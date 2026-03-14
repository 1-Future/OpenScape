// extract-object-placements.mjs — Extract object placements from OSRS cache
import { RSCache, IndexType, ConfigType } from "osrscachereader";
import fs from "fs";

const CACHE_DIR = "./cache";
const OUT_FILE = "./data/object-placements.json";

console.log("[extract] Loading cache...");
const cache = new RSCache(CACHE_DIR);
await cache.onload;
console.log("[extract] Cache ready.");

const xteas = cache.cacheRequester.xteas;
console.log("[extract] XTEA keys loaded:", xteas ? Object.keys(xteas).length : 0);

const allPlacements = [];
const objectNames = {};
let regionCount = 0;

// Use XTEA entries to find location archives for Lumbridge area
// Each xtea entry has: group (archive ID), mapsquare, name (e.g. "l50_50")
for (const [groupId, xtea] of Object.entries(xteas)) {
  // Parse region coords from mapsquare
  const rx = xtea.mapsquare >> 8;
  const ry = xtea.mapsquare & 0xff;

  // Filter to Lumbridge area (regions 48-52 x 48-52)
  if (rx < 48 || rx > 52 || ry < 48 || ry > 52) continue;

  // Only location files (l prefix), not terrain files (m prefix)
  if (!xtea.name || !xtea.name.startsWith("l")) continue;

  console.log(`  Loading region (${rx},${ry}) group=${groupId} name=${xtea.name}...`);

  try {
    const files = await cache.getAllFiles(IndexType.MAPS, parseInt(groupId));
    if (!files) continue;

    for (const file of files) {
      if (!file || !file.def) continue;
      const def = file.def;

      if (def.locations && def.locations.length > 0) {
        console.log(`    -> ${def.locations.length} objects`);
        regionCount++;

        for (const loc of def.locations) {
          const worldX = rx * 64 + loc.position.localX;
          const worldY = ry * 64 + loc.position.localY;

          allPlacements.push({
            id: loc.id,
            x: worldX,
            y: worldY,
            level: loc.position.height,
            type: loc.type,
            rotation: loc.orientation
          });
        }
      }
    }
  } catch (e) {
    console.log(`    -> Error: ${e.message}`);
  }
}

// Resolve object names
if (allPlacements.length > 0) {
  const uniqueIds = [...new Set(allPlacements.map(p => p.id))];
  console.log(`\n[extract] Resolving ${uniqueIds.length} unique object names...`);

  let resolved = 0;
  for (const objId of uniqueIds) {
    try {
      const objDef = await cache.getDef(IndexType.CONFIGS, ConfigType.OBJECT, objId);
      if (objDef && objDef.name && objDef.name !== "null") {
        objectNames[objId] = objDef.name;
        resolved++;
      }
    } catch (e) {}
  }
  console.log(`[extract] Resolved ${resolved} names`);
}

const output = { objectNames, placements: allPlacements };
fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`\n[extract] Done! ${allPlacements.length} placements from ${regionCount} regions`);
console.log(`[extract] Saved to ${OUT_FILE}`);
