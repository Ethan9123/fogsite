// FOGSITE — maze model, constraint validation, and random generator.
import { GRID, CELL, COLORS, RULES, inBounds, DIRS } from './rules.js';

// A maze is { cells: type[GRID][GRID], starts: {color:{r,c}}, chamber:{r,c} }.

export function emptyMaze() {
  const cells = [];
  for (let r = 0; r < GRID; r++) {
    cells.push(new Array(GRID).fill(CELL.ROOM));
  }
  return { cells, starts: {}, chamber: null };
}

export function cloneMaze(m) {
  return {
    cells: m.cells.map((row) => row.slice()),
    starts: Object.fromEntries(Object.entries(m.starts).map(([k, v]) => [k, { ...v }])),
    chamber: m.chamber ? { ...m.chamber } : null,
  };
}

export function isWalkable(type) {
  return type === CELL.ROOM || type === CELL.CHAMBER;
}

export function walkableAt(m, r, c) {
  return inBounds(r, c) && isWalkable(m.cells[r][c]);
}

export function orthNeighbors(r, c) {
  const out = [];
  for (const k of Object.keys(DIRS)) {
    const nr = r + DIRS[k].dr;
    const nc = c + DIRS[k].dc;
    if (inBounds(nr, nc)) out.push({ r: nr, c: nc, dir: k });
  }
  return out;
}

// Count orthogonal, in-bounds walkable neighbors — the start-of-game hint
// "你周围有几个房间格".
export function roomNeighborCount(m, r, c) {
  return orthNeighbors(r, c).filter((n) => isWalkable(m.cells[n.r][n.c])).length;
}

function countType(m, type) {
  let n = 0;
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) if (m.cells[r][c] === type) n++;
  return n;
}

// All walkable cells form a single connected component (orthogonal).
function connectivityOk(m) {
  let start = null;
  const walk = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    if (isWalkable(m.cells[r][c])) { walk.push([r, c]); if (!start) start = [r, c]; }
  }
  if (!start) return false;
  const seen = new Set();
  const stack = [start];
  seen.add(start[0] * GRID + start[1]);
  while (stack.length) {
    const [r, c] = stack.pop();
    for (const n of orthNeighbors(r, c)) {
      if (isWalkable(m.cells[n.r][n.c]) && !seen.has(n.r * GRID + n.c)) {
        seen.add(n.r * GRID + n.c);
        stack.push([n.r, n.c]);
      }
    }
  }
  return seen.size === walk.length;
}

// Chamber must have at least one "controllable" side: a wall or the grid edge
// (outer wall) on one of its orthogonal sides.
function chamberHasWallSide(m) {
  if (!m.chamber) return false;
  const { r, c } = m.chamber;
  for (const k of Object.keys(DIRS)) {
    const nr = r + DIRS[k].dr;
    const nc = c + DIRS[k].dc;
    if (!inBounds(nr, nc)) return true;          // grid edge = outer wall
    if (m.cells[nr][nc] === CELL.WALL) return true;
  }
  return false;
}

function adjacent(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}

// Check wire/storage data before any rule validator indexes the grid. Incomplete
// local builders may omit starts/chamber, but malformed coordinates never reach
// the engine. Rule validation below reports missing pieces separately.
export function validateMazeShape(m) {
  const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const point = (v) => record(v) && Number.isInteger(v.r) && Number.isInteger(v.c) && inBounds(v.r, v.c);
  if (!record(m)) return 'maze must be an object';
  if (!Array.isArray(m.cells) || m.cells.length !== GRID) return 'maze.cells must be a 5x5 grid';
  for (const row of m.cells) {
    if (!Array.isArray(row) || row.length !== GRID) return 'maze.cells must be a 5x5 grid';
    for (const cell of row) if (!Object.values(CELL).includes(cell)) return 'unknown maze cell';
  }
  if (!record(m.starts)) return 'maze.starts must be an object';
  for (const [color, start] of Object.entries(m.starts)) {
    if (!COLORS.includes(color) || !point(start)) return 'invalid maze start coordinate';
  }
  if (m.chamber !== null && !point(m.chamber)) return 'invalid maze chamber coordinate';
  if (m.chamber && m.cells[m.chamber.r][m.chamber.c] !== CELL.CHAMBER) return 'maze chamber does not match its cell';
  return null;
}

