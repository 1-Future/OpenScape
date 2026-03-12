// auto-export.mjs — Watches RuneLite scan output and auto-exports new models
// Usage: node auto-export.mjs

import fs from "fs";
import { RSCache, IndexType, ConfigType, GLTFExporter, ModelGroup } from "osrscachereader";

const SCAN_FILE = process.env.USERPROFILE + "/.runelite/nearby-models.json";
const OUT_DIR = "./models";
const CACHE_DIR = "./cache";

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const exported = new Set();
// Track what we already have
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith(".gltf")) exported.add(f.replace(".gltf", ""));
}

console.log(`[auto-export] ${exported.size} models already exported`);
console.log(`[auto-export] Watching ${SCAN_FILE}...`);
console.log(`[auto-export] Loading OSRS cache...`);

const cache = new RSCache(CACHE_DIR);
await cache.onload;
console.log(`[auto-export] Cache ready! Waiting for scan data...\n`);

let lastModified = 0;

async function exportNpc(id, name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  const key = `npc_${safeName}_${id}`;
  if (exported.has(key)) return null;

  try {
    const def = await cache.getDef(IndexType.CONFIGS, ConfigType.NPC, id);
    if (!def || !def.models || def.models.length === 0) return null;

    const modelGroup = new ModelGroup();
    for (const modelId of def.models) {
      if (modelId < 0) continue;
      try {
        const model = await cache.getDef(IndexType.MODELS, modelId);
        modelGroup.addModel(model);
      } catch (e) { /* skip bad model */ }
    }

    const merged = modelGroup.getMergedModel();
    const exporter = new GLTFExporter(merged);
    exporter.addColors(merged);
    const gltf = exporter.export();

    const path = `${OUT_DIR}/${key}.gltf`;
    fs.writeFileSync(path, gltf);
    exported.add(key);
    console.log(`  ✓ NPC: ${name} (${id}) → ${key}.gltf`);
    return key;
  } catch (e) {
    console.log(`  ✗ NPC: ${name} (${id}): ${e.message}`);
    return null;
  }
}

async function exportObject(id, name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  const key = `obj_${safeName}_${id}`;
  if (exported.has(key)) return null;

  try {
    const def = await cache.getDef(IndexType.CONFIGS, ConfigType.OBJECT, id);
    if (!def) return null;

    const modelIds = def.objectModels || def.models || [];
    if (modelIds.length === 0) return null;

    const modelGroup = new ModelGroup();
    for (const modelId of (Array.isArray(modelIds) ? modelIds : [modelIds])) {
      if (modelId < 0) continue;
      try {
        const model = await cache.getDef(IndexType.MODELS, modelId);
        modelGroup.addModel(model);
      } catch (e) { /* skip */ }
    }

    const merged = modelGroup.getMergedModel();
    const exporter = new GLTFExporter(merged);
    exporter.addColors(merged);
    const gltf = exporter.export();

    const path = `${OUT_DIR}/${key}.gltf`;
    fs.writeFileSync(path, gltf);
    exported.add(key);
    console.log(`  ✓ OBJ: ${name} (${id}) → ${key}.gltf`);
    return key;
  } catch (e) {
    console.log(`  ✗ OBJ: ${name} (${id}): ${e.message}`);
    return null;
  }
}

async function exportItem(id, name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  const key = `item_${safeName}_${id}`;
  if (exported.has(key)) return null;

  try {
    const def = await cache.getDef(IndexType.CONFIGS, ConfigType.ITEM, id);
    if (!def) return null;

    // Items can have inventoryModel or maleModel0
    const modelId = def.inventoryModel || def.maleModel0;
    if (!modelId || modelId < 0) return null;

    const modelGroup = new ModelGroup();
    const model = await cache.getDef(IndexType.MODELS, modelId);
    modelGroup.addModel(model);

    const merged = modelGroup.getMergedModel();
    const exporter = new GLTFExporter(merged);
    exporter.addColors(merged);
    const gltf = exporter.export();

    const path = `${OUT_DIR}/${key}.gltf`;
    fs.writeFileSync(path, gltf);
    exported.add(key);
    console.log(`  ✓ ITEM: ${name} (${id}) → ${key}.gltf`);
    return key;
  } catch (e) {
    console.log(`  ✗ ITEM: ${name} (${id}): ${e.message}`);
    return null;
  }
}

async function processScanFile() {
  try {
    const stat = fs.statSync(SCAN_FILE);
    if (stat.mtimeMs <= lastModified) return;
    lastModified = stat.mtimeMs;

    const data = JSON.parse(fs.readFileSync(SCAN_FILE, "utf8"));
    let newCount = 0;

    if (data.npcs) {
      for (const npc of data.npcs) {
        const result = await exportNpc(npc.id, npc.name);
        if (result) newCount++;
      }
    }

    if (data.objects) {
      for (const obj of data.objects) {
        const result = await exportObject(obj.id, obj.name);
        if (result) newCount++;
      }
    }

    if (data.items) {
      for (const item of data.items) {
        const result = await exportItem(item.id, item.name);
        if (result) newCount++;
      }
    }

    if (newCount > 0) {
      console.log(`\n[auto-export] Exported ${newCount} new models (${exported.size} total)\n`);
    }
  } catch (e) {
    // File might be mid-write, ignore
  }
}

// Poll every 2 seconds
setInterval(processScanFile, 2000);
// Also run immediately
processScanFile();
