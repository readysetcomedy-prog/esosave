import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, waitFor, sleep, normalizeTree } from './helpers.mjs';

let T;
before(async () => { T = await launch(); });
after(async () => { if (T) await T.close(); });
beforeEach(async () => { await T.context.setOffline(false); await T.control({ loggedOut: false, rejectValue: null, failAutosaves: 0 }); });

const app = (fn, ...args) => T.page.evaluate(fn, ...args);

test('extension installs on the page and sees the run', async () => {
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor installed' });
  const id = await app(() => window.app.start());
  await waitFor(async () => (await T.status()).currentRecordId === id, { label: 'run seen' });
  const st = await T.status();
  assert.equal(st.online, true);
  assert.equal(st.hasToken, true);
  const bar = await waitFor(async () => { const b = await T.bar(); return b && /good/.test(b.cls) ? b : null; }, { label: 'bar green' });
  assert.match(bar.text, /TEST-0001/);
});

test('online saves are recorded and acknowledged, with server key remapping', async () => {
  const id = await app(() => window.app.recordId);
  const tmp = await app(() => window.app.uuid());
  await app((k) => {
    window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'Main St');
    window.app.add('vitals', `vitals.vitalSigns.['${k}']`, { vitalSignDateTime: '09/15/2026 14:12:35' });
  }, tmp);
  await waitFor(async () => (await app(() => window.app.responses.length)) >= 2, { label: 'two autosaves' });
  // the app switched to the server key, like the real one does
  await app((k) => { window.app.edit('vitals', `vitals.vitalSigns.['${k}'].pulse`, 88, 'integer'); }, tmp);
  await waitFor(async () => (await app(() => window.app.responses.length)) >= 3, { label: 'third autosave' });
  const run = await waitFor(async () => { const r = await T.run(id); return r && r.batches.length >= 3 && r.batches.every(b => b.status === 'acked') ? r : null; }, { label: 'all acked' });
  assert.equal(run.batches.filter(b => b.status === 'acked').length, 3);
  assert.ok(Object.keys(run.keyMap).includes(tmp), 'key map records the server mapping');
  const rec = await T.record(id);
  assert.equal(rec.tree.incident.scene.manualAddress.locationName, 'Main St');
  assert.equal(rec.tree.vitals.vitalSigns[0].pulse, 88);
  assert.equal((await app(() => window.app.errors)).length, 0);
  const stored = await T.storage();
  assert.ok(stored['run:' + id], 'run persisted to extension storage');
  assert.ok(stored.templates && stored.templates.views.Incident, 'blank-run template captured');
});

test('offline: saves are held, the app is told "saved", banner warns, then everything pushes in order with key remapping', async () => {
  const id = await app(() => window.app.recordId);
  const before = await T.record(id);
  await T.context.setOffline(true);
  const tmpVital = await app(() => window.app.uuid());
  const tmpTx = await app(() => window.app.uuid());
  await app(({ v, t }) => {
    window.app.edit('incident', 'incident.scene.massCasualty', false, 'boolean');
    window.app.add('vitals', `vitals.vitalSigns.['${v}']`, { vitalSignDateTime: '09/15/2026 14:20:00' });
    window.app.sign('signatures', 'signatures.billingAuthorization.sectionOne.patientSignature.strokes', [[0.1, 0.2, 0.3, 0.4]]);
  }, { v: tmpVital, t: tmpTx });
  await waitFor(async () => (await T.status()).held >= 3, { label: 'three held' });
  // the app never saw a failure
  const errs = await app(() => window.app.errors);
  assert.equal(errs.length, 0, 'app saw no errors while offline');
  const heldResp = await app(() => window.app.responses.filter(r => r.held));
  assert.ok(heldResp.length >= 3, 'app got fake success responses');
  // more edits while offline, referencing the still-temporary vital key (the app never got a server key)
  await app(({ v, t }) => {
    window.app.edit('vitals', `vitals.vitalSigns.['${v}'].pulse`, 120, 'integer');
    window.app.add('flowchartTreatments', `flowchartTreatments.treatments.['${t}']`, { treatmentId: 5 });
    window.app.edit('flowchartTreatments', `flowchartTreatments.treatments.['${t}'].provider`, 'CREWID');
  }, { v: tmpVital, t: tmpTx });
  await waitFor(async () => (await T.status()).held >= 5, { label: 'five held' });
  const bar = await T.bar();
  assert.match(bar.cls, /warn/);
  assert.match(bar.text, /NO SIGNAL/);
  assert.match(bar.text, /held/);
  const mid = await T.record(id);
  assert.equal(mid.autosaves, before.autosaves, 'nothing reached the server while offline');

  await T.context.setOffline(false);
  await waitFor(async () => { const s = await T.status(); return s.held === 0 && !s.pushing && s.online; }, { label: 'all pushed', timeout: 30000 });
  const run = await T.run(id);
  assert.equal(run.batches.filter(b => b.status === 'held' || b.status === 'rejected').length, 0);
  const rec = await T.record(id);
  assert.equal(rec.tree.incident.scene.massCasualty, false);
  const vital = rec.tree.vitals.vitalSigns.find(v => v.vitalSignDateTime === '09/15/2026 14:20:00');
  assert.ok(vital, 'offline vital arrived');
  assert.equal(vital.pulse, 120, 'edit made with the temporary key was remapped');
  assert.ok(!/^[0-9a-f-]{20,}$/.test(vital.itemId) || vital.itemId !== tmpVital, 'server key used');
  assert.equal(rec.tree.flowchartTreatments.treatments[0].provider, 'CREWID');
  assert.deepEqual(rec.tree.signatures.billingAuthorization.sectionOne.patientSignature.strokes.strokes, [[0.1, 0.2, 0.3, 0.4]]);
  const bar2 = await T.bar();
  assert.match(bar2.cls, /good/);
  // later live edits from the app still use the temporary key; they must keep being rewritten
  await app(({ v }) => { window.app.edit('vitals', `vitals.vitalSigns.['${v}'].respirations`, 16, 'integer'); }, { v: tmpVital });
  await waitFor(async () => (await T.record(id)).tree.vitals.vitalSigns.find(v => v.pulse === 120).respirations === 16, { label: 'post-recovery edit remapped' });
  assert.equal((await app(() => window.app.errors)).length, 0);
});

