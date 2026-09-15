/* Replays a real recording of the ESO app (a HAR converted to JSON, kept OUT of the repo) through
 * the mock: once online as the baseline, once with every autosave held offline and pushed by the
 * extension afterwards. Both runs must end up identical.
 *
 *   ESOSAVE_RECORDING=/path/to/recording.json node --test test/recording.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch, waitFor, normalizeTree } from './helpers.mjs';

const file = process.env.ESOSAVE_RECORDING;
const skip = file ? false : 'set ESOSAVE_RECORDING to a scrubbed recording to run this';

let T, batches;
before(async () => {
  if (skip) return;
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  // ESO answered each ADD with {originalKey,newKey}; later batches use newKey. Map them back to the
  // app's temporary keys so the sequence can be replayed against a server that assigns its own keys.
  const esoToTemp = {};
  for (const e of rec) if (e.url.includes('/autosave') && e.response && Array.isArray(e.response.data)) for (const m of e.response.data) esoToTemp[m.newKey] = m.originalKey;
  const re = Object.keys(esoToTemp).length ? new RegExp(Object.keys(esoToTemp).join('|'), 'g') : null;
  batches = rec.filter(e => e.url.includes('/autosave') && Array.isArray(e.body)).map(e => ({
    scope: /scope=([^&]+)/.exec(e.url)[1],
    ops: JSON.parse(re ? JSON.stringify(e.body).replace(re, k => esoToTemp[k]) : JSON.stringify(e.body)),
  }));
  T = await launch();
});
after(async () => { if (T) await T.close(); });

async function feed(offline) {
  const page = T.page;
  await page.goto(T.url);
  await waitFor(() => page.evaluate(() => !!window.__esosave));
  const id = await page.evaluate(() => window.app.start());
  const crew = (await T.record(id)).crew[0].itemId;
  if (offline) await T.context.setOffline(true);
  // crew references in the recording point at the recorded run's crew row; point them at ours
  const recCrew = batches.flatMap(b => b.ops).map(o => o.value).find(v => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) && batches.some(b => b.ops.some(o => /firstProviderId|provider$/i.test(o.address) && o.value === v)));
  for (const b of batches) {
    const ops = JSON.parse(JSON.stringify(b.ops).split(recCrew || '__none__').join(crew));
    await page.evaluate(({ scope, ops }) => { for (const op of ops) window.app.dirty.push({ scope, op }); }, { scope: b.scope, ops });
    await page.evaluate(() => window.app.flush());
  }
  if (offline) {
    await waitFor(async () => (await T.status()).held >= 1, { label: 'held' });
    await T.context.setOffline(false);
  }
  await waitFor(async () => { const s = await T.status(); return s.held === 0 && !s.pushing; }, { label: 'all pushed', timeout: 60000 });
  const errors = await page.evaluate(() => window.app.errors);
  const run = await T.run(id);
  return { id, errors, rejected: run.batches.filter(b => b.status === 'rejected').map(b => b.error), record: await T.record(id) };
}

test('real recorded run: offline-held replay produces the same record as the online run', { skip }, async () => {
  const online = await feed(false);
  assert.deepEqual(online.errors, [], 'baseline had no errors');
  assert.deepEqual(online.rejected, []);
  const offline = await feed(true);
  assert.deepEqual(offline.errors, [], 'app saw no errors while offline');
  assert.deepEqual(offline.rejected, [], 'nothing rejected on push');
  assert.equal(offline.record.autosaves, online.record.autosaves, 'same number of batches reached the server');
  assert.deepEqual(normalizeTree(offline.record.tree, offline.record.crew), normalizeTree(online.record.tree, online.record.crew));
  console.log(`replayed ${batches.length} recorded batches, ${batches.reduce((n, b) => n + b.ops.length, 0)} field operations`);
});
