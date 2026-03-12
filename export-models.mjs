// export-models.mjs — Batch export OSRS models to glTF for miniscape 3D mode
// Usage: node export-models.mjs

import fs from "fs";
import { RSCache, IndexType, ConfigType, GLTFExporter, ModelGroup } from "osrscachereader";

const CACHE_DIR = "./cache";
const OUT_DIR = "./models";

// Models to export: { type, id, name }
const EXPORTS = [
  // Trees
  { type: "object", id: 1276, name: "tree_normal" },       // Normal tree
  { type: "object", id: 1278, name: "tree_oak" },          // Oak tree
  { type: "object", id: 1280, name: "tree_willow" },       // Willow tree
  { type: "object", id: 1306, name: "tree_yew" },          // Yew tree

  // Rocks
  { type: "object", id: 11360, name: "rock_tin" },         // Tin rock
  { type: "object", id: 11361, name: "rock_copper" },      // Copper rock
  { type: "object", id: 11362, name: "rock_iron" },        // Iron rock
  { type: "object", id: 11363, name: "rock_coal" },        // Coal rock

  // Fishing spots (are NPCs in OSRS)
  { type: "npc", id: 635, name: "fishing_spot" },          // Fishing spot

  // Common NPCs (correct IDs from cache lookup)
  { type: "npc", id: 385, name: "npc_man" },               // Man
  { type: "npc", id: 1119, name: "npc_woman" },            // Woman
  { type: "npc", id: 3105, name: "npc_hans" },             // Hans (Lumbridge)
  { type: "npc", id: 225, name: "npc_cook" },              // Cook
  { type: "npc", id: 397, name: "npc_guard" },             // Guard
  { type: "npc", id: 677, name: "npc_goblin" },            // Goblin (classic green)
  { type: "npc", id: 2790, name: "npc_cow" },              // Cow
  { type: "npc", id: 1173, name: "npc_chicken" },          // Chicken
  { type: "npc", id: 2510, name: "npc_rat" },              // Giant rat
  { type: "npc", id: 1020, name: "npc_small_rat" },        // Small rat

  // Tutorial Island NPCs
  { type: "npc", id: 3308, name: "npc_gielinor_guide" },   // Gielinor Guide
  { type: "npc", id: 8503, name: "npc_survival_expert" },  // Survival Expert
  { type: "npc", id: 3305, name: "npc_master_chef" },      // Master Chef

  // Spiders
  { type: "npc", id: 2477, name: "npc_giant_spider" },     // Giant spider
  { type: "npc", id: 2478, name: "npc_spider" },           // Small spider

  // Scenery
  { type: "object", id: 2147, name: "furnace" },           // Furnace
  { type: "object", id: 36781, name: "anvil" },            // Anvil
  { type: "object", id: 26185, name: "bank_booth" },       // Bank booth

  // Iconic
  { type: "npc", id: 2042, name: "npc_zulrah" },           // Zulrah
];

async function exportModel(cache, entry) {
  try {
    let modelGroup = new ModelGroup();

    if (entry.type === "npc") {
      const def = await cache.getDef(IndexType.CONFIGS, ConfigType.NPC, entry.id);
      if (!def || !def.models || def.models.length === 0) {
        console.log(`  SKIP ${entry.name}: no models found for NPC ${entry.id}`);
        return false;
      }
      for (const modelId of def.models) {
        if (modelId < 0) continue;
        try {
          const model = await cache.getDef(IndexType.MODELS, modelId);
          modelGroup.addModel(model);
        } catch (e) {
          console.log(`  WARN: model ${modelId} failed: ${e.message}`);
        }
      }
    } else if (entry.type === "object") {
      const def = await cache.getDef(IndexType.CONFIGS, ConfigType.OBJECT, entry.id);
      if (!def) {
        console.log(`  SKIP ${entry.name}: no def found for object ${entry.id}`);
        return false;
      }
      // Objects can have objectModels or models
      const modelIds = def.objectModels || def.models || [];
      if (modelIds.length === 0) {
        console.log(`  SKIP ${entry.name}: no model IDs for object ${entry.id}`);
        return false;
      }
      for (const modelId of (Array.isArray(modelIds) ? modelIds : [modelIds])) {
        if (modelId < 0) continue;
        try {
          const model = await cache.getDef(IndexType.MODELS, modelId);
          modelGroup.addModel(model);
        } catch (e) {
          console.log(`  WARN: model ${modelId} failed: ${e.message}`);
        }
      }
    } else if (entry.type === "item") {
      const def = await cache.getDef(IndexType.CONFIGS, ConfigType.ITEM, entry.id);
      if (!def || !def.maleModel0) {
        console.log(`  SKIP ${entry.name}: no model for item ${entry.id}`);
        return false;
      }
      const model = await cache.getDef(IndexType.MODELS, def.maleModel0);
      modelGroup.addModel(model);
    }

    const merged = modelGroup.getMergedModel();
    const exporter = new GLTFExporter(merged);
    exporter.addColors(merged);
    const gltf = exporter.export();

    const path = `${OUT_DIR}/${entry.name}.gltf`;
    fs.writeFileSync(path, gltf);
    console.log(`  OK: ${entry.name}.gltf`);
    return true;
  } catch (e) {
    console.log(`  FAIL ${entry.name}: ${e.message}`);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("Initializing OSRS cache reader...");
  const cache = new RSCache(CACHE_DIR);
  await cache.onload;
  console.log("Cache loaded!\n");

  let ok = 0, fail = 0;
  for (const entry of EXPORTS) {
    console.log(`Exporting ${entry.type} #${entry.id} → ${entry.name}...`);
    const success = await exportModel(cache, entry);
    if (success) ok++; else fail++;
  }

  console.log(`\nDone! ${ok} exported, ${fail} failed.`);
  console.log(`Models saved to ${OUT_DIR}/`);
}

main().catch(console.error);
