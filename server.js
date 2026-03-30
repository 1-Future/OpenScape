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
const NAMES_FILE = path.join(DATA_DIR, 'names.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const WALLS_FILE = path.join(DATA_DIR, 'walls.json');
const DOORS_FILE = path.join(DATA_DIR, 'doors.json');
const HEIGHTS_FILE = path.join(DATA_DIR, 'heights.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const VARIANTS_FILE = path.join(DATA_DIR, 'variants.json');
const APPEARANCES_FILE = path.join(DATA_DIR, 'appearances.json');
const playerPositions = new Map(); // name → {x, y, layer}
const playerAppearances = new Map(); // name → appearance object
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1480654483095552123/AsoMuMPfGyKNYma5hh-kYnIaNLm4sLF8Ui3rVewiZf37anEXyw5qU_7I8E8gQkDcDm1E';
const DISCORD_BOT_USER_ID = '1464768627709313044';
const BOT_PLAYER_ID = 0; // Reserved ID for Discord bot "AI"

const CHUNK_SIZE = 64;
const VIEW_DIST = 3;
const ENTITY_VIEW = (VIEW_DIST + 1) * CHUNK_SIZE;
const SPAWN_X = 100, SPAWN_Y = 100;

// ── Tick Queue System ────────────────────────────────────────────────────────
// Actions are scheduled for a future tick and run in priority order:
//   0 = movement, 1 = player actions, 2 = NPC actions, 3 = world events
// Usage: schedule(tick + 4, 1, 'player:3:attack', () => { ... })
// The key is optional — if provided, scheduling with the same key replaces the old entry.
const tickQueue = []; // { tick, priority, key, fn }

function schedule(atTick, priority, key, fn) {
  // If key provided, remove any existing entry with that key
  if (key) {
    for (let i = tickQueue.length - 1; i >= 0; i--) {
      if (tickQueue[i].key === key) { tickQueue.splice(i, 1); break; }
    }
  }
  tickQueue.push({ tick: atTick, priority, key, fn });
}

function cancelScheduled(key) {
  for (let i = tickQueue.length - 1; i >= 0; i--) {
    if (tickQueue[i].key === key) { tickQueue.splice(i, 1); return true; }
  }
  return false;
}

function processTickQueue() {
  // Collect all actions due this tick
  const due = [];
  for (let i = tickQueue.length - 1; i >= 0; i--) {
    if (tickQueue[i].tick <= tick) {
      due.push(tickQueue[i]);
      tickQueue.splice(i, 1);
    }
  }
  // Sort by priority (lower = earlier)
  due.sort((a, b) => a.priority - b.priority);
  // Execute
  for (const action of due) {
    try { action.fn(); } catch (e) { console.error('[tickQueue] Error:', e.message); }
  }
}


const T = {
  GRASS: 0, WATER: 1, TREE: 2, PATH: 3, ROCK: 4, SAND: 5, WALL: 6,
  FLOOR: 7, DOOR: 8, BRIDGE: 9, FISH_SPOT: 10, FLOWER: 11, BUSH: 12,
  DARK_GRASS: 13, CUSTOM: 14
};


// ── Chunk System ───────────────────────────────────────────────────────────────
const chunks = new Map();

function localXY(wx, wy) {
  return [((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE];
}

function loadChunkFromDisk(cx, cy, layer = 0) {
  const prefix = layer === 0 ? `${cx}_${cy}` : `L${layer}_${cx}_${cy}`;
  const tp = path.join(CHUNKS_DIR, `${prefix}.bin`);
  if (!fs.existsSync(tp)) return null;
  const buf = fs.readFileSync(tp);
  const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.set(new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, tiles.length)));
  const colors = new Map();
  const cp = path.join(CHUNKS_DIR, `${prefix}.json`);
  if (fs.existsSync(cp)) {
    const obj = JSON.parse(fs.readFileSync(cp, 'utf8'));
    for (const [k, v] of Object.entries(obj)) colors.set(parseInt(k), v);
  }
  return { tiles, colors, dirty: false, lastAccess: Date.now() };
}

function saveChunkToDisk(cx, cy, chunk, layer = 0) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  const prefix = layer === 0 ? `${cx}_${cy}` : `L${layer}_${cx}_${cy}`;
  fs.writeFileSync(path.join(CHUNKS_DIR, `${prefix}.bin`), Buffer.from(chunk.tiles));
  const cp = path.join(CHUNKS_DIR, `${prefix}.json`);
  if (chunk.colors.size > 0) {
    const obj = {}; for (const [k, v] of chunk.colors) obj[k] = v;
    fs.writeFileSync(cp, JSON.stringify(obj));
  } else if (fs.existsSync(cp)) { fs.unlinkSync(cp); }
  chunk.dirty = false;
}

function getChunk(cx, cy, layer = 0) {
  const key = `${layer}_${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (chunk) return chunk;
  chunk = loadChunkFromDisk(cx, cy, layer);
  if (!chunk) { const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE); tiles.fill(T.WATER); chunk = { tiles, colors: new Map(), dirty: false, lastAccess: Date.now() }; }
  chunks.set(key, chunk);
  return chunk;
}

function tileAt(x, y, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const key = `${layer}_${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (!chunk) {
    chunk = loadChunkFromDisk(cx, cy, layer);
    if (!chunk) return T.WATER;
    chunks.set(key, chunk);
  }
  const [lx, ly] = localXY(x, y);
  return chunk.tiles[ly * CHUNK_SIZE + lx];
}

function setTile(x, y, t, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy, layer);
  const [lx, ly] = localXY(x, y);
  chunk.tiles[ly * CHUNK_SIZE + lx] = t;
  chunk.dirty = true;
  chunk.lastAccess = Date.now();
}

function getColor(x, y, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = chunks.get(`${layer}_${cx}_${cy}`);
  if (!chunk) return null;
  const [lx, ly] = localXY(x, y);
  return chunk.colors.get(ly * CHUNK_SIZE + lx) || null;
}

function setColor(x, y, color, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy, layer);
  const [lx, ly] = localXY(x, y);
  const k = ly * CHUNK_SIZE + lx;
  if (color) chunk.colors.set(k, color);
  else chunk.colors.delete(k);
  chunk.dirty = true;
}

