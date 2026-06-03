// FOGSITE engine tests — run with: node test/engine.test.mjs
// Pure-logic verification of maze generation/validation and the full state
// machine (round cycle, combat, phase advance, escape win, timeout loss).
import assert from 'node:assert/strict';
import { GRID, CELL, RULES, MODE, ACTION, WINNER, COLORS } from '../src/rules.js';
import {
  emptyMaze, validateMaze, generateMaze, makeRng, roomNeighborCount,
} from '../src/maze.js';
import {
  createGame, explore, move, canMove, endTurn,
  attemptEscape, allOnSameCell, setPrediction,
  attack, attackTargets, moveGuard, canMoveGuard, endGuardianTurn,
  useAbility, canUseAbility,
} from '../src/game.js';

// ---- tiny test runner -----------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push([name, e]); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// ---- deterministic test maze (2 investigators) ----------------------------
// row0: R R R R R
// row1: R W W W W
// row2: R R R R C
// row3: R W W W W
// row4: R R R R R
// red start (0,0), green start (4,0); guard spawns on chamber (2,4).
function testMaze() {
  const m = emptyMaze();
  const W = CELL.WALL;
  for (const c of [1, 2, 3, 4]) { m.cells[1][c] = W; m.cells[3][c] = W; }
  m.cells[2][4] = CELL.CHAMBER;
  m.chamber = { r: 2, c: 4 };
  m.starts = { red: { r: 0, c: 0 }, green: { r: 4, c: 0 } };
  return m;
}
const TWO = ['red', 'green'];

// ===========================================================================
test('emptyMaze is all rooms', () => {
  const m = emptyMaze();
  assert.equal(m.cells.length, GRID);
  assert.ok(m.cells.every((row) => row.length === GRID && row.every((t) => t === CELL.ROOM)));
});

test('hand-built test maze validates', () => {
  const res = validateMaze(testMaze(), TWO);
  assert.ok(res.ok, 'expected valid, got: ' + JSON.stringify(res.errors));
});

test('validation catches missing chamber', () => {
  const m = testMaze();
  m.cells[2][4] = CELL.ROOM; m.chamber = null;
  const res = validateMaze(m, TWO);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => e.code === 'chamber'));
});

test('validation catches adjacent starts', () => {
  const m = testMaze();
  m.starts = { red: { r: 0, c: 0 }, green: { r: 0, c: 1 } };
  const res = validateMaze(m, TWO);
  assert.ok(res.errors.some((e) => e.code === 'start-adj'));
});

test('validation catches start adjacent to chamber', () => {
  const m = testMaze();
  m.starts = { red: { r: 2, c: 3 }, green: { r: 4, c: 0 } }; // (2,3) touches chamber (2,4)
  const res = validateMaze(m, TWO);
  assert.ok(res.errors.some((e) => e.code === 'start-chamber'));
});

test('roomNeighborCount start hint', () => {
  const m = testMaze();
  // (0,0): N=outer, S=(1,0)room, W=outer, E=(0,1)room => 2
  assert.equal(roomNeighborCount(m, 0, 0), 2);
});

test('generateMaze produces a valid maze for 3 colors (seeded)', () => {
  const m = generateMaze(COLORS, makeRng(12345));
  const res = validateMaze(m, COLORS);
  assert.ok(res.ok, 'generated maze invalid: ' + JSON.stringify(res.errors));
});

// ===========================================================================
test('createGame initial state', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, guardianName: 'GM', maze: testMaze() });
  assert.equal(s.mode, MODE.INVESTIGATORS);
  assert.equal(s.round, 1);
  assert.deepEqual(s.guard.pos, { r: 2, c: 4 });
  assert.equal(s.totalTilesLeft, RULES.phaseTiles[2].reduce((a, b) => a + b, 0));
  assert.equal(s.startHints.red, 2);
  assert.equal(s.inv.red.fatigue, false);
});

