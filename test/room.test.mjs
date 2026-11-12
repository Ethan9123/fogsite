// FOGSITE room-core tests — run with: node test/room.test.mjs
// Drives the transport-agnostic authoritative room core through a scripted
// 4-player game (1 guardian + 3 investigators) via the public API only, and
// checks that role/turn/phase validation rejects illegal actions. Also asserts
// the per-client projection (viewFor) keeps an investigator's view secret.
import assert from 'node:assert/strict';
import { MODE, WINNER, COLORS } from '../src/rules.js';
import { generateMaze, makeRng } from '../src/maze.js';
import { createRoom, applyAction, viewFor } from '../server/room.js';
import { TYPES } from '../server/protocol.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push([name, e]); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const GUARDIAN = 0, RED = 1, GREEN = 2, BLUE = 3;

// A 4-player room seated and started on a known-good generated maze.
function startedRoom() {
  const room = createRoom('TEST');
  assert.equal(applyAction(room, GUARDIAN, { type: TYPES.JOIN, role: 'guardian', name: 'GM' }).error, null);
  assert.equal(applyAction(room, RED, { type: TYPES.JOIN, role: 'investigator', color: 'red' }).error, null);
  assert.equal(applyAction(room, GREEN, { type: TYPES.JOIN, role: 'investigator', color: 'green' }).error, null);
  assert.equal(applyAction(room, BLUE, { type: TYPES.JOIN, role: 'investigator', color: 'blue' }).error, null);
  const maze = generateMaze(COLORS, makeRng(12345)); // seed validated by the engine suite
  assert.equal(applyAction(room, GUARDIAN, {
    type: TYPES.CONFIGURE, count: 3,
    characters: { red: 'monk', green: 'doctor', blue: 'guide' },
    guardianName: 'GM', maze,
  }).error, null);
  assert.equal(applyAction(room, GUARDIAN, { type: TYPES.START }).error, null);
  return room;
}

// ===========================================================================
test('join enforces unique seats', () => {
  const room = createRoom();
  assert.equal(applyAction(room, 0, { type: TYPES.JOIN, role: 'guardian' }).error, null);
  assert.ok(applyAction(room, 5, { type: TYPES.JOIN, role: 'guardian' }).error, 'guardian seat should be taken');
  assert.equal(applyAction(room, 1, { type: TYPES.JOIN, role: 'investigator', color: 'red' }).error, null);
  assert.ok(applyAction(room, 2, { type: TYPES.JOIN, role: 'investigator', color: 'red' }).error, 'red seat should be taken');
  // the same seat id cannot re-join
  assert.ok(applyAction(room, 0, { type: TYPES.JOIN, role: 'investigator', color: 'blue' }).error);
});

test('configure + start transitions lobby -> playing/investigators', () => {
  const room = startedRoom();
  assert.equal(room.phase, 'playing');
  assert.equal(room.game.mode, MODE.INVESTIGATORS);
  assert.equal(room.game.round, 1);
});

test('start is rejected until every investigator seat is filled', () => {
  const room = createRoom();
  applyAction(room, GUARDIAN, { type: TYPES.JOIN, role: 'guardian' });
  applyAction(room, RED, { type: TYPES.JOIN, role: 'investigator', color: 'red' });
  const maze = generateMaze(COLORS, makeRng(12345));
  applyAction(room, GUARDIAN, { type: TYPES.CONFIGURE, count: 3, characters: { red: 'monk', green: 'doctor', blue: 'guide' }, maze });
  const r = applyAction(room, GUARDIAN, { type: TYPES.START });
  assert.ok(r.error && /missing investigator/.test(r.error));
  assert.equal(room.phase, 'lobby');
});

test('illegal/out-of-turn/wrong-role actions are rejected', () => {
  const room = startedRoom();
  // guardian cannot take an investigator turn
  let r = applyAction(room, GUARDIAN, { type: TYPES.EXPLORE, dir: 'N' });
  assert.ok(r.error && /investigator/.test(r.error));
  // guardian action while it's the investigators' phase
  r = applyAction(room, GUARDIAN, { type: TYPES.GUARD_END });
  assert.ok(r.error && /guardian phase/.test(r.error));
  // malformed direction
  r = applyAction(room, RED, { type: TYPES.MOVE, dir: 'X' });
  assert.ok(r.error && /dir/.test(r.error));
  // an investigator acting twice in one round (after laying down)
  assert.equal(applyAction(room, RED, { type: TYPES.PASS }).error, null);
  r = applyAction(room, RED, { type: TYPES.PASS });
  assert.ok(r.error && /already over/.test(r.error));
  // unknown action type
  assert.ok(applyAction(room, RED, { type: 'nonsense' }).error);
});