// Cardinal adjacency check — melee requires N/S/E/W, no diagonals
function isCardinalAdjacent(x1, y1, x2, y2) {
  const dx = Math.abs(x1 - x2), dy = Math.abs(y1 - y2);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

// Tile variant storage (server-side)
global.tileVariantMap = new Map(); // "layer_x_y" → variant number

function saveVariants() {
  try {
    const obj = {};
    for (const [k, v] of global.tileVariantMap) obj[k] = v;
    fs.writeFileSync(VARIANTS_FILE, JSON.stringify(obj));
  } catch (e) { console.warn('[variants] Save error:', e.message); }
}

function loadVariants() {
  try {
    if (fs.existsSync(VARIANTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(VARIANTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) global.tileVariantMap.set(k, v);
      console.log(`[variants] Loaded ${global.tileVariantMap.size} tile variants`);
    }
  } catch (e) { console.warn('[variants] Load error:', e.message); }
}

// Wall/door edge storage (server-side, mirrors client)
const serverWallEdges = new Map(); // "layer_x_y" → bitmask (N=1, E=2, S=4, W=8, diagNE=16, diagNW=32)
const serverWallTexMap = new Map(); // "layer_x_y" → "type_variant" (wall texture key)
const serverDoorEdges = new Map();
const serverOpenDoors = new Map(); // "layer_x_y" → bitmask of which edges are currently open
const serverTileHeights = new Map(); // "layer_x_y" → height (float)
const serverRoofs = new Map(); // "layer_id" → roof object
let serverNextRoofId = 1;
const ROOFS_FILE = path.join(DATA_DIR, 'roofs.json');
const WALL_TEX_FILE = path.join(DATA_DIR, 'wall_textures.json');
const LOTS_FILE = path.join(DATA_DIR, 'lots.json');
const serverLots = new Map(); // id → {id, name, layer, tiles: [{x,y}], color, cx, cy}
let serverNextLotId = 1;

function saveWalls() {
  try {
    const walls = {}; for (const [k, v] of serverWallEdges) walls[k] = v;
    const doors = {}; for (const [k, v] of serverDoorEdges) doors[k] = v;
    const heights = {}; for (const [k, v] of serverTileHeights) heights[k] = v;
    fs.writeFileSync(WALLS_FILE, JSON.stringify(walls));
    fs.writeFileSync(DOORS_FILE, JSON.stringify(doors));
    fs.writeFileSync(HEIGHTS_FILE, JSON.stringify(heights));
    const roofs = {}; for (const [k, v] of serverRoofs) roofs[k] = v;
    fs.writeFileSync(ROOFS_FILE, JSON.stringify(roofs));
    const wallTex = {}; for (const [k, v] of serverWallTexMap) wallTex[k] = v;
    fs.writeFileSync(WALL_TEX_FILE, JSON.stringify(wallTex));
  } catch (e) { console.warn('[walls] Save error:', e.message); }
}

function loadWalls() {
  try {
    if (fs.existsSync(WALLS_FILE)) {
      const walls = JSON.parse(fs.readFileSync(WALLS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(walls)) serverWallEdges.set(k, v);
      console.log(`[walls] Loaded ${serverWallEdges.size} wall edges`);
    }
    if (fs.existsSync(DOORS_FILE)) {
      const doors = JSON.parse(fs.readFileSync(DOORS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(doors)) serverDoorEdges.set(k, v);
      console.log(`[walls] Loaded ${serverDoorEdges.size} door edges`);
    }
    if (fs.existsSync(HEIGHTS_FILE)) {
      const heights = JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(heights)) serverTileHeights.set(k, parseFloat(v));
      console.log(`[heights] Loaded ${serverTileHeights.size} tile heights`);
    }
    if (fs.existsSync(ROOFS_FILE)) {
      const roofs = JSON.parse(fs.readFileSync(ROOFS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(roofs)) { serverRoofs.set(k, v); if (v.id >= serverNextRoofId) serverNextRoofId = v.id + 1; }
      console.log(`[roofs] Loaded ${serverRoofs.size} roofs`);
    }
    if (fs.existsSync(WALL_TEX_FILE)) {
      const wallTex = JSON.parse(fs.readFileSync(WALL_TEX_FILE, 'utf8'));
      for (const [k, v] of Object.entries(wallTex)) serverWallTexMap.set(k, v);
      console.log(`[wallTex] Loaded ${serverWallTexMap.size} wall textures`);
    }
  } catch (e) { console.warn('[walls] Load error:', e.message); }
}

function saveLots() {
  try {
    const lots = {}; for (const [k, v] of serverLots) lots[k] = v;
    fs.writeFileSync(LOTS_FILE, JSON.stringify(lots));
  } catch (e) { console.warn('[lots] Save error:', e.message); }
}

function loadLots() {
  try {
    if (fs.existsSync(LOTS_FILE)) {
      const lots = JSON.parse(fs.readFileSync(LOTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(lots)) {
        serverLots.set(k, v);
        if (v.id >= serverNextLotId) serverNextLotId = v.id + 1;
      }
      console.log(`[lots] Loaded ${serverLots.size} lots`);
    }
  } catch (e) { console.warn('[lots] Load error:', e.message); }
}

// Send wall/door edges for a layer to a player
function sendEdgesForLayer(ws, layer) {
  const walls = [], doors = [];
  for (const [k, v] of serverWallEdges) {
    const parts = k.split('_');
    if (parseInt(parts[0]) === layer) walls.push({ x: parseInt(parts[1]), y: parseInt(parts[2]), mask: v });
  }
  for (const [k, v] of serverDoorEdges) {
    const parts = k.split('_');
    if (parseInt(parts[0]) === layer) doors.push({ x: parseInt(parts[1]), y: parseInt(parts[2]), mask: v });
  }
  if (walls.length > 0) send(ws, { t: 'walls_bulk', layer, walls });
  if (doors.length > 0) send(ws, { t: 'doors_bulk', layer, doors });
}
function getServerWallEdge(x, y, layer = 0) { return serverWallEdges.get(`${layer}_${x}_${y}`) || 0; }
function getServerDoorEdge(x, y, layer = 0) { return serverDoorEdges.get(`${layer}_${x}_${y}`) || 0; }

function isWalkable(x, y, layer = 0) {
  // Only walls block movement — tile colors are purely visual
  const we = getServerWallEdge(x, y, layer);
  if (we & 48) return false; // diagonal walls block the full tile
  return true;
}

// Check if movement from (fx,fy) to (tx,ty) is blocked by an edge wall
function isEdgeBlocked(fx, fy, tx, ty, layer = 0) {
  const dx = tx - fx, dy = ty - fy;
  // Combine wall + door edges, but exclude open doors from blocking
  const fromOpen = serverOpenDoors.get(`${layer}_${fx}_${fy}`) || 0;
  const toOpen = serverOpenDoors.get(`${layer}_${tx}_${ty}`) || 0;
  const fromEdges = getServerWallEdge(fx, fy, layer) | (getServerDoorEdge(fx, fy, layer) & ~fromOpen);
  const toEdges = getServerWallEdge(tx, ty, layer) | (getServerDoorEdge(tx, ty, layer) & ~toOpen);
  // Cardinal movement
  if (dx === 0 && dy === 1) return !!(fromEdges & 1) || !!(toEdges & 4);   // moving north: from's N wall or to's S wall
  if (dx === 0 && dy === -1) return !!(fromEdges & 4) || !!(toEdges & 1);   // moving south
  if (dx === 1 && dy === 0) return !!(fromEdges & 2) || !!(toEdges & 8);   // moving east
  if (dx === -1 && dy === 0) return !!(fromEdges & 8) || !!(toEdges & 2);  // moving west
  // Diagonal movement: check both cardinal components
  if (dx !== 0 && dy !== 0) {
    if (isEdgeBlocked(fx, fy, fx + dx, fy, layer)) return true;
    if (isEdgeBlocked(fx, fy, fx, fy + dy, layer)) return true;
    if (isEdgeBlocked(fx + dx, fy, tx, ty, layer)) return true;
    if (isEdgeBlocked(fx, fy + dy, tx, ty, layer)) return true;
  }
  return false;
}

function evictChunks() {
  const now = Date.now();
  const keep = new Set();
  for (const [, p] of players) {
    const cx = Math.floor(p.x / CHUNK_SIZE), cy = Math.floor(p.y / CHUNK_SIZE);
    for (let dx = -(VIEW_DIST + 1); dx <= VIEW_DIST + 1; dx++)
      for (let dy = -(VIEW_DIST + 1); dy <= VIEW_DIST + 1; dy++)
        keep.add(`${p.layer}_${cx + dx}_${cy + dy}`);
  }
  for (const [key, chunk] of chunks) {
    if (keep.has(key)) continue;
    if (now - chunk.lastAccess > 60000) {
      if (chunk.dirty) {
        const parts = key.split('_').map(Number);
        const [layer, cx, cy] = parts;
        saveChunkToDisk(cx, cy, chunk, layer);
      }
      chunks.delete(key);
    }
  }
}

function saveAllChunks() {
  let saved = 0;
  for (const [key, chunk] of chunks) {
    if (!chunk.dirty) continue;
    const parts = key.split('_').map(Number);
    const [layer, cx, cy] = parts;
    saveChunkToDisk(cx, cy, chunk, layer);
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

// ── Friends System ────────────────────────────────────────────────────────────
const friendsData = new Map(); // id -> Set of friend ids
const playerNames = new Map(); // id -> display name

// Load friends from disk
function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
      for (const [name, pos] of Object.entries(data)) playerPositions.set(name, pos);
      console.log(`[positions] Loaded ${playerPositions.size} saved positions`);
    }
  } catch (e) {}
}
function savePositions() {
  try {
    const data = {};
    for (const [name, pos] of playerPositions) data[name] = pos;
    // Also save all currently online players
    for (const [, p] of players) {
      const name = playerNames.get(p.id);
      if (name) data[name] = { x: p.x, y: p.y, layer: p.layer };
    }
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data));
  } catch (e) {}
}

const DEFAULT_APPEARANCE = {
  bodyType: 'A', // A or B
  head: 0, jaw: 0, torso: 0, arms: 0, hands: 0, legs: 0, feet: 0,
  hairColor: '#6B3A2A', torsoColor: '#8B7355', legsColor: '#4A5568', feetColor: '#5C4033', skinColor: '#D4A574',
};

function loadAppearances() {
  try {
    if (fs.existsSync(APPEARANCES_FILE)) {
      const data = JSON.parse(fs.readFileSync(APPEARANCES_FILE, 'utf8'));
      for (const [name, app] of Object.entries(data)) playerAppearances.set(name, app);
      console.log(`[appearances] Loaded ${playerAppearances.size} saved appearances`);
    }
  } catch (e) {}
}
function saveAppearances() {
  try {
    const data = {};
    for (const [name, app] of playerAppearances) data[name] = app;
    // Also save all currently online players
    for (const [, p] of players) {
      const name = playerNames.get(p.id);
      if (name && p.appearance) data[name] = p.appearance;
    }
    fs.writeFileSync(APPEARANCES_FILE, JSON.stringify(data));
  } catch (e) {}
}

function loadFriends() {
  try {
    if (fs.existsSync(FRIENDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      if (data.friends) for (const [id, friends] of Object.entries(data.friends)) {
        friendsData.set(parseInt(id), new Set(friends));
      }
      if (data.names) for (const [id, name] of Object.entries(data.names)) {
        playerNames.set(parseInt(id), name);
      }
      if (data.nextId) nextPlayerId = data.nextId;
      console.log(`[friends] Loaded ${friendsData.size} friend lists, ${playerNames.size} names`);
    }
  } catch (e) { console.log('[friends] Load error:', e.message); }
}

function saveFriends() {
  try {
    const friends = {};
    for (const [id, set] of friendsData) friends[id] = [...set];
    const names = {};
    for (const [id, name] of playerNames) names[id] = name;
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify({ friends, names, nextId: nextPlayerId }));
  } catch (e) { console.log('[friends] Save error:', e.message); }
}

function getPlayerById(id) {
  for (const [, p] of players) if (p.id === id) return p;
  return null;
}
function getPlayerByName(name) {
  const lower = name.toLowerCase();
  for (const [, p] of players) if ((playerNames.get(p.id) || `Player ${p.id}`).toLowerCase() === lower) return p;
  return null;
}
function getFriendsList(playerId) {
  const friends = friendsData.get(playerId) || new Set();
  return [...friends].map(fid => {
    const isOnline = fid === BOT_PLAYER_ID ? discordConnected : !!getPlayerById(fid);
    return {
      id: fid,
      name: playerNames.get(fid) || `Player ${fid}`,
      online: isOnline,
      world: isOnline ? 1 : 0,
    };
  });
}
function buildOnlineList() {
  const list = [];
  for (const [, op] of players) list.push({ id: op.id, name: playerNames.get(op.id) || `Player ${op.id}` });
  if (discordConnected) list.push({ id: BOT_PLAYER_ID, name: 'AI' });
  return list;
}
function sendFriendsList(p) {
  send(p.ws, { t: 'friends', list: getFriendsList(p.id), name: playerNames.get(p.id) || `Player ${p.id}` });
}
function notifyFriendsOfStatus(playerId, online) {
  const name = playerNames.get(playerId) || `Player ${playerId}`;
  // Notify all online players who have this player as a friend
  for (const [, p] of players) {
    const pFriends = friendsData.get(p.id);
    if (pFriends && pFriends.has(playerId)) {
      sendFriendsList(p);
      if (online) sendChat(p, `${name} has logged in.`, '#22c55e');
      else sendChat(p, `${name} has logged out.`, '#888888');
    }
  }
}

// ── Seeded RNG ─────────────────────────────────────────────────────────────────
let seed = 42;
function rng() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

// ── Stub functions for plugins to override ──────────────────────────────────
// These exist so the engine doesn't crash if no plugin provides them yet.
// Plugins replace these via the engine API.
const itemDefs = new Map();
const ITEM_BY_NAME = new Map();
function itemName(id) { const d = itemDefs.get(id); return d ? d.name : `Item #${id}`; }
function findItemId(name) { const d = ITEM_BY_NAME.get(name.toLowerCase()); return d ? d.id : -1; }
function addXp(p, skill, amount) {
  if (!p.skills || !p.skills[skill]) return;
  p.skills[skill].xp += amount;
  // Level-up detection will be handled by a skills plugin
}

const EQUIP_SLOTS = ['head', 'cape', 'neck', 'weapon', 'body', 'shield', 'legs', 'hands', 'feet', 'ring', 'ammo'];
function calcEquipBonuses() { return {}; }

// ── Pathfinding (A*) ───────────────────────────────────────────────────────────
function findPath(sx, sy, tx, ty, layer = 0) {
  if (!isWalkable(tx, ty, layer)) return [];
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
      if (!isWalkable(nx, ny, layer) || closed.has(key(nx, ny))) continue;
      if (isEdgeBlocked(cur.x, cur.y, nx, ny, layer)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(cur.x + dx, cur.y, layer) || !isWalkable(cur.x, cur.y + dy, layer))) continue;
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

// ── Discord Bridge (integrated) ──────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_CHANNEL_ID = '1480654372131180635';
const DISCORD_API = 'https://discord.com/api/v10';
const POLL_INTERVAL_MS = 3000; // check for new messages every 3s

let discordConnected = false;
let lastPmToBot = null;
let pendingNpcTalk = null;
let lastSeenMessageId = null;
let discordPollTimer = null;

function postToDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).catch(e => console.error('[discord] webhook error:', e.message));
}

