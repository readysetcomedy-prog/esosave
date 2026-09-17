import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockEso } from './mock-eso/server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT = process.env.ESOSAVE_EXT_DIR || join(root, 'dist', 'test');

export async function launch() {
  const mock = createMockEso();
  const base = await mock.listen();
  const userDataDir = mkdtempSync(join(tmpdir(), 'esosave-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const api = {
    mock, base, context, page, sw, userDataDir,
    url: base + '/ehr/',
    control: (c) => fetch(base + '/__control', { method: 'POST', body: JSON.stringify(c) }).then(r => r.json()),
    record: (id) => fetch(base + '/__record/' + id).then(r => r.json()),
    records: () => fetch(base + '/__records').then(r => r.json()),
    shape: (id, body) => fetch(base + '/__shape/' + id, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
    faxes: () => fetch(base + '/__faxes').then(r => r.json()),
    storage: () => sw.evaluate(() => new Promise(res => chrome.storage.local.get(null, res))),
    setStorage: (obj) => sw.evaluate((o) => new Promise(res => chrome.storage.local.set(o, res)), obj),
    status: (p = page) => p.evaluate(() => window.__esosave.status()),
    run: (id, p = page) => p.evaluate((i) => window.__esosave.run(i), id),
    bar: (p = page) => p.evaluate(() => { const h = document.getElementById('esosave-host'); const b = h && h.shadowRoot.querySelector('.bar'); return b ? { cls: b.className, text: b.textContent } : null; }),
    close: async () => { await context.close(); await mock.close(); rmSync(userDataDir, { recursive: true, force: true }); },
  };
  return api;
}

export async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Strip server-assigned keys so two runs can be compared structurally.
export function normalizeTree(tree, crew) {
  const crewIds = new Set((crew || []).map(c => c.itemId));
  const s = JSON.stringify(tree, (k, v) => {
    if (typeof v === 'string') { if (crewIds.has(v)) return 'CREW'; if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'KEY'; }
    return v;
  });
  return JSON.parse(s);
}