test('full turn cycle -> unanimous escape confirm -> investigators win', () => {
  const room = startedRoom();
  const g = room.game;
  // herd all three onto the same cell so the same-cell check succeeds
  const cell = { ...g.inv.red.pos };
  g.inv.green.pos = { ...cell };
  g.inv.blue.pos = { ...cell };
  // everyone ends their turn -> escape decision
  applyAction(room, RED, { type: TYPES.PASS });
  applyAction(room, GREEN, { type: TYPES.PASS });
  applyAction(room, BLUE, { type: TYPES.PASS });
  assert.equal(g.mode, MODE.ESCAPE_DECISION);
  assert.ok(room.escape, 'escape state should be initialized on entering the phase');
  // partial confirms do not resolve
  applyAction(room, RED, { type: TYPES.ESCAPE_CONFIRM });
  applyAction(room, GREEN, { type: TYPES.ESCAPE_CONFIRM });
  assert.equal(g.mode, MODE.ESCAPE_DECISION);
  // unanimous -> resolve
  const r = applyAction(room, BLUE, { type: TYPES.ESCAPE_CONFIRM });
  assert.equal(r.error, null);
  assert.equal(g.mode, MODE.GAME_OVER);
  assert.equal(g.winner, WINNER.INVESTIGATORS);
  assert.equal(room.phase, 'over');
  assert.equal(room.escape, null);
});

test('no-escape -> prediction -> guardian -> end -> round 2', () => {
  const room = startedRoom();
  const g = room.game;
  applyAction(room, RED, { type: TYPES.PASS });
  applyAction(room, GREEN, { type: TYPES.PASS });
  applyAction(room, BLUE, { type: TYPES.PASS });
  assert.equal(g.mode, MODE.ESCAPE_DECISION);
  // an investigator may not trigger the timeout
  assert.ok(applyAction(room, RED, { type: TYPES.ESCAPE_TIMEOUT }).error);
  // guardian/server times out the window -> prediction
  assert.equal(applyAction(room, GUARDIAN, { type: TYPES.ESCAPE_TIMEOUT }).error, null);
  assert.equal(g.mode, MODE.PREDICTION);
  assert.equal(room.escape, null);
  // each investigator submits a secret prediction
  applyAction(room, RED, { type: TYPES.PREDICT, card: 'rest' });
  applyAction(room, GREEN, { type: TYPES.PREDICT, card: 'rest' });
  // double-predict rejected
  assert.ok(applyAction(room, RED, { type: TYPES.PREDICT, card: 'caution' }).error);
  applyAction(room, BLUE, { type: TYPES.PREDICT, card: 'caution' });
  assert.equal(g.mode, MODE.GUARDIAN);
  // guardian ends the turn -> back to investigators, round 2
  assert.equal(applyAction(room, GUARDIAN, { type: TYPES.GUARD_END }).error, null);
  assert.equal(g.mode, MODE.INVESTIGATORS);
  assert.equal(g.round, 2);
  assert.equal(room.phase, 'playing');
});

// ---- the secrecy boundary at the room level -------------------------------
test('SECRECY: viewFor gives the guardian truth and an investigator only their own view', () => {
  const room = startedRoom();
  const gView = viewFor(room, GUARDIAN);
  assert.equal(gView.role, 'guardian');
  assert.equal(gView.view.grid.length, 5); // full 5x5 truth

  const redView = viewFor(room, RED);
  assert.equal(redView.role, 'investigator');
  assert.equal(redView.color, 'red');
  assert.equal(redView.view.role, 'investigator');
  // the projection itself must not embed maze truth or teammates
  const json = JSON.stringify(redView.view);
  assert.ok(!json.includes('green'), 'teammate leaked into investigator projection');
  assert.ok(!json.includes('blue'), 'teammate leaked into investigator projection');
  assert.ok(!json.includes('chamber'), 'maze truth leaked into investigator projection');
  assert.equal(redView.view.maze, undefined);
});

// ===========================================================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
