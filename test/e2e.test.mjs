import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, waitFor, sleep, normalizeTree } from './helpers.mjs';

let T;
before(async () => { T = await launch(); });
after(async () => { if (T) await T.close(); });
beforeEach(async () => { await T.context.setOffline(false); await T.control({ loggedOut: false, rejectValue: null, failAutosaves: 0, refuseAutosaves: 0 }); });

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
  const bar = await waitFor(async () => { const b = await T.bar(); return b && /good/.test(b.cls) && /TEST-0001/.test(b.text) ? b : null; }, { label: 'bar green with the incident number' });
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
  await waitFor(async () => /good/.test((await T.bar()).cls), { label: 'bar green after the push' });
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
  await T.setStorage({ fieldDefs: { mobileToMobile: ['MOBILETOMOBILE', 'boolean'] } }); // left behind by an earlier version
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
  // an earlier version remembered field names it had guessed itself; that memory must be ignored
  const stored = await T.storage();
  assert.equal(stored.fieldDefs, undefined, 'old learned-field key was removed');
  // the entry form shows a time next to its own controls: it must not get a button
  await T.page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div id="entry" class="vital-entry-modal" style="position:fixed;right:20px;top:20px;background:#fff;border:1px solid #000;padding:8px"><div><span>15:39:12</span><input value="x"></div></div>'); });
  await app(() => window.app.openTab('Vitals'));
  const buttons = () => T.page.evaluate(() => Array.from(window.__qa('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => ({ time: b.dataset.time, rect: b.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await buttons()).length === 1, { label: 'one copy button, for the saved row only' });
  const [btn] = await buttons();
  assert.equal(btn.time, '15:39:12');
  // nothing was inserted into the page; the button floats just left of the time cell
  assert.equal(await T.page.evaluate(() => document.querySelectorAll('.esosave-copy').length), 0, 'page DOM untouched');
  const cell = await T.page.evaluate(() => document.querySelector('#vitals td.t').getBoundingClientRect().toJSON());
  assert.ok(btn.rect.right <= cell.left - 4 && btn.rect.right >= cell.left - 14, `button (right ${btn.rect.right}) sits just left of the cell (left ${cell.left}), clear of its border`);
  assert.ok(btn.rect.top >= cell.top - 2 && btn.rect.bottom <= cell.bottom + 2, 'vertically on the row');
  await T.page.mouse.click(btn.rect.x + btn.rect.width / 2, btn.rect.y + btn.rect.height / 2);
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
  assert.equal(typeof op.value, 'string', 'text fields are sent as text, as the app does, even though the view returns a number');
  // ESO's bookkeeping fields on the vital (mobileToMobile etc.) were not sent
  assert.ok(!rec.ops.some(o => o.address.includes(b.itemId) && /mobileToMobile|softDeleted|fileId|imageType/.test(o.address)), 'no bookkeeping fields copied');
  // the tab was refreshed so the new row shows, with its own copy button; card still green
  await waitFor(async () => (await buttons()).length === 2, { label: 'two rows with copy buttons' });
  assert.equal(await app(() => window.app.quickOpened), 0, 'the refresh clicked the real tabs, not the QUICK VITALS control or a lookalike');
  assert.deepEqual((await app(() => window.app.clicks)).slice(-2), ['Incident', 'Vitals']);
  await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil')), { label: 'overlay gone' });
  const s = await T.status();
  assert.equal(s.online, true); assert.equal(s.held, 0);
  const run = await T.run(id);
  assert.ok(run.batches.some(b => b.synthetic === 'copyVital' && b.status === 'acked'), 'copy recorded as an acked batch');
  await T.page.evaluate(() => document.getElementById('entry').remove());
});

test('a copied vital ESO refuses is reported and dropped; the card never turns to NO SIGNAL', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Vitals'));
  const buttons = () => T.page.evaluate(() => Array.from(window.__qa('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => b.getBoundingClientRect().toJSON()));
  await waitFor(async () => (await buttons()).length === 2, { label: 'copy buttons' });
  const dialogs = [];
  const onDialog = (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); };
  T.page.on('dialog', onDialog);
  try {
    await T.control({ refuseAutosaves: 1 });
    const [r] = await buttons();
    await T.page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await waitFor(() => dialogs.length ? dialogs[0] : null, { label: 'error shown to the medic' });
    assert.match(dialogs[0], /ESO refused the copy: HTTP 500: Object reference/);
    await sleep(1500);
    const s = await T.status();
    assert.equal(s.online, true, 'still online');
    assert.equal(s.held, 0); assert.equal(s.rejected, 0);
    assert.equal((await T.record(id)).tree.vitals.vitalSigns.length, 2, 'no third vital');
    const run = await T.run(id);
    assert.ok(run.log.some(l => /Could not copy the .* vital: ESO refused/.test(l.msg)), 'logged');
    assert.equal(run.batches.filter(b => b.status === 'held' || b.status === 'rejected').length, 0);
    // a later real save still goes through directly
    await app(() => window.app.edit('incident', 'incident.dispatch.notes', 'after failed copy'));
    await waitFor(async () => (await T.record(id)).tree.incident?.dispatch?.notes === 'after failed copy', { label: 'later save direct' });
    const rec = await T.record(id);
    const last = await T.run(id);
    assert.equal(last.batches[last.batches.length - 1].status, 'acked');
  } finally { T.page.off('dialog', onDialog); await T.control({ refuseAutosaves: 0 }); }
});

test('with no signal, a copied vital is held and pushed when signal returns', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Vitals'));
  const buttons = () => T.page.evaluate(() => Array.from(window.__qa('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => b.getBoundingClientRect().toJSON()));
  await waitFor(async () => (await buttons()).length === 2, { label: 'copy buttons' });
  const dialogs = [];
  const onDialog = (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); };
  T.page.on('dialog', onDialog);
  try {
    await T.context.setOffline(true);
    await waitFor(async () => !(await T.status()).online, { label: 'offline noticed', timeout: 30000 });
    const [r] = await buttons();
    await T.page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await waitFor(async () => { const s = await T.status(); return s.held === 1; }, { label: 'copy held' });
    await waitFor(() => dialogs.length, { label: 'held notice' });
    assert.match(dialogs[0], /held on this device/);
    // the held copy already shows in the offline tab
    const shown = await app(() => window.app.openTab('Vitals').then(v => v.body.data.model.vitalSigns.length));
    assert.equal(shown, 3, 'offline list includes the held copy');
    await T.context.setOffline(false);
    await waitFor(async () => { const s = await T.status(); return s.online && s.held === 0; }, { label: 'pushed', timeout: 30000 });
    assert.equal((await T.record(id)).tree.vitals.vitalSigns.length, 3);
  } finally { T.page.off('dialog', onDialog); }
});

test('the call times show in the top bar as they are entered, and the setting hides them', async () => {
  const id = await freshRun();
  const strip = () => T.page.evaluate(() => { const el = document.getElementById('esosave-host').shadowRoot.querySelector('.times'); return el ? { text: el.textContent, rect: el.getBoundingClientRect().toJSON(), display: getComputedStyle(el).display } : null; });
  // before any time: every slot shows --:--
  const s0 = await waitFor(strip, { label: 'strip shown' });
  assert.match(s0.text, /Disp--:--Enr--:--Scene--:--At pt--:--Depart--:--Dest--:--Xfer--:--/);
  const bar = await T.page.evaluate(() => document.getElementById('topbar').getBoundingClientRect().toJSON());
  assert.ok(s0.rect.top >= bar.top && s0.rect.bottom <= bar.bottom, 'inside the top bar');
  // centred in the gap between what ESO shows on the left and on the right of the bar
  const ends = await T.page.evaluate(() => ({ l: document.getElementById('pt').getBoundingClientRect().right, r: document.getElementById('pid').getBoundingClientRect().left }));
  assert.ok(s0.rect.left > ends.l && s0.rect.right < ends.r, 'between the left and right content');
  assert.ok(Math.abs((s0.rect.left + s0.rect.right) / 2 - (ends.l + ends.r) / 2) < 20, `centred (strip ${(s0.rect.left + s0.rect.right) / 2}, gap ${(ends.l + ends.r) / 2})`);
  // the app saves a time the way ESO's app does: only the clock part is real
  await app(() => { window.app.edit('incident', 'incident.incidentTimes.enRouteTime', '01/01/1890 13:05:00', 'time'); window.app.edit('incident', 'incident.incidentTimes.onSceneTime', '01/01/1890 13:12:00', 'time'); });
  const s1 = await waitFor(async () => { const x = await strip(); return x && /Enr13:05/.test(x.text) ? x : null; }, { label: 'time shows' });
  assert.match(s1.text, /Scene13:12/);
  // a reload reads the times back from the Incident tab ESO serves
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await app((id) => window.app.use(id), id);
  await waitFor(async () => { const x = await strip(); return x && /Enr13:05/.test(x.text) && /Scene13:12/.test(x.text); }, { label: 'times from the served tab' });
  // an iPad-width screen: every tile still fits, because the tiles shrink and ESO's neighbours give up a little
  await T.page.setViewportSize({ width: 690, height: 700 });
  const fit = await waitFor(async () => {
    const x = await T.page.evaluate(() => { const el = document.getElementById('esosave-host').shadowRoot.querySelector('.times'); if (!el || getComputedStyle(el).display === 'none') return null; const r = el.getBoundingClientRect(); return { cls: el.className, right: r.right, scroll: el.scrollWidth, width: el.clientWidth, pid: document.getElementById('pid').getBoundingClientRect().left, pt: document.getElementById('pt').getBoundingClientRect().right, name: getComputedStyle(document.getElementById('ptname')).maxWidth, tiles: el.querySelectorAll('.t').length }; });
    return x && x.scroll <= x.width + 1 && x.right <= x.pid ? x : null;
  }, { label: 'fits at iPad width', timeout: 8000 });
  assert.equal(fit.tiles, 7);
  assert.match(fit.cls, /tight|micro/);
  assert.equal(fit.name, '110px', 'patient name was capped to make room');
  await T.page.setViewportSize({ width: 1280, height: 800 });
  await waitFor(() => T.page.evaluate(() => getComputedStyle(document.getElementById('ptname')).maxWidth === 'none'), { label: 'patient name restored on a wide screen' });
  // leaving the run (the records list) takes the strip away; coming back brings it back
  await T.page.evaluate(() => { location.hash = '#/records'; });
  await waitFor(async () => !(await strip()), { label: 'hidden outside the run' });
  await app(() => window.app.openTab('Incident'));
  await waitFor(async () => { const x = await strip(); return x && /Enr13:05/.test(x.text); }, { label: 'back inside the run' });
  // and the (locked, agency-set) setting turns it off; it is shown greyed out in the panel
  const q = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return !!(el && el.getBoundingClientRect().height); }, sel);
  if (!(await q('.panel [data-act=settings]'))) await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar').click());
  await waitFor(() => q('.panel [data-act=settings]'), { label: 'panel open' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=settings]').click());
  await waitFor(() => q('#times'), { label: 'settings open' });
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('#times').disabled), true, 'locked');
  await T.setStorage({ settings: { ...(await T.storage()).settings, showTimes: false } });
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await app((rid) => window.app.use(rid), id);
  await sleep(1500);
  await waitFor(async () => !(await strip()), { label: 'strip hidden' });
  assert.equal((await T.storage()).settings.showTimes, false);
  await T.setStorage({ settings: { ...(await T.storage()).settings, showTimes: true } });
});

const sh = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return el ? el.textContent : null; }, sel);
const shClick = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
function dialogs() { const seen = []; const on = (d) => { seen.push({ type: d.type(), message: d.message() }); d.accept().catch(() => {}); }; T.page.on('dialog', on); return { seen, off: () => T.page.off('dialog', on) }; }

test('before a lock: the paperwork question; No leaves the run open, Yes lets the same press through', async () => {
  const id = await freshRun();
  const ask = () => T.page.evaluate(() => { const v = document.getElementById('esosave-host').shadowRoot.querySelector('.veil .lockask'); return v ? v.textContent : null; });
  await app(() => document.getElementById('lockrecord').click());
  await waitFor(async () => /attached the proper paperwork/.test((await ask()) || ''), { label: 'the question' });
  assert.equal(await app(() => window.app.lockClicks), 0, 'ESO never saw the press');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=lock-no]').click());
  await waitFor(async () => (await ask()) === null, { label: 'question gone' });
  await sleep(500);
  assert.equal((await T.record(id)).state, 'draft', 'No: still open');
  assert.equal(await app(() => window.app.lockClicks), 0);
  await app(() => document.getElementById('lockrecord').click());
  await waitFor(async () => /paperwork/.test((await ask()) || ''), { label: 'asked again' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=lock-yes]').click());
  await waitFor(async () => (await T.record(id)).state === 'locked', { label: 'Yes: locked through ESO', timeout: 15000 });
  assert.equal(await app(() => window.app.lockClicks), 1, 'one press reached ESO');
  await waitFor(async () => (await T.run(id)).locked, { label: 'the extension sees the lock' });
});

test('lock: offers to fax the run to its destination, sends through ESO, and does not ask again once it is in the fax history', async () => {
  const id = await freshRun();
  await T.shape(id, { destination: { name: 'HSHS St. John\'s', fax: '2175551234', email: null } });
  const dl = dialogs();
  try {
    await app(() => window.app.lock());
    await waitFor(() => sh('.veil'), { label: 'prompt' });
    const text = await sh('.veil');
    assert.match(text, /TEST-\d+ is locked/);
    assert.match(text, /HSHS St. John's/);
    assert.match(text, /Send fax/); assert.doesNotMatch(text, /Send email/, 'no email on file, so no email button');
    await shClick('.veil [data-act=fax]');
    await waitFor(async () => (await T.faxes()).faxHistory.some(f => f.pcrId === id), { label: 'ESO faxed it' });
    const f = (await T.faxes()).faxHistory.find(f => f.pcrId === id);
    assert.equal(f.destination, 'HSHS St. John\'s');
    await waitFor(async () => /Fax sent/.test(await sh('.veil') || ''), { label: 'confirmation' });
    await waitFor(async () => !(await sh('.veil')), { label: 'confirmation gone', timeout: 6000 });
    const run = await T.run(id);
    assert.ok(run.log.some(l => /Fax sent to HSHS/.test(l.msg)));
    // unlock and lock again: ESO's history says it went, so no prompt
    await app(() => window.app.unlock());
    await app(() => window.app.lock());
    await waitFor(async () => (await T.run(id)).log.some(l => /Already faxed/.test(l.msg)), { label: 'relock sees the history' });
    assert.equal(await sh('.veil'), null, 'no second prompt');
    assert.equal(dl.seen.length, 0, 'no alerts');
  } finally { dl.off(); }
});

test('lock: email-only destination offers email only; Not now leaves it in the Not sent list; no destination asks nothing', async () => {
  const id = await freshRun();
  await T.shape(id, { destination: { name: 'Fayette County Hospital', fax: null, email: 'er@fayette.example' } });
  const dl = dialogs();
  try {
    await app(() => window.app.lock());
    const text = await waitFor(() => sh('.veil'), { label: 'prompt' });
    assert.match(text, /Send email/); assert.doesNotMatch(text, /Send fax/);
    await shClick('.veil [data-act=later]');
    await waitFor(async () => !(await sh('.veil')), { label: 'prompt closed' });
    await waitFor(async () => { const s = await T.status(); return s.unsent && s.unsent.items.some(i => i.pcrId === id && i.email && !i.fax); }, { label: 'listed as not sent', timeout: 20000 });
    // send it from the list
    await shClick('.bar [data-act=open]');
    await waitFor(() => sh('.unsent .head'), { label: 'the Not sent fold' });
    assert.equal(await sh('.urow'), null, 'folded by default');
    await shClick('.unsent [data-act=unsent-toggle]');
    await waitFor(() => sh('.urow[data-pcr="' + id + '"] [data-act=send-email]'), { label: 'email button in the list' });
    await shClick('.urow[data-pcr="' + id + '"] [data-act=send-email]');
    await waitFor(async () => (await T.faxes()).emails.some(e => e.pcrId === id), { label: 'emailed' });
    assert.ok(dl.seen.some(d => d.type === 'confirm' && /Email TEST-\d+ to Fayette/.test(d.message)), 'asked before sending');
    await waitFor(async () => { const s = await T.status(); return s.unsent && !s.unsent.items.some(i => i.pcrId === id); }, { label: 'off the list', timeout: 20000 });
    await shClick('.panel [data-act=close]');
    // a run with no destination: nothing to offer
    const id2 = await freshRun();
    await app(() => window.app.lock());
    await waitFor(async () => (await T.run(id2)).log.some(l => /Nothing to send: This record has no selected destination/.test(l.msg)), { label: 'nothing to send logged' });
    assert.equal(await sh('.veil'), null);
  } finally { dl.off(); }
});

test('lock with no signal: the fax is held with the run and sent when signal returns', async () => {
  const id = await freshRun();
  await T.shape(id, { destination: { name: 'Anderson Hospital', fax: '6185551234', email: null } });
  const dl = dialogs();
  try {
    // the destination check happens on lock, while there is still signal; then signal drops
    await app(() => window.app.lock());
    await waitFor(() => sh('.veil'), { label: 'prompt' });
    await T.context.setOffline(true);
    await waitFor(async () => !(await T.status()).online, { label: 'offline noticed', timeout: 30000 });
    await shClick('.veil [data-act=fax]');
    await waitFor(() => dl.seen.some(d => /held on this device/.test(d.message)), { label: 'held notice' });
    const held = await T.run(id);
    assert.equal(held.sends.filter(x => x.status === 'held').length, 1);
    assert.equal((await T.status()).held, 1, 'counts as a held change');
    assert.equal((await T.faxes()).faxHistory.some(f => f.pcrId === id), false);
    await T.context.setOffline(false);
    await waitFor(async () => (await T.faxes()).faxHistory.some(f => f.pcrId === id), { label: 'sent after signal returned', timeout: 30000 });
    await waitFor(async () => (await T.status()).held === 0, { label: 'nothing held' });
    assert.ok((await T.run(id)).log.some(l => /Fax sent to Anderson Hospital now that signal is back/.test(l.msg)));
  } finally { dl.off(); }
});

test('the Not sent list is agency-wide: locked runs from other devices with a destination and no fax in the history', async () => {
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  // three runs locked elsewhere: one faxed already, one with a fax destination, one with no destination
  const mk = async (dest) => { const r = await fetch(T.base + '/ehr/api/PatientCareRecords', { method: 'POST', headers: { 'x-custom-xsrf-token': 't' }, body: '{}' }).then(r => r.json()); await T.shape(r.data, { locked: true, destination: dest }); return r.data; };
  const faxed = await mk({ name: 'Barnes Jewish Hospital', fax: '3145551234', email: null });
  const unsent = await mk({ name: 'Gateway Regional Med Center', fax: '6185559876', email: 'er@gateway.example' });
  const nowhere = await mk(null);
  await fetch(T.base + `/ehr/api/PatientCareRecords/${faxed}/Fax/Send`, { method: 'POST', body: '{"sendDateTime":"09/17/2026 10:00:00"}' });
  await app(() => window.app.start()); // gives the extension a token
  await shClick('.bar [data-act=open]');
  await waitFor(async () => { const s = await T.status(); return s.unsent && s.unsent.items.some(i => i.pcrId === unsent); }, { label: 'scan done', timeout: 30000 });
  const s = await T.status();
  assert.ok(!s.unsent.items.some(i => i.pcrId === faxed), 'faxed run not listed');
  assert.ok(!s.unsent.items.some(i => i.pcrId === nowhere), 'run with no destination not listed');
  const item = s.unsent.items.find(i => i.pcrId === unsent);
  assert.equal(item.destinationName, 'Gateway Regional Med Center'); assert.equal(item.fax, true); assert.equal(item.email, true);
  assert.match(await sh('.run.unsent'), /Not sent yet \(1\)/, 'folded, with the count');
  await shClick('.unsent [data-act=unsent-toggle]');
  const text = await waitFor(async () => { const t = await sh('.run.unsent'); return t && /Gateway/.test(t) ? t : null; }, { label: 'unfolded' });
  assert.match(text, /Gateway Regional Med Center/);
  assert.match(await sh('.bar'), /1 run not faxed/);
  await shClick('.panel [data-act=close]');
});

test('quick history chips: tap several, one open of ESO\'s Add History list ticks them all and presses OK', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Patient'));
  const chips = () => T.page.evaluate(() => Array.from(window.__qa('.quick .chip[data-group=history]')).map(c => ({ short: c.textContent, name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await chips()).length >= 20, { label: 'chips drawn' });
  const all = (await chips()).filter(c => !/other/.test(c.cls));
  assert.equal((await chips()).filter(c => /other/.test(c.cls)).length, 1, 'one Other… at the end of the row');
  const btn = await T.page.evaluate(() => document.getElementById('addhist').getBoundingClientRect().toJSON());
  const next = await T.page.evaluate(() => document.querySelector('#patient label').getBoundingClientRect().toJSON());
  assert.ok(all[0].rect.left > btn.right, 'first chip sits to the right of Add History');
  assert.ok(all.some(c => c.rect.top > btn.bottom), 'later chips wrap under the button');
  assert.ok(all.every(c => c.rect.bottom < next.top), 'no chip sits on the next field: the button made room');
  const tap = async (name) => { await waitFor(() => T.page.evaluate((n) => !!Array.from(window.__qa('.quick .chip')).find(x => x.title === n), name), { label: 'chip ' + name }); await T.page.evaluate((n) => { Array.from(window.__qa('.quick .chip')).find(x => x.title === n).click(); }, name); };
  // each tap goes straight into ESO's list: open, tick, OK. Two quick taps may share one open.
  await tap('Hypertension (HTN)');
  await tap('Diabetes');
  const rec = await waitFor(async () => { const r = await T.record(id); const h = (r.tree.patient && r.tree.patient.patientMedicalHistories) || []; return h.length === 2 ? r : null; }, { label: 'both on ESO', timeout: 15000 });
  assert.deepEqual(rec.tree.patient.patientMedicalHistories.map(h => Number(h.itemId)).sort(), [545, 547]);
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'list closed with OK' });
  const opens = await app(() => window.app.shelfOpens);
  assert.ok(opens >= 1 && opens <= 2, 'one open per tap, or one for both: ' + opens);
  assert.match(await app(() => document.getElementById('histlist').textContent), /Hypertension \(HTN\)Diabetes/);
  await waitFor(async () => (await chips()).filter(c => /added/.test(c.cls)).length === 2, { label: 'chips show added' });
  // "Other…" opens ESO's own Add History list and nothing else
  await T.page.evaluate(() => Array.from(window.__qa('.quick .chip[data-group=history]')).find(c => /other/.test(c.className)).click());
  await waitFor(async () => (await app(() => window.app.shelfOpens)) === opens + 1, { label: 'Add History opened by Other…' });
  await app(() => document.querySelector('shelf-panel header button').click());
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'closed' });
  await waitFor(async () => (await chips()).length >= 20, { label: 'chips back' });
  // a second tap on a chip that is in takes it back out: open, untick, OK
  await tap('Hypertension (HTN)');
  await waitFor(async () => (await T.record(id)).tree.patient.patientMedicalHistories.length === 1, { label: 'HTN taken out', timeout: 15000 });
  assert.equal(Number((await T.record(id)).tree.patient.patientMedicalHistories[0].itemId), 545, 'Diabetes stays');
  assert.equal(await app(() => window.app.shelfOpens), opens + 2);
  await waitFor(async () => (await chips()).filter(c => /added/.test(c.cls)).map(c => c.short).join() === 'Diabetes', { label: 'HTN chip no longer shown as added' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
  // the search matched the exact name, not a lookalike ("Pulmonary Hypertension", "Type 1 Diabetes")
  const ops = rec.ops.filter(o => /patientMedicalHistories/.test(o.address));
  assert.deepEqual(ops.map(o => o.verb), ['ADD', 'ADD']);
  await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil')), { label: 'overlay gone' });
});

