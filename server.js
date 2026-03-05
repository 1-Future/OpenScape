const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Constants ──────────────────────────────────────────────────────────────────
const PORT = 2222;
const WORLD_W = 200, WORLD_H = 200;
const TICK_MS = 600;             // OSRS game tick: 0.6 seconds
const STATE_INTERVAL = 1;        // broadcast entities every tick
const SAVE_INTERVAL_MS = 30000;  // save world every 30s
const DATA_DIR = path.join(__dirname, 'data');
const WORLD_FILE = path.join(DATA_DIR, 'world.bin');
const COLORS_FILE = path.join(DATA_DIR, 'colors.json');
const NAMES_FILE = path.join(DATA_DIR, 'names.json');

const T = {
  GRASS: 0, WATER: 1, TREE: 2, PATH: 3, ROCK: 4, SAND: 5, WALL: 6,
  FLOOR: 7, DOOR: 8, BRIDGE: 9, FISH_SPOT: 10, FLOWER: 11, BUSH: 12,
  DARK_GRASS: 13, CUSTOM: 14
};

// ── World State ────────────────────────────────────────────────────────────────
let world = new Uint8Array(WORLD_W * WORLD_H);
let customColors = new Map(); // key (y*W+x) -> hex string
let customNames = new Map();  // key (tile type or "custom:hexcolor") -> display name
let players = new Map();      // ws -> player object
let npcs = [];
let respawns = [];
let groundItems = [];         // {id, name, x, y, despawnTick}
let openDoors = new Map();    // origKey -> {ox, oy, sx, sy} (original pos + swung-into pos)
let nextGroundItemId = 1;
let tick = 0;
let nextPlayerId = 1;

function tileAt(x, y) {
  return (x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H) ? world[y * WORLD_W + x] : T.WATER;
}
function setTile(x, y, t) {
  if (x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H) world[y * WORLD_W + x] = t;
}
function isWalkable(x, y) {
  const t = tileAt(x, y);
  return t !== T.WATER && t !== T.TREE && t !== T.ROCK && t !== T.WALL && t !== T.BUSH && t !== T.DOOR;
}

// ── Seeded RNG ─────────────────────────────────────────────────────────────────
let seed = 42;
function rng() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

