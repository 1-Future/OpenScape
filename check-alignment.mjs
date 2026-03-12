import fs from 'fs';

// Region 50,50 = Lumbridge, covers world (3200-3263, 3200-3263)
const d = JSON.parse(fs.readFileSync('data/tile-data/50_50.json', 'utf8'));

// In RuneLite at (3223, 3216) = local (23, 16):
// - Player is ON the Y=3216 chunk boundary
// - Trees are to the west (lower x)
// - Castle wall/stairs to the north (higher y)

// Check heights at known positions
// The castle wall has heights 464+ (from Land Surveyor screenshots)
// The courtyard has heights ~240

console.log('Heights along x=23 (world X=3223), varying Y:');
for (let y = 0; y < 64; y++) {
  const h = d.height[23][y];
  if (h > 300 || h < 100 || y % 8 === 0) {
    console.log(`  local y=${y} (world Y=${3200+y}): height=${h}`);
  }
}

console.log('\nHeights along y=16 (world Y=3216), varying X:');
for (let x = 0; x < 64; x++) {
  const h = d.height[x][16];
  if (h > 300 || h < 100 || x % 8 === 0) {
    console.log(`  local x=${x} (world X=${3200+x}): height=${h}`);
  }
}

// What should be at (3223, 3216) in RuneLite: courtyard grass, height ~240
console.log(`\nHeight at local (23,16) = world (3223,3216): ${d.height[23][16]}`);
// What's at (3223, 3223):
console.log(`Height at local (23,23) = world (3223,3223): ${d.height[23][23]}`);

// Check underlay IDs to see terrain type
console.log(`\nUnderlay at (23,16): ${d.underlay[23][16]}`);
console.log(`Underlay at (23,23): ${d.underlay[23][23]}`);
console.log(`Overlay at (23,16): ${d.overlay[23][16]}`);
console.log(`Overlay at (23,23): ${d.overlay[23][23]}`);

// Find where the castle wall heights (464+) are along x=20
console.log('\nHeights along x=20 (castle wall area):');
for (let y = 0; y < 64; y++) {
  const h = d.height[20][y];
  if (h >= 400) process.stdout.write(`y=${y}(${h}) `);
}
console.log();

// Find where heights transition from ~464 to ~240 (castle wall to courtyard)
console.log('\nCastle wall (h>=400) Y range along x=20:');
let wallStart = -1, wallEnd = -1;
for (let y = 0; y < 64; y++) {
  if (d.height[20][y] >= 400) {
    if (wallStart === -1) wallStart = y;
    wallEnd = y;
  }
}
console.log(`  Wall from y=${wallStart} to y=${wallEnd} (world Y=${3200+wallStart} to ${3200+wallEnd})`);