test('quick chips for medications and allergies work the same way, and every quick button hides while a picker is open', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Patient'));
  const chips = () => T.page.evaluate(() => Array.from(window.__qa('.quick .chip')).map(c => ({ short: c.textContent, name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await chips()).length >= 55, { label: 'all three groups drawn' });
  const tap = async (name) => { await waitFor(() => T.page.evaluate((n) => !!Array.from(window.__qa('.quick .chip')).find(x => x.title === n), name), { label: 'chip ' + name }); await T.page.evaluate((n) => { Array.from(window.__qa('.quick .chip')).find(x => x.title === n).click(); }, name); };
  // meds: the exact names win over lookalikes ("Insulin" not "Insulin Detemir")
  await tap('Lisinopril'); await tap('Insulin');
  await waitFor(async () => ((await T.record(id)).tree.patient?.patientMedications || []).length === 2, { label: 'two meds on ESO', timeout: 15000 });
  assert.deepEqual((await T.record(id)).tree.patient.patientMedications.map(m => Number(m.itemId)).sort(), [478, 485]);
  // allergies
  await tap('No known allergies');
  await waitFor(async () => ((await T.record(id)).tree.patient?.patientAllergies || []).length === 1, { label: 'allergy on ESO', timeout: 15000 });
  assert.equal(Number((await T.record(id)).tree.patient.patientAllergies[0].itemId), 518);
  await waitFor(async () => (await chips()).filter(c => /added/.test(c.cls) && /Lisinopril|Insulin|No known/.test(c.name)).length === 3, { label: 'chips show added' });
  // a picker the medic opens by hand: no quick button anywhere until it closes
  await app(() => document.getElementById('addallergy').click());
  await waitFor(async () => (await chips()).length === 0, { label: 'chips gone while the list is open' });
  await app(() => document.querySelector('shelf-panel header button').click());
  await waitFor(async () => (await chips()).length >= 55, { label: 'chips back' });
  // anything ESO draws over the page (the camera, attachments, a print sheet, a popover) hides the buttons under it
  await app(() => { const o = document.createElement('div'); o.id = 'overlay'; o.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:500'); document.body.appendChild(o); });
  const hist = () => T.page.evaluate(() => window.__qa('.quick .chip[data-group=history]').length);
  await waitFor(async () => (await hist()) === 0, { label: 'nothing under an overlay (the on-screen group)' });
  await app(() => document.getElementById('overlay').remove());
  await waitFor(async () => (await hist()) >= 20, { label: 'back when it goes' });
  // history chips do not anchor to the open list's own "Add History" title
  await app(() => document.getElementById('addhist').click());
  await waitFor(async () => (await chips()).length === 0, { label: 'none while Add History is open' });
  await app(() => document.querySelector('shelf-panel header button').click());
});

test('quick delays: one button presses ESO\'s own None/No Delay on every delay still empty, and leaves a set one alone', async () => {
  const id = await freshRun();
  // one delay already answered by hand
  await app(() => { window.app.addScalar('incident', "incident.additionalFactors.sceneDelays.['365']", 365); });
  await waitFor(async () => ((await T.record(id)).tree.incident?.additionalFactors?.sceneDelays || []).length === 1, { label: 'scene delay saved' });
  await app(() => window.app.openTab('Incident'));
  const btn = () => T.page.evaluate(() => { const b = window.__q('.quick .allnone[data-group=delays]'); return b ? { text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() } : null; });
  const b0 = await waitFor(async () => { const b = await btn(); return b && /\(4 left\)/.test(b.text) ? b : null; }, { label: 'All: None/No Delay button, counting the four still empty' });
  const field = await T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=DISPATCHDELAYS]').getBoundingClientRect().toJSON());
  assert.ok(b0.rect.bottom <= field.top && Math.abs(b0.rect.right - field.right) < 4, 'sits just above the first delay field, right-aligned');
  await T.page.evaluate(() => window.__q('.quick .allnone[data-group=delays]').click());
  const rec = await waitFor(async () => { const r = await T.record(id); const a = r.tree.incident?.additionalFactors || {}; return a.dispatchDelays && a.responseDelays && a.transportDelays && a.turnAroundDelays ? r : null; }, { label: 'four delays saved by the app', timeout: 15000 });
  const a = rec.tree.incident.additionalFactors;
  assert.deepEqual([a.dispatchDelays, a.responseDelays, a.transportDelays, a.turnAroundDelays].map(x => x.map(Number)), [[6430], [357], [385], [399]]);
  assert.deepEqual(a.sceneDelays.map(Number), [365], 'the hand-entered delay was left alone');
  await waitFor(async () => { const b = await btn(); return b && /done/.test(b.cls); }, { label: 'button shows done' });
  await waitFor(async () => !(await btn()), { label: 'button gone once every delay is answered', timeout: 8000 });
});

test('quick transport: chips after each transport field pick in ESO\'s list; a field with a value shows it as added', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Narrative'));
  const chips = (gk) => T.page.evaluate((g) => Array.from(window.__qa(`.quick .chip[data-group=${g}]:not(.other)`)).map(c => ({ short: c.textContent, name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })), gk);
  await waitFor(async () => (await chips('toStretcher')).length === 7 && (await chips('position')).length === 4 && (await chips('toAmbulance')).length === 1, { label: 'transport chips drawn' });
  assert.equal(await T.page.evaluate(() => window.__qa('.quick .chip.other[data-group=toStretcher]').length), 1, 'Other… on the stretcher row');
  const lab = await T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=HOWPATIENTWASMOVEDTOSTRETCHERIDS] label').getBoundingClientRect().toJSON());
  const fld = await T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=HOWPATIENTWASMOVEDTOSTRETCHERIDS]').getBoundingClientRect().toJSON());
  const c0 = (await chips('toStretcher'))[0];
  assert.ok(c0.rect.top >= lab.bottom && Math.abs(c0.rect.left - fld.left) < 4 && c0.rect.right <= fld.right, 'first chip sits under the label, inside the field width');
  const tap = async (name) => { await waitFor(() => T.page.evaluate((n) => { const c = Array.from(window.__qa('.quick .chip')).find(x => x.title === n); return !!c && !/busy/.test(c.className); }, name), { label: 'chip ' + name }); await T.page.evaluate((n) => { Array.from(window.__qa('.quick .chip')).find(x => x.title === n).click(); }, name); };
  await tap('Lifted to stretcher via draw-sheet');
  const rec = await waitFor(async () => { const r = await T.record(id); return (r.tree.narrative?.patientTransport?.howPatientWasMovedToStretcherIds || []).length ? r : null; }, { label: 'to-stretcher saved by the app', timeout: 15000 });
  assert.deepEqual(rec.tree.narrative.patientTransport.howPatientWasMovedToStretcherIds.map(Number), [15113]);
  await waitFor(async () => (await chips('toStretcher')).some(c => /added/.test(c.cls) && c.name === 'Lifted to stretcher via draw-sheet'), { label: 'chip shows added' });
  await tap('Lifted to stretcher via draw-sheet'); // tapped again: taken back out through the same list
  await waitFor(async () => !((await T.record(id)).tree.narrative?.patientTransport?.howPatientWasMovedToStretcherIds || []).map(Number).includes(15113), { label: 'draw-sheet removed', timeout: 15000 });
  await waitFor(async () => !(await chips('toStretcher')).some(c => /added/.test(c.cls) && c.name === 'Lifted to stretcher via draw-sheet'), { label: 'chip shows it is out' });
  // to ambulance: Stretcher; from ambulance: Stretcher (two fields, one after the other)
  await tap('Stretcher');
  await waitFor(async () => ((await T.record(id)).tree.narrative?.patientTransport?.patientMovedFromSceneToAmbulanceMethodIds || []).map(Number).includes(7183), { label: 'to ambulance', timeout: 15000 });
  await waitFor(() => T.page.evaluate(() => { const cs = Array.from(window.__qa('.quick .chip[data-group=fromAmbulance]:not(.other)')); return cs.length === 1 && !/busy/.test(cs[0].className); }), { label: 'from-ambulance chip free' });
  await T.page.evaluate(() => window.__q('.quick .chip[data-group=fromAmbulance]:not(.other)').click());
  await waitFor(async () => ((await T.record(id)).tree.narrative?.patientTransport?.patientMovedFromAmbulanceToDestinationMethodIds || []).map(Number).includes(7196), { label: 'from ambulance', timeout: 15000 });
  await tap('Semi-Fowlers');
  await waitFor(async () => ((await T.record(id)).tree.narrative?.patientTransport?.patientPositionDuringTransportIds || []).map(Number).includes(7189), { label: 'position', timeout: 15000 });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0, 'every picker closed');
  assert.match(await app(() => document.querySelector('eso-field[data-field-ref=PATIENTPOSITIONDURINGTRANSPORTIDS] .display-value').textContent), /Semi-Fowlers/);
});

test('facility chips: chosen in Settings from ESO\'s saved facilities, one tap sets Predefined, the type and the name', async () => {
  // fresh install: the agency's standard chips are there before anything is chosen
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  const std = (await T.storage()).settings || {};
  assert.equal((std.facilitySending || []).length, 7, 'seven standard sending chips');
  assert.equal((std.facilityDestination || []).length, 11, 'eleven standard destination chips');
  assert.equal(std.facilityDestination.find(f => f.label === 'SEO').name, "HSHS St. Elizabeth's Hospital");
  await T.setStorage({ settings: { ...std, facilitySending: [], facilityDestination: [] } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: { facilitySending: [], facilityDestination: [] } }) });
  const id = await freshRun();
  const sh = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return el ? el.textContent : null; }, sel);
  // choose two destination facilities and one sending facility in Settings
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=open]').click());
  await waitFor(() => sh('.panel [data-act=settings]'), { label: 'panel' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=settings]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.fac[data-key=facilityDestination] .facq')), { label: 'facility search box (bundle learned)' });
  const pickFac = async (key, text, name) => {
    await T.page.evaluate(([k, t]) => { const r = document.getElementById('esosave-host').shadowRoot; const inp = r.querySelector(`.fac[data-key=${k}] .facq`); inp.value = t; inp.dispatchEvent(new Event('input', { bubbles: true })); }, [key, text]);
    await waitFor(() => T.page.evaluate(([k, n]) => !!Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.fac[data-key=${k}] .facm a`)).find(a => a.textContent.startsWith(n)), [key, name]), { label: 'match ' + name });
    await T.page.evaluate(([k, n]) => { Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.fac[data-key=${k}] .facm a`)).find(a => a.textContent.startsWith(n)).click(); }, [key, name]);
    await waitFor(() => T.page.evaluate(([k, n]) => (document.getElementById('esosave-host').shadowRoot.querySelector(`.fac[data-key=${k}] .chosen`).textContent || '').includes(n), [key, name]), { label: 'chosen ' + name });
  };
  await pickFac('facilityDestination', 'anders', 'Anderson Hospital');
  await pickFac('facilityDestination', 'breese', 'Breese Nursing Home');
  await pickFac('facilitySending', 'sarah', 'Sarah Bush Lincoln');
  const st = (await T.storage()).settings;
  assert.deepEqual(st.facilityDestination.map(f => f.name), ['Anderson Hospital', 'Breese Nursing Home']);
  assert.equal(st.facilitySending[0].typeId, 6540, 'the facility remembers its type from ESO\'s list');
  assert.equal(st.facilityDestination[1].destType, 'Nursing Home', 'and the name ESO gives that kind of place on the Destination side');
  assert.equal(st.facilityDestination[1].type, 'Nursing home', 'and on the Scene side');
  assert.deepEqual(((await T.storage()).facilityTypes || {}).destinationTypes.find(t => t.id === 6577), { id: 6577, name: 'Nursing Home', locationTypeId: 6542 }, 'ESO\'s type tables are kept on the device');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.panel [data-act=close]').click());
  // chips sit under each location's Predefined/Address pills
  const chips = (g) => T.page.evaluate((gg) => Array.from(window.__qa(`.quick .chip[data-group=${gg}]:not(.other)`)).map(c => ({ name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })), g);
  await waitFor(async () => (await chips('fac-destination')).length === 2 && (await chips('fac-sending')).length === 1, { label: 'facility chips' });
  const pills = await T.page.evaluate(() => document.querySelector('eso-location[view-model="vm.destination"] .button-group').getBoundingClientRect().toJSON());
  const c0 = (await chips('fac-destination'))[0];
  assert.ok(c0.rect.top >= pills.bottom && Math.abs(c0.rect.left - pills.left) < 4, 'under the pills, left-aligned with them');
  assert.equal(await T.page.evaluate(() => window.__qa('.quick .chip[data-group^=fac-].other').length), 0, 'no Other… of ours: ESO\'s Location Type has one');
  const tap = async (g, name) => { await waitFor(async () => (await chips(g)).some(c => c.name === name && !/busy/.test(c.cls)), { label: 'chip free' }); await T.page.evaluate(([gg, n]) => Array.from(window.__qa(`.quick .chip[data-group=${gg}]`)).find(c => c.title === n).click(), [g, name]); };
  // destination: already in Predefined mode; type then name
  await tap('fac-destination', 'Breese Nursing Home');
  const rec = await waitFor(async () => { const r = await T.record(id); const d = r.tree.incident?.destination?.predefinedAddress; return d && d.predefinedLocationID ? r : null; }, { label: 'destination saved by the app', timeout: 15000 });
  assert.equal(rec.tree.incident.destination.predefinedAddress.locationTypeID, 6577, 'Nursing Home type chosen to match the facility');
  assert.equal(rec.tree.incident.destination.predefinedAddress.predefinedLocationID, 'loc-breese');
  assert.equal(await app(() => document.querySelector('eso-field[data-field-ref=DESTINATIONPREDEFINEDLOCATIONID] .display-value').textContent), 'Breese Nursing Home');
  await waitFor(async () => (await chips('fac-destination')).some(c => c.name === 'Breese Nursing Home' && /added/.test(c.cls)), { label: 'chip shows as current' });
  // sending: the scene is in Address mode; the chip switches it to Predefined first
  await tap('fac-sending', 'Sarah Bush Lincoln');
  await waitFor(async () => (await T.record(id)).tree.incident?.scene?.predefinedAddress?.predefinedLocationID === 'loc-sbl', { label: 'scene facility saved', timeout: 15000 });
  assert.equal(await app(() => document.querySelector('eso-location[view-model="vm.scene"]').dataset.mode), 'predefined');
  assert.equal((await T.record(id)).tree.incident.scene.predefinedAddress.locationTypeID, 6540, 'scene Location Type = Hospital');
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
  // both addresses set: ESO's own Calculate Mileage is pressed once for the crew
  await waitFor(async () => (await T.record(id)).tree.incident?.mileage?.geocodedLoadedMiles === 12.3, { label: 'loaded mileage calculated', timeout: 15000 });
  assert.equal(await app(() => window.app.calcClicks), 1, 'pressed once, when the second address landed');
  assert.equal(await app(() => document.querySelectorAll('eso-modal-dialog').length), 0, 'no dialog left behind');
  // a second destination tap changes type and name again
  await tap('fac-destination', 'Anderson Hospital');
  await waitFor(async () => (await T.record(id)).tree.incident?.destination?.predefinedAddress?.predefinedLocationID === 'loc-anderson', { label: 'destination changed', timeout: 15000 });
  assert.equal((await T.record(id)).tree.incident.destination.predefinedAddress.locationTypeID, 6575);
  await sleep(1500);
  assert.equal(await app(() => window.app.calcClicks), 1, 'not pressed again once the mileage is there');
  // a chip whose type id ESO's tables no longer know still maps by the name kept with it: never Hospital by default
  const custom = { facilitySending: [{ id: 'loc-rehab', name: 'Riverside Rehab', typeId: 424242, type: 'Rehabilitation Center', destType: 'Rehabilitation Center' }], facilityDestination: [{ id: 'loc-breese', name: 'Breese Nursing Home', typeId: 424242, type: 'Nursing home', destType: 'Nursing Home' }] };
  await T.setStorage({ settings: { ...(await T.storage()).settings, ...custom } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: custom }) });
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await app((rid) => window.app.use(rid), id);
  await waitFor(async () => (await chips('fac-destination')).length === 1, { label: 'chip back' });
  await tap('fac-destination', 'Breese Nursing Home');
  await waitFor(async () => (await T.record(id)).tree.incident?.destination?.predefinedAddress?.predefinedLocationID === 'loc-breese', { label: 'destination by kept type', timeout: 15000 });
  assert.equal((await T.record(id)).tree.incident.destination.predefinedAddress.locationTypeID, 6577, 'Nursing Home, not Hospital');
  await T.setStorage({ settings: { ...(await T.storage()).settings, facilitySending: [], facilityDestination: [] } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: {} }) });
});

