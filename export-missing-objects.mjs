// export-missing-objects.mjs — Export GLTF models for objects in placements that don't have models yet
import { RSCache, IndexType, ConfigType, GLTFExporter, ModelGroup } from "osrscachereader";
import fs from "fs";

const CACHE_DIR = "./cache";
const OUT_DIR = "./models";
const PLACEMENTS = "./data/object-placements.json";

const data = JSON.parse(fs.readFileSync(PLACEMENTS, "utf8"));
const existing = new Set(fs.readdirSync(OUT_DIR).filter(f => f.endsWith(".gltf")).map(f => f.replace(".gltf", "")));

console.log("[export] Loading cache...");
const cache = new RSCache(CACHE_DIR);
await cache.onload;
console.log("[export] Cache ready.");

// Find unique object IDs that need models
const needed = new Set();
for (const p of data.placements) {
  if (p.level > 0) continue; // ground floor only for now
  const name = data.objectNames[p.id];
  if (!name) continue;
  const safe = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  const key = `obj_${safe}_${p.id}`;
  if (!existing.has(key)) needed.add(p.id);
}

console.log(`[export] ${needed.size} objects need models`);

let exported = 0, failed = 0;
for (const objId of needed) {
  const name = data.objectNames[objId];
  if (!name) continue;
  const safe = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  const key = `obj_${safe}_${objId}`;

  try {
    const def = await cache.getDef(IndexType.CONFIGS, ConfigType.OBJECT, objId);
    if (!def) { failed++; continue; }

    const modelIds = def.objectModels || def.models || [];
    if (modelIds.length === 0) { failed++; continue; }

    const modelGroup = new ModelGroup();
    for (const modelId of (Array.isArray(modelIds) ? modelIds : [modelIds])) {
      if (modelId < 0) continue;
      try {
        const model = await cache.getDef(IndexType.MODELS, modelId);
        modelGroup.addModel(model);
      } catch (e) {}
    }

    const merged = modelGroup.getMergedModel();
    const exporter = new GLTFExporter(merged);
    exporter.addColors(merged);
    const gltf = exporter.export();

    fs.writeFileSync(`${OUT_DIR}/${key}.gltf`, gltf);
    exported++;
    if (exported % 50 === 0) console.log(`  [${exported}] ${name} (${objId})`);
  } catch (e) {
    failed++;
  }
}

console.log(`\n[export] Done! Exported ${exported} new models, ${failed} failed`);
console.log(`[export] Total models: ${existing.size + exported}`);