function initBotPlayer() {
  playerNames.set(BOT_PLAYER_ID, 'AI');
  if (!friendsData.has(BOT_PLAYER_ID)) friendsData.set(BOT_PLAYER_ID, new Set());
}

function setBotOnline(online) {
  discordConnected = online;
  if (online) {
    broadcast({ t: 'chat', msg: 'AI has connected.', color: '#7289da' });
  } else {
    broadcast({ t: 'chat', msg: 'AI has disconnected.', color: '#888' });
  }
  notifyFriendsOfStatus(BOT_PLAYER_ID, online);
  broadcast({ t: 'online_players', list: buildOnlineList() });
}

// Poll Discord channel for new messages from FUTURE BOT
async function pollDiscordMessages() {
  try {
    const url = lastSeenMessageId
      ? `${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages?after=${lastSeenMessageId}&limit=10`
      : `${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages?limit=1`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) {
      console.error(`[discord] Poll error: ${res.status}`);
      return;
    }
    const messages = await res.json();
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Messages come newest-first, reverse to process in order
    messages.reverse();

    // On first poll, just record the latest ID (don't process old messages)
    if (!lastSeenMessageId) {
      lastSeenMessageId = messages[messages.length - 1].id;
      if (!discordConnected) {
        setBotOnline(true);
        console.log('[discord] Polling active, AI online');
      }
      return;
    }

    for (const msg of messages) {
      lastSeenMessageId = msg.id;

      // Skip webhook messages (those are from us)
      if (msg.webhook_id) continue;

      const isBot = msg.author.id === DISCORD_BOT_USER_ID;
      const name = isBot ? 'AI' : msg.author.username;
      const text = (msg.content || '').trim().slice(0, 200);
      if (!text) continue;

      console.log(`[discord] → Game: ${name}: ${text}`);

      if (isBot) {
        // Route NPC talk response
        if (pendingNpcTalk) {
          const recipient = getPlayerById(pendingNpcTalk.playerId);
          if (recipient) {
            send(recipient.ws, { t: 'chat', msg: `[${pendingNpcTalk.npcName}] ${text}`, color: '#0ff' });
          }
          pendingNpcTalk = null;
          continue;
        }
        // Route PM reply
        if (lastPmToBot !== null) {
          const recipient = getPlayerById(lastPmToBot);
          if (recipient) {
            send(recipient.ws, { t: 'pm', from: BOT_PLAYER_ID, fromName: 'AI', msg: text });
          }
          continue;
        }
      }
      // Show in game chat
      broadcast({ t: 'chat', msg: `${name}: ${text}`, color: '#7289da' });
    }
  } catch (e) {
    console.error('[discord] Poll error:', e.message);
  }
}

