import fs from "fs";
const d = JSON.parse(fs.readFileSync("./data/object-placements.json", "utf8"));
const models = fs.readdirSync("./models/");

console.log("Total placements:", d.placements.length);
console.log("Unique object IDs:", new Set(d.placements.map(p => p.id)).size);
console.log("Named objects:", Object.keys(d.objectNames).length);

// Type distribution (OSRS loc types)
const types = {};
d.placements.forEach(p => { types[p.type] = (types[p.type] || 0) + 1; });
console.log("\nType distribution:");
const typeNames = {
  0: "wall_straight", 1: "wall_diagonal_corner", 2: "wall_corner", 3: "wall_straight_corner",
  4: "wall_decor_straight", 5: "wall_decor_straight_offset", 6: "wall_decor_diagonal_offset",
  7: "wall_decor_diagonal_nooffset", 8: "wall_decor_diagonal_both",
  9: "wall_diagonal", 10: "loc_full", 11: "loc_half", 12: "floor_decor",
  22: "ground_decor"
};
for (const [t, count] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log(`  type ${t} (${typeNames[t] || "other"}): ${count}`);
}

// Level distribution
const levels = {};
d.placements.forEach(p => { levels[p.level] = (levels[p.level] || 0) + 1; });
console.log("\nLevel distribution:", levels);

// Check model coverage
let hasModel = 0, noModel = 0;
const checked = new Set();
const missing = [];
for (const p of d.placements) {
  if (checked.has(p.id)) continue;
  checked.add(p.id);
  const name = d.objectNames[p.id];
  if (!name) continue;
  const safe = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
  const key = "obj_" + safe + "_" + p.id + ".gltf";
  if (models.includes(key)) {
    hasModel++;
  } else {
    noModel++;
    if (missing.length < 20) missing.push(`${name} (${p.id})`);
  }
}
console.log("\nModel coverage:");
console.log("  With GLTF:", hasModel);
console.log("  Missing:", noModel);
if (missing.length > 0) console.log("  Sample missing:", missing.join(", "));

// Ground floor placements only (level 0) — what we'll render
const ground = d.placements.filter(p => p.level === 0);
console.log("\nGround floor placements:", ground.length);

// Sample named objects
console.log("\nSample placements:");
const samples = ground.filter(p => d.objectNames[p.id]).slice(0, 15);
samples.forEach(p => console.log(`  ${d.objectNames[p.id]} (${p.id}) at ${p.x},${p.y} type=${p.type} rot=${p.rotation}`));
