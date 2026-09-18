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
  const DEFAULT_SETTINGS = { purgeHoursAfterLock: 0, probeSec: 20, heldProbeSec: 8, warmTabs: true, cardCollapsed: false, showTimes: true, sendPrompt: true, unsentList: true, quickHistory: true, quickMeds: true, quickAllergies: true, quickAcuity: true, quickDelays: true, quickTransport: true, quickAssess: true, quickDisposition: true, autoResponse: true, quickIncident: true, quickMechanism: true, quickFacilities: true, quickNarrative: true, quickPatient: true, quickRefusal: true, autoMileage: true, facilitySending: [], facilityDestination: [] };
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
  const OPEN_SETTINGS = ['quickHistory', 'quickMeds', 'quickAllergies', 'quickAcuity', 'quickDelays', 'quickTransport', 'quickAssess', 'quickDisposition', 'autoResponse', 'quickIncident', 'quickMechanism', 'quickFacilities', 'quickNarrative', 'quickPatient', 'quickRefusal', 'autoMileage', 'facilitySending', 'facilityDestination'];
  // The open settings follow the ESO login: one row per login in the agency's table, written when
  // the login is first seen and whenever they change something. Only these settings go there;
  // never a run, nor which runs were worked. The key is the project's public one.
  const ON_ESO = /(^|\.)esosuite\.net$/i.test(location.hostname);
  const SYNC = ON_ESO
    ? { url: 'https://qkprkwydxbtybaxylhln.supabase.co/rest/v1/esosave_users', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrcHJrd3lkeGJ0eWJheHlsaGxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzY2MTc2MjYsImV4cCI6MjA1MjE5MzYyNn0.DNjMTLqWtB7KJfZc3I03ufAPoIx69eA6wCkvhgdp7u4' }
    : { url: location.origin + '/__db/esosave_users', key: 'test-anon' };
  const openSettings = (src) => { const o = {}; for (const k of OPEN_SETTINGS) if (k in src) o[k] = src[k]; return o; };
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
    if (document.documentElement.hasAttribute('data-esosave')) await sendInit();
    setTimeout(() => toPage('action', { name: 'facilities' }), 1500);
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
      facilityTypes = { locationTypes: payload.locationTypes || [], destinationTypes: payload.destinationTypes || [] };
      await sset({ facilityTypes });
      if (panelOpen && settingsOpen) renderPanel(); layoutQuick();
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
    return { cls: 'good', title: 'ESO Save · signal OK', msg: (cur && cur.lastSavedAt ? `last save ${fmtTime(cur.lastSavedAt)}` : 'all saved') + (unsent ? ` · ${unsent} run${unsent === 1 ? '' : 's'} not faxed` : ''), num, btn: unsent ? 'Not sent' : null };
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
      `<div class="btns">${st.btn ? `<span class="btn" data-act="${st.btn === 'Push now' ? 'push' : 'open'}">${esc(st.btn)}</span>` : ''}<span class="btn" data-act="open">Runs</span></div>`;
    bar.querySelectorAll('.btn, .fold').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.act === 'push') toPage('action', { name: 'pushNow' });
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
      parts.push(`<div class="run">` +
        `<div class="lock">🔒 Set by the agency. These cannot be changed here.</div>` +
        `<label class="s locked">Clear a run from this device <input type="number" min="0" max="720" id="purge" value="${esc(settings.purgeHoursAfterLock)}" disabled> hours after it is locked (0 = as soon as the lock is seen)</label>` +
        `<label class="s locked"><input type="checkbox" id="warm" ${settings.warmTabs === false ? '' : 'checked'} disabled> Open every tab once, quietly, when a run opens (so tabs you have not touched still work with no signal)</label>` +
        `<label class="s locked"><input type="checkbox" id="times" ${settings.showTimes === false ? '' : 'checked'} disabled> Show the call times (dispatched, en route, on scene, at patient, depart, at destination, transfer) in the empty part of ESO's top bar</label>` +
        `<label class="s locked"><input type="checkbox" id="sendprompt" ${settings.sendPrompt === false ? '' : 'checked'} disabled> When a run is locked, offer to fax or email it to the destination if it has not been sent yet</label>` +
        `<label class="s locked"><input type="checkbox" id="unsentlist" ${settings.unsentList === false ? '' : 'checked'} disabled> Keep a list of locked runs from the last 15 days that have a fax or email destination but were never sent</label>` +
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
        `<label class="s"><input type="checkbox" id="qnarrative" ${settings.quickNarrative === false ? '' : 'checked'}> Narrative: rows for Primary and Secondary Impression, Provided Care Level, Anatomic Location and the complaint duration units (Narrative tab)</label>` +
        `<label class="s"><input type="checkbox" id="qpatient" ${settings.quickPatient === false ? '' : 'checked'}> Patient: Race row (every race, shortened) (Patient tab)</label>` +
        `<label class="s"><input type="checkbox" id="qrefusal" ${settings.quickRefusal === false ? '' : 'checked'}> Refusal form: chips for Legal, Decision-Making, Medical, Check All notifications and the four Patient Refusals inside ESO's Patient Refusal Form (Signatures tab)</label>` +
        `<label class="s"><input type="checkbox" id="qmileage" ${settings.autoMileage === false ? '' : 'checked'}> Loaded mileage: press ESO's Calculate Mileage once the scene and destination both have an address (Incident tab)</label>` +
        facilityPicker('facilitySending', 'Sending facility chips (Scene)') + facilityPicker('facilityDestination', 'Destination facility chips') +
        `<div class="actions"><button class="a" data-act="save-settings">Save</button></div></div>`);
    }
    if (settings.unsentList !== false) {
      const u = s.unsent;
      const items = u ? u.items : [];
      parts.push(`<div class="run unsent"><div class="head"><span class="num">Not sent yet</span><span class="muted">${u ? `locked in the last 15 days · checked ${fmtTime(u.at)}` : 'checking…'}</span></div>` +
        (items.length ? items.map(i => `<div class="urow" data-pcr="${esc(i.pcrId)}"><div><b>${esc(i.incidentNumber || '')}</b> · ${esc(fmtWhen(i.incidentDateTime))}<br><span class="muted">${esc(i.patientName || '')} → ${esc(i.destinationName || '')}</span></div><div class="actions">${i.fax ? '<button class="a" data-act="send-fax">Fax</button>' : ''}${i.email ? '<button class="a sec" data-act="send-email">Email</button>' : ''}</div></div>`).join('')
          : `<p class="muted">${u ? 'Every locked run with a fax or email destination has been sent.' : 'Looking at ESO\'s fax history and the locked runs…'}</p>`) +
        `<div class="actions"><button class="a sec" data-act="rescan">Check again</button></div></div>`);
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
  async function dbGet(name) {
    const r = await fetch(`${SYNC.url}?name=eq.${encodeURIComponent(name)}&select=name,settings,updated_at`, { headers: dbHeaders() });
    if (!r.ok) throw new Error('table ' + r.status);
    const rows = await r.json();
    return rows[0] || null;
  }
  async function dbPut(row) {
    const r = await fetch(SYNC.url, { method: 'POST', headers: { ...dbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error('table ' + r.status);
  }
  // A login just seen on this tablet: take their settings from the table (a new tablet gets what
  // they chose elsewhere); a login not yet in the table gets a row with what this tablet has.
  async function syncUser() {
    const who = user; if (!who) return;
    syncLastTry = Date.now();
    try {
      const row = await dbGet(who);
      // their row, or, for a login the table has never seen, the agency defaults: not whatever the
      // last person on this tablet chose
      Object.assign(settings, openSettings(row && row.settings && typeof row.settings === 'object' ? row.settings : DEFAULT_SETTINGS));
      await sset({ settings }); toPage('settings', settings); layoutQuick();
      await dbPut({ name: who, settings: openSettings(settings) });
      syncedUser = who; syncDirty = false;
    } catch (e) { syncDirty = true; } // no signal or the table is away: this tablet's settings stand, and the row is written later
    renderBar(); if (panelOpen) renderPanel();
  }
  // Something of theirs changed here: write the row.
  async function pushUser() {
    const who = user; if (!who) return;
    syncLastTry = Date.now();
    try {
      await dbPut({ name: who, settings: openSettings(settings) });
      syncedUser = who; syncDirty = false;
    } catch (e) { syncDirty = true; }
  }
  const openLogs = new Set();
  let settingsOpen = false;
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
      // the locked block is display only: its values come from the code
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
      layoutQuick();
      await sset({ settings }); toPage('settings', settings); settingsOpen = false; renderPanel(); renderTimes();
      pushUser();
    }
    else if (act === 'toggle-log') { if (openLogs.has(id)) openLogs.delete(id); else openLogs.add(id); renderPanel(); }
    else if (act === 'rescan') { toPage('action', { name: 'scanUnsent' }); }
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
  function squeezeNeighbours(bar, on) {
    if (!on) { for (const [el, st] of squeezed) el.setAttribute('style', st); squeezed.clear(); return false; }
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
    if (!bar) { if (timesEl) { timesEl.remove(); timesEl = null; timesKey = ''; } if (squeezed.size) squeezeNeighbours(null, false); return; }
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
    quickLayer = document.createElement('div'); quickLayer.className = 'quick'; shadow.appendChild(quickLayer);
    return quickLayer;
  }
  function quickEl(key, make) {
    let el = quickEls.get(key);
    if (!el) { el = make(); quickEls.set(key, el); ensureQuickLayer().appendChild(el); }
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
    const x = r.left + Math.min(24, r.width / 2), y = r.top + Math.min(12, r.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true; // off screen for now: nothing to say
    const top = document.elementsFromPoint(x, y).find(e => !(host && host.contains(e)));
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
    const btn = ok ? (g.field ? fieldEl(g.field) : anchorButton(g)) : null;
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
    const layer = ensureQuickLayer();
    const els = [];
    for (const [short, name, id] of [...g.chips, ...(g.noOther ? [] : [['Other…', null, 'other']])]) {
      const chip = quickEl(`${gk}:${id}`, () => {
        const c = document.createElement('button'); c.type = 'button'; c.className = 'chip' + (id === 'other' ? ' other' : ''); c.textContent = short; c.title = name || 'Open ESO\'s full list'; c.dataset.group = gk;
        c.addEventListener('pointerdown', (e) => e.stopPropagation());
        c.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (id === 'other') openNative(gk); else tapChip(gk, name, id); });
        return c;
      });
      chip.classList.toggle('added', id === 'all' ? g.all.every(n => isOn(n)) : id !== 'other' && isOn(name, id));
      chip.classList.toggle('on', id === 'all' ? g.all.some(n => pend(gk).has(n)) : id !== 'other' && pend(gk).has(name));
      chip.classList.toggle('off', id !== 'other' && id !== 'all' && pendOff(gk).has(name));
      chip.classList.toggle('busy', quickBusy);
      chip.style.display = 'block';
      chip.style.visibility = 'hidden';
      layer.appendChild(chip);
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
    const layer = ensureQuickLayer();
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
      layer.appendChild(chip);
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
    anatomic: { setting: 'quickNarrative', tab: 'Narrative', ref: 'CHIEFCOMPLAINTANATOMICLOCATIONID', what: 'Anatomic Location', noOther: true, items: [['Head', 'Head'], ['Neck', 'Neck'], ['Chest', 'Chest'], ['Abd', 'Abdomen'], ['Back', 'Back'], ['Upper Ext', 'Extremity-Upper'], ['Lower Ext', 'Extremity-Lower'], ['Genitalia', 'Genitalia'], ['General', 'General/Global']] },
    // Patient tab
    race: { setting: 'quickPatient', tab: 'Patient', ref: 'PATIENTRACEIDS', what: 'Race', noOther: true, items: [['White', 'White', 'White'], ['Black', 'Black or African American', 'Black'], ['Asian', 'Asian'], ['Latino', 'Hispanic or Latino'], ['Am Indian', 'American Indian or Alaska Native'], ['Mid East', 'Middle Eastern or North African'], ['Pac Islander', 'Native Hawaiian or Other Pacific Islander']] },
  };
  function layoutSingleRows() {
    const run = currentRun();
    for (const [rk, row] of Object.entries(SINGLE_ROWS)) {
      const f = settings[row.setting] === false || !run || run.locked || !onTab(row.tab || 'Incident') || shelfOpen() ? null : fieldEl(row.ref);
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
  function layoutQuick() {
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
    const cells = vitalTimeCells();
    if (!cells.length && !copyButtons.size) return;
    const layer = ensureCopyLayer();
    if (!layer) return;
    const keep = new Set();
    const seen = {};
    layer.style.display = copyHiddenAt && !(lastStatus.lastView && lastStatus.lastView.ts > copyHiddenAt) ? 'none' : '';
    for (const { el, text, rect, cell } of cells) {
      const time = text.padStart(8, '0');
      const nth = seen[time] = (seen[time] || 0);
      seen[time]++;
      let btn = copyButtons.get(el);
      if (!btn) { btn = makeCopyButton(); copyButtons.set(el, btn); layer.appendChild(btn); }
      keep.add(el);
      btn.dataset.time = time; btn.dataset.nth = String(nth);
      // hidden when something (the entry form, a menu) is drawn over the row
      const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 12), rect.top + rect.height / 2);
      const row = el.closest('tr') || (el.parentElement && el.parentElement.parentElement) || el.parentElement || el;
      const covered = hit && hit !== el && !el.contains(hit) && !row.contains(hit) && !(host && host.contains(hit));
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
  const rowObserver = new MutationObserver(() => scheduleRows(150));
  const startRowObserver = () => { if (document.body) rowObserver.observe(document.body, { childList: true, subtree: true, characterData: true }); };
  if (document.body) startRowObserver(); else document.addEventListener('DOMContentLoaded', startRowObserver);
  addEventListener('scroll', () => { scheduleRows(30); layoutQuick(); }, { capture: true, passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (!copyButtons.size || (host && e.composedPath().includes(host))) return;
    const t = e.target && e.target.closest ? e.target.closest('a, button, [role="tab"], li') : null;
    const label = t && (t.innerText || t.textContent || '').trim().toUpperCase();
    if (label && Object.values(TAB_LABELS).includes(label) && t.getBoundingClientRect().top <= 260) { copyHiddenAt = Date.now(); if (copyLayer) copyLayer.style.display = 'none'; }
  }, true);
  addEventListener('resize', () => scheduleRows(60));
  setInterval(() => { decorateVitalRows(); layoutQuick(); }, 700);
})();
