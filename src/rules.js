// FOGSITE — rules, constants, and tunable config (full "Arclight" ruleset).
// Pure data + helpers, no DOM. Importable in both the browser and Node.

export const GRID = 5; // 5x5 maze

// Cell types inside the 5x5 grid.
export const CELL = {
  ROOM: 'room',       // 部屋 — walkable
  WALL: 'wall',       // 内壁 — blocked
  CHAMBER: 'chamber', // 石室 — walkable special; guard/deity spawn here
};

// Investigator colors.
export const COLORS = ['red', 'green', 'blue'];
export const COLOR_LABEL = { red: '红', green: '绿', blue: '蓝' };
export const COLOR_HEX = { red: '#d9534f', green: '#4f9d69', blue: '#4a78c4' };

// Action-prediction cards.
export const ACTION = { CAUTION: 'caution', REST: 'rest' }; // 警戒 / 休憩
export const ACTION_LABEL = { caution: '警戒', rest: '休憩' };

// Orthogonal directions. row/col deltas; N = up.
export const DIRS = {
  N: { dr: -1, dc: 0, label: '北' },
  S: { dr: 1, dc: 0, label: '南' },
  W: { dr: 0, dc: -1, label: '西' },
  E: { dr: 0, dc: 1, label: '东' },
};
export const DIR_KEYS = ['N', 'E', 'S', 'W'];

// Diagonal direction labels (used by some abilities).
export const DIAG_LABEL = { NE: '东北', SE: '东南', NW: '西北', SW: '西南' };

// ---------------------------------------------------------------------------
// Tunable rule numbers. Several are best-effort defaults from a partially
// garbled translation table — centralized here so they are easy to confirm.
// ---------------------------------------------------------------------------
export const RULES = {
  // Small map-tiles ("迷宫地块(小)") on the time-limit board, grouped by phase,
  // keyed by the number of investigators. Index 0 = Phase 1, etc.
  phaseTiles: {
    2: [7, 11, 13, 14],
    3: [9, 11, 13, 14],
  },
  // Maze composition is fixed at 25 cells. Inner walls + 1 chamber.
  innerWalls: 5,          // 内壁地块 ×5
  chambers: 1,            // 石室 ×1
  // Attack: a successful hit removes this many tiles (休憩 caught).
  attackTileLoss: 3,
  // Guard may not attack the same investigator on two consecutive guardian turns.
  noRepeatAttack: true,
  // Cells the guard token may move per guardian turn (the 卫兵). Grows as
  // extra move-tokens unlock at phase boundaries.
  guardBaseMoves: 2,
  guardMovesPerPhaseBonus: 1, // +1 reachable each time a phase ends
  // The 守护神 (deity): unlocks at the end of Phase 2, moves up to N cells/turn,
  // must not increase distance to its chosen target, and its attack ignores 警戒.
  deityMoves: 2,
  deityUnlockAfterPhase: 2, // 0-indexed phase that, when finished, spawns deity
  // Ability uses per character per "fatigue window"; fatigue clears at end of
  // Phase 2, giving up to 2 total uses across a game.
  abilityUsesPerWindow: 1,
  fatigueResetAfterPhase: 2,
};

// ---------------------------------------------------------------------------
// The 7 character cards. `id` is stable; `resolve(ctx)` returns an info string
// (or performs a state effect) — implemented by the engine, declared here.
// `kind` drives which UI prompt is shown.
// ---------------------------------------------------------------------------
export const CHARACTERS = [
  {
    id: 'archaeologist', name: '考古学家', en: 'Archaeologist',
    kind: 'pick-adjacent-wall',
    desc: '指定一面相邻的墙壁，询问它是「内壁」（内壁/石室）还是「外壁」（5×5迷宫外侧）。',
  },
  {
    id: 'guide', name: '向导', en: 'Mountain Guide',
    kind: 'pick-other-investigator',
    desc: '指定另一名探检家，询问对方在自己的哪个方向（东/西/南/北）。',
  },
  {
    id: 'monk', name: '破戒僧', en: 'Transgressive Monk',
    kind: 'pick-straight-direction',
    desc: '指定一个直线方向（东西/南北），询问该方向上有多少面内壁（内壁/石室）。',
  },
  {
    id: 'geographer', name: '地理学家', en: 'Geographer',
    kind: 'pick-two-adjacent-empty',
    desc: '指定相邻的2个空格，询问它们是房间还是墙壁，并按结果直接放置地块。',
  },
  {
    id: 'mercenary', name: '元傭兵', en: 'Ex-Mercenary',
    kind: 'freeze-guards',
    desc: '将自己及周围一格（共9格）内的所有卫兵冻结，直到下个遗迹役手番结束。',
  },
  {
    id: 'doctor', name: '医师', en: 'Doctor',
    kind: 'revive-investigator',
    desc: '让一名已结束手番的探检家重新行动（将倒下的棋子立起）。',
  },
  {
    id: 'apprentice', name: '见习', en: 'Apprentice',
    kind: 'copy-ability',
    desc: '游戏开始即带疲劳。可复制另一名探检家的角色能力作为自己的能力使用。',
  },
];

export const CHARACTER_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

// Game phases of the turn cycle (state machine high-level mode).
export const MODE = {
  SETUP: 'setup',
  INVESTIGATORS: 'investigators',
  ESCAPE_DECISION: 'escape_decision',
  PREDICTION: 'prediction',
  GUARDIAN: 'guardian',
  GAME_OVER: 'game_over',
};

export const WINNER = { INVESTIGATORS: 'investigators', GUARDIAN: 'guardian' };

export function inBounds(r, c) {
  return r >= 0 && r < GRID && c >= 0 && c < GRID;
}