function startDiscordPolling() {
  console.log('[discord] Starting message polling...');
  pollDiscordMessages(); // initial poll to get last message ID
  discordPollTimer = setInterval(pollDiscordMessages, POLL_INTERVAL_MS);
}
function broadcastTiles(changes, layer = 0) {
  const byChunk = new Map();
  for (const c of changes) {
    const key = `${layer}_${Math.floor(c.x / CHUNK_SIZE)}_${Math.floor(c.y / CHUNK_SIZE)}`;
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(c);
  }
  for (const [ws, p] of players) {
    if (p.layer !== layer) continue;
    const rel = [];
    for (const [key, cc] of byChunk) if (p.sentChunks.has(key)) rel.push(...cc);
    if (rel.length > 0) send(ws, { t: 'tiles', changes: rel });
  }
}
function sendChat(p, msg, color) { send(p.ws, { t: 'chat', msg, color }); }
function sendStats(p) {
  // Send inventory with names resolved for client display
  const inv = p.inventory.map(i => ({ id: i.id, name: itemName(i.id), count: i.count }));
  const equip = {};
  for (const s of EQUIP_SLOTS) {
    if (p.equipment[s] >= 0) equip[s] = { id: p.equipment[s], name: itemName(p.equipment[s]) };
  }
  send(p.ws, { t: 'stats', hp: p.hp, maxHp: p.maxHp, skills: p.skills, inv, equip, bonuses: calcEquipBonuses(p.equipment), activePrayer: p.activePrayer });
}

function addItemById(p, id, count = 1) {
  if (id < 0) return false;
  const def = itemDefs.get(id);
  const stackable = def && def.stackable;
  if (stackable) {
    const ex = p.inventory.find(i => i.id === id);
    if (ex) { ex.count += count; return true; }
  }
  if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return false; }
  if (stackable) {
    p.inventory.push({ id, count });
  } else {
    for (let i = 0; i < count; i++) {
      if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return i > 0; }
      p.inventory.push({ id, count: 1 });
    }
  }
  return true;
}

// Legacy name-based wrapper (for gathering/old code)
function addItem(p, name) {
  const id = findItemId(name);
  if (id < 0) { // fallback: add by name for items not in cache
    if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return false; }
    const ex = p.inventory.find(i => i.name === name && !i.id);
    if (ex) ex.count++; else p.inventory.push({ id: -1, name, count: 1 });
    return true;
  }
  return addItemById(p, id);
}

function dropItemGround(id, x, y, count = 1) {
  groundItems.push({ id: nextGroundItemId++, itemId: id, name: itemName(id), x, y, count, despawnTick: tick + 167 });
}
function dropItem(name, x, y) {
  const id = findItemId(name);
  groundItems.push({ id: nextGroundItemId++, itemId: id, name: id >= 0 ? itemName(id) : name, x, y, count: 1, despawnTick: tick + 167 });
}

function findCluster(tx, ty, layer = 0) {
  const t = tileAt(tx, ty, layer);
  let x0 = tx, y0 = ty;
  while (tileAt(x0 - 1, y0, layer) === t) x0--;
  while (tileAt(x0, y0 - 1, layer) === t) y0--;
  let w = 0, h = 0;
  while (tileAt(x0 + w, y0, layer) === t) w++;
  while (tileAt(x0, y0 + h, layer) === t) h++;
  return { x: x0, y: y0, w, h };
}

function walkToClusterBase(cx, cy, cw, ch, px, py, layer = 0) {
  const candidates = [];
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy + ch, layer)) candidates.push([cx + dx, cy + ch]);
  for (let dy = 0; dy < ch; dy++) {
    if (isWalkable(cx - 1, cy + dy, layer)) candidates.push([cx - 1, cy + dy]);
    if (isWalkable(cx + cw, cy + dy, layer)) candidates.push([cx + cw, cy + dy]);
  }
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy - 1, layer)) candidates.push([cx + dx, cy - 1]);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return candidates[0];
}

function walkAdjacentTo(tx, ty, px, py, layer = 0) {
  const adj = [[tx-1,ty],[tx+1,ty],[tx,ty-1],[tx,ty+1]].filter(([x,y]) => isWalkable(x,y, layer));
  if (adj.length === 0) return null;
  adj.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return adj[0];
}

