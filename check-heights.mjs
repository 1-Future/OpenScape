import fs from 'fs';

// Check several regions around Lumbridge
const regions = [
  [50, 50, 'Lumbridge castle'],
  [50, 49, 'South of Lumbridge (swamp)'],
  [49, 50, 'West of Lumbridge'],
  [51, 50, 'East of Lumbridge'],
  [50, 51, 'North of Lumbridge'],
];

for (const [rx, ry, label] of regions) {
  const file = `data/tile-data/${rx}_${ry}.json`;
  if (!fs.existsSync(file)) { console.log(`${label} (${rx},${ry}): NO DATA`); continue; }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) {
    const h = d.height[x][y];
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
    count++;
  }
  console.log(`${label} (${rx},${ry}): min=${min} max=${max} avg=${Math.round(sum/count)}`);
}

// Verify byte transfer: simulate what server does
console.log('\n--- Byte transfer test ---');
const d = JSON.parse(fs.readFileSync('data/tile-data/50_50.json', 'utf8'));
const heights = new Uint16Array(64 * 64);
for (let x = 0; x < 64; x++)
  for (let y = 0; y < 64; y++)
    heights[y * 64 + x] = d.height[x][y] || 0;

// Simulate base64 encode/decode
const b64 = Buffer.from(heights.buffer).toString('base64');
const decoded = Buffer.from(b64, 'base64');
const decoded16 = new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);

// Check a few values
const checks = [[22, 18], [0, 0], [32, 32], [10, 10], [55, 55]];
for (const [x, y] of checks) {
  const orig = d.height[x][y] || 0;
  const stored = heights[y * 64 + x];
  const after = decoded16[y * 64 + x];
  console.log(`  (${x},${y}): original=${orig} stored=${stored} after_b64=${after} ${orig === after ? 'OK' : 'MISMATCH!'}`);
}

// Check: what does castle area look like? (around 3222,3218 → local 22,18)
console.log('\n--- Height grid near castle (local 18-30 x, 14-22 y) ---');
for (let y = 22; y >= 14; y--) {
  let row = `y=${String(y).padStart(2)}: `;
  for (let x = 18; x <= 30; x++) {
    row += String(d.height[x][y] || 0).padStart(4);
  }
  console.log(row);
}