// ── World Generation ───────────────────────────────────────────────────────────
function noise2d(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}
function smoothNoise(x, y, s) {
  const ix = Math.floor(x / s), iy = Math.floor(y / s);
  const fx = x / s - ix, fy = y / s - iy;
  const a = noise2d(ix, iy), b = noise2d(ix + 1, iy);
  const c = noise2d(ix, iy + 1), d = noise2d(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function generateWorld() {
  // Blank map — all grass. Use OSRS map overlay (M) as reference to build.
  for (let y = 0; y < WORLD_H; y++)
    for (let x = 0; x < WORLD_W; x++)
      setTile(x, y, T.GRASS);
}

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

function spawnNpcs() {
  // No NPCs on blank map — will be placed manually
}

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
  const key = (x, y) => y * WORLD_W + x;
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
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
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
  for (const [ws] of players) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
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
  groundItems.push({ id: nextGroundItemId++, name, x, y, despawnTick: tick + 167 }); // ~100s
}

// Find bounding box of a connected tile cluster (trees, rocks)
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

// Find nearest walkable tile adjacent to a cluster's base (bottom edge)
function walkToClusterBase(cx, cy, cw, ch, px, py) {
  // Try all tiles adjacent to the bottom edge first, then sides
  const candidates = [];
  // Bottom edge + 1 tile below
  for (let dx = 0; dx < cw; dx++) {
    if (isWalkable(cx + dx, cy + ch)) candidates.push([cx + dx, cy + ch]);
  }
  // Left and right sides
  for (let dy = 0; dy < ch; dy++) {
    if (isWalkable(cx - 1, cy + dy)) candidates.push([cx - 1, cy + dy]);
    if (isWalkable(cx + cw, cy + dy)) candidates.push([cx + cw, cy + dy]);
  }
  // Top edge
  for (let dx = 0; dx < cw; dx++) {
    if (isWalkable(cx + dx, cy - 1)) candidates.push([cx + dx, cy - 1]);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return candidates[0];
}

function walkAdjacentTo(tx, ty, px, py) {
  const adj = [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]].filter(([x, y]) => isWalkable(x, y));
  if (adj.length === 0) return null;
  adj.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return adj[0];
}

// ── Paint: Bucket Fill ─────────────────────────────────────────────────────────
function bucketFill(sx, sy, newTile, newColor) {
  const oldTile = tileAt(sx, sy);
  const oldColor = oldTile === T.CUSTOM ? (customColors.get(sy * WORLD_W + sx) || '#ff00ff') : null;
  if (oldTile === newTile && (newTile !== T.CUSTOM || oldColor === newColor)) return [];
  const changes = [];
  const stack = [{ x: sx, y: sy }];
  const visited = new Set();
  const key = (x, y) => y * WORLD_W + x;
  function matches(x, y) {
    if (tileAt(x, y) !== oldTile) return false;
    if (oldTile === T.CUSTOM) return (customColors.get(y * WORLD_W + x) || '#ff00ff') === oldColor;
    return true;
  }
  while (stack.length > 0 && changes.length < 5000) {
    const { x, y } = stack.pop();
    const k = key(x, y);
    if (visited.has(k) || x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H || !matches(x, y)) continue;
    visited.add(k);
    const prev = tileAt(x, y);
    const prevColor = prev === T.CUSTOM ? (customColors.get(k) || null) : null;
    setTile(x, y, newTile);
    if (newTile === T.CUSTOM && newColor) customColors.set(k, newColor);
    else if (newTile !== T.CUSTOM) customColors.delete(k);
    changes.push({ x, y, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
  return changes;
}

// ── Bucket All: recolor every matching tile in the world ────────────────────────
function tileKey(x, y) {
  const t = tileAt(x, y);
  if (t === T.CUSTOM) return 'c:' + (customColors.get(y * WORLD_W + x) || '#ff00ff');
  return 't:' + t;
}

function bucketAllRecolor(sx, sy, newTile, newColor) {
  const targetKey = tileKey(sx, sy);
  const changes = [];
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (tileKey(x, y) !== targetKey) continue;
      const k = y * WORLD_W + x;
      const prev = world[k];
      const prevColor = prev === T.CUSTOM ? (customColors.get(k) || null) : null;
      setTile(x, y, newTile);
      if (newTile === T.CUSTOM && newColor) customColors.set(k, newColor);
      else if (newTile !== T.CUSTOM) customColors.delete(k);
      changes.push({ x, y, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
    }
  }
  return changes;
}

// ── Persistence ────────────────────────────────────────────────────────────────
function saveWorld() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WORLD_FILE, Buffer.from(world));
  const colorsObj = {};
  for (const [k, v] of customColors) colorsObj[k] = v;
  fs.writeFileSync(COLORS_FILE, JSON.stringify(colorsObj));
  const namesObj = {};
  for (const [k, v] of customNames) namesObj[k] = v;
  fs.writeFileSync(NAMES_FILE, JSON.stringify(namesObj));
  console.log(`[save] World saved (${customColors.size} custom colors, ${customNames.size} custom names)`);
}

function loadWorld() {
  if (fs.existsSync(WORLD_FILE)) {
    const buf = fs.readFileSync(WORLD_FILE);
    world.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    console.log('[load] World loaded from disk');
    if (fs.existsSync(COLORS_FILE)) {
      const obj = JSON.parse(fs.readFileSync(COLORS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(obj)) customColors.set(parseInt(k), v);
      console.log(`[load] ${customColors.size} custom colors loaded`);
    }
    if (fs.existsSync(NAMES_FILE)) {
      const obj = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
      for (const [k, v] of Object.entries(obj)) customNames.set(k, v);
      console.log(`[load] ${customNames.size} custom names loaded`);
    }
    return true;
  }
  return false;
}

// ── Player Factory ─────────────────────────────────────────────────────────────
function createPlayer(ws) {
  // Find walkable spawn near center
  let sx = 100, sy = 100;
  for (let r = 0; r < 50; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (isWalkable(100 + dx, 100 + dy)) { sx = 100 + dx; sy = 100 + dy; r = 999; dx = 999; break; }

  return {
    id: nextPlayerId++, ws, x: sx, y: sy, hp: 10, maxHp: 10,
    gender: 'male',
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
    // Move along path
    if (p.path.length > 0) { // 1 tile per tick (walking speed)
      const next = p.path.shift();
      p.x = next.x; p.y = next.y;
    }

    // Pending pickup
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

    // Gathering
    if (p.gathering && p.path.length === 0) {
      const g = p.gathering;
      // Check if adjacent to any tile in the cluster (or the single tile)
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
        if (p.actionTick >= 4) { // 4 ticks = chance roll
          p.actionTick = 0;
          if (g.type === 'woodcutting') {
            // Chance scales with level: ~30% at lv1, ~70% at lv99
            const wcChance = Math.min(0.9, 0.25 + p.skills.woodcutting.level * 0.005);
            if (rng() >= wcChance) { sendChat(p, 'You swing at the tree...', '#ccc'); }
            else if (addItem(p, 'Logs')) {
              addXp(p, 'woodcutting', 25);
              sendChat(p, 'You chop down the tree.', '#ff0');
              // Remove entire tree cluster
              const cl = p.gatherCluster || { x: g.tx, y: g.ty, w: 1, h: 1 };
              const changes = [];
              for (let dy = 0; dy < cl.h; dy++)
                for (let dx = 0; dx < cl.w; dx++) {
                  setTile(cl.x + dx, cl.y + dy, T.GRASS);
                  changes.push({ x: cl.x + dx, y: cl.y + dy, tile: T.GRASS });
                  respawns.push({ x: cl.x + dx, y: cl.y + dy, tile: T.TREE, tick: tick + 25 });
                }
              broadcast({ t: 'tiles', changes });
              p.gathering = null;
              p.gatherCluster = null;
            }
          } else if (g.type === 'mining') {
            const mineChance = Math.min(0.9, 0.25 + p.skills.mining.level * 0.005);
            if (rng() >= mineChance) { sendChat(p, 'You swing at the rock...', '#ccc'); }
            else if (addItem(p, 'Ore')) {
              addXp(p, 'mining', 30);
              sendChat(p, 'You mine some ore.', '#ff0');
              setTile(g.tx, g.ty, T.GRASS);
              broadcast({ t: 'tiles', changes: [{ x: g.tx, y: g.ty, tile: T.GRASS }] });
              respawns.push({ x: g.tx, y: g.ty, tile: T.ROCK, tick: tick + 33 }); // ~20s
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
      } else {
        p.gathering = null;
      }
    }

    // Combat init from click
    if (p.clickedNpc !== null && p.path.length === 0) {
      const npc = npcs[p.clickedNpc];
      if (npc && !npc.dead && Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y) <= 1) {
        p.combatTarget = p.clickedNpc;
        p.clickedNpc = null;
      }
    }

    // Combat (RS-style formulas)
    if (p.combatTarget !== null) {
      const npc = npcs[p.combatTarget];
      if (!npc || npc.dead || Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y) > 2) {
        p.combatTarget = null;
      } else if (tick % 4 === 0) { // 4 ticks = 2.4s (scimitar speed)
        // Player attacks: hit chance = 0.4 + attack*0.03 - npcDef*0.02
        const hitChance = Math.max(0.1, Math.min(0.95, 0.4 + p.skills.attack.level * 0.03 - (npc.defence || 1) * 0.02));
        const maxHit = Math.max(1, p.skills.strength.level + 1);
        if (rng() < hitChance) {
          const dmg = Math.floor(rng() * maxHit) + 1;
          npc.hp -= dmg;
          sendChat(p, `You hit ${npc.name} for ${dmg}`, '#f44');
          addXp(p, 'attack', Math.ceil(dmg * 2));
          addXp(p, 'strength', Math.ceil(dmg * 2));
        } else {
          sendChat(p, `You miss ${npc.name}`, '#f44');
        }
        if (npc.hp <= 0) {
          npc.dead = true; npc.respawnTick = tick + 17; // ~10s
          addXp(p, 'hitpoints', Math.ceil(npc.xp * 0.33));
          sendChat(p, `You killed ${npc.name}!`, '#0f0');
          for (const drop of npc.drops) { if (rng() > 0.3) dropItem(drop, npc.x, npc.y); }
          p.combatTarget = null;
        } else {
          // NPC retaliates
          const npcHitChance = Math.max(0.05, Math.min(0.9, 0.3 + (npc.attack || 1) * 0.03 - p.skills.defence.level * 0.02));
          if (rng() < npcHitChance) {
            const npcDmg = Math.floor(rng() * Math.max(1, npc.attack || 1)) + 1;
            p.hp -= npcDmg;
            sendChat(p, `${npc.name} hits you for ${npcDmg}`, '#f44');
            addXp(p, 'defence', Math.ceil(npcDmg * 2));
            if (p.hp <= 0) { killPlayer(p); }
          }
        }
        // Update maxHp from hitpoints level
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
    // Wander
    if (tick % 5 === npc.wanderTick % 5) { // wander every ~3s
      const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      const [dx, dy] = dirs[Math.floor(rng() * 4)];
      const nx = npc.x + dx, ny = npc.y + dy;
      if (isWalkable(nx, ny) && Math.abs(nx - npc.spawnX) + Math.abs(ny - npc.spawnY) < 8) {
        npc.x = nx; npc.y = ny;
      }
    }
    // Aggressive chase + attack
    if (npc.aggressive) {
      let closest = null, closestDist = 999;
      for (const [, p] of players) {
        const d = Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y);
        if (d < closestDist) { closest = p; closestDist = d; }
      }
      if (closest && closestDist < 5 && closestDist > 1) { // chase every tick
        const dx = Math.sign(closest.x - npc.x), dy = Math.sign(closest.y - npc.y);
        if (isWalkable(npc.x + dx, npc.y + dy)) { npc.x += dx; npc.y += dy; }
      }
      if (closest && closestDist <= 1 && tick % 5 === 0) { // attack every 5 ticks (3s)
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
      broadcast({ t: 'tiles', changes: [{ x: r.x, y: r.y, tile: r.tile }] });
      respawns.splice(i, 1);
    }
  }

  // Despawn ground items
  for (let i = groundItems.length - 1; i >= 0; i--) {
    if (tick >= groundItems[i].despawnTick) groundItems.splice(i, 1);
  }

  // HP regen
  if (tick % 100 === 0) { // every 100 ticks = 60s (OSRS stat restore)
    for (const [, p] of players) {
      if (p.hp < p.maxHp) { p.hp++; sendStats(p); }
    }
  }

  // Broadcast entity state
  if (tick % STATE_INTERVAL === 0) {
    const pArr = [];
    for (const [, p] of players) pArr.push({ id: p.id, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, g: p.gender, path: p.path.slice(0, 20) });
    const nArr = npcs.filter(n => !n.dead).map(n => ({ id: n.id, x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp, name: n.name, color: n.color, atk: n.attack || 1, def: n.defence || 1 }));
    const gArr = groundItems.map(g => ({ id: g.id, name: g.name, x: g.x, y: g.y }));
    broadcast({ t: 'state', players: pArr, npcs: nArr, items: gArr, doors: [...openDoors.values()], tick });
  }
}

function killPlayer(p) {
  p.hp = p.maxHp; p.path = []; p.gathering = null; p.combatTarget = null; p.clickedNpc = null;
  // Find spawn
  for (let r = 0; r < 50; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (isWalkable(100 + dx, 100 + dy)) { p.x = 100 + dx; p.y = 100 + dy; r = 999; dx = 999; break; }
  sendChat(p, 'Oh dear, you are dead!', '#f00');
  if (p.inventory.length > 3) p.inventory.splice(3);
  sendStats(p);
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
      if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return;
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      if (isWalkable(tx, ty)) {
        p.path = findPath(p.x, p.y, tx, ty);
      } else {
        sendChat(p, "I can't reach that.", '#f44');
      }
      break;
    }
    case 'gather': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      const tile = tileAt(tx, ty);
      const typeMap = { [T.TREE]: 'woodcutting', [T.ROCK]: 'mining', [T.FISH_SPOT]: 'fishing' };
      if (!typeMap[tile]) return;
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      // For multi-tile objects (trees, rocks), walk to cluster base
      let adj;
      if (tile === T.TREE || tile === T.ROCK) {
        const cl = findCluster(tx, ty);
        adj = walkToClusterBase(cl.x, cl.y, cl.w, cl.h, p.x, p.y);
        // Store cluster info for full removal
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
    case 'gender': {
      p.gender = msg.v === 'female' ? 'female' : 'male';
      break;
    }
    case 'door': {
      const dx = Math.floor(msg.x), dy = Math.floor(msg.y);
      if (dx < 0 || dx >= WORLD_W || dy < 0 || dy >= WORLD_H) return;
      // Must be adjacent (within 1 tile)
      if (Math.abs(p.x - dx) > 1 || Math.abs(p.y - dy) > 1) {
        sendChat(p, 'You need to be next to the door.', '#f44');
        return;
      }
      const dk = dy * WORLD_W + dx;
      const tile = tileAt(dx, dy);
      if (tile === T.DOOR) {
        // Find interior side (FLOOR neighbor) to swing into
        let sx = dx, sy = dy;
        for (const [ndx, ndy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          if (tileAt(dx + ndx, dy + ndy) === T.FLOOR) { sx = dx + ndx; sy = dy + ndy; break; }
        }
        openDoors.set(dk, { ox: dx, oy: dy, sx, sy });
        setTile(dx, dy, T.FLOOR);
        broadcast({ t: 'tiles', changes: [{ x: dx, y: dy, tile: T.FLOOR }] });
        broadcast({ t: 'doors', doors: [...openDoors.values()] });
        sendChat(p, 'You open the door.', '#ccc');
      } else {
        // Check if clicking on swung door position or original position to close
        for (const [key, d] of openDoors) {
          if ((dx === d.ox && dy === d.oy) || (dx === d.sx && dy === d.sy)) {
            if (Math.abs(p.x - d.ox) > 1 || Math.abs(p.y - d.oy) > 1) {
              sendChat(p, 'You need to be next to the door.', '#f44');
              return;
            }
            openDoors.delete(key);
            setTile(d.ox, d.oy, T.DOOR);
            broadcast({ t: 'tiles', changes: [{ x: d.ox, y: d.oy, tile: T.DOOR }] });
            broadcast({ t: 'doors', doors: [...openDoors.values()] });
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
      // Walk to item tile then pick up
      if (p.x === gi.x && p.y === gi.y) {
        if (addItem(p, gi.name)) {
          groundItems.splice(idx, 1);
          sendStats(p);
          sendChat(p, `You pick up: ${gi.name}`, '#ff0');
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
      if (adj) {
        p.path = findPath(p.x, p.y, adj[0], adj[1]);
        p.clickedNpc = npcId;
      }
      break;
    }
    case 'paint': {
      // {t:'paint', tiles:[{x,y,tile,color?}]}
      const changes = [];
      if (!Array.isArray(msg.tiles) || msg.tiles.length > 500) return;
      for (const t of msg.tiles) {
        const x = Math.floor(t.x), y = Math.floor(t.y);
        if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) continue;
        const tile = Math.floor(t.tile);
        if (tile < 0 || tile > T.CUSTOM) continue;
        const k = y * WORLD_W + x;
        setTile(x, y, tile);
        if (tile === T.CUSTOM && t.color) customColors.set(k, String(t.color).slice(0, 7));
        else customColors.delete(k);
        changes.push({ x, y, tile, color: t.color || null });
      }
      if (changes.length > 0) broadcast({ t: 'tiles', changes });
      break;
    }
    case 'bucket': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketFill(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        const bc = changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color }));
        broadcast({ t: 'tiles', changes: bc });
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
      }
      break;
    }
    case 'bucket_all': {
      // Recolor every tile of the same type/color across the entire world
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketAllRecolor(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        const bc = changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color }));
        broadcast({ t: 'tiles', changes: bc });
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
        sendChat(p, `Recolored ${changes.length} tiles globally.`, '#ff981f');
      }
      break;
    }
    case 'bucket_new': {
      // Recolor every tile of same type globally AND rename it
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const name = String(msg.name || '').slice(0, 30);
      if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      if (!name) return;
      // Get the key for the NEW tile type for naming
      const newNameKey = tile === T.CUSTOM && msg.color ? 'c:' + msg.color : 't:' + tile;
      customNames.set(newNameKey, name);
      const changes = bucketAllRecolor(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        const bc = changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color }));
        broadcast({ t: 'tiles', changes: bc });
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
      }
      // Broadcast updated names
      const namesObj = {};
      for (const [k, v] of customNames) namesObj[k] = v;
      broadcast({ t: 'names', names: namesObj });
      sendChat(p, `Renamed ${changes.length} tiles to "${name}".`, '#ff981f');
      break;
    }
  }
}

// ── HTTP Server (serves client.html and map.html) ──────────────────────────────
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
  console.log(`[join] Player ${p.id} connected (${players.size} online)`);

  // Send full world state
  const colorsObj = {};
  for (const [k, v] of customColors) colorsObj[k] = v;
  const namesObj = {};
  for (const [k, v] of customNames) namesObj[k] = v;
  send(ws, {
    t: 'welcome', id: p.id, x: p.x, y: p.y,
    world: Buffer.from(world).toString('base64'),
    customColors: colorsObj,
    customNames: namesObj,
  });
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
if (!loadWorld()) {
  console.log('[init] Generating new world...');
  generateWorld();
  saveWorld();
}
spawnNpcs();

// Game loop
setInterval(gameTick, TICK_MS);

// Auto-save
setInterval(saveWorld, SAVE_INTERVAL_MS);

// Save on exit
process.on('SIGINT', () => { saveWorld(); process.exit(); });
process.on('SIGTERM', () => { saveWorld(); process.exit(); });

server.listen(PORT, () => {
  console.log(`[server] MiniScape running on http://localhost:${PORT}`);
  console.log(`[server] OSRS tick rate (${TICK_MS}ms / 0.6s), world ${WORLD_W}x${WORLD_H}`);
});