// ── Bucket Fill ──────────────────────────────────────────────────────────────
function bucketFill(sx, sy, newTile, newColor, layer = 0) {
  const oldTile = tileAt(sx, sy, layer);
  const oldColor = oldTile === T.CUSTOM ? (getColor(sx, sy, layer) || '#ff00ff') : null;
  if (oldTile === newTile && (newTile !== T.CUSTOM || oldColor === newColor)) return [];
  const changes = [], stack = [{ x: sx, y: sy }], visited = new Set();
  function matches(x, y) {
    if (Math.abs(x - sx) > 100 || Math.abs(y - sy) > 100) return false;
    if (tileAt(x, y, layer) !== oldTile) return false;
    if (oldTile === T.CUSTOM) return (getColor(x, y, layer) || '#ff00ff') === oldColor;
    return true;
  }
  while (stack.length > 0 && changes.length < 5000) {
    const { x, y } = stack.pop();
    const k = `${x},${y}`;
    if (visited.has(k) || !matches(x, y)) continue;
    visited.add(k);
    const prev = tileAt(x, y, layer);
    const prevColor = prev === T.CUSTOM ? (getColor(x, y, layer) || null) : null;
    setTile(x, y, newTile, layer);
    if (newTile === T.CUSTOM && newColor) setColor(x, y, newColor, layer);
    else setColor(x, y, null, layer);
    changes.push({ x, y, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
    // Only spread to neighbors not blocked by wall/door edges
    if (!isEdgeBlocked(x, y, x+1, y, layer)) stack.push({ x: x+1, y });
    if (!isEdgeBlocked(x, y, x-1, y, layer)) stack.push({ x: x-1, y });
    if (!isEdgeBlocked(x, y, x, y+1, layer)) stack.push({ x, y: y+1 });
    if (!isEdgeBlocked(x, y, x, y-1, layer)) stack.push({ x, y: y-1 });
  }
  return changes;
}

function tileKey(x, y, layer = 0) {
  const t = tileAt(x, y, layer);
  if (t === T.CUSTOM) return 'c:' + (getColor(x, y, layer) || '#ff00ff');
  return 't:' + t;
}

function bucketAllRecolor(sx, sy, newTile, newColor, layer = 0) {
  const targetKey = tileKey(sx, sy, layer);
  const changes = [];
  for (const [key, chunk] of chunks) {
    const parts = key.split('_').map(Number);
    const [chunkLayer, cx, cy] = parts;
    if (chunkLayer !== layer) continue;
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
function sendChunkToPlayer(ws, cx, cy, layer = 0) {
  const chunk = getChunk(cx, cy, layer);
  const colorsObj = {};
  for (const [k, v] of chunk.colors) colorsObj[k] = v;
  const msg = { t: 'chunk', cx, cy, tiles: Buffer.from(chunk.tiles).toString('base64'), colors: colorsObj };
  // Attach tile variants for this chunk
  if (global.tileVariantMap) {
    const variants = {};
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = cx * CHUNK_SIZE + lx, wy = cy * CHUNK_SIZE + ly;
        const vKey = `${layer}_${wx}_${wy}`;
        const v = global.tileVariantMap.get(vKey);
        if (v > 0) variants[`${lx}_${ly}`] = v;
      }
    }
    if (Object.keys(variants).length > 0) msg.variants = variants;
  }
  send(ws, msg);
}

function updatePlayerChunks(p) {
  const pcx = Math.floor(p.x / CHUNK_SIZE), pcy = Math.floor(p.y / CHUNK_SIZE);
  for (let dx = -VIEW_DIST; dx <= VIEW_DIST; dx++) {
    for (let dy = -VIEW_DIST; dy <= VIEW_DIST; dy++) {
      const key = `${p.layer}_${pcx + dx}_${pcy + dy}`;
      if (!p.sentChunks.has(key)) {
        sendChunkToPlayer(p.ws, pcx + dx, pcy + dy, p.layer);
        p.sentChunks.add(key);
      }
    }
  }
  for (const key of p.sentChunks) {
    const parts = key.split('_').map(Number);
    const [layer, cx, cy] = parts;
    if (layer !== p.layer || Math.abs(cx - pcx) > VIEW_DIST + 2 || Math.abs(cy - pcy) > VIEW_DIST + 2) {
      p.sentChunks.delete(key);
    }
  }
}

// ── Player Factory ─────────────────────────────────────────────────────────────
function createPlayer(ws) {
  const sx = SPAWN_X;
  const sy = SPAWN_Y;
  const skills = {}; // Populated by skills plugin if loaded
  const equipment = {};
  for (const s of EQUIP_SLOTS) equipment[s] = -1;
  const pid = nextPlayerId++;
  playerNames.set(pid, `Player ${pid}`);
  if (!friendsData.has(pid)) friendsData.set(pid, new Set());
  return {
    id: pid, ws, x: sx, y: sy, prevX: sx, prevY: sy, layer: 0, hp: 99, maxHp: 99,
    gender: 'male', appearance: { ...DEFAULT_APPEARANCE }, sentChunks: new Set(),
    path: [], gathering: null, actionTick: 0,
    combatTarget: null, clickedNpc: null, pendingPickup: null, pendingTalk: null, gatherCluster: null,
    nextAttackTick: 0, attackSpeed: 4,
    autoRetaliate: true,
    activePrayer: null, // null | 'melee' | 'ranged' | 'magic'
    gearTier: 3, // 1-3, restricts equippable gear tier (self-imposed challenge mode)
    skills, equipment,
    inventory: [],
  };
}

// ── Game Tick ──────────────────────────────────────────────────────────────────
function gameTick() {
  tick++;

  // Player movement
  for (const [, p] of players) {
    p.movedThisTick = false;
    if (p.path.length > 0) {
      p.prevX = p.x; p.prevY = p.y;
      const prevCX = Math.floor(p.x / CHUNK_SIZE), prevCY = Math.floor(p.y / CHUNK_SIZE);
      const next = p.path.shift();
      p.x = next.x; p.y = next.y;
      p.movedThisTick = true;
      const newCX = Math.floor(p.x / CHUNK_SIZE), newCY = Math.floor(p.y / CHUNK_SIZE);
      if (newCX !== prevCX || newCY !== prevCY) updatePlayerChunks(p);
    }

    // Item pickup
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

  }

  // Process tick queue
  processTickQueue();

  // Respawn resources
  for (let i = respawns.length - 1; i >= 0; i--) {
    if (tick >= respawns[i].tick) {
      const r = respawns[i];
      setTile(r.x, r.y, r.tile, r.layer || 0);
      broadcastTiles([{ x: r.x, y: r.y, tile: r.tile }], r.layer || 0);
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

  // Plugin tick handlers
  for (const { id, fn } of pluginTickHandlers) {
    try { fn(tick); } catch (e) { console.error(`[plugin:${id}] tick error:`, e.message); }
  }

  // Per-player state broadcast (proximity filtered)
  if (tick % STATE_INTERVAL === 0) {
    for (const [ws, p] of players) {
      const pArr = [];
      for (const [, op] of players) {
        if (Math.abs(op.x - p.x) <= ENTITY_VIEW && Math.abs(op.y - p.y) <= ENTITY_VIEW) {
          const opa = op.appearance;
          pArr.push({ id: op.id, x: op.x, y: op.y, hp: op.hp, maxHp: op.maxHp, g: op.gender,
            a: opa ? { bt: opa.bodyType, hc: opa.hairColor, tc: opa.torsoColor, lc: opa.legsColor, fc: opa.feetColor, sc: opa.skinColor } : null,
            path: op.path.slice(0, 20) });
        }
      }
      const nArr = npcs.filter(n => !n.dead && Math.abs(n.x - p.x) <= ENTITY_VIEW && Math.abs(n.y - p.y) <= ENTITY_VIEW)
        .map(n => ({ id: n.id, x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp, name: n.name, color: n.color, atk: n.attack || 1, def: n.defence || 1, talk: true }));
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
  p.x = SPAWN_X; p.y = SPAWN_Y;
  sendChat(p, 'Oh dear, you are dead!', '#f00');
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
    case 'chat': {
      const text = (msg.msg || '').trim().slice(0, 100);
      const chatName = playerNames.get(p.id) || `Player ${p.id}`;
      if (text) {
        broadcast({ t: 'chat', msg: `${chatName}: ${text}`, color: '#0000aa' });
        // Forward to Discord webhook
        postToDiscord(`**${chatName}:** ${text}`);
      }
      break;
    }
    case 'set_name': {
      const name = (msg.name || '').trim().slice(0, 20);
      if (name.length < 1) { sendChat(p, 'Name must be at least 1 character.', '#f44'); break; }
      // Check for duplicate names
      let nameTaken = false;
      for (const [id, n] of playerNames) {
        if (n.toLowerCase() === name.toLowerCase() && id !== p.id) { nameTaken = true; break; }
      }
      if (nameTaken) { sendChat(p, 'That name is already taken.', '#f44'); break; }
      playerNames.set(p.id, name);
      sendChat(p, `Name set to: ${name}`, '#22c55e');
      sendFriendsList(p);
      // Update friends lists of anyone who has us as friend
      for (const [, op] of players) {
        const opFriends = friendsData.get(op.id);
        if (opFriends && opFriends.has(p.id)) sendFriendsList(op);
      }
      // Send updated online list to all
      broadcast({ t: 'online_players', list: buildOnlineList() });
      saveFriends();
      // Restore saved position
      const savedPos = playerPositions.get(name);
      if (savedPos) {
        p.x = savedPos.x; p.y = savedPos.y; p.layer = savedPos.layer || 0;
        p.sentChunks = new Set();
        send(ws, { t: 'move_to', x: p.x, y: p.y, layer: p.layer });
        updatePlayerChunks(p);
      }
      // Restore saved appearance
      const savedApp = playerAppearances.get(name);
      if (savedApp) {
        p.appearance = savedApp;
        p.gender = savedApp.bodyType === 'B' ? 'female' : 'male';
        send(ws, { t: 'appearance', appearance: savedApp });
      } else {
        // No saved appearance — character creation handles this
        send(ws, { t: 'appearance', appearance: DEFAULT_APPEARANCE });
      }
      break;
    }
    case 'friend_add': {
      const targetName = (msg.name || '').trim();
      if (!targetName) break;
      // Find by name first, then by ID
      let target = getPlayerByName(targetName);
      if (!target && /^\d+$/.test(targetName)) target = getPlayerById(parseInt(targetName));
      // Allow adding by name even if offline (check playerNames)
      let targetId = null;
      if (target) {
        targetId = target.id;
      } else {
        // Search playerNames for offline match
        for (const [id, name] of playerNames) {
          if (name.toLowerCase() === targetName.toLowerCase()) { targetId = id; break; }
        }
      }
      if (targetId === null) { sendChat(p, `Player "${targetName}" not found.`, '#f44'); break; }
      // if (targetId === p.id) { sendChat(p, "You can't add yourself.", '#f44'); break; }
      const myFriends = friendsData.get(p.id);
      if (myFriends.has(targetId)) { sendChat(p, `Already on your friends list.`, '#f44'); break; }
      myFriends.add(targetId);
      const friendName = playerNames.get(targetId) || `Player ${targetId}`;
      sendChat(p, `Added ${friendName} to friends list.`, '#22c55e');
      sendFriendsList(p);
      saveFriends();
      break;
    }
    case 'friend_remove': {
      const rid = msg.id;
      const myFriends = friendsData.get(p.id);
      if (!myFriends || !myFriends.has(rid)) break;
      myFriends.delete(rid);
      const removedName = playerNames.get(rid) || `Player ${rid}`;
      sendChat(p, `Removed ${removedName} from friends list.`, '#ff981f');
      sendFriendsList(p);
      saveFriends();
      break;
    }
    case 'pm': {
      const targetId = msg.to;
      const text = (msg.msg || '').trim().slice(0, 200);
      if (!text) break;
      const myName = playerNames.get(p.id) || `Player ${p.id}`;
      const targetName = playerNames.get(targetId) || `Player ${targetId}`;

      // If PMing the AI bot, forward to Discord
      if (targetId === BOT_PLAYER_ID) {
        if (!discordConnected) { sendChat(p, 'AI is not online.', '#f44'); break; }
        postToDiscord(`**[PM from ${myName}]:** ${text}`);
        lastPmToBot = p.id;
        send(p.ws, { t: 'pm_sent', to: targetId, toName: 'AI', msg: text });
        break;
      }

      const target = getPlayerById(targetId);
      if (!target) { sendChat(p, `${targetName} is not online.`, '#f44'); break; }
      send(target.ws, { t: 'pm', from: p.id, fromName: myName, msg: text });
      send(p.ws, { t: 'pm_sent', to: targetId, toName: targetName, msg: text });
      break;
    }
    case 'move': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) > 200) { sendChat(p, 'Too far!', '#f44'); return; }
      p.gathering = null; p.clickedNpc = null;
      if (p.combatTarget !== null) {
        cancelScheduled(`patk:${p.id}`);
        p.combatTarget = null; // clicking to move always disengages
      }
      if (isWalkable(tx, ty, p.layer)) { p.path = findPath(p.x, p.y, tx, ty, p.layer); }
      else { sendChat(p, "I can't reach that.", '#f44'); }
      break;
    }
    case 'teleport': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      p.x = tx; p.y = ty; p.prevX = tx; p.prevY = ty;
      p.path = []; p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      if (msg.layer !== undefined) { p.layer = Math.floor(msg.layer); }
      p.sentChunks = new Set();
      updatePlayerChunks(p);
      break;
    }
    case 'gender': { p.gender = msg.v === 'female' ? 'female' : 'male'; break; }
    case 'set_appearance': {
      const a = msg.appearance;
      if (!a || typeof a !== 'object') break;
      const app = { ...DEFAULT_APPEARANCE };
      app.bodyType = a.bodyType === 'B' ? 'B' : 'A';
      app.head = Math.max(0, Math.min(8, parseInt(a.head) || 0));
      app.jaw = Math.max(0, Math.min(7, parseInt(a.jaw) || 0));
      app.torso = Math.max(0, Math.min(19, parseInt(a.torso) || 0));
      app.arms = Math.max(0, Math.min(16, parseInt(a.arms) || 0));
      app.hands = Math.max(0, Math.min(1, parseInt(a.hands) || 0));
      app.legs = Math.max(0, Math.min(21, parseInt(a.legs) || 0));
      app.feet = Math.max(0, Math.min(1, parseInt(a.feet) || 0));
      // Validate colors are hex strings
      const hexRe = /^#[0-9a-fA-F]{6}$/;
      if (hexRe.test(a.hairColor)) app.hairColor = a.hairColor;
      if (hexRe.test(a.torsoColor)) app.torsoColor = a.torsoColor;
      if (hexRe.test(a.legsColor)) app.legsColor = a.legsColor;
      if (hexRe.test(a.feetColor)) app.feetColor = a.feetColor;
      if (hexRe.test(a.skinColor)) app.skinColor = a.skinColor;
      p.appearance = app;
      p.gender = app.bodyType === 'B' ? 'female' : 'male';
      const name = playerNames.get(p.id);
      if (name) { playerAppearances.set(name, app); saveAppearances(); }
      sendChat(p, 'Appearance updated!', '#22c55e');
      break;
    }
    case 'door': {
      const dx = Math.floor(msg.x), dy = Math.floor(msg.y);
      if (Math.abs(p.x - dx) > 1 || Math.abs(p.y - dy) > 1) {
        sendChat(p, 'You need to be next to the door.', '#f44'); return;
      }
      const dk = `${dx},${dy}`;
      const tile = tileAt(dx, dy, p.layer);
      if (tile === T.DOOR) {
        let sx = dx, sy = dy;
        for (const [ndx, ndy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          if (tileAt(dx + ndx, dy + ndy, p.layer) === T.FLOOR) { sx = dx + ndx; sy = dy + ndy; break; }
        }
        openDoors.set(dk, { ox: dx, oy: dy, sx, sy });
        setTile(dx, dy, T.FLOOR, p.layer);
        broadcastTiles([{ x: dx, y: dy, tile: T.FLOOR }], p.layer);
        sendChat(p, 'You open the door.', '#ccc');
      } else {
        for (const [key, d] of openDoors) {
          if ((dx === d.ox && dy === d.oy) || (dx === d.sx && dy === d.sy)) {
            if (Math.abs(p.x - d.ox) > 1 || Math.abs(p.y - d.oy) > 1) {
              sendChat(p, 'You need to be next to the door.', '#f44'); return;
            }
            openDoors.delete(key);
            setTile(d.ox, d.oy, T.DOOR, p.layer);
            broadcastTiles([{ x: d.ox, y: d.oy, tile: T.DOOR }], p.layer);
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
        p.path = findPath(p.x, p.y, gi.x, gi.y, p.layer);
        p.pendingPickup = gid;
      }
      break;
    }
    case 'half_paint': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      // Broadcast to players on same layer
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'half_paint', x, y, side: msg.side, tile: msg.tile, color: msg.color });
      }
      break;
    }
    case 'door_toggle': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const side = Math.floor(msg.side) & 0xF;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      // Toggle open state on server — open doors don't block
      const key = `${p.layer}_${x}_${y}`;
      const curOpen = serverOpenDoors.get(key) || 0;
      const newOpen = curOpen ^ side;
      if (newOpen === 0) serverOpenDoors.delete(key);
      else serverOpenDoors.set(key, newOpen);
      // Broadcast to players on same layer
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'door_toggle', x, y, side, open: !!(newOpen & side) });
      }
      break;
    }
    case 'door_edge': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const mask = Math.floor(msg.mask) & 0xF;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      if (mask === 0) serverDoorEdges.delete(`${p.layer}_${x}_${y}`);
      else serverDoorEdges.set(`${p.layer}_${x}_${y}`, mask);
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'door_edge', x, y, mask });
      }
      break;
    }
    case 'set_height': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const h = parseFloat(msg.h) || 0;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      const key = `${p.layer}_${x}_${y}`;
      if (h === 0) serverTileHeights.delete(key);
      else serverTileHeights.set(key, h);
      for (const [ws2] of players) send(ws2, { t: 'set_height', x, y, h, layer: p.layer });
      break;
    }
    case 'wall_edge': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const mask = Math.floor(msg.mask) & 0x3F;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      if (mask === 0) { serverWallEdges.delete(`${p.layer}_${x}_${y}`); serverWallTexMap.delete(`${p.layer}_${x}_${y}`); }
      else serverWallEdges.set(`${p.layer}_${x}_${y}`, mask);
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'wall_edge', x, y, mask });
      }
      break;
    }
    case 'wall_tex': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tex = String(msg.tex || '6_0');
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      serverWallTexMap.set(`${p.layer}_${x}_${y}`, tex);
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'wall_tex', x, y, tex });
      }
      break;
    }
    case 'place_roof': {
      const roof = msg.roof;
      if (!roof) break;
      roof.id = serverNextRoofId++;
      roof.layer = p.layer;
      const key = `${roof.layer}_${roof.id}`;
      serverRoofs.set(key, roof);
      for (const [ws2] of players) send(ws2, { t: 'place_roof', roof });
      break;
    }
    case 'update_roof': {
      const roof = msg.roof;
      if (!roof) break;
      const key = `${roof.layer}_${roof.id}`;
      if (!serverRoofs.has(key)) break;
      serverRoofs.set(key, roof);
      for (const [ws2] of players) send(ws2, { t: 'update_roof', roof });
      break;
    }
    case 'delete_roof': {
      const key = `${msg.layer}_${msg.id}`;
      serverRoofs.delete(key);
      for (const [ws2] of players) send(ws2, { t: 'delete_roof', layer: msg.layer, id: msg.id });
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
        const variant = Math.floor(t.variant || 0);
        setTile(x, y, tile, p.layer);
        if (tile === T.CUSTOM && t.color) setColor(x, y, String(t.color).slice(0, 7), p.layer);
        else setColor(x, y, null, p.layer);
        // Store variant
        const vKey = `${p.layer}_${x}_${y}`;
        if (!global.tileVariantMap) global.tileVariantMap = new Map();
        if (variant > 0) global.tileVariantMap.set(vKey, variant);
        else global.tileVariantMap.delete(vKey);
        changes.push({ x, y, tile, color: t.color || null, variant });
      }
      if (changes.length > 0) broadcastTiles(changes, p.layer);
      break;
    }
    case 'bucket': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const variant = Math.floor(msg.variant || 0);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketFill(x, y, tile, msg.color || null, p.layer);
      if (changes.length > 0) {
        for (const c of changes) {
          const vKey = `${p.layer}_${c.x}_${c.y}`;
          c.prevVariant = global.tileVariantMap.get(vKey) || 0;
          if (variant > 0) global.tileVariantMap.set(vKey, variant);
          else global.tileVariantMap.delete(vKey);
        }
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color, variant })), p.layer);
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor, variant: c.prevVariant })) });
      }
      break;
    }
    case 'bucket_all': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const variant = Math.floor(msg.variant || 0);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketAllRecolor(x, y, tile, msg.color || null, p.layer);
      if (changes.length > 0) {
        for (const c of changes) {
          const vKey = `${p.layer}_${c.x}_${c.y}`;
          c.prevVariant = global.tileVariantMap.get(vKey) || 0;
          if (variant > 0) global.tileVariantMap.set(vKey, variant);
          else global.tileVariantMap.delete(vKey);
        }
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color, variant })), p.layer);
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor, variant: c.prevVariant })) });
        sendChat(p, `Recolored ${changes.length} tiles globally.`, '#ff981f');
      }
      break;
    }
    case 'bucket_new': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const variant = Math.floor(msg.variant || 0);
      const name = String(msg.name || '').slice(0, 30);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM || !name) return;
      const newNameKey = tile === T.CUSTOM && msg.color ? 'c:' + msg.color : 't:' + tile;
      customNames.set(newNameKey, name);
      const changes = bucketAllRecolor(x, y, tile, msg.color || null, p.layer);
      if (changes.length > 0) {
        for (const c of changes) {
          const vKey = `${p.layer}_${c.x}_${c.y}`;
          c.prevVariant = global.tileVariantMap.get(vKey) || 0;
          if (variant > 0) global.tileVariantMap.set(vKey, variant);
          else global.tileVariantMap.delete(vKey);
        }
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color, variant })), p.layer);
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor, variant: c.prevVariant })) });
      }
      const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
      broadcast({ t: 'names', names: namesObj });
      sendChat(p, `Renamed ${changes.length} tiles to "${name}".`, '#ff981f');
      break;
    }
    case 'set_layer': {
      const layer = Math.floor(msg.layer);
      if (layer < -1000 || layer > 1000 || isNaN(layer)) break;
      p.layer = layer;
      p.sentChunks = new Set();
      updatePlayerChunks(p);
      sendChat(p, `Layer: ${layer}`, '#ff981f');
      break;
    }
    case 'create_lot': {
      const name = (msg.name || 'Unnamed Lot').slice(0, 50);
      const tiles = msg.tiles;
      if (!Array.isArray(tiles) || tiles.length === 0 || tiles.length > 50000) break;
      const color = msg.color || '#3a7';
      const layer = p.layer;
      // Calculate center for teleport
      let sx = 0, sy = 0;
      for (const t of tiles) { sx += t.x; sy += t.y; }
      const cx = Math.round(sx / tiles.length), cy = Math.round(sy / tiles.length);
      const id = serverNextLotId++;
      const lot = { id, name, layer, tiles, color, cx, cy };
      serverLots.set(String(id), lot);
      broadcast({ t: 'lot_created', lot });
      sendChat(p, `Lot "${name}" created (${tiles.length} tiles)`, '#3a7');
      break;
    }
    case 'update_lot': {
      const lot = serverLots.get(String(msg.id));
      if (!lot) break;
      if (msg.name !== undefined) lot.name = String(msg.name).slice(0, 50);
      if (msg.color !== undefined) lot.color = msg.color;
      serverLots.set(String(lot.id), lot);
      broadcast({ t: 'lot_updated', lot });
      break;
    }
    case 'delete_lot': {
      const id = String(msg.id);
      if (!serverLots.has(id)) break;
      serverLots.delete(id);
      broadcast({ t: 'lot_deleted', id: msg.id });
      sendChat(p, `Lot deleted`, '#f44');
      break;
    }
    default: {
      // Route to plugin message handlers
      const handlers = pluginMessageHandlers.get(msg.t);
      if (handlers) for (const h of handlers) try { h(p, msg); } catch(e) { console.error(`[plugin:msg] ${msg.t}:`, e.message); }
      break;
    }
  }
}

