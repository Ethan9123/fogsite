// Regression tests for untrusted room actions. Every rejected payload must
// leave the authoritative room unchanged, not merely avoid throwing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoom, applyAction, viewFor } from '../server/room.js';
import { validateAction } from '../server/protocol.js';
import { COLORS } from '../src/rules.js';
import { generateMaze, makeRng, validateMaze } from '../src/maze.js';

const configure = () => ({ type: 'configure', count: 3,
  characters: { red: 'monk', green: 'doctor', blue: 'guide' },
  maze: generateMaze(COLORS, makeRng(12345)) });
function lobby() {
  const room = createRoom('TEST');
  applyAction(room, 0, { type: 'join', role: 'guardian', name: 'GM' });
  COLORS.forEach((color, i) => applyAction(room, i + 1, { type: 'join', role: 'investigator', color, name: 'private-' + color }));
  return room;
}
function started() {
  const room = lobby();
  assert.equal(applyAction(room, 0, configure()).error, null);
  assert.equal(applyAction(room, 0, { type: 'start' }).error, null);
  return room;
}
function rejected(room, pid, action) {
  const before = structuredClone(room);
  assert.ok(applyAction(room, pid, action).error, JSON.stringify(action));
  assert.deepEqual(room, before, 'invalid action mutated the room');
}

test('malformed maze shapes and invalid setup data are rejected atomically', () => {
  const mutations = [
    (a) => { a.maze = {}; }, (a) => { a.maze = []; },
    (a) => { a.maze.cells = []; }, (a) => { a.maze.cells[0] = null; },
    (a) => { a.maze.cells[0] = ['room']; }, (a) => { a.maze.cells[0][0] = 'bad'; },
    (a) => { a.maze.starts = null; }, (a) => { a.maze.starts.red = { r: -1, c: 0 }; },
    (a) => { a.maze.starts.red = { r: 5, c: 0 }; }, (a) => { a.maze.starts.red = { r: 0.5, c: 1 }; },
    (a) => { a.maze.starts.red = { r: '0', c: 0 }; }, (a) => { a.maze.starts.red = null; },
    (a) => { a.maze.chamber = {}; }, (a) => { a.maze.chamber = { r: 0, c: -1 }; },
    (a) => { a.maze.chamber = { ...a.maze.starts.red }; },
    (a) => { a.characters = {}; }, (a) => { a.characters.red = 'constructor'; },
    (a) => { a.guardianName = {}; }, (a) => { a.characters = []; },
  ];
  for (const mutate of mutations) {
    const room = lobby(), action = configure();
    mutate(action);
    rejected(room, 0, action);
  }
  for (const value of [null, {}, [], { cells: [null], starts: {} }]) assert.equal(validateMaze(value, COLORS).ok, false);
  for (const action of [null, [], { type: 'join', role: 'guardian', name: {} }]) assert.ok(validateAction(action));
});

test('start revalidates stored configuration and rejects excluded occupied seats', () => {
  const room = lobby();
  room.config = configure(); room.config.maze = {};
  rejected(room, 0, { type: 'start' });
  const two = configure(); two.count = 2;
  assert.equal(applyAction(room, 0, two).error, null);
  rejected(room, 0, { type: 'start' });
  assert.equal(applyAction(room, 0, configure()).error, null);
  assert.equal(applyAction(room, 0, { type: 'start' }).error, null);
});

test('overlapping starts and missing chambers are rejected by maze rules', () => {
  const a = configure();
  a.maze.starts.green = { ...a.maze.starts.red };
  assert.equal(validateMaze(a.maze, COLORS).ok, false);
  a.maze.chamber = null;
  assert.equal(validateMaze(a.maze, COLORS).ok, false);
});

test('ability payloads, including apprentice copies, are validated before mutation', () => {
  const cases = [
    ['archaeologist', undefined], ['archaeologist', {}], ['monk', {}], ['monk', { dir: 'constructor' }],
    ['geographer', { dirs: ['N', 'bad'] }], ['geographer', { dirs: 'NE' }],
    ['geographer', { dirs: {} }], ['geographer', { dirs: ['N', 'N'] }],
    ['geographer', { dirs: ['N', 'E', 'S'] }], ['geographer', { dirs: [] }],
    ['guide', {}], ['guide', { targetColor: 'constructor' }], ['doctor', { targetColor: null }],
    ['apprentice', { copyId: 'monk', inner: {} }], ['apprentice', { copyId: 'apprentice' }],
    ['apprentice', { copyId: 'constructor' }], ['apprentice', { copyId: 'monk', inner: [] }],
    ['mercenary', null], ['mercenary', []],
  ];
  for (const [id, params] of cases) {
    const room = started(); room.game.inv.red.characterId = id; room.game.inv.red.fatigue = false;
    rejected(room, 1, { type: 'ability', params });
  }
  for (const [id, params] of [['monk', { dir: 'N' }], ['guide', { targetColor: 'green' }],
    ['geographer', { dirs: ['N', 'E'] }], ['mercenary', {}], ['apprentice', { copyId: 'monk', inner: { dir: 'S' } }]]) {
    const room = started(); room.game.inv.red.characterId = id; room.game.inv.red.fatigue = false;
    assert.equal(applyAction(room, 1, { type: 'ability', params }).error, null);
  }
});

test('the complete investigator envelope hides teammate seats and escape confirmations', () => {
  const room = started();
  for (const pid of [1, 2, 3]) applyAction(room, pid, { type: 'pass' });
  applyAction(room, 2, { type: 'escape_confirm' });
  const own = viewFor(room, 1), other = viewFor(room, 99), guardian = viewFor(room, 0);
  assert.equal(own.playerCount, 3);
  assert.equal(own.escape.confirmCount, 1);
  assert.deepEqual(own.escape.confirms, []);
  for (const view of [own, other]) {
    const serialized = JSON.stringify(view);
    for (const hidden of ['green', 'blue', 'private-green', 'private-blue', 'chamber', 'maze']) assert.ok(!serialized.includes(hidden), hidden);
  }
  assert.equal(other.role, null); assert.equal(other.view, null);
  assert.equal(Object.keys(guardian.seats).length, 4);
  assert.deepEqual(guardian.escape.confirms, ['green']);
});