test('assessment: "All normal" presses No Abnormalities on every category in ESO\'s Quick Ax and OK; "A&Ox4" sets orientation', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Assessments'));
  await app(() => document.getElementById('addax').click());
  const rec0 = await waitFor(async () => { const r = await T.record(id); const a = r.tree.assessments?.assessmentsV2?.[0]; return a && (a.findings || []).length === 26 ? r : null; }, { label: 'assessment with 26 Not Assessed findings', timeout: 15000 });
  assert.ok(rec0.tree.assessments.assessmentsV2[0].findings.every(f => f.findingId === 'Not_Assessed'));
  const btns = () => T.page.evaluate(() => Array.from(window.__qa('.quick [data-group^=assess-]')).map(b => ({ g: b.dataset.group, text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await btns()).length === 2, { label: 'All normal and A&Ox4 buttons' });
  const edit = await T.page.evaluate(() => document.querySelector('assessment-record .ax-edit-buttons').getBoundingClientRect().toJSON());
  const all = (await btns()).find(b => b.g === 'assess-all');
  assert.ok(all.rect.right < edit.left && Math.abs(all.rect.top + all.rect.height / 2 - (edit.top + edit.height / 2)) < 10, 'sits just left of ESO\'s edit buttons on the record header');
  await T.page.evaluate(() => window.__q('.quick [data-group=assess-all]').click());
  const rec = await waitFor(async () => { const r = await T.record(id); const a = r.tree.assessments?.assessmentsV2?.[0]; return a && (a.findings || []).length === 26 && a.findings.every(f => f.findingId === 'No_Abnormalities') ? r : null; }, { label: 'every location No Abnormalities', timeout: 20000 });
  assert.equal(await app(() => window.app.quickAxOpens), 1, 'one Quick Ax open');
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'Quick Ax closed with OK' });
  const dels = rec.ops.filter(o => o.verb === 'DELETE' && /findings/.test(o.address)).length;
  assert.equal(dels, 26, 'each Not Assessed finding was removed the way ESO does it');
  await waitFor(async () => /done/.test((await btns()).find(b => b.g === 'assess-all').cls), { label: 'All normal shows done' });
  // A&Ox4
  await waitFor(async () => { const b = await btns(); return b.length === 2 && !b.some(x => /busy/.test(x.cls)); }, { label: 'free' });
  await T.page.evaluate(() => window.__q('.quick [data-group=assess-ao]').click());
  await waitFor(async () => { const a = (await T.record(id)).tree.assessments.assessmentsV2[0]; return ['Oriented_Person', 'Oriented_Place', 'Oriented_Time', 'Oriented_Event'].every(x => a.findings.some(f => f.findingId === x && f.findingLocationId === 'MentalStatus')); }, { label: 'oriented x4 saved', timeout: 15000 });
  assert.equal(await app(() => window.app.mentalOpens), 1);
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'Mental Status closed with OK' });
  // a second press of All normal on an already-normal record presses nothing and still closes cleanly
  await waitFor(async () => { const b = await btns(); return b.length === 2 && !b.some(x => /busy/.test(x.cls)); }, { label: 'free again' });
  const before = (await T.record(id)).ops.length;
  await T.page.evaluate(() => window.__q('.quick [data-group=assess-all]').click());
  await waitFor(async () => (await app(() => window.app.quickAxOpens)) === 2, { label: 'opened again' });
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'closed again' });
  await sleep(800);
  assert.equal((await T.record(id)).ops.length, before, 'nothing re-saved');
});