test('every tab is prefetched when a run opens, so an unopened tab still works offline', async () => {
  const id = await app(() => window.app.recordId);
  const run = await waitFor(async () => { const r = await T.run(id); return r && r.prefetchedAt && Object.keys(r.views).length >= 9 ? r : null; }, { label: 'all tabs prefetched', timeout: 20000 });
  assert.ok(run.views.Signatures && run.views.Billing && run.views.Narrative, 'tabs the app never opened have copies');
  await T.context.setOffline(true);
  const v = await app(() => window.app.openTab('Narrative'));
  assert.equal(v.status, 200, 'never-opened tab served from the prefetched copy');
  assert.equal(v.body.meta.esosaveOffline, true);
  await T.context.setOffline(false);
  // a tab name the extension has never seen is learned from a live load
  await app(() => window.app.openTab('CustomTab'));
  const stored = await waitFor(async () => { const s = await T.storage(); return s.knownViews && s.knownViews.includes('CustomTab') ? s.knownViews : null; }, { label: 'new tab learned' });
  assert.ok(stored.includes('CustomTab'));
});

test('offline tab switch is served from the cached view with held changes applied', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Vitals'));
  await app(() => window.app.openTab('Incident'));
  await T.context.setOffline(true);
  await app(() => { window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'Offline Ave'); });
  await waitFor(async () => (await T.status()).held >= 1, { label: 'held' });
  const v = await app(() => window.app.openTab('Incident'));
  assert.equal(v.status, 200, 'tab loaded from cache');
  assert.equal(v.body.data.model.scene.manualAddress.locationName, 'Offline Ave');
  assert.equal(v.body.meta.esosaveOffline, true);
  assert.ok(v.body.data.model.crew.length, 'crew still present');
  const vit = await app(() => window.app.openTab('Vitals'));
  assert.equal(vit.status, 200);
  assert.ok(vit.body.data.model.vitalSigns.length >= 2);
  await T.context.setOffline(false);
  await waitFor(async () => (await T.status()).held === 0, { label: 'pushed', timeout: 30000 });
  assert.equal((await T.record(id)).tree.incident.scene.manualAddress.locationName, 'Offline Ave');
});

test('a reload after an outage pushes what was held before the reload', async () => {
  const id = await app(() => window.app.recordId);
  await T.context.setOffline(true);
  await app(() => { window.app.edit('narrative', 'narrative.narrative.text', 'typed with no signal'); });
  await waitFor(async () => (await T.status()).held >= 1, { label: 'held' });
  await sleep(600); // let storage persist
  const stored = await T.storage();
  assert.ok(stored['run:' + id].batches.some(b => b.status === 'held'), 'held batch is in storage');
  await T.context.setOffline(false);
  await T.page.goto(T.url); // fresh page load, like Safari reloading the tab
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await app((i) => window.app.use(i), id); // the medic re-opens the same run
  await waitFor(async () => { const s = await T.status(); return s.ready && s.held === 0 && !s.pushing; }, { label: 'held pushed after reload', timeout: 30000 });
  assert.equal((await T.record(id)).tree.narrative.narrative.text, 'typed with no signal');
  const run = await T.run(id);
  assert.ok(run.batches.length >= 8, 'history survived the reload');
});

