// Extract location (object placement) data from OSRS cache
// Output: data/tile-data/loc_{regionX}_{regionY}.json per map region
// Each file contains objects with their IDs, types, orientations, and positions

import { RSCache } from 'osrscachereader';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = './data/tile-data';
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[loc-extract] Loading OSRS cache...');
const cache = new RSCache('./data/osrs-cache/cache/');
await cache.onload;
console.log('[loc-extract] Cache loaded.');

const mapIndex = cache.getIndex(5);
const archiveCount = Object.keys(mapIndex.archives).length;
console.log(`[loc-extract] Found ${archiveCount} map archives`);

let locCount = 0;
let errorCount = 0;
let totalObjects = 0;

for (const archiveId of Object.keys(mapIndex.archives)) {
  try {
    const files = await cache.getAllFiles(5, Number(archiveId));
    if (!files || files.length === 0) continue;

    const def = files[0]?.def;
    if (!def) continue;

    // LocationDefinition has locations[] and regionX/regionY
    if (def.locations && def.locations.length > 0 && def.regionX !== undefined) {
      const rx = def.regionX;
      const ry = def.regionY;

      const outFile = path.join(OUT_DIR, `loc_${rx}_${ry}.json`);
      fs.writeFileSync(outFile, JSON.stringify({
        regionX: rx,
        regionY: ry,
        locations: def.locations
      }));
      locCount++;
      totalObjects += def.locations.length;
      if (locCount % 100 === 0) console.log(`[loc-extract] ${locCount} location regions, ${totalObjects} objects...`);
    }
  } catch (e) {
    errorCount++;
  }
}

console.log(`[loc-extract] Done! ${locCount} location regions, ${totalObjects} total objects, ${errorCount} errors`);
