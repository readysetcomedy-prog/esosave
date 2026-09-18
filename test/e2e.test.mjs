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
  const buttons = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => ({ time: b.dataset.time, rect: b.getBoundingClientRect().toJSON() })));
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
  const buttons = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => b.getBoundingClientRect().toJSON()));
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
  const buttons = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.esosave-copy')).filter(b => b.style.display !== 'none').map(b => b.getBoundingClientRect().toJSON()));
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
  // and the setting turns it off
  const q = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return !!(el && el.getBoundingClientRect().height); }, sel);
  if (!(await q('.panel [data-act=settings]'))) await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.bar').click());
  await waitFor(() => q('.panel [data-act=settings]'), { label: 'panel open' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('[data-act=settings]').click());
  await waitFor(() => q('#times'), { label: 'settings open' });
  await T.page.evaluate(() => { const r = document.getElementById('esosave-host').shadowRoot; r.querySelector('#times').checked = false; r.querySelector('[data-act=save-settings]').click(); });
  await waitFor(async () => !(await strip()), { label: 'strip hidden' });
  assert.equal((await T.storage()).settings.showTimes, false);
  await T.setStorage({ settings: { ...(await T.storage()).settings, showTimes: true } });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.x').click());
});

const sh = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); return el ? el.textContent : null; }, sel);
const shClick = (sel) => T.page.evaluate((s) => { const el = document.getElementById('esosave-host').shadowRoot.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
function dialogs() { const seen = []; const on = (d) => { seen.push({ type: d.type(), message: d.message() }); d.accept().catch(() => {}); }; T.page.on('dialog', on); return { seen, off: () => T.page.off('dialog', on) }; }

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
  const text = await sh('.run.unsent');
  assert.match(text, /Gateway Regional Med Center/);
  assert.match(await sh('.bar'), /1 run not faxed/);
  await shClick('.panel [data-act=close]');
});

