// merge-collision.mjs — Merges RuneLite collision scan into tile-data settings
import fs from "fs";
import path from "path";

const COLLISION_FILE = process.env.USERPROFILE + "/.runelite/collision-data.json";
const TILE_DATA = "./data/tile-data/";

const data = JSON.parse(fs.readFileSync(COLLISION_FILE, "utf8"));
console.log(`Loaded ${data.tiles.length} collision tiles`);

// Group by chunk
const chunks = {};
for (const t of data.tiles) {
  const [x, y, plane, flag] = t;
  if (plane > 0) continue; // ground floor only
  const cx = Math.floor(x / 64);
  const cy = Math.floor(y / 64);
  const key = `${cx}_${cy}`;
  if (!chunks[key]) chunks[key] = [];
  chunks[key].push([x, y, flag]);
}

let updated = 0;
let tilesUpdated = 0;

for (const [key, tiles] of Object.entries(chunks)) {
  const filePath = path.join(TILE_DATA, key + ".json");
  if (!fs.existsSync(filePath)) continue;

  const td = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!td.settings) continue;

  for (const [x, y, flag] of tiles) {
    const lx = ((x % 64) + 64) % 64;
    const ly = ((y % 64) + 64) % 64;
    // OSRS collision flags:
    // 0x100 (256) = floor decoration block
    // 0x20000 (131072) = full block
    // 0x200000 (2097152) = object/NPC block
    // 16777215 = fully blocked (off-map)
    const isBlocked = (flag & (0x100 | 0x20000 | 0x200000)) !== 0 || flag === 16777215;
    td.settings[lx][ly] = isBlocked ? 1 : 0;
    tilesUpdated++;
  }

  fs.writeFileSync(filePath, JSON.stringify(td));
  updated++;
}

console.log(`Updated ${updated} chunk files (${tilesUpdated} tiles) with RuneLite collision data`);
console.log(`Chunks: ${Object.keys(chunks).join(", ")}`);
