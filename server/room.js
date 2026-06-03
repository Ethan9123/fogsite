// FOGSITE — authoritative room core. Transport-agnostic: no sockets, no timers,
// no I/O. Wraps the pure engine (game.js) and enforces who-may-do-what (role &
// turn validation) on top of it. The WebSocket layer (PR 3) and the Durable
// Object adapter (PR 5) drive this core and own the real network + clock.
//
// Player mapping (per Issue #1): one guardian + N investigators. Seats are keyed
// by playerId, which the transport assigns. Rules live ONLY in game.js — this
// file never decides game outcomes, it only routes validated actions into it.
import * as G from '../src/game.js';
import { MODE, COLORS } from '../src/rules.js';
import { validateMaze } from '../src/maze.js';
import { projectForInvestigator, projectForGuardian } from '../src/project.js';
import { TYPES, validateAction } from './protocol.js';

export const ESCAPE_SECONDS = 60; // window length the transport should count down

export function createRoom(code = null) {
  return {
    code,
    phase: 'lobby',                 // 'lobby' | 'playing' | 'over'
    players: {},                    // playerId -> { role: 'guardian'|'investigator', color, name }
    config: { count: 3, characters: {}, guardianName: '', maze: null },
    game: null,                     // engine state once started
    escape: null,                   // { confirms: [color], deadline: ms|null } during ESCAPE_DECISION
  };
}

// ---- seat helpers ---------------------------------------------------------
function isGuardian(room, playerId) {
  const p = room.players[playerId];
  return !!p && p.role === 'guardian';
}
function colorOf(room, playerId) {
  const p = room.players[playerId];
  return p && p.role === 'investigator' ? p.color : null;
}
function seatTaken(room, role, color) {
  return Object.values(room.players).some((p) =>
    role === 'guardian' ? p.role === 'guardian' : (p.role === 'investigator' && p.color === color));
}

const fail = (room, msg) => ({ state: room, error: msg });
// `result` (optional) is a small, per-actor payload the transport delivers
// privately to the acting client (e.g. an ability's secret answer, an explore
// outcome, an attack hit/block) — it never goes to other players.
const done = (room, result = null) => ({ state: room, error: null, result });

