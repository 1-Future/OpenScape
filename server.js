const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Constants ──────────────────────────────────────────────────────────────────
const PORT = 2222;
const TICK_MS = 600;
const STATE_INTERVAL = 1;
const SAVE_INTERVAL_MS = 30000;
const DATA_DIR = path.join(__dirname, 'data');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
const TILE_DATA_DIR = path.join(DATA_DIR, 'tile-data');
const NAMES_FILE = path.join(DATA_DIR, 'names.json');

const CHUNK_SIZE = 64;
const VIEW_DIST = 3;
const ENTITY_VIEW = (VIEW_DIST + 1) * CHUNK_SIZE;
const SPAWN_X = 3222, SPAWN_Y = 3218;

const T = {
  GRASS: 0, WATER: 1, TREE: 2, PATH: 3, ROCK: 4, SAND: 5, WALL: 6,
  FLOOR: 7, DOOR: 8, BRIDGE: 9, FISH_SPOT: 10, FLOWER: 11, BUSH: 12,
  DARK_GRASS: 13, CUSTOM: 14
};

// ── OSRS Terrain Data ─────────────────────────────────────────────────────────
const underlayRgb = {}; // id -> '#rrggbb'
const overlayRgb = {}; // id -> { hex, texture, hideUnderlay }
const terrainCache = new Map(); // 'cx_cy' -> Uint8Array(64*64*3) RGB per tile

function loadTerrainDefs() {
  try {
    const ul = JSON.parse(fs.readFileSync(path.join(TILE_DATA_DIR, 'underlays-rgb.json'), 'utf8'));
    for (const u of ul) underlayRgb[u.id] = u.hex;
    const ol = JSON.parse(fs.readFileSync(path.join(TILE_DATA_DIR, 'overlays-rgb.json'), 'utf8'));
    for (const o of ol) overlayRgb[o.id] = { hex: o.hex, texture: o.texture, hide: o.hideUnderlay };
    console.log(`[terrain] Loaded ${ul.length} underlays, ${ol.length} overlays`);
  } catch (e) {
    console.log('[terrain] No terrain definitions found, using default colors');
  }
}

function loadTerrainChunk(cx, cy) {
  const key = `${cx}_${cy}`;
  if (terrainCache.has(key)) return terrainCache.get(key);
  const filePath = path.join(TILE_DATA_DIR, `${cx}_${cy}.json`);
  if (!fs.existsSync(filePath)) { terrainCache.set(key, null); return null; }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Build RGB array: 64*64*3 bytes
    const rgb = new Uint8Array(64 * 64 * 3);
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const ul = data.underlay[x][y];
        const ol = data.overlay[x][y];
        const olDef = overlayRgb[ol];
        let hex;
        if (ol > 0 && olDef && olDef.hide) hex = olDef.hex;
        else if (ul > 0 && underlayRgb[ul]) hex = underlayRgb[ul];
        else hex = null;
        if (hex) {
          const idx = (y * 64 + x) * 3;
          rgb[idx] = parseInt(hex.slice(1, 3), 16);
          rgb[idx + 1] = parseInt(hex.slice(3, 5), 16);
          rgb[idx + 2] = parseInt(hex.slice(5, 7), 16);
        }
        // else stays 0,0,0 (black = no data, client uses default)
      }
    }
    terrainCache.set(key, rgb);
    return rgb;
  } catch (e) { terrainCache.set(key, null); return null; }
}

