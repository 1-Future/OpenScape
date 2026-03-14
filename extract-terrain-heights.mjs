// extract-terrain-heights.mjs — Extract terrain heights from OSRS cache
import { RSCache, IndexType } from 'osrscachereader';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = './cache';
const TILE_DATA_DIR = './data/tile-data';

console.log('[terrain] Loading cache...');
const cache = new RSCache(CACHE_DIR);
await cache.onload;
console.log('[terrain] Cache ready.');

const xteas = cache.cacheRequester.xteas;

// Helper: extract heights from a def
function getHeights(def) {
  if (!def.heights) return null;
  // Could be [plane][x][y] or [x][y]
  let h;
  if (Array.isArray(def.heights[0]) && Array.isArray(def.heights[0][0])) {
    h = def.heights[0]; // take plane 0 (ground floor)
  } else if (Array.isArray(def.heights[0])) {
    h = def.heights;
  } else return null;

  const out = {};
  for (let x = 0; x < 64; x++) {
    out[x] = [];
    for (let y = 0; y < 64; y++) {
      out[x][y] = (h[x] && h[x][y] != null) ? h[x][y] : 0;
    }
  }
  return out;
}

const done = new Set();
let updated = 0;

// 1) Load via XTEA entries (provides keys for encrypted groups)
for (const [groupId, xtea] of Object.entries(xteas)) {
  const rx = xtea.mapsquare >> 8, ry = xtea.mapsquare & 0xff;
  if (rx < 48 || rx > 52 || ry < 48 || ry > 52) continue;

  const regionKey = `${rx}_${ry}`;
  if (done.has(regionKey)) continue;

  try {
    const files = await cache.getAllFiles(IndexType.MAPS, parseInt(groupId));
    if (!files) continue;
    for (const file of files) {
      if (!file || !file.def) continue;
      const heights = getHeights(file.def);
      if (!heights) continue;

      const outFile = path.join(TILE_DATA_DIR, `${regionKey}.json`);
      let existing = {};
      if (fs.existsSync(outFile)) existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      existing.height = heights;
      existing.regionX = rx;
      existing.regionY = ry;
      fs.writeFileSync(outFile, JSON.stringify(existing));
      done.add(regionKey);
      updated++;
      console.log(`  [${regionKey}] Updated from XTEA group ${groupId}`);
      break;
    }
  } catch (e) {}
}

// 2) Load remaining regions (no XTEA, unencrypted) by standard group ID
for (let rx = 48; rx <= 52; rx++) {
  for (let ry = 48; ry <= 52; ry++) {
    const regionKey = `${rx}_${ry}`;
    if (done.has(regionKey)) continue;

    const groupId = rx * 128 + ry;
    try {
      const files = await cache.getAllFiles(IndexType.MAPS, groupId);
      if (!files) continue;
      for (const file of files) {
        if (!file || !file.def) continue;
        const heights = getHeights(file.def);
        if (!heights) continue;

        const outFile = path.join(TILE_DATA_DIR, `${regionKey}.json`);
        let existing = {};
        if (fs.existsSync(outFile)) existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        existing.height = heights;
        existing.regionX = rx;
        existing.regionY = ry;
        fs.writeFileSync(outFile, JSON.stringify(existing));
        done.add(regionKey);
        updated++;
        console.log(`  [${regionKey}] Updated from standard group ${groupId}`);
        break;
      }
    } catch (e) {}
  }
}

console.log(`\n[terrain] Done! Updated ${updated} regions.`);
console.log(`[terrain] Not found: ${[...Array(5)].flatMap((_,i)=>[...Array(5)].map((_,j)=>`${48+i}_${48+j}`)).filter(k=>!done.has(k))}`);
