import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, waitFor, sleep, normalizeTree } from './helpers.mjs';

let T;
before(async () => { T = await launch(); });
after(async () => { if (T) await T.close(); });
beforeEach(async () => { await T.context.setOffline(false); await T.control({ loggedOut: false, rejectValue: null, failAutosaves: 0 }); });

const app = (fn, ...args) => T.page.evaluate(fn, ...args);
// A fresh page and a fresh run, with the tab warm-up finished, so a test does not inherit clicks
// or tab state from the one before it.
async function freshRun() {
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  const id = await app(() => window.app.start());
  await waitFor(async () => { const r = await T.run(id); return r && r.log.some(l => /Opened \d+ tabs? once/.test(l.msg)) && r.prefetchedAt ? r : null; }, { label: 'warm-up done', timeout: 30000 });
  return id;
}

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

test('every tab and its companion requests are prefetched when a run opens, so an unopened tab works offline', async () => {
  const id = await app(() => window.app.recordId);
  const run = await waitFor(async () => { const r = await T.run(id); return r && r.prefetchedAt && Object.keys(r.views).length >= 9 ? r : null; }, { label: 'all tabs prefetched', timeout: 20000 });
  assert.ok(run.views.Signatures && run.views.Billing && run.views.Narrative, 'tabs the app never opened have copies');
  await T.context.setOffline(true);
  const v = await app(() => window.app.openTab('Vitals'));
  assert.equal(v.status, 200, 'never-opened tab served from the prefetched copy');
  assert.equal(v.body.meta.esosaveOffline, true);
  assert.equal(v.companions[0].status, 200, 'companion request (cardiac monitor) served from the prefetched copy');
  const p = await app(() => window.app.openTab('Patient'));
  assert.equal(p.status, 200);
  assert.equal(p.companions[0].status, 200, 'POST companion served from the prefetched copy');
  const a = await app(() => window.app.openTab('Assessments'));
  assert.equal(a.status, 200, 'tab whose request carries a query string is served');
  await T.context.setOffline(false);
  // a tab the extension has never seen, with its own companion request, is learned from one live load
  await app(() => window.app.openTab('CustomTab'));
  const learned = await waitFor(async () => { const s = await T.storage(); const l = s.tabRequests && s.tabRequests.CustomTab; return l && l.length >= 2 ? l : null; }, { label: 'new tab and companion learned' });
  assert.ok(learned.some(r => /custom\/lookup/.test(r.url) && r.url.includes('{id}')), 'companion recorded as a template: ' + JSON.stringify(learned));
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

test('the extension clicks through every tab once after a run opens, then returns to the original tab', async () => {
  const id = await freshRun();
  const clicks = await waitFor(async () => { const c = await app(() => window.app.clicks); return c.length >= 9 ? c : null; }, { label: 'tabs clicked', timeout: 30000 });
  for (const v of ['Patient', 'Vitals', 'FlowchartTreatments', 'Assessments', 'Narrative', 'Forms', 'Billing', 'Signatures']) assert.ok(clicks.includes(v), 'clicked ' + v);
  assert.equal(clicks[clicks.length - 1], 'Incident', 'returned to the tab the medic was on');
  const active = await app(() => document.querySelector('.tab.active').dataset.view);
  assert.equal(active, 'Incident');
  const run = await waitFor(async () => { const r = await T.run(id); return r.log.some(l => /Opened 8 tabs once/.test(l.msg)) ? r : null; }, { label: 'warm-up logged' });
  assert.ok(run);
  const veilGone = await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil')), { label: 'overlay removed' });
  assert.ok(veilGone);
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
  const srcId = await freshRun();
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

test('restore can copy only the chosen pages: incident and narrative go, patient and signatures stay blank', async () => {
  const srcId = await freshRun();
  await app(() => {
    window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'Shared Scene');
    window.app.edit('narrative', 'narrative.narrative.text', 'shared story');
    window.app.edit('patient', 'patient.demographics.lastName', 'FIRSTPATIENT');
    window.app.sign('signatures', 'signatures.billingAuthorization.sectionOne.patientSignature.strokes', [[1, 2]]);
  });
  await waitFor(async () => { const r = await T.record(srcId); return r.tree.signatures && r.tree.patient && r.tree.narrative && r.tree.incident; }, { label: 'source saved' });
  const before = (await T.records()).length;
  // the panel's picker sends the chosen pages along with the action
  await app((i) => window.postMessage({ __esosave: 'to-page', type: 'action', payload: { name: 'pushIntoNew', recordId: i, pages: ['incident', 'narrative'] } }, location.origin), srcId);
  const list = await waitFor(async () => { const l = await T.records(); return l.length > before ? l : null; }, { label: 'new run created' });
  const newId = list[list.length - 1].id;
  await waitFor(async () => { const s = await T.status(); const r = s.runs.find(x => x.recordId === newId); return r && r.counts.held === 0 && !s.pushing && r.counts.total > 0; }, { label: 'copy pushed', timeout: 30000 });
  const dst = await T.record(newId);
  assert.equal(dst.tree.incident.scene.manualAddress.locationName, 'Shared Scene');
  assert.equal(dst.tree.narrative.narrative.text, 'shared story');
  assert.equal(dst.tree.patient, undefined, 'patient not copied');
  assert.equal(dst.tree.signatures, undefined, 'signatures not copied');
  const status = await T.status();
  assert.deepEqual(status.runs.find(r => r.recordId === srcId).pages, { incident: 1, narrative: 1, patient: 1, signatures: 1 });
});

test('the page picker opens from the panel with Incident and Narrative on, warns on Patient or Signatures, and Toggle all selects every page', async () => {
  const id = await app(() => window.app.recordId);
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=open]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.panel .run')), { label: 'panel' });
  await T.page.evaluate((i) => { const p = document.getElementById('esosave-host').shadowRoot; [...p.querySelectorAll('.run')].find(r => r.dataset.id === i).querySelector('[data-act=into-new]').click(); }, id);
  const state = () => T.page.evaluate(() => { const p = document.getElementById('esosave-host').shadowRoot.querySelector('.pick'); return p && { on: [...p.querySelectorAll('.sw.on')].map(b => b.dataset.page), warn: !!p.querySelector('.warn'), go: p.querySelector('[data-act=go]').textContent }; });
  let st = await waitFor(state, { label: 'picker open' });
  assert.deepEqual(st.on, ['incident', 'narrative']);
  assert.equal(st.warn, false);
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.pick .sw[data-page=signatures]').click());
  st = await state();
  assert.ok(st.on.includes('signatures'));
  assert.equal(st.warn, true, 'warning shown once signatures is on');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.pick [data-act=all]').click());
  st = await state();
  assert.deepEqual(st.on, ['incident', 'patient', 'narrative', 'signatures'], 'toggle all turns on every page that has saves');
  assert.match(st.go, /Push 4 pages/);
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.pick [data-act=cancel]').click());
});

test('a copy button on a saved vital re-enters it as a new vital with the current time', async () => {
  const id = await freshRun();
  const k = await app(() => window.app.uuid());
  await app((k) => {
    window.app.add('vitals', `vitals.vitalSigns.['${k}']`, { vitalSignDateTime: '09/16/2026 15:39:12' });
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].bloodPressure.bloodPressureSystolic`, '120');
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].bloodPressure.bloodPressureDiastolic`, '80');
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].pulse.pulseRate`, '72');
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].glasgowComaScale.glascowComaTotalScore`, 15, 'integer');
    window.app.addScalar('vitals', `vitals.vitalSigns.['${k}'].glasgowComaScale.glasgowComaQualifierIds.['5690']`, 5690);
  }, k);
  await waitFor(async () => (await T.record(id)).tree.vitals?.vitalSigns?.[0]?.pulse?.pulseRate === '72', { label: 'vital saved' });
  await app(() => window.app.openTab('Vitals'));
  await waitFor(() => T.page.evaluate(() => !!document.querySelector('button.esosave-copy')), { label: 'copy button injected' });
  const btn = await T.page.evaluate(() => { const b = document.querySelector('button.esosave-copy'); return { time: b.dataset.time, next: b.nextElementSibling.textContent }; });
  assert.equal(btn.time, '15:39:12');
  assert.equal(btn.next, '15:39:12', 'button sits right in front of the time');
  await T.page.click('button.esosave-copy');
  const rec = await waitFor(async () => { const r = await T.record(id); return r.tree.vitals.vitalSigns.length === 2 ? r : null; }, { label: 'second vital on ESO', timeout: 20000 });
  const [a, b] = rec.tree.vitals.vitalSigns;
  assert.equal(b.bloodPressure.bloodPressureSystolic, '120');
  assert.equal(b.bloodPressure.bloodPressureDiastolic, '80');
  assert.equal(b.pulse.pulseRate, '72');
  assert.equal(b.glasgowComaScale.glascowComaTotalScore, 15);
  assert.deepEqual(b.glasgowComaScale.glasgowComaQualifierIds, [5690]);
  assert.notEqual(b.vitalSignDateTime, a.vitalSignDateTime, 'new time');
  assert.notEqual(b.itemId, a.itemId);
  // the field naming matched what the app itself uses
  const op = rec.ops.find(o => /pulse\.pulseRate$/.test(o.address) && o.address.includes(b.itemId));
  assert.equal(op.fieldRef, 'PULSERATE'); assert.equal(op.dataType, 'string');
  // the tab was refreshed so the new row shows, with its own copy button
  await waitFor(() => T.page.evaluate(() => document.querySelectorAll('button.esosave-copy').length === 2), { label: 'two rows with copy buttons' });
  await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil')), { label: 'overlay gone' });
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
  await waitFor(async () => /LOGGED OUT/.test((await T.bar()).text), { label: 'card says logged out' });
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

