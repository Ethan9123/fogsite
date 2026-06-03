// FOGSITE — game state machine (full ruleset). Pure logic, no DOM.
// State is mutated in place by the exported action functions; callers hold one
// state object and re-render after each call.
import {
  MODE, CELL, ACTION, RULES, DIRS, DIR_KEYS, WINNER,
  CHARACTER_BY_ID, COLOR_LABEL, inBounds,
} from './rules.js';
import {
  cloneMaze, isWalkable, walkableAt, orthNeighbors, roomNeighborCount,
} from './maze.js';

const key = (r, c) => `${r},${c}`;

function manhattan(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}
function cheby(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
}

// --------------------------------------------------------------------------
// Setup
// --------------------------------------------------------------------------
export function createGame({ colors, characters, guardianName, maze }) {
  const m = cloneMaze(maze);
  const inv = {};
  for (const color of colors) {
    const start = m.starts[color];
    const charId = characters[color];
    inv[color] = {
      color,
      characterId: charId,
      pos: { ...start },
      startPos: { ...start },
      explored: { [key(start.r, start.c)]: CELL.ROOM }, // you know your own start is a room
      laidDown: false,
      // apprentice starts fatigued (cannot act until fatigue clears at end of Phase 2)
      fatigue: charId === 'apprentice',
      forcedRestNextRound: false,
      actionCard: null,
    };
  }

  const phasePool = RULES.phaseTiles[colors.length].slice();
  const totalTilesLeft = phasePool.reduce((a, b) => a + b, 0);

  const startHints = {};
  for (const color of colors) {
    const s = m.starts[color];
    startHints[color] = roomNeighborCount(m, s.r, s.c);
  }

  const state = {
    mode: MODE.INVESTIGATORS,
    colors,
    guardianName: guardianName || '遗迹役',
    maze: m,
    inv,
    guard: { pos: { ...m.chamber }, lastAttacked: null },
    deity: { active: false, pos: null, lastAttacked: null },
    frozenGuards: false, // mercenary effect, active during the next guardian turn
    round: 1,
    phaseIndex: 0,
    phasePool,
    totalTilesLeft,
    timeUp: false,
    guardMaxMoves: RULES.guardBaseMoves,
    guardTurn: null,
    startHints,
    winner: null,
    log: [`游戏开始。${guardianName || '遗迹役'} 已建造迷宫。`],
  };
  return state;
}

// --------------------------------------------------------------------------
// Tile / phase bookkeeping
// --------------------------------------------------------------------------
function endPhase(state, idx) {
  state.guardMaxMoves += RULES.guardMovesPerPhaseBonus;
  let msg = `Phase ${idx + 1} 结束：守护者每回合机动 +1（现为 ${state.guardMaxMoves}）。`;
  if (idx === RULES.deityUnlockAfterPhase - 1 && !state.deity.active) {
    state.deity = { active: true, pos: { ...state.maze.chamber }, lastAttacked: null };
    msg += ' 守护神登场！';
  }
  if (idx === RULES.fatigueResetAfterPhase - 1) {
    for (const color of state.colors) state.inv[color].fatigue = false;
    msg += ' 全角色疲劳解除（能力可再次使用）。';
  }
  state.log.push(msg);
}

function consumeTiles(state, n, reason) {
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (state.totalTilesLeft <= 0) { state.timeUp = true; break; }
    state.phasePool[state.phaseIndex] -= 1;
    state.totalTilesLeft -= 1;
    removed += 1;
    while (state.phaseIndex < state.phasePool.length &&
           state.phasePool[state.phaseIndex] <= 0 &&
           state.phaseIndex < state.phasePool.length - 1) {
      endPhase(state, state.phaseIndex);
      state.phaseIndex += 1;
    }
    if (state.totalTilesLeft <= 0) state.timeUp = true;
  }
  if (removed > 0 && reason) {
    state.log.push(`${reason}：消耗 ${removed} 块地块（剩余 ${state.totalTilesLeft}）。`);
  }
  return removed;
}

// --------------------------------------------------------------------------
// Investigator actions (MODE.INVESTIGATORS)
// --------------------------------------------------------------------------
function neighborInDir(pos, dirKey) {
  const d = DIRS[dirKey];
  return { r: pos.r + d.dr, c: pos.c + d.dc };
}

