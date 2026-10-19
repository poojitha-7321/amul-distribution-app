// Generates PWA icons (Android + iOS) from public/favicon.svg. Run: node scripts/make-icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url));
const out = (n) => new URL(`../public/${n}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await sharp(svg).resize(192, 192).png().toFile(out('icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(out('icon-512.png'));
await sharp(svg).resize(180, 180).flatten({ background: '#12327a' }).png().toFile(out('apple-touch-icon.png'));
// Maskable icon: artwork inside the 80% safe zone on a solid background.
const inner = await sharp(svg).resize(360, 360).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#12327a' } })
  .composite([{ input: inner, gravity: 'center' }]).png().toFile(out('icon-maskable-512.png'));
console.log('icons written');