test('apprentice starts fatigued', () => {
  const s = createGame({ colors: TWO, characters: { red: 'apprentice', green: 'doctor' }, maze: testMaze() });
  assert.equal(s.inv.red.fatigue, true);
  assert.equal(canUseAbility(s, 'red'), false);
});

test('explore reveals a room, consumes a tile, and ends the turn', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  const before = s.totalTilesLeft;
  const r1 = explore(s, 'red', 'E'); // (0,1) is room
  assert.ok(r1.ok && r1.result === 'room');
  assert.equal(s.totalTilesLeft, before - 1);
  assert.equal(s.inv.red.explored['0,1'], CELL.ROOM);
  assert.equal(s.inv.red.laidDown, true); // one action per turn
});

test('move is a separate turn onto an already-explored room', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  // can't move into an unexplored cell
  assert.equal(canMove(s, 'red', 'E'), false);
  // pre-seed red's knowledge, then move is legal and ends the turn
  s.inv.red.explored['0,1'] = CELL.ROOM;
  assert.ok(canMove(s, 'red', 'E'));
  const r = move(s, 'red', 'E');
  assert.ok(r.ok);
  assert.deepEqual(s.inv.red.pos, { r: 0, c: 1 });
  assert.equal(s.inv.red.laidDown, true);
});

test('explore into a wall reveals only a generic wall (inner/outer hidden)', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  const res = explore(s, 'red', 'N'); // (-1,0) out of bounds = outer wall, but...
  assert.ok(res.ok && res.result === 'wall'); // ...the investigator only learns "wall"
  assert.equal(s.inv.red.explored['-1,0'], CELL.WALL);
  assert.equal(s.inv.red.laidDown, true);
});

test('archaeologist upgrades a wall to inner/outer knowledge', () => {
  const s = createGame({ colors: TWO, characters: { red: 'archaeologist', green: 'doctor' }, maze: testMaze() });
  // red at (0,0): N neighbor is the outer boundary
  const r = useAbility(s, 'red', { dir: 'N' });
  assert.ok(r.ok && r.answer === 'outer');
  assert.equal(s.inv.red.explored['-1,0'], 'wall-outer');
});

test('explore into an inner wall records it and ends the turn', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  s.inv.red.pos = { r: 0, c: 1 };
  const res = explore(s, 'red', 'S'); // (1,1) is an inner wall
  assert.ok(res.ok && res.result === 'wall');
  assert.equal(s.inv.red.explored['1,1'], CELL.WALL);
  assert.equal(s.inv.red.laidDown, true);
});

test('full investigator phase -> escape decision', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  endTurn(s, 'red');
  assert.equal(s.mode, MODE.INVESTIGATORS); // green still to act
  endTurn(s, 'green');
  assert.equal(s.mode, MODE.ESCAPE_DECISION);
});

test('escape success when all on same cell', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  // force both onto (0,0)
  s.inv.green.pos = { r: 0, c: 0 };
  endTurn(s, 'red'); endTurn(s, 'green');
  assert.equal(s.mode, MODE.ESCAPE_DECISION);
  assert.ok(allOnSameCell(s));
  const r = attemptEscape(s, true);
  assert.ok(r.ok && r.success);
  assert.equal(s.mode, MODE.GAME_OVER);
  assert.equal(s.winner, WINNER.INVESTIGATORS);
});

test('escape fails when not co-located -> guardian wins', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  endTurn(s, 'red'); endTurn(s, 'green');
  const r = attemptEscape(s, true);
  assert.ok(r.ok && !r.success);
  assert.equal(s.winner, WINNER.GUARDIAN);
});

test('not escaping -> prediction -> guardian', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  endTurn(s, 'red'); endTurn(s, 'green');
  attemptEscape(s, false);
  assert.equal(s.mode, MODE.PREDICTION);
  setPrediction(s, 'red', ACTION.REST);
  assert.equal(s.mode, MODE.PREDICTION); // green not set
  setPrediction(s, 'green', ACTION.CAUTION);
  assert.equal(s.mode, MODE.GUARDIAN);
  assert.ok(s.guardTurn);
});