// Returns the revealed type for an absolute cell, from the hidden maze.
// Out of bounds => 'outer' (outer wall).
function trueType(state, r, c) {
  if (!inBounds(r, c)) return 'outer';
  return state.maze.cells[r][c]; // room | wall | chamber
}

export function canExplore(state, color) {
  const it = state.inv[color];
  return state.mode === MODE.INVESTIGATORS && !it.laidDown && state.totalTilesLeft > 0;
}

export function explore(state, color, dirKey) {
  const it = state.inv[color];
  if (!canExplore(state, color)) return { ok: false, reason: '当前无法探索。' };
  const tgt = neighborInDir(it.pos, dirKey);
  const t = trueType(state, tgt.r, tgt.c);
  consumeTiles(state, 1, `${COLOR_LABEL[color]} 探索`);

  if (t === 'outer' || t === CELL.WALL) {
    // Record a GENERIC wall: by exploration alone the investigator learns only
    // "a wall blocks this way", not whether it is an inner wall or the maze's
    // outer boundary. Disambiguating that is the Archaeologist's job.
    it.explored[key(tgt.r, tgt.c)] = CELL.WALL;
    it.laidDown = true; // hitting a wall ends the turn immediately
    state.log.push(`${COLOR_LABEL[color]} 向${DIRS[dirKey].label}探索 → 墙壁，撞墙，手番结束。`);
    afterInvestigatorAct(state);
    return { ok: true, result: 'wall' };
  }
  // room or chamber: walkable, reveal it. Explore is the turn's single action,
  // so the turn ends here too (one action per turn — rulebook 9.1).
  it.explored[key(tgt.r, tgt.c)] = t;
  it.laidDown = true;
  state.log.push(`${COLOR_LABEL[color]} 向${DIRS[dirKey].label}探索 → 房间，手番结束。`);
  afterInvestigatorAct(state);
  return { ok: true, result: 'room' };
}

export function canMove(state, color, dirKey) {
  const it = state.inv[color];
  if (state.mode !== MODE.INVESTIGATORS || it.laidDown) return false;
  const tgt = neighborInDir(it.pos, dirKey);
  if (!walkableAt(state.maze, tgt.r, tgt.c)) return false;
  // must already be explored as walkable
  const known = it.explored[key(tgt.r, tgt.c)];
  return known === CELL.ROOM || known === CELL.CHAMBER;
}

export function move(state, color, dirKey) {
  const it = state.inv[color];
  if (!canMove(state, color, dirKey)) return { ok: false };
  const tgt = neighborInDir(it.pos, dirKey);
  it.pos = { r: tgt.r, c: tgt.c };
  it.laidDown = true; // one action per turn — moving ends the turn (rulebook 9.1)
  state.log.push(`${COLOR_LABEL[color]} 向${DIRS[dirKey].label}移动，手番结束。`);
  afterInvestigatorAct(state);
  return { ok: true };
}

export function endTurn(state, color) {
  const it = state.inv[color];
  if (state.mode !== MODE.INVESTIGATORS || it.laidDown) return { ok: false };
  it.laidDown = true;
  state.log.push(`${COLOR_LABEL[color]} 结束手番。`);
  afterInvestigatorAct(state);
  return { ok: true };
}

function afterInvestigatorAct(state) {
  // If every investigator has laid down, move to the escape decision.
  const allDown = state.colors.every((c) => state.inv[c].laidDown);
  if (allDown) {
    state.mode = MODE.ESCAPE_DECISION;
    state.log.push('所有探检家手番结束 → 脱出判断。');
  }
}

// --------------------------------------------------------------------------
// Character abilities
// --------------------------------------------------------------------------
export function canUseAbility(state, color) {
  const it = state.inv[color];
  return state.mode === MODE.INVESTIGATORS && !it.laidDown && !it.fatigue;
}

