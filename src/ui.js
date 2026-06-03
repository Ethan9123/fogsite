// FOGSITE — browser UI controller (local hotseat). Imports the pure engine and
// drives a screen state machine layered on top of the game state machine.
// Privacy model: each investigator sees only their OWN, position-relative map
// (they must still deduce where they are and where teammates are); the Guardian
// sees the full truth. Handoff/"pass the screen" interstitials enforce secrecy.
import {
  GRID, CELL, COLORS, COLOR_LABEL, ACTION, ACTION_LABEL,
  CHARACTERS, CHARACTER_BY_ID, RULES, MODE, WINNER, DIRS, DIR_KEYS,
} from './rules.js';
import { emptyMaze, validateMaze, generateMaze, makeRng } from './maze.js';
import * as G from './game.js';

const app = document.getElementById('app');
const clockEl = document.getElementById('clock');
const key = (r, c) => `${r},${c}`;
const ESCAPE_SECONDS = 60;

// Escape-challenge timed-commit state (digital-only twist): all investigators
// must press "confirm" within ESCAPE_SECONDS to fire the same-cell check.
let escapeState = null; // { confirms: Set<color>, deadline: ms, timer: intervalId }
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------
const ui = {
  screen: 'setup',
  game: null,
  handoff: null,      // { label, next }
  activeColor: null,  // current investigator (turn or prediction)
  action: null,       // 'explore' | 'move' | 'ability'
  abilityDirs: [],    // geographer multi-select
  copyId: null,       // apprentice copy target
  turnResult: null,   // private result shown after a turn-ending action
  error: null,        // transient illegal-move message
  deityTarget: null,  // guardian: deity move target color
  attackResults: {},  // guardian: color -> 'hit' | 'block'
  builder: newBuilder(),
};

function newBuilder() {
  return {
    count: 2,
    characters: { red: 'archaeologist', green: 'guide', blue: 'monk' },
    guardianName: '',
    tool: 'wall',
    maze: emptyMaze(),
  };
}
function builderColors(b) { return COLORS.slice(0, b.count); }

// ---------------------------------------------------------------------------
// Render dispatch
// ---------------------------------------------------------------------------
function render() {
  renderClock();
  let html = '';
  switch (ui.screen) {
    case 'setup': html = renderSetup(); break;
    case 'handoff': html = renderHandoff(); break;
    case 'investigator': html = renderInvestigator(); break;
    case 'escape': html = renderEscape(); break;
    case 'predict': html = renderPredict(); break;
    case 'guardian': html = renderGuardian(); break;
    case 'gameover': html = renderGameOver(); break;
    default: html = '<div class="panel">…</div>';
  }
  app.innerHTML = html;
}

function renderClock() {
  const g = ui.game;
  if (!g) { clockEl.innerHTML = ''; return; }
  clockEl.innerHTML =
    `第 <b>${g.round}</b> 轮 · 阶段 <b>P${g.phaseIndex + 1}</b> · 剩余地块 <b>${g.totalTilesLeft}</b>` +
    (g.deity.active ? ' · <b style="color:#c8a24a">守护神已现</b>' : '');
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------
function cellClass(val) {
  if (val === CELL.ROOM) return 'room';
  if (val === CELL.CHAMBER) return 'chamber';
  if (val === 'wall-inner') return 'wall-inner';
  if (val === 'wall-outer') return 'wall-outer';
  if (val === CELL.WALL) return 'wall';
  return 'fog';
}

// Setup builder grid (absolute truth, clickable).
function renderBuilderGrid(b) {
  const cells = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const t = b.maze.cells[r][c];
      const cls = t === CELL.WALL ? 'wall' : t === CELL.CHAMBER ? 'chamber' : 'room';
      let inner = '';
      if (t === CELL.CHAMBER) inner += '<span class="mark">石</span>';
      for (const col of builderColors(b)) {
        const s = b.maze.starts[col];
        if (s && s.r === r && s.c === c) inner += `<span class="pawn ${col}"></span>`;
      }
      cells.push(`<div class="cell ${cls} clickable" data-act="paint" data-r="${r}" data-c="${c}">${inner}</div>`);
    }
  }
  return `<div class="gridwrap"><div class="grid" style="grid-template-columns:repeat(${GRID},52px)">${cells.join('')}</div></div>`;
}

