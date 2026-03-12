// Classify OSRS world map tiles into tagged tile types
// Downloads map tiles from maps.runescape.wiki at zoom level 2 (1 tile = 4x4 pixels)
// Outputs: data/tagged-tiles/{tx}_{ty}.json with tile type per game coordinate

import { createCanvas, loadImage } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';
import https from 'https';
import { execSync } from 'child_process';

const OUT_DIR = './data/tagged-tiles';
const CACHE_DIR = './data/map-tiles/cache';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Tile type tags
const TAG = {
  GRASS: 0,
  WATER: 1,
  TREE: 2,
  PATH: 3,
  SAND: 4,
  WALL: 5,
  FLOOR: 6,     // building interior / light surface
  DARK: 7,      // dark wall / structure
  ROCK: 8,
  SWAMP: 9,
  DOOR: 10,     // red dots on map = interactive points
  FENCE: 11,    // thin wall lines
  ICON: 12,     // map icons (various colors)
  VOID: 13,     // black/empty (outside map)
};

const TAG_NAMES = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));

// Map tile config
const BASE_URL = 'https://maps.runescape.wiki/osrs/tiles/0_2019-10-31_1/2/0_';
const ZOOM = 2;
const PX_PER_TILE = 4; // at zoom 2, each game tile = 4x4 pixels

// World bounds at zoom 2 (surface map): x tiles 16-62, y tiles 37-65
const TX_MIN = 16, TX_MAX = 62;
const TY_MIN = 37, TY_MAX = 65;

function downloadTile(tx, ty) {
  const cacheFile = path.join(CACHE_DIR, `${tx}_${ty}.png`);
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
    return cacheFile;
  }
  const url = `${BASE_URL}${tx}_${ty}.png`;
  try {
    execSync(`curl -sL -o "${cacheFile}" -w "%{http_code}" "${url}"`, { encoding: 'utf8' });
    if (!fs.existsSync(cacheFile) || fs.statSync(cacheFile).size < 100) {
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
      return null;
    }
    return cacheFile;
  } catch (e) {
    return null;
  }
}

// Classify a single pixel RGB into a tile tag
function classifyPixel(r, g, b) {
  // Void / outside map (pure black or very dark uniform)
  if (r < 5 && g < 5 && b < 5) return TAG.VOID;

  // Red dots = doors/interactive points
  if (r > 150 && g < 60 && b < 60) return TAG.DOOR;

  // Building floor / very light surfaces
  if (r > 190 && g > 180 && b > 170) return TAG.FLOOR;

  // Water - distinctive blue-grey, B channel dominates
  if (b > 90 && b > r * 1.2 && b > g) return TAG.WATER;

  // Sand/desert - golden/yellow tones
  if (r > 140 && g > 90 && b < 90 && r > b * 2) return TAG.SAND;
  // Darker sand edge
  if (r > 90 && g > 80 && b > 40 && b < 70 && r - b > 30 && g - b > 25 && r > 90) return TAG.SAND;

  // Dark structures (very dark, nearly black)
  if (r < 35 && g < 35 && b < 35) return TAG.DARK;

  // Grey walls/buildings - R≈G≈B in mid range
  const maxRGB = Math.max(r, g, b);
  const minRGB = Math.min(r, g, b);
  if (maxRGB - minRGB < 20 && r > 45 && r < 110 && b > 40) return TAG.WALL;

  // Trees - green where G clearly dominates R, and B is low
  // Key tree colors: (42,88,18), (79,108,53)
  if (g > 70 && g > r * 1.4 && b < g * 0.7 && b < 60) return TAG.TREE;
  // Darker trees
  if (g > 55 && g > r * 1.5 && b < 25) return TAG.TREE;

  // Path/dirt - brown, R > G >> B
  if (r > 40 && r > g * 1.3 && b < 30 && g < 70) return TAG.PATH;
  // Lighter brown paths
  if (r > 60 && g > 40 && b < 40 && r > g * 1.1 && r - b > 30) return TAG.PATH;

  // Swamp - very dark green-brown
  if (r < 65 && g < 65 && b < 20 && g > r) return TAG.SWAMP;

  // Default: grass (yellowish-green is the most common terrain)
  return TAG.GRASS;
}