// Returns { ok, errors:[{code,msg}] }.
export function validateMaze(m, colors) {
  const shapeError = validateMazeShape(m);
  if (shapeError) return { ok: false, errors: [{ code: 'shape', msg: shapeError }] };
  const errors = [];
  const walls = countType(m, CELL.WALL);
  const chambers = countType(m, CELL.CHAMBER);

  if (walls < RULES.innerWalls) {
    errors.push({ code: 'walls', msg: `内壁数量不足：需要至少 ${RULES.innerWalls} 个，当前 ${walls} 个。` });
  }
  if (chambers !== RULES.chambers) {
    errors.push({ code: 'chamber', msg: `石室必须正好 ${RULES.chambers} 个，当前 ${chambers} 个。` });
  }

  // Every requested color must have a start, placed on a walkable (room) cell.
  for (const color of colors) {
    const s = m.starts[color];
    if (!s) { errors.push({ code: 'start', msg: `${color} 起始格尚未放置。` }); continue; }
    if (m.cells[s.r][s.c] !== CELL.ROOM) {
      errors.push({ code: 'start', msg: `${color} 起始格必须放在房间格上。` });
    }
  }

  // Color (start) tiles can't be orthogonally adjacent to one another.
  const placed = colors.filter((c) => m.starts[c]).map((c) => m.starts[c]);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placed[i].r === placed[j].r && placed[i].c === placed[j].c) {
        errors.push({ code: 'start-overlap', msg: '起始格不能重叠。' });
      }
      if (adjacent(placed[i], placed[j])) {
        errors.push({ code: 'start-adj', msg: '起始格之间不能正交相邻。' });
      }
    }
  }

  // Start tiles can't be adjacent to the chamber.
  if (m.chamber) {
    for (const s of placed) {
      if (adjacent(s, m.chamber)) errors.push({ code: 'start-chamber', msg: '起始格不能与石室相邻。' });
    }
  }

  if (!connectivityOk(m)) {
    errors.push({ code: 'connect', msg: '所有可通行格（房间/石室）必须连通，不能有被墙封死的孤立房间。' });
  }
  if (!chamberHasWallSide(m)) {
    errors.push({ code: 'chamber-wall', msg: '石室至少要有一面是墙壁或迷宫外缘。' });
  }

  return { ok: errors.length === 0, errors };
}

// --- seedable RNG (mulberry32) for reproducible tests ---
export function makeRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Rejection-sampling generator: place walls + chamber + starts, retry until valid.
export function generateMaze(colors, rng = makeRng(), maxTries = 4000) {
  const allCells = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) allCells.push({ r, c });

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const m = emptyMaze();
    const pool = shuffled(allCells, rng);
    let idx = 0;

    // chamber
    const ch = pool[idx++];
    m.cells[ch.r][ch.c] = CELL.CHAMBER;
    m.chamber = { r: ch.r, c: ch.c };

    // inner walls
    for (let w = 0; w < RULES.innerWalls; w++) {
      const cell = pool[idx++];
      m.cells[cell.r][cell.c] = CELL.WALL;
    }

    // starts on remaining ROOM cells
    const remaining = pool.slice(idx).filter((p) => m.cells[p.r][p.c] === CELL.ROOM);
    const chosen = shuffled(remaining, rng);
    let ok = true;
    let k = 0;
    for (const color of colors) {
      // find a room cell not adjacent to chamber / other chosen starts
      let placedCell = null;
      for (; k < chosen.length; k++) {
        const cand = chosen[k];
        if (adjacent(cand, m.chamber)) continue;
        const clash = colors.some((oc) => m.starts[oc] && adjacent(m.starts[oc], cand));
        if (clash) continue;
        placedCell = cand; k++; break;
      }
      if (!placedCell) { ok = false; break; }
      m.starts[color] = { r: placedCell.r, c: placedCell.c };
    }
    if (!ok) continue;

    if (validateMaze(m, colors).ok) return m;
  }
  throw new Error('generateMaze: failed to produce a valid maze');
}