// Investigator ego-centric relative map (9x9, start at center). Hides absolute
// coordinates, guard/deity, and other investigators — pure deduction view.
function renderEgoGrid(g, color) {
  const it = g.inv[color];
  const span = 4; // display radius
  const size = span * 2 + 1;
  const cells = [];
  for (let dr = -span; dr <= span; dr++) {
    for (let dc = -span; dc <= span; dc++) {
      const ar = it.startPos.r + dr, ac = it.startPos.c + dc;
      const val = it.explored[key(ar, ac)];
      const cls = cellClass(val);
      let inner = '';
      if (it.pos.r === ar && it.pos.c === ac) inner += `<span class="pawn ${color}"></span>`;
      if (it.startPos.r === ar && it.startPos.c === ac) inner += '<span class="mark">起</span>';
      cells.push(`<div class="cell ${cls}">${inner}</div>`);
    }
  }
  return `<div class="gridwrap"><div class="grid" style="grid-template-columns:repeat(${size},52px)">${cells.join('')}</div></div>`;
}

// Guardian full-truth grid (absolute) with all pawns, guard, deity.
function renderTruthGrid(g) {
  const cells = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const t = g.maze.cells[r][c];
      const cls = t === CELL.WALL ? 'wall' : t === CELL.CHAMBER ? 'chamber' : 'room';
      let inner = '';
      if (t === CELL.CHAMBER) inner += '<span class="mark">石</span>';
      const here = g.colors.filter((col) => g.inv[col].pos.r === r && g.inv[col].pos.c === c);
      here.forEach((col, i) => {
        inner += `<span class="pawn ${col}" style="left:${6 + i * 12}px;top:${14}px"></span>`;
      });
      if (g.guard.pos.r === r && g.guard.pos.c === c) inner += '<span class="guard" title="卫兵"></span>';
      if (g.deity.active && g.deity.pos.r === r && g.deity.pos.c === c) inner += '<span class="deity" title="守护神"></span>';
      cells.push(`<div class="cell ${cls}">${inner}</div>`);
    }
  }
  return `<div class="gridwrap"><div class="grid" style="grid-template-columns:repeat(${GRID},52px)">${cells.join('')}</div></div>`;
}

