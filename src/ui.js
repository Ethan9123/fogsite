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
import { projectForInvestigator, projectForGuardian } from './project.js';
import * as Net from './net.js';
import { actionCardHtml, actionCardBackHtml, charCardHtml } from './cards.js';
import { TYPES } from '../server/protocol.js';

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
  mode: 'menu',       // 'menu' | 'local' | 'online'
  online: null,       // online session state (see newOnline)
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
// The maze builder currently being edited — the local setup builder, or the
// online guardian's builder when in online mode.
function activeBuilder() { return ui.mode === 'online' && ui.online ? ui.online.builder : ui.builder; }

// ---------------------------------------------------------------------------
// Render dispatch
// ---------------------------------------------------------------------------
function render() {
  if (ui.mode === 'menu') { clockEl.innerHTML = ''; app.innerHTML = renderMenu(); return; }
  if (ui.mode === 'online') { renderOnline(); return; }
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

// ---------------------------------------------------------------------------
// Mode menu
// ---------------------------------------------------------------------------
function renderMenu() {
  return `<div class="panel center">
    <h2>FOGSITE · 雾境遗迹</h2>
    <p class="hint">选择游戏模式。两种模式规则完全一致，区别只在于「保密」如何实现。</p>
    <div class="row" style="justify-content:center">
      <div class="col" style="max-width:320px">
        <h3>本地热座</h3>
        <p class="hint">一台设备轮流游玩，靠「交接屏幕」提示保密。适合面对面。</p>
        <button data-act="mode-local" class="primary big">本地热座 →</button>
      </div>
      <div class="col" style="max-width:320px">
        <h3>联机对战（4 人）</h3>
        <p class="hint">每人各用一台设备，由服务器分别下发各自的视野，无需交接屏幕。1 名遗迹役 + 3 名探检家。</p>
        <button data-act="mode-online" class="primary big">联机对战 →</button>
      </div>
    </div>
  </div>`;
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

// Investigator ego-centric relative map (9x9, start at center). Renders straight
// from a projected investigator `view` (which hides absolute coordinates,
// guard/deity, and other investigators). Both the local hotseat (which projects
// locally) and online mode (which receives the view over the wire) call this.
function renderEgoGrid(view) {
  const cells = [];
  for (let row = 0; row < view.size; row++) {
    for (let col = 0; col < view.size; col++) {
      const cls = cellClass(view.grid[row][col]);
      let inner = '';
      if (view.self.row === row && view.self.col === col) inner += `<span class="pawn ${view.color}"></span>`;
      if (view.start.row === row && view.start.col === col) inner += '<span class="mark">起</span>';
      cells.push(`<div class="cell ${cls}">${inner}</div>`);
    }
  }
  return `<div class="gridwrap ego"><div class="grid" style="grid-template-columns:repeat(${view.size},52px)">${cells.join('')}</div></div>`;
}

// Guardian full-truth grid (absolute) with all pawns, guard, deity. Renders from
// a projected guardian `view`.
function renderTruthGrid(view) {
  const cells = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const cell = view.grid[r][c];
      const cls = cell.type === CELL.WALL ? 'wall' : cell.type === CELL.CHAMBER ? 'chamber' : 'room';
      let inner = '';
      if (cell.type === CELL.CHAMBER) inner += '<span class="mark">石</span>';
      cell.pawns.forEach((col, i) => {
        inner += `<span class="pawn ${col}" style="left:${6 + i * 12}px;top:${14}px"></span>`;
      });
      if (cell.guard) inner += '<span class="guard" title="卫兵"></span>';
      if (cell.deity) inner += '<span class="deity" title="守护神"></span>';
      cells.push(`<div class="cell ${cls}">${inner}</div>`);
    }
  }
  return `<div class="gridwrap"><div class="grid" style="grid-template-columns:repeat(${GRID},52px)">${cells.join('')}</div></div>`;
}

const legend = `<div class="legend">
  <span><i style="background:#e9e2cf"></i>房间</span>
  <span><i style="background:#33272b"></i>墙壁</span>
  <span><i style="background:#2e6b5e;border-radius:50%;border:1px solid #c8a24a"></i>石室</span>
  <span><i style="background:#c8b994"></i>未探明</span>
</div>`;

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------
function renderSetup() { return renderBuildScreen(ui.builder, { startAct: 'start' }); }