function loadTerrainHeights(cx, cy) {
  const filePath = path.join(TILE_DATA_DIR, `${cx}_${cy}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const heights = new Uint16Array(64 * 64);
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++)
        heights[y * 64 + x] = data.height[x][y] || 0;
    return heights;
  } catch (e) { return null; }
}


loadTerrainDefs();


// ── Chunk System ───────────────────────────────────────────────────────────────
const chunks = new Map();

function localXY(wx, wy) {
  return [((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE];
}

function loadChunkFromDisk(cx, cy) {
  const tp = path.join(CHUNKS_DIR, `${cx}_${cy}.bin`);
  if (!fs.existsSync(tp)) return null;
  const buf = fs.readFileSync(tp);
  const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.set(new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, tiles.length)));
  const colors = new Map();
  const cp = path.join(CHUNKS_DIR, `${cx}_${cy}.json`);
  if (fs.existsSync(cp)) {
    const obj = JSON.parse(fs.readFileSync(cp, 'utf8'));
    for (const [k, v] of Object.entries(obj)) colors.set(parseInt(k), v);
  }
  return { tiles, colors, dirty: false, lastAccess: Date.now() };
}

function saveChunkToDisk(cx, cy, chunk) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CHUNKS_DIR, `${cx}_${cy}.bin`), Buffer.from(chunk.tiles));
  const cp = path.join(CHUNKS_DIR, `${cx}_${cy}.json`);
  if (chunk.colors.size > 0) {
    const obj = {}; for (const [k, v] of chunk.colors) obj[k] = v;
    fs.writeFileSync(cp, JSON.stringify(obj));
  } else if (fs.existsSync(cp)) { fs.unlinkSync(cp); }
  chunk.dirty = false;
}

function getChunk(cx, cy) {
  const key = `${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (chunk) return chunk;
  chunk = loadChunkFromDisk(cx, cy);
  if (!chunk) chunk = { tiles: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), colors: new Map(), dirty: false, lastAccess: Date.now() };
  chunks.set(key, chunk);
  return chunk;
}

function tileAt(x, y) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const key = `${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (!chunk) {
    chunk = loadChunkFromDisk(cx, cy);
    if (!chunk) return T.GRASS;
    chunks.set(key, chunk);
  }
  const [lx, ly] = localXY(x, y);
  return chunk.tiles[ly * CHUNK_SIZE + lx];
}

function setTile(x, y, t) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy);
  const [lx, ly] = localXY(x, y);
  chunk.tiles[ly * CHUNK_SIZE + lx] = t;
  chunk.dirty = true;
  chunk.lastAccess = Date.now();
}

function getColor(x, y) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = chunks.get(`${cx}_${cy}`);
  if (!chunk) return null;
  const [lx, ly] = localXY(x, y);
  return chunk.colors.get(ly * CHUNK_SIZE + lx) || null;
}

function setColor(x, y, color) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy);
  const [lx, ly] = localXY(x, y);
  const k = ly * CHUNK_SIZE + lx;
  if (color) chunk.colors.set(k, color);
  else chunk.colors.delete(k);
  chunk.dirty = true;
}

function isWalkable(x, y) {
  const t = tileAt(x, y);
  if (t === T.WATER || t === T.TREE || t === T.ROCK || t === T.WALL || t === T.BUSH || t === T.DOOR) return false;
  return true;
}

function evictChunks() {
  const now = Date.now();
  const keep = new Set();
  for (const [, p] of players) {
    const cx = Math.floor(p.x / CHUNK_SIZE), cy = Math.floor(p.y / CHUNK_SIZE);
    for (let dx = -(VIEW_DIST + 1); dx <= VIEW_DIST + 1; dx++)
      for (let dy = -(VIEW_DIST + 1); dy <= VIEW_DIST + 1; dy++)
        keep.add(`${cx + dx}_${cy + dy}`);
  }
  for (const [key, chunk] of chunks) {
    if (keep.has(key)) continue;
    if (now - chunk.lastAccess > 60000) {
      if (chunk.dirty) {
        const [cx, cy] = key.split('_').map(Number);
        saveChunkToDisk(cx, cy, chunk);
      }
      chunks.delete(key);
    }
  }
}

function saveAllChunks() {
  let saved = 0;
  for (const [key, chunk] of chunks) {
    if (!chunk.dirty) continue;
    const [cx, cy] = key.split('_').map(Number);
    saveChunkToDisk(cx, cy, chunk);
    saved++;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
  fs.writeFileSync(NAMES_FILE, JSON.stringify(namesObj));
  if (saved > 0 || customNames.size > 0) console.log(`[save] ${saved} chunks, ${customNames.size} names`);
}

// ── World State ────────────────────────────────────────────────────────────────
let players = new Map();
let npcs = [];
let respawns = [];
let groundItems = [];
let openDoors = new Map();
let customNames = new Map();
let nextGroundItemId = 1;
let tick = 0;
let nextPlayerId = 1;

// ── Seeded RNG ─────────────────────────────────────────────────────────────────
let seed = 42;
function rng() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

// ── NPCs ───────────────────────────────────────────────────────────────────────
const NPC_TYPES = [
  { name: 'Chicken', color: '#8b1a1a', maxHp: 3, attack: 1, defence: 1, aggressive: false, xp: 12, drops: ['Feather', 'Bones', 'Raw chicken'] },
  { name: 'Rat', color: '#8b1a1a', maxHp: 2, attack: 1, defence: 1, aggressive: true, xp: 5, drops: ['Bones'] },
  { name: 'Cow', color: '#8b1a1a', maxHp: 8, attack: 1, defence: 1, aggressive: false, xp: 32, drops: ['Cowhide', 'Bones', 'Raw beef'] },
  { name: 'Goblin', color: '#8b1a1a', maxHp: 5, attack: 2, defence: 1, aggressive: true, xp: 20, drops: ['Bones', 'Coins (5)'] },
  { name: 'Spider', color: '#8b1a1a', maxHp: 3, attack: 2, defence: 1, aggressive: false, xp: 15, drops: ['Spider leg'] },
  { name: 'Skeleton', color: '#8b1a1a', maxHp: 12, attack: 5, defence: 3, aggressive: true, xp: 40, drops: ['Bones', 'Coins (12)'] },
  { name: 'Guard', color: '#8b1a1a', maxHp: 22, attack: 10, defence: 8, aggressive: false, xp: 80, drops: ['Coins (30)', 'Bones'] },
  { name: 'Dark Wizard', color: '#8b1a1a', maxHp: 18, attack: 8, defence: 5, aggressive: true, xp: 60, drops: ['Coins (20)', 'Rune essence'] },
];
function spawnNpcs() {}

// ── XP ─────────────────────────────────────────────────────────────────────────
function xpForLevel(l) {
  let t = 0;
  for (let i = 1; i < l; i++) t += Math.floor(i + 300 * Math.pow(2, i / 7)) / 4;
  return Math.floor(t);
}
function levelForXp(xp) {
  for (let l = 1; l < 99; l++) if (xpForLevel(l + 1) > xp) return l;
  return 99;
}
function addXp(p, skill, amount) {
  p.skills[skill].xp += amount;
  const nl = levelForXp(p.skills[skill].xp);
  if (nl > p.skills[skill].level) {
    p.skills[skill].level = nl;
    sendChat(p, `Congratulations! Your ${skill} level is now ${nl}!`, '#ff0');
  }
}

// ── Pathfinding (A*) ───────────────────────────────────────────────────────────
function findPath(sx, sy, tx, ty) {
  if (!isWalkable(tx, ty)) return [];
  if (sx === tx && sy === ty) return [];
  if (Math.abs(tx - sx) + Math.abs(ty - sy) > 200) return [];
  const key = (x, y) => `${x},${y}`;
  const open = [{ x: sx, y: sy, g: 0, f: 0 }];
  const closed = new Set();
  const came = new Map();
  const gScore = new Map();
  gScore.set(key(sx, sy), 0);
  let searched = 0;
  while (open.length > 0 && searched < 2000) {
    searched++;
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.x === tx && cur.y === ty) {
      const p = [];
      let k = key(tx, ty);
      while (came.has(k)) { const c = came.get(k); p.unshift({ x: c.x, y: c.y }); k = key(c.px, c.py); }
      p.push({ x: tx, y: ty });
      return p;
    }
    closed.add(key(cur.x, cur.y));
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!isWalkable(nx, ny) || closed.has(key(nx, ny))) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(cur.x + dx, cur.y) || !isWalkable(cur.x, cur.y + dy))) continue;
      const ng = cur.g + (dx !== 0 && dy !== 0 ? 1.41 : 1);
      const k = key(nx, ny);
      if (!gScore.has(k) || ng < gScore.get(k)) {
        gScore.set(k, ng);
        open.push({ x: nx, y: ny, g: ng, f: ng + Math.abs(nx - tx) + Math.abs(ny - ty) });
        came.set(k, { x: nx, y: ny, px: cur.x, py: cur.y });
      }
    }
  }
  return [];
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const [ws] of players) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}
function broadcastTiles(changes) {
  const byChunk = new Map();
  for (const c of changes) {
    const key = `${Math.floor(c.x / CHUNK_SIZE)}_${Math.floor(c.y / CHUNK_SIZE)}`;
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(c);
  }
  for (const [ws, p] of players) {
    const rel = [];
    for (const [key, cc] of byChunk) if (p.sentChunks.has(key)) rel.push(...cc);
    if (rel.length > 0) send(ws, { t: 'tiles', changes: rel });
  }
}
function sendChat(p, msg, color) { send(p.ws, { t: 'chat', msg, color }); }
function sendStats(p) {
  send(p.ws, { t: 'stats', hp: p.hp, maxHp: p.maxHp, skills: p.skills, inv: p.inventory });
}

function addItem(p, name) {
  if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return false; }
  const ex = p.inventory.find(i => i.name === name);
  if (ex) ex.count++; else p.inventory.push({ name, count: 1 });
  return true;
}
function dropItem(name, x, y) {
  groundItems.push({ id: nextGroundItemId++, name, x, y, despawnTick: tick + 167 });
}

function findCluster(tx, ty) {
  const t = tileAt(tx, ty);
  let x0 = tx, y0 = ty;
  while (tileAt(x0 - 1, y0) === t) x0--;
  while (tileAt(x0, y0 - 1) === t) y0--;
  let w = 0, h = 0;
  while (tileAt(x0 + w, y0) === t) w++;
  while (tileAt(x0, y0 + h) === t) h++;
  return { x: x0, y: y0, w, h };
}

function walkToClusterBase(cx, cy, cw, ch, px, py) {
  const candidates = [];
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy + ch)) candidates.push([cx + dx, cy + ch]);
  for (let dy = 0; dy < ch; dy++) {
    if (isWalkable(cx - 1, cy + dy)) candidates.push([cx - 1, cy + dy]);
    if (isWalkable(cx + cw, cy + dy)) candidates.push([cx + cw, cy + dy]);
  }
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy - 1)) candidates.push([cx + dx, cy - 1]);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return candidates[0];
}

function walkAdjacentTo(tx, ty, px, py) {
  const adj = [[tx-1,ty],[tx+1,ty],[tx,ty-1],[tx,ty+1]].filter(([x,y]) => isWalkable(x,y));
  if (adj.length === 0) return null;
  adj.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return adj[0];
}

// ── Bucket Fill ──────────────────────────────────────────────────────────────
function bucketFill(sx, sy, newTile, newColor) {
  const oldTile = tileAt(sx, sy);
  const oldColor = oldTile === T.CUSTOM ? (getColor(sx, sy) || '#ff00ff') : null;
  if (oldTile === newTile && (newTile !== T.CUSTOM || oldColor === newColor)) return [];
  const changes = [], stack = [{ x: sx, y: sy }], visited = new Set();
  function matches(x, y) {
    if (Math.abs(x - sx) > 100 || Math.abs(y - sy) > 100) return false;
    if (tileAt(x, y) !== oldTile) return false;
    if (oldTile === T.CUSTOM) return (getColor(x, y) || '#ff00ff') === oldColor;
    return true;
  }
  while (stack.length > 0 && changes.length < 5000) {
    const { x, y } = stack.pop();
    const k = `${x},${y}`;
    if (visited.has(k) || !matches(x, y)) continue;
    visited.add(k);
    const prev = tileAt(x, y);
    const prevColor = prev === T.CUSTOM ? (getColor(x, y) || null) : null;
    setTile(x, y, newTile);
    if (newTile === T.CUSTOM && newColor) setColor(x, y, newColor);
    else setColor(x, y, null);
    changes.push({ x, y, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
    stack.push({ x: x+1, y }, { x: x-1, y }, { x, y: y+1 }, { x, y: y-1 });
  }
  return changes;
}

function tileKey(x, y) {
  const t = tileAt(x, y);
  if (t === T.CUSTOM) return 'c:' + (getColor(x, y) || '#ff00ff');
  return 't:' + t;
}

function bucketAllRecolor(sx, sy, newTile, newColor) {
  const targetKey = tileKey(sx, sy);
  const changes = [];
  for (const [key, chunk] of chunks) {
    const [cx, cy] = key.split('_').map(Number);
    const baseX = cx * CHUNK_SIZE, baseY = cy * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const k = ly * CHUNK_SIZE + lx;
        const t = chunk.tiles[k];
        const tk = t === T.CUSTOM ? 'c:' + (chunk.colors.get(k) || '#ff00ff') : 't:' + t;
        if (tk !== targetKey) continue;
        const wx = baseX + lx, wy = baseY + ly;
        const prev = t, prevColor = t === T.CUSTOM ? (chunk.colors.get(k) || null) : null;
        chunk.tiles[k] = newTile;
        if (newTile === T.CUSTOM && newColor) chunk.colors.set(k, newColor);
        else chunk.colors.delete(k);
        chunk.dirty = true;
        changes.push({ x: wx, y: wy, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
      }
    }
  }
  return changes;
}

// ── Player Chunks ──────────────────────────────────────────────────────────────
function sendChunkToPlayer(ws, cx, cy) {
  const chunk = getChunk(cx, cy);
  const colorsObj = {};
  for (const [k, v] of chunk.colors) colorsObj[k] = v;
  const msg = { t: 'chunk', cx, cy, tiles: Buffer.from(chunk.tiles).toString('base64'), colors: colorsObj };
  // Attach OSRS terrain data if available
  const terrain = loadTerrainChunk(cx, cy);
  if (terrain) msg.terrain = Buffer.from(terrain).toString('base64');
  const heights = loadTerrainHeights(cx, cy);
  if (heights) msg.heights = Buffer.from(heights.buffer).toString('base64');
  send(ws, msg);
}

function updatePlayerChunks(p) {
  const pcx = Math.floor(p.x / CHUNK_SIZE), pcy = Math.floor(p.y / CHUNK_SIZE);
  for (let dx = -VIEW_DIST; dx <= VIEW_DIST; dx++) {
    for (let dy = -VIEW_DIST; dy <= VIEW_DIST; dy++) {
      const key = `${pcx + dx}_${pcy + dy}`;
      if (!p.sentChunks.has(key)) {
        sendChunkToPlayer(p.ws, pcx + dx, pcy + dy);
        p.sentChunks.add(key);
      }
    }
  }
  for (const key of p.sentChunks) {
    const [cx, cy] = key.split('_').map(Number);
    if (Math.abs(cx - pcx) > VIEW_DIST + 2 || Math.abs(cy - pcy) > VIEW_DIST + 2) {
      p.sentChunks.delete(key);
    }
  }
}

// ── Player Factory ─────────────────────────────────────────────────────────────
function createPlayer(ws) {
  let sx = SPAWN_X, sy = SPAWN_Y;
  for (let r = 0; r < 50; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (isWalkable(SPAWN_X + dx, SPAWN_Y + dy)) { sx = SPAWN_X + dx; sy = SPAWN_Y + dy; r = 999; dx = 999; break; }
  return {
    id: nextPlayerId++, ws, x: sx, y: sy, hp: 10, maxHp: 10,
    gender: 'male', sentChunks: new Set(),
    path: [], gathering: null, actionTick: 0,
    combatTarget: null, clickedNpc: null, pendingPickup: null, gatherCluster: null,
    skills: {
      attack: { xp: 0, level: 1 }, strength: { xp: 0, level: 1 },
      defence: { xp: 0, level: 1 }, hitpoints: { xp: 1154, level: 10 },
      woodcutting: { xp: 0, level: 1 }, fishing: { xp: 0, level: 1 },
      mining: { xp: 0, level: 1 },
    },
    inventory: [],
  };
}

// ── Game Tick ──────────────────────────────────────────────────────────────────
function gameTick() {
  tick++;

  for (const [, p] of players) {
    if (p.path.length > 0) {
      const prevCX = Math.floor(p.x / CHUNK_SIZE), prevCY = Math.floor(p.y / CHUNK_SIZE);
      const next = p.path.shift();
      p.x = next.x; p.y = next.y;
      const newCX = Math.floor(p.x / CHUNK_SIZE), newCY = Math.floor(p.y / CHUNK_SIZE);
      if (newCX !== prevCX || newCY !== prevCY) updatePlayerChunks(p);
    }

    if (p.pendingPickup !== null && p.path.length === 0) {
      const idx = groundItems.findIndex(g => g.id === p.pendingPickup);
      if (idx !== -1) {
        const gi = groundItems[idx];
        if (p.x === gi.x && p.y === gi.y && addItem(p, gi.name)) {
          groundItems.splice(idx, 1);
          sendStats(p);
          sendChat(p, `You pick up: ${gi.name}`, '#ff0');
        }
      }
      p.pendingPickup = null;
    }

    if (p.gathering && p.path.length === 0) {
      const g = p.gathering;
      const cl = p.gatherCluster;
      let adjacent = false;
      if (cl) {
        for (let dy = 0; dy < cl.h && !adjacent; dy++)
          for (let dx = 0; dx < cl.w && !adjacent; dx++)
            if (Math.abs(p.x - (cl.x + dx)) + Math.abs(p.y - (cl.y + dy)) <= 1) adjacent = true;
      } else {
        adjacent = Math.abs(p.x - g.tx) + Math.abs(p.y - g.ty) <= 1;
      }
      if (adjacent && tileAt(g.tx, g.ty) === g.tile) {
        p.actionTick++;
        if (p.actionTick >= 4) {
          p.actionTick = 0;
          if (g.type === 'woodcutting') {
            const wcChance = Math.min(0.9, 0.25 + p.skills.woodcutting.level * 0.005);
            if (rng() >= wcChance) { sendChat(p, 'You swing at the tree...', '#ccc'); }
            else if (addItem(p, 'Logs')) {
              addXp(p, 'woodcutting', 25);
              sendChat(p, 'You chop down the tree.', '#ff0');
              const cl2 = p.gatherCluster || { x: g.tx, y: g.ty, w: 1, h: 1 };
              const changes = [];
              for (let dy = 0; dy < cl2.h; dy++)
                for (let dx = 0; dx < cl2.w; dx++) {
                  setTile(cl2.x + dx, cl2.y + dy, T.GRASS);
                  changes.push({ x: cl2.x + dx, y: cl2.y + dy, tile: T.GRASS });
                  respawns.push({ x: cl2.x + dx, y: cl2.y + dy, tile: T.TREE, tick: tick + 25 });
                }
              broadcastTiles(changes);
              p.gathering = null; p.gatherCluster = null;
            }
          } else if (g.type === 'mining') {
            const mineChance = Math.min(0.9, 0.25 + p.skills.mining.level * 0.005);
            if (rng() >= mineChance) { sendChat(p, 'You swing at the rock...', '#ccc'); }
            else if (addItem(p, 'Ore')) {
              addXp(p, 'mining', 30);
              sendChat(p, 'You mine some ore.', '#ff0');
              setTile(g.tx, g.ty, T.GRASS);
              broadcastTiles([{ x: g.tx, y: g.ty, tile: T.GRASS }]);
              respawns.push({ x: g.tx, y: g.ty, tile: T.ROCK, tick: tick + 33 });
              p.gathering = null;
            }
          } else if (g.type === 'fishing') {
            const fishChance = Math.min(0.9, 0.25 + p.skills.fishing.level * 0.005);
            if (rng() >= fishChance) { sendChat(p, 'You continue fishing...', '#ccc'); }
            else if (addItem(p, 'Raw fish')) {
              addXp(p, 'fishing', 20);
              sendChat(p, 'You catch a fish.', '#ff0');
            }
          }
          sendStats(p);
        }
      } else { p.gathering = null; }
    }

    if (p.clickedNpc !== null && p.path.length === 0) {
      const npc = npcs[p.clickedNpc];
      if (npc && !npc.dead && Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y) <= 1) {
        p.combatTarget = p.clickedNpc;
        p.clickedNpc = null;
      }
    }

    if (p.combatTarget !== null) {
      const npc = npcs[p.combatTarget];
      if (!npc || npc.dead || Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y) > 2) {
        p.combatTarget = null;
      } else if (tick % 4 === 0) {
        const hitChance = Math.max(0.1, Math.min(0.95, 0.4 + p.skills.attack.level * 0.03 - (npc.defence || 1) * 0.02));
        const maxHit = Math.max(1, p.skills.strength.level + 1);
        if (rng() < hitChance) {
          const dmg = Math.floor(rng() * maxHit) + 1;
          npc.hp -= dmg;
          sendChat(p, `You hit ${npc.name} for ${dmg}`, '#f44');
          addXp(p, 'attack', Math.ceil(dmg * 2));
          addXp(p, 'strength', Math.ceil(dmg * 2));
        } else { sendChat(p, `You miss ${npc.name}`, '#f44'); }
        if (npc.hp <= 0) {
          npc.dead = true; npc.respawnTick = tick + 17;
          addXp(p, 'hitpoints', Math.ceil(npc.xp * 0.33));
          sendChat(p, `You killed ${npc.name}!`, '#0f0');
          for (const drop of npc.drops) { if (rng() > 0.3) dropItem(drop, npc.x, npc.y); }
          p.combatTarget = null;
        } else {
          const npcHitChance = Math.max(0.05, Math.min(0.9, 0.3 + (npc.attack || 1) * 0.03 - p.skills.defence.level * 0.02));
          if (rng() < npcHitChance) {
            const npcDmg = Math.floor(rng() * Math.max(1, npc.attack || 1)) + 1;
            p.hp -= npcDmg;
            sendChat(p, `${npc.name} hits you for ${npcDmg}`, '#f44');
            addXp(p, 'defence', Math.ceil(npcDmg * 2));
            if (p.hp <= 0) killPlayer(p);
          }
        }
        p.maxHp = p.skills.hitpoints.level;
        sendStats(p);
      }
    }
  }

  // NPC AI
  for (const npc of npcs) {
    if (npc.dead) {
      if (tick >= npc.respawnTick) { npc.dead = false; npc.hp = npc.maxHp; npc.x = npc.spawnX; npc.y = npc.spawnY; }
      continue;
    }
    if (tick % 5 === npc.wanderTick % 5) {
      const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
      const [dx, dy] = dirs[Math.floor(rng() * 4)];
      const nx = npc.x + dx, ny = npc.y + dy;
      if (isWalkable(nx, ny) && Math.abs(nx - npc.spawnX) + Math.abs(ny - npc.spawnY) < 8) {
        npc.x = nx; npc.y = ny;
      }
    }
    if (npc.aggressive) {
      let closest = null, closestDist = 999;
      for (const [, p] of players) {
        const d = Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y);
        if (d < closestDist) { closest = p; closestDist = d; }
      }
      if (closest && closestDist < 5 && closestDist > 1) {
        const dx = Math.sign(closest.x - npc.x), dy = Math.sign(closest.y - npc.y);
        if (isWalkable(npc.x + dx, npc.y + dy)) { npc.x += dx; npc.y += dy; }
      }
      if (closest && closestDist <= 1 && tick % 5 === 0) {
        const npcHitChance = Math.max(0.05, Math.min(0.9, 0.3 + (npc.attack || 1) * 0.03 - closest.skills.defence.level * 0.02));
        if (rng() < npcHitChance) {
          const dmg = Math.floor(rng() * Math.max(1, npc.attack || 1)) + 1;
          closest.hp -= dmg;
          sendChat(closest, `${npc.name} hits you for ${dmg}`, '#f44');
          addXp(closest, 'defence', Math.ceil(dmg * 2));
          if (closest.hp <= 0) killPlayer(closest);
          closest.maxHp = closest.skills.hitpoints.level;
          sendStats(closest);
        }
      }
    }
  }

  // Respawn resources
  for (let i = respawns.length - 1; i >= 0; i--) {
    if (tick >= respawns[i].tick) {
      const r = respawns[i];
      setTile(r.x, r.y, r.tile);
      broadcastTiles([{ x: r.x, y: r.y, tile: r.tile }]);
      respawns.splice(i, 1);
    }
  }

  // Despawn ground items
  for (let i = groundItems.length - 1; i >= 0; i--) {
    if (tick >= groundItems[i].despawnTick) groundItems.splice(i, 1);
  }

  // HP regen
  if (tick % 100 === 0) {
    for (const [, p] of players) {
      if (p.hp < p.maxHp) { p.hp++; sendStats(p); }
    }
  }

  // Per-player state broadcast (proximity filtered)
  if (tick % STATE_INTERVAL === 0) {
    for (const [ws, p] of players) {
      const pArr = [];
      for (const [, op] of players) {
        if (Math.abs(op.x - p.x) <= ENTITY_VIEW && Math.abs(op.y - p.y) <= ENTITY_VIEW) {
          pArr.push({ id: op.id, x: op.x, y: op.y, hp: op.hp, maxHp: op.maxHp, g: op.gender, path: op.path.slice(0, 20) });
        }
      }
      const nArr = npcs.filter(n => !n.dead && Math.abs(n.x - p.x) <= ENTITY_VIEW && Math.abs(n.y - p.y) <= ENTITY_VIEW)
        .map(n => ({ id: n.id, x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp, name: n.name, color: n.color, atk: n.attack || 1, def: n.defence || 1 }));
      const gArr = groundItems.filter(g => Math.abs(g.x - p.x) <= ENTITY_VIEW && Math.abs(g.y - p.y) <= ENTITY_VIEW)
        .map(g => ({ id: g.id, name: g.name, x: g.x, y: g.y }));
      const dArr = [...openDoors.values()].filter(d => Math.abs(d.ox - p.x) <= ENTITY_VIEW && Math.abs(d.oy - p.y) <= ENTITY_VIEW);
      send(ws, { t: 'state', players: pArr, npcs: nArr, items: gArr, doors: dArr, tick });
    }
  }

  // Evict idle chunks every 30s
  if (tick % 50 === 0) evictChunks();
}

function killPlayer(p) {
  p.hp = p.maxHp; p.path = []; p.gathering = null; p.combatTarget = null; p.clickedNpc = null;
  for (let r = 0; r < 50; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (isWalkable(SPAWN_X + dx, SPAWN_Y + dy)) { p.x = SPAWN_X + dx; p.y = SPAWN_Y + dy; r = 999; dx = 999; break; }
  sendChat(p, 'Oh dear, you are dead!', '#f00');
  if (p.inventory.length > 3) p.inventory.splice(3);
  sendStats(p);
  updatePlayerChunks(p);
}

// ── Message Handling ───────────────────────────────────────────────────────────
function handleMessage(ws, data) {
  const p = players.get(ws);
  if (!p) return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.t) {
    case 'move': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) > 200) { sendChat(p, 'Too far!', '#f44'); return; }
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      if (isWalkable(tx, ty)) { p.path = findPath(p.x, p.y, tx, ty); }
      else { sendChat(p, "I can't reach that.", '#f44'); }
      break;
    }
    case 'gather': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) > 200) return;
      const tile = tileAt(tx, ty);
      const typeMap = { [T.TREE]: 'woodcutting', [T.ROCK]: 'mining', [T.FISH_SPOT]: 'fishing' };
      if (!typeMap[tile]) return;
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      let adj;
      if (tile === T.TREE || tile === T.ROCK) {
        const cl = findCluster(tx, ty);
        adj = walkToClusterBase(cl.x, cl.y, cl.w, cl.h, p.x, p.y);
        p.gatherCluster = cl;
      } else {
        adj = walkAdjacentTo(tx, ty, p.x, p.y);
        p.gatherCluster = null;
      }
      if (adj) {
        p.path = findPath(p.x, p.y, adj[0], adj[1]);
        p.gathering = { type: typeMap[tile], tx, ty, tile };
        p.actionTick = 0;
      }
      break;
    }
    case 'gender': { p.gender = msg.v === 'female' ? 'female' : 'male'; break; }
    case 'door': {
      const dx = Math.floor(msg.x), dy = Math.floor(msg.y);
      if (Math.abs(p.x - dx) > 1 || Math.abs(p.y - dy) > 1) {
        sendChat(p, 'You need to be next to the door.', '#f44'); return;
      }
      const dk = `${dx},${dy}`;
      const tile = tileAt(dx, dy);
      if (tile === T.DOOR) {
        let sx = dx, sy = dy;
        for (const [ndx, ndy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          if (tileAt(dx + ndx, dy + ndy) === T.FLOOR) { sx = dx + ndx; sy = dy + ndy; break; }
        }
        openDoors.set(dk, { ox: dx, oy: dy, sx, sy });
        setTile(dx, dy, T.FLOOR);
        broadcastTiles([{ x: dx, y: dy, tile: T.FLOOR }]);
        sendChat(p, 'You open the door.', '#ccc');
      } else {
        for (const [key, d] of openDoors) {
          if ((dx === d.ox && dy === d.oy) || (dx === d.sx && dy === d.sy)) {
            if (Math.abs(p.x - d.ox) > 1 || Math.abs(p.y - d.oy) > 1) {
              sendChat(p, 'You need to be next to the door.', '#f44'); return;
            }
            openDoors.delete(key);
            setTile(d.ox, d.oy, T.DOOR);
            broadcastTiles([{ x: d.ox, y: d.oy, tile: T.DOOR }]);
            sendChat(p, 'You close the door.', '#ccc');
            break;
          }
        }
      }
      break;
    }
    case 'pickup': {
      const gid = Math.floor(msg.id);
      const idx = groundItems.findIndex(g => g.id === gid);
      if (idx === -1) return;
      const gi = groundItems[idx];
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      if (p.x === gi.x && p.y === gi.y) {
        if (addItem(p, gi.name)) {
          groundItems.splice(idx, 1);
          sendStats(p); sendChat(p, `You pick up: ${gi.name}`, '#ff0');
        }
      } else {
        p.path = findPath(p.x, p.y, gi.x, gi.y);
        p.pendingPickup = gid;
      }
      break;
    }
    case 'attack': {
      const npcId = Math.floor(msg.id);
      if (npcId < 0 || npcId >= npcs.length || npcs[npcId].dead) return;
      const npc = npcs[npcId];
      p.gathering = null; p.combatTarget = null;
      const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y);
      if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1]); p.clickedNpc = npcId; }
      break;
    }
    case 'paint': {
      const changes = [];
      if (!Array.isArray(msg.tiles) || msg.tiles.length > 500) return;
      for (const t of msg.tiles) {
        const x = Math.floor(t.x), y = Math.floor(t.y);
        if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) continue;
        const tile = Math.floor(t.tile);
        if (tile < 0 || tile > T.CUSTOM) continue;
        setTile(x, y, tile);
        if (tile === T.CUSTOM && t.color) setColor(x, y, String(t.color).slice(0, 7));
        else setColor(x, y, null);
        changes.push({ x, y, tile, color: t.color || null });
      }
      if (changes.length > 0) broadcastTiles(changes);
      break;
    }
    case 'bucket': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketFill(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color })));
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
      }
      break;
    }
    case 'bucket_all': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketAllRecolor(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color })));
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
        sendChat(p, `Recolored ${changes.length} tiles globally.`, '#ff981f');
      }
      break;
    }
    case 'bucket_new': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const name = String(msg.name || '').slice(0, 30);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM || !name) return;
      const newNameKey = tile === T.CUSTOM && msg.color ? 'c:' + msg.color : 't:' + tile;
      customNames.set(newNameKey, name);
      const changes = bucketAllRecolor(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color })));
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
      }
      const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
      broadcast({ t: 'names', names: namesObj });
      sendChat(p, `Renamed ${changes.length} tiles to "${name}".`, '#ff981f');
      break;
    }
  }
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const clientPath = path.join(__dirname, 'client.html');
const mapPath = path.join(__dirname, 'map.html');
const server = http.createServer((req, res) => {
  const file = req.url === '/map' ? mapPath : clientPath;
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(file, 'utf8'));
});

// ── WebSocket Server ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const p = createPlayer(ws);
  players.set(ws, p);
  console.log(`[join] Player ${p.id} at (${p.x}, ${p.y}) (${players.size} online)`);

  const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
  send(ws, { t: 'welcome', id: p.id, x: p.x, y: p.y, customNames: namesObj, chunkSize: CHUNK_SIZE });
  updatePlayerChunks(p);
  sendStats(p);
  sendChat(p, `Welcome to MiniScape! ${players.size} player(s) online.`, '#ff981f');
  broadcast({ t: 'chat', msg: `Player ${p.id} has joined.`, color: '#0ff' });

  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => {
    players.delete(ws);
    broadcast({ t: 'chat', msg: `Player ${p.id} has left.`, color: '#888' });
    console.log(`[leave] Player ${p.id} disconnected (${players.size} online)`);
  });
});

// ── Init ───────────────────────────────────────────────────────────────────────
fs.mkdirSync(CHUNKS_DIR, { recursive: true });
if (fs.existsSync(NAMES_FILE)) {
  const obj = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
  for (const [k, v] of Object.entries(obj)) customNames.set(k, v);
  console.log(`[load] ${customNames.size} custom names`);
}
spawnNpcs();

setInterval(gameTick, TICK_MS);
setInterval(saveAllChunks, SAVE_INTERVAL_MS);
process.on('SIGINT', () => { saveAllChunks(); process.exit(); });
process.on('SIGTERM', () => { saveAllChunks(); process.exit(); });

server.listen(PORT, () => {
  console.log(`[server] MiniScape running on http://localhost:${PORT}`);
  console.log(`[server] Chunk-based world (${CHUNK_SIZE}x${CHUNK_SIZE} chunks, view=${VIEW_DIST})`);
  console.log(`[server] Spawn: OSRS (${SPAWN_X}, ${SPAWN_Y}) Lumbridge`);
});
