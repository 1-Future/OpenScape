// extract-object-defs.mjs — Extract transform metadata for all placed objects
import { RSCache, IndexType, ConfigType } from "osrscachereader";
import fs from "fs";

const CACHE_DIR = "./cache";
const PLACEMENTS = "./data/object-placements.json";
const OUT_FILE = "./data/object-defs.json";

const data = JSON.parse(fs.readFileSync(PLACEMENTS, "utf8"));
const uniqueIds = [...new Set(data.placements.map(p => p.id))];

console.log("[defs] Loading cache...");
const cache = new RSCache(CACHE_DIR);
await cache.onload;
console.log(`[defs] Resolving ${uniqueIds.length} object defs...`);

const defs = {};
let i = 0;
for (const id of uniqueIds) {
  try {
    const def = await cache.getDef(IndexType.CONFIGS, ConfigType.OBJECT, id);
    if (!def) continue;
    defs[id] = {
      sizeX:           def.sizeX           ?? 1,
      sizeY:           def.sizeY           ?? 1,
      rotated:         def.rotated         ?? false,
      offsetX:         def.offsetX         ?? 0,
      offsetY:         def.offsetY         ?? 0,
      offsetHeight:    def.offsetHeight    ?? 0,
      modelSizeX:      def.modelSizeX      ?? 128,
      modelSizeY:      def.modelSizeY      ?? 128,
      modelSizeHeight: def.modelSizeHeight ?? 128,
      animationID:     def.animationID     ?? -1,
      wallOrDoor:      def.wallOrDoor      ?? -1,
    };
  } catch (e) {}
  i++;
  if (i % 200 === 0) console.log(`  ${i}/${uniqueIds.length}`);
}

fs.writeFileSync(OUT_FILE, JSON.stringify(defs));
console.log(`[defs] Done! ${Object.keys(defs).length} defs saved to ${OUT_FILE}`);
