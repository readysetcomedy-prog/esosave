/* ESO Save - extension-side content script (isolated world).
 *
 * - Makes sure the page-world interceptor (inject.js) is installed.
 * - Owns storage: every run's recorded batches, signature snapshots, blank-run templates, settings.
 * - Draws the always-visible status bar and the panel with the run list, restore buttons and log.
 */
(() => {
  'use strict';
  const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
  const INJECT_SRC = /*__INJECT_SRC__*/null;

  // ---------------------------------------------------------------- install the page-world script
  function ensureInjected() {
    if (document.documentElement.hasAttribute('data-esosave')) return;
    // Chrome honours "world": "MAIN" in the manifest. Safari does not, so load the same file from
    // the extension bundle as a page script (allowed by every CSP that trusts the extension origin),
    // and as a last resort inline it (ESO's own CSP allows inline scripts).
    try {
      const s = document.createElement('script');
      s.src = api.runtime.getURL('inject.js');
      s.async = false;
      s.onload = () => s.remove();
      s.onerror = () => { s.remove(); injectInline(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { injectInline(); }
    setTimeout(() => { if (!document.documentElement.hasAttribute('data-esosave')) injectInline(); }, 1500);
  }
  function injectInline() {
    if (document.documentElement.hasAttribute('data-esosave') || !INJECT_SRC) return;
    try {
      const s = document.createElement('script');
      s.textContent = INJECT_SRC;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* nothing else to try */ }
  }
  ensureInjected();

  const toPage = (type, payload) => window.postMessage({ __esosave: 'to-page', type, payload }, location.origin);

  // ---------------------------------------------------------------- storage
  const storage = api.storage.local;
  const sget = (keys) => new Promise(res => storage.get(keys, (v) => res(v || {})));
  const sset = (obj) => new Promise(res => storage.set(obj, () => res()));
  const sremove = (keys) => new Promise(res => storage.remove(keys, () => res()));
  const DEFAULT_SETTINGS = { valHighlight: true, purgeHoursAfterLock: 0, probeSec: 20, heldProbeSec: 8, warmTabs: true, cardCollapsed: false, showTimes: true, sendPrompt: true, unsentList: true, quickHistory: true, quickMeds: true, quickAllergies: true, quickAcuity: true, quickDelays: true, quickTransport: true, quickAssess: true, quickDisposition: true, autoResponse: true, quickIncident: true, quickMechanism: true, quickFacilities: true, quickNarrative: true, quickPatient: true, quickRefusal: true, autoMileage: true, askBeforeLock: true, cadGate: true, scanDocs: true, vitalCopySkip: [], tplLocks: [], facilitySending: [], facilityDestination: [] };
  // The agency's standard facility chips (ids and names from ESO's saved facilities). Every install
  // starts with these; Settings can add or remove per device.
  const FAC = {
    sbl: { id: '540af5e7-fbc6-f011-ad8f-6045bdb72f5d', name: 'Sarah Bush Lincoln', typeId: 6540, label: 'SB Mattoon' },
    stA: { id: 'dbe3de86-fac6-f011-ad8f-6045bdb72f5d', name: 'Saint Anthony Memorial Hospital', typeId: 6540, label: 'St A Effingham' },
    fch: { id: '477b90bc-f9c6-f011-ad8f-6045bdb72f5d', name: 'Fayette County Hospital', typeId: 6540, label: 'FCH' },
    holy: { id: 'b7e49057-fcc6-f011-ad8f-6045bdb72f5d', name: 'HSHS Holy Family Hospital', typeId: 6540, label: 'Holy Family' },
    highland: { id: 'a703d04c-fcc6-f011-ad8f-6045bdb72f5d', name: "HSHS St Joseph's Highland", typeId: 6540, label: "Joe's Highland" },
    breese: { id: '3cf3a995-fbc6-f011-ad8f-6045bdb72f5d', name: "HSHS St Joseph's Breese", typeId: 6540, label: "Joe's Breese" },
    anderson: { id: '4b5e73d9-f9c6-f011-ad8f-6045bdb72f5d', name: 'Anderson Hospital', typeId: 6540, label: 'Anderson' },
    carle: { id: '5e4c73a3-fcc6-f011-ad8f-6045bdb72f5d', name: 'Carle Foundation Hospital', typeId: 6540, label: 'Carle' },
    stJ: { id: '7a149502-f8c6-f011-ad8f-6045bdb72f5d', name: "HSHS St. John's", typeId: 6540, label: "St John's" },
    barnes: { id: '5362d2f7-fdc6-f011-ad8f-6045bdb72f5d', name: 'Barnes Jewish Hospital', typeId: 6540, label: 'Barnes' },
    slu: { id: '946f8531-fec6-f011-ad8f-6045bdb72f5d', name: 'SSM Health Saint Louis University', typeId: 6540, label: 'SLU' },
    seo: { id: '6dac3b3f-f8c6-f011-ad8f-6045bdb72f5d', name: "HSHS St. Elizabeth's Hospital", typeId: 6540, label: 'SEO' },
  };
  // every standard chip is a hospital: its type on the Scene side (ESO's location types) and on
  // the Destination side (ESO's destination types) is Hospital
  for (const f of Object.values(FAC)) { f.type = 'Hospital'; f.destType = 'Hospital'; }
  DEFAULT_SETTINGS.facilitySending = ['sbl', 'stA', 'fch', 'holy', 'highland', 'breese', 'anderson'].map(k => ({ ...FAC[k] }));
  DEFAULT_SETTINGS.facilityDestination = ['sbl', 'stA', 'fch', 'holy', 'highland', 'anderson', 'carle', 'stJ', 'barnes', 'slu', 'seo'].map(k => ({ ...FAC[k] }));

  // Settings the crew may change; everything else in Settings is locked (set in the code).
  // Ask the owner whether a new setting is locked or open before adding it (see CLAUDE.md).
  // the groups a saved vital is made of, as ESO's own view lays them out; the copy can leave any out
  const VITAL_GROUPS = [['bloodPressure', 'Blood pressure'], ['pulse', 'Pulse'], ['respiration', 'Respirations'], ['etCO2SPO2CO', 'SpO2, EtCO2 and CO'], ['glucoseAndTemp', 'Glucose and temperature'],
    ['pain', 'Pain scale'], ['avpu', 'AVPU'], ['position', 'Patient side and posture'], ['glasgowComaScale', 'Glasgow Coma Scale'], ['revisedTraumaScore', 'Revised trauma score'], ['cardiacMonitoring', 'Cardiac monitoring (ECG)']];
  const OPEN_SETTINGS = ['valHighlight', 'quickHistory', 'quickMeds', 'quickAllergies', 'quickAcuity', 'quickDelays', 'quickTransport', 'quickAssess', 'quickDisposition', 'autoResponse', 'quickIncident', 'quickMechanism', 'quickFacilities', 'quickNarrative', 'quickPatient', 'quickRefusal', 'autoMileage', 'scanDocs', 'vitalCopySkip', 'facilitySending', 'facilityDestination'];
  // The open settings follow the ESO login: one row per login in the agency's table, written when
  // the login is first seen and whenever they change something. Only these settings go there;
  // never a run, nor which runs were worked. The key is the project's public one.
  const ON_ESO = /(^|\.)esosuite\.net$/i.test(location.hostname);
  const SYNC = ON_ESO
    ? { url: 'https://qkprkwydxbtybaxylhln.supabase.co/rest/v1/esosave_users', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrcHJrd3lkeGJ0eWJheHlsaGxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzY2MTc2MjYsImV4cCI6MjA1MjE5MzYyNn0.DNjMTLqWtB7KJfZc3I03ufAPoIx69eA6wCkvhgdp7u4' }
    : { url: location.origin + '/__db/esosave_users', key: 'test-anon' };
  const openSettings = (src) => { const o = {}; for (const k of OPEN_SETTINGS) if (k in src) o[k] = src[k]; return o; };
  // The locked settings are the agency's: one row for all tablets, changed only by the agency's
  // owner (matched by ESO login name or agency person id), shown greyed out to everyone else.
  const LOCKED_SETTINGS = ['purgeHoursAfterLock', 'warmTabs', 'showTimes', 'sendPrompt', 'unsentList', 'askBeforeLock', 'cadGate', 'tplLocks'];
  const lockedSettings = (src) => { const o = {}; for (const k of LOCKED_SETTINGS) if (k in src) o[k] = src[k]; return o; };
  const AGENCY_ROW = '__agency__';
  const ADMIN = { name: 'GASTON, MICHAEL', id: 'd4e45fac-ee36-4ac8-bf9a-3fb3e265c0d0' };
  const isAdmin = () => (user && user.toUpperCase() === ADMIN.name) || (userId && userId === ADMIN.id);
  // the agency's tables (the RuralMed site): the call log and its users
  const AGENCY_DB = ON_ESO ? { url: 'https://qkprkwydxbtybaxylhln.supabase.co/rest/v1', key: SYNC.key } : { url: location.origin + '/__db', key: 'test-anon' };
  async function loadAll() {
    const all = await sget(null);
    const runs = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith('run:')) runs[k.slice(4)] = v;
    const settings = { ...DEFAULT_SETTINGS, ...(all.settings || {}) };
    if (!settings.facilityDefaults) { // first time with the standard facility chips: apply them once
      if (!(settings.facilitySending || []).length) settings.facilitySending = DEFAULT_SETTINGS.facilitySending.map(f => ({ ...f }));
      if (!(settings.facilityDestination || []).length) settings.facilityDestination = DEFAULT_SETTINGS.facilityDestination.map(f => ({ ...f }));
      settings.facilityDefaults = 1;
      await sset({ settings });
    }
    return { runs, templates: all.templates || null, settings, all };
  }
  async function purgeLocked(settings) {
    const { runs, all } = await loadAll();
    const hours = Number(settings.purgeHoursAfterLock);
    const cutoff = Date.now() - Math.max(0, hours) * 3600 * 1000;
    const stale = Date.now() - 30 * 24 * 3600 * 1000;
    const dead = Object.values(runs).filter(r => {
      if (r.batches.some(b => b.status === 'held' || b.status === 'rejected')) return false;
      if ((r.sends || []).some(x => x.status === 'held')) return false;
      if (r.locked && r.lockedAt && r.lockedAt <= Math.min(cutoff, Date.now() - 10 * 60 * 1000)) return true;
      if (!r.batches.length && !r.pendingCreate) return true;
      return (r.lastSeenAt || 0) < stale;
    });
    if (!dead.length) return;
    const keys = [];
    for (const r of dead) { keys.push('run:' + r.recordId, 'sigs:' + r.recordId); toPage('action', { name: 'forget', recordId: r.recordId }); }
    await sremove(keys.filter(k => k in all || k.startsWith('run:')));
  }

  let settings = { ...DEFAULT_SETTINGS };
  // The stored state goes to the page script once it is listening: when it is already there (the
  // manifest's MAIN-world script), right away; otherwise when it says hello. The page script
  // ignores a second copy.
  const booted = (async () => {
    const data = await loadAll();
    settings = data.settings;
    facilityTypes = data.all.facilityTypes || null;
    catalog = data.all.catalog || null;
    tpls = data.all.tpls || tpls;
    renderBar();
    await purgeLocked(settings);
    await sremove(['fieldDefs', 'knownViews']).catch(() => {}); // superseded keys from earlier versions
  })();
  async function sendInit() {
    await booted;
    const fresh = await loadAll();
    toPage('init', { runs: fresh.runs, templates: fresh.templates, settings, tabRequests: fresh.all.tabRequests || null, fieldDefs: fresh.all.fieldDefs2 || null, emailed: fresh.all.emailed || null });
  }
  (async () => {
    await booted;
    syncAgency();
    if (document.documentElement.hasAttribute('data-esosave')) await sendInit();
    setTimeout(() => { toPage('action', { name: 'facilities' }); toPage('action', { name: 'catalog' }); }, 1500);
    setInterval(() => purgeLocked(settings), 10 * 60 * 1000);
    // a row that could not be written (no signal, table away) goes when signal is back
    setInterval(() => { if (syncDirty && user && lastStatus && lastStatus.online && Date.now() - syncLastTry > 10000) { if (syncedUser !== user) syncUser(); else pushUser(); } }, 5000);
  })();
  // The page script may have been injected before our listener existed; ask for a status once ready.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__esosave !== 'to-ext') return;
    const { type, payload } = ev.data;
    if (type === 'hello') { sendInit(); }
    else if (type === 'persistRun' && payload && payload.run) {
      await sset({ ['run:' + payload.run.recordId]: payload.run });
    } else if (type === 'persistFieldDefs' && payload && payload.fieldDefs) {
      await sset({ fieldDefs2: payload.fieldDefs });
    } else if (type === 'event' && payload && payload.name === 'vitalCopied') {
      onVitalCopied(payload);
    } else if (type === 'facilities' && payload && Array.isArray(payload.items)) {
      facilities = payload;
      facilityTypes = { locationTypes: payload.locationTypes || [], destinationTypes: payload.destinationTypes || [], crew: payload.crew || [], lists: payload.lists || null };
      await sset({ facilityTypes });
      if (panelOpen && settingsOpen) renderPanel(); layoutQuick();
    } else if (type === 'event' && payload && payload.name === 'attached') {
      onAttached(payload);
    } else if (type === 'event' && payload && payload.name === 'facesheetFilled') {
      onFacesheetFilled(payload);
    } else if (type === 'catalog' && payload && Array.isArray(payload.fields)) {
      catalog = payload; await sset({ catalog });
      if (tplWin) renderTemplates();
    } else if (type === 'event' && payload && payload.name === 'templateProgress') {
      onTemplateProgress(payload);
    } else if (type === 'event' && payload && payload.name === 'templateFilled') {
      onTemplateFilled(payload);
    } else if (type === 'event' && payload && payload.name === 'sendPrompt') {
      showSendPrompt(payload);
    } else if (type === 'event' && payload && payload.name === 'sent') {
      onSent(payload);
    } else if (type === 'persistEmailed' && payload && payload.pcrId) {
      const cur = (await sget('emailed')).emailed || {};
      cur[payload.pcrId] = payload.ts || Date.now();
      const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
      for (const k of Object.keys(cur)) if (cur[k] < cutoff) delete cur[k];
      await sset({ emailed: cur });
    } else if (type === 'persistTabRequests' && payload && payload.tabRequests) {
      await sset({ tabRequests: payload.tabRequests });
    } else if (type === 'persistTemplates') {
      await sset({ templates: payload.templates });
    } else if (type === 'sig' && payload) {
      const key = 'sigs:' + (payload.recordId || 'unknown');
      const cur = (await sget(key))[key] || [];
      cur.push(payload);
      while (cur.length > 60) cur.shift();
      await sset({ [key]: cur });
      if (panelOpen) renderPanel();
    } else if (type === 'status' && payload) {
      lastStatus = payload;
      if (payload.userId !== undefined) userId = payload.userId;
      if (payload.user && payload.user !== user) { user = payload.user; sset({ user }); syncUser(); }
      maybeWarmTabs(payload);
      if (payload.runs.some(r => r.locked)) purgeLocked(settings);
      renderBar();
      renderTimes();
      layoutQuick();
      if (panelOpen) renderPanel();
      try { api.runtime.sendMessage({ type: 'badge', held: payload.held, rejected: payload.rejected, online: payload.online }); } catch (e) { /* worker asleep */ }
    }
  });

  // ---------------------------------------------------------------- UI
  let lastStatus = null;
  let user = null;       // the ESO login shown by the app
  let userId = null;     // their agency person id: the crew list of a run carries the same ids
  let syncedUser = null; // the login whose row has been fetched and applied
  let syncDirty = false; // a change of ours has not reached the table yet
  let syncLastTry = 0;
  let facilities = null; // ESO's saved facilities, from its configuration bundle
  let facilityTypes = null; // ESO's location and destination type tables, kept from the last bundle seen
  let panelOpen = false;
  let host, shadow, bar, panel;
  const fmtTime = (t) => t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
  const fmtWhen = (t) => t ? new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .bar { position: fixed; left: 8px; bottom: 8px; width: 196px; z-index: 2147483646; border-radius: 10px; padding: 8px 10px;
           font-size: 12px; color: #fff; cursor: pointer; user-select: none; box-shadow: 0 4px 14px rgba(0,0,0,.3); transition: background .2s; line-height: 1.3; }
    .bar.good { background: #15803d; } .bar.warn { background: #b45309; } .bar.bad { background: #b91c1c; } .bar.info { background: #1d4ed8; }
    .bar.warn, .bar.bad { animation: pulse 1.6s ease-in-out infinite; }
    .copylayer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483640; }
    .quick { position: fixed; inset: 0; pointer-events: none; z-index: 2147483640; font: 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .copylayer .sheet, .quick .sheet { position: absolute; inset: 0; pointer-events: none; will-change: transform; }
    .quick .chip { position: fixed; pointer-events: auto; height: 28px; padding: 0 11px; border-radius: 14px; border: 1px solid #94a3b8; background: #fff; color: #1e293b; font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .quick .chip:hover { border-color: #15803d; }
    .quick .chip.on { background: #15803d; border-color: #15803d; color: #fff; }
    .quick .chip.added { background: #dcfce7; border-color: #86efac; color: #166534; cursor: default; }
    .quick .chip.added::before { content: '✓ '; }
    .quick .chip.added.off { background: #fee2e2; border-color: #fca5a5; color: #991b1b; text-decoration: line-through; }
    .quick .chip.busy { opacity: .6; cursor: wait; }
    .quick .chip.other, .quick .allnone.other { border-style: dashed; color: #475569; font-weight: 600; }
    .quick .sw { position: fixed; pointer-events: auto; width: 34px; height: 26px; border-radius: 7px; border: 2px solid transparent; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .quick .sw.red { background: #dc2626; } .quick .sw.yellow { background: #facc15; } .quick .sw.green { background: #16a34a; }
    .quick .sw.cur { border-color: #0f172a; box-shadow: 0 0 0 2px #fff, 0 0 0 4px #0f172a; }
    .quick .sw.busy { opacity: .5; cursor: wait; }
    .quick .allnone { position: fixed; pointer-events: auto; height: 30px; padding: 0 14px; border-radius: 8px; border: 1px solid #15803d; background: #fff; color: #15803d; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .quick .allnone:hover { background: #f0fdf4; }
    .quick .allnone.done { background: #dcfce7; border-color: #86efac; color: #166534; cursor: default; }
    .quick .need { position: fixed; pointer-events: none; border: 2px solid #dc2626; border-radius: 6px; box-shadow: 0 0 0 3px rgba(220,38,38,.15); }
    .quick .need::after { content: attr(data-msg); position: absolute; right: 6px; top: -11px; background: #dc2626; color: #fff; font: 700 11px/16px system-ui, sans-serif; padding: 1px 7px; border-radius: 8px; }
    .times { position: fixed; z-index: 2147483639; display: flex; gap: 4px; align-items: stretch; pointer-events: none; font: 12px/1.15 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: nowrap; overflow: hidden; }
    .times .t { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 46px; padding: 3px 6px; border-radius: 7px; background: rgba(255,255,255,.10); color: #fff; }
    .times .t .l { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; opacity: .75; }
    .times .t .v { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 1px; }
    .times .t.empty .v { opacity: .35; font-weight: 400; }
    .times.tight { gap: 3px; } .times.tight .t { min-width: 40px; padding: 2px 3px; } .times.tight .t .v { font-size: 13px; } .times.tight .t .l { font-size: 9px; }
    .times.micro { gap: 2px; } .times.micro .t { min-width: 33px; padding: 1px 2px; border-radius: 5px; } .times.micro .t .v { font-size: 11px; } .times.micro .t .l { font-size: 7px; letter-spacing: 0; }
    .copylayer .esosave-copy { position: fixed; pointer-events: auto; width: 26px; height: 22px; margin: 0; padding: 0; border: 0; border-radius: 6px; background: #15803d; color: #fff; font: 15px/22px system-ui, sans-serif; text-align: center; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
    .copylayer .esosave-copy:hover { background: #166534; }
    @keyframes pulse { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }
    .bar .title { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #fff; flex: none; }
    .bar .msg { margin-top: 3px; opacity: .95; word-break: break-word; }
    .bar .who { margin-top: 2px; font-size: 11px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel label.s.locked { opacity: .6; }
    .panel .lock { font-size: 11px; color: #64748b; margin: 4px 0 6px; }
    .bar .num { font-weight: 700; }
    .bar .btns { display: flex; gap: 6px; margin-top: 7px; }
    .bar .title { justify-content: space-between; }
    .bar .fold { margin-left: auto; width: 22px; height: 22px; border-radius: 6px; border: 1px solid rgba(255,255,255,.5); background: rgba(255,255,255,.15); color: #fff; font-size: 14px; line-height: 20px; text-align: center; cursor: pointer; flex: none; }
    .bar.collapsed { width: 56px; height: 56px; padding: 0; border-radius: 14px; background: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .bar.collapsed img { width: 48px; height: 48px; display: block; }
    .bar.collapsed .ring { position: absolute; inset: -3px; border-radius: 17px; border: 3px solid #15803d; pointer-events: none; }
    .bar.collapsed.warn .ring { border-color: #b45309; } .bar.collapsed.bad .ring { border-color: #b91c1c; } .bar.collapsed.info .ring { border-color: #1d4ed8; }
    .bar.collapsed .pip { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px; background: #b45309; color: #fff; font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; padding: 0 5px; }
    .bar.collapsed.bad .pip { background: #b91c1c; }
    @media (max-width: 640px) { .bar.collapsed { left: 8px; right: auto; bottom: 8px; width: 56px; border-radius: 14px; } }
    .bar .btn { background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.55); color: #fff; border-radius: 6px; padding: 3px 9px; font-size: 12px; font-weight: 600; cursor: pointer; }
    @media (max-width: 640px) { .bar { left: 0; right: 0; bottom: 0; width: auto; border-radius: 0; } }
    .veil { position: fixed; inset: 0; z-index: 2147483645; background: rgba(15, 23, 42, .55); display: flex; align-items: center; justify-content: center; cursor: wait; }
    .veil .box { background: #fff; color: #111; border-radius: 14px; padding: 22px 26px; width: min(420px, calc(100vw - 32px)); box-shadow: 0 16px 48px rgba(0,0,0,.4); text-align: center; }
    .veil .spin { width: 44px; height: 44px; border: 5px solid #d1fae5; border-top-color: #15803d; border-radius: 50%; margin: 0 auto 12px; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .veil h2 { font-size: 18px; margin: 0 0 6px; }
    .veil .prog { font-size: 15px; font-weight: 600; color: #15803d; margin: 6px 0; min-height: 20px; }
    .veil .why { font-size: 13px; color: #555; line-height: 1.4; }
    .veil .track { height: 6px; background: #e5e7eb; border-radius: 3px; margin: 10px 0 12px; overflow: hidden; }
    .veil .fill { height: 100%; background: #15803d; width: 0; transition: width .3s; }
    .veil button.a { margin-top: 4px; }
    .veil .row { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 14px; }
    .veil .row button.a { font-size: 15px; padding: 10px 16px; }
    .veil .askbox, .veil .lockask { max-width: min(720px, 92vw); }
    .veil .askbox h2, .veil .lockask h2 { font-size: 22px; }
    .veil .askbox .why, .veil .lockask .why { font-size: 17px !important; }
    .veil .askbox .actions, .veil .lockask .actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 8px; }
    .veil .askbox .actions button.a, .veil .lockask .actions button.a { font-size: 19px; padding: 16px 26px; min-height: 58px; min-width: 150px; border-radius: 10px; margin: 0; }
    .veil .fillask .actions button.a { font-size: 17px; min-height: 52px; }
    .urow { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #eee; font-size: 13px; }
    .urow .actions { margin: 0; }
    .fac { margin-top: 8px; } .fac .chosen { margin: 4px 0; display: flex; flex-wrap: wrap; gap: 4px; } .fac .chosen a { cursor: pointer; font-weight: 700; margin-left: 2px; }
    .fac .facq { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
    .fac .facm { display: flex; flex-direction: column; } .fac .facm a { cursor: pointer; padding: 4px 6px; border-bottom: 1px solid #eee; } .fac .facm a:hover { background: #f1f5f9; }
    .pick { text-align: left; }
    .pick h2 { text-align: center; }
    .pick .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px solid #eee; }
    .pick .row .name { font-weight: 600; } .pick .row .n { color: #666; font-size: 12px; margin-left: 6px; font-weight: 400; }
    .pick .row.off .name { color: #999; }
    .sw { position: relative; width: 46px; height: 26px; border-radius: 13px; background: #cbd5e1; border: 0; cursor: pointer; flex: none; transition: background .15s; }
    .sw::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .15s; }
    .sw.on { background: #15803d; } .sw.on::after { left: 23px; }
    .sw:disabled { opacity: .4; cursor: default; }
    .pick .warn { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; border-radius: 8px; padding: 8px 10px; font-size: 13px; margin: 10px 0 0; line-height: 1.35; }
    .pick .btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
    .pick .sub { text-align: center; color: #555; font-size: 13px; margin-bottom: 8px; }
    .tplwin { position: fixed; inset: 0; z-index: 2147483647; background: #f8fafc; color: #111; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
    .tplwin .tophead { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #15803d; color: #fff; flex-wrap: wrap; }
    .tplwin .tophead h1 { font-size: 20px; margin: 0; flex: 1; }
    .tplwin .tophead input.name { font-size: 18px; padding: 8px 10px; border-radius: 8px; border: 0; min-width: 260px; }
    .tplwin .body { flex: 1; overflow: auto; padding: 14px 16px 60px; }
    .tplwin .tb { background: #fff; color: #111; border: 0; border-radius: 10px; padding: 12px 18px; font: inherit; font-weight: 700; cursor: pointer; min-height: 44px; }
    .tplwin .tb.pri { background: #1d4ed8; color: #fff; } .tplwin .tb.danger { background: #fee2e2; color: #991b1b; } .tplwin .tb.sec { background: #e2e8f0; }
    .tplwin h2 { font-size: 17px; margin: 18px 0 8px; color: #334155; }
    .tplwin .tpl { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; margin: 6px 0; flex-wrap: wrap; }
    .tplwin .tpl .tn { font-weight: 700; font-size: 17px; flex: 1; min-width: 160px; } .tplwin .tpl .by { color: #64748b; font-size: 13px; }
    .tplwin .pages { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 12px; }
    .tplwin .pages button { border: 1px solid #cbd5e1; background: #fff; border-radius: 20px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; min-height: 40px; }
    .tplwin .pages button.on { background: #1d4ed8; color: #fff; border-color: #1d4ed8; } .tplwin .pages button .cnt { background: #fbbf24; color: #111; border-radius: 10px; padding: 0 7px; margin-left: 6px; font-size: 12px; }
    .tplwin details.sec { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; margin: 8px 0; padding: 0 12px; }
    .tplwin details.sec > summary { cursor: pointer; font-weight: 700; padding: 12px 0; font-size: 16px; list-style: none; display: flex; align-items: center; gap: 8px; }
    .tplwin details.sec > summary::before { content: '▸'; color: #64748b; } .tplwin details.sec[open] > summary::before { content: '▾'; }
    .tplwin .tf { display: grid; grid-template-columns: 34px minmax(160px, 1fr) minmax(220px, 2fr); gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid #f1f5f9; }
    .tplwin .tf input[type=checkbox] { width: 24px; height: 24px; }
    .tplwin .tf.shut { opacity: .75; background: #f8fafc; }
    .tplwin .tf .fl { font-weight: 600; } .tplwin .tf.on .fl { color: #1d4ed8; }
    .tplwin .tf input[type=text], .tplwin .tf input[type=date], .tplwin .tf input[type=time], .tplwin .tf input[type=datetime-local], .tplwin .tf select, .tplwin .tf textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 8px; min-height: 42px; background: #fff; }
    .tplwin .pick { position: relative; } .tplwin .pick .chosen { font-size: 14px; color: #1d4ed8; font-weight: 700; margin-top: 3px; min-height: 18px; }
    .tplwin .pick .chosen span { display: inline-block; background: #dbeafe; border-radius: 12px; padding: 2px 10px; margin: 2px 4px 2px 0; }
    .tplwin .picklist { position: absolute; left: 0; right: 0; top: 44px; max-height: 300px; overflow: auto; background: #fff; border: 1px solid #94a3b8; border-radius: 8px; z-index: 5; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
    .tplwin .picklist button { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #f1f5f9; background: #fff; padding: 11px 12px; font: inherit; cursor: pointer; min-height: 42px; } .tplwin .picklist button.sel { background: #dbeafe; }
    .tplwin .item { border: 1px solid #cbd5e1; border-radius: 10px; margin: 8px 0; padding: 6px 12px 10px; background: #fafafa; }
    .tplwin .item .ih { display: flex; align-items: center; gap: 10px; font-weight: 700; padding: 6px 0; }
    .tplwin .share { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin: 8px 0; } .tplwin .share label { display: flex; gap: 6px; align-items: center; font-weight: 600; }
    .tplwin .muted { color: #64748b; font-size: 13px; }
    .tplwin .ax { margin: 6px 0; } .tplwin .ax h4 { margin: 10px 0 4px; font-size: 15px; color: #334155; }
    .tplwin .ax .loc { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(200px, 1fr); gap: 8px; align-items: center; padding: 3px 0; }
    .tplwin .search { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; margin: 6px 0 4px; min-height: 42px; }
    .panel { position: fixed; left: 212px; bottom: 8px; width: min(560px, calc(100vw - 228px)); max-height: min(85vh, 720px); overflow: auto; z-index: 2147483647;
             background: #fff; color: #111; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.35); padding: 14px 16px; font-size: 14px; line-height: 1.4; }
    .panel h1 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; justify-content: space-between; }
    .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #555; margin: 14px 0 6px; }
    .panel .x { cursor: pointer; font-size: 20px; padding: 0 6px; color: #666; }
    .run { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
    .run.current { border-color: #1d4ed8; box-shadow: 0 0 0 2px rgba(29,78,216,.15); }
    .run .head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .run .num { font-weight: 700; font-size: 15px; }
    .pill { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 600; margin-left: 4px; }
    .pill.good { background: #dcfce7; color: #166534; } .pill.warn { background: #fef3c7; color: #92400e; } .pill.bad { background: #fee2e2; color: #991b1b; } .pill.info { background: #dbeafe; color: #1e40af; } .pill.gray { background: #eee; color: #444; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    button.a { background: #1d4ed8; color: #fff; border: 0; border-radius: 6px; padding: 6px 10px; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.a.sec { background: #e5e7eb; color: #111; } button.a.danger { background: #b91c1c; }
    button.a:disabled { opacity: .5; cursor: default; }
    .log { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: #f6f6f6; border-radius: 8px; padding: 8px; max-height: 180px; overflow: auto; margin-top: 8px; white-space: pre-wrap; }
    .log .error { color: #b91c1c; font-weight: 700; } .log .warn { color: #b45309; } .log .good { color: #15803d; }
    .sigs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .sig { border: 1px solid #ddd; border-radius: 8px; padding: 6px; width: 160px; font-size: 11px; }
    .sig img { width: 100%; height: 60px; object-fit: contain; background: #fff; border-bottom: 1px solid #eee; margin-bottom: 4px; }
    .sig a { color: #1d4ed8; }
    .muted { color: #666; font-size: 12px; }
    @media (max-width: 640px) { .panel { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: 80vh; } }
    label.s { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
    input[type=number] { width: 70px; padding: 4px; }
  `;

  function mountUI() {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.id = 'esosave-host';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = CSS; shadow.appendChild(style);
    bar = document.createElement('div'); bar.className = 'bar info';
    bar.addEventListener('click', (e) => { if (e.target.closest('.btn, .fold')) return; if (settings.cardCollapsed) { setCollapsed(false, true); return; } togglePanel(); });
    shadow.appendChild(bar);
    document.body.appendChild(host);
    renderBar();
  }
  if (document.body) mountUI(); else document.addEventListener('DOMContentLoaded', mountUI);
  // ESO might replace the body; keep the bar alive.
  setInterval(() => { if (host && !document.body.contains(host)) document.body.appendChild(host); }, 3000);

  function barState(s) {
    if (!s) return { cls: 'info', title: 'ESO Save', msg: 'starting…' };
    const cur = s.runs.find(r => r.recordId === s.currentRecordId);
    const num = cur && cur.incidentNumber ? cur.incidentNumber : null;
    const held = s.held ? `${s.held} change${s.held === 1 ? '' : 's'} held on this device` : '';
    if (s.rejected) return { cls: 'bad', title: 'ESO REJECTED a save', msg: `${s.rejected} change${s.rejected === 1 ? '' : 's'} not accepted. Tap for details.`, num, btn: 'Details' };
    if (s.loggedOut) return { cls: 'bad', title: 'LOGGED OUT of ESO', msg: s.held ? held + '. Will push after you log in.' : 'Log in again to keep saving.', num, btn: 'Details' };
    if (!s.online) return { cls: 'warn', title: 'NO SIGNAL', msg: s.held ? held + '. Keep working.' : 'Keep working. Changes are being kept here.', num, btn: s.held ? 'Push now' : null };
    if (s.pushing) return { cls: 'info', title: 'Pushing to ESO…', msg: held, num };
    if (s.held) return { cls: 'warn', title: 'Changes held', msg: held + '. Pushing shortly.', num, btn: 'Push now' };
    const unsent = settings.unsentList !== false && s.unsent && s.unsent.items.length;
    return { cls: 'good', title: 'ESO Save · signal OK', msg: (cur && cur.lastSavedAt ? `last save ${fmtTime(cur.lastSavedAt)}` : 'all saved') + (unsent ? ` · ${unsent} run${unsent === 1 ? '' : 's'} not faxed` : ''), num, btn: null }; // the Not sent list lives in the opened card, not as a button on its front
  }
  let lastCls = null;
  function renderBar() {
    if (!bar) return;
    const st = barState(lastStatus);
    // Only a turn to red (rejected save, logged out) un-collapses the card. Amber (no signal, changes
    // held) shows as the ring colour and the count, so the card stays the way the medic left it.
    if (settings.cardCollapsed && lastCls && lastCls !== st.cls && st.cls === 'bad') setCollapsed(false, false);
    lastCls = st.cls;
    if (settings.cardCollapsed) {
      const held = lastStatus && (lastStatus.held || 0);
      const rejected = lastStatus && (lastStatus.rejected || 0);
      bar.className = 'bar collapsed ' + st.cls;
      bar.title = st.title + (st.msg ? ' · ' + st.msg : '') + ' (tap to expand)';
      bar.innerHTML = `<img src="${api.runtime.getURL('icons/logo.png')}" alt="ESO Save"><span class="ring"></span>${rejected ? '<span class="pip">!</span>' : held ? `<span class="pip">${held}</span>` : ''}`;
      return;
    }
    bar.className = 'bar ' + st.cls;
    bar.title = '';
    bar.innerHTML = `<div class="title"><span class="dot"></span><span>${esc(st.title)}</span><span class="fold" data-act="collapse" title="Collapse to just the logo">–</span></div>` +
      (user ? `<div class="who" title="Signed in to ESO as ${esc(user)}: the runs and settings shown are theirs">${esc(user)}</div>` : '') +
      `<div class="msg">${st.num ? `<span class="num">${esc(st.num)}</span> · ` : ''}${esc(st.msg)}</div>` +
      `<div class="btns">${st.btn ? `<span class="btn" data-act="${st.btn === 'Push now' ? 'push' : 'open'}">${esc(st.btn)}</span>` : ''}<span class="btn" data-act="templates">Templates</span><span class="btn" data-act="open">Runs</span></div>`;
    bar.querySelectorAll('.btn, .fold').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.act === 'push') toPage('action', { name: 'pushNow' });
      else if (b.dataset.act === 'templates') openTemplates();
      else if (b.dataset.act === 'collapse') setCollapsed(true, true);
      else togglePanel(true);
    }));
  }
  async function setCollapsed(v, save) {
    settings.cardCollapsed = !!v;
    if (save) await sset({ settings });
    if (!v && panel) panel.style.display = panelOpen ? 'block' : 'none';
    renderBar();
  }
  function togglePanel(force) {
    panelOpen = force === undefined ? !panelOpen : !!force;
    if (panelOpen) {
      if (!panel) { panel = document.createElement('div'); panel.className = 'panel'; shadow.appendChild(panel); }
      renderPanel(); panel.style.display = 'block';
      if (settings.unsentList !== false && (!lastStatus || !lastStatus.unsent || Date.now() - lastStatus.unsent.at > 2 * 60 * 1000)) toPage('action', { name: 'scanUnsent' });
    }
    else if (panel) panel.style.display = 'none';
  }
  async function renderPanel() {
    if (!panel || !panelOpen) return;
    const s = lastStatus || { runs: [], online: true };
    const all = await sget(null);
    const parts = [];
    parts.push(`<h1><span>ESO Save <span class="muted" style="font-weight:400;font-size:11px">v${esc(api.runtime.getManifest().version)}</span></span><span class="x" data-act="close">×</span></h1>`);
    // a run is its crew's: listed for any login on its personnel list. A run whose crew is not
    // known yet falls back to the login that first worked it on this tablet.
    const mine = (r) => !user || (r.crewIds && r.crewIds.length ? !!userId && r.crewIds.includes(userId) : !r.owner || r.owner === user);
    const nRuns = s.runs.filter(r => (r.counts.total || r.pendingCreate) && mine(r)).length;
    parts.push(`<div class="muted">${s.online ? 'Signal OK' : 'NO SIGNAL'}${s.loggedOut ? ' · logged out' : ''}${s.pushing ? ' · pushing' : ''} · ${nRuns} run${nRuns === 1 ? '' : 's'} on this device` +
      `${user ? ` · signed in as <b>${esc(user)}</b>` : ''}` +
      `${s.hasTemplates ? '' : ' · <span title="Start one run with signal so a blank-run template is saved">no offline new-run template yet</span>'}</div>`);
    parts.push(`<div class="actions"><button class="a" data-act="push">Push all held changes now</button><button class="a sec" data-act="export-all">Export everything</button><button class="a sec" data-act="settings">Settings</button></div>`);
    if (settingsOpen) {
      const dis = isAdmin() ? '' : 'disabled', lk = isAdmin() ? '' : ' locked';
      parts.push(`<div class="run">` +
        `<div class="lock">${isAdmin() ? '🔓 Agency settings: yours to change. They apply to every tablet.' : '🔒 Set by the agency. These cannot be changed here.'}</div>` +
        `<label class="s${lk}">Clear a run from this device <input type="number" min="0" max="720" id="purge" value="${esc(settings.purgeHoursAfterLock)}" ${dis}> hours after it is locked (0 = as soon as the lock is seen)</label>` +
        `<label class="s${lk}"><input type="checkbox" id="warm" ${settings.warmTabs === false ? '' : 'checked'} ${dis}> Open every tab once, quietly, when a run opens (so tabs you have not touched still work with no signal)</label>` +
        `<label class="s${lk}"><input type="checkbox" id="times" ${settings.showTimes === false ? '' : 'checked'} ${dis}> Show the call times (dispatched, en route, on scene, at patient, depart, at destination, transfer) in the empty part of ESO's top bar</label>` +
        `<label class="s${lk}"><input type="checkbox" id="sendprompt" ${settings.sendPrompt === false ? '' : 'checked'} ${dis}> When a run is locked, offer to fax or email it to the destination if it has not been sent yet</label>` +
        `<label class="s${lk}"><input type="checkbox" id="unsentlist" ${settings.unsentList === false ? '' : 'checked'} ${dis}> Keep a list of locked runs from the last 15 days that have a fax or email destination but were never sent</label>` +
        `<label class="s${lk}"><input type="checkbox" id="asklock" ${settings.askBeforeLock === false ? '' : 'checked'} ${dis}> Before a lock, ask whether the proper paperwork is attached (or not required); No leaves the run open</label>` +
        `<div class="s${lk}" style="display:block">Template locks: ${(settings.tplLocks || []).length ? (settings.tplLocks || []).length + ' locked (set in a template\'s editor with Lock fields; only ' + esc(ADMIN.name) + ' can change them)' : 'none (open any template\'s editor and press Lock fields to keep the crew from templating a field, vitals, or a part of them)'}</div>` +
        `<label class="s${lk}"><input type="checkbox" id="cadgate" ${settings.cadGate === false ? '' : 'checked'} ${dis}> CAD import: only a run the call log shows you on may be imported. Unit Capability and Unit's Level of Care follow the crew's ESO certifications (a paramedic on the crew makes it ALS; a unit named NT… is non-transport)</label>` +
        `<div class="s" style="margin-top:8px;font-weight:700">Quick buttons${user ? ` <span class="muted" style="font-weight:400">· yours, ${esc(user)}: they follow your ESO login to any tablet</span>` : ''}</div>` +
        `<label class="s"><input type="checkbox" id="qdelays" ${settings.quickDelays === false ? '' : 'checked'}> Delays: one "All: None/No Delay" button above the delay fields (Incident tab) that presses ESO's own None button on every delay still empty</label>` +
        `<label class="s"><input type="checkbox" id="qhistory" ${settings.quickHistory === false ? '' : 'checked'}> History: one-tap chips for common conditions under Add History (Patient tab)</label>` +
        `<label class="s"><input type="checkbox" id="qmeds" ${settings.quickMeds === false ? '' : 'checked'}> Medications: chips for common home meds under Add Medications (Patient tab)</label>` +
        `<label class="s"><input type="checkbox" id="qallergies" ${settings.quickAllergies === false ? '' : 'checked'}> Allergies: chips for common allergies under Add Allergies (Patient tab)</label>` +
        `<label class="s"><input type="checkbox" id="qacuity" ${settings.quickAcuity === false ? '' : 'checked'}> Acuity: red, yellow and green buttons next to Initial and Final Patient Acuity (Narrative tab)</label>` +
        `<label class="s"><input type="checkbox" id="qtransport" ${settings.quickTransport === false ? '' : 'checked'}> Transport: chips for how the patient was moved and positioned (Narrative tab)</label>` +
        `<label class="s"><input type="checkbox" id="qfacilities" ${settings.quickFacilities === false ? '' : 'checked'}> Facilities: chips for saved facilities above the Scene and Destination locations (Incident tab)</label>` +
        `<label class="s"><input type="checkbox" id="qincident" ${settings.quickIncident === false ? '' : 'checked'}> Incident: Run Type, Mutual Aid, EMD Complaint and Requested By rows under their labels (only what ESO's own quick-picks lack)</label>` +
        `<label class="s"><input type="checkbox" id="qmechanism" ${settings.quickMechanism === false ? '' : 'checked'}> Mechanism of injury: Blunt, Burn, Penetrating, Other chips (Narrative tab)</label>` +
        `<label class="s"><input type="checkbox" id="qdisposition" ${settings.quickDisposition === false ? '' : 'checked'}> Disposition: Transported ALS/BLS, Refusal, Canceled (Prior/Scene) buttons under Unit Disposition; Transport Mode and Reason for Refusal outlined in red until answered (Incident tab)</label>` +
        `<label class="s"><input type="checkbox" id="qautoresp" ${settings.autoResponse === false ? '' : 'checked'}> Auto-fill: choosing Emergent or Non-Emergent (response or transport mode) fills the lights/sirens, intersection, scheduled, speed and method fields that are still empty, and sets EMD Performed to No</label>` +
        `<label class="s"><input type="checkbox" id="qassess" ${settings.quickAssess === false ? '' : 'checked'}> Assessment: "All normal" (presses No Abnormalities on every category in ESO's Quick Ax) and "A&amp;Ox4" on each assessment (Assessments tab)</label>` +
        `<label class="s"><input type="checkbox" id="qnarrative" ${settings.quickNarrative === false ? '' : 'checked'}> Narrative: rows for Primary and Secondary Impression, Provided Care Level, Chief Complaint System, Anatomic Location and the complaint duration units (Narrative tab)</label>` +
        `<label class="s"><input type="checkbox" id="qpatient" ${settings.quickPatient === false ? '' : 'checked'}> Patient: Race row (every race, shortened) (Patient tab)</label>` +
        `<label class="s"><input type="checkbox" id="qrefusal" ${settings.quickRefusal === false ? '' : 'checked'}> Refusal form: chips for Legal, Decision-Making, Medical, Check All notifications and the four Patient Refusals inside ESO's Patient Refusal Form (Signatures tab)</label>` +
        `<label class="s"><input type="checkbox" id="qmileage" ${settings.autoMileage === false ? '' : 'checked'}> Loaded mileage: press ESO's Calculate Mileage once the scene and destination both have an address (Incident tab)</label>` +
        `<label class="s"><input type="checkbox" id="valhl" ${settings.valHighlight === false ? '' : 'checked'}> Show what the validation summary wants: every field on the open tab that ESO's validation summary names is outlined, red for an error and amber for a warning, with the reason when you hover or hold on it. It is checked again after each tab load and each save, so a field clears the moment it is filled and comes back if it is emptied. Turn it off if the outlines get in your way.</label>` +
        `<label class="s"><input type="checkbox" id="qscan" ${settings.scanDocs === false ? '' : 'checked'}> Paperwork scanner: when you press Camera or Add Attachment in ESO's Attachments dialog, ESO Save first asks what the paperwork is (Facesheet, Physician Certification, Med List, Monitor Printout or Other) and names the attachment after it, for example "260918-021:Facesheet". A run keeps one Facesheet and one Physician Certification: adding a second asks whether to replace the first. On an iPad with the ESO Save app, Camera opens the app's document scanner, which straightens and crops each page; the pages come back and attach themselves. A facesheet, scanned or uploaded, is read and offered to fill the Patient and Billing pages. Off: ESO's own camera and Add Attachment work as they always have.</label>` +
        `<div class="fac"><b>Vitals copy: what the copy button carries over</b><div class="muted" style="font-size:12px;margin:2px 0 4px">Untick anything that changes every time (blood pressure, say) so the copied vital comes in without it and nobody has to erase it.</div>` +
        VITAL_GROUPS.map(([k, label]) => `<label class="s"><input type="checkbox" data-vc="${k}" ${(settings.vitalCopySkip || []).includes(k) ? '' : 'checked'}> ${esc(label)}</label>`).join('') + `</div>` +
        facilityPicker('facilitySending', 'Sending facility chips (Scene)') + facilityPicker('facilityDestination', 'Destination facility chips') +
        `<div class="actions"><button class="a" data-act="save-settings">Save</button></div></div>`);
    }
    if (settings.unsentList !== false) {
      const u = s.unsent;
      const items = u ? u.items : [];
      parts.push(`<div class="run unsent"><div class="head" data-act="unsent-toggle" style="cursor:pointer"><span class="num">${unsentOpen ? '▾' : '▸'} Not sent yet${items.length ? ` (${items.length})` : ''}</span><span class="muted">${u ? `locked in the last 15 days · checked ${fmtTime(u.at)}` : 'checking…'}</span></div>` +
        (!unsentOpen ? '' : items.length ? items.map(i => `<div class="urow" data-pcr="${esc(i.pcrId)}"><div><b>${esc(i.incidentNumber || '')}</b> · ${esc(fmtWhen(i.incidentDateTime))}<br><span class="muted">${esc(i.patientName || '')} → ${esc(i.destinationName || '')}</span></div><div class="actions">${i.fax ? '<button class="a" data-act="send-fax">Fax</button>' : ''}${i.email ? '<button class="a sec" data-act="send-email">Email</button>' : ''}</div></div>`).join('')
          : `<p class="muted">${u ? 'Every locked run with a fax or email destination has been sent.' : 'Looking at ESO\'s fax history and the locked runs…'}</p>`) +
        (unsentOpen ? `<div class="actions"><button class="a sec" data-act="rescan">Check again</button></div>` : '') + `</div>`);
    }
    const listed = s.runs.filter(r => mine(r) && (r.counts.total || r.pendingCreate) && !(r.locked && !r.counts.held && !r.counts.rejected && !r.sends.some(x => x.status === 'held')));
    if (!listed.length) parts.push(`<p class="muted">No runs recorded yet. Open a run in ESO and every save will be recorded here.</p>`);
    for (const r of listed) {
      const sigs = all['sigs:' + r.recordId] || [];
      const c = r.counts;
      const pills = [];
      if (r.pendingCreate) pills.push('<span class="pill warn">not yet created on ESO</span>');
      if (c.held) pills.push(`<span class="pill warn">${c.held} held</span>`);
      for (const x of r.sends) if (x.status === 'held') pills.push(`<span class="pill warn">${x.kind} held</span>`);
      if (c.rejected) pills.push(`<span class="pill bad">${c.rejected} rejected</span>`);
      if (r.locked) pills.push('<span class="pill good">locked</span>');
      else if (!c.held && !c.rejected && c.total) pills.push('<span class="pill good">all on ESO</span>');
      if (r.recordId === s.currentRecordId) pills.push('<span class="pill info">open now</span>');
      if (r.restoredFrom) pills.push('<span class="pill gray">restored</span>');
      parts.push(`<div class="run ${r.recordId === s.currentRecordId ? 'current' : ''}" data-id="${esc(r.recordId)}">
        <div class="head"><span class="num">${esc(r.incidentNumber || '(no incident number yet)')}</span><span>${pills.join('')}</span></div>
        <div class="muted">${c.total} save${c.total === 1 ? '' : 's'} recorded · started ${fmtWhen(r.createdAt)} · last activity ${fmtWhen(r.lastSeenAt)}${r.lastSavedAt ? ' · last confirmed by ESO ' + fmtTime(r.lastSavedAt) : ''}${sigs.length ? ` · ${sigs.length} signature image${sigs.length === 1 ? '' : 's'}` : ''}</div>
        <div class="actions">
          <button class="a" data-act="into-current" ${!s.currentRecordId || s.currentRecordId === r.recordId || !c.total ? 'disabled' : ''} title="Push every recorded change of this run into the run that is open in ESO right now">Push into the open run</button>
          <button class="a" data-act="into-new" ${!c.total || !s.online ? 'disabled' : ''} title="Create a brand-new run on ESO and push every recorded change into it">Push into a NEW run</button>
          ${c.rejected ? '<button class="a sec" data-act="retry">Retry rejected</button><button class="a sec" data-act="drop">Drop rejected</button>' : ''}
          <button class="a sec" data-act="export">Export backup</button>
          <button class="a sec" data-act="toggle-log">Log</button>
          <button class="a danger" data-act="clear" title="Remove this run's recorded changes and signature images from this device">Clear</button>
        </div>
        ${openLogs.has(r.recordId) ? `<div class="log">${r.log.map(l => `<div class="${esc(l.level)}">${esc(fmtTime(l.ts))}  ${esc(l.msg)}</div>`).join('') || '<div class="muted">nothing yet</div>'}</div>` : ''}
        ${openLogs.has(r.recordId) && sigs.length ? `<div class="sigs">${sigs.map((g, i) => `<div class="sig"><img src="${g.dataUrl}" alt=""><div>${esc(g.label)}</div><div class="muted">${esc(fmtWhen(g.ts))} · <a href="${g.dataUrl}" download="signature-${esc(r.incidentNumber || r.recordId)}-${i + 1}.png">save image</a></div></div>`).join('')}</div>` : ''}
      </div>`);
    }
    parts.push(`<p class="muted">Everything here stays on this device until ESO confirms it. Locked runs clear ${Number(settings.purgeHoursAfterLock) ? esc(settings.purgeHoursAfterLock) + ' hour(s) after locking' : 'as soon as the lock is seen'}. Runs untouched for 30 days clear too. Signature images are a backup in case a signature never reaches ESO.</p>`);
    panel.innerHTML = parts.join('');
    panel.querySelectorAll('.fac .facq').forEach(inp => inp.addEventListener('input', () => {
      const key = inp.closest('.fac').dataset.key; facSearch[key] = inp.value;
      const box = inp.closest('.fac'); const fresh = document.createElement('div'); fresh.innerHTML = facilityPicker(key, box.querySelector('b').textContent);
      box.querySelector('.facm').innerHTML = fresh.querySelector('.facm').innerHTML;
      box.querySelectorAll('[data-act]').forEach(a => a.addEventListener('click', onPanelAction));
    }));
    panel.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', onPanelAction));
  }
  // ---- the login's row: fetched when the login is seen, written when they change something
  const dbHeaders = () => ({ apikey: SYNC.key, Authorization: 'Bearer ' + SYNC.key, 'Content-Type': 'application/json' });
  async function dbGet(name) { return dbFind('name', name); }
  // a row by the person's permanent ESO id (survives a name change) or by the login name
  async function dbFind(key, value) {
    const r = await fetch(`${SYNC.url}?${key}=eq.${encodeURIComponent(value)}&select=name,person_id,settings,updated_at`, { headers: dbHeaders() });
    if (!r.ok) throw new Error('table ' + r.status);
    const rows = await r.json();
    return rows[0] || null;
  }
  async function dbPatch(key, value, body) {
    const r = await fetch(`${SYNC.url}?${key}=eq.${encodeURIComponent(value)}`, { method: 'PATCH', headers: { ...dbHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('table ' + r.status);
  }
  async function dbPut(row) {
    const r = await fetch(SYNC.url, { method: 'POST', headers: { ...dbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error('table ' + r.status);
  }
  // The person's row: found by their ESO id first, so a name change in ESO (a marriage, say)
  // keeps their settings and templates; the row is renamed to the new login. A row from before
  // ids were kept is found by name and given the id.
  async function findPerson(who, pid) {
    let row = pid ? await dbFind('person_id', pid) : null;
    if (row && row.name !== who) { await dbPatch('person_id', pid, { name: who }); row.name = who; }
    if (!row) { row = await dbFind('name', who); if (row && pid && row.person_id !== pid) { await dbPatch('name', who, { person_id: pid }); row.person_id = pid; } }
    return row;
  }
  const personRow = (who, pid, extra) => ({ name: who, ...(pid ? { person_id: pid } : {}), ...extra });
  // A login just seen on this tablet: take their settings from the table (a new tablet gets what
  // they chose elsewhere); a login not yet in the table gets a row with what this tablet has.
  async function syncUser() {
    const who = user; if (!who) return;
    syncLastTry = Date.now();
    await syncAgency();
    try {
      const pid = userId;
      const row = await findPerson(who, pid);
      // their row, or, for a login the table has never seen, the agency defaults: not whatever the
      // last person on this tablet chose
      Object.assign(settings, openSettings(row && row.settings && typeof row.settings === 'object' ? row.settings : DEFAULT_SETTINGS));
      await sset({ settings }); toPage('settings', settings); layoutQuick();
      await dbPut(personRow(who, pid, { settings: openSettings(settings) }));
      syncedUser = who; syncDirty = false;
    } catch (e) { syncDirty = true; } // no signal or the table is away: this tablet's settings stand, and the row is written later
    renderBar(); if (panelOpen) renderPanel();
  }
  // Something of theirs changed here: write the row.
  async function pushUser() {
    const who = user; if (!who) return;
    syncLastTry = Date.now();
    try {
      await dbPut(personRow(who, userId, { settings: openSettings(settings) }));
      syncedUser = who; syncDirty = false;
    } catch (e) { syncDirty = true; }
  }
  // the agency row: locked settings for every tablet, read at start and with each login
  async function syncAgency() {
    try {
      const row = await dbGet(AGENCY_ROW);
      if (row && row.settings && typeof row.settings === 'object') { Object.assign(settings, lockedSettings(row.settings)); await sset({ settings }); toPage('settings', settings); renderTimes(); }
    } catch (e) { /* no signal: the tablet's copy stands */ }
  }
  async function pushAgency() {
    if (!isAdmin()) return;
    try { await dbPut({ name: AGENCY_ROW, settings: lockedSettings(settings) }); } catch (e) { syncDirty = true; }
  }
  const openLogs = new Set();
  let settingsOpen = false;
  let unsentOpen = false; // the Not sent list stays folded until asked for
  const facSearch = {};
  function facilityPicker(key, title) {
    const chosen = settings[key] || [];
    const q = (facSearch[key] || '').trim().toLowerCase();
    const cat = facilities ? facilities.items : [];
    const matches = q ? cat.filter(f => f.name.toLowerCase().includes(q) && !chosen.some(c => c.id === f.id)).slice(0, 8) : [];
    return `<div class="s fac" data-key="${key}"><b>${esc(title)}</b>` +
      `<div class="chosen">${chosen.map(c => { const t = facilityTypeName(FACILITY_GROUPS[key === 'facilitySending' ? 'sending' : 'destination'], c); return `<span class="pill gray">${esc(c.label && c.label !== c.name ? `${c.label} (${c.name})` : c.name)}${t ? ` <span class="muted">· ${esc(t)}</span>` : ' <span class="muted">· type unknown</span>'} <a data-act="fac-remove" data-id="${esc(c.id)}" title="Remove">×</a></span>`; }).join('') || '<span class="muted">none yet</span>'}</div>` +
      (facilities ? `<input type="text" class="facq" placeholder="Type part of a facility name…" value="${esc(facSearch[key] || '')}">` +
        `<div class="facm">${matches.map(f => { const t = typeNameFor(key === 'facilitySending' ? 'locationTypes' : 'destinationTypes', f.typeId); return `<a data-act="fac-add" data-id="${esc(f.id)}">${esc(f.name)}${f.city || t ? ` <span class="muted">${esc([f.city, t].filter(Boolean).join(' · '))}</span>` : ''}</a>`; }).join('')}${q && !matches.length ? '<span class="muted">no saved facility matches</span>' : ''}</div>`
        : '<span class="muted">Open a run first so ESO\'s facility list is loaded.</span>') + '</div>';
  }
  async function onPanelAction(e) {
    const el = e.currentTarget;
    const act = el.dataset.act;
    const runEl = el.closest('.run');
    const id = runEl && runEl.dataset.id;
    if (act === 'close') togglePanel(false);
    else if (act === 'push') toPage('action', { name: 'pushNow' });
    else if (act === 'settings') { settingsOpen = !settingsOpen; renderPanel(); }
    else if (act === 'save-settings') {
      if (isAdmin()) { // the agency's owner sets the locked block for every tablet
        const v = Number(panel.querySelector('#purge').value);
        settings.purgeHoursAfterLock = Number.isFinite(v) && v >= 0 ? v : 0;
        settings.warmTabs = !!panel.querySelector('#warm').checked;
        settings.showTimes = !!panel.querySelector('#times').checked;
        settings.sendPrompt = !!panel.querySelector('#sendprompt').checked;
        settings.unsentList = !!panel.querySelector('#unsentlist').checked;
        settings.askBeforeLock = !!panel.querySelector('#asklock').checked;
        settings.cadGate = !!panel.querySelector('#cadgate').checked;
        pushAgency();
      }
      settings.quickDelays = !!panel.querySelector('#qdelays').checked;
      settings.quickHistory = !!panel.querySelector('#qhistory').checked;
      settings.quickMeds = !!panel.querySelector('#qmeds').checked;
      settings.quickAllergies = !!panel.querySelector('#qallergies').checked;
      settings.quickAcuity = !!panel.querySelector('#qacuity').checked;
      settings.quickTransport = !!panel.querySelector('#qtransport').checked;
      settings.quickFacilities = !!panel.querySelector('#qfacilities').checked;
      settings.quickAssess = !!panel.querySelector('#qassess').checked;
      settings.quickDisposition = !!panel.querySelector('#qdisposition').checked;
      settings.quickIncident = !!panel.querySelector('#qincident').checked;
      settings.quickMechanism = !!panel.querySelector('#qmechanism').checked;
      settings.autoResponse = !!panel.querySelector('#qautoresp').checked;
      settings.quickNarrative = !!panel.querySelector('#qnarrative').checked;
      settings.quickPatient = !!panel.querySelector('#qpatient').checked;
      settings.quickRefusal = !!panel.querySelector('#qrefusal').checked;
      settings.autoMileage = !!panel.querySelector('#qmileage').checked;
      settings.scanDocs = !!panel.querySelector('#qscan').checked;
      settings.valHighlight = !!panel.querySelector('#valhl').checked;
      settings.vitalCopySkip = Array.from(panel.querySelectorAll('[data-vc]')).filter(c => !c.checked).map(c => c.dataset.vc);
      layoutQuick();
      await sset({ settings }); toPage('settings', settings); settingsOpen = false; renderPanel(); renderTimes();
      pushUser();
    }
    else if (act === 'toggle-log') { if (openLogs.has(id)) openLogs.delete(id); else openLogs.add(id); renderPanel(); }
    else if (act === 'rescan') { toPage('action', { name: 'scanUnsent' }); }
    else if (act === 'unsent-toggle') { unsentOpen = !unsentOpen; renderPanel(); }
    else if (act === 'fac-add' || act === 'fac-remove') {
      const key = el.closest('.fac').dataset.key; const fid = el.dataset.id;
      const list = (settings[key] || []).filter(c => c.id !== fid);
      if (act === 'fac-add') {
        const f = facilities && facilities.items.find(x => x.id === fid);
        if (f) {
          const std = Object.values(FAC).find(x => x.id === f.id);
          list.push({ id: f.id, name: f.name, typeId: f.typeId, type: typeNameFor('locationTypes', f.typeId), destType: typeNameFor('destinationTypes', f.typeId), ...(std ? { label: std.label } : {}) });
        }
        facSearch[key] = '';
      }
      settings[key] = list;
      await sset({ settings }); toPage('settings', settings); renderPanel(); layoutQuick();
      pushUser();
    }
    else if (act === 'send-fax' || act === 'send-email') {
      const row = el.closest('.urow'); const pcr = row && row.dataset.pcr; if (!pcr) return;
      const kind = act === 'send-fax' ? 'fax' : 'email';
      const dest = row.querySelector('.muted').textContent.split('→').pop().trim();
      if (!confirm(`${kind === 'fax' ? 'Fax' : 'Email'} ${row.querySelector('b').textContent} to ${dest}?`)) return;
      showVeilMessage(kind === 'fax' ? 'Sending fax…' : 'Sending email…', 'Asking ESO to send the chart to ' + dest + '.');
      toPage('action', { name: 'send', recordId: pcr, kind });
    }
    else if (act === 'into-current' || act === 'into-new') showPagePicker(id, act === 'into-new');
    else if (act === 'retry') toPage('action', { name: 'retryRejected', recordId: id });
    else if (act === 'drop') { if (confirm('Drop the rejected changes? They will stay in the export but will not be pushed again.')) toPage('action', { name: 'dropRejected', recordId: id }); }
    else if (act === 'export') exportRuns([id]);
    else if (act === 'export-all') exportRuns(null);
    else if (act === 'clear') {
      if (!confirm('Remove this run\'s recorded changes and signature images from this device? This cannot be undone.')) return;
      await sremove(['run:' + id, 'sigs:' + id]);
      toPage('action', { name: 'forget', recordId: id });
      openLogs.delete(id);
      renderPanel();
    }
  }
  async function exportRuns(ids) {
    const all = await sget(null);
    const out = { exportedAt: new Date().toISOString(), version: (lastStatus && lastStatus.version) || null, runs: {}, signatures: {} };
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('run:') && (!ids || ids.includes(k.slice(4)))) out.runs[k.slice(4)] = v;
      if (k.startsWith('sigs:') && (!ids || ids.includes(k.slice(5)))) out.signatures[k.slice(5)] = v;
    }
    const name = ids && ids.length === 1 && out.runs[ids[0]] ? (out.runs[ids[0]].incidentNumber || ids[0]) : 'all-runs';
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `esosave-${String(name).replace(/[^\w.-]+/g, '_')}.json`; a.target = '_blank';
    shadow.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------------------------------------------------------------- tab warm-up
  // ESO loads each tab's code the first time it is clicked, and serves those files with headers
  // that make the browser re-check them every time, so a tab that was never clicked cannot open
  // without signal even when its data is cached. Once a run is open, click through every tab once
  // (waiting for the medic to be idle), then return to where they were.
  const TAB_LABELS = { Incident: 'INCIDENT', Patient: 'PATIENT', Vitals: 'VITALS', FlowchartTreatments: 'FLOWCHART', Assessments: 'ASSESSMENTS',
    Narrative: 'NARRATIVE', Forms: 'FORMS', Billing: 'BILLING', Signatures: 'SIGNATURES' };
  const warmed = new Set();
  let warming = false;
  let lastInputAt = 0;
  for (const t of ['keydown', 'pointerdown', 'touchstart']) document.addEventListener(t, (e) => { if (!host || !e.composedPath().includes(host)) lastInputAt = Date.now(); }, true);

  // The tab strip: the clickable control whose whole label is exactly this word, in the row that
  // also holds the other tabs. A control like "QUICK VITALS" has an inner piece reading "VITALS",
  // so the match is made on the whole control, not on a fragment.
  const ALL_LABELS = Object.values(TAB_LABELS);
  function tabElement(label) {
    const want = label.toUpperCase();
    const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const candidates = [];
    for (const el of document.querySelectorAll('a, button, [role="tab"], li, div, span')) {
      if (host && host.contains(el)) continue;
      if (text(el) !== want) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.top > 260) continue;
      const ctl = el.closest('a, button, [role="tab"], li') || el;
      if (text(ctl) !== want) continue; // part of a longer label, e.g. QUICK VITALS
      candidates.push(ctl);
    }
    if (!candidates.length) return null;
    // prefer the one that is really the tab: a link to that tab of the run, sitting among the
    // other tabs (its siblings, or its parent's siblings, read as the other labels)
    const view = Object.keys(TAB_LABELS).find(k => TAB_LABELS[k] === want) || '';
    const score = (ctl) => {
      let n = 0;
      const href = (ctl.getAttribute && (ctl.getAttribute('href') || '')) || '';
      if (href && new RegExp('/' + view.toLowerCase() + '(/|$|\\?|#)', 'i').test(href)) n += 100;
      let node = ctl;
      for (let i = 0; node && node.parentElement && node.parentElement !== document.body && i < 4; node = node.parentElement, i++) {
        const sibs = Array.from(node.parentElement.children).filter(c => c !== node);
        const hits = sibs.filter(c => { const t = text(c); return t !== want && ALL_LABELS.includes(t); }).length;
        if (hits) { n += hits * 10 - i; break; }
      }
      return n;
    };
    const uniq = [...new Set(candidates)];
    uniq.sort((x, y) => score(y) - score(x));
    return uniq[0];
  }
  function currentTabLabel(s) {
    const v = s.lastView && s.lastView.recordId === s.currentRecordId ? s.lastView.view : 'Incident';
    return TAB_LABELS[v] || v.toUpperCase();
  }
  function maybeWarmTabs(s) {
    if (settings.warmTabs === false || warming) return;
    const id = s.currentRecordId;
    if (!id || warmed.has(id) || !s.online || s.loggedOut) return;
    const run = s.runs.find(r => r.recordId === id);
    if (!run || run.locked || run.tmp) return;
    if (!s.lastView || s.lastView.recordId !== id) return; // wait until the app has shown the first tab
    warmed.add(id);
    setTimeout(() => warmTabs(id), 600);
  }
  const idle = () => Date.now() - lastInputAt > 1500;
  function waitIdle(maxWait) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => { if (idle() || Date.now() - t0 > maxWait) resolve(idle()); else setTimeout(tick, 500); };
      tick();
    });
  }
  function waitViewLoaded(view, id, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const lv = lastStatus && lastStatus.lastView;
        if (lv && lv.view === view && lv.recordId === id && lv.ts >= t0 - 50) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }
  let veil = null, skipRequested = false;
  function showVeil(total) {
    if (!shadow) return;
    veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML = `<div class="box"><div class="spin"></div><h2>Getting this run ready for no signal</h2>
      <div class="prog">Opening tabs…</div><div class="track"><div class="fill"></div></div>
      <div class="why">ESO Save opens every tab once so each one still works if signal drops mid-call. Takes a few seconds. Please don't tap yet.</div>
      <button class="a sec" data-act="skip">Skip, I need the screen now</button></div>`;
    veil.addEventListener('click', (e) => { e.stopPropagation(); if (e.target.dataset && e.target.dataset.act === 'skip') skipRequested = true; });
    veil.addEventListener('pointerdown', (e) => e.stopPropagation());
    shadow.appendChild(veil);
    veil._total = total;
  }
  function veilProgress(n, label) {
    if (!veil) return;
    veil.querySelector('.prog').textContent = `Opening ${label} (${n} of ${veil._total})`;
    veil.querySelector('.fill').style.width = Math.round((n / veil._total) * 100) + '%';
  }
  function hideVeil() { if (veil) { veil.remove(); veil = null; } }

  async function warmTabs(id) {
    if (warming) return;
    warming = true;
    skipRequested = false;
    try {
      if (!lastStatus || lastStatus.currentRecordId !== id || !lastStatus.online) { warmed.delete(id); return; }
      const startLabel = currentTabLabel(lastStatus);
      const views = Object.keys(TAB_LABELS).filter(v => TAB_LABELS[v] !== startLabel);
      showVeil(views.length);
      let opened = 0, missing = [];
      for (const view of views) {
        const label = TAB_LABELS[view];
        if (skipRequested || !lastStatus.online || lastStatus.currentRecordId !== id) break;
        const el = tabElement(label);
        if (!el) { missing.push(label); continue; }
        veilProgress(opened + 1, label);
        el.click();
        // The tab's code is requested on the click and keeps loading even after we move on; the
        // wait is only to let the app settle. Move on when its data arrives, or after a moment.
        await waitViewLoaded(view, id, 400);
        opened++;
      }
      const back = tabElement(startLabel);
      if (back) { back.click(); await waitViewLoaded(Object.keys(TAB_LABELS).find(v => TAB_LABELS[v] === startLabel) || 'Incident', id, 1500); }
      if (opened) toPage('action', { name: 'note', recordId: id, msg: `Opened ${opened} tab${opened === 1 ? '' : 's'} once so they work with no signal.${missing.length ? ' Could not find: ' + missing.join(', ') + '.' : ''}${skipRequested ? ' (skipped early)' : ''}`, level: 'info' });
      // stopped early because signal dropped: try again when it is back and the run is reopened
      if (!skipRequested && opened < views.length) warmed.delete(id);
    } catch (e) { warmed.delete(id); }
    finally { hideVeil(); warming = false; }
  }

  // ---------------------------------------------------------------- page picker for pushing a run
  const PAGES = [
    ['incident', 'INCIDENT'], ['patient', 'PATIENT'], ['vitals', 'VITALS'], ['flowchartTreatments', 'FLOWCHART'], ['assessments', 'ASSESSMENTS'],
    ['narrative', 'NARRATIVE'], ['forms', 'FORMS'], ['billing', 'BILLING'], ['signatures', 'SIGNATURES'],
  ];
  const SENSITIVE = { patient: 'PATIENT', signatures: 'SIGNATURES' };
  const SENSITIVE_WARNING = 'Using this page will overwrite any saved signatures and patient details in the run you are pushing into. Only use it for the SAME patient.';
  function showPagePicker(sourceId, toNew) {
    if (!shadow || !lastStatus) return;
    const run = lastStatus.runs.find(r => r.recordId === sourceId);
    if (!run) return;
    const counts = run.pages || {};
    const on = new Set(['incident', 'narrative'].filter(p => counts[p]));
    const wrap = document.createElement('div');
    wrap.className = 'veil';
    wrap.style.cursor = 'default';
    wrap.style.zIndex = '2147483647';
    if (panel) panel.style.display = 'none';
    const close = () => { wrap.remove(); if (panel && panelOpen) panel.style.display = 'block'; };
    const render = () => {
      const anySensitive = [...on].some(p => SENSITIVE[p]);
      wrap.innerHTML = `<div class="box pick"><h2>${toNew ? 'Push into a NEW run' : 'Push into the open run'}</h2>
        <div class="sub">${esc(run.incidentNumber || 'this run')} · choose which pages to copy</div>
        ${PAGES.map(([key, label]) => `<div class="row ${on.has(key) ? '' : 'off'}"><span class="name">${label}<span class="n">${counts[key] ? counts[key] + ' save' + (counts[key] === 1 ? '' : 's') : 'nothing saved'}</span></span>
          <button class="sw ${on.has(key) ? 'on' : ''}" data-page="${key}" ${counts[key] ? '' : 'disabled'} aria-label="${label}"></button></div>`).join('')}
        ${anySensitive ? `<div class="warn">${esc(SENSITIVE_WARNING)}</div>` : ''}
        <div class="btns"><button class="a sec" data-act="all">Toggle all</button><button class="a sec" data-act="cancel">Cancel</button><button class="a" data-act="go" ${on.size ? '' : 'disabled'}>Push ${on.size} page${on.size === 1 ? '' : 's'}</button></div></div>`;
    };
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      const sw = e.target.closest('.sw');
      if (sw && !sw.disabled) { const k = sw.dataset.page; if (on.has(k)) on.delete(k); else on.add(k); render(); return; }
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'all') {
        const all = PAGES.map(([k]) => k).filter(k => counts[k]);
        if (all.every(k => on.has(k))) on.clear(); else all.forEach(k => on.add(k));
        render();
      } else if (act === 'cancel') close();
      else if (act === 'go') {
        const pages = PAGES.map(([k]) => k).filter(k => on.has(k));
        const names = PAGES.filter(([k]) => on.has(k)).map(([, l]) => l).join(', ');
        const blank = PAGES.filter(([k]) => !on.has(k) && counts[k]).map(([, l]) => l).join(', ');
        const sensitive = pages.some(p => SENSITIVE[p]);
        const msg = `${toNew ? 'Create a NEW run and copy' : 'Copy'}: ${names}.` + (blank ? `\\nNot copied: ${blank}.` : '') +
          (sensitive ? `\\n\\n⚠ ${SENSITIVE_WARNING}\\nIf this is a different patient, press Cancel and turn those pages off.` : '') + '\\n\\nContinue?';
        if (!confirm(msg)) return;
        close();
        toPage('action', { name: toNew ? 'pushIntoNew' : 'pushIntoCurrent', recordId: sourceId, pages });
      }
    });
    wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    render();
    shadow.appendChild(wrap);
  }

  // ---------------------------------------------------------------- call times in ESO's top bar
  // The times the narrative is written around, shown in the empty part of ESO's dark top bar so
  // nobody has to leave the page to look them up. Taken from what ESO sends the page and from the
  // app's own saves, so a time shows the moment it is entered.
  const TIME_FIELDS = [['dispatchedTime', 'Disp'], ['enRouteTime', 'Enr'], ['onSceneTime', 'Scene'], ['atPatientTime', 'At pt'],
    ['departSceneTime', 'Depart'], ['atDestinationTime', 'Dest'], ['transferPatientTime', 'Xfer']];
  let timesEl = null, timesKey = '';
  function topBarRect() {
    // ESO's header: a wide, dark band touching the top of the viewport
    const seen = new Set();
    for (const x of [innerWidth * 0.5, innerWidth * 0.3, innerWidth * 0.7]) {
      for (const el of document.elementsFromPoint(x, 30)) {
        if (seen.has(el) || (host && host.contains(el))) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.top > 4 || r.height < 40 || r.height > 130 || r.width < innerWidth * 0.8) continue;
        const bg = getComputedStyle(el).backgroundColor;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg || '');
        if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
        if ((Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114) > 110) continue; // not dark
        return { el, rect: r };
      }
    }
    return null;
  }
  // The widest empty stretch of the bar: between whatever ESO shows on the left (logo, patient
  // name) and on the right (positive ID, icons).
  function topBarGap(bar) {
    const spans = [];
    for (const el of bar.el.querySelectorAll('*')) {
      if (host && host.contains(el)) continue;
      const leaf = !el.firstElementChild || /^(IMG|SVG|CANVAS|INPUT|BUTTON|SELECT)$/.test(el.tagName) || (el.childNodes.length && Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim()));
      if (!leaf) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= bar.rect.top || r.top >= bar.rect.bottom) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      spans.push([r.left, r.right]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let best = null, cursor = bar.rect.left;
    for (const [l, r] of spans) {
      if (l - cursor > (best ? best[1] - best[0] : 0)) best = [cursor, l];
      cursor = Math.max(cursor, r);
    }
    if (bar.rect.right - cursor > (best ? best[1] - best[0] : 0)) best = [cursor, bar.rect.right];
    return best;
  }
  // Make a little room in ESO's bar: cap the widest text on the left (the patient name) and shrink
  // the label on the right ("POSITIVE IDENTIFICATION"). Undone the moment there is room again.
  const squeezed = new Map(); // element -> original inline style
  let squeezedAt = 0; // the bar's width when the neighbours were squeezed
  function squeezeNeighbours(bar, on) {
    // letting go and squeezing again on every look made the bar flicker (Safari); once squeezed,
    // the neighbours are let go only when the bar has grown since
    if (!on) { if (!squeezed.size || (bar && bar.rect.width < squeezedAt + 40)) return false; for (const [el, st] of squeezed) el.setAttribute('style', st); squeezed.clear(); squeezedAt = 0; return false; }
    if (squeezed.size) return false;
    squeezedAt = bar.rect.width;
    if (squeezed.size) return false;
    const mid = bar.rect.left + bar.rect.width / 2;
    const leaves = [];
    for (const el of bar.el.querySelectorAll('*')) {
      if (host && host.contains(el)) continue;
      if (!Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom <= bar.rect.top || r.top >= bar.rect.bottom) continue;
      leaves.push({ el, r, text: el.textContent.trim() });
    }
    const label = leaves.find(l => /^POSITIVE\s+ID/i.test(l.text));
    if (label) { squeezed.set(label.el, label.el.getAttribute('style') || ''); label.el.style.fontSize = '8px'; label.el.style.lineHeight = '1.1'; label.el.style.maxWidth = '54px'; label.el.style.letterSpacing = '0'; }
    const left = leaves.filter(l => l.r.right < mid && l.r.width > 60 && !/^PATIENT$/i.test(l.text)).sort((a, b) => b.r.width - a.r.width)[0];
    if (left) { squeezed.set(left.el, left.el.getAttribute('style') || ''); left.el.style.maxWidth = '110px'; left.el.style.overflow = 'hidden'; left.el.style.textOverflow = 'ellipsis'; left.el.style.whiteSpace = 'nowrap'; left.el.style.display = 'inline-block'; left.el.style.verticalAlign = 'bottom'; }
    return squeezed.size > 0;
  }
  function renderTimes() {
    if (!shadow) return;
    const s = lastStatus;
    const run = s && s.currentRecordId ? s.runs.find(r => r.recordId === s.currentRecordId) : null;
    // only while the page is actually inside that run (ESO keeps the run id in the address)
    const inRun = run && (location.href.includes(run.recordId) || (run.realId && location.href.includes(run.realId)));
    const bar = settings.showTimes !== false && inRun && !run.locked ? topBarRect() : null;
    if (!bar) { if (timesEl) { timesEl.remove(); timesEl = null; timesKey = ''; } if (squeezed.size) { for (const [el, st] of squeezed) el.setAttribute('style', st); squeezed.clear(); squeezedAt = 0; } return; }
    if (!timesEl) { timesEl = document.createElement('div'); timesEl.className = 'times'; shadow.appendChild(timesEl); }
    const times = run.times || {};
    const key = TIME_FIELDS.map(([k]) => times[k] || '').join('|');
    if (key !== timesKey) {
      timesKey = key;
      timesEl.innerHTML = TIME_FIELDS.map(([k, l]) => `<div class="t${times[k] ? '' : ' empty'}"><span class="l">${l}</span><span class="v">${esc(times[k] || '--:--')}</span></div>`).join('');
    }
    // centred in the empty stretch of the bar; on a narrow screen the tiles shrink, and if they
    // still do not fit, ESO's neighbours (patient name, positive ID label) give up a little width
    let gap = topBarGap(bar);
    let room = gap ? gap[1] - gap[0] - 24 : 0;
    const NEED = { full: 7 * 54 + 6 * 4, tight: 7 * 40 + 6 * 3, micro: 7 * 33 + 6 * 2 };
    if (room < NEED.tight) { if (squeezeNeighbours(bar, true)) { gap = topBarGap(bar); room = gap ? gap[1] - gap[0] - 24 : 0; } }
    else squeezeNeighbours(bar, false);
    if (room < NEED.micro - 20) { timesEl.style.display = 'none'; return; }
    timesEl.classList.toggle('tight', room < NEED.full && room >= NEED.tight);
    timesEl.classList.toggle('micro', room < NEED.tight);
    timesEl.style.display = 'flex';
    timesEl.style.top = Math.round(bar.rect.top + 6) + 'px';
    timesEl.style.height = Math.round(bar.rect.height - 12) + 'px';
    timesEl.style.maxWidth = Math.round(room) + 'px';
    const w = Math.min(room, timesEl.scrollWidth || room);
    timesEl.style.left = Math.round(gap[0] + 12 + (room - w) / 2) + 'px';
  }
  addEventListener('resize', () => setTimeout(renderTimes, 50));
  addEventListener('hashchange', () => setTimeout(renderTimes, 50));
  addEventListener('popstate', () => setTimeout(renderTimes, 50));
  setInterval(renderTimes, 700);

  // ---------------------------------------------------------------- quick buttons
  // One-tap chips that do what a finger would do in ESO's own pickers: open the list, tick the
  // item, press OK. Nothing is written behind the app's back, so the screen and the save are ESO's.
  // Names and ids come from ESO's configuration bundle (list SL.MEDICALHISTORY etc.).
  const CHIP_GROUPS = {
    history: {
      setting: 'quickHistory', button: /^Add History$/i, title: /^Add History$/i, listKey: 'histories',
      chips: [
        ['HTN', 'Hypertension (HTN)', 547], ['Diabetes', 'Diabetes', 545], ['COPD', 'Chronic Obstructive Pulmonary Disease (COPD)', 541],
        ['CHF', 'Congestive Heart Failure (CHF)', 540], ['Asthma', 'Asthma', 535], ['CAD', 'Coronary Artery Disease (CAD)', 12846],
        ['A-fib', 'Atrial Fibrillation', 10103], ['MI', 'Myocardial Infarction (MI)', 12871], ['Pacemaker/AICD', 'Pacemaker/AICD', 550],
        ['Stroke/CVA', 'Stroke/CVA', 555], ['Seizures', 'Seizures', 553], ['Dementia', 'Dementia', 543],
        ['Anxiety', 'Anxiety', 10076], ['Depression', 'Depression', 10071], ['Hyperlipidemia', 'Hyperlipidemia', 8212],
        ['Hypothyroid', 'Hypothyroidism', 10273], ['Renal failure', 'Kidney/Renal Failure', 552], ['Dialysis', 'Dialysis', 11887],
        ['GERD', 'Gastro-Esophageal Reflux Disease (GERD)', 8214], ['Cancer', 'Cancer, Unspecified', 537], ['Smoking', 'Smoking', 554],
        ['None reported', 'None Reported', 12224],
      ],
    },
    meds: {
      setting: 'quickMeds', button: /^Add Medications?$/i, title: /^Add Medications?$/i, listKey: 'meds',
      chips: [
        ['Lisinopril', 'Lisinopril', 485], ['Metoprolol', 'Metoprolol', 7913], ['Amlodipine', 'Amlodipine', 7594], ['Losartan', 'Losartan', 10118],
        ['HCTZ', 'Hydrochlorothiazide (Hctz)', 476], ['Carvedilol', 'Carvedilol', 7655], ['Atorvastatin', 'Atorvastatin', 7613], ['Simvastatin', 'Simvastatin', 8015],
        ['Metformin', 'Metformin', 7905], ['Insulin', 'Insulin', 478], ['Glipizide', 'Glipizide', 7813], ['Aspirin', 'Aspirin', 7608],
        ['Eliquis', 'Eliquis', 11948], ['Xarelto', 'Xarelto', 10014], ['Warfarin', 'Warfarin', 513], ['Plavix', 'Plavix', 493],
        ['Furosemide', 'Furosemide', 474], ['Potassium', 'Potassium', 494], ['Levothyroxine', 'Levothyroxine', 7878], ['Omeprazole', 'Omeprazole', 8258],
        ['Gabapentin', 'Gabapentin', 7801], ['Albuterol', 'Albuterol', 450], ['Prednisone', 'Prednisone', 496], ['Nitroglycerin', 'Nitroglycerin', 488],
        ['Hydrocodone', 'Hydrocodone', 477], ['Oxycodone', 'Oxycodone', 490], ['Tramadol', 'Tramadol', 506], ['Sertraline', 'Sertraline', 8013],
        ['Trazodone', 'Trazodone', 507], ['Alprazolam', 'Alprazolam', 7590], ['None reported', 'None Reported', 12223],
      ],
    },
    toStretcher: {
      setting: 'quickTransport', tab: 'Narrative', field: 'HOWPATIENTWASMOVEDTOSTRETCHERIDS', title: /moved to stretcher/i, listKey: 'howPatientWasMovedToStretcherIds',
      chips: [['Ambulated w/ assist', 'Ambulated with assistance', 15110], ['No assist', 'Ambulated to stretcher no assistance', 15111], ['Lifted', 'Lifted to stretcher', 15112],
        ['Draw-sheet', 'Lifted to stretcher via draw-sheet', 15113], ['Hoyer', 'Lifted to stretcher via Hoyer lift', 15114], ['Backboard', 'Lifted to stretcher with backboard', 15115], ['Stand & pivot', 'Via stand and pivot', 15119]],
    },
    toAmbulance: {
      setting: 'quickTransport', tab: 'Narrative', field: 'PATIENTMOVEDFROMSCENETOAMBULANCEMETHODIDS', title: /to ambulance/i, listKey: 'patientMovedFromSceneToAmbulanceMethodIds',
      chips: [['Stretcher', 'Stretcher', 7183]],
    },
    fromAmbulance: {
      setting: 'quickTransport', tab: 'Narrative', field: 'PATIENTMOVEDFROMAMBULANCETODESTINATIONMETHODIDS', title: /from ambulance/i, listKey: 'patientMovedFromAmbulanceToDestinationMethodIds',
      chips: [['Stretcher', 'Stretcher', 7196]],
    },
    position: {
      setting: 'quickTransport', tab: 'Narrative', field: 'PATIENTPOSITIONDURINGTRANSPORTIDS', title: /position during transport/i, listKey: 'patientPositionDuringTransportIds',
      chips: [['Fowlers', 'Fowlers (Semi-Upright Sitting)', 7186], ['Semi-Fowlers', 'Semi-Fowlers', 7189], ['Supine', 'Supine', 7191], ['Sitting', 'Sitting', 7190]],
    },
    mechanism: {
      setting: 'quickMechanism', tab: 'Narrative', field: 'MECHANISMOFINJURYIDS', title: /mechanism/i, listKey: 'mechanismOfInjuryIds', noOther: true,
      chips: [['Blunt', 'Blunt', 7117], ['Burn', 'Burn', 7118], ['Penetrating', 'Penetrating', 7120], ['Other', 'Other', 7119]],
    },
    allergies: {
      setting: 'quickAllergies', button: /^Add Allergies$/i, title: /^Add Allergies$/i, listKey: 'allergies',
      chips: [['NKDA', 'No known allergies', 518]],
    },
    transportDueTo: {
      setting: 'quickDisposition', tab: 'Incident', field: 'TRANSPORTDUETOITEMIDS', title: /^Transport Due To$/i, what: 'Transport Due To',
      chips: [['Closest Facility', 'Closest Facility', 429], ['Diversion', 'Diversion', 431], ['Family Choice', 'Family Choice', 426], ["Patient's Choice", "Patient's Choice", 425], ['Protocol', 'Protocol', 427]],
    },
    // Inside ESO's Patient Refusal Form (Signatures tab). The form is not a picker itself, so its
    // chips show while it is open and hide while one of its own pickers is on top. Ids here are
    // the agency's (GUIDs) or ESO's; what is set is read from the field's own display text.
    rfLegal: {
      setting: 'quickRefusal', form: /^Patient Refusal Form$/i, field: 'STANDARDREFUSALLEGALIDS', title: /^Legal$/i, what: 'Legal',
      chips: [['18+', '18 years of age or older', 'e8baca53-0bd8-4041-9761-392b38716aed'], ['Guardian', 'Parent/Legal guardian present', 'b7121c7f-3203-4a0e-9311-6b5945d2f7c3']],
    },
    rfDecision: {
      setting: 'quickRefusal', form: /^Patient Refusal Form$/i, field: 'STANDARDREFUSALDECISIONMAKINGIDS', title: /^Decision-Making$/i, what: 'Decision-Making',
      chips: [['Clear', 'Cleared capacity assessment', '0ebe23fe-29a7-43a3-881e-33995648ffd6'], ['Drug/Alcohol', 'Possible ETOH/drug use', 'fedb6b92-b47f-4d1b-bb6d-ec51264038c5'], ['Threat', 'Presents a significant life threat to self or others', 'afd73a13-f1d9-4115-9df1-24af3eb74578']],
    },
    rfMedical: {
      setting: 'quickRefusal', form: /^Patient Refusal Form$/i, field: 'STANDARDREFUSALMEDICALIDS', title: /^Medical$/i, what: 'Medical',
      chips: [['Cleared', 'Cleared capacity assessment', '7f59c7f9-779a-45ce-9eb5-0d95d8b70fb0']],
    },
    rfNotify: {
      setting: 'quickRefusal', form: /^Patient Refusal Form$/i, field: 'STANDARDREFUSALPATIENTNOTIFICATIONIDS', title: /Notifications$/i, what: 'notifications',
      all: ['Medical treatment/evaluation recommendation(s)', 'Further harm could result without medical treatment or evaluation', 'Transport by means other than ambulance could be hazardous in light of present illness/injury', 'EMS preference to provide transport to the closest appropriate medical facility'],
      chips: [['Check All', null, 'all']],
    },
    rfRefusals: {
      setting: 'quickRefusal', form: /^Patient Refusal Form$/i, field: 'STANDARDREFUSALPATIENTREFUSALIDS', title: /^Patient Refusals$/i, what: 'Patient Refusals', noOther: true,
      chips: [['Assessment', 'Assessment', 12817], ['Treatment', 'Treatment', 12818], ['Transport by EMS', 'Transport by EMS', 12819], ['Recommended Destination', 'Recommended Destination', 12820]],
    },
  };
  const ACUITY = {
    initial: { label: 'Initial Patient Acuity', key: 'initialAcuity', items: { red: ['Critical (Red)', 10586], yellow: ['Emergent (Yellow)', 10587], green: ['Lower Acuity (Green)', 10588] } },
    final: { label: 'Final Patient Acuity', key: 'finalAcuity', items: { red: ['Critical (Red)', 11838], yellow: ['Emergent (Yellow)', 11839], green: ['Lower Acuity (Green)', 11840] } },
  };
  let quickLayer = null;
  const quickEls = new Map();   // key -> element in our layer
  const pending = {}; // group -> names tapped, not yet committed
  const pend = (gk) => (pending[gk] = pending[gk] || new Set());
  const pendingOff = {}; // group -> names tapped to take back out
  const pendOff = (gk) => (pendingOff[gk] = pendingOff[gk] || new Set());
  const chipBusy = {}; // group -> its list is open and being ticked
  let quickBusy = false;
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // ESO folds a field away (Mutual Aid until the run type is mutual aid) in a wrapper that is
    // visibility:hidden, height 0 and overflow hidden; the field's own box still measures
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    return getComputedStyle(el).visibility !== 'hidden';
  };
  const inShelf = (el) => !!el.closest('shelf-panel, [class*="shelf" i]');
  function findByText(selector, text, opts) {
    // the innermost visible element whose whole text is exactly this (a string or a RegExp)
    const test = text instanceof RegExp ? (t) => text.test(t) : (t) => t.toUpperCase() === norm(text).toUpperCase();
    let best = null;
    for (const el of document.querySelectorAll(selector)) {
      if (host && host.contains(el)) continue;
      if (!test(norm(el.textContent))) continue;
      if (opts && opts.visible !== false && !visible(el)) continue;
      if (opts && opts.notInShelf && inShelf(el)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  async function until(fn, timeout, step) {
    const t0 = Date.now();
    for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > timeout) return null; await wait(step || 30); }
  }
  function ensureQuickLayer() {
    if (quickLayer || !shadow) return quickLayer;
    quickLayer = document.createElement('div'); quickLayer.className = 'quick'; quickLayer.innerHTML = '<div class="sheet"></div>'; shadow.appendChild(quickLayer);
    return quickLayer;
  }
  const quickSheet = () => ensureQuickLayer().firstElementChild;
  // ---- where the buttons live. A button drawn in a fixed overlay has to be dragged along by
  // script on every scroll frame, and on an iPad the page moves a frame ahead of that (the
  // jiggle). So the buttons for a tab's content sit in a host of our own inside ESO's scrolling
  // container itself, positioned in the container's content, and ride with the page natively;
  // the container's own edge clips them under the banner. Only buttons over ESO's fixed panels
  // (the refusal form) stay in the fixed overlay.
  const rides = new Map();      // scroller element -> { host, scroller, quick, copy }
  const rideHosts = new Set();
  const ours = (el) => !!el && ((host && host.contains(el)) || [...rideHosts].some(h => h.contains(el)));
  function scrollParent(el) {
    for (let e = el && el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e;
    }
    return null;
  }
  function rideFor(scroller) {
    let r = rides.get(scroller);
    if (r && r.host.parentElement === scroller) return r;
    if (r) { r.host.remove(); rideHosts.delete(r.host); rides.delete(scroller); }
    if (getComputedStyle(scroller).position === 'static') scroller.style.position = 'relative';
    const h = document.createElement('div');
    h.className = 'esosave-ride';
    h.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:20;pointer-events:none;';
    const sh = h.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS + ' .quick, .copylayer { position: absolute; inset: auto; left: 0; top: 0; width: 0; height: 0; overflow: visible; clip-path: none; } .sheet { position: absolute; inset: auto; left: 0; top: 0; width: 0; height: 0; overflow: visible; transform: translateZ(0); }';
    sh.appendChild(st);
    const q = document.createElement('div'); q.className = 'quick'; q.innerHTML = '<div class="sheet"></div>';
    const c = document.createElement('div'); c.className = 'copylayer'; c.innerHTML = '<div class="sheet"></div>';
    sh.appendChild(q); sh.appendChild(c);
    scroller.appendChild(h);
    r = { host: h, scroller, quickLayer: q, copyLayer: c, quick: q.firstElementChild, copy: c.firstElementChild };
    rides.set(scroller, r); rideHosts.add(h);
    return r;
  }
  // The sheets are offset so a child placed at viewport coordinates (as every layout here does)
  // lands on that same spot in the container's content, and then scrolls with it.
  function placeRides() {
    for (const [scroller, r] of rides) {
      if (!scroller.isConnected || r.host.parentElement !== scroller) { r.host.remove(); rideHosts.delete(r.host); rides.delete(scroller); continue; }
      const b = scroller.getBoundingClientRect();
      const lx = `${Math.round(scroller.scrollLeft - b.left - scroller.clientLeft)}px`, ly = `${Math.round(scroller.scrollTop - b.top - scroller.clientTop)}px`;
      for (const sheet of [r.quick, r.copy]) { if (sheet.style.left !== lx) sheet.style.left = lx; if (sheet.style.top !== ly) sheet.style.top = ly; }
    }
  }
  let mainScrollerCache = { at: 0, el: null };
  function mainScroller() {
    if (Date.now() - mainScrollerCache.at < 300) return mainScrollerCache.el;
    const probe = Array.from(document.querySelectorAll('eso-field, assessment-record, crew-list, eso-location, tr, grid-row')).find(e => !e.closest('shelf-panel, eso-modal, eso-modal-dialog, standard-refusal, jump-link-shelf-panel') && !ours(e) && visible(e));
    const el = probe ? scrollParent(probe) : null;
    mainScrollerCache = { at: Date.now(), el };
    return el;
  }
  function sheetFor(key, anchor) {
    const gk = key.split(':')[0];
    if (CHIP_GROUPS[gk] && CHIP_GROUPS[gk].form) { const sp = anchor ? scrollParent(anchor) : null; return sp ? rideFor(sp).quick : quickSheet(); }
    const ms = mainScroller();
    return ms ? rideFor(ms).quick : quickSheet();
  }
  function quickEl(key, make, anchor) {
    let el = quickEls.get(key);
    if (!el) { el = make(); quickEls.set(key, el); }
    const sheet = sheetFor(key, anchor);
    if (el.parentNode !== sheet) sheet.appendChild(el);
    return el;
  }
  function dropQuick(prefix) {
    for (const [k, el] of quickEls) if (k.startsWith(prefix)) { el.remove(); quickEls.delete(k); }
  }
  function currentRun() { const s = lastStatus; return s && s.currentRecordId ? s.runs.find(r => r.recordId === s.currentRecordId) : null; }
  function onTab(view) { const s = lastStatus; return s && s.lastView && s.lastView.view === view && s.lastView.recordId === s.currentRecordId; }
  // ESO's pickers slide over the page; while one is open no quick button is shown
  // ESO's dialogs (CAD import, confirmations, the mileage calculation) sit in eso-modal; while
  // one is up no quick button is shown either. The Patient Refusal Form is a shelf of its own kind
  // and keeps its chips.
  const modalOpen = () => Array.from(document.querySelectorAll('eso-modal, eso-modal-dialog')).some(m => visible(m) && !m.querySelector('standard-refusal'));
  const shelfOpen = () => Array.from(document.querySelectorAll('shelf-panel')).some(visible) || modalOpen();
  // a form ESO shows as a modal that is not a picker (the Patient Refusal Form): open when its
  // title is on screen and no picker sits on top of it
  const formOpen = (re) => {
    const h = Array.from(document.querySelectorAll('standard-refusal h1, jump-link-shelf-panel h1, shelf-panel h1')).find(x => visible(x) && re.test(norm(x.textContent)));
    return !!h && !modalOpen() && !Array.from(document.querySelectorAll('shelf-panel')).some(p => visible(p) && !p.contains(h));
  };
  // the names a multi-select field shows, upper-cased
  const shownParts = (ref) => { const v = fieldValue(ref); return v ? v.split(',').map(x => norm(x).toUpperCase()).filter(Boolean) : []; };

  // Rows of buttons under a field's label, above its value: measured, wrapped within the field's
  // width, and the room taken from the control so nothing of ESO's sits beneath them.
  function placeRows(f, els, gap = 6) {
    const r = f.getBoundingClientRect();
    const lab = f.querySelector('.label-container label, label');
    const ctl = f.querySelector('eso-control, .field-area, .field-container');
    const lines = [[]]; let x = 0, rowH = 34;
    for (const b of els) {
      const br = b.getBoundingClientRect(); const w = br.width || 80; rowH = Math.max(rowH, Math.round(br.height) + 6);
      if (x + w > r.width && lines[lines.length - 1].length) { lines.push([]); x = 0; }
      lines[lines.length - 1].push([b, w]); x += w + gap;
    }
    const need = lines.length * rowH + 4;
    let top0;
    if (lab && visible(lab) && ctl) { top0 = lab.getBoundingClientRect().bottom + 6; if (ctl.style.marginTop !== need + 'px') ctl.style.marginTop = need + 'px'; }
    else { top0 = r.top - need + 4; if (f.style.marginTop !== need + 'px') f.style.marginTop = need + 'px'; }
    lines.forEach((line, li) => { let lx = r.left; for (const [b, w] of line) { b.style.left = Math.round(lx) + 'px'; b.style.top = Math.round(top0 + li * rowH) + 'px'; b.style.visibility = ''; lx += w + gap; } });
  }
  // ---- chips: to the right of the group's Add button and in rows under it; or, for a field,
  // under the field's label
  function anchorButton(group) {
    const el = findByText('button, a', group.button, { notInShelf: true });
    const b = el ? (el.closest('button, a') || el) : null;
    return b && onTop(b) ? b : null;
  }
  // Whether the element is what is actually on screen at its own top-left corner: false while
  // ESO draws something over it (attachments, the camera, a print sheet, the patient popover,
  // any dialog). Our own layers do not count.
  function onTop(el) {
    const r = el.getBoundingClientRect();
    // Probe below the top banner: a field sliding under it is not covered, it is clipped (the
    // rows go under the banner with it); only something drawn over the field's visible part counts.
    const x = r.left + Math.min(24, r.width / 2), y = Math.max(r.top + Math.min(12, r.height / 2), bannerBottom() + 4);
    if (y >= r.bottom) return true; // wholly under the banner: the clip hides its rows anyway
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true; // off screen for now: nothing to say
    const top = document.elementsFromPoint(x, y).find(e => !ours(e));
    return !top || el.contains(top) || top.contains(el);
  }
  const fieldEl = (ref) => { const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); return f && visible(f) && onTop(f) ? f : null; };
  // Open a field's list the way a finger would. While ESO shows a field's quick-picks it hides
  // the list icon and puts the list behind the quick-picks' own "Other" button.
  function openPicker(f) {
    if (!f) return false;
    const other = Array.from(f.querySelectorAll('.quick-picks button')).find(b => visible(b) && (b.classList.contains('other') || /^Other$/i.test(norm(b.textContent))));
    const icon = Array.from(f.querySelectorAll('.shelf-click-indicator')).find(visible);
    const area = Array.from(f.querySelectorAll('.field-area')).find(visible);
    (other || icon || area || f.querySelector('.shelf-click-indicator') || f).click();
    return true;
  }
  function layoutChips(gk) {
    const g = CHIP_GROUPS[gk];
    const run = currentRun();
    const ok = settings[g.setting] !== false && run && !run.locked && (g.form ? formOpen(g.form) : onTab(g.tab || 'Patient') && !shelfOpen());
    // anchored to an Add button (chips to its right, rows under it) or to a field (chips after its
    // label, rows under the field)
    const btn = ok ? (g.field ? fieldReady(g.field) : anchorButton(g)) : null; // a field ESO keeps disabled gets no chips
    if (!btn) { dropQuick(gk + ':'); return; }
    const fr = btn.getBoundingClientRect();
    if (!fr.width) { dropQuick(gk + ':'); return; }
    const r = fr;
    const box = btn.parentElement ? btn.parentElement.getBoundingClientRect() : r;
    const right = Math.max(r.right + 200, box.right - 8);
    const have = new Set(((run.lists && run.lists[g.listKey]) || []).map(Number));
    const shown = g.field ? shownParts(g.field) : [];
    const isOn = (name, id) => have.has(id) || (!!name && shown.includes(name.toUpperCase()));
    const gap = 6, rowH = 34;
    let x = r.left + r.width + 12, y = r.top + (r.height - 28) / 2, row = 0;
    const under = r.bottom;
    void quickSheet();
    const els = [];
    for (const [short, name, id] of [...g.chips, ...(g.noOther ? [] : [['Other…', null, 'other']])]) {
      const chip = quickEl(`${gk}:${id}`, () => {
        const c = document.createElement('button'); c.type = 'button'; c.className = 'chip' + (id === 'other' ? ' other' : ''); c.textContent = short; c.title = name || 'Open ESO\'s full list'; c.dataset.group = gk;
        c.addEventListener('pointerdown', (e) => e.stopPropagation());
        c.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (id === 'other') openNative(gk); else tapChip(gk, name, id); });
        return c;
      }, btn);
      chip.classList.toggle('added', id === 'all' ? g.all.every(n => isOn(n)) : id !== 'other' && isOn(name, id));
      chip.classList.toggle('on', id === 'all' ? g.all.some(n => pend(gk).has(n)) : id !== 'other' && pend(gk).has(name));
      chip.classList.toggle('off', id !== 'other' && id !== 'all' && pendOff(gk).has(name));
      chip.classList.toggle('busy', quickBusy);
      chip.style.display = 'block';
      chip.style.visibility = 'hidden';
      { const sh = sheetFor(`${gk}:${id}`, btn); if (chip.parentNode !== sh) sh.appendChild(chip); }
      if (g.field) { els.push(chip); continue; }
      const w = chip.getBoundingClientRect().width || 60;
      if (x + w > right) { row++; x = r.left; y = under + 8 + (row - 1) * rowH; }
      chip.style.left = Math.round(x) + 'px'; chip.style.top = Math.round(y) + 'px';
      chip.style.visibility = '';
      x += w + gap;
    }
    if (g.field) { placeRows(btn, els); return; }
    // reserve the rows under the button so nothing of ESO's sits beneath the chips
    const need = row ? row * rowH + 8 : 0;
    if (btn.style.marginBottom !== need + 'px') btn.style.marginBottom = need + 'px';
  }
  // "Other…": open what ESO itself would open for this group, nothing more
  function openNative(gk) {
    if (quickBusy) return;
    const g = CHIP_GROUPS[gk];
    const el = g.field ? fieldEl(g.field) : anchorButton(g);
    if (!el) return;
    if (g.field) openPicker(el); else el.click();
  }
  function tapChip(gk, name, id) {
    const g = CHIP_GROUPS[gk];
    if (quickBusy && !Object.values(chipBusy).some(Boolean)) return; // something else is driving ESO; a tap during a chip commit queues

    const run = currentRun();
    const shown = g.field ? shownParts(g.field) : [];
    if (id === 'all') { // every name of the group not yet set
      for (const n of g.all) if (!shown.includes(n.toUpperCase())) pend(gk).add(n);
    } else {
      const on = (run && run.lists && (run.lists[g.listKey] || []).map(Number).includes(id)) || shown.includes(name.toUpperCase());
      if (on) { pend(gk).delete(name); pendOff(gk).add(name); } // in already: the tap takes it out
      else { pendOff(gk).delete(name); pend(gk).add(name); }
    }
    layoutChips(gk);
    commitChips(gk);
  }
  // Each tap opens ESO's list, ticks the row and presses OK, like a finger would. Taps that land
  // while the list is being worked ride the next open, so a quick run of taps merges.
  async function commitChips(gk) {
    const g = CHIP_GROUPS[gk];
    if (quickBusy || !(pend(gk).size || pendOff(gk).size)) return;
    quickBusy = true; chipBusy[gk] = true; layoutChips(gk);
    const what = g.what || (gk === 'history' ? 'history' : gk === 'meds' ? 'medications' : gk === 'allergies' ? 'allergies' : 'transport');
    const missed = [];
    try {
      while (pend(gk).size || pendOff(gk).size) {
        const names = [...pend(gk)], offs = [...pendOff(gk)];
        const btn = g.field ? fieldEl(g.field) : anchorButton(g);
        if (!btn) throw new Error(g.field ? 'the field was not found' : 'the Add button was not found');
        lateVeil(g.field ? 'Setting it in ESO…' : `${names.length ? 'Adding' : 'Removing'} ${what}…`, [...names, ...offs].join(', '));
        if (g.field) openPicker(btn); else btn.click();
        const shelf = await until(() => Array.from(document.querySelectorAll('shelf-panel')).find(p => visible(p) && Array.from(p.querySelectorAll('h1, header')).some(h => g.title.test(norm(h.textContent)))), 5000);
        if (!shelf) throw new Error(`the ${what} list did not open`);
        for (const name of names) {
          const li = await pickRow(shelf, name);
          pend(gk).delete(name);
          if (!li) { missed.push(name); continue; }
          const mark = li.querySelector('check-mark');
          if (mark && mark.classList.contains('selected')) continue; // already ticked
          (li.querySelector('.label-content') || li).click();
          if (!await until(() => { const m = li.querySelector('check-mark'); return m && m.classList.contains('selected'); }, 1500)) missed.push(name);
        }
        for (const name of offs) { // untick what was tapped a second time
          const li = await pickRow(shelf, name);
          pendOff(gk).delete(name);
          if (!li) { missed.push(name); continue; }
          const mark = li.querySelector('check-mark');
          if (!mark || !mark.classList.contains('selected')) continue; // not ticked after all
          (li.querySelector('.label-content') || li).click();
          if (!await until(() => { const m = li.querySelector('check-mark'); return !m || !m.classList.contains('selected'); }, 1500)) missed.push(name);
        }
        await clearSearch(shelf);
        const okBtn = Array.from(shelf.querySelectorAll('header button, button')).find(b => /^OK$/i.test(norm(b.textContent)));
        if (!okBtn) throw new Error('no OK button');
        okBtn.click();
        await until(() => closed(shelf), 4000);
      }
    } catch (e) {
      endVeil(); quickBusy = false; chipBusy[gk] = false; pend(gk).clear(); pendOff(gk).clear(); layoutChips(gk);
      alert(`ESO Save: could not add the ${what}. ` + (e && e.message ? e.message : '') + ' The list is left as ESO shows it; finish it by hand.');
      drainChips();
      return;
    }
    endVeil(); quickBusy = false; chipBusy[gk] = false;
    layoutChips(gk);
    if (missed.length) alert('ESO Save: not found in ESO\'s list, add by hand: ' + missed.join(', '));
    drainChips();
  }
  // taps on another group that landed during a commit go in next
  function drainChips() { for (const k of new Set([...Object.keys(pending), ...Object.keys(pendingOff)])) if (pend(k).size || pendOff(k).size) { commitChips(k); return; } }

  // ---- acuity: red / yellow / green next to the label, opens ESO's picker and picks the colour
  const ACUITY_REF = { 'Initial Patient Acuity': 'INITIALPATIENTACUITYID', 'Final Patient Acuity': 'FINALPATIENTACUITYID' };
  function acuityField(label) {
    // ESO marks every field with its ref; the click indicator inside opens the picker
    const f = document.querySelector(`eso-field[data-field-ref="${ACUITY_REF[label]}"]`);
    if (f && visible(f) && !onTop(f)) return null;
    if (f && visible(f)) {
      const lab = f.querySelector('label') || f;
      const ctl = f.querySelector('.shelf-click-indicator') || f.querySelector('.field-area') || f;
      return { lab, box: f, ctl };
    }
    const lab = findByText('label, span, div, p, legend', label, { notInShelf: true });
    if (!lab) return null;
    // the field block: nearest ancestor that is wide and holds a picker control
    let box = lab.parentElement;
    for (let i = 0; box && i < 5; box = box.parentElement, i++) {
      const r = box.getBoundingClientRect();
      if (r.width < 200) continue;
      const ctl = Array.from(box.querySelectorAll('[ng-click], button, a, [class*="icon" i], [class*="list" i]')).find(c => c !== lab && !c.contains(lab) && visible(c));
      if (ctl) return { lab, box, ctl };
    }
    return null;
  }
  function layoutAcuity() {
    const run = currentRun();
    if (settings.quickAcuity === false || !run || run.locked || !onTab('Narrative') || shelfOpen()) { dropQuick('a:'); return; }
    for (const [which, def] of Object.entries(ACUITY)) {
      const f = acuityField(def.label);
      if (!f) { dropQuick('a:' + which); continue; }
      const r = f.lab.getBoundingClientRect();
      const cur = run.lists ? Number(run.lists[def.key]) : null;
      let x = r.right + 14;
      const other = quickEl(`a:${which}:other`, () => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip other'; b.textContent = 'Other…'; b.title = 'Open ESO\'s acuity list';
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (quickBusy) return; const f2 = acuityField(def.label); if (f2) f2.ctl.click(); });
        return b;
      });
      for (const [colour, [name, id]] of Object.entries(def.items)) {
        const sw = quickEl(`a:${which}:${colour}`, () => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'sw ' + colour; b.title = name;
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pickAcuity(which, name); });
          return b;
        });
        sw.classList.toggle('cur', cur === id);
        sw.classList.toggle('busy', quickBusy);
        sw.style.left = Math.round(x) + 'px';
        sw.style.top = Math.round(r.top + (r.height - 26) / 2) + 'px';
        x += 34 + 8;
      }
      other.style.left = Math.round(x + 4) + 'px';
      other.style.top = Math.round(r.top + (r.height - 28) / 2) + 'px';
    }
  }
  async function pickAcuity(which, name) {
    if (quickBusy) return;
    const def = ACUITY[which];
    quickBusy = true; layoutAcuity();
    try {
      const f = acuityField(def.label);
      if (!f) throw new Error(def.label + ' not found on the page');
      f.ctl.click();
      let shelf = await until(() => Array.from(document.querySelectorAll('shelf-panel, eso-single-select-panel')).find(p => visible(p) && Array.from(p.querySelectorAll('li')).some(l => norm(l.textContent).toUpperCase().includes(name.toUpperCase()))), 4000);
      if (!shelf) { f.box.click(); shelf = await until(() => Array.from(document.querySelectorAll('shelf-panel, eso-single-select-panel')).find(p => visible(p) && Array.from(p.querySelectorAll('li')).some(l => norm(l.textContent).toUpperCase().includes(name.toUpperCase()))), 3000); }
      if (!shelf) throw new Error('the acuity list did not open');
      const li = Array.from(shelf.querySelectorAll('li')).find(l => visible(l) && norm((l.querySelector('.label-container > div') || l).textContent).toUpperCase() === name.toUpperCase());
      if (!li) throw new Error(name + ' is not in the list');
      (li.querySelector('.label-content') || li).click();
      await wait(150);
      // a single-select list usually closes itself; press OK if it is still open
      if (document.body.contains(shelf) && visible(shelf)) {
        const okBtn = Array.from((shelf.closest('shelf-panel') || shelf).querySelectorAll('header button')).find(b => /^OK$/i.test(norm(b.textContent)));
        if (okBtn) okBtn.click();
        await until(() => !document.body.contains(shelf) || !visible(shelf), 3000);
      }
    } catch (e) {
      quickBusy = false; layoutAcuity();
      alert('ESO Save: could not set the acuity. ' + (e && e.message ? e.message : ''));
      return;
    }
    quickBusy = false; layoutAcuity();
  }
  // ---- delays: one button above the delay fields presses ESO's own "None/No Delay" on each empty one
  const DELAY_REFS = ['DISPATCHDELAYS', 'RESPONSEDELAYS', 'SCENEDELAYS', 'TRANSPORTDELAYS', 'TURNAROUNDDELAYS'];
  const delayField = (ref) => { const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); return f && visible(f) && onTop(f) ? f : null; };
  const delayEmpty = (f) => { const v = f.querySelector('.display-value'); return !v || !norm(v.textContent); };
  let delaysDoneAt = 0;
  function layoutDelays() {
    const run = currentRun();
    const first = settings.quickDelays === false || !run || run.locked || !onTab('Incident') || shelfOpen() ? null : delayField(DELAY_REFS[0]);
    if (!first) { dropQuick('d:'); return; }
    const fields = DELAY_REFS.map(delayField).filter(Boolean);
    const empty = fields.filter(delayEmpty).length;
    if (!empty && Date.now() - delaysDoneAt > 2500) { dropQuick('d:'); return; }
    const r = first.getBoundingClientRect();
    const btn = quickEl('d:all', () => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'allnone'; b.dataset.group = 'delays'; b.title = 'Press None/No Delay on every delay field that is still empty';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); allNoDelay(); });
      return b;
    });
    const done = !empty;
    btn.classList.toggle('done', done);
    btn.textContent = done ? '✓ All: None/No Delay' : `All: None/No Delay${empty < fields.length ? ` (${empty} left)` : ''}`;
    btn.style.visibility = 'hidden'; btn.style.display = 'block';
    const w = btn.getBoundingClientRect().width || 160;
    btn.style.left = Math.round(r.right - w) + 'px';
    btn.style.top = Math.round(r.top - 36) + 'px';
    btn.style.visibility = '';
  }
  async function allNoDelay() {
    if (quickBusy) return;
    quickBusy = true;
    let pressed = 0;
    try {
      for (const ref of DELAY_REFS) {
        const f = delayField(ref);
        if (!f || !delayEmpty(f)) continue;
        const none = f.querySelector('button.none-or-pn-btn');
        if (!none) continue;
        none.click(); pressed++;
        await wait(120);
      }
    } finally { quickBusy = false; delaysDoneAt = Date.now(); layoutDelays(); }
    if (!pressed) return;
  }
  // ---- facilities: chips under the Predefined/Address pills of the Scene and Destination locations.
  // A tap selects Predefined, sets the type to match the facility, then picks the name.
  const FACILITY_GROUPS = {
    sending: { setting: 'facilitySending', model: 'vm.scene', typeRef: 'DISPATCHPREDEFINEDLOCATIONTYPEID', nameRef: 'DISPATCHPREDEFINEDLOCATIONID', typeList: 'locationTypes' },
    destination: { setting: 'facilityDestination', model: 'vm.destination', typeRef: 'DESTINATIONPREDEFINEDLOCATIONTYPEID', nameRef: 'DESTINATIONPREDEFINEDLOCATIONID', typeList: 'destinationTypes' },
  };
  function locationBlock(g) {
    const loc = Array.from(document.querySelectorAll('eso-location')).find(l => (l.getAttribute('view-model') || '') === g.model && visible(l));
    if (!loc || !onTop(loc)) return null;
    const pills = loc.querySelector('.button-group');
    const pill = pills ? Array.from(pills.querySelectorAll('button')).find(b => /^Predefined$/i.test(norm(b.textContent))) : null;
    return { loc, pills, pill };
  }
  // What ESO calls this kind of place: on the Scene side its location type, on the Destination
  // side the destination type that maps to it. From the type tables of the last bundle seen.
  function typeNameFor(list, typeId) {
    const t = facilityTypes || facilities;
    if (!t || !typeId) return null;
    if (list === 'locationTypes') { const x = (t.locationTypes || []).find(x => x.id === typeId); return x ? x.name : null; }
    const x = (t.destinationTypes || []).find(x => x.locationTypeId === typeId); return x ? x.name : null;
  }
  function facilityTypeName(g, fac) {
    // the name kept with the chip when it was chosen, else ESO's tables, else the one id every
    // standard chip shares (Hospital)
    return (g.typeList === 'locationTypes' ? fac.type : fac.destType) || typeNameFor(g.typeList, fac.typeId) || (fac.typeId === 6540 ? 'Hospital' : null);
  }
  function layoutFacilities(gk) {
    const g = FACILITY_GROUPS[gk];
    const run = currentRun();
    const chosen = settings[g.setting] || [];
    const blk = settings.quickFacilities !== false && chosen.length && run && !run.locked && onTab('Incident') && !shelfOpen() ? locationBlock(g) : null;
    if (!blk || !blk.pills) { dropQuick('f:' + gk + ':'); return; }
    const pr = blk.pills.getBoundingClientRect();
    if (!pr.width) { dropQuick('f:' + gk + ':'); return; }
    const nameField = fieldEl(g.nameRef);
    const current = nameField ? norm((nameField.querySelector('.display-value') || nameField).textContent) : '';
    const gap = 6, rowH = 34;
    const lr = blk.loc.getBoundingClientRect();
    const firstField = Array.from(blk.loc.querySelectorAll('eso-field')).find(visible);
    const fr0 = firstField ? firstField.getBoundingClientRect() : lr;
    const left = Math.min(pr.left, fr0.left), right = Math.max(pr.right, fr0.right, lr.right - 8);
    let x = left, y = pr.bottom + 8, row = 0;
    void quickSheet();
    for (const fac of chosen) {
      const chip = quickEl(`f:${gk}:${fac.id}`, () => {
        const c = document.createElement('button'); c.type = 'button'; c.className = 'chip' + (fac.id === 'other' ? ' other' : ''); c.textContent = fac.label || fac.name; c.title = fac.name; c.dataset.group = 'fac-' + gk;
        c.addEventListener('pointerdown', (e) => e.stopPropagation());
        c.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (fac.id === 'other') openFacilityList(gk); else pickFacility(gk, fac); });
        return c;
      });
      chip.classList.toggle('added', fac.id !== 'other' && current.toUpperCase() === fac.name.toUpperCase());
      chip.classList.toggle('busy', quickBusy);
      chip.style.display = 'block'; chip.style.visibility = 'hidden';
      { const sh = sheetFor(`f:${gk}:${fac.id}`); if (chip.parentNode !== sh) sh.appendChild(chip); }
      const w = chip.getBoundingClientRect().width || 120;
      if (x + w > right && x > left) { row++; x = left; y = pr.bottom + 8 + row * rowH; }
      chip.style.left = Math.round(x) + 'px'; chip.style.top = Math.round(y) + 'px';
      chip.style.visibility = '';
      x += w + gap;
    }
    const need = (row + 1) * rowH + 6;
    if (blk.pills.style.marginBottom !== need + 'px') blk.pills.style.marginBottom = need + 'px';
  }
  const rowLabel = (l) => norm((l.querySelector('.label-container > div, .label-container div') || l).textContent).toUpperCase();
  const findRow = (shelf, name) => Array.from(shelf.querySelectorAll('li')).find(l => visible(l) && rowLabel(l) === name.toUpperCase());
  // The row named exactly this, in an open list. The row is taken straight from the list when
  // it is there (the usual case: a tap, a click, done); only a list too long to show it all gets
  // the name typed into its search box first.
  async function pickRow(shelf, name) {
    let li = findRow(shelf, name) || await until(() => findRow(shelf, name), 250);
    if (li) return li;
    const input = shelf.querySelector('eso-search-input input, input[type=text]');
    if (!input) return null;
    input.focus(); input.value = name; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    li = await until(() => findRow(shelf, name), 3000);
    return li;
  }
  async function clearSearch(shelf) {
    const input = shelf.querySelector('eso-search-input input, input[type=text]');
    if (input && input.value) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); await wait(30); }
  }
  const closed = (shelf) => !document.body.contains(shelf) || !visible(shelf);
  async function pickSingle(field, name) {
    // open a single-select field's picker and choose the item named exactly this
    openPicker(field);
    const shelf = await until(() => Array.from(document.querySelectorAll('shelf-panel')).find(visible), 4000);
    if (!shelf) throw new Error('the list did not open');
    const li = await pickRow(shelf, name);
    if (!li) throw new Error(`"${name}" is not in the list`);
    (li.querySelector('.label-content') || li).click();
    // a single-select list closes itself; a multi-select one waits for OK
    if (!await until(() => closed(shelf), 300)) {
      await clearSearch(shelf);
      const okBtn = Array.from(shelf.querySelectorAll('header button, button')).find(b => /^OK$/i.test(norm(b.textContent)));
      if (okBtn) okBtn.click();
      await until(() => closed(shelf), 3000);
    }
  }
  async function openFacilityList(gk) {
    if (quickBusy) return;
    const g = FACILITY_GROUPS[gk];
    const blk = locationBlock(g); if (!blk) return;
    if (blk.pill && !blk.pill.classList.contains('selected')) blk.pill.click();
    const name = await until(() => fieldEl(g.nameRef), 2000);
    const f = name && !name.hasAttribute('disabled') ? name : fieldEl(g.typeRef);
    openPicker(f);
  }
  async function pickFacility(gk, fac) {
    if (quickBusy) return;
    const g = FACILITY_GROUPS[gk];
    quickBusy = true; layoutFacilities(gk);
    try {
      const blk = locationBlock(g);
      if (!blk) throw new Error('the location section was not found');
      lateVeil('Setting the facility…', fac.name);
      if (blk.pill && !blk.pill.classList.contains('selected')) { blk.pill.click(); }
      const typeField = await until(() => fieldEl(g.typeRef), 3000);
      if (!typeField) throw new Error('the Predefined fields did not appear');
      const typeName = facilityTypeName(g, fac);
      if (!typeName) throw new Error(`ESO's list does not say what kind of place ${fac.name} is. Remove it in Settings and add it again with a run open.`);
      const curType = norm((typeField.querySelector('.display-value') || typeField).textContent);
      if (curType.toUpperCase() !== typeName.toUpperCase()) {
        const qp = Array.from(typeField.querySelectorAll('.quick-picks button')).find(b => visible(b) && norm(b.textContent).toUpperCase() === typeName.toUpperCase());
        if (qp) qp.click();
        const ok = qp && await until(() => norm((typeField.querySelector('.display-value') || typeField).textContent).toUpperCase() === typeName.toUpperCase(), 1500, 60);
        if (!ok) await pickSingle(typeField, typeName);
      }
      const nameField = await until(() => { const f = fieldEl(g.nameRef); return f && !f.hasAttribute('disabled') ? f : null; }, 4000);
      if (!nameField) throw new Error('the name field is not ready');
      await pickSingle(nameField, fac.name);
    } catch (e) {
      endVeil(); quickBusy = false; layoutFacilities(gk);
      alert('ESO Save: could not set the facility. ' + (e && e.message ? e.message : ''));
      return;
    }
    endVeil(); quickBusy = false; layoutFacilities(gk);
  }
  // ---- assessments: "All normal" opens ESO's own Quick Ax for that assessment and presses
  // No Abnormalities on every category still unset, then OK; "A&Ox4" opens Mental Status and
  // presses ESO's Alert and Oriented x4.
  const NORMAL_RE = /^(No Abnormalities|Normal Baseline( For Patient)?)$/i;
  function layoutAssess() {
    const run = currentRun();
    const ok = settings.quickAssess !== false && run && !run.locked && onTab('Assessments') && !shelfOpen();
    const records = ok ? Array.from(document.querySelectorAll('assessment-record')).filter(r => visible(r) && onTop(r)) : [];
    const keep = new Set();
    records.forEach((rec, i) => {
      const id = rec.getAttribute('data-item-id') || String(i);
      const anchor = rec.querySelector('.ax-edit-buttons') || rec.querySelector('header');
      if (!anchor) return;
      const ar = anchor.getBoundingClientRect();
      if (!ar.width) return;
      // done when every category row of the record shows the No Abnormalities check
      const rows = Array.from(rec.querySelectorAll('.assessment-summary')).filter(r => !/Neonatal/i.test(r.textContent));
      const normal = rows.length && rows.every(r => r.querySelector('.no-abnormalities-or-not-assessed .assess-circle-check-bg, .no-abnormalities-or-not-assessed.assess-circle-check-bg'));
      const defs = [['all', normal ? '✓ All normal' : 'All normal', 'Press No Abnormalities on every category of this assessment (ESO\'s Quick Ax), then OK'], ['ao', 'A&Ox4', 'Open Mental Status and press Alert and Oriented x4']];
      let right = ar.left - 10;
      for (const [k, text, title] of defs.reverse()) {
        const key = `x:${id}:${k}`; keep.add(key);
        const b = quickEl(key, () => {
          const el = document.createElement('button'); el.type = 'button'; el.className = 'allnone'; el.dataset.group = 'assess-' + k;
          el.addEventListener('pointerdown', (e) => e.stopPropagation());
          el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (k === 'all') assessAllNormal(rec); else assessAOx4(rec); });
          return el;
        });
        b.textContent = text; b.title = title;
        b.classList.toggle('done', k === 'all' && !!normal);
        b.classList.toggle('busy', quickBusy);
        b.style.visibility = 'hidden'; b.style.display = 'block';
        const w = b.getBoundingClientRect().width || 100;
        b.style.left = Math.round(right - w) + 'px';
        b.style.top = Math.round(ar.top + (ar.height - 30) / 2) + 'px';
        b.style.visibility = '';
        right -= w + 8;
      }
    });
    for (const [k, el] of quickEls) if (k.startsWith('x:') && !keep.has(k)) { el.remove(); quickEls.delete(k); }
  }
  async function confirmIfAsked() {
    // ESO asks "Change assessment?" when a category already has findings; answer it
    const dlg = await until(() => Array.from(document.querySelectorAll('eso-modal-dialog, .eso-modal-dialog')).find(visible), 250, 50);
    if (!dlg) return;
    const ok = Array.from(dlg.querySelectorAll('button')).find(b => /change assessment|^ok$|^yes$/i.test(norm(b.textContent)));
    if (ok) { ok.click(); await until(() => !document.body.contains(dlg) || !visible(dlg), 2000); }
  }
  async function assessAllNormal(rec) {
    if (quickBusy) return;
    quickBusy = true; layoutAssess();
    try {
      const qa = rec.querySelector('button.quick-assess');
      if (!qa) throw new Error('this assessment has no Quick Ax button');
      showVeilMessage('Setting every category to No Abnormalities…', 'through ESO\'s Quick Ax');
      qa.click();
      const shelf = await until(() => Array.from(document.querySelectorAll('shelf-panel')).find(p => visible(p) && p.querySelector('.categories .category')), 5000);
      if (!shelf) throw new Error('Quick Ax did not open');
      for (const cat of Array.from(shelf.querySelectorAll('.categories .category'))) {
        const name = norm((cat.querySelector('header') || cat).textContent).replace(/Assess$/i, '').trim();
        if (/neonatal/i.test(name)) continue;
        const btn = Array.from(cat.querySelectorAll('button.radio-btn')).find(b => NORMAL_RE.test(norm(b.textContent)));
        if (!btn || btn.classList.contains('selected')) continue;
        btn.click();
        await confirmIfAsked();
        await wait(60);
      }
      const okBtn = Array.from(shelf.querySelectorAll('header button, button')).find(b => /^OK$/i.test(norm(b.textContent)));
      if (!okBtn) throw new Error('no OK button');
      okBtn.click();
      await until(() => !document.body.contains(shelf) || !visible(shelf), 4000);
    } catch (e) {
      hideVeil(); quickBusy = false; layoutAssess();
      alert('ESO Save: could not set the assessment. ' + (e && e.message ? e.message : ''));
      return;
    }
    hideVeil(); quickBusy = false; setTimeout(layoutAssess, 300);
  }
  async function assessAOx4(rec) {
    if (quickBusy) return;
    quickBusy = true; layoutAssess();
    try {
      const row = Array.from(rec.querySelectorAll('.assessment-summary')).find(r => /Mental Status/i.test(r.textContent));
      if (!row) throw new Error('Mental Status row not found');
      showVeilMessage('Setting Alert and Oriented x4…', 'in ESO\'s Mental Status section');
      row.click();
      const btn = await until(() => Array.from(document.querySelectorAll('shelf-panel button.radio-btn')).find(b => visible(b) && /Alert and Oriented x4/i.test(norm(b.textContent))), 5000);
      if (!btn) throw new Error('the Mental Status section did not open');
      if (!btn.classList.contains('selected')) { btn.click(); await confirmIfAsked(); await wait(80); }
      const shelf = btn.closest('shelf-panel');
      const okBtn = Array.from(shelf.querySelectorAll('header button, button')).find(b => /^OK$/i.test(norm(b.textContent)));
      if (!okBtn) throw new Error('no OK button');
      okBtn.click();
      await until(() => !document.body.contains(shelf) || !visible(shelf), 4000);
    } catch (e) {
      hideVeil(); quickBusy = false; layoutAssess();
      alert('ESO Save: could not set orientation. ' + (e && e.message ? e.message : ''));
      return;
    }
    hideVeil(); quickBusy = false; setTimeout(layoutAssess, 300);
  }
  // ---- dispositions: one button sets the whole set the way the crew would, then outlines in red
  // whatever ESO still needs (Transport Mode, Reason for Refusal) until it is answered.
  const fieldValue = (ref) => { const f = fieldEl(ref); if (!f) return null; const v = f.querySelector('.display-value'); return norm(v ? v.textContent : ''); };
  const fieldReady = (ref) => { const f = fieldEl(ref); return f && !f.hasAttribute('disabled') ? f : null; };
  // Set a single-select field: ESO's own quick-pick button when it has one, else its picker.
  async function setSingle(ref, fullName, quickLabel) {
    const f = await until(() => fieldReady(ref), 3000);
    if (!f) return false; // not on the page or not applicable for this disposition
    if (norm(fieldValue(ref)).toUpperCase() === fullName.toUpperCase()) return true;
    const qp = quickLabel ? Array.from(f.querySelectorAll('.quick-picks button')).find(b => norm(b.textContent).toUpperCase() === quickLabel.toUpperCase()) : null;
    if (qp) {
      qp.click();
      if (await until(() => norm(fieldValue(ref)).toUpperCase() === fullName.toUpperCase() || (fieldValue(ref) || '').toUpperCase().includes(quickLabel.toUpperCase()), 1200, 60)) return true;
    }
    await pickSingle(f, fullName);
    return true;
  }
  const DISPO = {
    als: { text: 'Transported ALS', steps: [['UNITDISPOSITIONITEMID', 'Patient Contact Made'], ['PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'Patient Evaluated and Care Provided'], ['CREWDISPOSITIONITEMID', 'Initiated and Continued Primary Care'], ['TRANSPORTDISPOSITIONITEMID', 'Transport by This EMS Unit (This Crew Only)'], ['LEVELOFSERVICEID', 'Advanced Life Support', 'ALS']], needs: ['TRANSPORTMODEID'] },
    bls: { text: 'Transported BLS', steps: [['UNITDISPOSITIONITEMID', 'Patient Contact Made'], ['PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'Patient Evaluated and Care Provided'], ['CREWDISPOSITIONITEMID', 'Initiated and Continued Primary Care'], ['TRANSPORTDISPOSITIONITEMID', 'Transport by This EMS Unit (This Crew Only)'], ['LEVELOFSERVICEID', 'Basic Life Support', 'BLS']], needs: ['TRANSPORTMODEID'] },
    refusal: { text: 'Refusal', steps: [['UNITDISPOSITIONITEMID', 'Patient Contact Made'], ['PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'Patient Evaluated and Refused Care'], ['CREWDISPOSITIONITEMID', 'Back in Service, Care or Support Services Refused'], ['TRANSPORTDISPOSITIONITEMID', 'No Transport']], needs: ['REFUSALRELEASEITEMIDS'] },
    prior: { text: 'Canceled (Prior)', steps: [['UNITDISPOSITIONITEMID', 'Canceled Prior to Arrival at Scene'], ['CREWDISPOSITIONITEMID', 'Back in Service, No Care or Support Services Required']], needs: [] },
    scene: { text: 'Canceled (Scene)', steps: [['UNITDISPOSITIONITEMID', 'Canceled on Scene'], ['CREWDISPOSITIONITEMID', 'Back in Service, No Care or Support Services Required']], needs: [] },
  };
  const needs = new Map(); // ref -> message, outlined until the field has a value
  let needsRun = null;
  function layoutDisposition() {
    const run = currentRun();
    const first = settings.quickDisposition === false || !run || run.locked || !onTab('Incident') || shelfOpen() ? null : fieldEl('UNITDISPOSITIONITEMID');
    if (!first) { dropQuick('dp:'); return; }
    const r = first.getBoundingClientRect();
    if (!r.width) { dropQuick('dp:'); return; }
    const els = [];
    for (const [k, d] of [...Object.entries(DISPO), ['other', { text: 'Other…', steps: [], other: true }]]) {
      const b = quickEl('dp:' + k, () => {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'allnone' + (d.other ? ' other' : ''); el.dataset.group = 'dispo-' + k; el.textContent = d.text; el.title = d.other ? 'Open ESO\'s Unit Disposition list' : d.steps.map(s => s[1]).join(' · ');
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
        el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (d.other) { if (!quickBusy) openPicker(fieldEl('UNITDISPOSITIONITEMID')); } else runDisposition(k); });
        return el;
      });
      b.classList.toggle('busy', quickBusy);
      b.style.visibility = 'hidden'; b.style.display = 'block';
      els.push(b);
    }
    placeRows(first, els, 8);
  }
  async function runDisposition(k) {
    if (quickBusy) return;
    const d = DISPO[k];
    quickBusy = true; layoutDisposition();
    try {
      lateVeil(d.text, d.steps.map(s => s[1]).join(', '));
      for (const [ref, name, quick] of d.steps) { await setSingle(ref, name, quick); await wait(60); }
      for (const ref of d.needs) needs.set(ref, ref === 'TRANSPORTMODEID' ? 'Transport Mode needed' : 'Reason needed');
    } catch (e) {
      endVeil(); quickBusy = false; layoutDisposition();
      alert('ESO Save: could not finish the disposition. ' + (e && e.message ? e.message : '') + ' Check the fields and finish by hand.');
      return;
    }
    endVeil(); quickBusy = false; layoutDisposition(); layoutNeeds();
  }
  // ---- response mode to scene: Emergent / Non-Emergent / Other… above the field, one tap even
  // once the field is set (ESO's own quick-picks only show while it is empty)
  // Rows of one-tap choices above a single-select field, one tap even once the field is set (ESO's
  // own quick-picks only show while it is empty). [label, ESO's full name, ESO quick-pick label]
  const IMPRESSIONS = [['Chest Pain', 'Chest Pain / Discomfort'], ['SOB', 'Acute Respiratory Distress (Dyspnea)'], ['Abd Pain', 'Abdominal Pain'], ['AMS', 'Altered Mental Status'], ['Weakness', 'Generalized Weakness'],
    ['Syncope', 'Syncope / Fainting'], ['Seizure', 'Seizures without status epilepticus'], ['Injury', 'Injury'], ['Stroke', 'Stroke'], ['No Complaint', 'No Complaints or Injury/Illness Noted']];
  const SINGLE_ROWS = {
    // Where ESO shows its own quick-picks (and its own Other), the row carries only what ESO does
    // not: no repeat of ESO's buttons and no Other… of its own.
    runtype: { setting: 'quickIncident', ref: 'RUNTYPEID', what: 'Run Type', noOther: true, items: [['Hosp-Hosp', 'Hospital-to-Hospital Transfer'], ['Mutual Aid', 'Emergency Response (Mutual Aid)'], ['Hosp-NonHosp', 'Hospital to Non-Hospital Facility Transfer'], ['NonHosp-Hosp', 'Non-Hospital Facility to Hospital Transfer']] },
    mutual: { setting: 'quickIncident', ref: 'MUTUALAIDID', what: 'Mutual Aid', noOther: true, items: [['Given', 'Mutual Aid Given'], ['Received', 'Mutual Aid Received'], ['No Unit Available', 'No Unit Available']] },
    emd: { setting: 'quickIncident', ref: 'EMDCOMPLAINTID', what: 'EMD Complaint', noOther: true, items: [['Abd Pain', 'Abdominal Pain/Problems'], ['AMS', 'Altered Mental Status'], ['Allergic', 'Allergic Reaction/Stings'], ['Assault', 'Assault'], ['Chest Pain', 'Chest Pain (Non-Traumatic)'], ['Cardiac Arrest', 'Cardiac Arrest/Death'], ['Diabetic', 'Diabetic Problem'], ['Falls', 'Falls'], ['Hemorrhage/Lac', 'Hemorrhage/Laceration'], ['Medical Alarm', 'Medical Alarm'], ['Overdose', 'Overdose/Poisoning/Ingestion'], ['Pregnancy', 'Pregnancy/Childbirth'], ['Psych', 'Psychiatric Problem/Abnormal Behavior/Suicide Attempt'], ['Seizure', 'Convulsions/Seizure'], ['Stroke', 'Stroke/CVA']] },
    reqby: { setting: 'quickIncident', ref: 'REQUESTEDBYITEMID', what: 'Requested By', noOther: true, items: [['Physician', 'Physician'], ['Law Enforcement', 'Law Enforcement'], ['Fire Dept', 'Fire Department'], ['Other Healthcare', 'Other Healthcare Provider']] },
    // Narrative tab. The ten impressions a rural service sees most; the secondary list carries the
    // same names.
    primary: { setting: 'quickNarrative', tab: 'Narrative', ref: 'PRIMARYIMPRESSIONID', what: 'Primary Impression', items: IMPRESSIONS },
    secondary: { setting: 'quickNarrative', tab: 'Narrative', ref: 'SECONDARYIMPRESSIONID', what: 'Secondary Impression', items: IMPRESSIONS },
    care: { setting: 'quickNarrative', tab: 'Narrative', ref: 'PROVIDEDCARELEVELID', what: 'Provided Care Level', items: [['ALS Paramedic', 'ALS - Paramedic'], ['BLS', 'BLS - All Levels']] },
    units: { setting: 'quickNarrative', tab: 'Narrative', ref: 'CHIEFTIMEUNITSOFCOMPLAINTDURATION', what: 'Duration Unit', items: [['Minutes', 'Minutes'], ['Hours', 'Hours'], ['Days', 'Days']] },
    // Chief Complaint System: ESO shows Global/General, Musculoskeletal/Skin, Cardiovascular and Other itself
    system: { setting: 'quickNarrative', tab: 'Narrative', ref: 'CHIEFCOMPLAINTORGANSYSTEMID', what: 'Chief Complaint System', noOther: true, items: [['Psych', 'Behavioral/Psychiatric'], ['Neuro', 'CNS/Neuro'], ['GI', 'GI'], ['Immune', 'Lymphatic/Immune'], ['Reproductive', 'Reproductive'], ['Pulmonary', 'Pulmonary'], ['Renal', 'Renal']] },
    anatomic: { setting: 'quickNarrative', tab: 'Narrative', ref: 'CHIEFCOMPLAINTANATOMICLOCATIONID', what: 'Anatomic Location', noOther: true, items: [['Head', 'Head'], ['Neck', 'Neck'], ['Chest', 'Chest'], ['Abd', 'Abdomen'], ['Back', 'Back'], ['Upper Ext', 'Extremity-Upper'], ['Lower Ext', 'Extremity-Lower'], ['Genitalia', 'Genitalia'], ['General', 'General/Global']] },
    // Patient tab
    race: { setting: 'quickPatient', tab: 'Patient', ref: 'PATIENTRACEIDS', what: 'Race', noOther: true, items: [['White', 'White', 'White'], ['Black', 'Black or African American', 'Black'], ['Asian', 'Asian'], ['Latino', 'Hispanic or Latino'], ['Am Indian', 'American Indian or Alaska Native'], ['Mid East', 'Middle Eastern or North African'], ['Pac Islander', 'Native Hawaiian or Other Pacific Islander']] },
  };
  function layoutSingleRows() {
    const run = currentRun();
    for (const [rk, row] of Object.entries(SINGLE_ROWS)) {
      const f = settings[row.setting] === false || !run || run.locked || !onTab(row.tab || 'Incident') || shelfOpen() ? null : fieldReady(row.ref);
      if (!f) { dropQuick(`sr:${rk}:`); continue; }
      const r = f.getBoundingClientRect();
      if (!r.width) { dropQuick(`sr:${rk}:`); continue; }
      const cur = shownParts(row.ref);
      const entries = [...row.items.map((it, i) => [String(i), ...it]), ...(row.noOther ? [] : [['other', 'Other…', null, null]])];
      // measure, wrap within the field width, then place the rows above the field
      const els = entries.map(([k, text, full, quick]) => {
        const b = quickEl(`sr:${rk}:${k}`, () => {
          const el = document.createElement('button'); el.type = 'button'; el.className = 'chip' + (k === 'other' ? ' other' : ''); el.dataset.group = 'sr-' + rk; el.textContent = text; el.title = k === 'other' ? `Open ESO's ${row.what} list` : `${row.what}: ${full}`;
          el.addEventListener('pointerdown', (e) => e.stopPropagation());
          el.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            if (quickBusy) return;
            const f2 = fieldEl(row.ref); if (!f2) return;
            if (k === 'other') { openPicker(f2); return; }
            quickBusy = true; layoutSingleRows();
            lateVeil('Setting it in ESO…', `${row.what}: ${full}`);
            try { await setSingle(row.ref, full, quick); } catch (err) { alert(`ESO Save: could not set ${row.what}. ` + (err && err.message ? err.message : '')); }
            endVeil(); quickBusy = false; layoutSingleRows();
          });
          return el;
        });
        b.classList.toggle('added', k !== 'other' && !!full && cur.includes(full.toUpperCase()));
        b.classList.toggle('busy', quickBusy);
        b.style.display = 'block'; b.style.visibility = 'hidden';
        return b;
      });
      placeRows(f, els);
    }
  }
  function layoutNeeds() {
    const run = currentRun();
    if (!run || !onTab('Incident') || shelfOpen()) { dropQuick('nd:'); return; }
    if (needsRun !== run.recordId) { needs.clear(); needsRun = run.recordId; } // another run: its own answers
    for (const [ref, msg] of needs) {
      const f = fieldEl(ref);
      const v = f ? f.querySelector('.display-value') : null;
      const filled = v && norm(v.textContent);
      if (!f) { dropQuick('nd:' + ref); continue; } // off screen for the moment (a tab hop): still owed
      if (filled) { needs.delete(ref); dropQuick('nd:' + ref); continue; }
      const r = f.getBoundingClientRect();
      const box = quickEl('nd:' + ref, () => { const el = document.createElement('div'); el.className = 'need'; return el; });
      box.dataset.msg = msg;
      box.style.left = Math.round(r.left - 6) + 'px'; box.style.top = Math.round(r.top - 4) + 'px';
      box.style.width = Math.round(r.width + 8) + 'px'; box.style.height = Math.round(r.height + 4) + 'px';
    }
  }

  // ---- auto-fill after a mode is chosen: response mode to scene, and transport mode
  const AUTO = {
    PRIORITYID: {
      match: (v) => /^Emergent$/i.test(v) ? 'e' : /^Non-Emergent$/i.test(v) ? 'n' : /Emergent/i.test(v) ? 'other' : null,
      fill: (kind) => [
        ...(kind === 'e' ? [['RESPONSEMODELIGHTSANDSIRENSUSE', 'Lights and Sirens', 'Lights & Sirens']] : kind === 'n' ? [['RESPONSEMODELIGHTSANDSIRENSUSE', 'No Lights or Sirens', 'No Lights or Sirens']] : []),
        ...(kind === 'e' || kind === 'n' ? [['RESPONSEMODEINTERSECTIONNAVIGATION', 'With Normal Light Patterns', 'With Normal Light Pattern'], ['RESPONSEMODESCHEDULED', 'No (Unscheduled)', 'No'], ['RESPONSEMODESPEED', 'Speed-Normal Traffic', 'Normal Traffic']] : []),
        ['EMDPERFORMEDID', 'No', 'No'],
      ],
    },
    TRANSPORTMODEID: {
      match: (v) => /^Emergent \(Immediate Response\)$/i.test(v) ? 'e' : /^Non-Emergent$/i.test(v) ? 'n' : null,
      fill: (kind) => [['TRANSPORTMODELIGHTSANDSIRENSUSE', kind === 'e' ? 'Lights and Sirens' : 'No Lights or Sirens', kind === 'e' ? 'Lights & Sirens' : 'No Lights or Sirens'], ['TRANSPORTMETHODID', 'Ground-Ambulance', 'Ambulance']],
    },
  };
  const seenMode = {};
  let autoBusy = false;
  function watchModes() {
    if (quickBusy || autoBusy || warming) return; // look again once the buttons and the warm-up are done
    for (const [ref, rule] of Object.entries(AUTO)) {
      if (settings.autoResponse === false || !onTab('Incident')) { delete seenMode[ref]; continue; }
      const v = fieldValue(ref);
      if (v === null) { delete seenMode[ref]; continue; }
      const prev = seenMode[ref];
      seenMode[ref] = v;
      if (prev === undefined || prev === v || !v) continue; // first look, or unchanged, or cleared
      const kind = rule.match(v);
      if (!kind) continue;
      autoFill(rule.fill(kind));
    }
  }
  async function autoFill(steps) {
    if (autoBusy) return;
    autoBusy = true;
    try {
      for (const [ref, name, quick] of steps) {
        const f = await until(() => fieldReady(ref), 2500);
        if (!f || norm(fieldValue(ref))) continue; // only fields still empty
        await setSingle(ref, name, quick);
        await wait(60);
      }
    } catch (e) { /* leave the rest to the crew */ }
    autoBusy = false;
  }
  // Everything in the quick and copy layers scrolls under ESO's banner (the dark top bar and the
  // tab strip) like the page does: the layers are clipped at the banner's bottom edge.
  const tabStrip = {}; // label -> element, found once per view
  function bannerBottom() {
    let b = 0;
    const bar = topBarRect(); if (bar) b = Math.max(b, bar.rect.bottom);
    const s = lastStatus; const label = s ? currentTabLabel(s) : null;
    if (label) {
      if (!tabStrip[label] || !document.contains(tabStrip[label])) tabStrip[label] = tabElement(label);
      let el = tabStrip[label];
      for (let i = 0; el && i < 4; el = el.parentElement, i++) {
        const r = el.getBoundingClientRect();
        if (r.height > 110 || r.height <= 0) break;
        if (r.top < b + 40 && r.bottom > 0) b = Math.max(b, r.bottom);
      }
    }
    return Math.round(b);
  }
  function clipLayers() {
    const b = bannerBottom();
    const clip = b > 0 ? `inset(${b}px 0 0 0)` : '';
    for (const l of [quickLayer, copyLayer]) if (l && l.style.clipPath !== clip) l.style.clipPath = clip;
  }
  // ---- loaded mileage: once the scene and the destination both have an address, ESO's own
  // "Calculate Mileage" button is pressed for the crew, once per pair of addresses
  const mileageTried = {}; // recordId -> the pair of addresses last tried
  let mileageBusy = false;
  function addressReady(loc) {
    // what ESO itself needs before it will geocode: a predefined place, or a typed address with
    // street, city, state and zip
    const val = (f) => { const v = f.querySelector('.display-value'); return f && visible(f) ? norm(v ? v.textContent : '') : ''; };
    const fields = Array.from(loc.querySelectorAll('eso-field[data-field-ref]')).filter(visible);
    const by = (re) => fields.filter(f => re.test(f.dataset.fieldRef)).map(val).find(Boolean) || '';
    const predefined = by(/PREDEFINEDLOCATIONID$/);
    if (predefined) return 'P:' + predefined;
    const street = by(/(ADDRESS1|MANUALADDRESS1|STREET)$/), city = by(/CITY$/), state = by(/STATEID$/), zip = by(/(ZIP|POSTALCODE)$/);
    return street && city && state && zip ? `M:${street}|${city}|${state}|${zip}` : '';
  }
  function watchMileage() {
    const run = currentRun(); const s = lastStatus;
    if (settings.autoMileage === false || !run || run.locked || !s || !s.online || !onTab('Incident') || shelfOpen() || quickBusy || autoBusy || mileageBusy || warming) return;
    const btn = document.getElementById('calcMileage');
    if (!btn || !visible(btn) || (host && host.contains(btn))) return; // no button: the mileage is already there
    if (document.querySelector('eso-modal-dialog')) return;
    const locs = ['vm.scene', 'vm.destination'].map(m => Array.from(document.querySelectorAll('eso-location')).find(l => (l.getAttribute('view-model') || '') === m && visible(l)));
    if (!locs[0] || !locs[1]) return;
    const sig = locs.map(addressReady);
    if (!sig[0] || !sig[1]) return;
    const key = sig.join(' -> ');
    if (mileageTried[run.recordId] === key) return; // this pair was tried already; a change of address tries again
    mileageTried[run.recordId] = key;
    calculateMileage(btn);
  }
  async function calculateMileage(btn) {
    mileageBusy = true;
    try {
      btn.click();
      // ESO shows a "Calculating…" dialog, then either fills the miles in or says why not; a
      // complaint we caused is closed for the crew (nothing else is touched)
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        await wait(150);
        const dlg = Array.from(document.querySelectorAll('eso-modal-dialog')).find(visible);
        if (!dlg) { if (Date.now() - t0 > 1500) break; continue; }
        const title = norm((dlg.querySelector('h1, h2, .title, [data-title]') || dlg).textContent);
        if (/missing address|could not determine|problem calculating/i.test(title)) {
          const ok = Array.from(dlg.querySelectorAll('button')).find(b => /^(OK|Close|Dismiss)$/i.test(norm(b.textContent)));
          if (ok) ok.click();
          break;
        }
      }
    } catch (e) { /* the crew can press the button themselves */ }
    mileageBusy = false;
  }
  // ---- crew roles: every role, shortened, above each crew member (Incident tab). A tap does
  // what a finger would: open the member (Edit), open Roles, tick, OK, OK.
  const CREW_ROLES = [['Lead Scene', 'Lead - At Scene', 14107], ['Lead Trans', 'Lead - Transport', 14108], ['Drv Resp', 'Driver - Response', 14102], ['Drv Trans', 'Driver - Transport', 14103],
    ['Other Scene', 'Other Caregiver - At Scene', 14105], ['Other Trans', 'Other Caregiver - Transport', 14106], ['Other', 'Other', 14104]];
  const crewPend = {}; // member name -> { on: Set, off: Set }
  const crewPending = (name) => (crewPend[name] = crewPend[name] || { on: new Set(), off: new Set() });
  let crewBusy = null;
  function crewRows() {
    return Array.from(document.querySelectorAll('crew-list grid-row, crew-grid grid-row')).filter(r => visible(r) && onTop(r) && r.querySelector('.crew-info .name') && !r.classList.contains('add'));
  }
  const crewName = (row) => norm(row.querySelector('.crew-info .name').textContent);
  // ESO lists a member's roles in an aside as "Roles: Lead - Transport, Driver - Transport"
  const crewRoles = (row) => Array.from(row.querySelectorAll('.crew-info aside')).map(a => norm(a.textContent).replace(/^Roles?\s*:\s*/i, '')).join(', ').split(',').map(x => norm(x).toUpperCase()).filter(Boolean);
  function layoutCrew() {
    const run = currentRun();
    const rows = settings.quickIncident === false || !run || run.locked || !onTab('Incident') || shelfOpen() ? [] : crewRows();
    const seen = new Set();
    for (const row of rows) {
      const name = crewName(row); if (!name) continue;
      seen.add(name);
      const have = crewRoles(row); const p = crewPending(name);
      const els = CREW_ROLES.map(([short, full, id]) => {
        const b = quickEl(`crew:${name}:${id}`, () => {
          const el = document.createElement('button'); el.type = 'button'; el.className = 'chip'; el.dataset.group = 'crew'; el.dataset.member = name; el.textContent = short; el.title = `${name}: ${full}`;
          el.addEventListener('pointerdown', (e) => e.stopPropagation());
          el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); tapCrew(name, full); });
          return el;
        });
        const on = have.includes(full.toUpperCase());
        b.classList.toggle('added', on); b.classList.toggle('on', p.on.has(full)); b.classList.toggle('off', p.off.has(full));
        b.classList.toggle('busy', quickBusy);
        b.style.display = 'block'; b.style.visibility = 'hidden';
        return b;
      });
      placeRows(row, els);
    }
    for (const [k] of quickEls) if (k.startsWith('crew:') && !seen.has(k.split(':')[1])) dropQuick(k);
  }
  function tapCrew(name, full) {
    if (quickBusy && crewBusy !== name) return;
    const row = crewRows().find(r => crewName(r) === name); if (!row) return;
    const p = crewPending(name);
    if (crewRoles(row).includes(full.toUpperCase())) { p.on.delete(full); p.off.add(full); } else { p.off.delete(full); p.on.add(full); }
    layoutCrew();
    commitCrew(name);
  }
  async function commitCrew(name) {
    const p = crewPending(name);
    if (quickBusy || !(p.on.size || p.off.size)) return;
    quickBusy = true; crewBusy = name; layoutCrew();
    try {
      while (p.on.size || p.off.size) {
        const ons = [...p.on], offs = [...p.off];
        const row = crewRows().find(r => crewName(r) === name);
        if (!row) throw new Error('the crew member was not found on the page');
        lateVeil('Setting the role…', `${name}: ${[...ons, ...offs].join(', ')}`);
        (row.querySelector('grid-cell.clickable') || row).click(); // Edit
        const edit = await until(() => Array.from(document.querySelectorAll('shelf-panel')).find(s => visible(s) && s.querySelector('eso-field[data-field-ref="PERSONNELROLEIDS"]')), 5000);
        if (!edit) throw new Error('the crew member did not open');
        const field = edit.querySelector('eso-field[data-field-ref="PERSONNELROLEIDS"]');
        openPicker(field); // Roles
        const list = await until(() => Array.from(document.querySelectorAll('shelf-panel')).find(s => visible(s) && s !== edit && !s.contains(edit) && Array.from(s.querySelectorAll('h1')).some(h => /^Roles?$/i.test(norm(h.textContent)))), 5000);
        if (!list) throw new Error('the Roles list did not open');
        const tick = async (full, want) => {
          const li = await pickRow(list, full); if (!li) return false;
          const sel = () => { const m = li.querySelector('check-mark'); return !!(m && m.classList.contains('selected')); };
          if (sel() !== want) { (li.querySelector('.label-content') || li).click(); await until(() => sel() === want, 1500); }
          return sel() === want;
        };
        for (const f of ons) { p.on.delete(f); await tick(f, true); }
        for (const f of offs) { p.off.delete(f); await tick(f, false); }
        await clearSearch(list);
        const ok1 = Array.from(list.querySelectorAll('header button')).find(b => /^OK$/i.test(norm(b.textContent)));
        if (!ok1) throw new Error('no OK on the Roles list'); ok1.click();
        await until(() => closed(list), 4000);
        const ok2 = Array.from(edit.querySelectorAll('header button')).find(b => /^OK$/i.test(norm(b.textContent)));
        if (!ok2) throw new Error('no OK on the crew member'); ok2.click();
        await until(() => closed(edit), 4000);
      }
    } catch (e) {
      endVeil(); quickBusy = false; crewBusy = null; p.on.clear(); p.off.clear(); layoutCrew();
      alert('ESO Save: could not set the role. ' + (e && e.message ? e.message : '') + ' Finish it by hand.');
      return;
    }
    endVeil(); quickBusy = false; crewBusy = null; layoutCrew();
  }
  // A full layout places everything at its true spot, so the slid sheet must be put back first
  // and the slide measured from here on; otherwise a layout in the middle of a scroll jumps.
  function rebaseLayers() {
    if (!scrollRaf) return;
    for (const s of [quickLayer, copyLayer].map(l => l && l.firstElementChild).filter(Boolean)) s.style.transform = '';
    if (scroller) scrollBase = scrollPos(scroller);
  }
  function layoutQuick() {
    try { rebaseLayers(); } catch (e) { /* keep going */ }
    try { placeRides(); } catch (e) { /* keep going */ }
    try { clipLayers(); } catch (e) { /* keep going */ }
    try { layoutCrew(); } catch (e) { /* keep going */ }
    try { watchMileage(); } catch (e) { /* keep going */ }
    try { layoutAssess(); } catch (e) { /* keep going */ }
    try { layoutDisposition(); } catch (e) { /* keep going */ }
    try { layoutSingleRows(); } catch (e) { /* keep going */ }
    try { layoutNeeds(); } catch (e) { /* keep going */ }
    try { watchModes(); } catch (e) { /* keep going */ }
    for (const gk of Object.keys(CHIP_GROUPS)) { try { layoutChips(gk); } catch (e) { /* keep going */ } }
    for (const gk of Object.keys(FACILITY_GROUPS)) { try { layoutFacilities(gk); } catch (e) { /* keep going */ } }
    try { layoutDelays(); } catch (e) { /* keep going */ }
    try { layoutAcuity(); } catch (e) { /* keep going */ }
  }

  // ---------------------------------------------------------------- copy button on saved vitals
  // Each saved vital row in the Vitals tab shows its time (HH:MM:SS). A small copy button floats
  // just left of that cell; tapping it re-enters the vital's values as a new row with the current
  // time. The buttons live in this extension's own layer, never inside ESO's page, so the cell is
  // not pushed about and the app's own rendering is untouched.
  let scroller = null, scrollBase = null, scrollUntil = 0, scrollRaf = 0;
  const scrollPos = (el) => el === document || el === document.documentElement || el === document.body ? { x: scrollX, y: scrollY } : { x: el.scrollLeft, y: el.scrollTop };
  const TIME_RE = /^\d{1,2}:\d{2}:\d{2}$/;
  const NOT_A_ROW = '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="popover" i], [class*="dropdown" i], [class*="picker" i], [class*="menu" i], [class*="overlay" i], label';
  let copyBusy = false;
  let copyLayer = null;
  let copyHiddenAt = 0; // set when a tab is tapped; the buttons stay hidden until the next tab has loaded
  const copyButtons = new Map(); // time element -> button in our layer
  function vitalTimeCells() {
    const out = [];
    if (!lastStatus || !lastStatus.lastView || lastStatus.lastView.view !== 'Vitals' || !lastStatus.currentRecordId) return out;
    for (const el of document.querySelectorAll('td, div, span, p, strong, b')) {
      if (host && host.contains(el)) continue;
      if (el.children.length > 1) continue;
      const text = (el.textContent || '').trim();
      if (!TIME_RE.test(text)) continue;
      // innermost element only: a wrapper around the real cell would give a second button
      if (el.firstElementChild && (el.firstElementChild.textContent || '').trim() === text) continue;
      if (el.closest('input, textarea, select, button, [contenteditable]')) continue;
      if (el.closest(NOT_A_ROW)) continue; // the entry form's own time field
      // a time shown next to a field control is part of a form, not a saved row
      let formy = false;
      for (let a = el.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) {
        if (a.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea')) { formy = true; break; }
      }
      if (formy) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // the cell the time sits in (a td, or the nearest wrapper that is still just this cell)
      let cell = el.closest('td');
      if (!cell) {
        cell = el;
        for (let a = el.parentElement, i = 0; a && i < 3; a = a.parentElement, i++) {
          const ar = a.getBoundingClientRect();
          if (ar.height > r.height + 28 || ar.width > Math.max(3 * r.width, 160)) break;
          cell = a;
        }
      }
      out.push({ el, text, rect: r, cell: cell.getBoundingClientRect() });
    }
    return out;
  }
  function ensureCopyLayer() {
    if (copyLayer || !shadow) return copyLayer;
    copyLayer = document.createElement('div');
    copyLayer.className = 'copylayer';
    copyLayer.innerHTML = '<div class="sheet"></div>';
    shadow.appendChild(copyLayer);
    return copyLayer;
  }
  function makeCopyButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'esosave-copy';
    btn.title = 'Copy this vital as a new entry with the current time';
    btn.textContent = '⧉';
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (copyBusy) return;
      copyBusy = true;
      showVeilMessage('Copying vital…', 'Entering the same values as a new vital with the current time.');
      toPage('action', { name: 'copyVital', recordId: lastStatus.currentRecordId, time: btn.dataset.time, nth: Number(btn.dataset.nth) });
      setTimeout(() => { if (copyBusy) { copyBusy = false; hideVeil(); } }, 20000);
    });
    return btn;
  }
  function decorateVitalRows() {
    rebaseLayers();
    try { placeRides(); } catch (e) { /* keep going */ }
    const cells = vitalTimeCells();
    if (!cells.length && !copyButtons.size) return;
    const layer = ensureCopyLayer();
    if (!layer) return;
    const keep = new Set();
    const seen = {};
    const hidden = copyHiddenAt && !(lastStatus.lastView && lastStatus.lastView.ts > copyHiddenAt) ? 'none' : '';
    layer.style.display = hidden;
    for (const r of rides.values()) r.copyLayer.style.display = hidden;
    for (const { el, text, rect, cell } of cells) {
      const time = text.padStart(8, '0');
      const nth = seen[time] = (seen[time] || 0);
      seen[time]++;
      let btn = copyButtons.get(el);
      if (!btn) { btn = makeCopyButton(); copyButtons.set(el, btn); }
      const sp = scrollParent(el); const sheet = sp ? rideFor(sp).copy : layer.firstElementChild;
      if (btn.parentNode !== sheet) sheet.appendChild(btn);
      keep.add(el);
      btn.dataset.time = time; btn.dataset.nth = String(nth);
      // hidden when something (the entry form, a menu) is drawn over the row
      const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 12), rect.top + rect.height / 2);
      const row = el.closest('tr') || (el.parentElement && el.parentElement.parentElement) || el.parentElement || el;
      const covered = hit && hit !== el && !el.contains(hit) && !row.contains(hit) && !ours(hit);
      const off = rect.bottom < 0 || rect.top > innerHeight;
      if (covered || off) { btn.style.display = 'none'; continue; }
      const w = 26, h = 22;
      // just left of the cell; if the cell hugs the screen edge, in the cell's own padding before
      // the text when that fits, otherwise just right of the cell. Never on top of the time itself.
      let left;
      if (cell.left - w - 8 >= 2) left = cell.left - w - 8;
      else {
        let textLeft = rect.left;
        try { const rg = document.createRange(); rg.selectNodeContents(el); const tr = rg.getBoundingClientRect(); if (tr.width) textLeft = tr.left; } catch (e) { /* ignore */ }
        left = textLeft - cell.left >= w + 4 ? textLeft - w - 2 : cell.right + 6;
      }
      btn.style.display = 'block';
      btn.style.left = Math.round(left) + 'px';
      btn.style.top = Math.round(rect.top + (rect.height - h) / 2) + 'px';
    }
    for (const [el, btn] of copyButtons) { if (!keep.has(el)) { btn.remove(); copyButtons.delete(el); } }
  }
  // Most picks are over in a blink; the overlay only appears if one takes longer than that.
  let lateVeilTimer = null;
  function lateVeil(title, text, after = 500) {
    clearTimeout(lateVeilTimer);
    lateVeilTimer = setTimeout(() => showVeilMessage(title, text), after);
  }
  function endVeil() { clearTimeout(lateVeilTimer); lateVeilTimer = null; hideVeil(); }
  // ---- before a lock: the paperwork question. ESO's "Lock Record" button (in its validation
  // dialog) is caught on the way down; Yes lets the same press through, No leaves the run open.
  // A press on one of ESO's buttons is caught before ESO sees it: the click on a desktop, and
  // the touch itself on an iPad, where ESO acts on touchend and never sees a click. Once approved,
  // the same button is clicked for the crew and let through.
  let tapEndAt = 0; // one gesture ends with touchend/pointerup and then a click: act on the first, not both
  function guardTap(match, onTap) {
    for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button, a') : null;
        if (!btn || ours(btn)) return;
        const m = match(btn, e); if (!m) return;
        if (m === 'through') return;
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        if (type === 'touchend' || type === 'pointerup') { tapEndAt = Date.now(); onTap(btn, m); }
        else if (type === 'click' && Date.now() - tapEndAt > 600) onTap(btn, m);
      }, { capture: true, passive: false });
    }
  }
  let lockApproved = false;
  guardTap((btn) => {
    if (!/^Lock Record$/i.test(norm(btn.textContent)) || settings.askBeforeLock === false) return null;
    if (lockApproved) { lockApproved = false; return 'through'; }
    return 'ask';
  }, (btn) => askBeforeLock(btn));
  function askBeforeLock(btn) {
    hideVeil();
    if (!shadow) return;
    veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML = `<div class="box lockask"><h2>Before you lock</h2><div class="why" style="font-size:15px;margin:10px 0 16px">Have you attached the proper paperwork for this run, or acknowledge it's not required?</div>
      <div class="actions"><button class="a" data-act="lock-yes">Yes, lock it</button><button class="a sec" data-act="lock-no">No, not yet</button></div></div>`;
    veil.querySelector('[data-act=lock-no]').addEventListener('click', () => hideVeil());
    veil.querySelector('[data-act=lock-yes]').addEventListener('click', () => { hideVeil(); lockApproved = true; btn.click(); lockApproved = false; });
    shadow.appendChild(veil);
  }
  // ---- CAD import: the Import press in ESO's "CAD Import - Select an incident" dialog is caught
  // on the way down. The chosen incident is looked up in the agency's call log; only a run whose
  // crew (by the agency's users) includes this ESO login goes through.
  let cadApproved = false;
  guardTap((btn) => {
    if (!/^Import$/i.test(norm(btn.textContent)) || settings.cadGate === false) return null;
    const dlg = btn.closest('eso-modal-dialog');
    if (!dlg || !/CAD Import/i.test(norm(dlg.textContent))) return null;
    if (cadApproved) { cadApproved = false; return 'through'; }
    const row = dlg.querySelector('grid-row.selected');
    const cells = row ? Array.from(row.querySelectorAll('grid-cell')).map(c => norm(c.textContent)) : [];
    if (!row || cells.length < 4) return null; // nothing chosen: ESO's own behaviour
    return cells[1];
  }, (btn, incident) => gateCad(btn, incident));
  const agencyGet = async (path) => {
    const r = await fetch(`${AGENCY_DB.url}/${path}`, { headers: { apikey: AGENCY_DB.key, Authorization: 'Bearer ' + AGENCY_DB.key } });
    if (!r.ok) throw new Error('table ' + r.status);
    return r.json();
  };
  const nameKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  function sameCrew(u) { // the agency's user against the ESO login "LAST, FIRST"
    const [last, first] = (user || '').split(',').map(nameKey);
    const ul = nameKey(u.last_name), uf = nameKey(u.first_name);
    return !!last && ul === last && (!first || !uf || uf === first || uf.startsWith(first) || first.startsWith(uf));
  }
  async function gateCad(btn, incident) {
    lateVeil('Checking the call log…', incident);
    let calls = null, users = [];
    try {
      calls = await agencyGet(`call_log_entries?runnumber=eq.${encodeURIComponent(incident)}&select=runnumber,callsign,crewmemberone,crewmembertwo,crewmemberthree&order=createdat.desc&limit=5`);
    } catch (e) { calls = null; } // the call log is out of reach: nothing to check against
    const call = Array.isArray(calls) ? calls.find(c => c.crewmemberone || c.crewmembertwo || c.crewmemberthree) || calls[0] : null;
    if (call) {
      const names = [call.crewmemberone, call.crewmembertwo, call.crewmemberthree].map(x => norm(x)).filter(Boolean);
      try { users = names.length ? await agencyGet(`users?username=in.(${names.map(encodeURIComponent).join(',')})&select=username,first_name,last_name`) : []; } catch (e) { users = []; }
      if (!users.some(sameCrew)) {
        endVeil();
        askBox('Not your run', 'You are not associated with this run, please choose another or inform dispatch.', [['OK', null]]);
        return;
      }
    } else if (Array.isArray(calls)) {
      endVeil();
      const go = await new Promise(res => askBox('Not in the call log', `Run ${incident} is not in the call log yet, so the crew cannot be checked. Import it anyway?`, [['Import anyway', true], ['Cancel', false]], res));
      if (!go) return;
    }
    endVeil();
    cadApproved = true; btn.click(); cadApproved = false;
  }
  // ---- paperwork: the Camera and Add Attachment presses in ESO's Attachments dialog are caught
  // on the way down and the type of paperwork asked first. The chosen label becomes ESO's
  // description for the upload (ESO's own camera or Add Attachment dialog does the rest, as it
  // always did). On an iPad carrying the ESO Save app, Camera hops to the app's document scanner
  // instead; the scanned pages come back through the app and are uploaded exactly as ESO's
  // dialog would upload them.
  const DOC_TYPES = [['Facesheet', true], ['Physician Certification', true], ['Med List', false], ['Monitor Printout', false], ['Other', false]]; // [type, only one per run]
  const docLabel = (run, type) => `${run.incidentNumber || 'run'}:${type}`;
  const NATIVE_APP = 'com.ruralmedems.esosave';
  let nativeScanner = false; // the ESO Save app is reachable and has a scanner (iPad)
  let pendingScan = null;    // { recordId, label, type, replace, at } while the app is scanning
  let scanPoll = null;
  async function nativeCall(msg) {
    try {
      if (!ON_ESO) { const r = await fetch(location.origin + '/__native', { method: 'POST', body: JSON.stringify(msg) }); return r.ok ? r.json() : null; }
      return await new Promise(res => { try { api.runtime.sendMessage({ type: 'native', app: NATIVE_APP, msg }, (r) => { void api.runtime.lastError; res(r || null); }); } catch (e) { res(null); } });
    } catch (e) { return null; }
  }
  async function probeNative() {
    const r = await nativeCall({ type: 'ping' });
    nativeScanner = !!(r && r.native && r.scanner);
  }
  probeNative();
  let attachApproved = false;
  const attachmentsDialog = (btn) => {
    const dlg = btn.closest('eso-modal-dialog'); if (!dlg) return null;
    const head = dlg.querySelector('header, h1');
    return head && /^Attachments$/i.test(norm(head.textContent)) ? dlg : null;
  };
  guardTap((btn) => {
    const mode = norm(btn.textContent);
    if (!/^(Camera|Add Attachment)$/i.test(mode) || settings.scanDocs === false || !attachmentsDialog(btn)) return null;
    const run = currentRun(); if (!run || run.locked) return null;
    if (attachApproved) { attachApproved = false; return 'through'; }
    return /^Camera$/i.test(mode) ? 'camera' : 'file';
  }, (btn, mode) => askDocType(btn, mode));
  const askChoice = (title, text, buttons) => new Promise(res => askBox(title, text, buttons, res));
  async function askDocType(btn, mode) {
    const run = currentRun(); if (!run) return;
    const type = await askChoice('What is this paperwork?', mode === 'camera' && nativeScanner ? 'The ESO Save scanner opens next; the pages attach themselves when you come back.' : 'The attachment is named after your answer.', DOC_TYPES.map(([t]) => [t, t]).concat([['Cancel', null]]));
    if (!type) return;
    const single = DOC_TYPES.find(d => d[0] === type)[1];
    const label = docLabel(run, type);
    let replace = false;
    if (single && (run.attachments || []).some(a => a.description === label)) {
      const c = await askChoice(`A ${type} is already attached`, `This run already has an attachment named ${label}. Replace it with the new one, or keep both?`, [['Replace it', 'replace'], ['Keep both', 'keep'], ['Cancel', null]]);
      if (!c) return;
      replace = c === 'replace';
    }
    if (mode === 'camera' && nativeScanner) { await startScan(run, type, label, replace, single ? 1 : 12); return; }
    toPage('action', { name: 'attachTag', recordId: run.recordId, label, type, replace });
    attachApproved = true; btn.click(); attachApproved = false;
  }
  async function startScan(run, type, label, replace, pages) {
    pendingScan = { recordId: run.recordId, label, type, replace, at: Date.now(), back: location.href };
    await sset({ pendingScan });
    // the page to come back to: the app's Attach button opens it in Safari (a fresh tab; the
    // extension in that tab then closes this one)
    const url = `esosave://scan?type=${encodeURIComponent(type)}&record=${encodeURIComponent(run.recordId)}&incident=${encodeURIComponent(run.incidentNumber || '')}&pages=${pages}&back=${encodeURIComponent(location.href)}`;
    if (ON_ESO) location.href = url; else nativeCall({ type: 'open', url });
    watchScans();
  }
  function watchScans() {
    if (scanPoll) return;
    scanPoll = setInterval(pollScans, 4000);
    pollScans();
  }
  let pollingScans = false;
  async function pollScans() {
    if (pollingScans) return;
    if (!pendingScan) { clearInterval(scanPoll); scanPoll = null; return; }
    if (Date.now() - pendingScan.at > 30 * 60 * 1000) { pendingScan = null; sset({ pendingScan: null }); clearInterval(scanPoll); scanPoll = null; return; }
    pollingScans = true;
    try {
      const r = await nativeCall({ type: 'scans' });
      const listed = r && Array.isArray(r.scans) ? r.scans : [];
      for (const item of listed) {
        if (!item || !item.id) continue;
        // claimed before it is used: two ESO tabs (the one the scan left from and the one the
        // app's Attach button opened) never attach the same pages twice
        const c = await nativeCall({ type: 'claim', id: item.id });
        const sc = c && c.scan; if (!sc) continue;
        if (!Array.isArray(sc.pages) || !sc.pages.length) { nativeCall({ type: 'consume', id: sc.id }); continue; }
        const p = pendingScan && (!sc.record || sc.record === pendingScan.recordId) ? pendingScan : null;
        const type = sc.type || (p && p.type) || 'Other';
        const run = p ? currentRun() : null;
        const recordId = sc.record || (p && p.recordId);
        if (!recordId) { nativeCall({ type: 'consume', id: sc.id }); continue; }
        const label = (p && p.label) || `${(run && run.incidentNumber) || sc.incident || 'run'}:${type}`;
        const pagesBlobs = sc.pages.map(b64 => { try { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'image/jpeg' }); } catch (e) { return null; } }).filter(Boolean);
        lateVeil('Attaching…', `${label}${pagesBlobs.length > 1 ? ` (${pagesBlobs.length} pages)` : ''}`, 0);
        toPage('action', { name: 'attachUpload', recordId, label, type, replace: !!(p && p.replace), pages: pagesBlobs, text: sc.text || null, ext: 'jpg', scanId: sc.id });
        if (p) { pendingScan = null; sset({ pendingScan: null }); }
      }
    } finally { pollingScans = false; }
    if (!pendingScan) { clearInterval(scanPoll); scanPoll = null; }
  }
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) addEventListener(ev, () => { if (pendingScan && (document.visibilityState !== 'hidden')) pollScans(); });
  (async () => {
    const st = await sget('pendingScan');
    if (!st.pendingScan || Date.now() - st.pendingScan.at > 30 * 60 * 1000) return;
    pendingScan = st.pendingScan;
    // this is the tab the app's Attach button opened: the one the scan left from goes
    if (pendingScan.back && pendingScan.back === location.href && ON_ESO) { try { api.runtime.sendMessage({ type: 'closeTwins', url: location.href }, () => { void api.runtime.lastError; }); } catch (e) { /* ignore */ } }
    watchScans();
  })();
  function onAttached(p) {
    endVeil();
    if (p.scanId) nativeCall({ type: 'consume', id: p.scanId });
    if (!p.ok) { alert(`ESO Save: could not attach ${p.label}. ${p.error || ''}`); return; }
    if (p.source === 'scan') notice(`${p.label} attached`, `${p.pages > 1 ? p.pages + ' pages are' : 'It is'} on the run. Reopen Attachments to see ${p.pages > 1 ? 'them' : 'it'}.`);
    if (p.type === 'Facesheet' && p.file) onFacesheet(p);
  }
  // ---- the facesheet: read (the app's text recognition on an iPad: a scan carries its text, an
  // uploaded picture is read on request), the labels on it mapped to ESO's fields, and the crew
  // asked before the Patient and Billing pages are written.
  async function onFacesheet(p) {
    let text = p.text || null;
    if (!text && p.file && nativeScanner) {
      lateVeil('Reading the facesheet…', p.label, 0);
      try {
        const b64 = await blobBase64(p.file);
        const r = await nativeCall({ type: 'ocr', image: b64 });
        text = r && r.text ? r.text : null;
      } catch (e) { text = null; }
      endVeil();
    }
    if (!text) { if (p.source === 'scan') notice('Facesheet attached', 'It could not be read, so the Patient and Billing pages were left alone.', 4000); return; }
    const parsed = parseFacesheet(text);
    const plan = facesheetPlan(parsed, (facilityTypes && facilityTypes.lists) || null);
    plan.text = text;
    const run = currentRun(); if (!run) return;
    if (!plan.patient.length && !plan.billing.length) { plan.lines = []; askFill(run, plan); return; }
    askFill(run, plan);
  }
  const blobBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(blob); });
  function askFill(run, plan) {
    hideVeil();
    if (!shadow) return;
    veil = document.createElement('div');
    veil.className = 'veil';
    veil.style.cursor = 'default';
    veil.innerHTML = `<div class="box askbox fillask" style="max-width:560px;text-align:left"><h2>Fill from the facesheet?</h2>
      <div class="why" style="font-size:14px;margin:8px 0 4px">These go onto the Patient page, replacing what is there for these fields:</div>
      <ul style="margin:4px 0 10px 18px;padding:0;font-size:14px;line-height:1.45">${plan.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      ${plan.lines.length ? '' : '<div class="why" style="font-size:14px;margin:0 0 10px">Nothing on it could be read into the Patient page.</div>'}
      ${plan.skipped.length ? `<div class="why" style="font-size:13px;margin:0 0 10px">Left blank: ${esc(plan.skipped.join('; '))}.</div>` : ''}
      <details style="font-size:12px;margin:0 0 10px"><summary style="cursor:pointer">Show the text that was read</summary><pre style="white-space:pre-wrap;max-height:220px;overflow:auto;background:#f1f5f9;padding:8px;border-radius:6px;margin:6px 0 0">${esc(plan.text || '')}</pre></details>
      <div class="actions">${plan.lines.length ? '<button class="a" data-act="fill-yes">Fill the Patient page</button>' : ''}<button class="a sec" data-act="fill-no">${plan.lines.length ? 'Not now' : 'Close'}</button></div></div>`;
    veil.querySelector('[data-act=fill-no]').addEventListener('click', () => hideVeil());
    const yes = veil.querySelector('[data-act=fill-yes]');
    if (yes) yes.addEventListener('click', () => {
      showVeilMessage('Filling the Patient page…', `${plan.patient.length} fields`);
      toPage('action', { name: 'fillFacesheet', recordId: run.recordId, patient: plan.patient, billing: [], places: plan.places.filter(p => p.scope === 'patient') });
    });
    shadow.appendChild(veil);
  }
  async function onFacesheetFilled(p) {
    hideVeil();
    if (!p.ok) { alert('ESO Save: could not fill from the facesheet. ' + (p.error || '')); return; }
    // the app only shows what it has loaded: step off the tab and back so it re-reads the page
    const id = lastStatus && lastStatus.currentRecordId;
    const here = ['Patient'].find(v => onTab(v));
    if (here && id) {
      const away = tabElement('INCIDENT'), back = tabElement(TAB_LABELS[here]);
      if (away && back) { away.click(); await waitViewLoaded('Incident', id, 1500).catch(() => {}); back.click(); await waitViewLoaded(here, id, 3000).catch(() => {}); }
    }
    notice('Patient page filled', `${p.patient} fields${p.held ? ', held until ESO answers' : ''}. Check them over.`, 4000);
  }
  // Facesheets come in two shapes around here: "Patient Information / Guarantor Information /
  // Primary Insurance / Secondary Insurance" blocks with "Label: value" pairs in two columns, and
  // "PATIENT / GUARANTOR / COVERAGE" blocks with the label right-aligned before its value. The
  // text arrives one recognised row per line, the cells of a row separated by " | ". Every value
  // is taken from a label; an unlabelled row right after an address is the city line, and an
  // unlabelled row naming a race is the race.
  const RACES = [[/white|caucasian/i, 'White'], [/black|african/i, 'Black or African American'], [/asian/i, 'Asian'], [/indian|alaska|native american/i, 'American Indian or Alaska Native'], [/hispanic|latino/i, 'Hispanic or Latino'], [/middle eastern|north african/i, 'Middle Eastern or North African'], [/hawaiian|pacific/i, 'Native Hawaiian or Other Pacific Islander']];
  const RELS = [[/^self|patient$/i, 'Self'], [/spouse|husband|wife/i, 'Spouse'], [/child|son|daughter|dependent/i, 'Child/Dependent'], [/parent|mother|father/i, 'Parent'], [/partner/i, 'Life/Domestic Partner'], [/employee/i, 'Employee']];
  // every label the parser reads, plus the ones it knows to leave alone (so a value is never
  // mistaken for part of the next label)
  const KNOWN = new Set(['pcp', 'primarycareprovider', 'primarycarephysician', 'primaryphysician', 'pcpname', 'familyphysician', 'primarydoctor',
    'patientname', 'name', 'patient', 'legalname', 'homeaddress', 'address', 'address1', 'streetaddress', 'street', 'patientaddress', 'mailingaddress', 'city', 'citystatezip', 'citystzip', 'citystate',
    'sex', 'birthsex', 'sexatbirth', 'legalsex', 'sexgender', 'gendersex', 'gender', 'genderidentity', 'dob', 'dobage', 'birthdateage', 'dateofbirth', 'birthdate', 'born', 'birthday', 'ssn', 'socialsecurity', 'socialsecuritynumber', 'ss', 'ssno',
    'race', 'raceethnicity', 'patientrace', 'ethnicity', 'ethnicgroup', 'ethnic', 'homephone', 'primaryphone', 'phone', 'phonenumber', 'homephonenumber', 'patientphone', 'telephone',
    'mobilephone', 'cellphone', 'cell', 'mobile', 'cellular', 'workphone', 'businessphone', 'guarantorname', 'guarantor', 'patientsreltn', 'relationtopatient', 'relationship', 'reltn',
    'relationshiptopatient', 'relationtothepatient', 'patientrelationship', 'relation', 'reltopatient', 'billingaddress', 'guarantoraddress', 'subscribername', 'subscriber', 'insuredname', 'insured',
    'policyholder', 'patreltosubscriber', 'relationtosubscriber', 'relationshiptosubscriber', 'relationtoinsured', 'relationshiptoinsured', 'insurancename', 'payor', 'payer', 'insurance', 'carrier',
    'company', 'insurancecompany', 'planname', 'payorname', 'payername',
    // read past, never used
    'altphone', 'religion', 'age', 'contactname', 'claimaddress', 'insurancetype', 'guarantorid', 'mrn', 'fin', 'encounterdate', 'hospitalaccount', 'contactserial', 'roombed', 'unit', 'patientclass',
    'hospitalservice', 'admittingprovider', 'attendingprovider', 'referringphysician', 'admdiagnosis', 'employer', 'status', 'plan', 'groupnumber', 'subscriberid', 'subscriberdob', 'policynumber',
    'insurancephone', 'authorizationnumber', 'authorizationphone', 'authorizationcontact', 'employername', 'employerphone', 'financialclass', 'regdttm', 'estdtofarrival', 'inptadmdttm', 'dischdttm',
    'observationdttm', 'vipindicator', 'admitreason', 'patienttype', 'medicalservice', 'location', 'isolation', 'diseasealert', 'admittype', 'admitsource', 'advancedirective', 'regclerk',
    'admitphysician', 'attendphysician', 'legalguardian', 'inptadmdate', 'inptadmtime', 'chartid', 'maritalstatus', 'language', 'email', 'occupation', 'accountnumber', 'visitnumber', 'nextofkin',
    'emergencycontact', 'preferredname', 'nickname', 'suffix', 'middlename', 'firstname', 'lastname']);
  function parseFacesheet(text) {
    const out = { patient: {}, guarantor: {}, primary: {}, secondary: {}, contact: {}, encounter: {}, head: {}, other: {} };
    const key = (t) => String(t || '').toLowerCase().replace(/[^a-z]/g, '');
    let section = 'head', lastAddressRow = -1, lastAddressSection = null, carry = null;
    const rows = String(text).split(/\r?\n/);
    const set = (sec, k, v) => { if (v && out[sec] && !(k in out[sec])) out[sec][k] = v; };
    const header = (k) => /^(patientinformation|patient|patientdemographics|demographics)$/.test(k) ? 'patient'
      : /^(guarantorinformation|guarantor)$/.test(k) ? 'guarantor'
      : /^(guarantoremployer|coverage|tertiaryinsurance|employer|employerinformation)$/.test(k) ? 'other'
      : /^(contactinformation|emergencycontact|emergencycontacts|nextofkin)$/.test(k) ? 'contact'
      : /^(primaryinsurance|insuranceprimary)$/.test(k) ? 'primary'
      : /^(secondaryinsurance|insurancesecondary)$/.test(k) ? 'secondary'
      : /^(encounterinformation|encounter|visitinformation|visit)$/.test(k) ? 'encounter' : null;
    // "Label: value Label2: value2" as one recognised cell (two columns read as one line), or a
    // label with its value in the next cell, or in the next row: every "Label:" starts a pair.
    // The label is the longest run of words before the colon that is one this parser knows
    // (so "ROE, LOUISE M DOB:" splits at "DOB"); an unknown label is the one word before it.
    const LABEL_WORD = /^[A-Za-z][A-Za-z.'\/()-]*$/;
    const labelsIn = (cell) => {
      const found = [];
      for (let i = cell.indexOf(':'); i !== -1; i = cell.indexOf(':', i + 1)) {
        if (cell[i + 1] && !/\s/.test(cell[i + 1])) continue; // 17:17, not a label
        const words = [];
        let j = i;
        while (words.length < 4) {
          let e = j; while (e > 0 && cell[e - 1] === ' ') e--;
          let b = e; while (b > 0 && cell[b - 1] !== ' ') b--;
          if (e === b) break;
          const w = cell.slice(b, e);
          if (!LABEL_WORD.test(w)) break;
          words.unshift({ w, b });
          j = b;
          if (b === 0) break;
        }
        if (!words.length) continue;
        let pick = words[words.length - 1];
        for (let n = words.length; n >= 1; n--) { const cand = words.slice(words.length - n); if (KNOWN.has(key(cand.map(x => x.w).join('')))) { pick = cand[0]; break; } }
        found.push({ label: key(cell.slice(pick.b, i)), start: pick.b, end: i + 1 });
      }
      return found;
    };
    const unlabelled = (sec, cell, r) => {
      const city = cityLine(cell);
      if (city && lastAddressSection === sec && r - lastAddressRow <= 2) { take(sec, 'city', cell, r); return; }
      if (sec !== 'patient' && sec !== 'head') return;
      if (RACES.some(([re]) => re.test(cell)) && cell.length < 45) set('patient', 'race', cell);
      // the label went missing: a date with an age after it can only be the birth date; a bare
      // Female / Male the sex
      if (/^\d{1,2}\/\d{1,2}\/\d{4}\s*\(?\s*\d{1,3}\s*(yrs?|years?|y\.?o\.?)\b/i.test(cell)) set('patient', 'dobLoose', cell);
      if (/^(female|male|f|m)$/i.test(cell.trim())) set('patient', 'sexLoose', cell.trim());
    };
    rows.forEach((row, r) => {
      const cells = row.split(/\s\|\s|\t/).map(c => c.trim()).filter(Boolean);
      let pending = null;
      cells.forEach((cell, ci) => {
        const k = key(cell);
        if (!/:/.test(cell)) { const h = header(k); if (h) { section = h; carry = null; pending = null; return; } }
        const pairs = labelsIn(cell);
        pairs.forEach((p, i) => { p.value = cell.slice(p.end, i + 1 < pairs.length ? pairs[i + 1].start : undefined).trim(); });
        const lead = pairs.length ? cell.slice(0, pairs[0].start).trim() : cell;
        if (lead) {
          const p = pending || (ci === 0 ? carry : null);
          if (p) { take(section, p, lead, r); pending = null; carry = null; }
          else unlabelled(section, lead, r);
        }
        pending = null;
        for (const p of pairs) { if (!p.label) continue; if (p.value) take(section, p.label, p.value, r); else pending = p.label; }
      });
      carry = pending; // a label at the end of a row may find its value at the start of the next
    });
    function take(sec, label, value, r) {
      const is = (...names) => names.includes(label);
      if (is('pcp', 'primarycareprovider', 'primarycarephysician', 'primaryphysician', 'pcpname', 'familyphysician', 'primarydoctor')) { set('patient', 'pcp', value); return; }
      if (sec === 'patient' || sec === 'head') {
        if (is('patientname', 'name', 'patient', 'legalname')) set('patient', 'name', value);
        else if (is('lastname')) set('patient', 'last', value);
        else if (is('firstname')) set('patient', 'first', value);
        else if (is('middlename')) set('patient', 'middle', value);
        else if (is('homeaddress', 'address', 'address1', 'streetaddress', 'street', 'patientaddress', 'mailingaddress')) { set('patient', 'address', value); lastAddressRow = r; lastAddressSection = sec; }
        else if (is('city', 'citystatezip', 'citystzip', 'citystate')) set('patient', 'city', value);
        else if (is('sex', 'birthsex', 'sexatbirth', 'legalsex', 'sexgender', 'gendersex')) { const w = value.split(/\s+/); set('patient', 'sex', w[0]); if (w.length > 1) unlabelled(sec, w.slice(1).join(' '), r); }
        else if (is('gender', 'genderidentity')) set('patient', 'gender', value);
        else if (is('dob', 'dateofbirth', 'birthdate', 'born', 'birthday', 'dobage', 'birthdateage')) set('patient', 'dob', value);
        else if (is('ssn', 'socialsecurity', 'socialsecuritynumber', 'ss', 'ssno')) set('patient', 'ssn', value);
        else if (is('race', 'raceethnicity', 'patientrace')) set('patient', 'race', value);
        else if (is('ethnicity', 'ethnicgroup', 'ethnic')) set('patient', 'ethnicity', value);
        else if (is('homephone', 'primaryphone', 'phone', 'phonenumber', 'homephonenumber', 'patientphone', 'telephone')) set('patient', 'phoneHome', value);
        else if (is('mobilephone', 'cellphone', 'cell', 'mobile', 'cellular')) set('patient', 'phoneMobile', value);
        else if (is('workphone', 'businessphone')) set('patient', 'phoneWork', value);
      } else if (sec === 'guarantor') {
        if (is('guarantorname', 'guarantor', 'name')) set('guarantor', 'name', value);
        else if (is('patientsreltn', 'relationtopatient', 'relationship', 'reltn', 'relationshiptopatient', 'relationtothepatient', 'patientrelationship', 'relation', 'reltopatient')) set('guarantor', 'rel', value);
        else if (is('billingaddress', 'address', 'homeaddress', 'address1', 'guarantoraddress')) { set('guarantor', 'address', value); lastAddressRow = r; lastAddressSection = sec; }
        else if (is('city', 'citystatezip', 'citystate')) set('guarantor', 'city', value);
        else if (is('dob', 'dateofbirth', 'birthdate', 'birthday')) set('guarantor', 'dob', value);
        else if (is('ssn', 'socialsecurity', 'socialsecuritynumber')) set('guarantor', 'ssn', value);
      } else if (sec === 'primary' || sec === 'secondary') {
        if (is('subscribername', 'subscriber', 'insuredname', 'insured', 'policyholder')) set(sec, 'subscriber', value);
        else if (is('patientsreltn', 'patreltosubscriber', 'relationship', 'relationtosubscriber', 'reltn', 'relationshiptosubscriber', 'patientrelationship', 'relationtoinsured', 'relationshiptoinsured')) set(sec, 'rel', value);
        else if (is('insurancename', 'payor', 'payer', 'insurance', 'carrier', 'company', 'insurancecompany', 'planname', 'payorname', 'payername')) set(sec, 'company', value);
      }
    }
    return out;
  }
  function cityLine(t) {
    const m = /^([A-Za-z .'-]{2,}?),?\s+([A-Za-z]{2})\.?\s+(\d{5})(?:\s*-?\s*(\d{1,4}))?\s*$/.exec(String(t || '').trim());
    return m ? { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] } : null;
  }
  const splitName = (t) => {
    const clean = String(t || '').replace(/[*"]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    let last, rest;
    if (clean.includes(',')) { [last, rest] = clean.split(',').map(x => x.trim()); }
    else { const w = clean.split(' '); last = w.pop(); rest = w.join(' '); }
    const parts = (rest || '').split(' ').filter(Boolean);
    return { last, first: parts.shift() || '', middle: parts.join(' ') };
  };
  const dateOf = (t) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(t || '')); return m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}` : null; };
  const phoneOf = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
  const fmtPhone = (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  // What goes where: the ops for the Patient page and the Billing page, the place lookups, a line
  // per item for the question, and what was left blank and why.
  // ESO's own lists (the system ones are the same for every agency; the bundle's copy wins when seen)
  const ESO_LISTS = {
    states: [['AL', 247], ['AK', 248], ['AZ', 249], ['AR', 250], ['CA', 251], ['CO', 252], ['CT', 253], ['DE', 254], ['FL', 256], ['GA', 257], ['HI', 258], ['ID', 259], ['IL', 260], ['IN', 261], ['IA', 262], ['KS', 263], ['KY', 264], ['LA', 265], ['ME', 266], ['MD', 267], ['MA', 268], ['MI', 269], ['MN', 270], ['MS', 271], ['MO', 272], ['MT', 273], ['NE', 274], ['NV', 275], ['NH', 276], ['NJ', 277], ['NM', 278], ['NY', 279], ['NC', 280], ['ND', 281], ['OH', 282], ['OK', 283], ['OR', 284], ['PA', 285], ['RI', 286], ['SC', 287], ['SD', 288], ['TN', 289], ['TX', 290], ['UT', 291], ['VT', 292], ['VA', 293], ['WA', 294], ['WV', 295], ['WI', 296], ['WY', 297]].map(([abbr, id]) => ({ id, abbr, name: abbr })),
    phoneTypes: [{ id: 12830, name: 'Home' }, { id: 12831, name: 'Home Mobile' }, { id: 12827, name: 'Work' }, { id: 12828, name: 'Work Mobile' }, { id: 12833, name: 'Daytime' }, { id: 12834, name: 'Evening' }],
    sex: [{ id: 15359, name: 'Female' }, { id: 15360, name: 'Male' }, { id: 15361, name: 'Unknown' }],
    gender: [{ id: 314, name: 'Female' }, { id: 313, name: 'Male' }, { id: 14760, name: 'Female-to-Male, Transgender Male' }, { id: 14761, name: 'Male-to-Female, Transgender Female' }, { id: 14762, name: 'Other, neither exclusively male or female' }, { id: 10316, name: 'Unknown (Unable to Determine)' }],
    race: [{ id: 315, name: 'American Indian or Alaska Native' }, { id: 316, name: 'Asian' }, { id: 317, name: 'Black or African American' }, { id: 10317, name: 'Hispanic or Latino' }, { id: 1338789, name: 'Middle Eastern or North African' }, { id: 318, name: 'Native Hawaiian or Other Pacific Islander' }, { id: 319, name: 'White' }],
    ethnicity: [{ id: 321, name: 'Hispanic or Latino' }, { id: 322, name: 'Not Hispanic or Latino' }],
    relationship: [{ id: 5780, name: 'Self' }, { id: 5781, name: 'Spouse' }, { id: 5782, name: 'Child/Dependent' }, { id: 5783, name: 'Parent' }, { id: 11792, name: 'Life/Domestic Partner' }, { id: 11791, name: 'Employee' }, { id: 5784, name: 'Other Relationship' }],
  };
  // What goes where: the ops for the Patient page and the Billing page (the insured: the patient
  // again, or the guarantor named on the sheet; never the insurance itself, that is the billing
  // office's), the place lookups, a line per item for the question, and what was left blank and why.
  function facesheetPlan(f, lists) {
    const L = {}; for (const k of Object.keys(ESO_LISTS)) L[k] = (lists && Array.isArray(lists[k]) && lists[k].length) ? lists[k] : ESO_LISTS[k];
    const byName = (list, re) => { const x = (list || []).find(i => re.test(i.name || '')); return x ? x.id : null; };
    const exact = (list, name) => byName(list, new RegExp('^' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
    const patient = [], billing = [], places = [], lines = [], skipped = [];
    const ed = (arr, address, fieldRef, value, dataType) => { if (value !== null && value !== undefined && value !== '') arr.push({ verb: 'EDIT', address, fieldRef, value, dataType: dataType || 'string' }); };
    const phoneOps = (arr, base, refs, typeId, number) => {
      const k = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      arr.push({ verb: 'ADD', address: `${base}.items.['${k}']`, fieldRef: refs[0], value: {}, dataType: 'collection', isComplexType: true });
      if (typeId) arr.push({ verb: 'EDIT', address: `${base}.items.['${k}'].phoneTypeId`, fieldRef: refs[1], value: typeId, dataType: 'singleselect' });
      arr.push({ verb: 'EDIT', address: `${base}.items.['${k}'].phoneNumber`, fieldRef: refs[2], value: number, dataType: 'phone' });
    };
    const P = f.patient, G = f.guarantor;
    // ---- Patient page
    const name = splitName(P.name) || (P.last ? { last: P.last.trim(), first: (P.first || '').trim(), middle: (P.middle || '').trim() } : null);
    if (name && name.last) {
      ed(patient, 'patient.demographics.lastName', 'PATIENTLASTNAME', name.last); ed(patient, 'patient.demographics.firstName', 'PATIENTFIRSTNAME', name.first); ed(patient, 'patient.demographics.middleName', 'PATIENTMIDDLENAME', name.middle);
      lines.push(`Name: ${name.last}, ${name.first}${name.middle ? ' ' + name.middle : ''}`);
    }
    const sexOf = (t) => /^f/i.test(t || '') ? 'Female' : /^m/i.test(t || '') ? 'Male' : null;
    const sex = sexOf(P.sex) || sexOf(P.gender) || sexOf(P.sexLoose);
    if (sex) { ed(patient, 'patient.demographics.sexId', 'PATIENTSEXID', exact(L.sex, sex), 'singleselect'); lines.push(`Sex: ${sex}`); }
    // gender: the sex, unless the sheet names a gender of its own
    const gender = P.gender ? (exact(L.gender, P.gender) ? P.gender : sexOf(P.gender)) : sex;
    if (gender) { const gid = exact(L.gender, gender); if (gid) ed(patient, 'patient.demographics.genderId', 'PATIENTGENDERID', gid, 'singleselect'); if (gid && gender !== sex) lines.push(`Gender: ${gender}`); }
    else if (P.gender) skipped.push(`gender "${P.gender}" (not one of ESO's)`);
    const dob = dateOf(P.dob) || dateOf(P.dobLoose);
    if (dob) { ed(patient, 'patient.demographics.dob', 'PATIENTDOB', dob + ' 00:00:00', 'date'); lines.push(`DOB: ${dob}`); }
    if (P.ssn) { const d = P.ssn.replace(/\D/g, ''); if (/x|\*/i.test(P.ssn) || d.length !== 9) skipped.push('SSN (masked on the facesheet)'); else { ed(patient, 'patient.demographics.ssn', 'PATIENTSSN', d, 'ssn'); lines.push('SSN: ***-**-' + d.slice(-4)); } }
    if (P.race) {
      const hit = RACES.find(([re]) => re.test(P.race));
      const rid = hit ? exact(L.race, hit[1]) : null;
      if (rid) { patient.push({ verb: 'ADD', address: `patient.demographics.raceIds.['${rid}']`, fieldRef: 'PATIENTRACEIDS', value: rid, dataType: 'multiselect' }); lines.push(`Race: ${hit[1]}`); }
      else skipped.push(`race "${P.race}" (not one of ESO's)`);
    }
    if (P.ethnicity) {
      const eth = /hispanic|latino/i.test(P.ethnicity) ? (/\b(not|non)\b/i.test(P.ethnicity) ? 'Not Hispanic or Latino' : 'Hispanic or Latino') : null;
      const eid = eth ? exact(L.ethnicity, eth) : null;
      if (eid) { ed(patient, 'patient.demographics.ethnicityId', 'PATIENTETHNICITYID', eid, 'singleselect'); lines.push(`Ethnicity: ${eth}`); }
      else if (!/unknown|declined|refused|unable/i.test(P.ethnicity)) skipped.push(`ethnicity "${P.ethnicity}" (not one of ESO's)`);
    }
    const addr = (src) => { const c = src.city ? cityLine(src.city) : null; const st = c ? (L.states || []).find(s => s.abbr === c.state) : null; return { line1: src.address || null, city: c ? c.city : null, stateId: st ? st.id : null, state: c ? c.state : null, zip: c ? c.zip : null }; };
    const pa = addr(P);
    if (pa.line1 || pa.city) {
      ed(patient, 'patient.contact.address.address1', 'PATIENTADDRESS1', pa.line1); ed(patient, 'patient.contact.address.city', 'PATIENTCITY', pa.city);
      if (pa.stateId) ed(patient, 'patient.contact.address.stateId', 'PATIENTSTATE', pa.stateId, 'singleselect'); else if (pa.state) skipped.push(`state ${pa.state} (not in ESO's list)`);
      ed(patient, 'patient.contact.address.zip', 'PATIENTZIP', pa.zip);
      if (pa.city && pa.stateId && pa.zip) places.push({ scope: 'patient', city: pa.city, stateId: pa.stateId, zip: pa.zip });
      lines.push(`Address: ${[pa.line1, pa.city, pa.state, pa.zip].filter(Boolean).join(', ')}`);
    }
    const ptype = (re) => byName(L.phoneTypes, re);
    for (const [k, re, what] of [['phoneHome', /^home$/i, 'Home'], ['phoneMobile', /^home mobile$/i, 'Mobile'], ['phoneWork', /^work$/i, 'Work']]) {
      const n = phoneOf(P[k]); if (!n) continue;
      phoneOps(patient, 'patient.contact.patientPhoneNumbers', ['PATIENTPHONENUMBERS', 'PATIENTPHONETYPEID', 'PATIENTPHONENUMBER'], ptype(re), n);
      lines.push(`${what} phone: ${fmtPhone(n)}`);
    }
    if (f.primary.company || f.secondary.company || G.name) skipped.push('insurance and the insured (the billing office\'s)');
    return { patient, billing, places, lines, skipped };
  }
  // a short notice in our overlay that goes by itself
  function notice(title, text, ms = 3000) {
    showVeilMessage(title, text);
    if (veil) { const sp = veil.querySelector('.spin'); if (sp) sp.remove(); veil.style.cursor = 'default'; veil.addEventListener('click', hideVeil); }
    const mine = veil;
    setTimeout(() => { if (veil === mine) hideVeil(); }, ms);
  }
  // ================================================================ Templates
  // A crew member's own fill-ins: any of ESO's fields (from the bundle's catalog) with a value,
  // plus items to add (a vital, a treatment, an assessment, a history entry...). Kept in the
  // agency's table under the person's ESO id, private, shared with everyone, or with named
  // people. Filling writes the run the way ESO's app writes, one tab at a time, with a progress
  // bar, and works with no signal (held like any save).
  let catalog = null;
  let tpls = { mine: [], shared: [], everyone: [], at: 0 };
  let tplWin = null, tplView = 'list', ed = null;
  const TPL_URL = AGENCY_DB.url + '/esosave_templates', SHARE_URL = AGENCY_DB.url + '/esosave_template_shares';
  const TPL_PAGES = [['incident', 'Incident'], ['patient', 'Patient'], ['vitals', 'Vitals'], ['flowchartTreatments', 'Flowchart'], ['assessments', 'Assessments'], ['narrative', 'Narrative'], ['forms', 'Forms'], ['billing', 'Billing'], ['signatures', 'Signatures']];
  const ITEM_NAMES = { vital: 'Vital signs', treatment: 'Treatments', assessment: 'Assessments', history: 'Patient history', allergy: 'Allergies', medication: 'Home medications', belonging: 'Belongings', sign: 'Signs and symptoms', protocol: 'Protocols used', immunization: 'Immunizations' };
  const ITEM_ONE = { vital: 'a vital', treatment: 'a treatment', assessment: 'an assessment', history: 'a history entry', allergy: 'an allergy', medication: 'a medication', belonging: 'a belonging', sign: 'a sign or symptom', protocol: 'a protocol', immunization: 'an immunization' };
  const ITEM_KEY = { treatment: 'flowchartTreatmentRegistryId', history: 'itemId', allergy: 'itemId', medication: 'itemId', belonging: 'itemId', sign: 'signId', protocol: 'protocolsUsedId', immunization: 'immunizationTypeId' };
  const SHORT_NAMES = { cpr: 'CPR', acs: 'ACS', mvc: 'MVC', css: 'CSS', lapss: 'LAPSS', mend: 'MEND', ob: 'OB', ebola: 'Ebola', ppe: 'PPE', emd: 'EMD', cad: 'CAD' };
  const humanize = (seg) => SHORT_NAMES[String(seg || '').toLowerCase()] || String(seg || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').replace(/^./, c => c.toUpperCase()).replace(/\bId\b/g, '').trim();
  const tplHeaders = (extra) => ({ apikey: AGENCY_DB.key, Authorization: 'Bearer ' + AGENCY_DB.key, 'Content-Type': 'application/json', ...(extra || {}) });
  async function tplReq(url, opts) {
    const r = await fetch(url, { ...opts, headers: tplHeaders(opts && opts.headers) });
    if (!r.ok) throw new Error('table ' + r.status);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
  // ---- the table
  async function tplLoad() {
    if (!userId) return;
    const shares = await tplReq(`${SHARE_URL}?person_id=eq.${encodeURIComponent(userId)}&select=template_id`);
    const ids = (shares || []).map(x => x.template_id);
    const or = [`owner_id.eq.${userId}`, 'share.eq.everyone'].concat(ids.length ? [`id.in.(${ids.join(',')})`] : []);
    const rows = await tplReq(`${TPL_URL}?or=(${or.join(',')})&select=id,owner_id,owner_name,name,body,share,updated_at&order=name.asc`);
    const mine = [], shared = [], everyone = [];
    for (const r of rows || []) { if (r.owner_id === userId) mine.push(r); else if (r.share === 'everyone') everyone.push(r); else shared.push(r); }
    tpls = { mine, shared, everyone, at: Date.now(), who: userId };
    await sset({ tpls });
  }
  async function tplSave(t) {
    const row = { owner_id: userId, owner_name: user, name: t.name, body: t.body, share: t.share, updated_at: new Date().toISOString() };
    if (t.id) row.id = t.id;
    const out = await tplReq(TPL_URL, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) });
    const saved = Array.isArray(out) ? out[0] : out;
    const id = (saved && saved.id) || t.id;
    if (id) {
      await tplReq(`${SHARE_URL}?template_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      if (t.share === 'some' && t.people.length) await tplReq(SHARE_URL, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(t.people.map(p => ({ template_id: id, person_id: p.id, person_name: p.name }))) });
    }
    return id;
  }
  async function tplNameTaken(name, share, ownId) {
    const filt = share === 'private' ? `owner_id=eq.${encodeURIComponent(userId)}&share=eq.private` : `share=eq.${encodeURIComponent(share)}`;
    const rows = await tplReq(`${TPL_URL}?${filt}&name=ilike.${encodeURIComponent(name.replace(/[%_\\]/g, '\\$&'))}&select=id,name,owner_id,owner_name`);
    return (rows || []).find(r => r.id !== ownId) || null;
  }
  async function tplPeople(id) { return (await tplReq(`${SHARE_URL}?template_id=eq.${encodeURIComponent(id)}&select=person_id,person_name`)) || []; }
  async function tplDelete(id) { await tplReq(`${TPL_URL}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); }
  // ---- the window
  function openTemplates() {
    if (!shadow) return;
    if (!tplWin) { tplWin = document.createElement('div'); tplWin.className = 'tplwin'; shadow.appendChild(tplWin); }
    tplView = 'list'; ed = null;
    renderTemplates();
    if (!catalog) toPage('action', { name: 'catalog' });
    tplLoad().then(() => { if (tplWin && tplView === 'list') renderTemplates(); }).catch(() => { if (tplWin && tplView === 'list') renderTemplates('No signal: showing the templates last seen.'); });
  }
  function closeTemplates() { if (tplWin) { tplWin.remove(); tplWin = null; } ed = null; }
  function renderTemplates(note) {
    if (!tplWin) return;
    if (tplView === 'edit') return renderEditor();
    tplWin._page = null;
    if (tpls.who && userId && tpls.who !== userId) { tpls = { mine: [], shared: [], everyone: [], at: 0, who: userId }; note = note || 'No signal: the templates seen on this tablet were another login\'s.'; }
    const run = currentRun();
    const canFill = !!run && !run.locked;
    const held = (t) => { const nf = Object.keys((t.body && t.body.fields) || {}).length, its = (t.body && t.body.items) || []; const kinds = {}; for (const it of its) kinds[it.kind] = (kinds[it.kind] || 0) + 1; return [`${nf} field${nf === 1 ? '' : 's'}`].concat(Object.entries(kinds).map(([k, n]) => `${n} ${n === 1 ? (ITEM_ONE[k] || k).replace(/^(a|an) /, '') : (ITEM_NAMES[k] || k).toLowerCase()}`)).join(' · '); };
    const row = (t, kind) => `<div class="tpl" data-id="${esc(t.id)}"><div><div class="tn">${esc(t.name)}</div><div class="by">${kind !== 'mine' ? `shared by ${esc(t.owner_name || '')}` : (t.share === 'everyone' ? 'yours, shared with everyone' : t.share === 'some' ? 'yours, shared with some people' : 'yours, private')} · ${esc(held(t))}</div></div>
      <button class="tb pri" data-act="fill" ${canFill ? '' : 'disabled title="Open an unlocked run first"'}>Fill this run</button>
      ${kind === 'mine' ? '<button class="tb sec" data-act="edit">Edit</button><button class="tb sec" data-act="copy" title="A new template of your own, starting from this one">Copy</button><button class="tb danger" data-act="delete">Delete</button>' : '<button class="tb sec" data-act="copy" title="A new template of your own, starting from this one">Copy to mine</button>'}</div>`;
    // a copy's name: "(copy)", then "(copy 2)", "(copy 3)"... among the person's own
    const copyName = (name) => { const base = name.replace(/ \(copy( \d+)?\)$/, ''); const taken = new Set(tpls.mine.map(x => x.name.toLowerCase())); let n = 1, cand = `${base} (copy)`; while (taken.has(cand.toLowerCase())) { n++; cand = `${base} (copy ${n})`; } return cand; };
    tplWin.innerHTML = `<div class="tophead"><h1>Templates</h1><button class="tb" data-act="new">New template</button><button class="tb sec" data-act="close">Close</button></div>
      <div class="body">
        ${note ? `<div class="muted">${esc(note)}</div>` : ''}
        ${canFill ? '' : `<div class="muted">Open a run in ESO to fill one; templates can be made at any time.</div>`}
        <h2>My templates</h2>${tpls.mine.length ? tpls.mine.map(t => row(t, 'mine')).join('') : '<div class="muted">None yet. New template makes one.</div>'}
        <h2>Templates others shared with you</h2>${tpls.shared.length ? tpls.shared.map(t => row(t, 'shared')).join('') : '<div class="muted">None.</div>'}
        <h2>Templates others shared to everyone</h2>${tpls.everyone.length ? tpls.everyone.map(t => row(t, 'everyone')).join('') : '<div class="muted">None.</div>'}
      </div>`;
    tplWin.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async (e) => {
      const act = b.dataset.act; const id = b.closest('.tpl') && b.closest('.tpl').dataset.id;
      const all = [...tpls.mine, ...tpls.shared, ...tpls.everyone]; const t = all.find(x => x.id === id);
      if (act === 'close') closeTemplates();
      else if (act === 'new') startEditor(null);
      else if (act === 'edit' && t) startEditor(t);
      // any template, one's own or another's, copied becomes a new private one of one's own, to change and share
      else if (act === 'copy' && t) startEditor({ ...t, id: null, name: copyName(t.name), share: 'private', owner_id: userId, owner_name: user });
      else if (act === 'delete' && t) { if (!confirm(`Delete the template "${t.name}"? People it was shared with lose it too.`)) return; try { await tplDelete(t.id); await tplLoad(); } catch (err) { alert('ESO Save: could not delete it. ' + err.message); } renderTemplates(); }
      else if (act === 'fill' && t) fillWithTemplate(t);
    }));
  }
  // ---- the editor
  async function startEditor(t) {
    if (!catalog) { toPage('action', { name: 'catalog' }); alert("ESO Save: ESO's field list has not been seen yet on this device. Open any run once, then try again."); return; }
    if (t && t.body) t = { ...t, body: onlyOffered(t.body) };
    ed = { id: t ? t.id : null, name: t ? t.name : '', share: t ? t.share || 'private' : 'private', people: [], page: 'incident', q: '', fields: {}, items: [] };
    if (t && t.body) { ed.fields = JSON.parse(JSON.stringify(t.body.fields || {})); ed.items = JSON.parse(JSON.stringify(t.body.items || [])); }
    if (t && t.id && t.share === 'some') { try { ed.people = (await tplPeople(t.id)).map(p => ({ id: p.person_id, name: p.person_name })); } catch (e) { /* offline */ } }
    tplView = 'edit'; renderEditor();
  }
  const NONE_RE = /^(none|none noted|none reported|none\/no delay|no delay|not applicable|n\/a|nothing)$/i;
  const noneOf = (ref) => listOf(ref).find(e => NONE_RE.test(String(e.n).trim())) || null;
  // ---- locks: the agency owner can lock any field, any item (vitals as a whole), any part of one
  // (blood pressure); the crew sees the lock and cannot set it, and a fill leaves it out. A key is
  // a field's address, an item root, or root.part; a lock covers everything under it.
  const tplLocks = () => Array.isArray(settings.tplLocks) ? settings.tplLocks : [];
  const tplLocked = (key) => tplLocks().some(k => key === k || key.startsWith(k + '.'));
  let lockMode = false;
  async function toggleLock(key) {
    if (!isAdmin()) return;
    const cur = tplLocks();
    settings.tplLocks = cur.includes(key) ? cur.filter(k => k !== key) : cur.concat([key]);
    await sset({ settings }); await pushAgency();
    renderEditor();
  }
  const lockBtn = (key, extra) => lockMode && isAdmin() ? `<button type="button" class="tb sec" data-lock="${esc(key)}" title="${tplLocked(key) ? 'Locked: the crew cannot set this' : 'Open: lock it'}" style="padding:6px 10px;min-height:36px;${extra || ''}">${tplLocks().includes(key) ? '🔒 Locked' : tplLocked(key) ? '🔒 (in a locked group)' : '🔓 Lock'}</button>` : '';
  const lockNote = () => `<span class="muted" style="font-weight:600">🔒 Locked by the agency</span>`;
  // Fields ESO shows only once something else is picked (the mutual aid agency once the run type is
  // mutual aid, the injury fields once there is an injury, the transport fields once the patient
  // is transported...). Kept out of sight, and out of a fill, until their trigger is set the
  // same way in the template.
  const SHOW_WHEN = [
    { when: 'incident.response.runTypeId', test: /mutual aid/i, show: /^incident\.response\.mutualAidID$/, why: 'the run type is Mutual Aid' },
    { when: 'incident.response.priorityId', test: null, show: /^incident\.response\.responseMode/, why: 'a Response Mode to Scene is chosen' },
    { when: 'incident.disposition.transportDispositionItemID', test: /transport by/i, show: /^incident\.disposition\.(transportMode|transportMethodID|transportDueToItemIDs|divertedFrom|levelOfServiceId|transferredTo)/, why: 'the Transport Disposition is a transport' },
    { when: 'incident.disposition.patientEvaluationCareDispositionItemID', test: /refus/i, show: /^incident\.disposition\.refusalReleaseItemIDs$/, why: 'the Patient Evaluation/Care Disposition is a refusal' },
    { when: 'narrative.injuries.injuredId', test: /^(yes|unknown)/i, show: /^narrative\.injuries\.(?!injuredId$)/, why: 'Possible Patient Injury is Yes or Unknown' },
  ];
  const ruleFor = (a) => SHOW_WHEN.find(r => r.show.test(a));
  const ruleMet = (r, fields) => { const f = fields[r.when]; if (!f) return false; if (!r.test) return true; const names = (Array.isArray(f.v) ? f.v : [f.v]).map(v => nameOf(f.l, v)); return names.some(n => r.test.test(n)); };
  const fieldShown = (a, fields) => { const r = ruleFor(a); return !r || ruleMet(r, fields); };
  // the crew's blanks: {incident}, {unit}, {date}, {time} filled in on the run
  function fillBlanks(text, run) {
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
    const unit = (() => { try { return norm(fieldValue('UNITID') || ''); } catch (e) { return ''; } })();
    return String(text).replace(/\{incident\}/gi, run.incidentNumber || '').replace(/\{unit\}/gi, unit).replace(/\{date\}/gi, `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`).replace(/\{time\}/gi, `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  }
  // what a fill leaves out: locked fields, items and parts, and fields whose trigger is not set
  // the Unable to obtain that stands in for a list: with it set, ESO refuses entries on that list, so a fill leaves them out
  const ITEM_PN = { 'patient.patientMedicalHistories': 'patient.patientHistoriesPertinentNegativeId', 'patient.patientAllergies': 'patient.patientAllergiesPertinentNegativeId', 'patient.patientMedications': 'patient.patientMedicationsPertinentNegativeId', 'patient.patientImmunizations.items': 'patient.patientImmunizations.pertinentNegativeId' };
  const utoSet = (fields, root) => { const a = ITEM_PN[root]; const f = a && fields && fields[a]; return !!(f && f.v !== null && f.v !== undefined && f.v !== ''); };
  // a saved template may carry a field the catalog no longer offers (one ESO turned out to set itself); it is dropped quietly
  function onlyOffered(body) {
    const fields = {}; const known = new Set((catalog && catalog.fields || []).map(f => f.a));
    for (const [a, f] of Object.entries(body.fields || {})) if (known.has(a)) fields[a] = f;
    return { ...body, fields };
  }
  function applyLocks(body) {
    const out = { v: body.v || 1, fields: {}, items: [] }; let dropped = 0;
    for (const [a, f] of Object.entries(body.fields || {})) { if (tplLocked(a)) dropped++; else if (!fieldShown(a, body.fields || {})) continue; else out.fields[a] = f; }
    for (const it of (body.items || [])) {
      if (tplLocked(it.root)) { dropped++; continue; }
      if (utoSet(body.fields, it.root)) continue; // the Unable to obtain stands in for the list
      const copy = { ...it, fields: {} };
      for (const [rel, f] of Object.entries(it.fields || {})) { if (tplLocked(it.root + '.' + rel)) dropped++; else copy.fields[rel] = f; }
      if (it.kind === 'assessment') {
        if (tplLocked(it.root + '.findings')) { copy.findings = []; dropped++; }
        else { const before = (it.findings || []).length; copy.findings = (it.findings || []).filter(f => { const c = axCatOf(f.loc); return !(c && tplLocked(`${it.root}.findings.${c.id}`)); }); if (copy.findings.length < before) dropped++; }
      }
      out.items.push(copy);
    }
    return { body: out, dropped };
  }
  // the list, with its None entry (if it has one) first
  const listOf = (ref) => { const l = (catalog && catalog.lists && catalog.lists[ref]) || []; const i = l.findIndex(e => NONE_RE.test(String(e.n).trim())); return i > 0 ? [l[i]].concat(l.slice(0, i), l.slice(i + 1)) : l; };
  const nameOf = (ref, id) => { const x = listOf(ref).find(e => String(e.id) === String(id)); return x ? x.n : String(id); };
  function fieldsOfPage(page) { return (catalog.fields || []).filter(f => f.a.split('.')[0] === page); }
  function sectionsOf(page) {
    const out = new Map();
    for (const f of fieldsOfPage(page)) {
      if (f.i) continue;
      const segs = f.a.split('.');
      const key = page === 'forms' && segs.length > 3 ? segs.slice(1, 3).join('.') : segs[1];
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(f);
    }
    return out;
  }
  function itemRootsOf(page) { return Object.entries(catalog.items || {}).filter(([root]) => root.split('.')[0] === page); }
  const memberFields = (root) => (catalog.fields || []).filter(f => f.i === root).map(f => ({ ...f, rel: f.a.slice(root.length + 1) }));
  function renderEditor() {
    if (!tplWin || !ed) return;
    // a redraw keeps the place on the page (and the open folds) the crew was at
    const oldBody = tplWin.querySelector('.body'); const keepTop = oldBody ? oldBody.scrollTop : 0;
    const openFolds = new Set(Array.from(tplWin.querySelectorAll('details.sec[open]')).map(d => d.querySelector('summary') && d.querySelector('summary').textContent.trim()));
    const openLocs = new Set(Array.from(tplWin.querySelectorAll('details.axg[open]')).map(d => d.dataset.axg));
    const q = ed.q.trim().toLowerCase();
    const counts = {}; for (const a of Object.keys(ed.fields)) { const p = a.split('.')[0]; counts[p] = (counts[p] || 0) + 1; } for (const it of ed.items) { const p = it.root.split('.')[0]; counts[p] = (counts[p] || 0) + 1; }
    const pageBtns = TPL_PAGES.map(([k, l]) => `<button data-page="${k}" class="${ed.page === k ? 'on' : ''}">${l}${counts[k] ? `<span class="cnt">${counts[k]}</span>` : ''}</button>`).join('');
    const crew = ((facilityTypes && facilityTypes.crew) || []).filter(c => c.name && c.id !== userId);
    const shareUi = `<div class="share"><span class="muted">Share:</span>
      <label><input type="radio" name="share" value="private" ${ed.share === 'private' ? 'checked' : ''}> Private</label>
      <label><input type="radio" name="share" value="everyone" ${ed.share === 'everyone' ? 'checked' : ''}> Everyone</label>
      <label><input type="radio" name="share" value="some" ${ed.share === 'some' ? 'checked' : ''}> Certain people</label>
      ${ed.share === 'some' ? `<div class="pick" style="min-width:260px"><input type="text" class="search" data-people placeholder="Search a name…"><div class="picklist" hidden data-peoplelist></div><div class="chosen">${ed.people.map(p => `<span>${esc(p.name)} <a data-unshare="${esc(p.id)}" style="cursor:pointer">✕</a></span>`).join('')}</div></div>` : ''}</div>`;
    let content = '';
    const page = ed.page;
    const secs = sectionsOf(page), roots = itemRootsOf(page);
    // ESO names its unable-to-obtain fields "UTO" or "Reason Unable To Obtain"; the editor names the field each stands in for (Last Known Well · UTO)
    const pnTitle = (f) => {
      if (f.t !== 'pertinentNegative') return f.n;
      const generic = /^(UTO|Reason Unable To Obtain|Pertinent Negative)$/i.test(f.n.trim());
      const partnerA = f.a.replace(/PertinentNegative(I[dD])?$/, '').replace(/\.pertinentNegativeId$/, '');
      const partner = partnerA !== f.a && (catalog.fields || []).find(x => x.a === partnerA);
      const base = generic ? (partner ? partner.n : humanize(partnerA.split('.').pop())) : f.n;
      return `${base} · UTO`;
    };
    const fieldRow = (f, cur, prefix) => {
      const on = !!cur; const key = prefix ? `${prefix}|${f.rel}` : f.a;
      const locked = tplLocked(f.a);
      const shut = locked && !isAdmin();
      const rule = prefix ? null : ruleFor(f.a); const unmet = rule && !ruleMet(rule, ed.fields);
      const blanks = f.t === 'string' && /narrative/i.test(f.a) && /narrativeText|narrative$/i.test(f.a) ? '<div class="muted" style="font-weight:400">Leave blanks like ____ to fill on the run; {incident}, {unit}, {date} and {time} are filled in for you.</div>' : '';
      return `<div class="tf ${on ? 'on' : ''} ${shut ? 'shut' : ''}" data-key="${esc(key)}"><input type="checkbox" data-sel ${on ? 'checked' : ''} ${shut ? 'disabled' : ''}><div class="fl">${esc(pnTitle(f))}<div class="muted" style="font-weight:400">${esc(f.t === 'pertinentNegative' ? 'unable to obtain: the reason' : '')}${locked ? lockNote() : ''}${unmet ? `<div style="color:#b45309">Only on the run when ${esc(rule.why)}; left out until then.</div>` : ''}</div>${blanks}</div><div>${shut ? '' : inputFor(f, cur ? cur.v : null, key)}${lockBtn(f.a, 'margin-top:4px')}</div></div>`;
    };
    for (const [sec, fields] of secs) {
      const shown = (q ? fields.filter(f => f.n.toLowerCase().includes(q) || sec.toLowerCase().includes(q)) : fields).filter(f => fieldShown(f.a, ed.fields) || ed.fields[f.a]);
      if (!shown.length) continue;
      const n = shown.filter(f => ed.fields[f.a]).length;
      // the delay fields: one press sets every one of them to ESO's own None/No Delay
      const delays = fields.filter(f => f.t === 'multiselect' && /Delays$/.test(f.a) && listOf(f.l).some(e => /none\/no delay/i.test(e.n)));
      const delayBtn = delays.length ? `<button class="tb sec" data-nodelays style="margin:6px 0">No delays (None/No Delay on all ${delays.length})</button>` : '';
      content += `<details class="sec" ${q || n ? 'open' : ''}><summary>${esc(humanize(sec.includes('.') ? sec.split('.')[1] : sec))}${n ? ` <span class="cnt" style="background:#fbbf24;border-radius:10px;padding:0 7px;font-size:12px">${n}</span>` : ''}</summary>${delayBtn}${shown.map(f => fieldRow(f, ed.fields[f.a], null)).join('')}</details>`;
    }
    for (const [root, kind] of roots) {
      const items = ed.items.map((it, i) => ({ it, i })).filter(x => x.it.root === root);
      const members = memberFields(root);
      const rootLocked = tplLocked(root), rootShut = rootLocked && !isAdmin();
      content += `<details class="sec" ${items.length || q ? 'open' : ''}><summary><span style="flex:1">${esc(ITEM_NAMES[kind] || humanize(root.split('.').pop()))}${items.length ? ` <span class="cnt" style="background:#fbbf24;border-radius:10px;padding:0 7px;font-size:12px">${items.length}</span>` : ''}${rootLocked ? ' ' + lockNote() : ''}</span>${lockBtn(root)}</summary>
        ${rootShut ? `<div class="muted" style="padding:0 0 10px">${esc(ITEM_NAMES[kind] || 'These')} are locked by the agency: a template cannot add them. Enter them on the run yourself.</div>` : ''}
        ${!rootShut && utoSet(ed.fields, root) ? `<div data-utonote style="color:#b45309;padding:0 0 10px">Unable to obtain is set for ${esc((ITEM_NAMES[kind] || 'these').toLowerCase())}: ESO takes one or the other, so a fill writes the Unable to obtain and leaves ${items.length ? 'these entries' : 'any entries'} out. Clear it to fill entries instead.</div>` : ''}
        ${items.map(({ it, i }) => `<div class="item" data-item="${i}"><div class="ih">${esc(itemTitle(it))}<span style="flex:1"></span><button class="tb danger" data-remove>Remove</button></div>
          ${rootShut ? `<div class="muted">${lockNote()} Not filled.</div>` : kind === 'assessment' ? assessmentUi(it) : groupedRows(members.filter(m => !(kind === 'vital' && /vitalSignDateTime|softDeleted/.test(m.rel))), it, i, fieldRow, kind)}</div>`).join('')}
        ${rootShut ? '' : `<button class="tb pri" data-additem="${esc(root)}" data-kind="${esc(kind)}" style="margin:8px 0">Add ${esc(ITEM_ONE[kind] || 'one')}</button>`}</details>`;
    }
    if (!content) content = '<div class="muted">Nothing on this tab can be templated.</div>';
    const nf = Object.keys(ed.fields).length, ni = ed.items.length;
    tplWin.innerHTML = `<div class="tophead"><input class="name" type="text" placeholder="Template name" value="${esc(ed.name)}" data-name><span class="muted" style="color:#d1fae5">${nf} field${nf === 1 ? '' : 's'}${ni ? `, ${ni} item${ni === 1 ? '' : 's'}` : ''}</span><span style="flex:1"></span>${isAdmin() ? `<button class="tb ${lockMode ? 'pri' : 'sec'}" data-act="lockmode" title="Lock fields the crew must enter themselves">${lockMode ? 'Done locking' : 'Lock fields'}</button>` : ''}<button class="tb pri" data-act="save">Save</button><button class="tb sec" data-act="cancel">Cancel</button></div>
      <div class="body">${shareUi}<input type="text" class="search" placeholder="Find a field on this tab…" value="${esc(ed.q)}" data-q><div class="pages">${pageBtns}</div>${content}</div>`;
    if (tplWin._page === page) {
      for (const d of tplWin.querySelectorAll('details.sec')) { const t = d.querySelector('summary') && d.querySelector('summary').textContent.trim(); if (t && openFolds.has(t)) d.open = true; }
      for (const d of tplWin.querySelectorAll('details.axg')) if (openLocs.has(d.dataset.axg)) d.open = true;
      tplWin.querySelector('.body').scrollTop = keepTop;
    }
    tplWin._page = page;
    wireEditor();
  }
  // a vital's members in their groups (Blood pressure: Systolic, Diastolic, Method; Pulse: Rate,
  // Rhythm...), the key of a treatment first, the rest of a treatment's 250 fields folded away
  const VITAL_ORDER = ['bloodPressure', 'pulse', 'respiration', 'etCO2SPO2CO', 'glucoseAndTemp', 'pain', 'avpu', 'position', 'glasgowComaScale', 'revisedTraumaScore', 'cardiacMonitoring'];
  const VITAL_GROUP_NAMES = { bloodPressure: 'Blood pressure', pulse: 'Pulse', respiration: 'Respirations', etCO2SPO2CO: 'SpO₂, EtCO₂ and CO', glucoseAndTemp: 'Glucose and temperature', pain: 'Pain', avpu: 'AVPU', position: 'Patient side and posture', glasgowComaScale: 'Glasgow Coma Scale', revisedTraumaScore: 'Revised trauma score', cardiacMonitoring: 'Cardiac monitoring' };
  const vitalGroup = (rel) => rel.includes('.') ? rel.split('.')[0] : /^pain/i.test(rel) ? 'pain' : /^avpu/i.test(rel) ? 'avpu' : /^patient(Side|Posture)/i.test(rel) ? 'position' : 'other';
  // a group that is not a dotted part of the vital (pain, AVPU, position) locks by its fields
  const groupFields = (it, g) => memberFields(it.root).filter(m => vitalGroup(m.rel) === g).map(m => it.root + '.' + m.rel);
  function groupedRows(members, it, i, fieldRow, kind) {
    if (kind === 'vital') {
      // what ESO works out itself, or takes from a figure, is not typed into a template
      const skip = /shockIndex|temperatureC$|etCO2mmHg|etCO2Percentage|etCO2kPa|coDecimal|patientSide|patientPosture|glascowComaTotalScore|revisedTrauma/;
      const groups = new Map();
      for (const m of members) { if (skip.test(m.rel)) continue; const g = /PertinentNegativeId$/.test(m.rel) ? vitalGroup(m.rel.replace(/PertinentNegativeId$/, '').replace(/^(bloodPressure|pulse|respiration|glasgowComaScale(Eyes|Verbal|Motor)?|painScale).*/, (x, g1) => g1.startsWith('glasgow') ? 'glasgowComaScale' : g1 === 'painScale' ? 'pain' : g1)) : vitalGroup(m.rel); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m); }
      const keys = [...groups.keys()].sort((a, b) => (VITAL_ORDER.indexOf(a) + 1 || 99) - (VITAL_ORDER.indexOf(b) + 1 || 99));
      const gcs = ['glascowComaEyesId', 'glascowComaVerbalId', 'glascowComaMotorId'].map(k => it.fields['glasgowComaScale.' + k]).map(f => f ? Number((nameOf(f.l, f.v).match(/^(\d)/) || [])[1]) : NaN);
      const total = gcs.every(n => !isNaN(n)) ? gcs.reduce((a, b) => a + b, 0) : null;
      return `<div style="display:flex;flex-direction:column;gap:10px">` + keys.map(g => {
        const gk = g === 'other' ? null : `${it.root}.${g}`; const gl = gk && tplLocked(gk);
        const rows = gl && !isAdmin() ? '' : groups.get(g).filter(m => !/PertinentNegativeId$/.test(m.rel)).map(m => fieldRow(m, it.fields[m.rel], String(i))).join('') + groups.get(g).filter(m => /PertinentNegativeId$/.test(m.rel)).map(m => fieldRow({ ...m, n: 'Unable to obtain' }, it.fields[m.rel], String(i))).join('');
        return `<div style="border:1px solid #e2e8f0;border-radius:10px;background:#fff"><div style="padding:8px 12px;background:#f1f5f9;border-radius:10px 10px 0 0;font-weight:700;color:#334155;display:flex;gap:10px;align-items:center">${esc(VITAL_GROUP_NAMES[g] || humanize(g))}${g === 'glasgowComaScale' && total ? ` <span class="muted">total ${total}</span>` : ''}${gl ? lockNote() : ''}${gk ? lockBtn(gk) : ''}</div><div style="padding:4px 12px 8px">${rows}</div></div>`;
      }).join('') + '</div>';
    }
    if (kind === 'treatment') {
      const first = ['flowchartTreatmentRegistryId', 'dose', 'doseUnitId', 'routeId', 'provider', 'successful', 'comments', 'indicationForGivingIds', 'responseId'];
      const head = members.filter(m => first.includes(m.rel)).sort((a, b) => first.indexOf(a.rel) - first.indexOf(b.rel));
      const rest = members.filter(m => !first.includes(m.rel));
      const set = rest.filter(m => it.fields[m.rel]).length;
      return head.map(m => fieldRow(m, it.fields[m.rel], String(i))).join('') + `<details ${set ? 'open' : ''} style="margin-top:6px"><summary style="cursor:pointer;font-weight:600;color:#334155">More fields (${rest.length}${set ? ', ' + set + ' set' : ''})</summary>${rest.map(m => fieldRow(m, it.fields[m.rel], String(i))).join('')}</details>`;
    }
    const key = ITEM_KEY[kind];
    const sorted = key ? members.slice().sort((a, b) => (a.rel === key ? -1 : b.rel === key ? 1 : 0)) : members;
    return sorted.map(m => fieldRow(m, it.fields[m.rel], String(i))).join('');
  }
  const itemTitle = (it) => { const k = ITEM_KEY[it.kind]; const f = k && it.fields[k]; if (it.kind === 'assessment') { const fs = (it.findings || []).filter(f => f && f.loc && f.id); const ab = fs.filter(x => !isNA(x.id)).length; const na = fs.filter(x => x.id === 'Not_Assessed').length; const blank = axComplete(fs).length - fs.length; return `Assessment: ${ab ? ab + ' finding' + (ab === 1 ? '' : 's') : fs.length ? 'no abnormalities' : 'nothing set'}${na ? `, ${na} not assessed` : ''}${blank && fs.length ? `, ${blank} blank (written Not Assessed)` : ''}`; } if (it.kind === 'vital') return 'Vital'; return f && f.v != null ? nameOf(f.l, f.v) : humanize(it.kind); };
  // a list with parents (a medication's measures, a treatment's routes) narrows to the item's other choices, as ESO's own dropdown does
  function entriesFor(f, key) {
    const entries = listOf(f.l);
    if (!key || !key.includes('|') || !entries.some(e => e.p != null)) return entries;
    const it = ed && ed.items[Number(key.split('|')[0])]; if (!it) return entries;
    const parents = new Set(Object.values(it.fields).map(x => String(x.v)));
    const narrowed = entries.filter(e => parents.has(String(e.p)));
    return narrowed.length ? narrowed : entries;
  }
  const siblingsNarrow = (key) => { const it = ed && ed.items[Number(key.split('|')[0])]; if (!it) return false; return memberFields(it.root).some(f => f.l && f.rel !== key.split('|')[1] && listOf(f.l).some(e => e.p != null)); };
  function inputFor(f, v, key) {
    const val = v == null ? '' : v;
    if (f.t === 'boolean') return `<select data-in><option value="">—</option><option value="true" ${val === true || val === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${val === false || val === 'false' ? 'selected' : ''}>No</option></select>`;
    if (f.t === 'date') return `<input type="date" data-in value="${esc(esoToInput(val, 'date'))}">`;
    if (f.t === 'datetime') return `<input type="datetime-local" data-in value="${esc(esoToInput(val, 'datetime'))}">`;
    if (f.t === 'time') return `<input type="time" data-in step="1" value="${esc(esoToInput(val, 'time'))}">`;
    const none = f.l ? noneOf(f.l) : null;
    const noneBtn = none ? `<button type="button" class="tb sec" data-none="${esc(none.id)}" style="padding:8px 12px;min-height:38px;margin-top:4px">${esc(none.n)}</button>` : '';
    // a short list is laid out as ESO's own quick picks: one button per choice
    if (f.l && (f.t === 'singleselect' || f.t === 'pertinentNegative' || f.t === 'multiselect') && listOf(f.l).length && listOf(f.l).length <= 8) {
      const arr = f.t === 'multiselect' ? (Array.isArray(val) ? val : (val === '' ? [] : [val])) : (val === '' ? [] : [val]);
      const on = (id) => arr.map(String).includes(String(id));
      return `<div class="pills" data-pills="${f.t === 'multiselect' ? 'multi' : 'one'}" style="display:flex;flex-wrap:wrap;gap:6px">${entriesFor(f, key).map(e => `<button type="button" data-pill="${esc(e.id)}" style="border:1px solid ${on(e.id) ? '#1d4ed8' : '#cbd5e1'};background:${on(e.id) ? '#1d4ed8' : '#fff'};color:${on(e.id) ? '#fff' : '#1e293b'};border-radius:20px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;min-height:40px">${esc(e.n)}</button>`).join('')}</div>`;
    }
    if (f.l && (f.t === 'singleselect' || f.t === 'pertinentNegative')) return `<div class="pick"><input type="text" data-pick placeholder="Search or scroll…"><div class="picklist" hidden></div><div class="chosen">${val !== '' ? esc(nameOf(f.l, val)) : ''}</div>${noneBtn}</div>`;
    if (f.l && f.t === 'multiselect') { const arr = Array.isArray(val) ? val : (val === '' ? [] : [val]); return `<div class="pick"><input type="text" data-pick data-multi placeholder="Search or scroll…"><div class="picklist" hidden></div><div class="chosen">${arr.map(x => `<span>${esc(nameOf(f.l, x))} <a data-unpick="${esc(x)}" style="cursor:pointer">✕</a></span>`).join('')}</div>${noneBtn}</div>`; }
    if (f.t === 'string' && /narrative|comment|note|description|statement/i.test(f.n + f.a)) return `<textarea data-in rows="3">${esc(val)}</textarea>`;
    return `<input type="text" data-in ${/number|integer|phone|ssn/.test(f.t) ? 'inputmode="decimal"' : ''} value="${esc(val)}">`;
  }
  function esoToInput(v, t) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    if (t === 'date') return `${m[3]}-${m[1]}-${m[2]}`;
    if (t === 'time') return `${m[4]}:${m[5]}:${m[6]}`;
    return `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}`;
  }
  function inputToEso(v, t) {
    if (!v) return null;
    if (t === 'date') { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v); return m ? `${m[2]}/${m[3]}/${m[1]} 00:00:00` : null; }
    if (t === 'time') { const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v); return m ? `01/01/1890 ${m[1]}:${m[2]}:${m[3] || '00'}` : null; }
    if (t === 'datetime') { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v); return m ? `${m[2]}/${m[3]}/${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}` : null; }
    return v;
  }
  // The assessment, laid out as ESO's own Assessments screen (assess-catalog.js carries the
  // layout from ESO's code): the categories down the side; each category's sections, each with
  // No Abnormalities and Not Assessed written where ESO writes them; each section's locations
  // with the findings ESO offers there, each a check (present) or an X (not present), a pick-one
  // row for a pupil size, a pulse or a capillary refill; the category's comments. A new
  // assessment starts No Abnormalities on the areas ESO seeds; a finding on a location takes the
  // place of that location's No Abnormalities / Not Assessed, as it does in ESO.
  const AX = () => (typeof ESOSAVE_ASSESS !== 'undefined' && ESOSAVE_ASSESS.layout ? ESOSAVE_ASSESS : null);
  const isNA = (id) => id === 'No_Abnormalities' || id === 'Not_Assessed';
  const axSections = () => { const A = AX(); return A ? A.layout.flatMap(c => c.s.map(s => ({ ...s, cat: c.id }))) : []; };
  const axSectionOf = (loc) => axSections().find(s => s.g.some(g => g.loc === loc) || s.na.includes(loc));
  // where a finding on a location knocks out No Abnormalities / Not Assessed: the location
  // itself, and its section's holder when that is a location of its own (Eyes for either eye)
  const axNaHolders = (loc) => { const s = axSectionOf(loc); return [loc].concat(s ? s.na.filter(l => l !== loc && !s.g.some(g => g.loc === l)) : []); };
  const axCatLocs = (c) => [...new Set(c.s.flatMap(s => s.g.map(g => g.loc).concat(s.na)))];
  const axCatOf = (loc) => { const A = AX(); return A && A.layout.find(c => axCatLocs(c).includes(loc)); };
  // what a fill writes: the template's findings, plus Not Assessed on each area ESO seeds that
  // the template says nothing about, as ESO itself starts an assessment
  function axComplete(findings) {
    const A = AX(); const fs = (findings || []).filter(f => f && f.loc && f.id);
    if (!A) return fs;
    const touched = new Set(fs.flatMap(f => axNaHolders(f.loc)));
    return fs.concat(A.top.filter(loc => !touched.has(loc)).map(loc => ({ loc, id: 'Not_Assessed' })));
  }
  function assessmentUi(it) {
    const A = AX();
    if (!A) return '<div class="muted">The assessment layout is not available.</div>';
    const fname = (id) => (A.findings.find(f => f.id === id) || {}).n || id.replace(/_/g, ' ');
    const at = (loc) => (it.findings || []).filter(f => f.loc === loc);
    const has = (loc, id) => at(loc).find(f => f.id === id);
    const cats = A.layout;
    if (!it._cat || !cats.some(c => c.id === it._cat)) it._cat = cats[0].id;
    const catState = (c) => { const fs = axCatLocs(c).flatMap(at); if (fs.some(f => !isNA(f.id))) return '#b91c1c'; if (fs.length && fs.every(f => f.id === 'No_Abnormalities')) return '#15803d'; if (fs.some(f => f.id === 'Not_Assessed')) return '#64748b'; return '#b45309'; };
    const idx = ed.items.indexOf(it);
    const lockAll = tplLocked(it.root + '.findings');
    const catKeyOf = (c) => `${it.root}.findings.${c.id}`;
    let html = `<div class="ax"><div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px"><button type="button" class="tb sec" data-allnormal>All No Abnormalities</button><button type="button" class="tb sec" data-allna>All Not Assessed</button><button type="button" class="tb sec" data-aox4>Alert and Oriented x4</button><button type="button" class="tb sec" data-axclear>Clear all</button></div>
      <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:150px;display:flex;flex-direction:column;gap:4px">${cats.map(c => `<button type="button" data-cat="${esc(c.id)}" style="text-align:left;border:0;border-radius:8px;padding:10px 12px;font:inherit;font-weight:700;cursor:pointer;background:${it._cat === c.id ? '#22c55e' : '#f1f5f9'};color:${it._cat === c.id ? '#fff' : '#334155'};display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:5px;background:${catState(c)};flex:none"></span>${esc(c.n.toUpperCase())}${lockAll || tplLocked(catKeyOf(c)) ? ' 🔒' : ''}</button>`).join('')}</div>
      <div style="flex:1;min-width:280px">`;
    const cat = cats.find(c => c.id === it._cat);
    const catLocked = lockAll || tplLocked(catKeyOf(cat));
    html += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px"><b style="font-size:17px">${esc(cat.n)}</b>${catLocked ? lockNote() : ''}${lockBtn(catKeyOf(cat))}</div>`;
    const toggle = (loc, id) => { const f = has(loc, id); const on = f && f.present !== false, off = f && f.present === false; return `<span style="display:inline-flex;border:1px solid #cbd5e1;border-radius:20px;overflow:hidden;flex:none"><button type="button" data-tog="${esc(loc)}|${esc(id)}|1" title="Present" style="border:0;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer;background:${on ? '#22c55e' : '#fff'};color:${on ? '#fff' : '#64748b'}">✓</button><button type="button" data-tog="${esc(loc)}|${esc(id)}|0" title="Not present" style="border:0;border-left:1px solid #cbd5e1;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer;background:${off ? '#ef4444' : '#fff'};color:${off ? '#fff' : '#64748b'}">✕</button></span>`; };
    const group = (g, fold) => {
      const fs = at(g.loc).filter(f => !isNA(f.id));
      const one = g.one ? `<div class="pills" style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px">${g.one.map(id => { const on = !!(has(g.loc, id) && has(g.loc, id).present !== false); return `<button type="button" data-one="${esc(g.loc)}|${esc(id)}" style="border:1px solid ${on ? '#1d4ed8' : '#cbd5e1'};background:${on ? '#1d4ed8' : '#fff'};color:${on ? '#fff' : '#1e293b'};border-radius:20px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;min-height:40px">${esc(fname(id))}</button>`; }).join('')}</div>` : '';
      const list = g.f.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px 16px">${g.f.map(id => `<span style="display:flex;align-items:center;gap:8px">${toggle(g.loc, id)} <span>${esc(fname(id))}</span></span>`).join('')}</div>` : '';
      if (!fold) return `${g.n !== 'Findings' ? `<div style="font-weight:700;color:#334155;margin:4px 0 6px">${esc(g.n)}</div>` : ''}${one}${list}`;
      const state = fs.length ? fs.map(f => (f.present === false ? '✕ ' : '✓ ') + fname(f.id)).join(', ') : has(g.loc, 'No_Abnormalities') ? 'No Abnormalities' : has(g.loc, 'Not_Assessed') ? 'Not Assessed' : '';
      return `<details class="axg" data-axg="${esc(g.loc)}" ${fs.length ? 'open' : ''} style="border-top:1px solid #f1f5f9;padding:2px 0"><summary style="cursor:pointer;font-weight:600;color:#334155;padding:6px 0">${esc(g.n)}${state ? ` <span class="muted" style="font-weight:400">${esc(state)}</span>` : ''}</summary><div style="padding:4px 0 8px">${one}${list}</div></details>`;
    };
    if (catLocked && !isAdmin()) html += `<div class="muted" style="margin:6px 0 12px">${esc(cat.n)} is locked by the agency: a template cannot set it. Assess it on the run.</div>`;
    else for (const s of cat.s) {
      const naOn = (id) => s.na.length > 0 && s.na.every(l => has(l, id));
      const fold = new Set(s.g.map(g => g.loc)).size > 1;
      const n = [...new Set(s.g.map(g => g.loc))].flatMap(at).filter(f => !isNA(f.id)).length;
      const ok = naOn('No_Abnormalities'), na = naOn('Not_Assessed');
      html += `<div class="axsec" style="border:1px solid #e2e8f0;border-radius:10px;margin:0 0 10px;background:#fff">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;background:#f1f5f9;border-radius:10px 10px 0 0"><b style="flex:1;font-size:16px">${esc(s.n)}${n ? ` <span class="cnt" style="background:#fbbf24;border-radius:10px;padding:0 7px;font-size:12px">${n}</span>` : ''}</b>
          ${s.na.length ? `<button type="button" class="tb ${ok ? 'pri' : 'sec'}" data-set="${esc(s.na.join(','))}|No_Abnormalities" style="border-radius:22px">${ok ? '● ' : '○ '}No Abnormalities</button><button type="button" class="tb ${na ? 'pri' : 'sec'}" data-set="${esc(s.na.join(','))}|Not_Assessed" style="border-radius:22px">${na ? '● ' : '○ '}Not Assessed</button>` : ''}</div>
        <div style="padding:8px 12px 12px">${s.g.map(g => group(g, fold)).join('')}</div></div>`;
    }
    const cm = cat.c; const cmf = cm && memberFields('assessments.assessmentsV2').find(m => m.rel === cm);
    if (cmf && !(catLocked && !isAdmin())) html += `<div style="font-weight:700;color:#334155;margin:4px 0 6px">Comments</div><div class="tf ${it.fields[cm] ? 'on' : ''}" data-key="${esc(String(idx))}|${esc(cm)}" style="grid-template-columns:34px 1fr"><input type="checkbox" data-sel ${it.fields[cm] ? 'checked' : ''}><div>${inputFor(cmf, it.fields[cm] ? it.fields[cm].v : null)}</div></div>`;
    return html + '</div></div></div>';
  }
  function fieldDef(key) {
    // key: an address, or "<item index>|<member rel>"
    const bar = key.indexOf('|');
    if (bar < 0) { const f = (catalog.fields || []).find(x => x.a === key); return f ? { f, get: () => ed.fields[key], set: (v) => { if (v == null) delete ed.fields[key]; else ed.fields[key] = v; } } : null; }
    const i = Number(key.slice(0, bar)), rel = key.slice(bar + 1); const it = ed.items[i]; if (!it) return null;
    const f = memberFields(it.root).find(x => x.rel === rel); if (!f) return null;
    return { f, get: () => it.fields[rel], set: (v) => { if (v == null) delete it.fields[rel]; else it.fields[rel] = v; } };
  }
  function wireEditor() {
    const W = tplWin;
    W.querySelector('[data-name]').addEventListener('input', (e) => { ed.name = e.target.value; });
    W.querySelector('[data-q]').addEventListener('input', (e) => { ed.q = e.target.value; clearTimeout(W._qt); W._qt = setTimeout(() => { const el = W.querySelector('[data-q]'); const pos = el.selectionStart; renderEditor(); const n = tplWin.querySelector('[data-q]'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } }, 250); });
    W.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => { ed.page = b.dataset.page; renderEditor(); }));
    W.querySelectorAll('input[name=share]').forEach(r => r.addEventListener('change', () => { ed.share = r.value; renderEditor(); }));
    W.querySelectorAll('[data-unshare]').forEach(a => a.addEventListener('click', () => { ed.people = ed.people.filter(p => p.id !== a.dataset.unshare); renderEditor(); }));
    const pp = W.querySelector('[data-people]');
    if (pp) {
      const list = W.querySelector('[data-peoplelist]');
      const crew = ((facilityTypes && facilityTypes.crew) || []).filter(c => c.name && c.id !== userId);
      const show = () => { const q = pp.value.trim().toLowerCase(); const hits = crew.filter(c => !ed.people.some(p => p.id === c.id) && (!q || c.name.toLowerCase().includes(q))).slice(0, 60); list.innerHTML = hits.map(c => `<button type="button" data-pid="${esc(c.id)}">${esc(c.name)}</button>`).join('') || '<div class="muted" style="padding:8px">No one matches.</div>'; list.hidden = false; list.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => { ed.people.push({ id: b.dataset.pid, name: crew.find(c => c.id === b.dataset.pid).name }); renderEditor(); })); };
      pp.addEventListener('focus', show); pp.addEventListener('input', show);
      // clicking away closes the list (a moment later, so a tap on a name still lands)
      pp.addEventListener('blur', () => setTimeout(() => { if (!list.contains(shadow.activeElement)) list.hidden = true; }, 250));
    }
    W.querySelector('[data-act=cancel]').addEventListener('click', () => { tplView = 'list'; ed = null; lockMode = false; renderTemplates(); });
    const lm = W.querySelector('[data-act=lockmode]'); if (lm) lm.addEventListener('click', () => { lockMode = !lockMode; renderEditor(); });
    W.querySelectorAll('[data-lock]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleLock(b.dataset.lock); }));
    W.querySelector('[data-act=save]').addEventListener('click', saveEditor);
    W.querySelectorAll('[data-additem]').forEach(b => b.addEventListener('click', () => {
      const root = b.dataset.additem, kind = b.dataset.kind, rootField = null;
      const rootDef = { r: rootRef(root), t: rootType(kind) };
      const A = typeof ESOSAVE_ASSESS !== 'undefined' ? ESOSAVE_ASSESS : null;
      ed.items.push({ root, kind, r: rootDef.r, t: rootDef.t, fields: {}, findings: kind === 'assessment' && A ? A.top.map(id => ({ loc: id, id: 'No_Abnormalities' })) : [] });
      renderEditor();
      const last = tplWin.querySelectorAll('.item'); if (last.length) last[last.length - 1].scrollIntoView({ block: 'nearest' });
    }));
    W.querySelectorAll('[data-nodelays]').forEach(b => b.addEventListener('click', () => {
      for (const f of fieldsOfPage(ed.page)) {
        if (!(f.t === 'multiselect' && /Delays$/.test(f.a))) continue;
        const none = listOf(f.l).find(e => /none\/no delay/i.test(e.n)); if (!none) continue;
        ed.fields[f.a] = { r: f.r, t: f.t, v: [none.id], l: f.l };
      }
      renderEditor();
    }));
    W.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => { const i = Number(b.closest('.item').dataset.item); ed.items.splice(i, 1); renderEditor(); }));
    const axItem = (b) => ed.items[Number(b.closest('.item').dataset.item)];
    W.querySelectorAll('[data-allnormal]').forEach(b => b.addEventListener('click', () => { const it = axItem(b); it.findings = AX().top.map(id => ({ loc: id, id: 'No_Abnormalities' })); renderEditor(); }));
    W.querySelectorAll('[data-allna]').forEach(b => b.addEventListener('click', () => { const it = axItem(b); it.findings = AX().top.map(id => ({ loc: id, id: 'Not_Assessed' })); renderEditor(); }));
    W.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { const it = axItem(b); it._cat = b.dataset.cat; renderEditor(); }));
    // a section's No Abnormalities / Not Assessed: written on each of the section's holders, everything in the section cleared first; the same button again clears it
    W.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
      const it = axItem(b); const [csv, id] = b.dataset.set.split('|'); const locs = csv.split(',');
      const was = locs.every(l => (it.findings || []).some(f => f.loc === l && f.id === id));
      const inside = new Set(locs.concat(axSections().filter(s => s.na.join(',') === csv).flatMap(s => s.g.map(g => g.loc))));
      it.findings = (it.findings || []).filter(f => !inside.has(f.loc));
      if (!was) for (const loc of locs) it.findings.push({ loc, id });
      renderEditor();
    }));
    // a finding, present or not, takes the place of No Abnormalities / Not Assessed on its location; the same button again clears it
    const axClearNA = (it, loc) => { const holders = axNaHolders(loc); it.findings = (it.findings || []).filter(f => !(isNA(f.id) && holders.includes(f.loc))); };
    W.querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', () => {
      const it = axItem(b); const [loc, id, on] = b.dataset.tog.split('|'); const present = on === '1';
      const cur = (it.findings || []).find(f => f.loc === loc && f.id === id);
      axClearNA(it, loc);
      it.findings = it.findings.filter(f => !(f.loc === loc && f.id === id));
      if (!(cur && (cur.present !== false) === present)) it.findings.push({ loc, id, present });
      renderEditor();
    }));
    // a pick-one row (pupil size, a pulse, capillary refill): one of them at a time on that location
    W.querySelectorAll('[data-one]').forEach(b => b.addEventListener('click', () => {
      const it = axItem(b); const [loc, id] = b.dataset.one.split('|');
      const s = axSectionOf(loc); const g = s && s.g.find(x => x.loc === loc && x.one); const ids = g ? g.one : [id];
      const cur = (it.findings || []).find(f => f.loc === loc && f.id === id && f.present !== false);
      axClearNA(it, loc);
      it.findings = it.findings.filter(f => !(f.loc === loc && ids.includes(f.id)));
      if (!cur) it.findings.push({ loc, id, present: true });
      renderEditor();
    }));
    W.querySelectorAll('[data-aox4]').forEach(b => b.addEventListener('click', () => {
      const it = axItem(b); const A = AX();
      it.findings = (it.findings || []).filter(f => !(f.loc === 'MentalStatus' && ((A.orientation || []).includes(f.id) || isNA(f.id))));
      for (const id of (A.orientation || [])) it.findings.push({ loc: 'MentalStatus', id, present: true });
      it._cat = 'MentalStatus'; renderEditor();
    }));
    W.querySelectorAll('[data-axclear]').forEach(b => b.addEventListener('click', () => { const it = axItem(b); it.findings = []; renderEditor(); }));
    // field rows
    W.querySelectorAll('.tf').forEach(row => {
      const key = row.dataset.key; const d = fieldDef(key); if (!d) return;
      const box = row.querySelector('[data-sel]');
      const setVal = (v) => { const has = v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length); if (has) d.set({ r: d.f.r, t: d.f.t, v, ...(d.f.l ? { l: d.f.l } : {}) }); else d.set(null); box.checked = has; row.classList.toggle('on', has); };
      const inp = row.querySelector('[data-in]');
      if (inp) {
        inp.addEventListener('change', () => { let v = inp.value; if (d.f.t === 'boolean') v = v === '' ? null : v === 'true'; else if (['date', 'time', 'datetime'].includes(d.f.t)) v = inputToEso(v, d.f.t); setVal(v); });
        box.addEventListener('change', () => { if (!box.checked) { inp.value = ''; setVal(null); } else if (!inp.value) { box.checked = false; inp.focus(); } });
      }
      const pills = row.querySelector('[data-pills]');
      if (pills) {
        const multi = pills.dataset.pills === 'multi';
        const cur = () => { const c = d.get(); return c ? (Array.isArray(c.v) ? c.v : [c.v]) : []; };
        pills.querySelectorAll('[data-pill]').forEach(b => b.addEventListener('click', () => {
          const e = listOf(d.f.l).find(x => String(x.id) === b.dataset.pill); const id = e ? e.id : b.dataset.pill;
          const now = cur(); const has = now.map(String).includes(String(id));
          if (multi) setVal(has ? now.filter(x => String(x) !== String(id)) : (NONE_RE.test(e ? e.n : '') ? [id] : now.filter(x => { const y = listOf(d.f.l).find(z => String(z.id) === String(x)); return !(y && NONE_RE.test(y.n)); }).concat([id])));
          else setVal(has ? null : id);
          renderEditor();
        }));
        box.addEventListener('change', () => { if (!box.checked) { setVal(null); renderEditor(); } else box.checked = !!cur().length; });
      }
      const pk = row.querySelector('[data-pick]');
      if (pk) {
        const list = row.querySelector('.picklist'); const multi = pk.hasAttribute('data-multi');
        const cur = () => { const c = d.get(); return c ? (Array.isArray(c.v) ? c.v : [c.v]) : []; };
        const show = () => {
          const q = pk.value.trim().toLowerCase();
          const entries = entriesFor(d.f, key);
          const chosen = cur().map(String);
          const hits = entries.filter(e => !q || e.n.toLowerCase().includes(q)).slice(0, 200);
          list.innerHTML = hits.map(e => `<button type="button" data-id="${esc(e.id)}" class="${chosen.includes(String(e.id)) ? 'sel' : ''}">${esc(e.n)}</button>`).join('') || '<div class="muted" style="padding:8px">Nothing matches.</div>';
          list.hidden = false;
          list.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => {
            const raw = b.dataset.id; const e = entries.find(x => String(x.id) === raw); const id = e ? e.id : raw;
            if (multi) { const now = cur(); const has = now.map(String).includes(String(id)); setVal(has ? now.filter(x => String(x) !== String(id)) : now.concat([id])); }
            else { setVal(id); list.hidden = true; pk.value = ''; if (key.includes('|') && siblingsNarrow(key)) { renderEditor(); return; } }
            row.querySelector('.chosen').innerHTML = multi ? cur().map(x => `<span>${esc(nameOf(d.f.l, x))} <a data-unpick="${esc(x)}" style="cursor:pointer">✕</a></span>`).join('') : esc(nameOf(d.f.l, id));
            wireUnpick(row, d, setVal, cur);
            if (multi) show();
            if (key.includes('|')) updateItemTitle(row.closest('.item'), ed.items[Number(key.split('|')[0])]);
          }));
        };
        pk.addEventListener('focus', show); pk.addEventListener('input', show);
        pk.addEventListener('blur', () => setTimeout(() => { if (!list.contains(shadow.activeElement)) list.hidden = true; }, 250));
        const nb = row.querySelector('[data-none]');
        if (nb) nb.addEventListener('click', () => {
          const e = listOf(d.f.l).find(x => String(x.id) === nb.dataset.none); const id = e ? e.id : nb.dataset.none;
          setVal(multi ? [id] : id); // None stands alone
          row.querySelector('.chosen').innerHTML = multi ? `<span>${esc(nameOf(d.f.l, id))} <a data-unpick="${esc(id)}" style="cursor:pointer">✕</a></span>` : esc(nameOf(d.f.l, id));
          wireUnpick(row, d, setVal, cur);
          if (key.includes('|')) updateItemTitle(row.closest('.item'), ed.items[Number(key.split('|')[0])]);
        });
        box.addEventListener('change', () => { if (!box.checked) { setVal(null); row.querySelector('.chosen').innerHTML = ''; } else { box.checked = !!cur().length; pk.focus(); } });
        wireUnpick(row, d, setVal, cur);
      }
    });
  }
  function wireUnpick(row, d, setVal, cur) { row.querySelectorAll('[data-unpick]').forEach(a => a.addEventListener('click', () => { setVal(cur().filter(x => String(x) !== a.dataset.unpick)); a.parentElement.remove(); })); }
  function updateItemTitle(card, it) { const h = card && card.querySelector('.ih'); if (h) h.firstChild.textContent = itemTitle(it); }
  const rootRef = (root) => { const f = (catalog.fields || []).find(x => x.i === root); return ({ 'vitals.vitalSigns': 'VITALSIGN', 'flowchartTreatments.treatments': 'FLOWCHARTTREATMENT', 'assessments.assessmentsV2': 'ASSESSMENT2', 'patient.patientMedicalHistories': 'PATIENTMEDICALHISTORY', 'patient.patientAllergies': 'PATIENTALLERGIES', 'patient.patientMedications': 'PATIENTMEDICATIONS', 'patient.patientPersonalItems': 'PATIENTPERSONALITEMS', 'narrative.supportingSignsAndSymptomsEnhanced.signsAndSymptomsEnhanced': 'SIGNSANDSYMPTOMSENHANCED', 'narrative.clinicalImpression.protocolsUsed.items': 'PROTOCOLSUSED', 'patient.patientImmunizations.items': 'PATIENTIMMUNIZATIONS' })[root] || (f ? f.r : root.toUpperCase()); };
  const rootType = (kind) => ['history', 'allergy', 'medication', 'belonging'].includes(kind) ? 'fieldGroup' : ['protocol', 'immunization'].includes(kind) ? 'collection' : 'collectionWithData';
  async function saveEditor() {
    if (!ed) return;
    const name = ed.name.trim();
    if (!name) { alert('ESO Save: give the template a name first.'); tplWin.querySelector('[data-name]').focus(); return; }
    // an item without its key (a treatment with no treatment picked, an empty vital) cannot be written
    const empty = ed.items.filter(it => !(it.kind === 'vital' || it.kind === 'assessment' ? (it.kind === 'assessment' ? (it.findings || []).length || Object.keys(it.fields).length : Object.keys(it.fields).length) : it.fields[ITEM_KEY[it.kind]]));
    if (empty.length) { alert(`ESO Save: ${empty.length === 1 ? 'one item is' : empty.length + ' items are'} empty (${empty.map(it => ITEM_ONE[it.kind] || it.kind).join(', ')}): pick ${empty.some(it => ITEM_KEY[it.kind]) ? 'what it is' : 'at least one value'}, or remove it.`); return; }
    const items = ed.items.map(it => { const { _open, _cat, ...rest } = it; return rest; });
    let body = { v: 1, fields: ed.fields, items };
    if (!isAdmin()) { const r = applyLocks(body); body = r.body; }
    if (!Object.keys(body.fields).length && !body.items.length) { alert('ESO Save: the template is empty. Tick at least one field.'); return; }
    if (!userId) { alert('ESO Save: ESO has not said who is signed in yet. Open a run, then save.'); return; }
    const btn = tplWin.querySelector('[data-act=save]'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      // one name per shared category across the agency (a "Refusal" shared to everyone and one
      // shared with named people may both exist; two shared to everyone may not); one name per
      // person among their private ones
      const clash = await tplNameTaken(name, ed.share, ed.id);
      if (clash) {
        btn.disabled = false; btn.textContent = 'Save';
        alert(`ESO Save: there is already a template called "${clash.name}" ${ed.share === 'everyone' ? 'shared to everyone' : ed.share === 'some' ? 'shared with named people' : 'of yours'}${clash.owner_id !== userId ? ` (made by ${clash.owner_name})` : ''}. Change the name a little, "${name}2" for instance.`);
        tplWin.querySelector('[data-name]').focus(); return;
      }
      const id = await tplSave({ id: ed.id, name, body, share: ed.share, people: ed.people });
      ed.id = id; await tplLoad();
      tplView = 'list'; ed = null; renderTemplates();
    } catch (e) { btn.disabled = false; btn.textContent = 'Save'; alert(/409/.test(e.message) ? `ESO Save: that name is already taken in this sharing. Change it a little, "${name}2" for instance.` : 'ESO Save: could not save the template (no signal, or the table is away). ' + e.message); }
  }
  // ---- the fill
  let tplFilling = null;
  function fillWithTemplate(t) {
    const run = currentRun();
    if (!run || run.locked) { alert('ESO Save: open an unlocked run first.'); return; }
    const { body, dropped } = applyLocks(onlyOffered(t.body || {}));
    for (const it of body.items) if (it.kind === 'assessment') it.findings = axComplete(it.findings);
    for (const f of Object.values(body.fields)) if (f && f.t === 'string' && typeof f.v === 'string') f.v = fillBlanks(f.v, run);
    for (const it of body.items) for (const f of Object.values(it.fields || {})) if (f && f.t === 'string' && typeof f.v === 'string') f.v = fillBlanks(f.v, run);
    const nf = Object.keys(body.fields).length, ni = body.items.length;
    if (!nf && !ni) { alert(`ESO Save: everything in "${t.name}" is locked by the agency, so there is nothing to fill.`); return; }
    const before = run.tplFilled && run.tplFilled[t.id];
    closeTemplates();
    askBox(`Fill this run from "${t.name}"?`, `${run.incidentNumber || 'This run'} gets ${nf} field${nf === 1 ? '' : 's'}${ni ? ` and ${ni} item${ni === 1 ? '' : 's'}` : ''} from the template. Anything already on the run for those fields is replaced.${dropped ? ` ${dropped} thing${dropped === 1 ? '' : 's'} in it ${dropped === 1 ? 'is' : 'are'} locked by the agency and left out.` : ''}${before && ni ? ' This template already filled this run once: its fields are written again; tick below to add its items (vitals, treatments, assessments…) a second time.' : ''}`, [['Yes, fill it', true], ['No', false]], (yes) => {
      if (!yes) return;
      const again = veilAgain;
      tplFilling = { name: t.name, at: Date.now() };
      showProgress(`Filling from "${t.name}"…`, 'Starting', 0);
      toPage('action', { name: 'fillTemplate', recordId: run.recordId, body, tplName: t.name, tplId: t.id, items: before && ni ? again : true });
    });
    if (before && ni && veil) {
      const box = veil.querySelector('.askbox');
      const lab = document.createElement('label'); lab.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;margin:0 0 12px;font-size:15px';
      lab.innerHTML = '<input type="checkbox" data-again style="width:22px;height:22px"> Add the items again';
      box.insertBefore(lab, box.querySelector('.actions'));
      veilAgain = false; lab.querySelector('input').addEventListener('change', (e) => { veilAgain = e.target.checked; });
    } else veilAgain = true;
  }
  let veilAgain = true;
  function showProgress(title, text, frac) {
    if (veil && veil.querySelector('.track')) { veil.querySelector('.prog').textContent = text; veil.querySelector('.fill').style.width = Math.round(frac * 100) + '%'; return; }
    hideVeil(); if (!shadow) return;
    veil = document.createElement('div'); veil.className = 'veil';
    veil.innerHTML = `<div class="box"><div class="spin"></div><h2>${esc(title)}</h2><div class="prog">${esc(text)}</div><div class="track"><div class="fill" style="width:${Math.round(frac * 100)}%"></div></div><div class="why">Every tab is written the way ESO's app saves it; with no signal it is held and pushed later.</div></div>`;
    shadow.appendChild(veil);
  }
  function onTemplateProgress(p) {
    if (!tplFilling) return;
    const label = (TPL_PAGES.find(([k]) => k === p.scope) || [])[1] || p.scope;
    showProgress(`Filling from "${tplFilling.name}"…`, `${label}: ${p.done} of ${p.total} fields${p.held ? ' (held, no signal)' : ''}`, p.total ? p.done / p.total : 0);
  }
  async function onTemplateFilled(p) {
    const name = tplFilling ? tplFilling.name : 'the template'; tplFilling = null;
    hideVeil();
    if (!p.ok) { const m = /^ESO refused the (\w+) tab: (HTTP \d+)(.*)$/.exec(p.error || ''); const w = p.written || []; alert(m ? `ESO Save: ESO would not take the ${m[1]} tab from "${name}" (${m[2]}${m[3] || ''}). ${w.length ? `Written before it: ${w.join(', ')}. Nothing after it was written.` : 'Nothing was written.'} Tell Michael which template it was; the details are in the ESO Save log.` : `ESO Save: could not fill from "${name}". ${p.error || ''}`); return; }
    if (p.refused && p.refused.length) alert(`ESO Save: ESO would not take ${p.refused.length} thing${p.refused.length === 1 ? '' : 's'} from "${name}" and ${p.refused.length === 1 ? 'it was' : 'they were'} left out:\n${p.refused.map(r => `• ${r.name} (${r.scope} tab): ${r.error}`).join('\n')}\nEverything else went in. Tell Michael; the details are in the ESO Save log.`);
    // the app shows what it has loaded: step off the open tab and back so it re-reads it
    const id = lastStatus && lastStatus.currentRecordId;
    const here = lastStatus && lastStatus.lastView && lastStatus.lastView.recordId === id ? lastStatus.lastView.view : null;
    if (here && id && TAB_LABELS[here]) {
      const away = tabElement(here === 'Incident' ? 'PATIENT' : 'INCIDENT'), back = tabElement(TAB_LABELS[here]);
      if (away && back) { away.click(); await waitViewLoaded(here === 'Incident' ? 'Patient' : 'Incident', id, 1500).catch(() => {}); back.click(); await waitViewLoaded(here, id, 3000).catch(() => {}); }
    }
    notice(`Filled from "${name}"`, `${p.total} fields across ${(p.scopes || []).length} tab${(p.scopes || []).length === 1 ? '' : 's'}${p.held ? ', held until ESO answers' : ''}. Check them over.`, 4500);
  }
  // ---- the unit's level, from ESO itself: the crew on the run and their certifications (the
  // agency's people in ESO's configuration bundle). A paramedic on the crew makes the unit ALS,
  // whatever they run it as; otherwise BLS. A unit named NT… is non-transport. Set once the unit
  // is known (the CAD import brings it), once per crew and unit, again when either changes.
  const unitLevelDone = {}; // recordId -> the crew+unit it was set for
  function crewLevel(run) {
    const people = (facilityTypes && facilityTypes.crew) || (facilities && facilities.crew) || null;
    if (!people || !run || !run.crewCerts || !run.crewCerts.length) return null;
    let known = false, als = false;
    for (const m of run.crewCerts) {
      const p = people.find(x => x.id === m.id); if (!p) continue;
      const cred = m.cert ? p.creds.find(c => c.id === m.cert) : null;
      const names = cred ? [cred.name] : p.creds.map(c => c.name); // no certification chosen on the run yet: what they hold
      if (!names.length) continue;
      known = true;
      if (names.some(n => /paramedic/i.test(n))) als = true;
    }
    return known ? (als ? 'ALS' : 'BLS') : null;
  }
  setInterval(async () => {
    const run = currentRun();
    if (settings.cadGate === false || !run || run.locked || quickBusy || autoBusy || !onTab('Incident') || shelfOpen() || warming) return;
    const level = crewLevel(run); if (!level) return;
    const cap = fieldReady('UNITCAPABILITYID'), loc = fieldReady('UNITSLEVELOFCAREID');
    if (!cap || !loc) return;
    const unit = norm(fieldValue('UNITID') || ''); const nt = /^NT/i.test(unit);
    if (!unit) return; // no unit yet (it comes with the CAD import): ground or non-transport is not known
    const key = `${run.crewCerts.map(c => c.id + ':' + c.cert).sort().join('|')}#${unit}#${level}`;
    if (unitLevelDone[run.recordId] === key) return;
    unitLevelDone[run.recordId] = key;
    quickBusy = true; lateVeil("Setting the unit's level…", `${level}${nt ? ', non-transport' : ''}`);
    try {
      await setSingle('UNITCAPABILITYID', nt ? `Non-Transport-Medical Treatment (${level} Equipped)` : `Ground Transport (${level} Equipped)`);
      await wait(60);
      await setSingle('UNITSLEVELOFCAREID', level === 'ALS' ? 'ALS-Paramedic' : 'BLS-Basic /EMT');
    } catch (e) { alert("ESO Save: could not set the unit's level. " + (e && e.message ? e.message : '')); }
    endVeil(); quickBusy = false; layoutQuick();
  }, 700);
  // a question or a notice in our own overlay: [label, value] buttons; the value goes to the callback
  function askBox(title, text, buttons, cb) {
    hideVeil();
    if (!shadow) return;
    veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML = `<div class="box askbox"><h2>${esc(title)}</h2><div class="why" style="font-size:15px;margin:10px 0 16px">${esc(text)}</div><div class="actions">${buttons.map(([l], i) => `<button class="a${i ? ' sec' : ''}" data-i="${i}">${esc(l)}</button>`).join('')}</div></div>`;
    veil.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { hideVeil(); if (cb) cb(buttons[Number(b.dataset.i)][1]); }));
    shadow.appendChild(veil);
  }
  function showVeilMessage(title, text) {
    hideVeil();
    if (!shadow) return;
    veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML = `<div class="box"><div class="spin"></div><h2>${esc(title)}</h2><div class="why">${esc(text)}</div></div>`;
    shadow.appendChild(veil);
  }
  // ---------------------------------------------------------------- send after lock
  function showSendPrompt(p) {
    if (settings.sendPrompt === false || !shadow) return;
    hideVeil();
    const dest = (p.fax.ok ? p.fax : p.email).destinationName || 'the destination';
    veil = document.createElement('div');
    veil.className = 'veil';
    veil.style.cursor = 'default';
    veil.innerHTML = `<div class="box"><h2>${esc(p.incidentNumber || 'This run')} is locked</h2>
      <div class="why">${p.historyKnown ? 'It has not been sent yet. ' : ''}Send the chart to <b>${esc(dest)}</b>?</div>
      <div class="row">${p.fax.ok ? '<button class="a" data-act="fax">Send fax</button>' : ''}${p.email.ok ? '<button class="a" data-act="email">Send email</button>' : ''}<button class="a sec" data-act="later">Not now</button></div>
      <div class="why" style="margin-top:10px">${p.fax.ok && p.email.ok ? '' : esc(p.fax.ok ? (p.email.error ? '' : '') : (p.fax.error || ''))}</div></div>`;
    veil.addEventListener('pointerdown', (e) => e.stopPropagation());
    veil.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'later') { hideVeil(); toPage('action', { name: 'note', recordId: p.recordId, msg: 'Not sent: the medic chose Not now. It will stay in the Not sent list.', level: 'warn' }); toPage('action', { name: 'scanUnsent' }); return; }
      showVeilMessage(act === 'fax' ? 'Sending fax…' : 'Sending email…', 'Asking ESO to send the chart to ' + dest + '.');
      toPage('action', { name: 'send', recordId: p.recordId, kind: act });
    });
    shadow.appendChild(veil);
  }
  function onSent(p) {
    hideVeil();
    const what = p.kind === 'fax' ? 'Fax' : 'Email';
    if (!p.ok) { alert(`ESO Save: could not ${p.kind} the run. ${p.error || ''}`); return; }
    if (p.held) { alert(`ESO Save: no signal right now. The ${p.kind} is held on this device and will be sent as soon as ESO answers.`); return; }
    showVeilMessage(`${what} sent`, `ESO accepted the ${p.kind}${p.destinationName ? ' to ' + p.destinationName : ''}.`);
    if (veil) { veil.querySelector('.spin').remove(); veil.style.cursor = 'default'; veil.addEventListener('click', hideVeil); }
    setTimeout(() => { if (veil && /sent/.test(veil.textContent)) hideVeil(); }, 2500);
    if (panelOpen) renderPanel();
  }
  async function onVitalCopied(p) {
    if (!p.ok) { copyBusy = false; hideVeil(); alert('ESO Save: ' + (p.error || 'could not copy the vital')); return; }
    // The app only shows what it has loaded: step off the tab and back so it re-reads the list.
    const id = lastStatus && lastStatus.currentRecordId;
    const away = tabElement('INCIDENT') || tabElement('PATIENT');
    const back = tabElement('VITALS');
    if (away && back) {
      away.click();
      await waitViewLoaded('Incident', id, 1500).catch(() => {});
      back.click();
      await waitViewLoaded('Vitals', id, 3000).catch(() => {});
    }
    copyBusy = false;
    hideVeil();
    if (p.held) setTimeout(() => alert('ESO Save: no signal right now. The copied vital is held on this device and will be pushed to ESO when signal returns.'), 50);
    setTimeout(decorateVitalRows, 300);
  }
  let rowTimer = null;
  const scheduleRows = (ms) => { clearTimeout(rowTimer); rowTimer = setTimeout(() => { decorateVitalRows(); layoutQuick(); }, ms); };
  const rowObserver = new MutationObserver((muts) => { if (muts.some(m => !ours(m.target) && !(m.target && m.target.classList && m.target.classList.contains('esosave-ride')))) scheduleRows(150); });
  const startRowObserver = () => { if (document.body) rowObserver.observe(document.body, { childList: true, subtree: true, characterData: true }); };
  if (document.body) startRowObserver(); else document.addEventListener('DOMContentLoaded', startRowObserver);
  // While the page scrolls, the layers slide with it by exactly the scrolled distance, one
  // transform per frame (Safari delivers scroll events unevenly; laying everything out on each
  // one made the buttons bounce). A full layout follows once the scrolling settles.
  function slideLayers() {
    const sheets = [quickLayer, copyLayer].map(l => l && l.firstElementChild).filter(Boolean);
    if (scroller && scrollBase) {
      const p = scrollPos(scroller);
      const t = `translate(${Math.round(scrollBase.x - p.x)}px, ${Math.round(scrollBase.y - p.y)}px)`;
      for (const s of sheets) if (s.style.transform !== t) s.style.transform = t;
    }
    if (Date.now() < scrollUntil) { scrollRaf = requestAnimationFrame(slideLayers); return; }
    scrollRaf = 0; scroller = null; scrollBase = null;
    for (const s of sheets) s.style.transform = '';
    decorateVitalRows(); layoutQuick();
  }
  addEventListener('scroll', (e) => {
    const el = e.target && e.target.nodeType === 9 ? document : e.target;
    if (!el || ours(el)) return;
    if (scroller !== el) { for (const s of [quickLayer, copyLayer].map(l => l && l.firstElementChild).filter(Boolean)) s.style.transform = ''; decorateVitalRows(); layoutQuick(); scroller = el; scrollBase = scrollPos(el); }
    scrollUntil = Date.now() + 160;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(slideLayers);
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (!copyButtons.size || ours(e.target)) return;
    const t = e.target && e.target.closest ? e.target.closest('a, button, [role="tab"], li') : null;
    const label = t && (t.innerText || t.textContent || '').trim().toUpperCase();
    if (label && Object.values(TAB_LABELS).includes(label) && t.getBoundingClientRect().top <= 260) { copyHiddenAt = Date.now(); if (copyLayer) copyLayer.style.display = 'none'; for (const r of rides.values()) r.copyLayer.style.display = 'none'; }
  }, true);
  addEventListener('resize', () => scheduleRows(60));
  setInterval(() => { decorateVitalRows(); layoutQuick(); }, 700);
})();