const legend = `<div class="legend">
  <span><i style="background:#cfd6e6"></i>房间</span>
  <span><i style="background:#5a4632"></i>墙壁</span>
  <span><i style="background:#8a5cc4"></i>石室</span>
  <span><i style="background:#2a2f40"></i>未探明</span>
</div>`;

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------
function renderSetup() {
  const b = ui.builder;
  const cols = builderColors(b);
  const v = validateMaze(b.maze, cols);

  const charOpts = (sel) => CHARACTERS.map((ch) =>
    `<option value="${ch.id}" ${ch.id === sel ? 'selected' : ''}>${ch.name}（${ch.en}）</option>`).join('');

  const charRows = cols.map((col) => `
    <label class="fld"><span class="pill tag-${col}">${COLOR_LABEL[col]}</span>
      <select data-act="set-char" data-color="${col}">${charOpts(b.characters[col])}</select>
    </label>`).join('');

  const tools = [
    ['wall', '墙壁/房间'], ['chamber', '石室'], ['room', '清为房间'],
    ...cols.map((col) => [`start-${col}`, `${COLOR_LABEL[col]}起点`]),
  ];
  const toolBtns = tools.map(([t, label]) =>
    `<button data-act="set-tool" data-tool="${t}" class="${b.tool === t ? 'sel' : ''}">${label}</button>`).join('');

  const errs = v.ok ? '<div class="notice good">迷宫合法，可以开始。</div>'
    : `<div class="errlist">${v.errors.map((e) => `<div>• ${esc(e.msg)}</div>`).join('')}</div>`;

  return `<div class="panel">
    <h2>遗迹役布置阶段</h2>
    <p class="hint">由「遗迹役」秘密建造 5×5 迷宫并分配角色。投资者请勿观看本屏幕。完成后点击「开始游戏」。</p>
    <div class="row">
      <div class="col">
        <h3>1 · 人数与角色</h3>
        <div class="btnrow">
          <button data-act="set-count" data-n="2" class="${b.count === 2 ? 'sel' : ''}">2 名探检家</button>
          <button data-act="set-count" data-n="3" class="${b.count === 3 ? 'sel' : ''}">3 名探检家</button>
        </div>
        ${charRows}
        <label class="fld"><span>遗迹役名字</span>
          <input type="text" data-act="set-gm" placeholder="遗迹役" value="${esc(b.guardianName)}" />
        </label>
        <h3>3 · 检查</h3>
        ${errs}
        <div class="btnrow">
          <button data-act="autogen">随机生成合法迷宫</button>
          <button data-act="clear" class="danger">清空</button>
        </div>
        <div class="spacer"></div>
        <button data-act="start" class="primary big" ${v.ok ? '' : 'disabled'}>开始游戏 →</button>
      </div>
      <div class="col">
        <h3>2 · 建造迷宫</h3>
        <p class="hint">选择工具后点击格子绘制。需要：≥${RULES.innerWalls} 面内壁、正好 ${RULES.chambers} 间石室、每色 1 个起点（起点须为房间、彼此不相邻、不挨石室）。</p>
        <div class="btnrow">${toolBtns}</div>
        ${renderBuilderGrid(b)}
        ${legend}
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Handoff (privacy) screen
// ---------------------------------------------------------------------------
function renderHandoff() {
  const h = ui.handoff;
  return `<div class="panel handoff">
    <div class="secret">🔒</div>
    <div>请将屏幕交给</div>
    <div class="big-label">${esc(h.label)}</div>
    <div class="warn">其他玩家请勿观看屏幕</div>
    <button data-act="handoff-go" class="primary big">我已就位，开始</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Investigator turn screen
// ---------------------------------------------------------------------------
function renderInvestigator() {
  const g = ui.game;
  const color = ui.activeColor;
  const it = g.inv[color];
  const char = CHARACTER_BY_ID[it.characterId];
  const tiles = g.totalTilesLeft;

  let controls = '';
  if (ui.turnResult) {
    controls = `<div class="notice good">${esc(ui.turnResult)}</div>
      <button data-act="inv-continue" class="primary big">继续（交给下一位）→</button>`;
  } else if (!ui.action) {
    const err = ui.error ? `<div class="notice bad">${esc(ui.error)}</div>` : '';
    controls = `${err}
      <div class="btnrow">
        <button data-act="inv-mode" data-mode="explore" ${tiles > 0 ? '' : 'disabled'}>探索（揭示相邻格）</button>
        <button data-act="inv-mode" data-mode="move">移动（走向已知房间）</button>
        <button data-act="inv-mode" data-mode="ability" ${it.fatigue ? 'disabled' : ''}>使用能力</button>
        <button data-act="inv-pass">跳过本手番</button>
      </div>
      <p class="hint">本回合只能执行其中 <b>一种</b> 行动。${it.fatigue ? '（你的能力已疲劳，暂不可用）' : ''}${tiles > 0 ? '' : '（地块已耗尽，无法探索）'}</p>`;
  } else if (ui.action === 'explore') {
    controls = dpad('inv-dir', (k) => {
      const tgt = { r: it.pos.r + DIRS[k].dr, c: it.pos.c + DIRS[k].dc };
      return it.explored[key(tgt.r, tgt.c)] === undefined && tiles > 0;
    }) + cancelBtn('选择一个方向探索（揭示该相邻格）。');
  } else if (ui.action === 'move') {
    controls = dpad('inv-dir', (k) => G.canMove(g, color, k)) + cancelBtn('移动到一个已探明的相邻房间。');
  } else if (ui.action === 'ability') {
    controls = renderAbilityUI(g, color, char);
  }

  return `<div class="panel">
    <h2><span class="pill tag-${color}">${COLOR_LABEL[color]}</span> 探检家 · ${esc(char.name)}</h2>
    <div class="kv">
      <span>起点周围房间数：<b>${g.startHints[color]}</b></span>
      <span>角色能力：${ui.action === 'ability' || true ? esc(char.desc) : ''}</span>
    </div>
    <div class="row">
      <div class="col" style="flex:0 0 auto">${renderEgoGrid(g, color)}${legend}
        <p class="hint">这是你的相对地图：「起」是你的起点，你并不知道自己在 5×5 中的绝对位置——需要靠探索与推理还原。</p>
      </div>
      <div class="col">${controls}</div>
    </div>
  </div>`;
}

function dpad(act, enabledFn) {
  const cellFor = (k, cls) => {
    const en = enabledFn(k);
    return `<button class="${cls}" data-act="${act}" data-dir="${k}" ${en ? '' : 'disabled'}>${DIRS[k].label}</button>`;
  };
  return `<div class="dpad">
    ${cellFor('N', 'n')}${cellFor('W', 'w')}<div class="mid">方向</div>${cellFor('E', 'e')}${cellFor('S', 's')}
  </div>`;
}
function cancelBtn(hintText) {
  return `<p class="hint">${esc(hintText)}</p><button data-act="inv-cancel">← 返回</button>`;
}

// ability UI by character kind (apprentice wraps a chosen copy target)
function renderAbilityUI(g, color, char) {
  const it = g.inv[color];
  let kind = char.kind;
  let head = '';

  if (char.id === 'apprentice') {
    const opts = CHARACTERS.filter((c) => c.id !== 'apprentice')
      .map((c) => `<option value="${c.id}" ${ui.copyId === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
    head = `<label class="fld"><span>复制角色</span>
      <select data-act="set-copy"><option value="">— 选择 —</option>${opts}</select></label>`;
    if (!ui.copyId) return head + cancelBtn('见习：先选择要复制的角色能力。');
    kind = CHARACTER_BY_ID[ui.copyId].kind;
  }

  const err = ui.error ? `<div class="notice bad">${esc(ui.error)}</div>` : '';
  let body = '';
  switch (kind) {
    case 'pick-adjacent-wall':
    case 'pick-straight-direction':
      body = dpad('abil-dir', () => true);
      break;
    case 'pick-other-investigator': {
      const others = g.colors.filter((c) => c !== color);
      body = `<div class="btnrow">${others.map((c) =>
        `<button data-act="abil-target" data-color="${c}"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span></button>`).join('')}</div>`;
      break;
    }
    case 'pick-two-adjacent-empty': {
      const btns = DIR_KEYS.map((k) =>
        `<button data-act="abil-geo" data-dir="${k}" class="${ui.abilityDirs.includes(k) ? 'sel' : ''}">${DIRS[k].label}</button>`).join('');
      body = `<div class="btnrow">${btns}</div>
        <button data-act="abil-geo-confirm" class="primary" ${ui.abilityDirs.length ? '' : 'disabled'}>勘测这 ${ui.abilityDirs.length} 格</button>`;
      break;
    }
    case 'freeze-guards':
      body = `<button data-act="abil-confirm" class="primary">冻结周围 9 格内的卫兵</button>`;
      break;
    case 'revive-investigator': {
      const down = g.colors.filter((c) => c !== color && g.inv[c].laidDown);
      body = down.length
        ? `<div class="btnrow">${down.map((c) => `<button data-act="abil-target" data-color="${c}"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span> 复活</button>`).join('')}</div>`
        : `<p class="hint">目前没有「已结束手番」的队友可供复活。</p>`;
      break;
    }
    default: body = '<p class="hint">（该能力暂未实现交互）</p>';
  }
  return head + err + body + `<div class="spacer"></div>` + cancelBtn('能力使用后本手番即结束。');
}

// ---------------------------------------------------------------------------
// Escape decision
// ---------------------------------------------------------------------------
function renderEscape() {
  const g = ui.game;
  const confirms = escapeState ? escapeState.confirms : new Set();
  const remain = escapeState ? Math.max(0, escapeState.deadline - Date.now()) : ESCAPE_SECONDS * 1000;

  const btns = g.colors.map((c) => {
    const done = confirms.has(c);
    return `<button data-act="escape-confirm" data-color="${c}" class="big ${done ? 'sel' : ''}" ${done ? 'disabled' : ''}>
      <span class="pill tag-${c}">${COLOR_LABEL[c]}</span> ${done ? '✓ 已确认' : '确认脱出'}</button>`;
  }).join('');

  return `<div class="panel center">
    <h2>脱出挑战</h2>
    <p class="hint">所有探检家手番已结束。若你们认为全员已在同一格，可发起脱出挑战。<br>
      在 <b>${ESCAPE_SECONDS} 秒</b>内，全部 ${g.colors.length} 名探检家都按下「确认脱出」即触发检定：<br>
      全员同格 → 探检家胜利；任意一人不同格 → 遗迹役胜利。倒计时结束仍未全员确认 → 放弃脱出，继续探索。</p>
    <div class="who" id="escape-timer" style="color:var(--accent)">${(remain / 1000).toFixed(1)}s</div>
    <div class="btnrow center" style="justify-content:center">${btns}</div>
    <div class="spacer"></div>
    <button data-act="escape-skip">放弃脱出，继续探索</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Prediction (secret 警戒/休憩)
// ---------------------------------------------------------------------------
function renderPredict() {
  const g = ui.game;
  const color = ui.activeColor;
  const forced = G.forcedRest(g, color);
  return `<div class="panel center">
    <h2><span class="pill tag-${color}">${COLOR_LABEL[color]}</span> 秘密行动预测</h2>
    <p class="hint">遗迹役即将行动。秘密选择你的行动卡——出「休憩」若被攻击会损失 ${RULES.attackTileLoss} 块地块；出「警戒」可挡下攻击，但若没被攻击会被贴「禁止警戒牌」。</p>
    ${forced ? '<div class="notice bad">你身上有「禁止警戒牌」，本回合只能选择「休憩」。</div>' : ''}
    <div class="btnrow center" style="justify-content:center">
      <button data-act="predict" data-card="${ACTION.CAUTION}" class="big" ${forced ? 'disabled' : ''}>警戒</button>
      <button data-act="predict" data-card="${ACTION.REST}" class="big">休憩</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Guardian turn
// ---------------------------------------------------------------------------
function renderGuardian() {
  const g = ui.game;
  const gt = g.guardTurn;
  const guardTargets = G.attackTargets(g, 'guard');
  const deityTargets = g.deity.active ? G.attackTargets(g, 'deity') : [];

  const cardRow = g.colors.map((c) => {
    const res = ui.attackResults[c];
    const it = g.inv[c];
    let face = '面朝下';
    if (res) face = `${ACTION_LABEL[it.actionCard]} · ${res === 'hit' ? '命中' : '被挡'}`;
    return `<span class="pill tag-${c}">${COLOR_LABEL[c]}</span> <span class="pill">${face}</span>`;
  }).join(' &nbsp; ');

  const guardDpad = dpad('guard-move', (k) => G.canMoveGuard(g, k));
  let deitySection = '';
  if (g.deity.active) {
    const opts = g.colors.map((c) =>
      `<option value="${c}" ${ui.deityTarget === c ? 'selected' : ''}>${COLOR_LABEL[c]}</option>`).join('');
    deitySection = `<h3>守护神（${gt.deityMovesUsed}/${RULES.deityMoves} 步，须不远离目标）</h3>
      <label class="fld"><span>追击目标</span><select data-act="deity-target"><option value="">— 选择 —</option>${opts}</select></label>
      ${ui.deityTarget ? dpad('deity-move', (k) => G.canMoveDeity(g, k, ui.deityTarget)) : '<p class="hint">先选择追击目标。</p>'}`;
  }

  const atkBtns = (list, attacker) => list.length
    ? list.map((c) => `<button data-act="attack" data-attacker="${attacker}" data-color="${c}" class="danger"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span> 攻击</button>`).join('')
    : '<span class="hint">无可攻击目标</span>';

  const frozen = g.frozenGuards ? '<div class="notice bad">卫兵被「元傭兵」冻结，本手番无法移动或攻击（守护神不受影响）。</div>' : '';

  return `<div class="panel">
    <h2>遗迹役手番 · ${esc(g.guardianName)}</h2>
    <div class="kv">
      <span>卫兵机动：<b>${gt.movesUsed}/${g.guardMaxMoves}</b></span>
      <span>剩余地块：<b>${g.totalTilesLeft}</b></span>
      <span>不可连续攻击同一人</span>
    </div>
    ${frozen}
    <div class="row">
      <div class="col" style="flex:0 0 auto">${renderTruthGrid(g)}
        <div class="legend"><span>■ 卫兵</span><span>● 守护神</span><span>○ 探检家</span><span>石 石室</span></div>
      </div>
      <div class="col">
        <h3>卫兵移动（${gt.movesUsed}/${g.guardMaxMoves}）</h3>
        ${guardDpad}
        ${deitySection}
        <h3>攻击</h3>
        <p class="hint">卫兵攻击会翻开目标行动卡：出「休憩」→ 命中扣 ${RULES.attackTileLoss} 块；出「警戒」→ 被挡。守护神攻击无视警戒。</p>
        <div class="btnrow">${atkBtns(guardTargets, 'guard')}</div>
        ${g.deity.active ? `<div class="btnrow">守护神：${atkBtns(deityTargets, 'deity')}</div>` : ''}
        <h3>行动卡</h3>
        <div class="kv">${cardRow}</div>
        <div class="spacer"></div>
        <button data-act="guard-end" class="primary big">结束遗迹役手番 →</button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function renderGameOver() {
  const g = ui.game;
  const inv = g.winner === WINNER.INVESTIGATORS;
  const logHtml = g.log.slice(-40).map((l) => `<div>${esc(l)}</div>`).join('');
  return `<div class="panel win">
    <h2>游戏结束</h2>
    <div class="who" style="color:${inv ? 'var(--green)' : 'var(--red)'}">${inv ? '探检家胜利！' : '遗迹役胜利！'}</div>
    <p class="hint">${inv ? '全员成功在同一格脱出。' : '在探检家脱出前耗尽时间，或脱出失败。'}</p>
    <div class="log" style="text-align:left;max-width:560px;margin:18px auto">${logHtml}</div>
    <button data-act="new-game" class="primary big">再来一局</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Flow driver
// ---------------------------------------------------------------------------
function advance() {
  const g = ui.game;
  ui.error = null;
  switch (g.mode) {
    case MODE.GAME_OVER: ui.screen = 'gameover'; render(); break;
    case MODE.INVESTIGATORS: nextInvestigator(); break;
    case MODE.ESCAPE_DECISION: startEscape(); break;
    case MODE.PREDICTION: nextPredictor(); break;
    case MODE.GUARDIAN:
      handoffTo(g.guardianName, () => { ui.screen = 'guardian'; ui.attackResults = {}; ui.deityTarget = null; });
      break;
  }
}

function handoffTo(label, next) {
  ui.handoff = { label, next };
  ui.screen = 'handoff';
  render();
}

function startEscape() {
  ui.screen = 'escape';
  escapeState = { confirms: new Set(), deadline: Date.now() + ESCAPE_SECONDS * 1000, timer: null };
  render();
  escapeState.timer = setInterval(escapeTick, 200);
}
function stopEscape() {
  if (escapeState && escapeState.timer) clearInterval(escapeState.timer);
  escapeState = null;
}
function escapeTick() {
  if (!escapeState) return;
  const remain = Math.max(0, escapeState.deadline - Date.now());
  const el = document.getElementById('escape-timer');
  if (el) el.textContent = (remain / 1000).toFixed(1) + 's';
  if (remain <= 0) {
    stopEscape();
    ui.game.log.push('脱出确认超时，本回合放弃脱出。');
    G.attemptEscape(ui.game, false);
    advance();
  }
}
function confirmEscape(color) {
  if (!escapeState) return;
  escapeState.confirms.add(color);
  if (escapeState.confirms.size >= ui.game.colors.length) {
    stopEscape();
    G.attemptEscape(ui.game, true);
    advance();
  } else {
    render();
  }
}

function nextInvestigator() {
  const g = ui.game;
  const color = g.colors.find((c) => !g.inv[c].laidDown);
  if (!color) { advance(); return; } // engine will have transitioned
  handoffTo(`${COLOR_LABEL[color]} 探检家`, () => {
    ui.activeColor = color; ui.action = null; ui.turnResult = null;
    ui.abilityDirs = []; ui.copyId = null; ui.error = null;
    ui.screen = 'investigator';
  });
}

function nextPredictor() {
  const g = ui.game;
  const color = g.colors.find((c) => g.inv[c].actionCard === null);
  if (!color) { advance(); return; }
  handoffTo(`${COLOR_LABEL[color]} 探检家（秘密出牌）`, () => {
    ui.activeColor = color; ui.screen = 'predict';
  });
}

// ---------------------------------------------------------------------------
// Event handling (delegated)
// ---------------------------------------------------------------------------
app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const g = ui.game;

  switch (act) {
    // ---- setup ----
    case 'set-count': ui.builder.count = Number(t.dataset.n); render(); break;
    case 'set-tool': ui.builder.tool = t.dataset.tool; render(); break;
    case 'paint': paint(ui.builder, Number(t.dataset.r), Number(t.dataset.c)); render(); break;
    case 'autogen': autogen(); render(); break;
    case 'clear': ui.builder.maze = emptyMaze(); render(); break;
    case 'start': startGame(); break;

    // ---- handoff ----
    case 'handoff-go': { const n = ui.handoff.next; ui.handoff = null; n(); render(); break; }

    // ---- investigator ----
    case 'inv-mode': ui.action = t.dataset.mode; ui.error = null; render(); break;
    case 'inv-cancel': ui.action = null; ui.abilityDirs = []; ui.copyId = null; ui.error = null; render(); break;
    case 'inv-pass': G.endTurn(g, ui.activeColor); ui.turnResult = '已跳过本手番。'; render(); break;
    case 'inv-dir': doDirAction(t.dataset.dir); break;
    case 'inv-continue':
      ui.turnResult = null; ui.action = null; ui.abilityDirs = []; ui.copyId = null;
      advance(); break;

    // ---- abilities ----
    case 'abil-dir': doAbility({ dir: t.dataset.dir }); break;
    case 'abil-target': doAbility({ targetColor: t.dataset.color }); break;
    case 'abil-geo': toggleGeo(t.dataset.dir); render(); break;
    case 'abil-geo-confirm': doAbility({ dirs: ui.abilityDirs.slice() }); break;
    case 'abil-confirm': doAbility({}); break;

    // ---- escape (timed unanimous commit) ----
    case 'escape-confirm': confirmEscape(t.dataset.color); break;
    case 'escape-skip': stopEscape(); G.attemptEscape(g, false); advance(); break;

    // ---- prediction ----
    case 'predict': {
      G.setPrediction(g, ui.activeColor, t.dataset.card);
      advance(); break;
    }

    // ---- guardian ----
    case 'guard-move': G.moveGuard(g, t.dataset.dir); render(); break;
    case 'deity-move': G.moveDeity(g, t.dataset.dir, ui.deityTarget); render(); break;
    case 'attack': {
      const res = G.attack(g, t.dataset.color, t.dataset.attacker);
      if (res.ok) ui.attackResults[t.dataset.color] = res.success ? 'hit' : 'block';
      render(); break;
    }
    case 'guard-end': G.endGuardianTurn(g); advance(); break;

    // ---- game over ----
    case 'new-game': ui.game = null; ui.builder = newBuilder(); ui.screen = 'setup'; render(); break;
  }
});

app.addEventListener('change', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  switch (t.dataset.act) {
    case 'set-char': ui.builder.characters[t.dataset.color] = t.value; break;
    case 'set-gm': ui.builder.guardianName = t.value; break;
    case 'set-copy': ui.copyId = t.value || null; render(); break;
    case 'deity-target': ui.deityTarget = t.value || null; render(); break;
  }
});

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------
function doDirAction(dir) {
  const g = ui.game, color = ui.activeColor;
  if (ui.action === 'explore') {
    const res = G.explore(g, color, dir);
    if (res.ok) ui.turnResult = res.result === 'room' ? '探索结果：房间（已记入地图）。'
      : '探索结果：墙壁，撞墙，本手番结束。';
  } else if (ui.action === 'move') {
    const res = G.move(g, color, dir);
    if (res.ok) ui.turnResult = '已移动到该相邻房间，本手番结束。';
    else ui.error = '无法朝该方向移动。';
  }
  render();
}

function toggleGeo(dir) {
  const i = ui.abilityDirs.indexOf(dir);
  if (i >= 0) ui.abilityDirs.splice(i, 1);
  else if (ui.abilityDirs.length < 2) ui.abilityDirs.push(dir);
}

function doAbility(params) {
  const g = ui.game, color = ui.activeColor;
  const it = g.inv[color];
  const payload = it.characterId === 'apprentice' ? { copyId: ui.copyId, inner: params } : params;
  const res = G.useAbility(g, color, payload);
  if (res.ok) {
    ui.turnResult = `能力结果：${res.info}`;
    ui.error = null;
  } else {
    ui.error = res.reason || '能力使用失败。';
  }
  render();
}

// ---------------------------------------------------------------------------
// Setup actions
// ---------------------------------------------------------------------------
function paint(b, r, c) {
  const t = b.tool;
  const clearStartsAt = () => {
    for (const k of Object.keys(b.maze.starts)) {
      const s = b.maze.starts[k]; if (s.r === r && s.c === c) delete b.maze.starts[k];
    }
  };
  const clearChamberAt = () => { if (b.maze.chamber && b.maze.chamber.r === r && b.maze.chamber.c === c) b.maze.chamber = null; };

  if (t === 'wall') {
    const now = b.maze.cells[r][c] === CELL.WALL ? CELL.ROOM : CELL.WALL;
    b.maze.cells[r][c] = now;
    if (now === CELL.WALL) { clearStartsAt(); clearChamberAt(); }
  } else if (t === 'room') {
    b.maze.cells[r][c] = CELL.ROOM; clearChamberAt();
  } else if (t === 'chamber') {
    if (b.maze.chamber) b.maze.cells[b.maze.chamber.r][b.maze.chamber.c] = CELL.ROOM;
    b.maze.cells[r][c] = CELL.CHAMBER; b.maze.chamber = { r, c }; clearStartsAt();
  } else if (t.startsWith('start-')) {
    const color = t.slice(6);
    if (b.maze.cells[r][c] !== CELL.ROOM) { b.maze.cells[r][c] = CELL.ROOM; clearChamberAt(); }
    b.maze.starts[color] = { r, c };
  }
}

function autogen() {
  const b = ui.builder;
  try {
    b.maze = generateMaze(builderColors(b), makeRng());
  } catch (err) {
    ui.error = '生成失败，请重试。';
  }
}

function startGame() {
  const b = ui.builder;
  const cols = builderColors(b);
  const v = validateMaze(b.maze, cols);
  if (!v.ok) return;
  const characters = {};
  for (const c of cols) characters[c] = b.characters[c];
  ui.game = G.createGame({
    colors: cols, characters,
    guardianName: b.guardianName.trim() || '遗迹役',
    maze: b.maze,
  });
  ui.attackResults = {};
  advance();
}

// ---------------------------------------------------------------------------
render();