test('disposition buttons set the whole set through ESO\'s pickers and quick-picks; red outline until Transport Mode or the refusal reason is answered', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const btns = () => T.page.evaluate(() => Array.from(window.__qa('.quick [data-group^=dispo-]')).map(b => ({ g: b.dataset.group, text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await btns()).length === 6, { label: 'five disposition buttons and Other…' });
  // Other… opens ESO's Unit Disposition list
  await T.page.evaluate(() => window.__q('.quick [data-group=dispo-other]').click());
  await waitFor(() => T.page.evaluate(() => !!document.querySelector('shelf-panel')), { label: 'unit disposition list opened' });
  assert.match(await app(() => document.querySelector('shelf-panel h1').textContent), /Unit Disposition/);
  await app(() => document.querySelector('shelf-panel header button').click());
  await waitFor(async () => (await btns()).length === 6, { label: 'buttons back' });
  // no row of ours over Response Mode to Scene: ESO shows Emergent / Non-Emergent / Other itself
  assert.equal(await T.page.evaluate(() => window.__qa('.quick [data-group=sr-resp]').length), 0);
  // (the layout settles a moment after rows above reserve their room)
  await waitFor(async () => { const unit = await T.page.evaluate(() => { const f = document.querySelector('eso-field[data-field-ref=UNITDISPOSITIONITEMID]'); return { f: f.getBoundingClientRect().toJSON(), lab: f.querySelector('label').getBoundingClientRect().toJSON(), area: (f.querySelector('eso-control') || f.querySelector('.field-area')).getBoundingClientRect().toJSON() }; }); const first = (await btns())[0]; return first && first.rect.top >= unit.lab.bottom && first.rect.bottom <= unit.area.top && Math.abs(first.rect.left - unit.f.left) < 4; }, { label: 'row sits under the Unit Disposition label, above its value' });
  const press = async (g) => { await waitFor(async () => { const b = (await btns()).find(x => x.g === g); return b && !/busy/.test(b.cls); }, { label: g }); await T.page.evaluate((gg) => window.__q(`.quick [data-group=${gg}]`).click(), g); };
  const dispo = async () => (await T.record(id)).tree.incident?.disposition || {};
  // Transported ALS
  await press('dispo-als');
  await waitFor(async () => (await dispo()).levelOfServiceId === 8196, { label: 'ALS set', timeout: 20000 });
  const d1 = await dispo();
  assert.equal(d1.unitDispositionItemID, 14402); assert.equal(d1.patientEvaluationCareDispositionItemID, 14410); assert.equal(d1.crewDispositionItemID, 14415); assert.equal(d1.transportDispositionItemID, 14435);
  const need = () => T.page.evaluate(() => Array.from(window.__qa('.quick .need')).map(n => n.dataset.msg));
  await waitFor(async () => (await need()).includes('Transport Mode needed'), { label: 'Transport Mode outlined in red' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
  // the crew picks Transport Mode Emergent by hand; the follow-ons fill themselves and the outline goes
  await app(() => { document.querySelector('eso-field[data-field-ref=TRANSPORTMODEID] .shelf-click-indicator').click(); });
  await app(() => { Array.from(document.querySelectorAll('shelf-panel li')).find(l => /Emergent \(Immediate Response\)/.test(l.textContent)).click(); });
  await waitFor(async () => { const d = await dispo(); return d.transportModeLightsAndSirensUseId === 14813 && d.transportMethodID === 10353; }, { label: 'lights & sirens and ambulance filled in', timeout: 15000 });
  await waitFor(async () => !(await need()).length, { label: 'outline gone' });
  // Refusal on a fresh run
  const id2 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await waitFor(async () => (await btns()).length === 6, { label: 'buttons' });
  await press('dispo-refusal');
  await waitFor(async () => ((await T.record(id2)).tree.incident?.disposition || {}).transportDispositionItemID === 14441, { label: 'refusal set', timeout: 20000 });
  const d2 = (await T.record(id2)).tree.incident.disposition;
  assert.equal(d2.unitDispositionItemID, 14402); assert.equal(d2.patientEvaluationCareDispositionItemID, 14411); assert.equal(d2.crewDispositionItemID, 14421);
  assert.equal(d2.levelOfServiceId, undefined, 'level of service left alone on a refusal');
  await waitFor(async () => (await need()).includes('Reason needed'), { label: 'reason outlined' });
  await app(() => { document.querySelector('eso-field[data-field-ref=REFUSALRELEASEITEMIDS] .shelf-click-indicator').click(); });
  await app(() => { Array.from(document.querySelectorAll('shelf-panel li')).find(l => /Against Medical Advice/.test(l.textContent)).click(); document.querySelector('shelf-panel header button').click(); });
  await waitFor(async () => !(await need()).length, { label: 'reason outline gone' });
  // Canceled prior: only unit and crew; patient evaluation stays not applicable
  const id3 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await waitFor(async () => (await btns()).length === 6, { label: 'buttons' });
  await press('dispo-prior');
  await waitFor(async () => ((await T.record(id3)).tree.incident?.disposition || {}).crewDispositionItemID === 14420, { label: 'canceled prior set', timeout: 20000 });
  const d3 = (await T.record(id3)).tree.incident.disposition;
  assert.equal(d3.unitDispositionItemID, 14404); assert.equal(d3.patientEvaluationCareDispositionItemID, undefined); assert.equal(d3.transportDispositionItemID, undefined);
  assert.deepEqual(await need(), []);
});

test('choosing a response mode fills the follow-on fields that are empty and sets EMD Performed to No', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await waitFor(() => T.page.evaluate(() => !!document.querySelector('eso-field[data-field-ref=PRIORITYID] .quick-picks button')), { label: 'response mode quick-picks' });
  await sleep(1200); // the watcher must have seen the empty field first
  // the crew leaves Speed answered already; it must be left alone
  await app(() => { window.app.ssSet && 0; Array.from(document.querySelectorAll('eso-field[data-field-ref=RESPONSEMODESPEED] .quick-picks button')).find(b => /Enhanced/.test(b.textContent)).click(); });
  await app(() => { Array.from(document.querySelectorAll('eso-field[data-field-ref=PRIORITYID] .quick-picks button')).find(b => b.textContent === 'Emergent').click(); });
  const resp = await waitFor(async () => { const r = (await T.record(id)).tree.incident?.response || {}; return r.emdPerformedID === 6868 ? r : null; }, { label: 'auto-filled through EMD', timeout: 15000 });
  assert.equal(resp.priorityId, 338);
  assert.equal(resp.responseModeLightsAndSirensUseId, 14797, 'Lights & Sirens');
  assert.equal(resp.responseModeIntersectionNavigationId, 14805, 'With Normal Light Pattern');
  assert.equal(resp.responseModeScheduledId, 14807, 'No');
  assert.equal(resp.responseModeSpeedId, 14810, 'Speed left as the crew set it');
  // non-emergent on another run
  const id2 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await waitFor(() => T.page.evaluate(() => !!document.querySelector('eso-field[data-field-ref=PRIORITYID] .quick-picks button')), { label: 'quick-picks' });
  await sleep(1200);
  await app(() => { Array.from(document.querySelectorAll('eso-field[data-field-ref=PRIORITYID] .quick-picks button')).find(b => b.textContent === 'Non-Emergent').click(); });
  const r2 = await waitFor(async () => { const r = (await T.record(id2)).tree.incident?.response || {}; return r.emdPerformedID === 6868 ? r : null; }, { label: 'non-emergent auto-fill', timeout: 15000 });
  assert.equal(r2.responseModeLightsAndSirensUseId, 14799, 'No Lights or Sirens');
  assert.equal(r2.responseModeSpeedId, 14811, 'Normal Traffic');
  // a downgraded mode only sets EMD; the rest is the crew's call
  const id3 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await waitFor(() => T.page.evaluate(() => !!document.querySelector('eso-field[data-field-ref=PRIORITYID] .quick-picks button')), { label: 'quick-picks' });
  await sleep(1200);
  await app(() => { Array.from(document.querySelectorAll('eso-field[data-field-ref=PRIORITYID] .quick-picks button')).find(b => /Downgraded/.test(b.textContent)).click(); });
  await waitFor(async () => ((await T.record(id3)).tree.incident?.response || {}).emdPerformedID === 6868, { label: 'EMD No', timeout: 15000 });
  await sleep(1500);
  const r3 = (await T.record(id3)).tree.incident.response;
  assert.equal(r3.responseModeLightsAndSirensUseId, undefined, 'lights & sirens left for the crew on a downgraded response');
});

test('Run Type, Mutual Aid, EMD Complaint and Requested By rows; Mutual Aid only once the run type is mutual aid', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const row = (g) => T.page.evaluate((gg) => Array.from(window.__qa(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() })), g);
  // only what ESO's own quick-picks do not offer, and no Other… of ours (ESO has one)
  await waitFor(async () => (await row('sr-runtype')).length === 4 && (await row('sr-emd')).length === 15 && (await row('sr-reqby')).length === 4, { label: 'rows drawn' });
  assert.deepEqual((await row('sr-runtype')).map(b => b.text), ['Hosp-Hosp', 'Mutual Aid', 'Hosp-NonHosp', 'NonHosp-Hosp']);
  assert.deepEqual((await row('sr-reqby')).map(b => b.text), ['Physician', 'Law Enforcement', 'Fire Dept', 'Other Healthcare']);
  assert.ok(!(await row('sr-emd')).some(b => /Breathing|Sick Person|Traffic|Other/.test(b.text)));
  assert.equal((await row('sr-mutual')).length, 0, 'Mutual Aid row hidden while ESO keeps the field folded away (its box still measures)');
  const geom = () => T.page.evaluate(() => { const f = document.querySelector('eso-field[data-field-ref=EMDCOMPLAINTID]'); return { f: f.getBoundingClientRect().toJSON(), lab: f.querySelector('label').getBoundingClientRect().toJSON(), area: (f.querySelector('eso-control') || f.querySelector('.field-area')).getBoundingClientRect().toJSON() }; });
  await waitFor(async () => { const fld = await geom(); const emd = await row('sr-emd'); return emd.length === 15 && emd.every(c => c.rect.top >= fld.lab.bottom && c.rect.bottom <= fld.area.top + 2 && c.rect.right <= fld.f.right + 2); }, { label: 'EMD chips wrap into rows under the label, above the value, within the field width' });
  const emd = await row('sr-emd');
  assert.ok(new Set(emd.map(c => Math.round(c.rect.top))).size >= 2, 'more than one row');
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(window.__qa(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const resp = async () => (await T.record(id)).tree.incident?.response || {};
  // a dialog of ESO's (CAD import) hides every quick button until it closes
  const allQuick = () => T.page.evaluate(() => window.__qa('.quick .sheet > *').length);
  await app(() => document.getElementById('cadimport').click());
  await waitFor(async () => (await allQuick()) === 0, { label: 'nothing while the CAD import dialog is up' });
  await app(() => document.querySelector('eso-modal button').click());
  await waitFor(async () => (await row('sr-runtype')).length === 4, { label: 'rows back after Cancel' });
  await tap('sr-runtype', 'Hosp-Hosp'); // no ESO quick-pick for this one: goes through the picker
  await waitFor(async () => (await resp()).runTypeId === 14627, { label: 'run type', timeout: 15000 });
  await tap('sr-runtype', 'Mutual Aid');
  await waitFor(async () => (await resp()).runTypeId === 328, { label: 'mutual aid run type', timeout: 15000 });
  await waitFor(async () => (await row('sr-mutual')).length === 3, { label: 'Mutual Aid row appears with the field' });
  await tap('sr-mutual', 'No Unit Available');
  await waitFor(async () => (await resp()).mutualAidID === 1338313, { label: 'mutual aid', timeout: 15000 });
  await tap('sr-emd', 'Seizure');
  await waitFor(async () => (await resp()).emdComplaintId === 6845, { label: 'Convulsions/Seizure', timeout: 15000 });
  await tap('sr-emd', 'Chest Pain'); // the field is set already: through the picker
  await waitFor(async () => (await resp()).emdComplaintId === 6843, { label: 'Chest Pain', timeout: 15000 });
  await tap('sr-reqby', 'Law Enforcement');
  await waitFor(async () => (await resp()).requestedByItemID === 438, { label: 'requested by', timeout: 15000 });
  await waitFor(async () => (await row('sr-reqby')).some(b => b.text === 'Law Enforcement' && /added/.test(b.cls)), { label: 'shown as current' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('mechanism of injury: all four as chips, more than one allowed', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Narrative'));
  const chips = () => T.page.evaluate(() => Array.from(window.__qa('.quick .chip[data-group=mechanism]')).map(c => ({ short: c.textContent, cls: c.className })));
  // ESO keeps Mechanism of Injury disabled until Possible Patient Injury? is Yes or Unknown: no chips until then
  await waitFor(async () => (await T.page.evaluate(() => window.__qa('.quick .chip[data-group=toStretcher]').length)) > 0, { label: 'the tab is drawn' });
  assert.equal((await chips()).length, 0, 'no chips while ESO keeps the field disabled');
  await app(() => document.querySelector('eso-field[data-field-ref="ISINJUREDID"] [data-injured="Yes"]').click());
  await waitFor(async () => (await chips()).length === 4, { label: 'four chips, no extra Other…' });
  assert.deepEqual((await chips()).map(c => c.short), ['Blunt', 'Burn', 'Penetrating', 'Other']);
  const tap = async (t) => { await waitFor(async () => (await chips()).some(c => c.short === t && !/busy/.test(c.cls)), { label: t }); await T.page.evaluate((tt) => Array.from(window.__qa('.quick .chip[data-group=mechanism]')).find(c => c.textContent === tt).click(), t); };
  await tap('Blunt'); await tap('Penetrating');
  await waitFor(async () => ((await T.record(id)).tree.narrative?.injuries?.mechanismOfInjuryIds || []).length === 2, { label: 'both saved', timeout: 15000 });
  assert.deepEqual((await T.record(id)).tree.narrative.injuries.mechanismOfInjuryIds.map(Number).sort(), [7117, 7120]);
  await waitFor(async () => (await chips()).filter(c => /added/.test(c.cls)).length === 2, { label: 'both shown as set' });
});

test('Narrative rows: impressions, care level, duration units and every anatomic location', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Narrative'));
  const row = (g) => T.page.evaluate((gg) => Array.from(window.__qa(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className })), g);
  await waitFor(async () => (await row('sr-primary')).length === 11 && (await row('sr-secondary')).length === 11 && (await row('sr-care')).length === 3 && (await row('sr-units')).length === 4 && (await row('sr-anatomic')).length === 9 && (await row('sr-system')).length === 7, { label: 'rows drawn' });
  assert.deepEqual((await row('sr-anatomic')).map(b => b.text), ['Head', 'Neck', 'Chest', 'Abd', 'Back', 'Upper Ext', 'Lower Ext', 'Genitalia', 'General'], 'every location, abbreviated, no Other…');
  assert.equal((await row('sr-primary')).at(-1).text, 'Other…');
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(window.__qa(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const nar = async () => (await T.record(id)).tree.narrative || {};
  await tap('sr-primary', 'Chest Pain');
  await waitFor(async () => (await nar()).clinicalImpression?.primaryImpressionId === 582, { label: 'primary impression', timeout: 15000 });
  await tap('sr-secondary', 'SOB');
  await waitFor(async () => (await nar()).clinicalImpression?.secondaryImpressionId === 630, { label: 'secondary impression', timeout: 15000 });
  await tap('sr-system', 'Neuro'); // ESO shows its own quick-picks here: through its Other button (ESO's name carries a trailing space)
  await waitFor(async () => (await nar()).clinicalImpression?.chiefComplaintOrganSystemId === 7104, { label: 'organ system', timeout: 15000 });
  await tap('sr-anatomic', 'Chest');
  await waitFor(async () => (await nar()).patientComplaint?.chiefComplaintAnatomicLocationId === 7096, { label: 'anatomic location', timeout: 15000 });
  await tap('sr-units', 'Hours');
  await waitFor(async () => (await nar()).patientComplaint?.chiefTimeUnitsOfComplaintDuration === 7082, { label: 'units', timeout: 15000 });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('Patient tab: Race row; allergies keep only NKDA and Other…', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Patient'));
  const row = (g) => T.page.evaluate((gg) => Array.from(window.__qa(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className })), g);
  await waitFor(async () => (await row('sr-race')).length === 7 && (await row('allergies')).length === 2, { label: 'rows drawn' });
  assert.deepEqual((await row('allergies')).map(b => b.text), ['NKDA', 'Other…']);
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(window.__qa(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const demo = async () => (await T.record(id)).tree.patient?.demographics || {};
  assert.deepEqual((await row('sr-race')).map(b => b.text), ['White', 'Black', 'Asian', 'Latino', 'Am Indian', 'Mid East', 'Pac Islander']);
  await tap('sr-race', 'Latino'); // no ESO quick-pick for this one: through the picker (a multi-select, so OK is pressed)
  await waitFor(async () => ((await demo()).raceIds || []).map(Number).includes(10317), { label: 'race', timeout: 15000 });
  await waitFor(async () => (await row('sr-race')).some(b => b.text === 'Latino' && /added/.test(b.cls)), { label: 'shown as set' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('refusal form: chips inside ESO\'s Patient Refusal Form tick its own lists; Check All; they hide while one of its pickers is up', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Signatures'));
  const chips = (g) => T.page.evaluate((gg) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(gg ? `.quick .chip[data-group=${gg}]` : '.quick .chip')).map(c => ({ text: c.textContent, cls: c.className })), g);
  await sleep(1200);
  assert.equal((await chips()).length, 0, 'nothing on the Signatures tab until the form opens');
  await app(() => document.getElementById('openrefusal').click());
  await waitFor(async () => (await chips('rfLegal')).length === 3 && (await chips('rfDecision')).length === 4 && (await chips('rfMedical')).length === 2 && (await chips('rfNotify')).length === 2 && (await chips('rfRefusals')).length === 4, { label: 'chips in the form' });
  assert.deepEqual((await chips('rfLegal')).map(c => c.text), ['18+', 'Guardian', 'Other…']);
  assert.deepEqual((await chips('rfRefusals')).map(c => c.text), ['Assessment', 'Treatment', 'Transport by EMS', 'Recommended Destination']);
  const tap = async (g, text) => { await waitFor(async () => (await chips(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(window.__qa(`.quick .chip[data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const rf = async () => (await T.record(id)).tree.signatures?.standardSignatures?.standardRefusal || {};
  await tap('rfLegal', '18+');
  await waitFor(async () => ((await rf()).capacityAssessment?.legalIds || []).includes('e8baca53-0bd8-4041-9761-392b38716aed'), { label: 'legal', timeout: 15000 });
  await tap('rfDecision', 'Clear');
  await waitFor(async () => ((await rf()).capacityAssessment?.decisionMakingIds || []).includes('0ebe23fe-29a7-43a3-881e-33995648ffd6'), { label: 'decision-making', timeout: 15000 });
  await tap('rfMedical', 'Cleared');
  await waitFor(async () => ((await rf()).capacityAssessment?.medicalIds || []).includes('7f59c7f9-779a-45ce-9eb5-0d95d8b70fb0'), { label: 'medical', timeout: 15000 });
  await tap('rfNotify', 'Check All');
  await waitFor(async () => ((await rf()).patientNotifications?.patientNotificationIds || []).length === 4, { label: 'all four notifications', timeout: 15000 });
  await waitFor(async () => (await chips('rfNotify')).some(c => c.text === 'Check All' && /added/.test(c.cls)), { label: 'Check All shown done' });
  await tap('rfRefusals', 'Assessment'); await tap('rfRefusals', 'Transport by EMS');
  await waitFor(async () => ((await rf()).patientRefusals?.patientRefusalIds || []).map(Number).sort().join() === '12817,12819', { label: 'two refusals in one open', timeout: 15000 });
  await waitFor(async () => (await chips('rfRefusals')).filter(c => /added/.test(c.cls)).length === 2, { label: 'shown as set' });
  // a picker the medic opens by hand from the form: no chips until it closes; the form itself stays
  await app(() => document.querySelector('standard-refusal eso-field[data-field-ref=STANDARDREFUSALLEGALIDS] .shelf-click-indicator').click());
  await waitFor(async () => (await chips()).length === 0, { label: 'chips gone while the picker is up' });
  await app(() => document.querySelector('shelf-panel header button').click());
  await waitFor(async () => (await chips('rfLegal')).length === 3, { label: 'chips back' });
  await app(() => document.querySelector('standard-refusal header button').click());
  await waitFor(async () => (await chips()).length === 0, { label: 'gone with the form' });
});

test('every quick button scrolls under ESO\'s banner: the layers are clipped at the banner\'s bottom edge', async () => {
  await app(() => window.app.openTab('Narrative'));
  const layer = () => T.page.evaluate(() => { const l = window.__q('.quick'); return l ? l.style.clipPath : null; });
  await waitFor(async () => (await layer()) === 'inset(64px 0px 0px)', { label: 'clipped at the sticky top bar' }); // the mock's bar is 64px tall
  const bar = await T.page.evaluate(() => document.getElementById('topbar').getBoundingClientRect().bottom);
  assert.equal(bar, 64);
  await app(() => document.getElementById('scroller').scrollTo(0, 400));
  await sleep(300);
  assert.equal(await layer(), 'inset(64px 0px 0px)', 'still clipped after a scroll');
  // the rows ride inside ESO's scrolling container (no script moves them during a scroll), so the
  // container's own edge takes them under the bar
  assert.ok(await T.page.evaluate(() => { const r = window.__q('.quick [data-group=sr-primary]'); return r && r.getRootNode().host.classList.contains('esosave-ride') && r.getRootNode().host.parentElement === document.getElementById('scroller'); }), 'the row lives in the scroller');
  await waitFor(() => T.page.evaluate(() => !!window.__q('.quick .chip[data-group=toStretcher]')), { label: 'transport chips' });
  assert.ok(await T.page.evaluate(() => window.__qa('.quick .chip').every(c => c.getRootNode().host.parentElement === document.getElementById('scroller'))), 'every chip lives in the scroller too, never the fixed overlay');
  // after the scroll settles, and after the regular re-layout ticks, a row still sits under its label
  const under = () => T.page.evaluate(() => { const f = document.querySelector('eso-field[data-field-ref=PRIMARYIMPRESSIONID]'); const lab = f.querySelector('label').getBoundingClientRect(); const c = window.__q('.quick [data-group=sr-primary]').getBoundingClientRect(); return Math.round(c.top - lab.bottom); });
  await sleep(900);
  const d1 = await under(); await sleep(800); const d2 = await under();
  assert.ok(d1 >= 2 && d1 <= 12 && d1 === d2, `row stays put under its label: ${d1} then ${d2}`);
  // the field's top edge slides under the bar: its row is still drawn (clipped), not dropped as "covered"
  await app(() => { const sc = document.getElementById('scroller'); const f = document.querySelector('eso-field[data-field-ref=PRIMARYIMPRESSIONID]'); sc.scrollTo(0, sc.scrollTop + f.getBoundingClientRect().top - 40); });
  await sleep(1200);
  const fieldTop = await T.page.evaluate(() => Math.round(document.querySelector('eso-field[data-field-ref=PRIMARYIMPRESSIONID]').getBoundingClientRect().top));
  assert.ok(fieldTop < 64 && fieldTop > 0, `field partly under the bar: top at ${fieldTop}`);
  assert.ok(await T.page.evaluate(() => !!window.__q('.quick [data-group=sr-primary]')), 'the row is still there while its field is half under the bar');
  await app(() => document.getElementById('scroller').scrollTo(0, 0));
});

test('crew roles: every role, shortened, above each crew member; a tap opens the member, the Roles list, ticks, OK, OK; a second tap takes it out', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const chips = () => T.page.evaluate(() => Array.from(window.__qa('.quick .chip[data-group=crew]')).map(c => ({ text: c.textContent, member: c.dataset.member, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await chips()).length === 7, { label: 'seven role chips for the one crew member' });
  assert.deepEqual((await chips()).map(c => c.text), ['Lead Scene', 'Lead Trans', 'Drv Resp', 'Drv Trans', 'Other Scene', 'Other Trans', 'Other']);
  assert.equal((await chips())[0].member, 'TEST, MEDIC');
  await waitFor(async () => { const row = await T.page.evaluate(() => document.querySelector('crew-list grid-row').getBoundingClientRect().toJSON()); const cs = await chips(); return cs.length === 7 && cs.every(c => c.rect.bottom <= row.top + 2); }, { label: 'above the member' });
  const tap = async (t) => { await waitFor(async () => (await chips()).some(c => c.text === t && !/busy/.test(c.cls)), { label: t }); await T.page.evaluate((tt) => Array.from(window.__qa('.quick .chip[data-group=crew]')).find(c => c.textContent === tt).click(), t); };
  const roles = async () => { const c = ((await T.record(id)).tree.incident?.crew || [])[0]; return (c && c.roleIds || []).map(Number).sort(); };
  await tap('Lead Trans');
  await waitFor(async () => (await roles()).join() === '14108', { label: 'Lead - Transport saved through the app', timeout: 15000 });
  await waitFor(async () => (await chips()).some(c => c.text === 'Lead Trans' && /added/.test(c.cls)), { label: 'shown as set (ESO writes it as "Roles: Lead - Transport")' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0, 'both shelves closed');
  await tap('Lead Trans'); // the first and only role comes out again
  await waitFor(async () => (await roles()).join() === '', { label: 'first role taken out', timeout: 15000 });
  await tap('Lead Trans');
  await waitFor(async () => (await roles()).join() === '14108', { label: 'and back in', timeout: 15000 });
  await tap('Drv Trans');
  await waitFor(async () => (await roles()).join() === '14103,14108', { label: 'a second role', timeout: 15000 });
  await tap('Lead Trans'); // out again
  await waitFor(async () => (await roles()).join() === '14103', { label: 'taken back out', timeout: 15000 });
  await waitFor(async () => !(await chips()).some(c => c.text === 'Lead Trans' && /added/.test(c.cls)), { label: 'chip shows it is out' });
});

test('quick acuity: red, yellow, green next to each acuity field, one tap picks it in ESO\'s list', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Narrative'));
  const sws = () => T.page.evaluate(() => Array.from(window.__qa('.quick .sw')).map(c => ({ title: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await sws()).length === 6, { label: 'six swatches' });
  assert.equal(await T.page.evaluate(() => window.__qa('.quick .chip.other:not([data-group])').length), 2, 'an Other… after each acuity row');
  const lab = await T.page.evaluate(() => document.querySelector('#narrative label').getBoundingClientRect().toJSON());
  const first = (await sws())[0];
  assert.ok(first.rect.left > lab.right && Math.abs(first.rect.top + first.rect.height / 2 - (lab.top + lab.height / 2)) < 8, 'swatches sit right after the label, on its line');
  const tapSw = async (i) => {
    await waitFor(() => T.page.evaluate((n) => { const b = window.__qa('.quick .sw')[n]; return !!b && !/busy/.test(b.className); }, i), { label: 'swatch free' });
    await T.page.evaluate((n) => window.__qa('.quick .sw')[n].click(), i);
  };
  await tapSw(0); // initial red
  await waitFor(async () => (await T.record(id)).tree.narrative?.patientComplaint?.initialPatientAcuityId === 10586, { label: 'initial red saved by the app' });
  assert.equal(await app(() => document.getElementById('ia').textContent), 'Critical (Red)');
  await waitFor(async () => /\bcur\b/.test((await sws())[0].cls), { label: 'red marked current' });
  await tapSw(5); // final green
  await waitFor(async () => (await T.record(id)).tree.narrative?.patientComplaint?.finalPatientAcuityId === 11840, { label: 'final green saved' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0, 'picker closed');
  await tapSw(1); // change initial to yellow
  await waitFor(async () => (await T.record(id)).tree.narrative?.patientComplaint?.initialPatientAcuityId === 10587, { label: 'initial yellow' });
  await waitFor(async () => { const s = await sws(); return /cur/.test(s[1].cls) && !/cur/.test(s[0].cls); }, { label: 'current moved to yellow' });
});

test('locking a run marks it and it is cleared from the device after the retention window', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.lock());
  await waitFor(async () => { const r = (await T.status()).runs.find(x => x.recordId === id); return r && r.locked; }, { label: 'locked seen' });
  await sleep(500);
  // a just-locked run gets ten minutes so the send prompt can finish; age the lock past that
  await waitFor(async () => (await T.storage())['run:' + id]?.locked, { label: 'lock stored' });
  const stored = (await T.storage())['run:' + id];
  await T.setStorage({ settings: { purgeHoursAfterLock: 0 }, ['run:' + id]: { ...stored, lockedAt: Date.now() - 11 * 60 * 1000 } });
  await T.page.goto(T.url);
  await waitFor(async () => !(await T.storage())['run:' + id], { label: 'purged' });
  // ...and one locked a moment ago stays until the grace is over
  const id2 = await freshRun();
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'grace'); });
  await waitFor(async () => (await T.record(id2)).tree.incident?.scene?.callNature === 'grace', { label: 'saved' });
  await app(() => window.app.lock());
  await waitFor(async () => (await T.storage())['run:' + id2]?.locked, { label: 'lock stored' });
  await T.page.goto(T.url);
  await sleep(1500);
  assert.ok((await T.storage())['run:' + id2], 'kept during the grace period');
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

test('the card collapses to the logo, stays collapsed on no signal, expands on tap, and re-expands by itself when red', async () => {
  const q = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return el ? { cls: el.className, html: el.innerHTML.slice(0, 200) } : null; }, sel);
  await waitFor(async () => (await q('.bar')) && !/collapsed/.test((await q('.bar')).cls), { label: 'expanded card' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.fold').click());
  let b = await waitFor(async () => { const x = await q('.bar'); return x && /collapsed/.test(x.cls) ? x : null; }, { label: 'collapsed' });
  assert.match(b.html, /icons\/logo\.png/, 'collapsed card shows the logo');
  const stored = await T.storage();
  assert.equal(stored.settings.cardCollapsed, true, 'collapsed state remembered');
  // no signal: stays collapsed, the ring turns amber and the held count shows on the logo
  await T.context.setOffline(true);
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'collapsed test'); });
  b = await waitFor(async () => { const x = await q('.bar'); return x && /collapsed/.test(x.cls) && /warn/.test(x.cls) && /class="pip">1</.test(x.html) ? x : null; }, { label: 'amber ring with count, still collapsed', timeout: 20000 });
  await sleep(3000);
  assert.match((await q('.bar')).cls, /collapsed/, 'did not expand by itself on no signal');
  await T.context.setOffline(false);
  await waitFor(async () => (await T.status()).held === 0, { label: 'pushed', timeout: 30000 });
  assert.match((await q('.bar')).cls, /collapsed/, 'still collapsed after the push');
  // red (logged out) is the one thing that un-collapses it
  await T.control({ loggedOut: true });
  await app(() => { window.app.edit('incident', 'incident.scene.callNature', 'collapsed test 2'); });
  b = await waitFor(async () => { const x = await q('.bar'); return x && !/collapsed/.test(x.cls) && /bad/.test(x.cls) ? x : null; }, { label: 'auto-expanded on logged out', timeout: 20000 });
  await T.control({ loggedOut: false });
  await waitFor(async () => { const s = await T.status(); return !s.loggedOut && s.held === 0; }, { label: 'logged in and pushed', timeout: 30000 });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.fold').click());
  await waitFor(async () => /collapsed/.test((await q('.bar')).cls), { label: 'collapsed again' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar').click());
  await waitFor(async () => !/collapsed/.test((await q('.bar')).cls), { label: 'expanded by tap' });
});

test('settings follow the ESO login: a row per login in the agency table; locked settings stay locked; runs of another login stay out of sight', async () => {
  await T.control({ userName: 'JONES, ALEX', userId: 'person-m' });
  const db = () => fetch(T.base + '/__db_dump').then(r => r.json());
  const id = await freshRun();
  await app(() => window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'His St'));
  await waitFor(async () => ((await T.run(id)) || {}).batches?.length >= 1 || (await app(() => window.app.responses.length)) >= 1, { label: 'a save of his' });
  // the login is read from ESO's own responses and shown on the card; a row is written for it
  await waitFor(() => T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.bar .who') || {}).textContent), { label: 'name on the card' }).then(v => assert.equal(v, 'JONES, ALEX'));
  const row = await waitFor(async () => (await db()).find(r => r.name === 'JONES, ALEX'), { label: 'row written' });
  assert.equal(row.settings.quickHistory, true);
  assert.ok(!('purgeHoursAfterLock' in row.settings) && !('warmTabs' in row.settings), 'locked settings never go to the table');
  for (const k of Object.keys(row)) assert.ok(['name', 'person_id', 'settings', 'updated_at'].includes(k), 'nothing else leaves the device: ' + k);
  assert.equal(row.person_id, 'person-m', 'the row carries the permanent ESO id');
  // Settings: the agency block is locked, the quick buttons are theirs; a change goes to the row
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=open]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.panel [data-act=settings]')), { label: 'panel' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=settings]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('#qhistory')), { label: 'settings open' });
  const locked = await T.page.evaluate(() => ['#purge', '#warm', '#times', '#sendprompt', '#unsentlist'].map(s => document.getElementById('esosave-host').shadowRoot.querySelector(s).disabled));
  assert.deepEqual(locked, [true, true, true, true, true], 'the agency block cannot be changed');
  assert.match(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.panel').textContent), /signed in as JONES, ALEX/);
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot; r.querySelector('#qhistory').checked = false; r.querySelector('[data-act=save-settings]').click(); });
  await waitFor(async () => (await db()).find(r => r.name === 'JONES, ALEX').settings.quickHistory === false, { label: 'change reached the row' });
  // another login on the same tablet: their own row, and a run whose crew she is not on is not listed for her
  await T.control({ userName: 'SMITH, JANE', userId: 'person-j' });
  const id2 = await freshRun();
  await app(() => window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'Her St'));
  await waitFor(async () => (await app(() => window.app.responses.length)) >= 1, { label: 'a save of hers' });
  await waitFor(() => T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.bar .who') || {}).textContent === 'SMITH, JANE'), { label: 'second login on the card' });
  await waitFor(async () => (await db()).some(r => r.name === 'SMITH, JANE'), { label: 'row for the second login' });
  assert.equal((await db()).find(r => r.name === 'SMITH, JANE').settings.quickHistory, true, 'her own defaults, not his change');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=open]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.panel .run[data-id]')), { label: 'runs listed' });
  const listed = await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.panel .run[data-id]')).map(r => r.dataset.id));
  assert.ok(listed.includes(id2) && !listed.includes(id), 'only runs she is on the crew of are listed');
  // he adds her to his run's crew: it is hers to see as well, on the next look at the run
  await T.shape(id, { crew: [{ personnelId: 'person-m' }, { personnelId: 'person-j' }] });
  await app((rid) => window.app.use(rid), id);
  await waitFor(async () => { await T.page.evaluate(() => { const p = document.getElementById('esosave-host').shadowRoot.querySelector('.panel'); if (!p || p.style.display === 'none') document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=open]').click(); }); return T.page.evaluate((rid) => !!document.getElementById('esosave-host').shadowRoot.querySelector(`.panel .run[data-id="${rid}"]`), id); }, { label: 'his run listed for her once she is on its crew', timeout: 15000 });
  const quick = await T.storage();
  assert.equal(quick.settings.quickHistory, true, 'the tablet now carries her settings');
  // a tablet she has never used: her row is what it gets
  await T.setStorage({ settings: { ...quick.settings, quickMeds: true } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'SMITH, JANE', settings: { quickMeds: false, quickAcuity: false } }) });
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await app((rid) => window.app.use(rid), id2);
  await waitFor(async () => (await T.storage()).settings.quickMeds === false && (await T.storage()).settings.quickAcuity === false, { label: 'her row applied on this tablet' });
  // no signal to the table: her change stays here and goes when the table is back
  await T.control({ dbDown: true });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=open]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.panel [data-act=settings]')), { label: 'panel' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=settings]').click());
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('#qmeds')), { label: 'settings open' });
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot; r.querySelector('#qmeds').checked = true; r.querySelector('[data-act=save-settings]').click(); });
  await sleep(800);
  assert.equal((await db()).find(r => r.name === 'SMITH, JANE').settings.quickMeds, false, 'not written while the table is away');
  assert.equal((await T.storage()).settings.quickMeds, true, 'kept on the tablet');
  await T.control({ dbDown: false });
  await waitFor(async () => (await db()).find(r => r.name === 'SMITH, JANE').settings.quickMeds === true, { label: 'written once the table is back', timeout: 40000 });
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
  // her name changes in ESO (a marriage): the same person id finds her row, it is renamed, her settings stay
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'SMITH, JANE', person_id: 'person-j', settings: { quickMeds: false, quickAcuity: false } }) });
  await T.control({ userName: 'BROWN, JANE', userId: 'person-j' });
  await freshRun();
  await app(() => window.app.edit('incident', 'incident.scene.manualAddress.locationName', 'New St'));
  await waitFor(() => T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.bar .who') || {}).textContent === 'BROWN, JANE'), { label: 'new name on the card' });
  await waitFor(async () => (await db()).some(r => r.name === 'BROWN, JANE' && r.person_id === 'person-j'), { label: 'row renamed' });
  assert.ok(!(await db()).some(r => r.name === 'SMITH, JANE'), 'no second row under the old name');
  assert.equal((await db()).find(r => r.name === 'BROWN, JANE').settings.quickMeds, false, 'her settings came with her');
  await waitFor(async () => (await T.storage()).settings.quickMeds === false, { label: 'the tablet carries them' });
  await T.setStorage({ settings: { ...(await T.storage()).settings, quickMeds: true, quickAcuity: true } });
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
});

test('CAD import: only a run the call log shows you on may be imported', async () => {
  const seed = (table, rows) => fetch(T.base + '/__db_seed', { method: 'POST', body: JSON.stringify({ table, rows }) });
  await seed('users', [{ username: 'thocq', first_name: 'Trent', last_name: 'Hocq' }, { username: 'efear', first_name: 'Emma', last_name: 'Fear' }, { username: 'tmedic', first_name: 'Medic', last_name: 'Test' }, { username: 'cberg', first_name: 'Chad', last_name: 'Berg' }]);
  await seed('call_log_entries', [
    { runnumber: '260918-024', callsign: 'RM-23', crewmemberone: 'thocq', crewmembertwo: 'efear', crewmemberthree: '', cmslevel: 'ALS-E', createdat: '2026-09-18T16:21:00Z' },
    { runnumber: '260918-017', callsign: 'RM-16', crewmemberone: 'tmedic', crewmembertwo: 'cberg', crewmemberthree: '', cmslevel: 'BLS-E', createdat: '2026-09-18T12:54:00Z' },
    { runnumber: '260918-031', callsign: 'QRV-2', crewmemberone: 'cberg', crewmembertwo: 'tmedic', crewmemberthree: '', cmslevel: 'ALS-NE', createdat: '2026-09-18T10:07:00Z' },
  ]);
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const box = () => T.page.evaluate(() => { const b = document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox'); return b ? b.textContent : null; });
  const pick = async (incident) => { await app((n) => Array.from(document.querySelectorAll('eso-modal grid-row[data-cad]')).find(r => r.textContent.includes(n)).click(), incident); await app(() => document.querySelector('eso-modal .import').click()); };
  await app(() => document.getElementById('cadimport').click());
  await waitFor(() => app(() => !!document.querySelector('eso-modal .import')), { label: 'CAD dialog' });
  // a run whose crew (thocq, efear) does not include TEST, MEDIC
  await pick('260918-024');
  await waitFor(async () => /not associated with this run/.test((await box()) || ''), { label: 'told it is not their run' });
  assert.equal(await app(() => window.app.cadImports), 0, 'ESO never saw the press');
  assert.equal(await app(() => !!document.querySelector('eso-modal .import')), true, 'the CAD dialog is still there to choose another');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.askbox button').click());
  // a run the login is on: goes through; the unit fields follow the crew's ESO certifications (TEST, MEDIC is an EMT-Basic: BLS)
  await pick('260918-017');
  await waitFor(async () => (await app(() => window.app.cadImports)) === 1, { label: 'imported (BLS run)', timeout: 15000 });
  await waitFor(() => app(() => /CAD Import Success/.test(document.body.textContent)), { label: 'ESO success alert' });
  await app(() => document.querySelector('eso-modal button').click());
  const resp = async () => (await T.record(id)).tree.incident?.response || {};
  await waitFor(async () => (await resp()).unitCapabilityID === 14136 && (await resp()).unitsLevelOfCareID === 9681, { label: 'Ground Transport (BLS Equipped) and BLS-Basic /EMT', timeout: 20000 });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel, eso-modal').length), 0);
  // a non-transport unit (NT02 in ESO): Non-Transport-Medical Treatment (BLS Equipped) for this EMT-Basic crew
  const id2 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await app(() => document.getElementById('cadimport').click());
  await waitFor(() => app(() => !!document.querySelector('eso-modal .import')), { label: 'CAD dialog' });
  await pick('260918-031');
  await waitFor(async () => (await app(() => window.app.cadImports)) === 1, { label: 'imported (NT run)', timeout: 15000 }); // a fresh page: its own count
  await waitFor(() => app(() => /CAD Import Success/.test(document.body.textContent)), { label: 'ESO success alert' });
  await app(() => document.querySelector('eso-modal button').click());
  await waitFor(async () => { const r = (await T.record(id2)).tree.incident?.response || {}; return r.unitCapabilityID === 14139 && r.unitsLevelOfCareID === 9681; }, { label: 'non-transport BLS', timeout: 20000 });
  // a run the call log does not have: asked, and Import anyway goes through
  const id3 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  await app(() => document.getElementById('cadimport').click());
  await waitFor(() => app(() => !!document.querySelector('eso-modal .import')), { label: 'CAD dialog' });
  await pick('260917-099');
  await waitFor(async () => /not in the call log yet/.test((await box()) || ''), { label: 'asked' });
  assert.equal(await app(() => window.app.cadImports), 0);
  await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(b => /Import anyway/.test(b.textContent)).click());
  await waitFor(async () => (await app(() => window.app.cadImports)) === 1, { label: 'imported anyway', timeout: 15000 });
  await app(() => document.querySelector('eso-modal button').click());
  await waitFor(async () => { const r = (await T.record(id3)).tree.incident?.response || {}; return r.unitCapabilityID === 14136; }, { label: 'unit 23 with an EMT-Basic crew: Ground Transport (BLS Equipped)', timeout: 20000 });
});

test('the unit\'s level follows the crew\'s ESO certifications: an EMT-Basic crew is BLS; a paramedic on the crew makes it ALS; an NT unit is non-transport', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const resp = async () => (await T.record(id)).tree.incident?.response || {};
  await sleep(1500);
  assert.equal((await resp()).unitCapabilityID, undefined, 'nothing until the unit is known');
  await app(() => window.app.ssSetForTest('UNITID', 3002)); // unit 16
  // TEST, MEDIC holds EMT-Basic: BLS, ground
  await waitFor(async () => (await resp()).unitCapabilityID === 14136 && (await resp()).unitsLevelOfCareID === 9681, { label: 'BLS from the crew', timeout: 20000 });
  // a paramedic joins the crew: ALS, whatever they run it as
  await T.shape(id, { crew: [{ personnelId: 'person-1', certification: 'cred-b1' }, { personnelId: 'person-2', certification: 'cred-p2' }] });
  await app((rid) => window.app.use(rid), id);
  await waitFor(async () => (await resp()).unitCapabilityID === 14135 && (await resp()).unitsLevelOfCareID === 9686, { label: 'ALS once a paramedic is on', timeout: 20000 });
  // the unit becomes an NT unit: non-transport, still ALS
  await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil')), { label: 'settled' });
  await app(() => window.app.ssSetForTest('UNITID', 3003));
  await waitFor(async () => (await resp()).unitCapabilityID === 14138 && (await resp()).unitsLevelOfCareID === 9686, { label: 'non-transport ALS', timeout: 20000 });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('the agency settings: locked for everyone, changed only by the agency owner\'s ESO login, and they reach every tablet', async () => {
  const db = () => fetch(T.base + '/__db_dump').then(r => r.json());
  const openSettings = async () => {
    await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=open]').click());
    await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.panel [data-act=settings]')), { label: 'panel' });
    await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=settings]').click());
    await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('#asklock')), { label: 'settings open' });
  };
  const lockedDisabled = () => T.page.evaluate(() => ['#purge', '#warm', '#asklock', '#cadgate'].map(s => document.getElementById('esosave-host').shadowRoot.querySelector(s).disabled));
  // the owner, by ESO login
  await T.control({ userName: 'GASTON, MICHAEL', userId: 'd4e45fac-ee36-4ac8-bf9a-3fb3e265c0d0' });
  await freshRun();
  await waitFor(() => T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.bar .who') || {}).textContent === 'GASTON, MICHAEL'), { label: 'owner on the card' });
  await openSettings();
  assert.deepEqual(await lockedDisabled(), [false, false, false, false], 'the owner may change the agency block');
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot; r.querySelector('#purge').value = '12'; r.querySelector('#asklock').checked = false; r.querySelector('[data-act=save-settings]').click(); });
  await waitFor(async () => { const a = (await db()).find(r => r.name === '__agency__'); return a && a.settings.purgeHoursAfterLock === 12 && a.settings.askBeforeLock === false; }, { label: 'agency row written' });
  assert.ok(!('quickHistory' in (await db()).find(r => r.name === '__agency__').settings), 'only the locked settings are the agency\'s');
  // anyone else: greyed out, and the agency row is what their tablet runs with
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
  const id = await freshRun();
  await waitFor(async () => (await T.storage()).settings.purgeHoursAfterLock === 12 && (await T.storage()).settings.askBeforeLock === false, { label: 'agency settings applied' });
  await openSettings();
  assert.deepEqual(await lockedDisabled(), [true, true, true, true], 'locked for the crew');
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('#purge').value), '12');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.panel [data-act=close]').click());
  // with the question turned off by the agency, Lock Record goes straight through
  await app(() => document.getElementById('lockrecord').click());
  await waitFor(async () => (await T.record(id)).state === 'locked', { label: 'locked without the question', timeout: 15000 });
  assert.equal(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.veil .lockask')), false);
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: '__agency__', settings: {} }) });
  await T.setStorage({ settings: { ...(await T.storage()).settings, purgeHoursAfterLock: 0, askBeforeLock: true } });
});

test('Transport Due To chips (Incident): tick through ESO\'s list, a second tap unticks', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const chips = () => T.page.evaluate(() => Array.from(window.__qa('.quick .chip[data-group=transportDueTo]')).map(c => ({ text: c.textContent, cls: c.className })));
  await waitFor(async () => (await chips()).length === 6, { label: 'five chips and Other…' });
  assert.deepEqual((await chips()).map(c => c.text), ['Closest Facility', 'Diversion', 'Family Choice', "Patient's Choice", 'Protocol', 'Other…']);
  const tap = async (t) => { await waitFor(async () => (await chips()).some(c => c.text === t && !/busy/.test(c.cls)), { label: t }); await T.page.evaluate((tt) => Array.from(window.__qa('.quick .chip[data-group=transportDueTo]')).find(c => c.textContent === tt).click(), t); };
  const due = async () => ((await T.record(id)).tree.incident?.disposition?.transportDueToItemIDs || []).map(Number).sort();
  await tap('Closest Facility'); await tap('Protocol');
  await waitFor(async () => (await due()).join() === '427,429', { label: 'both in', timeout: 15000 });
  await waitFor(async () => (await chips()).filter(c => /added/.test(c.cls)).length === 2, { label: 'shown as set' });
  await tap('Protocol');
  await waitFor(async () => (await due()).join() === '429', { label: 'Protocol out again', timeout: 15000 });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('on a touch screen the lock question and the CAD gate catch the tap itself, the way ESO acts on it', async () => {
  const id = await freshRun();
  // ESO on an iPad acts on touchend and never sees a click: a touch on Lock Record must not lock
  const touch = (sel) => app((s) => { const el = document.querySelector(s); for (const t of ['touchstart', 'touchend']) el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })); }, sel);
  await app(() => { document.getElementById('lockrecord').addEventListener('touchend', (e) => { if (!e.defaultPrevented) { window.app.lockClicks++; window.app.lock(); } }); });
  await touch('#lockrecord');
  await waitFor(() => T.page.evaluate(() => /attached the proper paperwork/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil .lockask') || {}).textContent || '')), { label: 'the question' });
  await sleep(500);
  assert.equal(await app(() => window.app.lockClicks), 0, 'ESO never got the touch');
  assert.equal((await T.record(id)).state, 'draft');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=lock-yes]').click());
  await waitFor(async () => (await T.record(id)).state === 'locked', { label: 'Yes locks it', timeout: 15000 });
});

test('paperwork: Camera and Add Attachment ask what it is, the label becomes the description, one Facesheet per run', async () => {
  await T.control({ scanner: false }); // no ESO Save app around: ESO's own camera does the taking
  const id = await freshRun();
  const inc = (await T.record(id)).incidentNumber;
  await app(() => window.app.openTab('Incident'));
  const box = () => T.page.evaluate(() => { const b = document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox'); return b ? b.textContent : null; });
  const choose = (label) => T.page.evaluate((l) => { const b = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(x => x.textContent.trim() === l); if (!b) throw new Error('no button ' + l); b.click(); }, label);
  const press = (cls) => app((c) => document.querySelector(`eso-modal-dialog .${c}`).click(), cls);
  const list = async () => (await T.record(id)).attachments;
  await app(() => document.getElementById('attachments').click());
  await waitFor(() => app(() => !!document.querySelector('eso-modal-dialog .camera')), { label: 'Attachments dialog' });
  // Camera: the question first, ESO's camera never saw the press
  await press('camera');
  await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'the type question' });
  assert.equal(await app(() => window.app.cameraClicks), 0);
  for (const t of ['Facesheet', 'Physician Certification', 'Med List', 'Monitor Printout', 'Other', 'Cancel']) assert.match((await box()) || '', new RegExp(t));
  await choose('Med List');
  await waitFor(async () => (await app(() => window.app.uploads)) === 1, { label: 'ESO uploaded the photo', timeout: 15000 });
  let l = await list();
  assert.equal(l.length, 1); assert.equal(l[0].description, `${inc}:Med List`); assert.match(l[0].name, new RegExp(`^${inc}Photo1\\.jpg$`));
  // a facesheet, then a second one: asked, Replace it leaves exactly one (the new one)
  await waitFor(() => app(() => document.querySelectorAll('eso-modal-dialog grid-row').length === 1), { label: 'list redrawn' });
  await press('camera'); await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked again' }); await choose('Facesheet');
  await waitFor(async () => (await list()).length === 2, { label: 'facesheet attached', timeout: 15000 });
  const firstFs = (await list()).find(a => a.description === `${inc}:Facesheet`).itemId;
  await waitFor(() => app(() => document.querySelectorAll('eso-modal-dialog grid-row').length === 2), { label: 'list redrawn' });
  await waitFor(async () => ((await T.status()).runs.find(r => r.recordId === id) || {}).attachments?.length === 2, { label: 'extension knows both' });
  await press('camera'); await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked' }); await choose('Facesheet');
  await waitFor(async () => /already attached/.test((await box()) || ''), { label: 'the replace question' });
  assert.match((await box()) || '', new RegExp(`${inc}:Facesheet`));
  await choose('Replace it');
  await waitFor(async () => { const a = await list(); return a.filter(x => x.description === `${inc}:Facesheet`).length === 1 && !a.some(x => x.itemId === firstFs); }, { label: 'old facesheet gone, new one there', timeout: 15000 });
  assert.equal((await list()).length, 2);
  // Keep both keeps both
  await waitFor(() => app(() => document.querySelectorAll('eso-modal-dialog grid-row').length === 2), { label: 'list redrawn' });
  await press('camera'); await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked' }); await choose('Facesheet');
  await waitFor(async () => /already attached/.test((await box()) || ''), { label: 'asked to replace' });
  await choose('Keep both');
  await waitFor(async () => (await list()).filter(x => x.description === `${inc}:Facesheet`).length === 2, { label: 'two facesheets', timeout: 15000 });
  // Cancel in the question: nothing happens
  await waitFor(() => app(() => document.querySelectorAll('eso-modal-dialog grid-row').length === 3), { label: 'list redrawn' });
  const before = await app(() => window.app.uploads);
  await press('camera'); await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked' }); await choose('Cancel');
  await sleep(600);
  assert.equal(await app(() => window.app.uploads), before);
  assert.equal(await app(() => window.app.cameraClicks), 4);
  // Add Attachment: the same question, then ESO's own dialog; the label overrides whatever is typed
  await press('add');
  await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked for a file too' });
  assert.equal(await app(() => window.app.attachClicks), 0);
  await choose('Physician Certification');
  await waitFor(() => app(() => !!document.querySelector('eso-modal-dialog input[type=file]')), { label: "ESO's Add Attachment dialog" });
  assert.equal(await app(() => window.app.attachClicks), 1);
  await app(() => { window.app.pickFile('cert.pdf', 'pdf bytes'); document.querySelector('eso-modal-dialog eso-text input').value = 'typed by hand'; document.querySelector('eso-modal-dialog .attach').click(); });
  await waitFor(async () => (await list()).some(a => a.description === `${inc}:Physician Certification`), { label: 'certification attached with the label', timeout: 15000 });
  assert.match((await list()).find(a => a.description === `${inc}:Physician Certification`).name, /\.pdf$/);
  // the switch off (settings follow the login): ESO's camera straight away, description empty
  await T.setStorage({ settings: { ...(await T.storage()).settings, scanDocs: false } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: { scanDocs: false } }) });
  await T.page.goto(T.url);
  await waitFor(() => T.page.evaluate(() => !!window.__esosave), { label: 'interceptor' });
  await app((rid) => window.app.use(rid), id);
  await sleep(1500);
  await app(() => document.getElementById('attachments').click());
  await waitFor(() => app(() => !!document.querySelector('eso-modal-dialog .camera')), { label: 'Attachments dialog' });
  await press('camera');
  await waitFor(async () => (await app(() => window.app.cameraClicks)) === 1, { label: 'ESO camera at once' });
  await waitFor(async () => (await list()).length === 5, { label: 'plain upload', timeout: 15000 });
  assert.equal((await list())[4].description, null);
  assert.equal(await box(), null);
  await T.setStorage({ settings: { ...(await T.storage()).settings, scanDocs: true } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: {} }) });
});

test('paperwork on an iPad: Camera hops to the ESO Save scanner and the pages come back onto the run', async () => {
  await T.control({ scanner: true });
  await fetch(T.base + '/__native_reset', { method: 'POST' });
  const id = await freshRun();
  const inc = (await T.record(id)).incidentNumber;
  await app(() => window.app.openTab('Incident'));
  const box = () => T.page.evaluate(() => { const b = document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox'); return b ? b.textContent : null; });
  const choose = (label) => T.page.evaluate((l) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(x => x.textContent.trim() === l).click(), label);
  const list = async () => (await T.record(id)).attachments;
  const native = () => fetch(T.base + '/__native_dump').then(r => r.json());
  await app(() => document.getElementById('attachments').click());
  await waitFor(() => app(() => !!document.querySelector('eso-modal-dialog .camera')), { label: 'Attachments dialog' });
  await app(() => document.querySelector('eso-modal-dialog .camera').click());
  await waitFor(async () => /scanner opens next/.test((await box()) || ''), { label: 'the question says the scanner is coming' });
  await choose('Monitor Printout');
  await waitFor(async () => (await native()).opened.length === 1, { label: 'hopped to the app' });
  const url = new URL((await native()).opened[0]);
  assert.equal(url.protocol, 'esosave:'); assert.equal(url.searchParams.get('type'), 'Monitor Printout'); assert.equal(url.searchParams.get('record'), id); assert.equal(url.searchParams.get('incident'), inc); assert.equal(url.searchParams.get('pages'), '12');
  assert.equal(url.searchParams.get('back'), await T.page.evaluate(() => location.href), "the app's Attach button brings Safari back to this page");
  assert.equal(await app(() => window.app.cameraClicks), 0, "ESO's camera stayed shut");
  // the app scans two pages and leaves them for the extension
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
  await fetch(T.base + '/__native_seed', { method: 'POST', body: JSON.stringify({ scans: [{ id: 'scan-1', type: 'Monitor Printout', record: id, incident: inc, pages: [jpeg, jpeg], at: Date.now() }] }) });
  await waitFor(async () => (await list()).length === 2, { label: 'both pages attached', timeout: 20000 });
  const l = await list();
  assert.deepEqual(l.map(a => a.description), [`${inc}:Monitor Printout`, `${inc}:Monitor Printout`]);
  assert.deepEqual(l.map(a => a.name), [`${inc}Photo1.jpg`, `${inc}Photo2.jpg`]);
  assert.ok(l.every(a => a.bytes === 22 && /image\/jpeg/.test(a.contentType)), 'the bytes ESO got are the scanned pages');
  await waitFor(async () => (await native()).consumed.includes('scan-1') && (await native()).scans.length === 0, { label: 'the scan was consumed' });
  assert.deepEqual((await native()).claimed, ['scan-1'], 'claimed once before it was used');
  await waitFor(() => T.page.evaluate(() => /attached/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil') || {}).textContent || '')), { label: 'the notice' });
  // a facesheet replacing one that came back: the old one goes
  await waitFor(async () => ((await T.status()).runs.find(r => r.recordId === id) || {}).attachments?.length === 2, { label: 'extension knows the list' });
  await app(() => document.querySelector('eso-modal-dialog .camera').click());
  await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked' }); await choose('Facesheet');
  await waitFor(async () => (await native()).opened.length === 2, { label: 'hopped' });
  assert.equal(new URL((await native()).opened[1]).searchParams.get('pages'), '1');
  await fetch(T.base + '/__native_seed', { method: 'POST', body: JSON.stringify({ scans: [{ id: 'scan-2', type: 'Facesheet', record: id, incident: inc, pages: [jpeg], at: Date.now() }] }) });
  await waitFor(async () => (await list()).some(a => a.description === `${inc}:Facesheet`), { label: 'facesheet attached', timeout: 20000 });
  const fs1 = (await list()).find(a => a.description === `${inc}:Facesheet`).itemId;
  await waitFor(async () => ((await T.status()).runs.find(r => r.recordId === id) || {}).attachments?.length === 3, { label: 'extension knows three' });
  await app(() => document.querySelector('eso-modal-dialog .camera').click());
  await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked' }); await choose('Facesheet');
  await waitFor(async () => /already attached/.test((await box()) || ''), { label: 'replace question' }); await choose('Replace it');
  await waitFor(async () => (await native()).opened.length === 3, { label: 'hopped' });
  await fetch(T.base + '/__native_seed', { method: 'POST', body: JSON.stringify({ scans: [{ id: 'scan-3', type: 'Facesheet', record: id, incident: inc, pages: [jpeg], at: Date.now() }] }) });
  await waitFor(async () => { const a = await list(); return a.filter(x => x.description === `${inc}:Facesheet`).length === 1 && !a.some(x => x.itemId === fs1); }, { label: 'replaced', timeout: 20000 });
  assert.equal((await list()).length, 3);
  await T.control({ scanner: false });
});

// Two facesheets as the app's text recognition hands them over: one recognised row per line,
// the cells of a row separated by " | " (made-up people).
const FACESHEET_A = [
  'Fayette County Hospital | 650 W Taylor Street',
  'Patient Information',
  'Patient Name: DOE, JANE Q | Alt Phone:',
  'Home Address: PO BOX 337 | Sex: Female',
  'BROWNSTOWN, IL 6241803 | DOB: 09/22/1947',
  'Home Phone: (618)699-1518 | Age: 78 Years',
  'Mobile Phone: | Religion: Christian',
  'Work Phone: | SSN: XXX-XX-8969',
  'Guarantor Information',
  'Guarantor Name: DOE, JANE Q | Alt Phone:',
  "Patient's Reltn: Self | Sex: Female",
  'Billing Address: PO BOX 337 | DOB: 09/22/1947',
  'BROWNSTOWN, IL 624180337 | Age: 78 Years',
  'Home Phone: (618)699-1518 | SSN: XXX-XX-8969',
  'Contact Information',
  'Emergency Contact | Next of Kin',
  'Contact Name: LACH, JULIE L | Contact Name:',
  "Patient's Reltn: Mother | Patient's Reltn:",
  'Sex: Female | Sex:',
  'Home Phone: (618)267-3695 | Home Phone:',
  'Primary Insurance',
  'Subscriber Name: DOE, JANE Q | Insurance Name: UHC Complete Care Medicare',
  "Patient's Reltn: Self | Claim Address: PO BOX 31362",
  'Sex: Female | SALT LAKE CITY, UT 841310362',
  'DOB: 09/22/1947 | Insurance Phone: (877)842-3210',
  'Age: 78 Years | Policy Number: 916615452',
  'Employer Name: | Group Number: 84506',
  'Financial Class: Medicare Advantage | Authorization Number:',
  'Secondary Insurance',
  'Subscriber Name: DOE, JANE Q | Insurance Name: ILLINOIS MEDICAID',
  "Patient's Reltn: Self | Claim Address: 431 W WASHINGTON ST",
  'Sex: Female | SPRINGFIELD, IL 627011207',
  'DOB: 09/22/1947 | Insurance Phone:',
  'Age: 78 Years | Policy Number: 366900232',
  'Financial Class: Medicaid | Group Number:',
  'Encounter Information',
  'Reg Dt/Tm: 09/16/2026 17:17 | Patient Type: Emergency | Admit Type: Emergency',
  'Admit Reason: fall, trouble moving | Attend Physician: Paul W Koch, MD',
  'PCP: Deidre Langston, APRN',
  'DOE, JANE Q | Female / 78 Years',
  'MRN: 000546068 | FIN: 1207599505',
].join('\n');
const FACESHEET_B = [
  "St Anthony's Memorial | Encounter Date: | 9/19/2026",
  'Hospital Effingham | Hospital Account: | 97169873',
  'MRN: | 55712705',
  'Guarantor: | ROE,LOUISE M',
  'ENCOUNTER',
  'Patient Class: | Emergency | Unit: | SAE EMERGENCY R*',
  'PATIENT',
  'Name: ROE, LOUISE M',
  '10/24/1931 (94 yrs)',
  'Address: | 707 S Oak St | female | White Or Caucasian',
  'City: | EFFINGHAM, IL 62401-1954 | Ethnicity: | Not Hispanic or Latino',
  'Primary Care Provider: | Jeffrey Brummer, DO | Primary Phone: | 217-343-9134',
  'Work Phone:',
  'Mobile Phone: | 217-343-9134',
  'EMERGENCY CONTACT',
  'Contact Name | Legal Guardian? | Relationship to Patient | Home Phone | Work Phone | Mobile Phone',
  '1. ROE,SUSAN | Daughter | (217)342-4932 | 217-343-9134',
  'GUARANTOR',
  'Guarantor: | ROE,LOUISE M | DOB: | 10/24/1931',
  'Address: | 707 S Oak St | Sex: | Female',
  'City: | Effingham, IL 62401-1954',
  'Relation to Patient: | Self | Home Phone: | 217-342-4932',
  'Guarantor ID: | 2477266 | Mobile Phone: | 217-343-9134',
  'GUARANTOR EMPLOYER',
  'Employer: | RETIRED | Status: | RETIRED',
  'COVERAGE',
  'PRIMARY INSURANCE',
  'Payor: | MEDICARE | Plan: | MEDICARE PART A&B',
  'Group Number: | Insurance Type: | INDEMNITY',
  'Subscriber Name: | ROE,LOUISE M | Subscriber DOB: | 10/24/1931',
  'Subscriber ID: | 4M41X00GG90',
  'Pat. Rel. to Subscriber: | Self',
  'SECONDARY INSURANCE',
  'Payor: | Plan:',
  'Group Number: | Insurance Type:',
  'Subscriber Name: | Subscriber DOB:',
  'Subscriber ID:',
  'Pat. Rel. to Subscriber:',
].join('\n');

test('facesheet: a scanned facesheet is read and, on a yes, fills the Patient and Billing pages', async () => {
  await T.control({ scanner: true });
  await fetch(T.base + '/__native_reset', { method: 'POST' });
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
  // the question's own words (the raw text it can show on request is left out)
  const box = () => T.page.evaluate(() => { const b = document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox'); if (!b) return null; const pre = b.querySelector('pre'); return pre ? b.textContent.replace(pre.textContent, '') : b.textContent; });
  const choose = (label) => T.page.evaluate((l) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(x => x.textContent.trim() === l).click(), label);
  const scanFacesheet = async (id, text, scanId) => {
    await app(() => document.getElementById('attachments').click());
    await waitFor(() => app(() => !!document.querySelector('eso-modal-dialog .camera')), { label: 'Attachments dialog' });
    await app(() => document.querySelector('eso-modal-dialog .camera').click());
    await waitFor(async () => /What is this paperwork/.test((await box()) || ''), { label: 'asked' }); await choose('Facesheet');
    await waitFor(async () => (await fetch(T.base + '/__native_dump').then(r => r.json())).opened.length >= 1, { label: 'hopped' });
    await fetch(T.base + '/__native_seed', { method: 'POST', body: JSON.stringify({ scans: [{ id: scanId, type: 'Facesheet', record: id, incident: (await T.record(id)).incidentNumber, pages: [jpeg], text, at: Date.now() }] }) });
    await waitFor(async () => /Fill from the facesheet/.test((await box()) || ''), { label: 'the fill question', timeout: 20000 });
    return await box();
  };
  // ---- the two-column "Patient Information" facesheet
  const id = await freshRun();
  await app(() => window.app.openTab('Patient'));
  let q = await scanFacesheet(id, FACESHEET_A, 'fs-a');
  for (const t of ['Name: DOE, JANE Q', 'Sex: Female', 'DOB: 09/22/1947', 'PO BOX 337, BROWNSTOWN, IL, 62418', 'Home phone: (618) 699-1518', 'SSN (masked on the facesheet)', 'insurance and the insured']) assert.ok(q.includes(t), `question lists ${t}: ${q}`);
  assert.ok(!/Medicare|policy|UHC|Physician|Insured \(/.test(q), 'only the patient: no insurance, no insured, no physician');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=fill-yes]').click());
  const tree = async () => (await T.record(id)).tree;
  await waitFor(async () => { const t = await tree(); return t.patient?.demographics?.lastName === 'DOE' && t.patient?.contact?.address?.placeId; }, { label: 'the Patient page written', timeout: 20000 });
  const t = await tree();
  const d = t.patient.demographics, c = t.patient.contact;
  assert.equal(d.firstName, 'JANE'); assert.equal(d.middleName, 'Q'); assert.equal(d.sexId, 15359); assert.equal(d.genderId, 314); assert.equal(d.dob, '09/22/1947 00:00:00'); assert.equal(d.ssn, undefined, 'masked SSN left alone');
  assert.equal(c.address.address1, 'PO BOX 337'); assert.equal(c.address.city, 'BROWNSTOWN'); assert.equal(c.address.stateId, 260); assert.equal(c.address.zip, '62418'); assert.equal(c.address.placeId.county, 'Fayette');
  const phones = Object.values(c.patientPhoneNumbers?.items || {});
  assert.deepEqual(phones.map(p => [p.phoneTypeId, p.phoneNumber]), [[12830, '6186991518']]);
  assert.equal(c.physicianFirstName, undefined, 'the physician is not filled');
  assert.equal(t.billing, undefined, 'the Billing page is never touched');
  await waitFor(() => T.page.evaluate(() => /Patient page filled/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil') || {}).textContent || '')), { label: 'the notice' });
  assert.equal((await T.record(id)).attachments.length, 1, 'and the facesheet itself is attached');
  // ---- the right-aligned "PATIENT / GUARANTOR / COVERAGE" facesheet; Not now leaves the pages alone
  await fetch(T.base + '/__native_reset', { method: 'POST' });
  const id2 = await freshRun();
  await app(() => window.app.openTab('Incident'));
  q = await scanFacesheet(id2, FACESHEET_B, 'fs-b');
  for (const t of ['Name: ROE, LOUISE M', 'Sex: Female', 'DOB: 10/24/1931', 'Race: White', 'Ethnicity: Not Hispanic or Latino', '707 S Oak St, EFFINGHAM, IL, 62401', 'Home phone: (217) 343-9134', 'Mobile phone: (217) 343-9134']) assert.ok(q.includes(t), `question lists ${t}: ${q}`);
  assert.ok(!/MEDICARE|policy/.test(q), 'the insurance is never filled');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=fill-no]').click());
  await sleep(800);
  assert.equal((await T.record(id2)).tree.patient?.demographics?.lastName, undefined, 'Not now wrote nothing');
  assert.equal(await box(), null);
  await T.control({ scanner: false });
});

test('vitals copy: the groups the crew unticks in Settings are left out of the copy', async () => {
  await T.setStorage({ settings: { ...(await T.storage()).settings, vitalCopySkip: ['bloodPressure', 'glasgowComaScale'] } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: { vitalCopySkip: ['bloodPressure', 'glasgowComaScale'] } }) });
  const id = await freshRun();
  const k = await app(() => window.app.uuid());
  await app((k) => {
    window.app.add('vitals', `vitals.vitalSigns.['${k}']`, { vitalSignDateTime: '09/16/2026 15:39:12' });
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].bloodPressure.bloodPressureSystolic`, '120');
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].bloodPressure.bloodPressureDiastolic`, '80');
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].pulse.pulseRate`, '72');
    window.app.edit('vitals', `vitals.vitalSigns.['${k}'].glasgowComaScale.glascowComaTotalScore`, 15, 'integer');
  }, k);
  await waitFor(async () => (await T.record(id)).tree.vitals?.vitalSigns?.[0]?.pulse?.pulseRate === '72', { label: 'vital saved' });
  await app(() => window.app.openTab('Vitals'));
  const buttons = () => T.page.evaluate(() => Array.from(window.__qa('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => ({ time: b.dataset.time, rect: b.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await buttons()).length === 1, { label: 'copy button' });
  await sleep(800);
  const [first] = await buttons();
  await T.page.mouse.click(first.rect.x + first.rect.width / 2, first.rect.y + first.rect.height / 2);
  const rec = await waitFor(async () => { const r = await T.record(id); return r.tree.vitals.vitalSigns.length === 2 ? r : null; }, { label: 'copied', timeout: 20000 });
  const c = rec.tree.vitals.vitalSigns[1];
  assert.equal(c.pulse.pulseRate, '72', 'pulse still copied');
  assert.equal(c.bloodPressure?.bloodPressureSystolic ?? null, null, 'blood pressure left out');
  assert.equal(c.glasgowComaScale?.glascowComaTotalScore ?? null, null, 'GCS left out');
  assert.ok(!rec.ops.some(o => o.address.includes(c.itemId) && /bloodPressure|glasgowComaScale/.test(o.address)), 'never sent');
  await T.setStorage({ settings: { ...(await T.storage()).settings, vitalCopySkip: [] } });
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: 'TEST, MEDIC', settings: {} }) });
});

// ---- Templates: a crew member's own fill-ins, kept under their ESO id, shared or private
const tw = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s); return el ? el.textContent : null; }, sel);
const twClick = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
const twClickText = (sel, text) => T.page.evaluate(([s, t]) => { const el = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin ' + s)).find(x => x.textContent.trim() === t); if (!el) throw new Error('no ' + s + ' ' + t); el.click(); }, [sel, text]);
const twType = (sel, text) => T.page.evaluate(([s, t]) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s); if (!el) throw new Error('no ' + s); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, text]);
// the field row for a catalog field (or an item member: "<item index>|<rel>")
const rowSel = (key) => `.tf[data-key="${key}"]`;
// a choice: a short list is ESO-style quick-pick buttons, a long one a search-and-scroll picker
const pick = async (key, text) => {
  const pills = await T.page.evaluate((s) => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s + ' [data-pill]'), rowSel(key));
  if (pills) { await twClickText(rowSel(key) + ' [data-pill]', text); return; }
  await twType(rowSel(key) + ' [data-pick]', text); await waitFor(() => T.page.evaluate((s) => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s + ' .picklist button'), rowSel(key)), { label: 'list for ' + key }); await twClickText(rowSel(key) + ' .picklist button', text);
};
const tplDb = () => fetch(T.base + '/__db_tpl_dump').then(r => r.json());

test('templates: made from ESO\'s own field catalog, saved under the person\'s id, and filled into a run tab by tab with a progress bar', async () => {
  await fetch(T.base + '/__db_tpl_reset', { method: 'POST' });
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
  const id = await freshRun();
  const inc = (await T.record(id)).incidentNumber;
  await app(() => window.app.openTab('Incident'));
  await waitFor(async () => !!(await T.storage()).catalog, { label: 'the field catalog kept on the device' });
  const cat = (await T.storage()).catalog;
  assert.ok(cat.fields.some(f => f.a === 'incident.response.runTypeId' && f.l === 'SL.RUNTYPE'), 'a field with its list');
  assert.ok(!cat.fields.some(f => /incidentNumber|unitId|lastName|roleIds|strokes|locationName/.test(f.a)), "the call's own fields are not in it");
  assert.ok(cat.fields.some(f => f.a === 'flowchartTreatments.treatments.dose' && f.i === 'flowchartTreatments.treatments'), 'item members know their item');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(() => tw('h1'), { label: 'the Templates window' });
  assert.match(await tw('.body'), /None yet/);
  await twClick('[data-act=new]');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-name]')), { label: 'editor' });
  await twType('[data-name]', 'Chest pain');
  // Incident: two pick lists
  await twClick('[data-page=incident]');
  // Mutual Aid is not offered until the run type calls for it, as on ESO's own screen
  assert.equal(await T.page.evaluate((s) => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s), rowSel('incident.response.mutualAidID')), false, 'mutual aid hidden');
  await pick('incident.response.runTypeId', 'Emergency Response (Mutual Aid)');
  await waitFor(() => T.page.evaluate((s) => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s), rowSel('incident.response.mutualAidID')), { label: 'mutual aid shown once the run type is mutual aid' });
  await pick('incident.response.runTypeId', 'Emergency Response (Mutual Aid)'); // the same button again takes it off
  await waitFor(() => T.page.evaluate((s) => !document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s), rowSel('incident.response.mutualAidID')), { label: 'hidden again' });
  await pick('incident.response.runTypeId', '911 Response (Scene)');
  await pick('incident.response.priorityId', 'Emergent');
  assert.ok(await T.page.evaluate((s) => /29, 78, 216/.test(Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin ' + s + ' [data-pill]')).find(b => b.textContent === '911 Response (Scene)').style.background), rowSel('incident.response.runTypeId')), 'the chosen quick pick is lit');
  // one press puts ESO's own None/No Delay on every delay field
  await twClick('[data-nodelays]');
  const lit = (key, text) => T.page.evaluate(([s, t]) => { const b = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin ' + s + ' [data-pill]')).find(x => x.textContent === t); return !!b && /29, 78, 216/.test(b.style.background); }, [rowSel(key), text]);
  await waitFor(() => lit('incident.additionalFactors.sceneDelays', 'None/No Delay'), { label: 'no delays' });
  assert.ok(await lit('incident.additionalFactors.dispatchDelays', 'None/No Delay'));
  // Patient: a number, a multiselect, a history item
  await twClick('[data-page=patient]');
  await twType(rowSel('patient.demographics.weight') + ' [data-in]', '180');
  await pick('patient.demographics.raceIds', 'White');
  await twClick('[data-additem="patient.patientMedicalHistories"]');
  await pick('0|itemId', 'Hypertension');
  // Vitals: a vital with two values
  await twClick('[data-page=vitals]');
  await twClick('[data-additem="vitals.vitalSigns"]');
  await twType(rowSel('1|bloodPressure.bloodPressureSystolic') + ' [data-in]', '120');
  await twType(rowSel('1|pulse.pulseRate') + ' [data-in]', '80');
  // Flowchart: a treatment; its measure list narrows to the treatment's own
  await twClick('[data-page=flowchartTreatments]');
  await twClick('[data-additem="flowchartTreatments.treatments"]');
  await pick('2|flowchartTreatmentRegistryId', 'Oxygen');
  await twType(rowSel('2|dose') + ' [data-in]', '15');
  assert.deepEqual(await T.page.evaluate((s) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin ' + s + ' [data-pill]')).map(b => b.textContent), rowSel('2|doseUnitId')), ['L/min'], 'only the measures of the chosen treatment, as quick picks');
  await pick('2|doseUnitId', 'L/min');
  // Assessments: one assessment, all normal, with a comment
  await twClick('[data-page=assessments]');
  // ESO's retired assessment form (a field per finding, its value a section name) is still in ESO's field list; it is never offered
  assert.equal(await tw(rowSel('assessments.assessments.mentalStatus.orientation.person')), null, 'the retired form stays out');
  await twClick('[data-additem="assessments.assessmentsV2"]');
  // laid out as ESO's screen: categories down the side, each area No Abnormalities to start; Skin gets Cold ✓ and Clammy ✕, Mental Status A&Ox4
  assert.match(await tw('.item .ih'), /no abnormalities/);
  await twClick('.item [data-cat="Skin"]');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-tog="Skin|Cold|1"]')), { label: "the skin's own findings" });
  assert.equal(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-tog="Skin|Agitation|1"]')), false, 'only the findings of that area');
  assert.match(await tw('.item [data-set="Skin|No_Abnormalities"]'), /●/);
  await twClick('[data-tog="Skin|Cold|1"]');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-tog="Skin|Clammy|0"]')), { label: 'redrawn' });
  await twClick('[data-tog="Skin|Clammy|0"]');
  await waitFor(async () => /2 findings/.test((await tw('.item .ih')) || ''), { label: 'two findings on the skin' });
  assert.match(await tw('.item [data-set="Skin|No_Abnormalities"]'), /○/, 'a finding took the place of No Abnormalities');
  await twClick('.item [data-aox4]');
  await waitFor(async () => /6 findings/.test((await tw('.item .ih')) || ''), { label: 'oriented x4 on Mental Status' });
  // HEENT is Head, Face, Eyes, Neck, each its own section; the eyes are Left and Right, a pupil size picked one at a time, the findings per eye;
  // a pupil size on the left eye takes the place of the Eyes section's No Abnormalities, as it does in ESO
  await twClick('.item [data-cat="HEENT"]');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-one="EyesLeft|5mm"]')), { label: 'the eyes' });
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .axsec').length), 4, 'Head, Face, Eyes, Neck');
  assert.equal(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-tog="Eyes|Blind|1"]')), false, 'findings live on each eye, not on Eyes');
  assert.match(await tw('.item [data-set="Eyes|No_Abnormalities"]'), /●/);
  await twClick('[data-one="EyesLeft|5mm"]');
  await waitFor(async () => /○ No Abnormalities/.test((await tw('.item [data-set="Eyes|No_Abnormalities"]')) || ''), { label: 'the eyes are no longer No Abnormalities' });
  await twClick('[data-one="EyesLeft|4mm"]');
  await waitFor(async () => /4-mm/.test((await tw('.item details[data-axg="EyesLeft"] summary')) || ''), { label: 'one pupil size at a time' });
  await twClick('[data-tog="EyesRight|Blind|1"]');
  await waitFor(async () => /8 findings/.test((await tw('.item .ih')) || ''), { label: 'a pupil size and a finding on the eyes' });
  await twClick('.item [data-cat="Abdomen"]');
  await waitFor(() => T.page.evaluate((s) => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s), rowSel('3|abdomenSection.comments')), { label: 'abdomen comments' });
  await twType(rowSel('3|abdomenSection.comments') + ' [data-in]', 'Soft, non-tender');
  
  // Narrative: an impression and text
  await twClick('[data-page=narrative]');
  await pick('narrative.clinicalImpression.primaryImpressionId', 'Chest Pain');
  await twType(rowSel('narrative.narrative.narrativeText') + ' [data-in]', 'Unit {unit} responded to {incident} on {date}. Pt c/o chest pain. Pt is ____ y/o.');
  assert.match(await tw('.pages'), /Incident4/);
  await twClick('[data-act=save]');
  await waitFor(async () => (await tplDb()).templates.length === 1, { label: 'saved to the table' });
  const saved = (await tplDb()).templates[0];
  assert.equal(saved.owner_id, 'person-1'); assert.equal(saved.owner_name, 'TEST, MEDIC'); assert.equal(saved.name, 'Chest pain'); assert.equal(saved.share, 'private');
  assert.deepEqual(saved.body.fields['incident.response.runTypeId'], { r: 'RUNTYPEID', t: 'singleselect', v: 326, l: 'SL.RUNTYPE' });
  assert.deepEqual(saved.body.fields['patient.demographics.raceIds'].v, [319]);
  assert.deepEqual(saved.body.fields['incident.additionalFactors.dispatchDelays'].v, [350]); assert.deepEqual(saved.body.fields['incident.additionalFactors.sceneDelays'].v, [372]);
  assert.equal(saved.body.items.length, 4);
  assert.equal(saved.body.items.find(i => i.kind === 'treatment').fields.doseUnitId.v, 9001);
  const ax = saved.body.items.find(i => i.kind === 'assessment');
  assert.equal(ax.findings.length, 23 + 2 + 4 + 2, "ESO's own areas; the skin carries two, Mental Status the four orientations, each eye one"); assert.deepEqual(ax.findings.filter(f => f.loc === 'Skin').map(f => [f.id, f.present]).sort(), [['Clammy', false], ['Cold', true]]); assert.deepEqual(ax.findings.filter(f => /^Eyes/.test(f.loc)).map(f => [f.loc, f.id]).sort(), [['EyesLeft', '4mm'], ['EyesRight', 'Blind']], 'the eyes: a size on the left, Blind on the right, nothing on Eyes itself'); assert.ok(ax.findings.filter(f => !/^(Skin|MentalStatus|Eyes)/.test(f.loc)).every(f => f.id === 'No_Abnormalities'), 'every other area no abnormalities');
  assert.ok(!ax.findings.some(f => f.loc === 'MentalStatus' && /No_Abnormalities|Not_Assessed/.test(f.id)), 'A&Ox4 clears the NA on Mental Status, as ESO does');
  await waitFor(() => tw('h2'), { label: 'back on the list' });
  assert.match(await tw('.body'), /Chest pain[\s\S]*private/);
  // fill the run from it: a question, then a progress bar, then the run carries it all
  await twClickText('.tpl [data-act=fill]', 'Fill this run');
  await waitFor(async () => /Fill this run from "Chest pain"/.test(await T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox') || {}).textContent || '')), { label: 'the question' });
  assert.match(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox').textContent), /replaced/);
  await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(b => /Yes, fill it/.test(b.textContent)).click());
  const tree = async () => (await T.record(id)).tree;
  await waitFor(async () => { const t = await tree(); return /Pt c\/o chest pain/.test(t.narrative?.narrative?.narrativeText || '') && t.incident?.response?.runTypeId === 326; }, { label: 'filled', timeout: 30000 });
  assert.equal((await tree()).narrative.narrative.narrativeText, `Unit  responded to ${inc} on ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}. Pt c/o chest pain. Pt is ____ y/o.`, 'the blanks the run knows are filled, the rest left for the medic');
  await waitFor(() => T.page.evaluate(() => /Filled from "Chest pain"/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil') || {}).textContent || '')), { label: 'the notice', timeout: 15000 });
  const t = await tree();
  assert.equal(t.incident.response.priorityId, 330);
  assert.deepEqual(t.incident.additionalFactors.dispatchDelays, [350]); assert.deepEqual(t.incident.additionalFactors.sceneDelays, [372]);
  assert.equal(t.patient.demographics.weight, '180'); assert.deepEqual(t.patient.demographics.raceIds, [319]);
  assert.equal(Object.values(t.patient.patientMedicalHistories)[0].itemId, 1337168);
  const v = t.vitals.vitalSigns[0]; assert.equal(v.bloodPressure.bloodPressureSystolic, '120'); assert.equal(v.pulse.pulseRate, '80'); assert.match(v.vitalSignDateTime, /^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d$/);
  const tr = t.flowchartTreatments.treatments[0]; assert.equal(tr.flowchartTreatmentRegistryId, 1416); assert.equal(tr.dose, '15'); assert.equal(tr.doseUnitId, 9001); assert.ok(tr.treatmentDate);
  const a = t.assessments.assessmentsV2[0]; assert.equal(a.abdomenSection.comments, 'Soft, non-tender'); const fs = Object.values(a.findings); assert.equal(fs.length, 31); assert.deepEqual(fs.filter(f => f.findingLocationId === 'Skin').map(f => [f.findingId, f.present]).sort(), [['Clammy', false], ['Cold', true]]); assert.deepEqual(fs.filter(f => f.findingLocationId === 'MentalStatus').map(f => f.findingId).sort(), ['Oriented_Event', 'Oriented_Person', 'Oriented_Place', 'Oriented_Time']); assert.deepEqual(fs.filter(f => /^Eyes/.test(f.findingLocationId)).map(f => [f.findingLocationId, f.findingId, f.present]).sort(), [['EyesLeft', '4mm', true], ['EyesRight', 'Blind', true]], 'written on each eye as ESO writes them; no Not Assessed on Eyes'); assert.ok(fs.filter(f => !/^(Skin|MentalStatus|Eyes)/.test(f.findingLocationId)).every(f => f.findingId === 'No_Abnormalities' && f.present === true));
  assert.equal(t.narrative.clinicalImpression.primaryImpressionId, 500);
  const run = await T.run(id);
  assert.ok(run.batches.filter(b => b.synthetic === 'facesheet' || b.synthetic === 'template').length >= 6, 'one batch per tab');
  assert.ok(run.log.some(l => /Template "Chest pain": filled/.test(l.msg)));
  // filled again: the fields are written again, the items are not added twice unless asked
  await app(() => window.app.edit('incident', 'incident.response.priorityId', 331, 'singleselect'));
  await waitFor(async () => (await tree()).incident.response.priorityId === 331, { label: 'changed by hand' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(() => tw('h1'), { label: 'window' });
  await twClickText('.tpl [data-act=fill]', 'Fill this run');
  await waitFor(async () => /already filled this run once/.test(await T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox') || {}).textContent || '')), { label: 'the repeat warning' });
  assert.ok(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox [data-again]')), 'a tick to add the items again');
  await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(b => /Yes, fill it/.test(b.textContent)).click());
  await waitFor(async () => (await tree()).incident.response.priorityId === 330, { label: 'field overwritten', timeout: 30000 });
  await waitFor(() => T.page.evaluate(() => /Filled from "Chest pain"/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil') || {}).textContent || '')), { label: 'the notice', timeout: 15000 });
  const t2 = await tree();
  assert.equal(t2.vitals.vitalSigns.length, 1, 'no second vital'); assert.equal(t2.assessments.assessmentsV2.length, 1, 'no second assessment'); assert.equal(Object.keys(t2.patient.patientMedicalHistories).length, 1, 'no second history entry');
});

test('templates: a field ESO refuses is left out and named to the medic; everything else in the template still goes in', async () => {
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1', rejectValue: 326 }); // ESO refuses the Run Type the template carries
  const id = await freshRun();
  const dialogs = []; const onDialog = (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); }; T.page.on('dialog', onDialog);
  try {
    await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
    await waitFor(() => tw('h1'), { label: 'window' });
    await twClickText('.tpl [data-act=fill]', 'Fill this run');
    await waitFor(async () => /Fill this run from "Chest pain"/.test(await T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox') || {}).textContent || '')), { label: 'question' });
    await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(b => /Yes, fill it/.test(b.textContent)).click());
    const tree = async () => (await T.record(id)).tree;
    await waitFor(async () => { const t = await tree(); return /Pt c\/o chest pain/.test(t.narrative?.narrative?.narrativeText || '') && t.incident?.response?.priorityId === 330; }, { label: 'the rest filled', timeout: 30000 });
    await waitFor(() => dialogs.length, { label: 'the medic is told' });
    assert.match(dialogs[0], /ESO would not take 1 thing from "Chest pain"[\s\S]*Run Type \(incident tab\): HTTP 400: Rejected value 326[\s\S]*Everything else went in/);
    const t = await tree();
    assert.equal(t.incident.response.runTypeId ?? null, null, 'the refused field stayed out');
    assert.equal(t.vitals.vitalSigns.length, 1, 'the items still went in');
    const ops = (await T.record(id)).ops.filter(o => /runTypeId/.test(o.address));
    assert.equal(ops.length, 0, 'nothing of the refused op landed');
    const log = (await T.run(id)).log.map(l => l.msg).join('\n');
    assert.match(log, /ESO would not take Run Type \(incident.response.runTypeId\) on the incident tab: HTTP 400: Rejected value 326\. Left out\./);
  } finally { T.page.off('dialog', onDialog); await T.control({ rejectValue: null }); }
});

test('templates: shared to everyone or to named people show up for them, named after who shared them; a copy becomes theirs', async () => {
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
  await freshRun();
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(async () => /Chest pain/.test((await tw('.body')) || ''), { label: 'his template listed' });
  // share it with everyone
  await twClickText('.tpl [data-act=edit]', 'Edit');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin input[name=share]')), { label: 'editor' });
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin input[name=share][value=everyone]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  await twClick('[data-act=save]');
  await waitFor(async () => (await tplDb()).templates[0].share === 'everyone', { label: 'shared' });
  await waitFor(() => tw('[data-act=new]'), { label: 'back on the list' });
  // a second, shared with one named person
  await twClick('[data-act=new]');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-name]')), { label: 'editor' });
  await twType('[data-name]', 'For Alex');
  await twClick('[data-page=incident]');
  await pick('incident.response.priorityId', 'Non-Emergent');
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin input[name=share][value=some]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-people]')), { label: 'people search' });
  await twType('[data-people]', 'jones');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-peoplelist] button')), { label: 'names' });
  await twClickText('[data-peoplelist] button', 'JONES, ALEX');
  await waitFor(async () => /JONES, ALEX/.test((await tw('.share .chosen')) || ''), { label: 'chosen' });
  await twClick('[data-act=save]');
  await waitFor(async () => (await tplDb()).shares.some(s => s.person_id === 'person-m'), { label: 'share row' });
  await waitFor(() => tw('[data-act=new]'), { label: 'back on the list' });
  // Jane sees the everyone template, not the one for Alex; a copy is hers
  await T.control({ userName: 'SMITH, JANE', userId: 'person-j' });
  await freshRun();
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(async () => /shared by TEST, MEDIC/.test((await tw('.body')) || ''), { label: 'listed for her with who shared it' });
  const body = await tw('.body');
  assert.match(body, /Templates shared to everyone[\s\S]*Chest pain[\s\S]*shared by TEST, MEDIC/);
  assert.doesNotMatch(body, /For Alex/);
  assert.match(body.split('Templates shared with you')[1].split('Templates shared to everyone')[0], /None/);
  // only its maker can change or delete it: her buttons on his template are Fill and Copy
  assert.deepEqual(await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl [data-act]')).map(b => b.dataset.act)), ['fill', 'copy']);
  await twClickText('.tpl [data-act=copy]', 'Copy to mine');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-name]')), { label: 'editor' });
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-name]').value), 'Chest pain (copy)');
  await twClick('[data-act=save]');
  await waitFor(async () => (await tplDb()).templates.some(x => x.owner_id === 'person-j' && x.name === 'Chest pain (copy)'), { label: 'her own copy' });
  // her own can be copied too, for a call that differs only a little: the copy is a new private one, named so it does not collide
  await waitFor(() => tw('[data-act=new]'), { label: 'list' });
  await T.page.evaluate(() => { const row = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl')).find(r => /^Chest pain \(copy\)/.test(r.querySelector('.tn').textContent)); row.querySelector('[data-act=copy]').click(); });
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-name]')), { label: 'editor' });
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-name]').value), 'Chest pain (copy 2)');
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin input[name=share]:checked').value), 'private');
  await twClick('[data-page=narrative]');
  await waitFor(() => T.page.evaluate((s) => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s), rowSel('narrative.narrative.narrativeText')), { label: 'the copied narrative' });
  assert.match(await T.page.evaluate((s) => document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s + ' [data-in]').value, rowSel('narrative.narrative.narrativeText')), /chest pain/, 'the copy carries everything the original had');
  await twClick('[data-act=save]');
  await waitFor(async () => (await tplDb()).templates.some(x => x.owner_id === 'person-j' && x.name === 'Chest pain (copy 2)' && x.share === 'private'), { label: 'her second copy' });
  await waitFor(() => tw('[data-act=new]'), { label: 'list' });
  const okDialog = (d) => d.accept().catch(() => {}); T.page.on('dialog', okDialog);
  try {
    await T.page.evaluate(() => { const row = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl')).find(r => /^Chest pain \(copy 2\)/.test(r.querySelector('.tn').textContent)); row.querySelector('[data-act=delete]').click(); });
    await waitFor(async () => !(await tplDb()).templates.some(x => x.name === 'Chest pain (copy 2)'), { label: 'second copy deleted again' });
  } finally { T.page.off('dialog', okDialog); }
  // she tries to share her copy to everyone under his name: refused until she changes it
  await twClickText('.tpl [data-act=edit]', 'Edit');
  await waitFor(() => T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin input[name=share]')), { label: 'editor' });
  await twType('[data-name]', 'chest PAIN');
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin input[name=share][value=everyone]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  const said = []; const onDialog = (d) => { said.push(d.message()); d.accept(); }; T.page.on('dialog', onDialog);
  await twClick('[data-act=save]');
  await waitFor(() => said.length, { label: 'told' });
  T.page.off('dialog', onDialog);
  assert.match(said[0], /already a template called "Chest pain" shared to everyone \(made by TEST, MEDIC\)/);
  assert.ok(!(await tplDb()).templates.some(t => t.owner_id === 'person-j' && t.share === 'everyone'), 'not saved');
  await twType('[data-name]', 'Chest pain 2');
  await twClick('[data-act=save]');
  await waitFor(async () => (await tplDb()).templates.some(t => t.owner_id === 'person-j' && t.name === 'Chest pain 2' && t.share === 'everyone'), { label: 'saved under the new name' });
  await waitFor(() => tw('[data-act=new]'), { label: 'back on the list' });
  // Alex sees the one shared with him
  await T.control({ userName: 'JONES, ALEX', userId: 'person-m' });
  await freshRun();
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(async () => /For Alex/.test((await tw('.body')) || ''), { label: 'listed for him' });
  assert.match((await tw('.body')).split('Templates shared with you')[1].split('Templates shared to everyone')[0], /For Alex[\s\S]*shared by TEST, MEDIC/);
  assert.ok(!(await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl [data-act]')).some(b => /edit|delete/.test(b.dataset.act)))), 'no Edit or Delete on what others made');
  assert.equal((await tplDb()).templates.find(t => t.name === 'Chest pain').owner_id, 'person-1', 'the original is still his after the copy');
  await twClick('[data-act=close]');
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
});

test('templates: with no signal the fill is held and pushed when signal returns', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Narrative'));
  // the list was seen once with signal: it is kept on the device for this login
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(async () => (await T.storage()).tpls?.who === 'person-1' && /Chest pain/.test((await tw('.body')) || ''), { label: 'templates loaded' });
  await twClick('[data-act=close]');
  await T.context.setOffline(true);
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(async () => /Chest pain/.test((await tw('.body')) || ''), { label: 'templates from the device' });
  await T.page.evaluate(() => { const row = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl')).find(r => /^Chest pain/.test(r.querySelector('.tn').textContent)); row.querySelector('[data-act=fill]').click(); });
  await waitFor(async () => /Fill this run from/.test(await T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox') || {}).textContent || '')), { label: 'question' });
  await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(b => /Yes, fill it/.test(b.textContent)).click());
  await waitFor(async () => { const r = await T.run(id); return r && r.batches.filter(b => b.status === 'held').length >= 6; }, { label: 'held', timeout: 20000 });
  await waitFor(() => T.page.evaluate(() => /held until ESO answers/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil') || {}).textContent || '')), { label: 'the notice says held', timeout: 15000 });
  await T.context.setOffline(false);
  await waitFor(async () => (await T.record(id)).tree.narrative?.clinicalImpression?.primaryImpressionId === 500, { label: 'pushed once signal is back', timeout: 40000 });
  await waitFor(async () => (await T.run(id)).batches.every(b => b.status === 'acked' || b.status === 'dropped'), { label: 'all acked', timeout: 30000 });
});

test('templates: the agency owner locks a field and a part of the vitals; the crew sees the lock, cannot set them, and a fill leaves them out', async () => {
  const agency = async () => ((await fetch(T.base + '/__db_dump').then(r => r.json())).find(r => r.name === '__agency__') || {}).settings || {};
  await T.control({ userName: 'GASTON, MICHAEL', userId: 'd4e45fac-ee36-4ac8-bf9a-3fb3e265c0d0' });
  await freshRun();
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(() => tw('[data-act=new]'), { label: 'window' });
  await twClick('[data-act=new]');
  await waitFor(() => tw('[data-act=lockmode]'), { label: 'the owner sees Lock fields' });
  await twClick('[data-act=lockmode]');
  await twClick('[data-page=incident]');
  await waitFor(() => tw('[data-lock="incident.response.priorityId"]'), { label: 'lock buttons' });
  await twClick('[data-lock="incident.response.priorityId"]');
  await waitFor(async () => ((await agency()).tplLocks || []).includes('incident.response.priorityId'), { label: 'lock in the agency row' });
  await twClick('[data-page=vitals]');
  await twClick('[data-additem="vitals.vitalSigns"]');
  await waitFor(() => tw('[data-lock="vitals.vitalSigns.bloodPressure"]'), { label: 'a lock per vital group' });
  await twClick('[data-lock="vitals.vitalSigns.bloodPressure"]');
  await waitFor(async () => ((await agency()).tplLocks || []).includes('vitals.vitalSigns.bloodPressure'), { label: 'group lock in the agency row' });
  assert.match(await tw('[data-lock="vitals.vitalSigns.bloodPressure"]'), /Locked/);
  await twClick('[data-page=assessments]');
  await twClick('[data-additem="assessments.assessmentsV2"]');
  await waitFor(() => tw('.item [data-cat="Skin"]'), { label: 'the assessment' });
  await twClick('.item [data-cat="Skin"]');
  await waitFor(() => tw('[data-lock="assessments.assessmentsV2.findings.Skin"]'), { label: 'a lock per assessment category' });
  await twClick('[data-lock="assessments.assessmentsV2.findings.Skin"]');
  await waitFor(async () => ((await agency()).tplLocks || []).includes('assessments.assessmentsV2.findings.Skin'), { label: 'category lock in the agency row' });
  await twClick('[data-act=cancel]');
  // the crew: the lock shows, the field cannot be set, the template saves without it, the fill leaves it out
  await T.control({ userName: 'TEST, MEDIC', userId: 'person-1' });
  const id = await freshRun();
  await waitFor(async () => ((await T.storage()).settings.tplLocks || []).length === 3, { label: 'locks reached the tablet' });
  await app(() => window.app.edit('incident', 'incident.response.priorityId', 331, 'singleselect'));
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar [data-act=templates]').click());
  await waitFor(async () => /Chest pain/.test((await tw('.body')) || ''), { label: 'his templates' });
  assert.equal(await tw('[data-act=lockmode]'), null, 'no Lock fields for the crew');
  await T.page.evaluate(() => { const row = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl')).find(r => /^Chest pain/.test(r.querySelector('.tn').textContent)); row.querySelector('[data-act=edit]').click(); });
  await waitFor(() => tw('[data-page=incident]'), { label: 'editor' });
  await twClick('[data-page=incident]');
  const prio = () => T.page.evaluate((s) => { const r = document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin ' + s); return r ? { cls: r.className, text: r.textContent, dis: r.querySelector('[data-sel]').disabled, input: !!r.querySelector('[data-pick], [data-in]') } : null; }, rowSel('incident.response.priorityId'));
  const p = await waitFor(prio, { label: 'priority row' });
  assert.ok(/shut/.test(p.cls) && p.dis && !p.input && /Locked by the agency/.test(p.text), 'locked for the crew: ' + JSON.stringify(p));
  await twClick('[data-page=vitals]');
  const vit = await tw('.item');
  assert.match(vit, /Blood pressure[\s\S]*Locked by the agency/);
  assert.equal(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin .tf[data-key$="|bloodPressure.bloodPressureSystolic"]')), false, 'no blood pressure rows for the crew');
  assert.ok(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin .tf[data-key$="|pulse.pulseRate"]')), 'pulse still there');
  await twClick('[data-page=assessments]');
  // the template's assessment carries Cold and Clammy on the skin from its maker; the crew cannot touch the skin now, and a fill leaves it out
  await waitFor(() => tw('.item [data-cat="Skin"]'), { label: 'the assessment' });
  await twClick('.item [data-cat="Skin"]');
  await waitFor(async () => /Skin is locked by the agency/.test((await tw('.item .ax')) || ''), { label: 'the skin is locked for the crew' });
  assert.equal(await T.page.evaluate(() => !!document.getElementById('esosave-host').shadowRoot.querySelector('.tplwin [data-tog="Skin|Cold|1"]')), false, 'no skin findings to set');
  await twClick('.item [data-cat="HEENT"]');
  await waitFor(() => tw('[data-tog="Neck|JVD|1"]'), { label: 'the neck' });
  await twClick('[data-tog="Neck|JVD|1"]');
  await twClick('[data-act=save]');
  await waitFor(async () => { const t = (await tplDb()).templates.find(x => x.name === 'Chest pain'); return t && !t.body.fields['incident.response.priorityId'] && !t.body.items.find(i => i.kind === 'vital').fields['bloodPressure.bloodPressureSystolic']; }, { label: 'saved without the locked things' });
  await waitFor(() => tw('[data-act=new]'), { label: 'list' });
  await T.page.evaluate(() => { const row = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.tplwin .tpl')).find(r => /^Chest pain/.test(r.querySelector('.tn').textContent)); row.querySelector('[data-act=fill]').click(); });
  await waitFor(async () => /Fill this run from "Chest pain"/.test(await T.page.evaluate(() => (document.getElementById('esosave-host').shadowRoot.querySelector('.veil .askbox') || {}).textContent || '')), { label: 'question' });
  await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.askbox button')).find(b => /Yes, fill it/.test(b.textContent)).click());
  await waitFor(async () => (await T.record(id)).tree.vitals?.vitalSigns?.length === 1 && (await T.record(id)).tree.assessments?.assessmentsV2?.length === 1, { label: 'filled', timeout: 30000 });
  await waitFor(() => T.page.evaluate(() => /Filled from/.test((document.getElementById('esosave-host').shadowRoot.querySelector('.veil') || {}).textContent || '')), { label: 'notice', timeout: 15000 });
  const t = (await T.record(id)).tree;
  assert.equal(t.incident.response.priorityId, 331, 'the locked field kept what the medic set');
  assert.equal(t.incident.response.runTypeId, 326, 'the open field was filled');
  assert.equal(t.vitals.vitalSigns[0].pulse.pulseRate, '80'); assert.equal(t.vitals.vitalSigns[0].bloodPressure?.bloodPressureSystolic ?? null, null, 'no blood pressure from a template');
  const axf = Object.values(t.assessments.assessmentsV2[0].findings);
  assert.deepEqual(axf.filter(f => f.findingLocationId === 'Skin').map(f => f.findingId), ['Not_Assessed'], 'the locked skin is written Not Assessed, as ESO starts it');
  assert.deepEqual(axf.filter(f => f.findingLocationId === 'Neck').map(f => f.findingId), ['JVD'], 'the open neck finding went in');
  // the owner clears the locks
  await fetch(T.base + '/__db_set', { method: 'POST', body: JSON.stringify({ name: '__agency__', settings: { ...(await agency()), tplLocks: [] } }) });
  await T.setStorage({ settings: { ...(await T.storage()).settings, tplLocks: [] } });
});