// Shared maze-builder screen. Used by the local setup (startAct 'start') and the
// online guardian's pre-game configuration (startAct 'o-start', with a roster
// header). `b` is the builder being edited; click/change handlers route to it
// via activeBuilder().
function renderBuildScreen(b, opts) {
  const cols = builderColors(b);
  const v = validateMaze(b.maze, cols);

  const charOpts = (sel) => CHARACTERS.map((ch) =>
    `<option value="${ch.id}" ${ch.id === sel ? 'selected' : ''}>${ch.name}（${ch.en}）</option>`).join('');

  const charRows = cols.map((col) => `
    <label class="fld"><span class="pill tag-${col}">${COLOR_LABEL[col]}</span>
      <select data-act="set-char" data-color="${col}">${charOpts(b.characters[col])}</select>
    </label>`).join('');
  const charPreview = `<div class="cardrow mini">${
    cols.map((col) => charCardHtml(CHARACTER_BY_ID[b.characters[col]], col)).join('')}</div>`;

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
    ${opts.headerExtra || ''}
    <div class="row">
      <div class="col">
        <h3>1 · 人数与角色</h3>
        <div class="btnrow">
          <button data-act="set-count" data-n="2" class="${b.count === 2 ? 'sel' : ''}">2 名探检家</button>
          <button data-act="set-count" data-n="3" class="${b.count === 3 ? 'sel' : ''}">3 名探检家</button>
        </div>
        ${charRows}
        ${charPreview}
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
        <button data-act="${opts.startAct}" class="primary big" ${v.ok ? '' : 'disabled'}>开始游戏 →</button>
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
    </div>
    <div class="row">
      <div class="col" style="flex:0 0 auto">${renderEgoGrid(projectForInvestigator(g, color))}${legend}
        <p class="hint">这是你的相对地图：「起」是你的起点，你并不知道自己在 5×5 中的绝对位置——需要靠探索与推理还原。</p>
      </div>
      <div class="col">${controls}<div class="spacer"></div>${charCardHtml(char, color)}</div>
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
function cancelBtn(hintText, act = 'inv-cancel') {
  return `<p class="hint">${esc(hintText)}</p><button data-act="${act}">← 返回</button>`;
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
    <div class="cardrow center">
      ${actionCardHtml(ACTION.CAUTION, { act: 'predict', disabled: forced })}
      ${actionCardHtml(ACTION.REST, { act: 'predict' })}
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
    const stamp = res ? { stamp: res === 'hit' ? '命中' : '被挡', stampCls: res === 'hit' ? 'hit' : 'block' } : {};
    const face = res ? actionCardHtml(it.actionCard, stamp) : actionCardBackHtml();
    return `<div class="cardslot"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span>${face}</div>`;
  }).join('');

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
      <div class="col" style="flex:0 0 auto">${renderTruthGrid(projectForGuardian(g))}
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
        <div class="cardrow mini">${cardRow}</div>
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

  // online actions are handled in their own module to keep the secrecy-critical
  // path separate from the local hotseat controller.
  if (act === 'mode-online' || (ui.mode === 'online' && act.startsWith('o-'))) {
    handleOnlineClick(act, t);
    return;
  }

  switch (act) {
    // ---- menu ----
    case 'mode-local':
      ui.mode = 'local'; ui.screen = 'setup'; ui.game = null; ui.builder = newBuilder();
      ui.error = null; render(); break;

    // ---- setup (shared by local setup + online guardian config) ----
    case 'set-count': activeBuilder().count = Number(t.dataset.n); render(); break;
    case 'set-tool': activeBuilder().tool = t.dataset.tool; render(); break;
    case 'paint': paint(activeBuilder(), Number(t.dataset.r), Number(t.dataset.c)); render(); break;
    case 'autogen': autogen(); render(); break;
    case 'clear': activeBuilder().maze = emptyMaze(); render(); break;
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
    case 'set-char': activeBuilder().characters[t.dataset.color] = t.value; break;
    case 'set-gm': activeBuilder().guardianName = t.value; break;
    case 'set-copy': ui.copyId = t.value || null; render(); break;
    case 'deity-target': ui.deityTarget = t.value || null; render(); break;
    // ---- online ----
    case 'o-code': ui.online.codeInput = t.value.trim().toUpperCase(); break;
    case 'o-seat-name': ui.online.seatChoice.name = t.value; break;
    case 'o-set-copy': ui.online.copyId = t.value || null; render(); break;
    case 'o-deity-target': ui.online.deityTarget = t.value || null; render(); break;
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
  const b = activeBuilder();
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

// ===========================================================================
// ONLINE MODE
// Renders entirely from the server-pushed projected view and routes every
// action through net.js. There is NO screen handoff: each player is on their
// own device and only ever receives their own view, so secrecy is enforced on
// the wire (server/room.js viewFor). No rules live here — the server is
// authoritative and rejects anything illegal.
// ===========================================================================
function newOnline() {
  return {
    net: null,
    code: null,
    codeInput: '',
    you: null,
    conn: 'connecting', // 'connecting' | 'online' | 'reconnecting'
    state: null,        // last viewFor pushed by the server
    notice: null,       // transient private result (explore / ability / attack)
    error: null,        // transient error
    seatChoice: { role: 'investigator', color: 'red', name: '' },
    builder: newBuilder(),
    action: null,       // investigator: 'explore' | 'move' | 'ability'
    abilityDirs: [],
    copyId: null,
    deityTarget: null,
    attackResults: {},  // guardian, this turn: color -> 'hit' | 'block'
    escapeTimer: null,
  };
}

function initOnline() { ui.mode = 'online'; ui.online = newOnline(); render(); }

function leaveOnline() {
  const o = ui.online;
  if (o) {
    if (o.escapeTimer) clearInterval(o.escapeTimer);
    if (o.net) o.net.close();
  }
  ui.online = null;
  ui.mode = 'menu';
  render();
}

function netSend(action) {
  const o = ui.online;
  if (o && o.net) { o.error = null; o.net.send(action); }
}

// Active colors follow the public player count; names/seat ids stay private.
function onlineColors() {
  const state = ui.online.state;
  if (state && state.phase !== 'lobby') return COLORS.slice(0, state.playerCount);
  const seats = state ? state.seats : {};
  const present = new Set(Object.values(seats).filter((s) => s.role === 'investigator').map((s) => s.color));
  return COLORS.filter((c) => present.has(c));
}

async function onlineStart(rawCode) {
  const o = ui.online;
  if (!o || o.pending) return;
  o.pending = true;
  o.error = null;
  let code = rawCode;
  try {
    if (!code) code = await Net.createRoom();
    else {
      const info = await Net.lookupRoom(code);
      if (ui.online !== o) return;
      if (!info.exists) { o.error = `房间 ${code} 不存在`; render(); return; }
    }
  } catch {
    if (ui.online !== o) return;
    o.error = '无法连接服务器（请确认在线服务器 server/ws.mjs 正在运行）。'; render(); return;
  } finally {
    o.pending = false;
  }
  if (ui.online !== o) return;
  o.code = code;
  o.conn = 'connecting';
  o.net = Net.connect(code, {
    onOpen: () => { if (ui.online === o) { o.conn = 'online'; render(); } },
    onWelcome: (m) => { o.you = m.you; },
    onState: (s) => { if (ui.online === o) onOnlineState(s); },
    onResult: (r) => { if (ui.online === o) { o.notice = describeResult(r); render(); } },
    onError: (m) => { if (ui.online === o) { o.error = m.error || '操作被拒绝'; render(); } },
    onReconnecting: () => { if (ui.online === o && ui.mode === 'online') { o.conn = 'reconnecting'; render(); } },
  });
  render();
}

function onOnlineState(s) {
  const o = ui.online;
  if (!o) return;
  const v = s.view;
  // A fresh investigator turn (laidDown cleared) means stale action UI is gone.
  if (v && v.role === 'investigator' && v.laidDown) { o.action = null; o.abilityDirs = []; o.copyId = null; }
  // Attack reveals only persist within a single guardian turn.
  if (!v || v.mode !== MODE.GUARDIAN) { o.attackResults = {}; o.deityTarget = null; }
  o.state = s;
  manageOnlineEscape();
  render();
}

function describeResult(r) {
  if (!r) return null;
  if (r.kind === 'explore') return r.outcome === 'room' ? '探索结果：房间（已记入地图）。' : '探索结果：墙壁，撞墙，手番结束。';
  if (r.kind === 'ability') return `能力结果：${r.info}`;
  if (r.kind === 'attack') {
    ui.online.attackResults[r.color] = r.success ? 'hit' : 'block';
    return `攻击 ${COLOR_LABEL[r.color]}：${r.success ? '命中（扣 ' + RULES.attackTileLoss + ' 块）' : '被「警戒」挡下'}。`;
  }
  return null;
}

// Display-only escape countdown; the server owns the authoritative timeout and
// pushes the phase transition when it elapses.
function manageOnlineEscape() {
  const o = ui.online;
  const inEscape = o.state && o.state.escape && o.state.escape.deadline;
  if (inEscape && !o.escapeTimer) {
    o.escapeTimer = setInterval(() => {
      const d = ui.online && ui.online.state && ui.online.state.escape && ui.online.state.escape.deadline;
      const el = document.getElementById('escape-timer');
      if (d && el) el.textContent = (Math.max(0, d - Date.now()) / 1000).toFixed(1) + 's';
    }, 200);
  } else if (!inEscape && o.escapeTimer) {
    clearInterval(o.escapeTimer); o.escapeTimer = null;
  }
}

// ---- online render dispatch ----------------------------------------------
function renderOnlineClock() {
  const v = ui.online.state && ui.online.state.view;
  if (!v) { clockEl.innerHTML = ''; return; }
  clockEl.innerHTML =
    `第 <b>${v.round}</b> 轮 · 阶段 <b>P${v.phaseIndex + 1}</b> · 剩余地块 <b>${v.totalTilesLeft}</b>` +
    (v.deityActive ? ' · <b style="color:#c8a24a">守护神已现</b>' : '');
}

function renderOnline() {
  const o = ui.online;
  renderOnlineClock();
  let html;
  if (!o.code || !o.state) html = renderOnlineLobby();
  else if (o.state.phase === 'lobby') html = renderOnlineSeats();
  else if (o.state.phase === 'over') html = renderOnlineOver();
  else if (!o.state.view || !o.state.role) html = renderOnlineUnseated();
  else if (o.state.role === 'guardian') html = renderOnlineGuardian();
  else html = renderOnlineInvestigator();
  const banner =
    connBadge(o.conn) +
    (o.error ? `<div class="notice bad">${esc(o.error)}</div>` : '') +
    (o.notice ? `<div class="notice good">${esc(o.notice)}</div>` : '');
  app.innerHTML = banner + html;
}

// Connection health. Stays out of the way while healthy; surfaces a clear,
// non-alarming notice while connecting or auto-reconnecting (the seat is held
// server-side, so the game resumes the moment the socket comes back).
function connBadge(conn) {
  if (conn === 'reconnecting')
    return `<div class="notice" style="text-align:center;color:#c8a24a">● 连接已断开，正在自动重连…（你的座位已保留）</div>`;
  if (conn === 'connecting')
    return `<div class="notice hint" style="text-align:center">● 连接中…</div>`;
  return '';
}

function roomBadge(code) {
  return `<div class="notice" style="text-align:center">房间码：<b style="font-size:22px;letter-spacing:4px">${esc(code)}</b></div>`;
}
function renderRoster(seats) {
  const items = Object.values(seats).map((p) => {
    const tag = p.role === 'guardian' ? '<span class="pill">遗迹役</span>' : `<span class="pill tag-${p.color}">${COLOR_LABEL[p.color]}</span>`;
    return `<span>${tag} ${esc(p.name || '')}</span>`;
  });
  return `<div class="kv" style="justify-content:center">${items.join('') || '<span class="hint">暂无玩家</span>'}</div>`;
}

function renderOnlineLobby() {
  const o = ui.online;
  return `<div class="panel center">
    <h2>联机对战</h2>
    <p class="hint">创建房间后把房间码分享给同伴；或输入房间码加入。需要 1 名遗迹役 + ${COLORS.length} 名探检家。</p>
    <div class="row" style="justify-content:center">
      <div class="col" style="max-width:300px">
        <h3>创建房间</h3>
        <button data-act="o-create" class="primary big">创建新房间</button>
      </div>
      <div class="col" style="max-width:300px">
        <h3>加入房间</h3>
        <label class="fld"><span>房间码</span>
          <input type="text" data-act="o-code" maxlength="4" placeholder="ABCD" value="${esc(o.codeInput || '')}" style="text-transform:uppercase" /></label>
        <button data-act="o-join" class="primary">加入</button>
      </div>
    </div>
    <div class="spacer"></div>
    <button data-act="o-menu">← 返回模式选择</button>
  </div>`;
}

function renderOnlineSeats() {
  const o = ui.online, s = o.state;
  const seatsArr = Object.values(s.seats);
  const roster = renderRoster(s.seats);

  if (s.role === 'guardian') {
    return renderBuildScreen(o.builder, {
      startAct: 'o-start',
      headerExtra: `${roomBadge(o.code)}${roster}
        <p class="hint">座位填满后即可开始；开始时会把迷宫与角色分配下发给服务器。投资者请勿观看本屏幕。</p>`,
    });
  }
  if (s.role === 'investigator') {
    return `<div class="panel center">
      <h2>已入座 · <span class="pill tag-${s.color}">${COLOR_LABEL[s.color]}</span> 探检家</h2>
      ${roomBadge(o.code)}${roster}
      <p class="hint">等待遗迹役建造迷宫并开始游戏…（你的角色会在开始时揭晓）</p>
      <button data-act="o-menu">← 离开房间</button>
    </div>`;
  }

  // not yet seated — pick a seat
  const sc = o.seatChoice;
  const guardianTaken = seatsArr.some((p) => p.role === 'guardian');
  const takenColors = new Set(seatsArr.filter((p) => p.role === 'investigator').map((p) => p.color));
  const roleBtns = `
    <button data-act="o-seat-role" data-role="guardian" class="${sc.role === 'guardian' ? 'sel' : ''}" ${guardianTaken ? 'disabled' : ''}>遗迹役</button>
    <button data-act="o-seat-role" data-role="investigator" class="${sc.role === 'investigator' ? 'sel' : ''}">探检家</button>`;
  const colorBtns = COLORS.map((c) =>
    `<button data-act="o-seat-color" data-color="${c}" class="${sc.color === c ? 'sel' : ''}" ${takenColors.has(c) ? 'disabled' : ''}><span class="pill tag-${c}">${COLOR_LABEL[c]}</span></button>`).join('');
  return `<div class="panel center">
    <h2>选择座位</h2>
    ${roomBadge(o.code)}${roster}
    <div class="btnrow center" style="justify-content:center">${roleBtns}</div>
    ${sc.role === 'investigator' ? `<div class="btnrow center" style="justify-content:center">${colorBtns}</div>` : ''}
    <label class="fld" style="max-width:280px;margin:10px auto"><span>昵称（可选）</span>
      <input type="text" data-act="o-seat-name" value="${esc(sc.name)}" placeholder="${sc.role === 'guardian' ? '遗迹役' : '探检家'}" /></label>
    <button data-act="o-seat" class="primary big">入座</button>
    <div class="spacer"></div>
    <button data-act="o-menu">← 离开房间</button>
  </div>`;
}

function renderOnlineUnseated() {
  return `<div class="panel center">
    <h2>对局已经开始</h2>
    ${roomBadge(ui.online.code)}
    <p class="hint">你在这局中没有座位，无法加入或查看棋盘。若要重连，请使用原来的浏览器标签页。</p>
    <button data-act="o-menu" class="primary">← 返回模式选择</button>
  </div>`;
}

function renderOnlineOver() {
  const s = ui.online.state;
  const inv = s.winner === WINNER.INVESTIGATORS;
  return `<div class="panel win">
    <h2>游戏结束</h2>
    <div class="who" style="color:${inv ? 'var(--green)' : 'var(--red)'}">${inv ? '探检家胜利！' : '遗迹役胜利！'}</div>
    <p class="hint">${inv ? '全员成功在同一格脱出。' : '在探检家脱出前耗尽时间，或脱出失败。'}</p>
    <button data-act="o-menu" class="primary big">返回菜单</button>
  </div>`;
}

// ---- online investigator --------------------------------------------------
function renderOnlineInvestigator() {
  const o = ui.online, v = o.state.view;
  const char = CHARACTER_BY_ID[v.characterId];
  const grid = `<div class="col" style="flex:0 0 auto">${renderEgoGrid(v)}${legend}
    <p class="hint">这是你的相对地图：「起」是你的起点；你并不知道自己在 5×5 中的绝对位置。</p></div>`;

  let panel;
  if (v.mode === MODE.ESCAPE_DECISION) panel = onlineEscapePanel();
  else if (v.mode === MODE.PREDICTION) panel = onlinePredictPanel();
  else if (v.mode === MODE.GUARDIAN) panel = '<div class="notice">遗迹役正在行动，请稍候…</div>';
  else if (v.laidDown) panel = '<div class="notice good">你已结束本回合手番。等待其他探检家与遗迹役…</div>';
  else panel = onlineInvestigatorPanel();

  return `<div class="panel">
    <h2><span class="pill tag-${v.color}">${COLOR_LABEL[v.color]}</span> 探检家 · ${esc(char.name)}</h2>
    <div class="kv">
      <span>起点周围房间数：<b>${v.startHint}</b></span>
    </div>
    <div class="row">${grid}<div class="col">${panel}<div class="spacer"></div>${charCardHtml(char, v.color)}</div></div>
  </div>`;
}

function onlineInvestigatorPanel() {
  const o = ui.online, v = o.state.view;
  const tiles = v.totalTilesLeft;
  const at = (k) => {
    const d = DIRS[k];
    const r = v.self.row + d.dr, c = v.self.col + d.dc;
    if (r < 0 || r >= v.size || c < 0 || c >= v.size) return undefined;
    return v.grid[r][c]; // null = fog; or a cell type string
  };
  if (o.action === 'explore') return dpad('o-inv-dir', (k) => at(k) === null && tiles > 0) + cancelBtn('选择一个方向探索（揭示该相邻格）。', 'o-inv-cancel');
  if (o.action === 'move') return dpad('o-inv-dir', (k) => at(k) === CELL.ROOM || at(k) === CELL.CHAMBER) + cancelBtn('移动到一个已探明的相邻房间。', 'o-inv-cancel');
  if (o.action === 'ability') return onlineAbilityPanel();
  return `<div class="btnrow">
      <button data-act="o-inv-mode" data-mode="explore" ${tiles > 0 ? '' : 'disabled'}>探索（揭示相邻格）</button>
      <button data-act="o-inv-mode" data-mode="move">移动（走向已知房间）</button>
      <button data-act="o-inv-mode" data-mode="ability" ${v.fatigue ? 'disabled' : ''}>使用能力</button>
      <button data-act="o-inv-pass">跳过本手番</button>
    </div>
    <p class="hint">本回合只能执行其中 <b>一种</b> 行动。${v.fatigue ? '（你的能力已疲劳，暂不可用）' : ''}${tiles > 0 ? '' : '（地块已耗尽，无法探索）'}</p>`;
}

function onlineAbilityPanel() {
  const o = ui.online, v = o.state.view;
  const char = CHARACTER_BY_ID[v.characterId];
  let kind = char.kind, head = '';
  if (char.id === 'apprentice') {
    const opts = CHARACTERS.filter((c) => c.id !== 'apprentice')
      .map((c) => `<option value="${c.id}" ${o.copyId === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
    head = `<label class="fld"><span>复制角色</span><select data-act="o-set-copy"><option value="">— 选择 —</option>${opts}</select></label>`;
    if (!o.copyId) return head + cancelBtn('见习：先选择要复制的角色能力。', 'o-inv-cancel');
    kind = CHARACTER_BY_ID[o.copyId].kind;
  }
  const others = onlineColors().filter((c) => c !== v.color);
  let body = '';
  switch (kind) {
    case 'pick-adjacent-wall':
    case 'pick-straight-direction':
      body = dpad('o-abil-dir', () => true); break;
    case 'pick-other-investigator':
      body = `<div class="btnrow">${others.map((c) => `<button data-act="o-abil-target" data-color="${c}"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span></button>`).join('')}</div>`;
      break;
    case 'pick-two-adjacent-empty': {
      const btns = DIR_KEYS.map((k) => `<button data-act="o-abil-geo" data-dir="${k}" class="${o.abilityDirs.includes(k) ? 'sel' : ''}">${DIRS[k].label}</button>`).join('');
      body = `<div class="btnrow">${btns}</div><button data-act="o-abil-geo-confirm" class="primary" ${o.abilityDirs.length ? '' : 'disabled'}>勘测这 ${o.abilityDirs.length} 格</button>`;
      break;
    }
    case 'freeze-guards':
      body = '<button data-act="o-abil-confirm" class="primary">冻结周围 9 格内的卫兵</button>'; break;
    case 'revive-investigator':
      body = others.length
        ? `<div class="btnrow">${others.map((c) => `<button data-act="o-abil-target" data-color="${c}"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span> 复活</button>`).join('')}</div><p class="hint">只能复活已结束手番的队友（否则服务器会拒绝）。</p>`
        : '<p class="hint">没有其他探检家。</p>';
      break;
    default: body = '<p class="hint">（该能力暂未实现交互）</p>';
  }
  return head + body + '<div class="spacer"></div>' + cancelBtn('能力使用后本手番即结束。', 'o-inv-cancel');
}

function onlinePredictPanel() {
  const v = ui.online.state.view;
  if (v.actionCard !== null) return '<div class="notice good">已秘密出牌，等待其他探检家与遗迹役…</div>';
  const forced = v.forcedRestNextRound;
  return `<h3>秘密行动预测</h3>
    <p class="hint">秘密选择行动卡：「休憩」若被攻击损失 ${RULES.attackTileLoss} 块；「警戒」可挡下攻击，但未被攻击会被贴「禁止警戒牌」。</p>
    ${forced ? '<div class="notice bad">你身上有「禁止警戒牌」，本回合只能「休憩」。</div>' : ''}
    <div class="cardrow">
      ${actionCardHtml(ACTION.CAUTION, { act: 'o-predict', disabled: forced })}
      ${actionCardHtml(ACTION.REST, { act: 'o-predict' })}
    </div>`;
}

function onlineEscapePanel() {
  const o = ui.online, s = o.state, v = s.view;
  const confirms = (s.escape && s.escape.confirms) || [];
  const mine = confirms.includes(v.color);
  const remain = s.escape && s.escape.deadline ? Math.max(0, s.escape.deadline - Date.now()) : 0;
  const cols = onlineColors();
  const tally = `${s.escape?.confirmCount ?? confirms.length}/${cols.length} 人`;
  return `<h3>脱出挑战</h3>
    <p class="hint">若你们认为全员已在同一格，全部 ${cols.length} 人在倒计时内确认即触发检定。倒计时结束未全员确认则放弃脱出、继续探索。</p>
    <div class="who" id="escape-timer" style="color:var(--accent)">${(remain / 1000).toFixed(1)}s</div>
    <div class="kv">已确认：${tally}</div>
    <button data-act="o-escape-confirm" class="big ${mine ? 'sel' : ''}" ${mine ? 'disabled' : ''}>${mine ? '✓ 已确认脱出' : '确认脱出'}</button>`;
}

// ---- online guardian ------------------------------------------------------
function renderOnlineGuardian() {
  const o = ui.online, s = o.state, v = s.view;
  const truth = `<div class="col" style="flex:0 0 auto">${renderTruthGrid(v)}
    <div class="legend"><span>■ 卫兵</span><span>● 守护神</span><span>○ 探检家</span><span>石 石室</span></div></div>`;

  if (v.mode !== MODE.GUARDIAN) {
    let status;
    if (v.mode === MODE.ESCAPE_DECISION) {
      const remain = s.escape && s.escape.deadline ? Math.max(0, s.escape.deadline - Date.now()) : 0;
      const confirms = (s.escape && s.escape.confirms) || [];
      status = `<h3>脱出判断</h3><p class="hint">探检家正在决定是否脱出。</p>
        <div class="who" id="escape-timer" style="color:var(--accent)">${(remain / 1000).toFixed(1)}s</div>
        <div class="kv">已确认 ${confirms.length}/${v.colors.length} 人</div>`;
    } else if (v.mode === MODE.PREDICTION) {
      status = '<h3>行动预测</h3><p class="hint">探检家正在秘密出牌（警戒/休憩）。在你攻击翻牌之前，你看不到他们的选择。</p>';
    } else {
      status = '<h3>探检家手番</h3><p class="hint">探检家正在行动。你可以观察棋盘，待他们全部结束手番后进入你的回合。</p>';
    }
    return `<div class="panel"><h2>遗迹役 · ${esc(v.guardianName)}</h2>
      <div class="row">${truth}<div class="col">${status}</div></div></div>`;
  }

  const gt = v.guardTurn || { movesUsed: 0, deityMovesUsed: 0 };
  const frozen = v.frozenGuards ? '<div class="notice bad">卫兵被「元傭兵」冻结，本手番无法移动/攻击（守护神不受影响）。</div>' : '';
  const guardDpad = dpad('o-guard-move', (k) => !!(v.guardMovesLegal && v.guardMovesLegal[k]));
  let deitySection = '';
  if (v.deityActive) {
    const opts = v.colors.map((c) => `<option value="${c}" ${o.deityTarget === c ? 'selected' : ''}>${COLOR_LABEL[c]}</option>`).join('');
    const legal = (k) => !!(o.deityTarget && v.deityMovesLegal && v.deityMovesLegal[o.deityTarget] && v.deityMovesLegal[o.deityTarget][k]);
    deitySection = `<h3>守护神（${gt.deityMovesUsed}/${RULES.deityMoves} 步）</h3>
      <label class="fld"><span>追击目标</span><select data-act="o-deity-target"><option value="">— 选择 —</option>${opts}</select></label>
      ${o.deityTarget ? dpad('o-deity-move', legal) : '<p class="hint">先选择追击目标。</p>'}`;
  }
  const atkBtns = (list, attacker) => (list && list.length)
    ? list.map((c) => `<button data-act="o-attack" data-attacker="${attacker}" data-color="${c}" class="danger"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span> 攻击</button>`).join('')
    : '<span class="hint">无可攻击目标</span>';
  // The online guardian view never learns the card identity directly, so a
  // resolved attack stamps the face-down back instead of flipping it.
  const cardRow = v.colors.map((c) => {
    const res = o.attackResults[c];
    const face = actionCardBackHtml(res ? { stamp: res === 'hit' ? '命中' : '被挡', stampCls: res === 'hit' ? 'hit' : 'block' } : {});
    return `<div class="cardslot"><span class="pill tag-${c}">${COLOR_LABEL[c]}</span>${face}</div>`;
  }).join('');

  return `<div class="panel">
    <h2>遗迹役手番 · ${esc(v.guardianName)}</h2>
    <div class="kv">
      <span>卫兵机动：<b>${gt.movesUsed}/${v.guardMaxMoves}</b></span>
      <span>剩余地块：<b>${v.totalTilesLeft}</b></span>
      <span>不可连续攻击同一人</span>
    </div>
    ${frozen}
    <div class="row">${truth}
      <div class="col">
        <h3>卫兵移动（${gt.movesUsed}/${v.guardMaxMoves}）</h3>
        ${guardDpad}
        ${deitySection}
        <h3>攻击</h3>
        <p class="hint">攻击翻开目标行动卡：休憩→命中扣 ${RULES.attackTileLoss} 块；警戒→被挡。守护神攻击无视警戒。</p>
        <div class="btnrow">${atkBtns(v.attackTargets && v.attackTargets.guard, 'guard')}</div>
        ${v.deityActive ? `<div class="btnrow">守护神：${atkBtns(v.attackTargets && v.attackTargets.deity, 'deity')}</div>` : ''}
        <h3>行动卡</h3>
        <div class="cardrow mini">${cardRow}</div>
        <div class="spacer"></div>
        <button data-act="o-guard-end" class="primary big">结束遗迹役手番 →</button>
      </div>
    </div>
  </div>`;
}

// ---- online click routing -------------------------------------------------
function onlineToggleGeo(dir) {
  const a = ui.online.abilityDirs;
  const i = a.indexOf(dir);
  if (i >= 0) a.splice(i, 1);
  else if (a.length < 2) a.push(dir);
}

function sendAbility(inner) {
  const v = ui.online.state.view;
  const params = v.characterId === 'apprentice' ? { copyId: ui.online.copyId, inner } : inner;
  netSend({ type: TYPES.ABILITY, params });
}

function onlineStartGame() {
  const b = ui.online.builder;
  const cols = builderColors(b);
  if (!validateMaze(b.maze, cols).ok) { ui.online.error = '迷宫尚不合法，无法开始。'; render(); return; }
  const characters = {};
  for (const c of cols) characters[c] = b.characters[c];
  netSend({ type: TYPES.CONFIGURE, count: b.count, characters, guardianName: b.guardianName.trim() || '遗迹役', maze: b.maze });
  netSend({ type: TYPES.START });
}

function handleOnlineClick(act, t) {
  if (act === 'mode-online') { initOnline(); return; }
  const o = ui.online;
  if (!o) return;
  o.error = null;
  switch (act) {
    case 'o-menu': leaveOnline(); break;
    case 'o-create': onlineStart(''); break;
    case 'o-join': {
      const code = (o.codeInput || '').trim().toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) { o.error = '请输入 4 位房间码'; render(); break; }
      onlineStart(code); break;
    }
    case 'o-seat-role': o.seatChoice.role = t.dataset.role; render(); break;
    case 'o-seat-color': o.seatChoice.color = t.dataset.color; render(); break;
    case 'o-seat': {
      const sc = o.seatChoice;
      if (sc.role === 'guardian') netSend({ type: TYPES.JOIN, role: 'guardian', name: sc.name || '遗迹役' });
      else netSend({ type: TYPES.JOIN, role: 'investigator', color: sc.color, name: sc.name || '' });
      break;
    }
    case 'o-start': onlineStartGame(); break;

    case 'o-inv-mode': o.action = t.dataset.mode; o.notice = null; render(); break;
    case 'o-inv-cancel': o.action = null; o.abilityDirs = []; o.copyId = null; render(); break;
    case 'o-inv-pass': netSend({ type: TYPES.PASS }); break;
    case 'o-inv-dir':
      if (o.action === 'explore') netSend({ type: TYPES.EXPLORE, dir: t.dataset.dir });
      else if (o.action === 'move') netSend({ type: TYPES.MOVE, dir: t.dataset.dir });
      break;

    case 'o-abil-dir': sendAbility({ dir: t.dataset.dir }); break;
    case 'o-abil-target': sendAbility({ targetColor: t.dataset.color }); break;
    case 'o-abil-geo': onlineToggleGeo(t.dataset.dir); render(); break;
    case 'o-abil-geo-confirm': sendAbility({ dirs: o.abilityDirs.slice() }); break;
    case 'o-abil-confirm': sendAbility({}); break;

    case 'o-predict': netSend({ type: TYPES.PREDICT, card: t.dataset.card }); break;
    case 'o-escape-confirm': netSend({ type: TYPES.ESCAPE_CONFIRM }); break;

    case 'o-guard-move': netSend({ type: TYPES.GUARD_MOVE, dir: t.dataset.dir }); break;
    case 'o-deity-move': netSend({ type: TYPES.DEITY_MOVE, dir: t.dataset.dir, targetColor: o.deityTarget }); break;
    case 'o-attack': netSend({ type: TYPES.ATTACK, color: t.dataset.color, attacker: t.dataset.attacker }); break;
    case 'o-guard-end': netSend({ type: TYPES.GUARD_END }); break;
  }
}

// ---------------------------------------------------------------------------
render();
