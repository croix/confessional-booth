// Rasterize public/crest.svg into a gold PNG for the Stream Deck keys.
//   node scripts/render-crest.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLD = '#c9a961';

let svg = readFileSync(join(ROOT, 'public', 'crest.svg'), 'utf8');
// Tint every fill to the gold, but keep any fill="none" outlines transparent.
svg = svg
  .replace(/#[0-9a-fA-F]{6}\b/g, GOLD)
  .replace(/fill\s*:\s*(?!none)[^;"'}]+/gi, `fill:${GOLD}`)
  .replace(/fill\s*=\s*"(?!none)[^"]*"/gi, `fill="${GOLD}"`);

const out = join(ROOT, 'public', 'crest-key.png');
await sharp(Buffer.from(svg), { density: 300 })
  .resize({ height: 216, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(out);
console.log('rendered gold crest ->', out);