// params shape depends on the character kind; see rules.js CHARACTERS[].kind.
// For apprentice, params = { copyId, ...innerParams }.
export function useAbility(state, color, params) {
  const it = state.inv[color];
  if (!canUseAbility(state, color)) return { ok: false, reason: '能力不可用（疲劳或已倒下）。' };

  let charId = it.characterId;
  let p = params;
  if (charId === 'apprentice') {
    if (!params || !params.copyId) return { ok: false, reason: '见习需要指定复制的角色。' };
    charId = params.copyId;
    p = params.inner || {};
  }

  const res = resolveAbility(state, color, charId, p);
  if (!res.ok) return res;

  it.fatigue = true;
  it.laidDown = true; // using an ability is the turn's single action (rulebook 9.1)
  const charName = CHARACTER_BY_ID[it.characterId].name;
  state.log.push(`${COLOR_LABEL[color]}（${charName}）使用能力：${res.info}`);
  afterInvestigatorAct(state);
  return res;
}

function resolveAbility(state, color, charId, p) {
  const it = state.inv[color];
  switch (charId) {
    case 'archaeologist': {
      // p.dir = N/E/S/W of an adjacent wall
      const tgt = neighborInDir(it.pos, p.dir);
      const t = trueType(state, tgt.r, tgt.c);
      if (t !== CELL.WALL && t !== 'outer') return { ok: false, reason: '该方向不是墙壁，无法鉴定。' };
      // Upgrade the investigator's knowledge from "wall" to inner-vs-outer.
      it.explored[key(tgt.r, tgt.c)] = t === 'outer' ? 'wall-outer' : 'wall-inner';
      return { ok: true, info: `${DIRS[p.dir].label}侧的墙是「${t === 'outer' ? '外壁' : '内壁'}」`, answer: t === 'outer' ? 'outer' : 'inner' };
    }
    case 'guide': {
      const other = state.inv[p.targetColor];
      if (!other) return { ok: false, reason: '目标探检家不存在。' };
      const dir = cardinalDir(it.pos, other.pos);
      return { ok: true, info: `${COLOR_LABEL[p.targetColor]} 在你的「${dir.label}」方向`, answer: dir.key };
    }
    case 'monk': {
      // p.dir ray; count inner walls (wall or chamber) along it to the edge
      let count = 0;
      let r = it.pos.r, c = it.pos.c;
      const d = DIRS[p.dir];
      while (true) {
        r += d.dr; c += d.dc;
        if (!inBounds(r, c)) break;
        if (state.maze.cells[r][c] === CELL.WALL || state.maze.cells[r][c] === CELL.CHAMBER) count++;
      }
      return { ok: true, info: `${DIRS[p.dir].label}方向上有 ${count} 面内壁`, answer: count };
    }
    case 'geographer': {
      // p.dirs = up to 2 direction keys of adjacent unexplored cells; reveal+place
      // Geographer asks only "room or wall" (rulebook 角色指南). Walls are
      // recorded generic (inner/outer not distinguished); chamber reads as a room.
      const reveals = [];
      for (const dir of (p.dirs || [])) {
        const tgt = neighborInDir(it.pos, dir);
        const t = trueType(state, tgt.r, tgt.c);
        const walkable = (t === CELL.ROOM || t === CELL.CHAMBER);
        it.explored[key(tgt.r, tgt.c)] = walkable ? (t === CELL.CHAMBER ? CELL.CHAMBER : CELL.ROOM) : CELL.WALL;
        reveals.push(`${DIRS[dir].label}=${walkable ? '房间' : '墙壁'}`);
      }
      return { ok: true, info: `勘测：${reveals.join('，')}` };
    }
    case 'mercenary': {
      // freeze guards within the 9-cell block around self for the next guardian turn
      const near = cheby(state.guard.pos, it.pos) <= 1;
      if (near) state.frozenGuards = true;
      return { ok: true, info: near ? '已冻结附近的卫兵（持续到下个遗迹役手番结束）' : '附近没有卫兵，能力空放' };
    }
    case 'doctor': {
      const tgt = state.inv[p.targetColor];
      if (!tgt) return { ok: false, reason: '目标不存在。' };
      if (!tgt.laidDown) return { ok: false, reason: '目标尚未结束手番。' };
      tgt.laidDown = false;
      return { ok: true, info: `让 ${COLOR_LABEL[p.targetColor]} 重新行动` };
    }
    default:
      return { ok: false, reason: `未知角色能力：${charId}` };
  }
}

