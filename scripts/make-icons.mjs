// Usage: node scripts/make-icons.mjs path/to/logo.png  (square artwork on a white background)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync(process.argv[2]).toString('base64');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const out = await page.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H); const px = d.data;
  // flood-fill near-white from the outside edges -> transparent (keeps the white shield inside)
  const isWhite = (i) => px[i] > 232 && px[i + 1] > 232 && px[i + 2] > 232;
  const seen = new Uint8Array(W * H); const stack = [];
  for (let x = 0; x < W; x++) { stack.push(x, 0, x, H - 1); } for (let y = 0; y < H; y++) { stack.push(0, y, W - 1, y); }
  while (stack.length) { const y = stack.pop(), x = stack.pop(); if (x < 0 || y < 0 || x >= W || y >= H) continue; const k = y * W + x; if (seen[k]) continue; seen[k] = 1; const i = k * 4; if (!isWhite(i)) continue; px[i + 3] = 0; stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1); }
  // soften the edge: pixels adjacent to transparent get partial alpha based on whiteness
  ctx.putImageData(d, 0, 0);
  // bounds of the opaque area
  // bounds of the solid artwork only (ignores the pale drop shadow around it)
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (px[i + 3] && px[i + 1] - Math.max(px[i], px[i + 2]) > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
  const bw = maxX - minX + 1, bh = maxY - minY + 1, side = Math.max(bw, bh);
  const cropped = document.createElement('canvas'); cropped.width = side; cropped.height = side;
  cropped.getContext('2d').drawImage(c, minX, minY, side, side, 0, 0, side, side);
  const render = (size, opaqueBg) => {
    const o = document.createElement('canvas'); o.width = size; o.height = size; const g = o.getContext('2d');
    if (opaqueBg) { g.fillStyle = opaqueBg; g.fillRect(0, 0, size, size); }
    // step-down scaling for quality
    let cur = cropped; let s = side;
    while (s / 2 > size) { const t = document.createElement('canvas'); t.width = t.height = Math.round(s / 2); t.getContext('2d').drawImage(cur, 0, 0, t.width, t.height); cur = t; s = t.width; }
    g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, size, size);
    return o.toDataURL('image/png').split(',')[1];
  };
  // iOS app icon: opaque, the rounded square scaled to fill; iOS applies its own mask
  const ios = (() => {
    const size = 1024; const o = document.createElement('canvas'); o.width = o.height = size; const g = o.getContext('2d');
    // sample the corner colour of the logo to fill behind the rounded corners
    const sc = c.getContext('2d').getImageData(minX + 40, minY + Math.round(bh / 2), 1, 1).data;
    g.fillStyle = `rgb(${sc[0]},${sc[1]},${sc[2]})`; g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = 'high'; g.drawImage(cropped, 0, 0, size, size);
    return o.toDataURL('image/png').split(',')[1];
  })();
  return { bounds: [minX, minY, bw, bh], sizes: Object.fromEntries([16, 32, 48, 128, 256, 512].map(s => [s, render(s)])), ios, splash: render(512) };
}, src);
await browser.close();
console.log('bounds', out.bounds);
for (const [s, b64] of Object.entries(out.sizes)) { if (s !== '512') writeFileSync(`extension/icons/icon${s}.png`, Buffer.from(b64, 'base64')); }
writeFileSync('extension/icons/logo.png', Buffer.from(out.sizes[512], 'base64'));
writeFileSync('ios-app/assets/icon.png', Buffer.from(out.ios, 'base64'));
writeFileSync('ios-app/assets/splash-icon.png', Buffer.from(out.splash, 'base64'));
console.log('written');