// ---- combat ---------------------------------------------------------------
function toGuardianTurn(s, redAction = ACTION.REST, greenAction = ACTION.CAUTION) {
  endTurn(s, 'red'); endTurn(s, 'green');
  attemptEscape(s, false);
  setPrediction(s, 'red', redAction);
  setPrediction(s, 'green', greenAction);
}

test('guard hits a 休憩 target, blocked by 警戒', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  // place guard adjacent to red, red REST (caught), green CAUTION (safe)
  s.inv.red.pos = { r: 0, c: 0 };
  s.inv.green.pos = { r: 4, c: 0 };
  toGuardianTurn(s, ACTION.REST, ACTION.CAUTION);
  s.guard.pos = { r: 0, c: 1 }; // adjacent to red (0,0), far from green
  const targets = attackTargets(s, 'guard');
  assert.ok(targets.includes('red'));
  assert.ok(!targets.includes('green'));
  const before = s.totalTilesLeft;
  const r = attack(s, 'red', 'guard');
  assert.ok(r.ok && r.success);
  assert.equal(s.totalTilesLeft, before - RULES.attackTileLoss);
});

test('警戒 blocks the guard (no tile loss)', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  s.inv.red.pos = { r: 0, c: 0 };
  toGuardianTurn(s, ACTION.CAUTION, ACTION.CAUTION);
  s.guard.pos = { r: 0, c: 1 };
  const before = s.totalTilesLeft;
  const r = attack(s, 'red', 'guard');
  assert.ok(r.ok && !r.success);
  assert.equal(s.totalTilesLeft, before);
});

test('no repeat attack on same investigator two turns running', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  s.guard.lastAttacked = 'red';
  s.inv.red.pos = { r: 0, c: 0 };
  toGuardianTurn(s, ACTION.REST, ACTION.CAUTION);
  s.guard.pos = { r: 0, c: 1 };
  assert.ok(!attackTargets(s, 'guard').includes('red'));
});

test('CAUTION-unattacked => forcedRest next round', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  toGuardianTurn(s, ACTION.CAUTION, ACTION.REST);
  endGuardianTurn(s);
  assert.equal(s.inv.red.forcedRestNextRound, true);  // played 警戒, not attacked
  assert.equal(s.inv.green.forcedRestNextRound, false); // played 休憩
  assert.equal(s.mode, MODE.INVESTIGATORS);
  assert.equal(s.round, 2);
  // forced rest is enforced on next prediction
  endTurn(s, 'red'); endTurn(s, 'green');
  attemptEscape(s, false);
  const r = setPrediction(s, 'red', ACTION.CAUTION); // tries 警戒 but forced to 休憩
  assert.equal(r.forced, true);
  assert.equal(s.inv.red.actionCard, ACTION.REST);
});

// ---- phase advance & deity ------------------------------------------------
test('crossing phase boundaries grows guard moves; finishing Phase 2 spawns deity + clears fatigue', () => {
  const s = createGame({ colors: TWO, characters: { red: 'apprentice', green: 'doctor' }, maze: testMaze() });
  assert.equal(s.guardMaxMoves, RULES.guardBaseMoves);
  assert.equal(s.deity.active, false);
  assert.equal(s.inv.red.fatigue, true);

  // Phase pool for 2 players is [7, 11, 13, 14]. Drain through Phase 1 (7) and
  // Phase 2 (11) — 18 tiles — by landing guard hits on resting investigators.
  // Each hit removes RULES.attackTileLoss (3) tiles; alternate targets.
  let slot = 'red';
  for (let round = 0; round < 12 && s.phaseIndex < 2; round++) {
    endTurn(s, 'red'); endTurn(s, 'green');
    attemptEscape(s, false);
    setPrediction(s, 'red', ACTION.REST);
    setPrediction(s, 'green', ACTION.REST); // -> enters guardian turn
    s.guard.lastAttacked = null;            // clear no-repeat for the test
    s.guard.pos = { ...s.inv[slot].pos };
    if (attackTargets(s, 'guard').includes(slot)) attack(s, slot, 'guard');
    endGuardianTurn(s);
    slot = slot === 'red' ? 'green' : 'red';
  }
  assert.ok(s.guardMaxMoves > RULES.guardBaseMoves, 'guard moves should have grown');
  assert.equal(s.deity.active, true, 'deity active after Phase 2');
  assert.equal(s.inv.red.fatigue, false, 'fatigue clears after Phase 2');
});

