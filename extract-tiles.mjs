// Extract all OSRS tile data from cache into MiniScape chunk format
// Output: data/tile-data/{regionX}_{regionY}.json per map region (64x64)
// Each file contains heights, underlays, overlays, shapes, rotations, settings

import { RSCache } from 'osrscachereader';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = './data/tile-data';
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[extract] Loading OSRS cache...');
const cache = new RSCache('./data/osrs-cache/cache/');
await cache.onload;
console.log('[extract] Cache loaded. Reading map index...');

// Index 5 = MAPS
const mapIndex = cache.getIndex(5);
const archiveCount = Object.keys(mapIndex.archives).length;
console.log(`[extract] Found ${archiveCount} map archives`);

let mapCount = 0;
let locCount = 0;
let errorCount = 0;

for (const archiveId of Object.keys(mapIndex.archives)) {
  try {
    const files = await cache.getAllFiles(5, Number(archiveId));
    if (!files || files.length === 0) continue;

    const def = files[0]?.def;
    if (!def) continue;

    // MapDefinition has tiles[z][x][y], LocationDefinition has locations[]
    if (def.tiles && def.regionX !== undefined) {
      const rx = def.regionX;
      const ry = def.regionY;

      // Compute real heights using the built-in method
      const heights = def.getHeights();

      // Extract plane 0 (ground level) tile data
      const tileData = {
        regionX: rx,
        regionY: ry,
        // Per-tile arrays, indexed [x][y] within the 64x64 region
        // World coordinate = (regionX * 64 + x, regionY * 64 + y)
        height: [],       // computed real heights
        underlay: [],     // underlay IDs
        overlay: [],      // overlay IDs
        overlayShape: [], // overlay shape (0-11)
        overlayRot: [],   // overlay rotation (0-3)
        settings: [],     // tile settings/flags
      };

      for (let x = 0; x < 64; x++) {
        tileData.height[x] = [];
        tileData.underlay[x] = [];
        tileData.overlay[x] = [];
        tileData.overlayShape[x] = [];
        tileData.overlayRot[x] = [];
        tileData.settings[x] = [];

        for (let y = 0; y < 64; y++) {
          const tile = def.tiles[0]?.[x]?.[y] || {};
          tileData.height[x][y] = heights[0]?.[x]?.[y] || 0;
          tileData.underlay[x][y] = tile.underlayId || 0;
          tileData.overlay[x][y] = tile.overlayId || 0;
          tileData.overlayShape[x][y] = tile.overlayPath != null ? Math.floor(tile.overlayPath) : 0;
          tileData.overlayRot[x][y] = tile.overlayRotation || 0;
          // Combine plane 0 settings with plane 1 bridge flag
          let s = tile.settings || 0;
          const tile1 = def.tiles[1]?.[x]?.[y] || {};
          if (tile1.settings && (tile1.settings & 2)) s |= 2; // propagate bridge flag from plane 1
          tileData.settings[x][y] = s;
        }
      }

      const outFile = path.join(OUT_DIR, `${rx}_${ry}.json`);
      fs.writeFileSync(outFile, JSON.stringify(tileData));
      mapCount++;
      if (mapCount % 100 === 0) console.log(`[extract] ${mapCount} map regions extracted...`);
    }

    if (def.locations && def.regionX !== undefined) {
      locCount++;
    }
  } catch (e) {
    errorCount++;
    // Some archives fail due to missing xteas or corrupted data — skip
  }
}

console.log(`[extract] Done! ${mapCount} map regions, ${locCount} location defs, ${errorCount} errors`);
console.log(`[extract] Output: ${OUT_DIR}/`);

// Also extract underlay color definitions for mapping IDs to colors
try {
  const underlays = [];
  // ConfigType for underlays: index 2, archive depends on version
  // Let's try to get them
  const configIndex = cache.getIndex(2);
  // Underlay archive is typically config type 1
  for (let i = 0; i < 300; i++) {
    try {
      const def = await cache.getDef(2, 1, i);
      if (def && def.color !== undefined) {
        const r = (def.color >> 16) & 0xFF;
        const g = (def.color >> 8) & 0xFF;
        const b = def.color & 0xFF;
        underlays.push({ id: i, color: def.color, hex: `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}` });
      }
    } catch (e) { break; }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'underlays.json'), JSON.stringify(underlays, null, 2));
  console.log(`[extract] ${underlays.length} underlay definitions saved`);
} catch (e) {
  console.log('[extract] Could not extract underlay colors:', e.message || e);
}

// Extract overlay definitions too
try {
  const overlays = [];
  for (let i = 0; i < 300; i++) {
    try {
      const def = await cache.getDef(2, 4, i);
      if (def) {
        overlays.push({ id: i, ...def });
      }
    } catch (e) { break; }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'overlays.json'), JSON.stringify(overlays, null, 2));
  console.log(`[extract] ${overlays.length} overlay definitions saved`);
} catch (e) {
  console.log('[extract] Could not extract overlay definitions:', e.message || e);
}