test('a save ESO rejects turns the banner red and stays in the list; other saves keep flowing', async () => {
  const id = await app(() => window.app.recordId);
  await T.control({ rejectValue: 'REJECT-ME' });
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'REJECT-ME'); });
  await waitFor(async () => (await T.status()).rejected >= 1, { label: 'rejected' });
  const bar = await waitFor(async () => { const b = await T.bar(); return b && /bad/.test(b.cls) ? b : null; }, { label: 'bar red' });
  assert.match(bar.text, /REJECTED/);
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'fine now'); });
  await waitFor(async () => (await T.record(id)).tree.incident.scene.callNature === 'fine now', { label: 'later save flowed' });
  await T.control({ rejectValue: null });
  await app((i) => window.postMessage({ __esosave: 'to-page', type: 'action', payload: { name: 'dropRejected', recordId: i } }, location.origin), id);
  await waitFor(async () => (await T.status()).rejected === 0, { label: 'dropped' });
  await waitFor(async () => /good/.test((await T.bar()).cls), { label: 'bar green again' });
});

test('restore: push a whole recorded run into a brand-new run, crew and item keys remapped', async () => {
  const srcId = await app(() => window.app.recordId);
  // reference the crew member the way signatures do
  const crewItemId = (await T.record(srcId)).crew[0].itemId;
  await app((c) => { window.app.edit('signatures', 'signatures.standardSignatures.providerSignatures.firstProviderId', c, 'singleselect'); }, crewItemId);
  await waitFor(async () => (await T.record(srcId)).tree.signatures?.standardSignatures?.providerSignatures?.firstProviderId === crewItemId, { label: 'crew ref saved' });
  const src = await T.record(srcId);
  const beforeCount = (await T.records()).length;
  await app((i) => window.postMessage({ __esosave: 'to-page', type: 'action', payload: { name: 'pushIntoNew', recordId: i } }, location.origin), srcId);
  const list = await waitFor(async () => { const l = await T.records(); return l.length > beforeCount ? l : null; }, { label: 'new run created' });
  const newId = list[list.length - 1].id;
  await waitFor(async () => { const s = await T.status(); const r = s.runs.find(x => x.recordId === newId); return r && r.counts.held === 0 && !s.pushing; }, { label: 'restore pushed', timeout: 30000 });
  const dst = await T.record(newId);
  const held = (await T.run(newId)).batches.filter(b => b.status === 'rejected');
  assert.equal(held.length, 0, 'no rejected batches on restore: ' + JSON.stringify(held.map(b => b.error)));
  assert.notEqual(dst.crew[0].itemId, src.crew[0].itemId);
  assert.equal(dst.tree.signatures.standardSignatures.providerSignatures.firstProviderId, dst.crew[0].itemId, 'crew reference points at the new run\'s crew row');
  assert.deepEqual(normalizeTree(dst.tree, dst.crew), normalizeTree(src.tree, src.crew), 'new run has the same content as the old one');
});

test('locking a run marks it and it is cleared from the device after the retention window', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.lock());
  await waitFor(async () => { const r = (await T.status()).runs.find(x => x.recordId === id); return r && r.locked; }, { label: 'locked seen' });
  await sleep(500);
  await T.setStorage({ settings: { purgeHoursAfterLock: 0 } });
  await T.page.goto(T.url);
  await waitFor(async () => !(await T.storage())['run:' + id], { label: 'purged' });
});

