// FOGSITE — pure projection / secrecy layer. No DOM.
// Given the full authoritative game state, produce the restricted "view" each
// role is allowed to see. This is the single source of truth for *what each
// client may know*:
//
//   - An investigator sees ONLY their own ego-centric relative map. They do NOT
//     learn their absolute position, the maze, teammates, the guard, or the
//     deity. Every coordinate is emitted relative to that investigator's own
//     start, so no absolute coordinate ever leaves the server.
//   - The Guardian sees the full truth (maze, all pawns, guard, deity).
//
// The local hotseat UI renders from these same views, so its privacy model is
// identical to the (future) online server's per-client projection.
import { GRID } from './rules.js';

const key = (r, c) => `${r},${c}`;

// Ego-grid display radius. A 9x9 window (span 4) covers any reachable offset
// from a start cell within the 5x5 maze.
export const EGO_SPAN = 4;

// The view an investigator client is allowed to receive. Relative-only.
export function projectForInvestigator(state, color) {
  const it = state.inv[color];
  const span = EGO_SPAN;
  const size = span * 2 + 1;

  // Ego grid relative to this investigator's own start; absolute coordinates
  // never appear in the output. null = fog (unexplored / out of window).
  const grid = [];
  for (let dr = -span; dr <= span; dr++) {
    const row = [];
    for (let dc = -span; dc <= span; dc++) {
      const val = it.explored[key(it.startPos.r + dr, it.startPos.c + dc)];
      row.push(val === undefined ? null : val);
    }
    grid.push(row);
  }

  return {
    role: 'investigator',
    color,
    mode: state.mode,
    round: state.round,
    phaseIndex: state.phaseIndex,
    totalTilesLeft: state.totalTilesLeft,
    deityActive: state.deity.active,
    startHint: state.startHints[color],
    // ego grid, plus self/start as indices into `grid` (start is always center)
    span,
    size,
    grid,
    self: { row: (it.pos.r - it.startPos.r) + span, col: (it.pos.c - it.startPos.c) + span },
    start: { row: span, col: span },
    // this investigator's own private status only
    characterId: it.characterId,
    fatigue: it.fatigue,
    laidDown: it.laidDown,
    actionCard: it.actionCard,
    forcedRestNextRound: it.forcedRestNextRound,
  };
}

// The full-truth view for the Guardian client.
export function projectForGuardian(state) {
  const grid = [];
  for (let r = 0; r < GRID; r++) {
    const row = [];
    for (let c = 0; c < GRID; c++) {
      row.push({
        type: state.maze.cells[r][c],
        pawns: state.colors.filter((col) => state.inv[col].pos.r === r && state.inv[col].pos.c === c),
        guard: state.guard.pos.r === r && state.guard.pos.c === c,
        deity: state.deity.active && state.deity.pos.r === r && state.deity.pos.c === c,
      });
    }
    grid.push(row);
  }
  return {
    role: 'guardian',
    mode: state.mode,
    round: state.round,
    phaseIndex: state.phaseIndex,
    totalTilesLeft: state.totalTilesLeft,
    guardianName: state.guardianName,
    deityActive: state.deity.active,
    grid,
  };
}