test('the card collapses to the logo, expands on tap, and re-expands by itself when signal drops', async () => {
  const q = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return el ? { cls: el.className, html: el.innerHTML.slice(0, 200) } : null; }, sel);
  await waitFor(async () => (await q('.bar')) && !/collapsed/.test((await q('.bar')).cls), { label: 'expanded card' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.fold').click());
  let b = await waitFor(async () => { const x = await q('.bar'); return x && /collapsed/.test(x.cls) ? x : null; }, { label: 'collapsed' });
  assert.match(b.html, /icons\/logo\.png/, 'collapsed card shows the logo');
  const stored = await T.storage();
  assert.equal(stored.settings.cardCollapsed, true, 'collapsed state remembered');
  await T.context.setOffline(true);
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'collapsed test'); });
  b = await waitFor(async () => { const x = await q('.bar'); return x && !/collapsed/.test(x.cls) && /warn/.test(x.cls) ? x : null; }, { label: 'auto-expanded on no signal', timeout: 20000 });
  await T.context.setOffline(false);
  await waitFor(async () => (await T.status()).held === 0, { label: 'pushed', timeout: 30000 });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.fold').click());
  await waitFor(async () => /collapsed/.test((await q('.bar')).cls), { label: 'collapsed again' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar').click());
  await waitFor(async () => !/collapsed/.test((await q('.bar')).cls), { label: 'expanded by tap' });
});