// ---------------------------------------------------------------------------
// applyAction — the single entry point. Validates shape, then role/turn/phase,
// then delegates to the engine. Mutates `room` in place (like game.js) and
// returns { state, error }. `error` is null on success.
// ---------------------------------------------------------------------------
export function applyAction(room, playerId, action) {
  const shapeErr = validateAction(action);
  if (shapeErr) return fail(room, shapeErr);
  const g = room.game;

  switch (action.type) {
    // ---- lobby ----
    case TYPES.JOIN: {
      if (room.phase !== 'lobby') return fail(room, 'cannot join after the game has started');
      if (room.players[playerId]) return fail(room, 'this seat id already joined');
      if (seatTaken(room, action.role, action.color)) return fail(room, 'that seat is already taken');
      room.players[playerId] = {
        role: action.role,
        color: action.role === 'investigator' ? action.color : null,
        name: action.name || '',
      };
      return done(room);
    }

    case TYPES.CONFIGURE: {
      if (!isGuardian(room, playerId)) return fail(room, 'only the guardian may configure');
      if (room.phase !== 'lobby') return fail(room, 'cannot configure after start');
      room.config = {
        count: action.count,
        characters: action.characters,
        guardianName: action.guardianName || '',
        maze: action.maze,
      };
      return done(room);
    }

    case TYPES.START: {
      if (!isGuardian(room, playerId)) return fail(room, 'only the guardian may start');
      if (room.phase !== 'lobby') return fail(room, 'already started');
      const colors = COLORS.slice(0, room.config.count);
      for (const c of colors) {
        if (!Object.values(room.players).some((p) => p.role === 'investigator' && p.color === c)) {
          return fail(room, `missing investigator seat: ${c}`);
        }
      }
      if (!room.config.maze) return fail(room, 'no maze configured');
      const v = validateMaze(room.config.maze, colors);
      if (!v.ok) return fail(room, 'invalid maze: ' + v.errors.map((e) => e.code).join(','));
      room.game = G.createGame({
        colors,
        characters: room.config.characters,
        guardianName: room.config.guardianName,
        maze: room.config.maze,
      });
      room.phase = 'playing';
      syncPhase(room);
      return done(room);
    }

    // ---- investigator turn (MODE.INVESTIGATORS) ----
    case TYPES.EXPLORE:
    case TYPES.MOVE:
    case TYPES.ABILITY:
    case TYPES.PASS: {
      if (room.phase !== 'playing' || !g || g.mode !== MODE.INVESTIGATORS) return fail(room, 'not the investigators phase');
      const color = colorOf(room, playerId);
      if (!color) return fail(room, 'only an investigator may take a turn');
      if (g.inv[color].laidDown) return fail(room, 'your turn is already over this round');
      let res;
      if (action.type === TYPES.EXPLORE) res = G.explore(g, color, action.dir);
      else if (action.type === TYPES.MOVE) res = G.move(g, color, action.dir);
      else if (action.type === TYPES.PASS) res = G.endTurn(g, color);
      else res = G.useAbility(g, color, action.params || {});
      if (!res || !res.ok) return fail(room, (res && res.reason) || 'illegal action');
      syncPhase(room);
      let result = null;
      if (action.type === TYPES.EXPLORE) result = { kind: 'explore', outcome: res.result };
      else if (action.type === TYPES.ABILITY) result = { kind: 'ability', info: res.info };
      return done(room, result);
    }

    // ---- escape decision (MODE.ESCAPE_DECISION) ----
    case TYPES.ESCAPE_CONFIRM: {
      if (!g || g.mode !== MODE.ESCAPE_DECISION) return fail(room, 'not the escape-decision phase');
      const color = colorOf(room, playerId);
      if (!color) return fail(room, 'only an investigator may confirm escape');
      if (!room.escape) room.escape = { confirms: [], deadline: null };
      if (!room.escape.confirms.includes(color)) room.escape.confirms.push(color);
      // unanimous within the window => run the same-cell check
      if (g.colors.every((c) => room.escape.confirms.includes(c))) {
        G.attemptEscape(g, true);
        syncPhase(room);
      }
      return done(room);
    }

    case TYPES.ESCAPE_TIMEOUT: {
      if (!g || g.mode !== MODE.ESCAPE_DECISION) return fail(room, 'not the escape-decision phase');
      if (!isGuardian(room, playerId)) return fail(room, 'only the guardian/server may time out the escape');
      G.attemptEscape(g, false); // window elapsed without unanimity => proceed to prediction
      syncPhase(room);
      return done(room);
    }

    // ---- secret prediction (MODE.PREDICTION) ----
    case TYPES.PREDICT: {
      if (!g || g.mode !== MODE.PREDICTION) return fail(room, 'not the prediction phase');
      const color = colorOf(room, playerId);
      if (!color) return fail(room, 'only an investigator may predict');
      if (g.inv[color].actionCard !== null) return fail(room, 'you already submitted a prediction');
      G.setPrediction(g, color, action.card); // may transition into the guardian turn
      syncPhase(room);
      return done(room);
    }

    // ---- guardian turn (MODE.GUARDIAN) ----
    case TYPES.GUARD_MOVE:
    case TYPES.DEITY_MOVE:
    case TYPES.ATTACK:
    case TYPES.GUARD_END: {
      if (!g || g.mode !== MODE.GUARDIAN) return fail(room, 'not the guardian phase');
      if (!isGuardian(room, playerId)) return fail(room, 'only the guardian may act now');
      let res;
      if (action.type === TYPES.GUARD_MOVE) res = G.moveGuard(g, action.dir);
      else if (action.type === TYPES.DEITY_MOVE) res = G.moveDeity(g, action.dir, action.targetColor);
      else if (action.type === TYPES.ATTACK) res = G.attack(g, action.color, action.attacker);
      else res = G.endGuardianTurn(g);
      if (!res || !res.ok) return fail(room, (res && res.reason) || 'illegal guardian action');
      syncPhase(room);
      const result = action.type === TYPES.ATTACK
        ? { kind: 'attack', color: action.color, attacker: action.attacker, success: res.success }
        : null;
      return done(room, result);
    }

    default:
      return fail(room, 'unhandled action type');
  }
}

// Keep room.phase / room.escape in sync with the engine's mode after each action.
function syncPhase(room) {
  const g = room.game;
  if (!g) return;
  if (g.mode === MODE.GAME_OVER) {
    room.phase = 'over';
    room.escape = null;
  } else if (g.mode === MODE.ESCAPE_DECISION) {
    if (!room.escape) room.escape = { confirms: [], deadline: null };
  } else {
    room.escape = null;
  }
}

// ---------------------------------------------------------------------------
// viewFor — the per-client projection the transport pushes. This is the secrecy
// boundary: a client only ever receives what this returns. Guardian gets full
// truth; each investigator gets their own ego map and nothing else.
// ---------------------------------------------------------------------------
export function viewFor(room, playerId) {
  const p = room.players[playerId];
  const base = {
    code: room.code,
    phase: room.phase,
    you: playerId,
    role: p ? p.role : null,
    color: p ? p.color : null,
    seats: Object.fromEntries(Object.entries(room.players).map(([id, pl]) => [id, { role: pl.role, color: pl.color, name: pl.name }])),
    escape: room.escape ? { confirms: room.escape.confirms.slice(), deadline: room.escape.deadline } : null,
    winner: room.game ? room.game.winner : null,
  };
  if (!room.game || room.phase === 'lobby') return { ...base, view: null };

  if (p && p.role === 'guardian') return { ...base, view: projectForGuardian(room.game) };
  if (p && p.role === 'investigator') return { ...base, view: projectForInvestigator(room.game, p.color) };
  return { ...base, view: null }; // spectator / unseated
}