test('a run started with no signal is created on ESO when signal returns and its saves follow', async () => {
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await waitFor(async () => (await T.status()).hasToken || true);
  await app(() => window.app.attachments().catch(() => null)).catch(() => null); // any live call so the token is known
  await T.context.setOffline(true);
  const tmpId = await app(() => window.app.start());
  assert.match(tmpId, /^esosave-/, 'temporary run id issued offline');
  const tmpVital = await app(() => window.app.uuid());
  await app((v) => {
    window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'Started offline');
    window.app.add('vitals', `vitals.vitalSigns.['${v}']`, { vitalSignDateTime: '09/15/2026 15:00:00' });
    window.app.edit('vitals', `vitals.vitalSigns.['${v}'].pulse`, 70, 'integer');
  }, tmpVital);
  await waitFor(async () => (await T.status()).held >= 3, { label: 'held for temp run' });
  const v = await app(() => window.app.openTab('Vitals'));
  assert.equal(v.status, 200, 'view served offline (template or synthesized)');
  assert.equal(v.body.data.model.vitalSigns[0].pulse, 70);
  const inc = await app(() => window.app.openTab('Incident'));
  assert.equal(inc.status, 200, 'incident template served offline');
  assert.equal(inc.body.data.model.scene.manualAddress.locationName, 'Started offline');
  assert.ok(inc.body.data.model.crew.length, 'template carries the crew');
  await T.context.setOffline(false);
  await waitFor(async () => { const s = await T.status(); const r = s.runs.find(x => x.recordId === tmpId); return r && r.realId && r.counts.held === 0 && !s.pushing; }, { label: 'created and pushed', timeout: 30000 });
  const realId = (await T.status()).runs.find(x => x.recordId === tmpId).realId;
  const rec = await T.record(realId);
  assert.equal(rec.tree.incident.scene.manualAddress.locationName, 'Started offline');
  assert.equal(rec.tree.vitals.vitalSigns[0].pulse, 70);
  // the app still uses the temporary id in its URLs; those must be rewritten
  const live = await app(() => window.app.openTab('Incident'));
  assert.equal(live.status, 200);
  assert.equal(live.body.data.model.response.incidentNumber, rec.incidentNumber);
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'after creation'); });
  await waitFor(async () => (await T.record(realId)).tree.incident.scene.callNature === 'after creation', { label: 'live save with temp id in url' });
});

test('logged out: saves are held and pushed after logging back in', async () => {
  const id = await app(() => window.app.recordId);
  const status = await T.status();
  const run = status.runs.find(r => r.recordId === id);
  const realId = run.realId || id;
  await T.control({ loggedOut: true });
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'while logged out'); });
  await waitFor(async () => { const s = await T.status(); return s.loggedOut && s.held >= 1; }, { label: 'held while logged out' });
  assert.match((await T.bar()).text, /LOGGED OUT/);
  await T.control({ loggedOut: false });
  await waitFor(async () => { const s = await T.status(); return !s.loggedOut && s.held === 0; }, { label: 'pushed after login', timeout: 30000 });
  assert.equal((await T.record(realId)).tree.incident.scene.callNature, 'while logged out');
});

test('gateway errors (502) are treated like no signal', async () => {
  const id = await app(() => window.app.recordId);
  const realId = (await T.status()).runs.find(r => r.recordId === id).realId || id;
  const errsBefore = (await app(() => window.app.errors)).length;
  await T.control({ failAutosaves: 1 });
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'through a 502'); });
  await waitFor(async () => (await T.record(realId)).tree.incident.scene.callNature === 'through a 502', { label: 'recovered from 502', timeout: 30000 });
  assert.equal((await app(() => window.app.errors)).length, errsBefore, 'app never saw the 502');
});

test('signature canvases are snapshotted when the pen lifts', async () => {
  const id = await app(() => window.app.recordId);
  const box = await T.page.locator('#sig').boundingBox();
  await T.page.mouse.move(box.x + 10, box.y + 50);
  await T.page.mouse.down();
  await T.page.mouse.move(box.x + 100, box.y + 20, { steps: 5 });
  await T.page.mouse.move(box.x + 200, box.y + 80, { steps: 5 });
  await T.page.mouse.up();
  const sigs = await waitFor(async () => { const s = await T.storage(); const k = Object.keys(s).find(k => k.startsWith('sigs:')); return k && s[k].length ? s[k] : null; }, { label: 'signature snapshot stored' });
  assert.match(sigs[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(sigs[0].label, 'Signature');
  assert.equal(sigs[0].recordId, id);
});

test('an identical batch re-sent by the app while the first is still held is not queued twice', async () => {
  const id = await app(() => window.app.recordId);
  const realId = (await T.status()).runs.find(r => r.recordId === id).realId || id;
  await T.context.setOffline(true);
  const k = await app(() => window.app.uuid());
  await app((k) => { window.app.add('vitals', `vitals.vitalSigns.['${k}']`, { vitalSignDateTime: 'dup-test' }); }, k);
  await waitFor(async () => (await T.status()).held >= 1, { label: 'held' });
  await app((k) => { window.app.add('vitals', `vitals.vitalSigns.['${k}']`, { vitalSignDateTime: 'dup-test' }); }, k);
  await sleep(800);
  await T.context.setOffline(false);
  await waitFor(async () => (await T.status()).held === 0, { label: 'pushed', timeout: 30000 });
  const rec = await T.record(realId);
  assert.equal(rec.tree.vitals.vitalSigns.filter(v => v.vitalSignDateTime === 'dup-test').length, 1);
});
