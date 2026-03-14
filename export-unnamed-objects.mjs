// export-unnamed-objects.mjs — Export GLTF models for unnamed objects (by ID only)
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

// Find unique unnamed object IDs
const unnamed = new Set();
for (const p of data.placements) {
  if (p.level > 0) continue;
  if (data.objectNames[p.id]) continue; // already has a name
  const key = `obj_id_${p.id}`;
  if (!existing.has(key)) unnamed.add(p.id);
}

console.log(`[export] ${unnamed.size} unnamed objects need models`);

let exported = 0, failed = 0, noModel = 0;
let i = 0;
for (const objId of unnamed) {
  i++;
  const key = `obj_id_${objId}`;

  try {
    const def = await cache.getDef(IndexType.CONFIGS, ConfigType.OBJECT, objId);
    if (!def) { failed++; continue; }

    const modelIds = def.objectModels || def.models || [];
    if (!modelIds || modelIds.length === 0) { noModel++; continue; }

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
    if (exported % 50 === 0) console.log(`  [${exported}/${unnamed.size}] ID ${objId}`);
  } catch (e) {
    failed++;
  }
}

console.log(`\n[export] Done! Exported ${exported}, no model data: ${noModel}, failed: ${failed}`);
console.log(`[export] Total models: ${existing.size + exported}`);