function cardinalDir(from, to) {
  const dr = to.r - from.r;
  const dc = to.c - from.c;
  if (dr === 0 && dc === 0) return DIRS.N; // same cell → arbitrary
  if (Math.abs(dr) >= Math.abs(dc)) {
    return dr < 0 ? { ...DIRS.N, key: 'N' } : { ...DIRS.S, key: 'S' };
  }
  return dc < 0 ? { ...DIRS.W, key: 'W' } : { ...DIRS.E, key: 'E' };
}

// --------------------------------------------------------------------------
// Escape decision (MODE.ESCAPE_DECISION)
// --------------------------------------------------------------------------
export function allOnSameCell(state) {
  const first = state.inv[state.colors[0]].pos;
  return state.colors.every((c) => {
    const p = state.inv[c].pos;
    return p.r === first.r && p.c === first.c;
  });
}

export function attemptEscape(state, doIt) {
  if (state.mode !== MODE.ESCAPE_DECISION) return { ok: false };
  if (doIt) {
    const success = allOnSameCell(state);
    state.mode = MODE.GAME_OVER;
    state.winner = success ? WINNER.INVESTIGATORS : WINNER.GUARDIAN;
    state.log.push(success ? '脱出成功！探检家胜利！' : '脱出失败：探检家不在同一格。遗迹役胜利！');
    return { ok: true, success };
  }
  // proceed to action prediction
  state.mode = MODE.PREDICTION;
  for (const c of state.colors) state.inv[c].actionCard = null;
  state.log.push('不脱出 → 进入行动预测。');
  return { ok: true, success: null };
}

// --------------------------------------------------------------------------
// Action prediction (MODE.PREDICTION) — secret 警戒/休憩
// --------------------------------------------------------------------------
export function forcedRest(state, color) {
  return state.inv[color].forcedRestNextRound;
}

export function setPrediction(state, color, action) {
  if (state.mode !== MODE.PREDICTION) return { ok: false };
  const it = state.inv[color];
  if (it.forcedRestNextRound) action = ACTION.REST; // 禁止警戒
  it.actionCard = action;
  const allSet = state.colors.every((c) => state.inv[c].actionCard !== null);
  if (allSet) enterGuardian(state);
  return { ok: true, forced: it.forcedRestNextRound };
}

function enterGuardian(state) {
  // Timeout: if no tiles remain when the guardian's turn begins, guardian wins.
  if (state.totalTilesLeft <= 0) {
    state.mode = MODE.GAME_OVER;
    state.winner = WINNER.GUARDIAN;
    state.log.push('时间耗尽，轮到遗迹役手番 → 遗迹役胜利！');
    return;
  }
  state.mode = MODE.GUARDIAN;
  state.guardTurn = { movesUsed: 0, deityMovesUsed: 0, attacked: [] };
  state.log.push(`—— 遗迹役手番（第 ${state.round} 轮）——`);
}

// --------------------------------------------------------------------------
// Guardian turn (MODE.GUARDIAN)
// --------------------------------------------------------------------------
function occupiedByInvestigator(state, r, c) {
  return state.colors.some((col) => state.inv[col].pos.r === r && state.inv[col].pos.c === c);
}

export function canMoveGuard(state, dirKey) {
  if (state.mode !== MODE.GUARDIAN || state.frozenGuards) return false;
  if (state.guardTurn.movesUsed >= state.guardMaxMoves) return false;
  const tgt = neighborInDir(state.guard.pos, dirKey);
  if (!walkableAt(state.maze, tgt.r, tgt.c)) return false;
  if (state.maze.cells[tgt.r][tgt.c] === CELL.CHAMBER) return false; // one-way: cannot re-enter
  if (occupiedByInvestigator(state, tgt.r, tgt.c)) return false;
  return true;
}

export function moveGuard(state, dirKey) {
  if (!canMoveGuard(state, dirKey)) return { ok: false };
  const tgt = neighborInDir(state.guard.pos, dirKey);
  state.guard.pos = { r: tgt.r, c: tgt.c };
  state.guardTurn.movesUsed += 1;
  return { ok: true };
}