// ---- timeout loss ---------------------------------------------------------
test('timeout: no tiles when guardian turn begins => guardian wins', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  s.totalTilesLeft = 0; // simulate exhausted clock
  endTurn(s, 'red'); endTurn(s, 'green');
  attemptEscape(s, false);
  setPrediction(s, 'red', ACTION.REST);
  setPrediction(s, 'green', ACTION.REST); // entering guardian triggers timeout check
  assert.equal(s.mode, MODE.GAME_OVER);
  assert.equal(s.winner, WINNER.GUARDIAN);
});

// ---- abilities ------------------------------------------------------------
test('archaeologist identifies an adjacent wall as inner vs outer', () => {
  const s = createGame({ colors: TWO, characters: { red: 'archaeologist', green: 'doctor' }, maze: testMaze() });
  s.inv.red.pos = { r: 0, c: 1 }; // S neighbor (1,1) is inner WALL; N neighbor is outer
  const r1 = useAbility(s, 'red', { dir: 'S' });
  assert.ok(r1.ok && r1.answer === 'inner');
  assert.equal(s.inv.red.fatigue, true); // ability fatigues
});

test('monk counts inner walls along a ray', () => {
  const s = createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, maze: testMaze() });
  s.inv.red.pos = { r: 2, c: 0 }; // ray E along row 2: (2,1)(2,2)(2,3) rooms, (2,4) chamber=inner => 1
  const r = useAbility(s, 'red', { dir: 'E' });
  assert.ok(r.ok);
  assert.equal(r.answer, 1);
});

test('guide reports relative cardinal direction', () => {
  const s = createGame({ colors: TWO, characters: { red: 'guide', green: 'doctor' }, maze: testMaze() });
  s.inv.red.pos = { r: 0, c: 0 };
  s.inv.green.pos = { r: 4, c: 0 }; // due south
  const r = useAbility(s, 'red', { targetColor: 'green' });
  assert.ok(r.ok && r.answer === 'S');
});

test('doctor revives a laid-down investigator', () => {
  const s = createGame({ colors: TWO, characters: { red: 'doctor', green: 'monk' }, maze: testMaze() });
  s.inv.green.laidDown = true;
  const r = useAbility(s, 'red', { targetColor: 'green' });
  assert.ok(r.ok);
  assert.equal(s.inv.green.laidDown, false);
});

test('mercenary freezes nearby guard', () => {
  const s = createGame({ colors: TWO, characters: { red: 'mercenary', green: 'doctor' }, maze: testMaze() });
  s.inv.red.pos = { r: 2, c: 3 }; // chebyshev 1 from guard at (2,4)
  const r = useAbility(s, 'red', {});
  assert.ok(r.ok);
  assert.equal(s.frozenGuards, true);
  // frozen guard cannot move or attack
  // jump to a guardian turn artificially
  s.mode = MODE.GUARDIAN; s.guardTurn = { movesUsed: 0, deityMovesUsed: 0, attacked: [] };
  assert.equal(canMoveGuard(s, 'W'), false);
  assert.deepEqual(attackTargets(s, 'guard'), []);
});

test('apprentice can copy another character ability after fatigue clears', () => {
  const s = createGame({ colors: TWO, characters: { red: 'apprentice', green: 'doctor' }, maze: testMaze() });
  s.inv.red.fatigue = false; // pretend phase-2 fatigue clear
  s.inv.red.pos = { r: 2, c: 0 };
  const r = useAbility(s, 'red', { copyId: 'monk', inner: { dir: 'E' } });
  assert.ok(r.ok);
  assert.equal(r.answer, 1);
});

// ===========================================================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