test('quick history chips: tap several, one open of ESO\'s Add History list ticks them all and presses OK', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Patient'));
  const chips = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip[data-group=history]')).map(c => ({ short: c.textContent, name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await chips()).length >= 20, { label: 'chips drawn' });
  const all = (await chips()).filter(c => !/other/.test(c.cls));
  assert.equal((await chips()).filter(c => /other/.test(c.cls)).length, 1, 'one Other… at the end of the row');
  const btn = await T.page.evaluate(() => document.getElementById('addhist').getBoundingClientRect().toJSON());
  const next = await T.page.evaluate(() => document.querySelector('#patient label').getBoundingClientRect().toJSON());
  assert.ok(all[0].rect.left > btn.right, 'first chip sits to the right of Add History');
  assert.ok(all.some(c => c.rect.top > btn.bottom), 'later chips wrap under the button');
  assert.ok(all.every(c => c.rect.bottom < next.top), 'no chip sits on the next field: the button made room');
  const tap = async (name) => { await waitFor(() => T.page.evaluate((n) => !!Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).find(x => x.title === n), name), { label: 'chip ' + name }); await T.page.evaluate((n) => { Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).find(x => x.title === n).click(); }, name); };
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
  await T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip[data-group=history]')).find(c => /other/.test(c.className)).click());
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
  const chips = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).map(c => ({ short: c.textContent, name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await chips()).length >= 55, { label: 'all three groups drawn' });
  const tap = async (name) => { await waitFor(() => T.page.evaluate((n) => !!Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).find(x => x.title === n), name), { label: 'chip ' + name }); await T.page.evaluate((n) => { Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).find(x => x.title === n).click(); }, name); };
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
  const btn = () => T.page.evaluate(() => { const b = document.getElementById('esosave-host').shadowRoot.querySelector('.quick .allnone[data-group=delays]'); return b ? { text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() } : null; });
  const b0 = await waitFor(async () => { const b = await btn(); return b && /\(4 left\)/.test(b.text) ? b : null; }, { label: 'All: None/No Delay button, counting the four still empty' });
  const field = await T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=DISPATCHDELAYS]').getBoundingClientRect().toJSON());
  assert.ok(b0.rect.bottom <= field.top && Math.abs(b0.rect.right - field.right) < 4, 'sits just above the first delay field, right-aligned');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.quick .allnone[data-group=delays]').click());
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
  const chips = (gk) => T.page.evaluate((g) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick .chip[data-group=${g}]:not(.other)`)).map(c => ({ short: c.textContent, name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })), gk);
  await waitFor(async () => (await chips('toStretcher')).length === 7 && (await chips('position')).length === 4 && (await chips('toAmbulance')).length === 1, { label: 'transport chips drawn' });
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip.other[data-group=toStretcher]').length), 1, 'Other… on the stretcher row');
  const lab = await T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=HOWPATIENTWASMOVEDTOSTRETCHERIDS] label').getBoundingClientRect().toJSON());
  const fld = await T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=HOWPATIENTWASMOVEDTOSTRETCHERIDS]').getBoundingClientRect().toJSON());
  const c0 = (await chips('toStretcher'))[0];
  assert.ok(c0.rect.top >= lab.bottom && Math.abs(c0.rect.left - fld.left) < 4 && c0.rect.right <= fld.right, 'first chip sits under the label, inside the field width');
  const tap = async (name) => { await waitFor(() => T.page.evaluate((n) => { const c = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).find(x => x.title === n); return !!c && !/busy/.test(c.className); }, name), { label: 'chip ' + name }); await T.page.evaluate((n) => { Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip')).find(x => x.title === n).click(); }, name); };
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
  await waitFor(() => T.page.evaluate(() => { const cs = Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip[data-group=fromAmbulance]:not(.other)')); return cs.length === 1 && !/busy/.test(cs[0].className); }), { label: 'from-ambulance chip free' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.quick .chip[data-group=fromAmbulance]:not(.other)').click());
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
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.panel [data-act=close]').click());
  // chips sit under each location's Predefined/Address pills
  const chips = (g) => T.page.evaluate((gg) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick .chip[data-group=${gg}]:not(.other)`)).map(c => ({ name: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })), g);
  await waitFor(async () => (await chips('fac-destination')).length === 2 && (await chips('fac-sending')).length === 1, { label: 'facility chips' });
  const pills = await T.page.evaluate(() => document.querySelector('eso-location[view-model="vm.destination"] .button-group').getBoundingClientRect().toJSON());
  const c0 = (await chips('fac-destination'))[0];
  assert.ok(c0.rect.top >= pills.bottom && Math.abs(c0.rect.left - pills.left) < 4, 'under the pills, left-aligned with them');
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip[data-group^=fac-].other').length), 0, 'no Other… of ours: ESO\'s Location Type has one');
  const tap = async (g, name) => { await waitFor(async () => (await chips(g)).some(c => c.name === name && !/busy/.test(c.cls)), { label: 'chip free' }); await T.page.evaluate(([gg, n]) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick .chip[data-group=${gg}]`)).find(c => c.title === n).click(), [g, name]); };
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
  // a second destination tap changes type and name again
  await tap('fac-destination', 'Anderson Hospital');
  await waitFor(async () => (await T.record(id)).tree.incident?.destination?.predefinedAddress?.predefinedLocationID === 'loc-anderson', { label: 'destination changed', timeout: 15000 });
  assert.equal((await T.record(id)).tree.incident.destination.predefinedAddress.locationTypeID, 6575);
  await T.setStorage({ settings: { ...(await T.storage()).settings, facilitySending: [], facilityDestination: [] } });
});

test('assessment: "All normal" presses No Abnormalities on every category in ESO\'s Quick Ax and OK; "A&Ox4" sets orientation', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Assessments'));
  await app(() => document.getElementById('addax').click());
  const rec0 = await waitFor(async () => { const r = await T.record(id); const a = r.tree.assessments?.assessmentsV2?.[0]; return a && (a.findings || []).length === 26 ? r : null; }, { label: 'assessment with 26 Not Assessed findings', timeout: 15000 });
  assert.ok(rec0.tree.assessments.assessmentsV2[0].findings.every(f => f.findingId === 'Not_Assessed'));
  const btns = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick [data-group^=assess-]')).map(b => ({ g: b.dataset.group, text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await btns()).length === 2, { label: 'All normal and A&Ox4 buttons' });
  const edit = await T.page.evaluate(() => document.querySelector('assessment-record .ax-edit-buttons').getBoundingClientRect().toJSON());
  const all = (await btns()).find(b => b.g === 'assess-all');
  assert.ok(all.rect.right < edit.left && Math.abs(all.rect.top + all.rect.height / 2 - (edit.top + edit.height / 2)) < 10, 'sits just left of ESO\'s edit buttons on the record header');
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.quick [data-group=assess-all]').click());
  const rec = await waitFor(async () => { const r = await T.record(id); const a = r.tree.assessments?.assessmentsV2?.[0]; return a && (a.findings || []).length === 26 && a.findings.every(f => f.findingId === 'No_Abnormalities') ? r : null; }, { label: 'every location No Abnormalities', timeout: 20000 });
  assert.equal(await app(() => window.app.quickAxOpens), 1, 'one Quick Ax open');
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'Quick Ax closed with OK' });
  const dels = rec.ops.filter(o => o.verb === 'DELETE' && /findings/.test(o.address)).length;
  assert.equal(dels, 26, 'each Not Assessed finding was removed the way ESO does it');
  await waitFor(async () => /done/.test((await btns()).find(b => b.g === 'assess-all').cls), { label: 'All normal shows done' });
  // A&Ox4
  await waitFor(async () => { const b = await btns(); return b.length === 2 && !b.some(x => /busy/.test(x.cls)); }, { label: 'free' });
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.quick [data-group=assess-ao]').click());
  await waitFor(async () => { const a = (await T.record(id)).tree.assessments.assessmentsV2[0]; return ['Oriented_Person', 'Oriented_Place', 'Oriented_Time', 'Oriented_Event'].every(x => a.findings.some(f => f.findingId === x && f.findingLocationId === 'MentalStatus')); }, { label: 'oriented x4 saved', timeout: 15000 });
  assert.equal(await app(() => window.app.mentalOpens), 1);
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'Mental Status closed with OK' });
  // a second press of All normal on an already-normal record presses nothing and still closes cleanly
  await waitFor(async () => { const b = await btns(); return b.length === 2 && !b.some(x => /busy/.test(x.cls)); }, { label: 'free again' });
  const before = (await T.record(id)).ops.length;
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.quick [data-group=assess-all]').click());
  await waitFor(async () => (await app(() => window.app.quickAxOpens)) === 2, { label: 'opened again' });
  await waitFor(async () => (await app(() => document.querySelectorAll('shelf-panel').length)) === 0, { label: 'closed again' });
  await sleep(800);
  assert.equal((await T.record(id)).ops.length, before, 'nothing re-saved');
});

test('disposition buttons set the whole set through ESO\'s pickers and quick-picks; red outline until Transport Mode or the refusal reason is answered', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Incident'));
  const btns = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick [data-group^=dispo-]')).map(b => ({ g: b.dataset.group, text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await btns()).length === 6, { label: 'five disposition buttons and Other…' });
  // Other… opens ESO's Unit Disposition list
  await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelector('.quick [data-group=dispo-other]').click());
  await waitFor(() => T.page.evaluate(() => !!document.querySelector('shelf-panel')), { label: 'unit disposition list opened' });
  assert.match(await app(() => document.querySelector('shelf-panel h1').textContent), /Unit Disposition/);
  await app(() => document.querySelector('shelf-panel header button').click());
  await waitFor(async () => (await btns()).length === 6, { label: 'buttons back' });
  // no row of ours over Response Mode to Scene: ESO shows Emergent / Non-Emergent / Other itself
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick [data-group=sr-resp]').length), 0);
  const unit = await T.page.evaluate(() => { const f = document.querySelector('eso-field[data-field-ref=UNITDISPOSITIONITEMID]'); return { f: f.getBoundingClientRect().toJSON(), lab: f.querySelector('label').getBoundingClientRect().toJSON(), area: f.querySelector('.field-area').getBoundingClientRect().toJSON() }; });
  const first = (await btns())[0];
  assert.ok(first.rect.top >= unit.lab.bottom && first.rect.bottom <= unit.area.top && Math.abs(first.rect.left - unit.f.left) < 4, 'row sits under the Unit Disposition label, above its value');
  const press = async (g) => { await waitFor(async () => { const b = (await btns()).find(x => x.g === g); return b && !/busy/.test(b.cls); }, { label: g }); await T.page.evaluate((gg) => document.getElementById('esosave-host').shadowRoot.querySelector(`.quick [data-group=${gg}]`).click(), g); };
  const dispo = async () => (await T.record(id)).tree.incident?.disposition || {};
  // Transported ALS
  await press('dispo-als');
  await waitFor(async () => (await dispo()).levelOfServiceId === 8196, { label: 'ALS set', timeout: 20000 });
  // ALS also goes to the Narrative page's care level and comes back; wait for that hop to finish
  await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil') && location.hash.endsWith('/incident')), { label: 'care-level hop done', timeout: 20000 });
  await waitFor(async () => (await T.record(id)).tree.narrative?.clinicalImpression?.providedCareLevelId === 14196, { label: 'care level matched', timeout: 15000 });
  await sleep(1200);
  const d1 = await dispo();
  assert.equal(d1.unitDispositionItemID, 14402); assert.equal(d1.patientEvaluationCareDispositionItemID, 14410); assert.equal(d1.crewDispositionItemID, 14415); assert.equal(d1.transportDispositionItemID, 14435);
  const need = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .need')).map(n => n.dataset.msg));
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
  const row = (g) => T.page.evaluate((gg) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className, rect: b.getBoundingClientRect().toJSON() })), g);
  // only what ESO's own quick-picks do not offer, and no Other… of ours (ESO has one)
  await waitFor(async () => (await row('sr-runtype')).length === 4 && (await row('sr-emd')).length === 15 && (await row('sr-reqby')).length === 4, { label: 'rows drawn' });
  assert.deepEqual((await row('sr-runtype')).map(b => b.text), ['Hosp-Hosp', 'Mutual Aid', 'Hosp-NonHosp', 'NonHosp-Hosp']);
  assert.deepEqual((await row('sr-reqby')).map(b => b.text), ['Physician', 'Law Enforcement', 'Fire Dept', 'Other Healthcare']);
  assert.ok(!(await row('sr-emd')).some(b => /Breathing|Sick Person|Traffic|Other/.test(b.text)));
  assert.equal((await row('sr-mutual')).length, 0, 'Mutual Aid row hidden while ESO keeps the field folded away (its box still measures)');
  const fld = await T.page.evaluate(() => { const f = document.querySelector('eso-field[data-field-ref=EMDCOMPLAINTID]'); return { f: f.getBoundingClientRect().toJSON(), lab: f.querySelector('label').getBoundingClientRect().toJSON(), area: f.querySelector('.field-area').getBoundingClientRect().toJSON() }; });
  const emd = await row('sr-emd');
  assert.ok(emd.every(c => c.rect.top >= fld.lab.bottom && c.rect.bottom <= fld.area.top + 2 && c.rect.right <= fld.f.right + 2), 'EMD chips wrap into rows under the label, above the value, within the field width');
  assert.ok(new Set(emd.map(c => Math.round(c.rect.top))).size >= 2, 'more than one row');
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const resp = async () => (await T.record(id)).tree.incident?.response || {};
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
  const chips = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip[data-group=mechanism]')).map(c => ({ short: c.textContent, cls: c.className })));
  await waitFor(async () => (await chips()).length === 4, { label: 'four chips, no extra Other…' });
  assert.deepEqual((await chips()).map(c => c.short), ['Blunt', 'Burn', 'Penetrating', 'Other']);
  const tap = async (t) => { await waitFor(async () => (await chips()).some(c => c.short === t && !/busy/.test(c.cls)), { label: t }); await T.page.evaluate((tt) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip[data-group=mechanism]')).find(c => c.textContent === tt).click(), t); };
  await tap('Blunt'); await tap('Penetrating');
  await waitFor(async () => ((await T.record(id)).tree.narrative?.injuries?.mechanismOfInjuryIds || []).length === 2, { label: 'both saved', timeout: 15000 });
  assert.deepEqual((await T.record(id)).tree.narrative.injuries.mechanismOfInjuryIds.map(Number).sort(), [7117, 7120]);
  await waitFor(async () => (await chips()).filter(c => /added/.test(c.cls)).length === 2, { label: 'both shown as set' });
});

test('Narrative rows: impressions, care level, duration units and every anatomic location, plus a 0-9 pad for the duration', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Narrative'));
  const row = (g) => T.page.evaluate((gg) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className })), g);
  await waitFor(async () => (await row('sr-primary')).length === 11 && (await row('sr-secondary')).length === 11 && (await row('sr-care')).length === 3 && (await row('sr-units')).length === 4 && (await row('sr-anatomic')).length === 9 && (await row('np-duration')).length === 12, { label: 'rows drawn' });
  assert.deepEqual((await row('sr-anatomic')).map(b => b.text), ['Head', 'Neck', 'Chest', 'Abd', 'Back', 'Upper Ext', 'Lower Ext', 'Genitalia', 'General'], 'every location, abbreviated, no Other…');
  assert.equal((await row('sr-primary')).at(-1).text, 'Other…');
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const nar = async () => (await T.record(id)).tree.narrative || {};
  await tap('sr-primary', 'Chest Pain');
  await waitFor(async () => (await nar()).clinicalImpression?.primaryImpressionId === 582, { label: 'primary impression', timeout: 15000 });
  await tap('sr-secondary', 'SOB');
  await waitFor(async () => (await nar()).clinicalImpression?.secondaryImpressionId === 630, { label: 'secondary impression', timeout: 15000 });
  await tap('sr-anatomic', 'Chest');
  await waitFor(async () => (await nar()).patientComplaint?.chiefComplaintAnatomicLocationId === 7096, { label: 'anatomic location', timeout: 15000 });
  await tap('sr-units', 'Hours');
  await waitFor(async () => (await nar()).patientComplaint?.chiefTimeUnitsOfComplaintDuration === 7082, { label: 'units', timeout: 15000 });
  // the pad: digits gather, then ESO's own number shelf is opened once, the value entered, OK pressed
  const opens = await app(() => window.app.shelfOpens);
  await tap('np-duration', '4');
  await waitFor(async () => (await row('np-duration')).some(b => /padval/.test(b.cls) && b.text === '4 …'), { label: 'pending value shown', interval: 30, timeout: 1200 });
  await tap('np-duration', '5');
  await waitFor(async () => (await nar()).patientComplaint?.chiefComplaintDuration === 45, { label: 'duration entered', timeout: 15000 });
  assert.equal(await app(() => window.app.shelfOpens), opens + 1, 'one open of the number shelf');
  await waitFor(() => T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=CHIEFCOMPLAINTDURATION] .display-value').textContent === '45'), { label: 'shown in the field' });
  await waitFor(async () => (await row('np-duration')).some(b => /padval/.test(b.cls) && b.text === '45'), { label: 'pad shows the value' });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('ALS / BLS chosen on either page sets the other page too, then comes back to where it was chosen', async () => {
  const id = await freshRun();
  await app(() => window.app.openTab('Narrative'));
  const row = (g) => T.page.evaluate((gg) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className })), g);
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  await app(() => { window.app.clicks = []; });
  await tap('sr-care', 'ALS Paramedic');
  await waitFor(async () => (await T.record(id)).tree.narrative?.clinicalImpression?.providedCareLevelId === 14196, { label: 'care level', timeout: 15000 });
  await waitFor(async () => (await T.record(id)).tree.incident?.disposition?.levelOfServiceId === 8196, { label: 'level of service matched on the Incident page', timeout: 20000 });
  await waitFor(() => app(() => window.app.clicks.join(',') === 'Incident,Narrative'), { label: 'went to Incident and came back', timeout: 15000 });
  await waitFor(() => app(() => location.hash.endsWith('/narrative')), { label: 'back on Narrative' });
  await waitFor(() => T.page.evaluate(() => !document.getElementById('esosave-host').shadowRoot.querySelector('.veil')), { label: 'hop finished' });
  // the other way: BLS through ESO's own quick-pick on the Incident page
  await app(() => window.app.openTab('Incident'));
  await waitFor(() => app(() => !!document.querySelector('eso-field[data-field-ref=LEVELOFSERVICEID] .display-value')?.textContent.includes('Advanced')), { label: 'Incident shows ALS' });
  await sleep(1500); // the watcher takes its first look
  await app(() => { window.app.clicks = []; window.app.ssSetForTest('LEVELOFSERVICEID', 8197); });
  await waitFor(async () => (await T.record(id)).tree.narrative?.clinicalImpression?.providedCareLevelId === 14194, { label: 'care level matched to BLS', timeout: 20000 });
  await waitFor(() => app(() => window.app.clicks.join(',') === 'Narrative,Incident'), { label: 'went to Narrative and came back', timeout: 15000 });
  assert.equal(await app(() => document.querySelectorAll('shelf-panel').length), 0);
});

test('Patient tab: Race row and 0-9 pads for Weight and Height (feet, inches); allergies keep only NKDA and Other…', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Patient'));
  const row = (g) => T.page.evaluate((gg) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).map(b => ({ text: b.textContent, cls: b.className })), g);
  await waitFor(async () => (await row('sr-race')).length === 2 && (await row('np-weight')).length === 12 && (await row('np-feet')).length === 12 && (await row('np-inches')).length === 12 && (await row('allergies')).length === 2, { label: 'rows drawn' });
  assert.deepEqual((await row('allergies')).map(b => b.text), ['NKDA', 'Other…']);
  const tap = async (g, text) => { await waitFor(async () => (await row(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick [data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
  const demo = async () => (await T.record(id)).tree.patient?.demographics || {};
  await tap('sr-race', 'Latino'); // no ESO quick-pick for this one: through the picker (a multi-select, so OK is pressed)
  await waitFor(async () => ((await demo()).raceIds || []).map(Number).includes(10317), { label: 'race', timeout: 15000 });
  await waitFor(async () => (await row('sr-race')).some(b => b.text === 'Latino' && /added/.test(b.cls)), { label: 'shown as set' });
  await tap('np-weight', '1'); await tap('np-weight', '5'); await tap('np-weight', '0');
  await waitFor(async () => (await demo()).weight === 150, { label: 'weight', timeout: 15000 });
  await waitFor(() => T.page.evaluate(() => document.querySelector('eso-field[data-field-ref=PATIENTWEIGHT] .display-value').textContent === '150 lbs'), { label: 'shown with its unit' });
  await tap('np-feet', '5'); // a one-digit field goes in after a shorter pause
  await waitFor(async () => (await demo()).heightFtComponent === 5, { label: 'feet', timeout: 15000 });
  await tap('np-inches', '1'); await tap('np-inches', '0');
  await waitFor(async () => (await demo()).heightInComponent === 10, { label: 'inches', timeout: 15000 });
  // ⌫ takes the last digit back before it goes in
  await tap('np-weight', '2'); await tap('np-weight', '9'); await tap('np-weight', '⌫');
  await waitFor(async () => (await demo()).weight === 2, { label: 'weight re-entered', timeout: 15000 });
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
  const tap = async (g, text) => { await waitFor(async () => (await chips(g)).some(b => b.text === text && !/busy/.test(b.cls)), { label: text }); await T.page.evaluate(([gg, t]) => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll(`.quick .chip[data-group=${gg}]`)).find(b => b.textContent === t).click(), [g, text]); };
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
  const layer = () => T.page.evaluate(() => { const l = document.getElementById('esosave-host').shadowRoot.querySelector('.quick'); return l ? l.style.clipPath : null; });
  await waitFor(async () => (await layer()) === 'inset(64px 0px 0px)', { label: 'clipped at the sticky top bar' }); // the mock's bar is 64px tall
  const bar = await T.page.evaluate(() => document.getElementById('topbar').getBoundingClientRect().bottom);
  assert.equal(bar, 64);
  await app(() => window.scrollTo(0, 400));
  await sleep(300);
  assert.equal(await layer(), 'inset(64px 0px 0px)', 'still clipped after a scroll');
  await app(() => window.scrollTo(0, 0));
});

test('quick acuity: red, yellow, green next to each acuity field, one tap picks it in ESO\'s list', async () => {
  const id = await app(() => window.app.recordId);
  await app(() => window.app.openTab('Narrative'));
  const sws = () => T.page.evaluate(() => Array.from(document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .sw')).map(c => ({ title: c.title, cls: c.className, rect: c.getBoundingClientRect().toJSON() })));
  await waitFor(async () => (await sws()).length === 6, { label: 'six swatches' });
  assert.equal(await T.page.evaluate(() => document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .chip.other:not([data-group])').length), 2, 'an Other… after each acuity row');
  const lab = await T.page.evaluate(() => document.querySelector('#narrative label').getBoundingClientRect().toJSON());
  const first = (await sws())[0];
  assert.ok(first.rect.left > lab.right && Math.abs(first.rect.top + first.rect.height / 2 - (lab.top + lab.height / 2)) < 8, 'swatches sit right after the label, on its line');
  const tapSw = async (i) => {
    await waitFor(() => T.page.evaluate((n) => { const b = document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .sw')[n]; return !!b && !/busy/.test(b.className); }, i), { label: 'swatch free' });
    await T.page.evaluate((n) => document.getElementById('esosave-host').shadowRoot.querySelectorAll('.quick .sw')[n].click(), i);
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
