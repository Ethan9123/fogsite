// FOGSITE projection / secrecy-layer tests — run with: node test/project.test.mjs
// Verifies that the pure view layer gives the Guardian full truth while giving
// each investigator ONLY their own ego-centric relative map (no maze, no
// teammates, no guard/deity, no absolute coordinates). The secrecy-leak test is
// the load-bearing one: it is what makes per-client online play safe.
import assert from 'node:assert/strict';
import { CELL } from '../src/rules.js';
import { emptyMaze } from '../src/maze.js';
import { createGame, explore } from '../src/game.js';
import { projectForInvestigator, projectForGuardian, EGO_SPAN } from '../src/project.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push([name, e]); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// Same deterministic 2-investigator maze as the engine tests.
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
function newGame() {
  return createGame({ colors: TWO, characters: { red: 'monk', green: 'doctor' }, guardianName: 'GM', maze: testMaze() });
}

// The exact whitelist of fields an investigator client may receive. Any extra
// key is a potential leak, so we assert the key set exactly.
const INV_KEYS = [
  'role', 'color', 'mode', 'round', 'phaseIndex', 'totalTilesLeft', 'deityActive',
  'startHint', 'span', 'size', 'grid', 'self', 'start',
  'characterId', 'fatigue', 'laidDown', 'actionCard', 'forcedRestNextRound',
];

// ===========================================================================
test('guardian view exposes full truth (maze, pawns, guard, deity)', () => {
  const s = newGame();
  const v = projectForGuardian(s);
  assert.equal(v.role, 'guardian');
  // maze cell types match exactly
  assert.equal(v.grid[2][4].type, CELL.CHAMBER);
  assert.equal(v.grid[1][1].type, CELL.WALL);
  assert.equal(v.grid[0][0].type, CELL.ROOM);
  // all pawns visible at their absolute cells
  assert.deepEqual(v.grid[0][0].pawns, ['red']);
  assert.deepEqual(v.grid[4][0].pawns, ['green']);
  // guard spawns on the chamber
  assert.equal(v.grid[2][4].guard, true);
  // deity not active yet
  assert.ok(v.grid.every((row) => row.every((cell) => cell.deity === false)));
});

test('guardian view shows the deity once active', () => {
  const s = newGame();
  s.deity = { active: true, pos: { r: 2, c: 0 }, lastAttacked: null };
  const v = projectForGuardian(s);
  assert.equal(v.deityActive, true);
  assert.equal(v.grid[2][0].deity, true);
});

test('investigator view exposes ONLY whitelisted fields', () => {
  const s = newGame();
  const v = projectForInvestigator(s, 'red');
  assert.deepEqual(Object.keys(v).sort(), [...INV_KEYS].sort());
  assert.equal(v.role, 'investigator');
  assert.equal(v.color, 'red');
});

test('investigator starts knowing only their own start cell (rest is fog)', () => {
  const s = newGame();
  const v = projectForInvestigator(s, 'red');
  const center = EGO_SPAN; // start sits at grid center
  assert.equal(v.start.row, center);
  assert.equal(v.start.col, center);
  assert.equal(v.grid[center][center], CELL.ROOM); // own start is a known room
  // every other cell is fog (null)
  let known = 0;
  for (const row of v.grid) for (const cell of row) if (cell !== null) known++;
  assert.equal(known, 1);
});

test('exploring reveals cells in RELATIVE coordinates only', () => {
  const s = newGame();
  explore(s, 'red', 'E'); // red at (0,0) reveals (0,1) as a room, one cell east of start
  const v = projectForInvestigator(s, 'red');
  const center = EGO_SPAN;
  assert.equal(v.grid[center][center], CELL.ROOM);     // start
  assert.equal(v.grid[center][center + 1], CELL.ROOM); // one east
  let known = 0;
  for (const row of v.grid) for (const cell of row) if (cell !== null) known++;
  assert.equal(known, 2);
});

test('self position is relative to start, never absolute', () => {
  const s = newGame();
  // Pretend green moved: start (4,0), now at (2,0) — two cells north of start.
  s.inv.green.startPos = { r: 4, c: 0 };
  s.inv.green.pos = { r: 2, c: 0 };
  const v = projectForInvestigator(s, 'green');
  const center = EGO_SPAN;
  // absolute (2,0) must NOT appear; relative offset is (-2, 0) => grid (center-2, center)
  assert.equal(v.self.row, center - 2);
  assert.equal(v.self.col, center); // absolute col 0 maps to the center column, hiding it
});

// ---- the load-bearing secrecy-leak test -----------------------------------
test('SECRECY: an investigator view leaks no maze, teammate, guard, or deity data', () => {
  const s = newGame();
  // Make the hidden state information-rich: green elsewhere, guard adjacent to
  // red, deity active. None of this may appear in red's view.
  s.inv.green.pos = { r: 4, c: 0 };
  s.guard.pos = { r: 0, c: 1 };
  s.deity = { active: true, pos: { r: 0, c: 2 }, lastAttacked: null };
  explore(s, 'red', 'E'); // give red some explored cells too

  const v = projectForInvestigator(s, 'red');

  // No structural handle on the secret state.
  assert.equal(v.maze, undefined);
  assert.equal(v.inv, undefined);
  assert.equal(v.guard, undefined);
  assert.equal(v.deity, undefined);
  assert.equal(v.colors, undefined);
  assert.equal(v.startHints, undefined);
  // deityActive is a single allowed boolean — never a position.
  assert.equal(typeof v.deityActive, 'boolean');
  assert.equal(v.deityActive, true);

  // The serialized view must not embed the full maze, the other color, or any
  // guard/deity coordinate. (Scan the JSON for forbidden tokens.)
  const json = JSON.stringify(v);
  assert.ok(!json.includes('green'), 'teammate color leaked');
  assert.ok(!json.includes('chamber'), 'maze chamber type leaked into investigator view');
  assert.ok(!json.includes('"guard"'), 'guard key leaked');
  // red knows exactly its own explored cells, nothing more.
  let known = 0;
  for (const row of v.grid) for (const cell of row) if (cell !== null) known++;
  assert.equal(known, Object.keys(s.inv.red.explored).length);
});

// ===========================================================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