// ── Plugin System ───────────────────────────────────────────────────────────
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const PLUGIN_DATA_DIR = path.join(DATA_DIR, 'plugins');
const pluginConfig = fs.existsSync(path.join(PLUGINS_DIR, 'plugins.json'))
  ? JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'plugins.json'), 'utf8'))
  : { plugins: [] };
const loadedPlugins = new Map();
const pluginTickHandlers = [];
const pluginMessageHandlers = new Map();
const pluginSaveHandlers = [];
const pluginEventHandlers = new Map();

const serverEngine = {
  side: 'server',
  TICK_MS, CHUNK_SIZE, T,
  // World
  tileAt: (x, y, layer) => tileAt(x, y, layer || 0),
  setTile, getColor, setColor, isWalkable, isEdgeBlocked,
  getWallEdge: (x, y, layer) => { const k = `${layer||0}_${x}_${y}`; return serverWallEdges.get(k) || 0; },
  setWallEdge: (x, y, mask, layer) => { const k = `${layer||0}_${x}_${y}`; if (mask === 0) serverWallEdges.delete(k); else serverWallEdges.set(k, mask); },
  getDoorEdge: (x, y, layer) => { const k = `${layer||0}_${x}_${y}`; return serverDoorEdges.get(k) || 0; },
  setDoorEdge: (x, y, mask, layer) => { const k = `${layer||0}_${x}_${y}`; if (mask === 0) serverDoorEdges.delete(k); else serverDoorEdges.set(k, mask); },
  getTileHeight: (x, y, layer) => serverTileHeights.get(`${layer||0}_${x}_${y}`) || 0,
  setTileHeight: (x, y, h, layer) => { const k = `${layer||0}_${x}_${y}`; if (h === 0) serverTileHeights.delete(k); else serverTileHeights.set(k, h); },
  getVariant: (x, y, layer) => { const k = `${layer||0}_${x}_${y}`; return global.tileVariantMap ? (global.tileVariantMap.get(k) || 0) : 0; },
  setVariant: (x, y, v, layer) => { if (global.tileVariantMap) { const k = `${layer||0}_${x}_${y}`; if (v === 0) global.tileVariantMap.delete(k); else global.tileVariantMap.set(k, v); } },
  // Pathfinding
  findPath,
  // Tick
  getTick: () => tick,
  schedule, cancelScheduled,
  onTick(id, fn) { pluginTickHandlers.push({ id, fn }); },
  offTick(id) { const i = pluginTickHandlers.findIndex(h => h.id === id); if (i >= 0) pluginTickHandlers.splice(i, 1); },
  // Players
  getPlayer(id) { for (const [, p] of players) if (p.id === id) return p; return null; },
  forEachPlayer(fn) { for (const [, p] of players) fn(p); },
  send(p, msg) { send(p.ws, msg); },
  sendChat(p, text, color) { sendChat(p, text, color); },
  broadcast,
  broadcastTiles,
  // Messages
  onMessage(type, handler) {
    if (!pluginMessageHandlers.has(type)) pluginMessageHandlers.set(type, []);
    pluginMessageHandlers.get(type).push(handler);
  },
  // Skills/Items (proxies to existing functions)
  addXp, getSkillLevel: (p, skill) => p.skills[skill] ? p.skills[skill].level : 1,
  addItem, addItemById, dropItemGround, itemName, findItemId,
  // Data persistence
  loadData(id) {
    const fp = path.join(PLUGIN_DATA_DIR, `${id}.json`);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    return {};
  },
  saveData(id, data) {
    fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_DATA_DIR, `${id}.json`), JSON.stringify(data));
  },
  onSave(id, fn) { pluginSaveHandlers.push({ id, fn }); },
  // Dependencies
  require(id) {
    const p = loadedPlugins.get(id);
    if (!p) throw new Error(`Plugin "${id}" not loaded`);
    return p.api;
  },
  // Events
  on(event, handler) {
    if (!pluginEventHandlers.has(event)) pluginEventHandlers.set(event, []);
    pluginEventHandlers.get(event).push(handler);
  },
  emit(event, ...args) {
    const handlers = pluginEventHandlers.get(event);
    if (handlers) for (const h of handlers) try { h(...args); } catch(e) { console.error(`[plugin:event] ${event}:`, e.message); }
  },
};