// Process a single tile image into 64x64 tile tags
async function processTile(tx, ty) {
  const file = await downloadTile(tx, ty);
  if (!file) return null;

  const img = await loadImage(file);
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, 256, 256).data;

  const tags = new Array(64);

  for (let gx = 0; gx < 64; gx++) {
    tags[gx] = new Array(64);
    for (let gy = 0; gy < 64; gy++) {
      // Each game tile = 4x4 pixel block
      // gx maps to pixel columns gx*4 to gx*4+3
      // gy maps to pixel rows (63-gy)*4 to (63-gy)*4+3 (Y inverted)
      const px0 = gx * PX_PER_TILE;
      const py0 = (63 - gy) * PX_PER_TILE;

      // Sample center 2x2 of the 4x4 block (avoids edge artifacts)
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = 1; dy <= 2; dy++) {
        for (let dx = 1; dx <= 2; dx++) {
          const px = px0 + dx;
          const py = py0 + dy;
          const off = (py * 256 + px) * 4;
          rSum += pixels[off];
          gSum += pixels[off + 1];
          bSum += pixels[off + 2];
          count++;
        }
      }

      const r = Math.round(rSum / count);
      const g = Math.round(gSum / count);
      const b = Math.round(bSum / count);

      tags[gx][gy] = classifyPixel(r, g, b);
    }
  }

  return tags;
}

// Main: process all tiles
async function main() {
  const mode = process.argv[2]; // 'test' for single tile, 'all' for everything

  if (mode === 'test') {
    // Test with specified tile or default Lumbridge
    const tx = parseInt(process.argv[3]) || 50;
    const ty = parseInt(process.argv[4]) || 50;
    console.log(`Processing tile (${tx}, ${ty}) - Lumbridge...`);
    const tags = await processTile(tx, ty);
    if (!tags) { console.log('Failed!'); return; }

    // Print ASCII grid (top = north = high game Y)
    const chars = '.~T#:W_[]!+*?X'.split(''); // index = tag value
    console.log('\nTag map (. grass, ~ water, T tree, # path, : sand, W wall, _ floor, [ dark, ! door):');
    for (let gy = 63; gy >= 0; gy--) {
      let row = '';
      for (let gx = 0; gx < 64; gx++) {
        row += chars[tags[gx][gy]] || '?';
      }
      console.log(row);
    }

    // Stats
    const counts = {};
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const t = tags[x][y];
        counts[TAG_NAMES[t]] = (counts[TAG_NAMES[t]] || 0) + 1;
      }
    }
    console.log('\nTag counts:', counts);

    // Save
    const outFile = path.join(OUT_DIR, `${tx}_${ty}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ tx, ty, tags }));
    console.log(`Saved: ${outFile}`);
    return;
  }

  // Full extraction
  let processed = 0, skipped = 0;
  const totalTiles = (TX_MAX - TX_MIN + 1) * (TY_MAX - TY_MIN + 1);
  console.log(`Processing ${totalTiles} potential tiles...`);

  for (let ty = TY_MIN; ty <= TY_MAX; ty++) {
    for (let tx = TX_MIN; tx <= TX_MAX; tx++) {
      try {
        const tags = await processTile(tx, ty);
        if (!tags) { skipped++; continue; }

        const outFile = path.join(OUT_DIR, `${tx}_${ty}.json`);
        fs.writeFileSync(outFile, JSON.stringify({ tx, ty, tags }));
        processed++;
        if (processed % 50 === 0) console.log(`  ${processed} tiles processed...`);
      } catch (e) {
        skipped++;
      }
    }
  }

  console.log(`Done! ${processed} tiles classified, ${skipped} skipped.`);
}

main().catch(console.error);