export function canMoveDeity(state, dirKey, targetColor) {
  if (state.mode !== MODE.GUARDIAN || !state.deity.active) return false;
  if (state.guardTurn.deityMovesUsed >= RULES.deityMoves) return false;
  const tgt = neighborInDir(state.deity.pos, dirKey);
  if (!walkableAt(state.maze, tgt.r, tgt.c)) return false;
  if (state.maze.cells[tgt.r][tgt.c] === CELL.CHAMBER) return false;
  if (occupiedByInvestigator(state, tgt.r, tgt.c)) return false;
  // deity may not increase its distance to the chosen target
  if (targetColor) {
    const t = state.inv[targetColor].pos;
    if (manhattan(tgt, t) > manhattan(state.deity.pos, t)) return false;
  }
  return true;
}

export function moveDeity(state, dirKey, targetColor) {
  if (!canMoveDeity(state, dirKey, targetColor)) return { ok: false };
  const tgt = neighborInDir(state.deity.pos, dirKey);
  state.deity.pos = { r: tgt.r, c: tgt.c };
  state.guardTurn.deityMovesUsed += 1;
  return { ok: true };
}

// Which investigators can a given attacker (guard or deity) currently hit?
export function attackTargets(state, attacker = 'guard') {
  const unit = attacker === 'deity' ? state.deity : state.guard;
  if (attacker === 'deity' && !state.deity.active) return [];
  if (attacker === 'guard' && state.frozenGuards) return [];
  const lastAttacked = unit.lastAttacked;
  return state.colors.filter((col) => {
    if (RULES.noRepeatAttack && lastAttacked === col) return false; // no two-in-a-row
    return manhattan(unit.pos, state.inv[col].pos) <= 1; // same or orthogonally adjacent
  });
}

export function attack(state, color, attacker = 'guard') {
  if (state.mode !== MODE.GUARDIAN) return { ok: false };
  if (!attackTargets(state, attacker).includes(color)) return { ok: false, reason: '该目标不在攻击范围/不可连续攻击。' };
  const it = state.inv[color];
  const unit = attacker === 'deity' ? state.deity : state.guard;

  let success;
  if (attacker === 'deity') {
    success = true; // 超攻击 ignores 警戒
  } else {
    success = it.actionCard === ACTION.REST; // 休憩 caught = hit; 警戒 blocks
  }

  state.guardTurn.attacked.push(color);
  unit.lastAttacked = color;

  if (success) {
    consumeTiles(state, RULES.attackTileLoss, `${attacker === 'deity' ? '守护神超攻击' : '攻击'} 命中 ${COLOR_LABEL[color]}`);
    state.log.push(`攻击命中 ${COLOR_LABEL[color]}（${attacker === 'deity' ? '无视警戒' : '其出休憩'}）。`);
  } else {
    state.log.push(`攻击 ${COLOR_LABEL[color]} 被「警戒」挡下。`);
  }
  return { ok: true, success };
}

export function endGuardianTurn(state) {
  if (state.mode !== MODE.GUARDIAN) return { ok: false };
  // 禁止警戒 marker: investigators who played 警戒 but were NOT attacked are
  // forced to 休憩 next round; everyone else is cleared.
  for (const color of state.colors) {
    const it = state.inv[color];
    const wasAttacked = state.guardTurn.attacked.includes(color);
    if (it.actionCard === ACTION.CAUTION && !wasAttacked) {
      it.forcedRestNextRound = true;
    } else {
      it.forcedRestNextRound = false;
    }
  }
  // recover: stand everyone up, clear cards, clear mercenary freeze, next round
  for (const color of state.colors) {
    const it = state.inv[color];
    it.laidDown = false;
    it.actionCard = null;
  }
  state.frozenGuards = false;
  state.round += 1;
  state.guardTurn = null;

  // Even at 0 tiles the investigators get a "last gasp" turn: they may still
  // move / use abilities (no explore) and attempt escape. Timeout is only
  // adjudicated when the guardian's next turn begins (see enterGuardian),
  // matching rulebook 13.4 / 14.2 ("Phase 4 ends → escape challenge runs as
  // normal → only then does the guardian win on time").
  state.mode = MODE.INVESTIGATORS;
  state.log.push(`—— 第 ${state.round} 轮 探检家手番 ——`);
  return { ok: true };
}