function loadServerPlugins() {
  fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  for (const id of pluginConfig.plugins) {
    const pluginPath = path.join(PLUGINS_DIR, id, 'plugin.js');
    if (!fs.existsSync(pluginPath)) { console.warn(`[plugin] Not found: ${id}`); continue; }
    try {
      const plugin = require(pluginPath);
      for (const dep of (plugin.meta.depends || [])) {
        if (!loadedPlugins.has(dep)) throw new Error(`Missing dependency: ${dep}`);
      }
      if (plugin.server && plugin.server.init) plugin.server.init(serverEngine);
      loadedPlugins.set(id, { meta: plugin.meta, api: (plugin.server && plugin.server.api) || {} });
      console.log(`[plugin] Loaded: ${plugin.meta.name}`);
    } catch (e) { console.error(`[plugin] Error loading ${id}:`, e.message); }
  }
}

function generatePluginScripts() {
  return pluginConfig.plugins
    .map(id => `<script src="/plugins/${id}/plugin.js"></script>`)
    .join('\n');
}

function savePluginData() {
  for (const { id, fn } of pluginSaveHandlers) {
    try { fn(); } catch (e) { console.error(`[plugin:${id}] save error:`, e.message); }
  }
}

function injectPlugins(html) {
  const scripts = generatePluginScripts();
  return html.replace('<!-- PLUGIN_SCRIPTS -->', scripts);
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const clientPath = path.join(__dirname, 'client.html');
const launcherPath = path.join(__dirname, 'launcher.html');
const server = http.createServer((req, res) => {

  // Serve static files (lib/, assets/, plugins/)
  if (req.url.startsWith('/lib/') || req.url.startsWith('/assets/') || req.url.startsWith('/plugins/')) {
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(filePath));
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // API: auto-login with name parameter
  if (req.url.startsWith('/play?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const name = params.get('name');
    let html = injectPlugins(fs.readFileSync(clientPath, 'utf8'));
    if (name) {
      html = html.replace('<head>', `<head><script>window.autoLoginName = "${name.replace(/"/g, '')}";</script>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }
  if (req.url === '/play' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(injectPlugins(fs.readFileSync(clientPath, 'utf8')));
    return;
  }
});

// ── WebSocket Server ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const p = createPlayer(ws);
  players.set(ws, p);
  console.log(`[join] Player ${p.id} at (${p.x}, ${p.y}) (${players.size} online)`);

  const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
  const pName = playerNames.get(p.id) || `Player ${p.id}`;
  send(ws, { t: 'welcome', id: p.id, x: p.x, y: p.y, layer: p.layer, customNames: namesObj, chunkSize: CHUNK_SIZE, name: pName });
  updatePlayerChunks(p);
  // Send all wall/door data to client
  const allWalls = {}; for (const [k, v] of serverWallEdges) allWalls[k] = v;
  const allDoors = {}; for (const [k, v] of serverDoorEdges) allDoors[k] = v;
  const allHeights = {}; for (const [k, v] of serverTileHeights) allHeights[k] = v;
  const allRoofs = {}; for (const [k, v] of serverRoofs) allRoofs[k] = v;
  const allWallTex = {}; for (const [k, v] of serverWallTexMap) allWallTex[k] = v;
  const allLots = []; for (const [, v] of serverLots) allLots.push(v);
  send(ws, { t: 'all_edges', walls: allWalls, doors: allDoors, heights: allHeights, roofs: allRoofs, wallTextures: allWallTex, lots: allLots });
  sendStats(p);
  sendFriendsList(p);
  sendChat(p, `Welcome to OpenScape! ${players.size} player(s) online.`, '#ff981f');
  broadcast({ t: 'chat', msg: `${pName} has joined.`, color: '#0ff' });
  notifyFriendsOfStatus(p.id, true);

  // Broadcast online players list to all (including new player)
  broadcast({ t: 'online_players', list: buildOnlineList() });

  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => {
    players.delete(ws);
    const leaveName = playerNames.get(p.id) || `Player ${p.id}`;
    broadcast({ t: 'chat', msg: `${leaveName} has left.`, color: '#888' });
    notifyFriendsOfStatus(p.id, false);
    // Update online list for remaining players
    broadcast({ t: 'online_players', list: buildOnlineList() });
    // Save position on disconnect
    const name = playerNames.get(p.id);
    if (name) {
      playerPositions.set(name, { x: p.x, y: p.y, layer: p.layer });
      if (p.appearance) playerAppearances.set(name, p.appearance);
    }
    savePositions();
    saveAppearances();
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
loadFriends();
loadWalls();
loadLots();
loadVariants();
loadPositions();
loadAppearances();
initBotPlayer();
loadServerPlugins();

// Create a small grass island at spawn so the player can stand
for (let dx = -3; dx <= 3; dx++) {
  for (let dy = -3; dy <= 3; dy++) {
    setTile(SPAWN_X + dx, SPAWN_Y + dy, T.GRASS);
  }
}

setInterval(gameTick, TICK_MS);
setInterval(saveAllChunks, SAVE_INTERVAL_MS);
setInterval(saveFriends, SAVE_INTERVAL_MS);
setInterval(saveWalls, SAVE_INTERVAL_MS);
setInterval(saveVariants, SAVE_INTERVAL_MS);
setInterval(saveLots, SAVE_INTERVAL_MS);
setInterval(savePluginData, SAVE_INTERVAL_MS);
process.on('SIGINT', () => { saveAllChunks(); saveFriends(); saveWalls(); saveLots(); saveVariants(); savePositions(); saveAppearances(); savePluginData(); process.exit(); });
process.on('SIGTERM', () => { saveAllChunks(); saveFriends(); saveWalls(); saveLots(); saveVariants(); savePositions(); saveAppearances(); savePluginData(); process.exit(); });

server.listen(PORT, () => {
  console.log(`[server] OpenScape running on http://localhost:${PORT}`);
  console.log(`[server] Chunk-based world (${CHUNK_SIZE}x${CHUNK_SIZE} chunks, view=${VIEW_DIST})`);
  console.log(`[server] Spawn: (${SPAWN_X}, ${SPAWN_Y})`);
  // Start Discord message polling
  startDiscordPolling();
});
