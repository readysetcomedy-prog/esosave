/* ESO Save - page-world interceptor.
 *
 * Runs inside the ESO EHR web app (www.esosuite.net) in the page's own JavaScript world so it can
 * wrap XMLHttpRequest, which is what the ESO app uses for every API call.
 *
 * What it does:
 *  - Records every autosave batch ESO's app sends, per run (patient care record).
 *  - When a save cannot reach ESO (no signal, gateway error), it HOLDS the batch on the device and
 *    tells the app "saved" so the medic can keep working. The banner stays amber until every held
 *    batch has really been accepted by ESO.
 *  - Pushes held batches in the original order as soon as ESO is reachable again, and remaps the
 *    temporary item keys the app invented offline to the keys ESO assigns.
 *  - Serves the last copy of each tab (view) while offline, with held changes applied, so switching
 *    tabs does not spin forever.
 *  - Can restore an entire recorded run into the run that is open, or into a brand-new run.
 *  - Snapshots every signature canvas as a PNG the moment the pen lifts, as a last-resort backup.
 *
 * It never invents data. It only replays what the app itself tried to send.
 */
(() => {
  'use strict';

  // The manifest also declares this file as a MAIN-world content script. On browsers that ignore
  // that (Safari) it would run in the isolated world instead, where wrapping XHR does nothing.
  const ext = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ||
              (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id);
  if (ext) return;
  if (window.__esosave) return;

  const VERSION = '0.1.0';
  const API_PREFIX_RE = /^\/ehr\/api\/+/i;
  const FAKE_OK_TEXT = '{"result":"Success","data":[]}';
  const PROBE_PATH = '/ehr/api/thirdpartydata/partners';

  const RealXHR = window.XMLHttpRequest;
  const realFetch = window.fetch ? window.fetch.bind(window) : null;

  // ------------------------------------------------------------------ state
  const S = {
    runs: Object.create(null),   // recordId -> run
    templates: null,             // { recordId, views: { Incident: text, ... } } blank views of a fresh run
    settings: { purgeHoursAfterLock: 24, probeSec: 20, heldProbeSec: 8 },
    online: navigator.onLine !== false,
    loggedOut: false,
    pushing: false,
    ready: false,                // stored state has been merged in
    xsrf: null,                  // last x-custom-xsrf-token seen on a live request
    currentRecordId: null,
    lastEvent: null,
    lastProbeAt: 0,
    rejectedSeen: false,
  };

  // ------------------------------------------------------------------ utils
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    }));
  const tryJSON = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pad = (n) => String(n).padStart(2, '0');
  function fmtEsoDate(d) {
    // "09/15/2026 14:08:24 -05:00" - local time with offset, the format the app itself sends.
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(a / 60 | 0)}:${pad(a % 60)}`;
  }
  function apiUrl(path) { return location.origin + '/ehr/api' + path; }

  function post(type, payload) {
    try { window.postMessage({ __esosave: 'to-ext', type, payload }, location.origin); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ runs
  function newRun(recordId) {
    return {
      recordId, realId: null, tmp: false, pendingCreate: null,
      incidentNumber: null, state: 'draft', locked: false, lockedAt: null,
      createdAt: Date.now(), lastSeenAt: Date.now(), lastSavedAt: null,
      nextSeq: 0, batches: [], keyMap: {}, views: {}, crew: null,
      restoredFrom: null, fresh: false, log: [],
    };
  }
  function getRun(recordId) {
    let r = S.runs[recordId];
    if (!r) { r = S.runs[recordId] = newRun(recordId); }
    r.lastSeenAt = Date.now();
    return r;
  }
  function touchCurrent(run) {
    if (S.currentRecordId !== run.recordId) { S.currentRecordId = run.recordId; emit(); }
  }
  const heldCount = (run) => run.batches.reduce((n, b) => n + (b.status === 'held' ? 1 : 0), 0);
  const hasHeld = (run) => run.batches.some(b => b.status === 'held');
  const needsPush = (run) => !!run.pendingCreate || hasHeld(run);

  function log(run, msg, level = 'info') {
    const entry = { ts: Date.now(), msg, level };
    if (run) { run.log.push(entry); if (run.log.length > 400) run.log.splice(0, run.log.length - 400); persist(run); }
    S.lastEvent = { ...entry, recordId: run ? run.recordId : null };
    emit();
  }

  const persistTimers = new Map();
  function persist(run, now) {
    clearTimeout(persistTimers.get(run.recordId));
    const flush = () => {
      persistTimers.delete(run.recordId);
      const { pushing, ...rest } = run;
      post('persistRun', { run: rest });
    };
    if (now) flush(); else persistTimers.set(run.recordId, setTimeout(flush, 250));
  }
  function persistAllNow() { for (const id of [...persistTimers.keys()]) { const r = S.runs[id]; if (r) persist(r, true); } }
  window.addEventListener('pagehide', persistAllNow);
  window.addEventListener('beforeunload', persistAllNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistAllNow(); });

  // ------------------------------------------------------------------ key remapping
  // ESO's app invents a GUID for every new list item (vital, treatment, finding, signature form...).
  // The server answers with {originalKey, newKey}; later edits must use newKey. When we held the
  // batch offline the app never learned newKey, so we rewrite on the way out.
  function resolveKey(map, k) {
    let cur = k, n = 0;
    while (map[cur] !== undefined && map[cur] !== cur && n++ < 16) cur = map[cur];
    return cur;
  }
  function rewriteKeys(text, map) {
    const keys = Object.keys(map);
    if (!keys.length) return text;
    const re = new RegExp(keys.map(escapeRe).join('|'), 'g');
    return text.replace(re, k => resolveKey(map, k));
  }
  function applyMappings(run, data) {
    if (!Array.isArray(data)) return;
    for (const m of data) {
      if (m && m.originalKey && m.newKey && m.originalKey !== m.newKey) run.keyMap[m.originalKey] = m.newKey;
    }
  }

  // ------------------------------------------------------------------ address parsing / offline view patching
  function parseAddress(addr) {
    const out = [];
    const re = /\['([^']*)'\]|[^.[\]]+/g;
    let m;
    while ((m = re.exec(addr))) out.push(m[1] !== undefined ? { key: m[1], bracket: true } : { key: m[0], bracket: false });
    return out;
  }
  function findItem(arr, key) {
    return arr.find(x => x && typeof x === 'object' ? String(x.itemId) === key : String(x) === key);
  }
  function applyOp(model, op, keyMap) {
    const toks = parseAddress(rewriteKeys(op.address, keyMap));
    if (toks.length < 2) return;
    toks.shift(); // scope root, e.g. "vitals." - the view model starts below it
    let cur = model;
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i], nxt = toks[i + 1];
      if (t.bracket) {
        if (Array.isArray(cur)) {
          let it = findItem(cur, t.key);
          if (!it) { it = { itemId: t.key }; cur.push(it); }
          cur = it;
        } else { cur = cur[t.key] ?? (cur[t.key] = {}); }
      } else {
        if (cur[t.key] == null || typeof cur[t.key] !== 'object') cur[t.key] = nxt.bracket ? [] : {};
        cur = cur[t.key];
      }
    }
    const last = toks[toks.length - 1];
    const val = op.value === undefined ? null : JSON.parse(rewriteKeys(JSON.stringify(op.value), keyMap));
    if (op.verb === 'DELETE') {
      if (last.bracket && Array.isArray(cur)) {
        const idx = cur.findIndex(x => x && typeof x === 'object' ? String(x.itemId) === last.key : String(x) === last.key);
        if (idx >= 0) cur.splice(idx, 1);
      } else if (Array.isArray(cur)) { /* nothing sensible */ } else { cur[last.key] = null; }
      return;
    }
    if (last.bracket) {
      if (Array.isArray(cur)) {
        const existing = findItem(cur, last.key);
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          if (existing && typeof existing === 'object') Object.assign(existing, val);
          else cur.push({ itemId: last.key, ...val });
        } else if (!existing) {
          cur.push(val === null ? last.key : val);
        }
      } else { cur[last.key] = val; }
    } else {
      cur[last.key] = val;
    }
  }
  function applyHeldToView(run, view, text) {
    const j = tryJSON(text);
    if (!j || !j.data || !j.data.model) return text;
    const scope = view.toLowerCase();
    for (const b of run.batches) {
      if (b.status !== 'held' && b.status !== 'pending') continue;
      if (String(b.scope).toLowerCase() !== scope) continue;
      for (const op of b.ops) { try { applyOp(j.data.model, op, run.keyMap); } catch (e) { /* best effort */ } }
    }
    if (j.meta && typeof j.meta === 'object') j.meta.esosaveOffline = true;
    return JSON.stringify(j);
  }

  // ------------------------------------------------------------------ raw requests (never intercepted)
  function rawRequest({ method, url, headers, body, timeout }) {
    return new Promise((resolve) => {
      let r;
      try {
        r = new RealXHR();
        r.open(method, url, true);
        r.withCredentials = true;
        for (const [k, v] of Object.entries(headers || {})) { try { r.setRequestHeader(k, v); } catch (e) { /* forbidden header */ } }
        if (timeout) r.timeout = timeout;
      } catch (e) { resolve({ status: 0, statusText: '', text: '', headers: '', url, netError: true, contentType: '' }); return; }
      const done = (netError) => resolve({
        status: netError ? 0 : r.status, statusText: netError ? '' : r.statusText,
        text: netError ? '' : (r.responseText || ''), headers: netError ? '' : (r.getAllResponseHeaders() || ''),
        url: r.responseURL || url, netError, contentType: netError ? '' : (r.getResponseHeader('content-type') || ''),
      });
      r.onload = () => done(false);
      r.onerror = () => done(true);
      r.ontimeout = () => done(true);
      r.onabort = () => done(true);
      try { r.send(body === undefined ? null : body); } catch (e) { done(true); }
    });
  }
  function headersFor(json) {
    const h = { accept: 'application/json, text/plain, */*' };
    if (json) h['content-type'] = 'application/json;charset=UTF-8';
    if (S.xsrf) h['x-custom-xsrf-token'] = S.xsrf;
    return h;
  }
  function outcome(res) {
    if (res.netError || res.status === 0) return 'net';
    if (res.status >= 500) return 'net';                 // Cloudflare 502/503/504 when ESO is unreachable
    if (res.status === 401 || res.status === 403) return 'auth';
    if (/text\/html/i.test(res.contentType || '')) return 'auth'; // bounced to the login page
    if (res.status >= 200 && res.status < 300) {
      const j = tryJSON(res.text);
      if (j && typeof j === 'object' && j.result && j.result !== 'Success') return 'rejected';
      return 'ok';
    }
    return 'rejected';
  }
  function fakeOk(text, url) {
    return { status: 200, statusText: 'OK', text, url, netError: false,
      contentType: 'application/json; charset=utf-8',
      headers: 'content-type: application/json; charset=utf-8\r\nx-esosave: held\r\n' };
  }
  function summarize(res) {
    const j = tryJSON(res.text);
    const msg = j && (j.message || j.error || j.responseStatus?.message || (Array.isArray(j.errors) && j.errors.join('; ')));
    return `HTTP ${res.status}${msg ? ': ' + String(msg).slice(0, 300) : (res.text ? ': ' + res.text.slice(0, 200) : '')}`;
  }

  // ------------------------------------------------------------------ connectivity
  function setOnline(v, why) {
    if (S.online === v) return;
    S.online = v;
    log(null, v ? 'Signal is back.' : ('NO SIGNAL' + (why ? ' - ' + why : '')), v ? 'good' : 'warn');
    if (v) kick(0);
  }
  function setLoggedOut(v) {
    if (S.loggedOut === v) return;
    S.loggedOut = v;
    log(null, v ? 'ESO logged you out. Held changes will push after you log back in.' : 'Logged in again.', v ? 'warn' : 'good');
    if (!v) kick(0);
  }
  async function probe() {
    S.lastProbeAt = Date.now();
    const res = await rawRequest({ method: 'GET', url: location.origin + PROBE_PATH, headers: headersFor(false), timeout: 8000 });
    const o = outcome(res);
    if (o === 'net') setOnline(false, 'ESO not reachable');
    else if (o === 'auth') { setOnline(true); setLoggedOut(true); }
    else { setOnline(true); setLoggedOut(false); }
    return o;
  }
  function anyHeld() { return Object.values(S.runs).some(needsPush); }
  setInterval(() => {
    const every = (anyHeld() || !S.online || S.loggedOut) ? S.settings.heldProbeSec : S.settings.probeSec;
    if (Date.now() - S.lastProbeAt >= every * 1000 - 50) probe().then(() => { if (S.online && !S.loggedOut && anyHeld()) kick(0); });
  }, 1000);
  window.addEventListener('online', () => { probe(); });
  window.addEventListener('offline', () => { setOnline(false, 'browser reports offline'); });

  // ------------------------------------------------------------------ push engine
  let kickTimer = null;
  function kick(delay) { clearTimeout(kickTimer); kickTimer = setTimeout(pushAll, delay == null ? 300 : delay); }
  async function pushAll() {
    if (S.pushing || S.loggedOut) return;
    if (!S.xsrf) return; // need the app's token; it arrives with the app's first request
    S.pushing = true; emit();
    try {
      for (const run of Object.values(S.runs)) {
        if (!needsPush(run)) continue;
        const ok = await pushRun(run);
        if (!ok) break;
      }
    } finally { S.pushing = false; emit(); }
  }
  async function sendBatch(run, targetId, batch) {
    const text = rewriteKeys(JSON.stringify(batch.ops), run.keyMap);
    return rawRequest({ method: 'POST', url: apiUrl(`/PatientCareRecords/${targetId}/autosave?scope=${encodeURIComponent(batch.scope)}`),
      headers: headersFor(true), body: text, timeout: 30000 });
  }
  function ack(run, batch, res) {
    batch.status = 'acked'; batch.ackedAt = Date.now();
    const j = tryJSON(res.text);
    batch.mappings = (j && Array.isArray(j.data)) ? j.data : [];
    applyMappings(run, batch.mappings);
    run.lastSavedAt = Date.now();
  }
  function reject(run, batch, res) {
    batch.status = 'rejected'; batch.error = summarize(res); batch.rejectedAt = Date.now();
    S.rejectedSeen = true;
    log(run, `ESO REJECTED a ${batch.scope} change (${batch.ops.length} field${batch.ops.length === 1 ? '' : 's'}): ${batch.error}`, 'error');
  }
  async function pushRun(run) {
    run.pushing = true;
    try {
      if (run.pendingCreate) {
        const res = await rawRequest({ method: 'POST', url: apiUrl('/PatientCareRecords'), headers: headersFor(true), body: run.pendingCreate.body, timeout: 30000 });
        const o = outcome(res);
        if (o === 'net') { setOnline(false); return false; }
        if (o === 'auth') { setLoggedOut(true); return false; }
        if (o !== 'ok') { log(run, 'ESO refused to create the run: ' + summarize(res), 'error'); run.pendingCreate = null; persist(run); return true; }
        const j = tryJSON(res.text);
        run.realId = j && j.data;
        run.keyMap[run.recordId] = run.realId;
        run.pendingCreate = null;
        log(run, 'Run created on ESO after signal returned.', 'good');
        await mapCrew(run, run.realId, run.crew);
        persist(run);
      }
      const target = run.realId || run.recordId;
      for (let i = 0; i < run.batches.length; i++) {
        const b = run.batches[i];
        if (b.status !== 'held') continue;
        const res = await sendBatch(run, target, b);
        const o = outcome(res);
        if (o === 'ok') { ack(run, b, res); persist(run); emit(); continue; }
        if (o === 'net') { b.attempts = (b.attempts || 0) + 1; setOnline(false, 'push failed'); return false; }
        if (o === 'auth') { setLoggedOut(true); return false; }
        reject(run, b, res); persist(run); emit();
      }
      if (!hasHeld(run)) log(run, `All changes for ${run.incidentNumber || 'this run'} are on ESO.`, 'good');
      return true;
    } finally { run.pushing = false; }
  }

  // Crew rows get a fresh itemId per run; signatures and treatments reference them.
  async function mapCrew(run, targetId, oldCrew) {
    const res = await rawRequest({ method: 'GET', url: apiUrl(`/PatientCareRecords/${targetId}/Views/Incident?getMultiPatientData=true&getPcrHeaderData=true`), headers: headersFor(false), timeout: 30000 });
    if (outcome(res) !== 'ok') return;
    const j = tryJSON(res.text);
    const crew = j && j.data && j.data.model && Array.isArray(j.data.model.crew) ? j.data.model.crew : null;
    observeMeta(run, j);
    if (!crew) return;
    run.crew = crew;
    for (const old of (oldCrew || [])) {
      const match = crew.find(c => c && old && c.personnelId === old.personnelId);
      if (match && old.itemId && match.itemId && match.itemId !== old.itemId) run.keyMap[old.itemId] = match.itemId;
    }
  }

  // Restore everything recorded for sourceId into targetId (or a brand-new run when targetId is null).
  async function restoreInto(sourceId, targetId) {
    const src = S.runs[sourceId];
    if (!src) return;
    if (!S.xsrf) { log(src, 'Open any ESO page first so the extension can see your session, then try again.', 'warn'); return; }
    let created = false;
    if (!targetId) {
      const res = await rawRequest({ method: 'POST', url: apiUrl('/PatientCareRecords'), headers: headersFor(true),
        body: JSON.stringify({ createdDateTime: fmtEsoDate(new Date()) }), timeout: 30000 });
      const o = outcome(res);
      if (o !== 'ok') { log(src, 'Could not create a new run: ' + (o === 'net' ? 'no signal' : summarize(res)), 'error'); if (o === 'net') setOnline(false); if (o === 'auth') setLoggedOut(true); return; }
      targetId = tryJSON(res.text).data;
      created = true;
    }
    if (targetId === sourceId) { log(src, 'Pushing this run back into itself.', 'info'); }
    const tgt = getRun(targetId);
    tgt.restoredFrom = sourceId;
    if (targetId !== sourceId) {
      for (const b of src.batches) for (const m of (b.mappings || [])) if (m.newKey && m.originalKey) tgt.keyMap[m.newKey] = m.originalKey;
      await mapCrew(tgt, targetId, src.crew);
    }
    let n = 0;
    for (const b of src.batches) {
      if (b.status === 'dropped') continue;
      tgt.batches.push({ seq: tgt.nextSeq++, ts: Date.now(), origTs: b.ts, scope: b.scope, ops: b.ops, status: 'held', attempts: 0, restored: true });
      n++;
    }
    persist(tgt);
    log(tgt, `${created ? 'Created a NEW run and queued' : 'Queued'} ${n} saved change${n === 1 ? '' : 's'} from ${src.incidentNumber || sourceId} ` +
      `into ${tgt.incidentNumber || (created ? 'the new run' : 'this run')}. Pushing now. ` +
      (created ? 'Open the new run from the records list when it finishes.' : 'Switch tabs to see the restored fields.'), 'good');
    kick(0);
  }

  // ------------------------------------------------------------------ observing responses
  function observeMeta(run, j) {
    if (!j || typeof j !== 'object') return;
    const meta = j.meta;
    if (meta && typeof meta.state === 'string') {
      run.state = meta.state;
      const locked = meta.state.toLowerCase() !== 'draft';
      setLocked(run, locked);
    }
    const model = j.data && j.data.model;
    const num = (model && (model.incidentNumber || (model.response && model.response.incidentNumber))) || null;
    if (num && run.incidentNumber !== num) { run.incidentNumber = num; persist(run); emit(); }
    const patients = j.data && j.data.optionalData && j.data.optionalData.patients;
    if (Array.isArray(patients)) {
      const me = patients.find(p => p && p.patientCareRecordId === (run.realId || run.recordId));
      if (me && typeof me.isLocked === 'boolean') setLocked(run, me.isLocked);
    }
    if (model && Array.isArray(model.crew) && model.crew.length && model.crew[0] && 'personnelId' in model.crew[0]) run.crew = model.crew;
  }
  function setLocked(run, locked) {
    if (locked && !run.locked) { run.locked = true; run.lockedAt = Date.now(); log(run, `Run ${run.incidentNumber || ''} is locked. It will be cleared from this device after ${S.settings.purgeHoursAfterLock} hour(s).`, 'good'); }
    else if (!locked && run.locked) { run.locked = false; run.lockedAt = null; log(run, 'Run unlocked again.', 'info'); }
  }

  // ------------------------------------------------------------------ request classification
  function classify(method, url) {
    let u;
    try { u = new URL(url, location.href); } catch { return null; }
    if (u.origin !== location.origin) return null;
    const path = u.pathname.replace(/\/{2,}/g, '/');
    if (!API_PREFIX_RE.test(path)) return null;
    const rest = path.replace(API_PREFIX_RE, '');
    const m = method.toUpperCase();
    const rec = /^PatientCareRecords(?:\/([^/]+))?(?:\/(.*))?$/i.exec(rest);
    if (rec) {
      const id = rec[1], tail = rec[2] || '';
      if (!id) return m === 'POST' ? { type: 'create', path, query: u.search } : { type: 'other', path };
      if (/^autosave$/i.test(tail) && m === 'POST') return { type: 'autosave', recordId: id, scope: u.searchParams.get('scope') || 'unknown', path, query: u.search };
      const v = /^Views\/([^/?]+)$/i.exec(tail);
      if (v && m === 'GET') return { type: 'view', recordId: id, view: v[1], path, query: u.search };
      return { type: 'record', recordId: id, tail, method: m, path, query: u.search };
    }
    return { type: 'other', path };
  }
  function rewriteUrl(url) {
    // A run created offline has a temporary id; once ESO assigns the real one, swap it in the URL.
    for (const run of Object.values(S.runs)) {
      if (run.tmp && run.realId && url.includes(run.recordId)) return url.split(run.recordId).join(run.realId);
    }
    return url;
  }

  // ------------------------------------------------------------------ pipeline (shared by XHR and fetch)
  async function pipeline(kind, req) {
    // req: { method, url, headers, body }
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) if (k.toLowerCase() === 'x-custom-xsrf-token' && v) S.xsrf = v;
    }
    switch (kind.type) {
      case 'autosave': return handleAutosave(kind, req);
      case 'view': return handleView(kind, req);
      case 'create': return handleCreate(kind, req);
      case 'record': return handleRecord(kind, req);
      default: {
        const res = await rawRequest(req);
        const o = outcome(res);
        if (o === 'net') setOnline(false, 'request failed'); else { setOnline(true); if (o === 'auth') setLoggedOut(true); else setLoggedOut(false); }
        return res;
      }
    }
  }
  async function handleAutosave(kind, req) {
    const run = getRun(kind.recordId);
    touchCurrent(run);
    const ops = tryJSON(req.body);
    if (!Array.isArray(ops)) return rawRequest(req);
    // The app re-sending exactly what is already held (a retry after an error it saw) must not
    // create duplicate list items when both copies are pushed.
    const opsText = JSON.stringify(ops);
    if (run.batches.some(b => b.status === 'held' && b.scope === kind.scope && JSON.stringify(b.ops) === opsText)) {
      return fakeOk(FAKE_OK_TEXT, req.url);
    }
    const batch = { seq: run.nextSeq++, ts: Date.now(), scope: kind.scope, ops, status: 'pending', attempts: 0 };
    run.batches.push(batch);
    const hold = (why) => {
      batch.status = 'held'; persist(run, true); emit(); kick(why === 'no signal' ? 2000 : 300);
      if (heldCount(run) === 1) log(run, `Holding changes for ${run.incidentNumber || 'this run'} on this device (${why}). They will push automatically.`, 'warn');
      return fakeOk(FAKE_OK_TEXT, req.url);
    };
    if (run.pendingCreate || run.pushing || hasHeld(run)) return hold('waiting for earlier changes');
    if (S.loggedOut) return hold('logged out');
    if (!S.online) return hold('no signal');
    const res = await rawRequest({ ...req, body: rewriteKeys(req.body, run.keyMap), url: rewriteUrl(req.url) });
    const o = outcome(res);
    if (o === 'ok') { ack(run, batch, res); setOnline(true); setLoggedOut(false); persist(run); emit(); return res; }
    if (o === 'net') {
      if (req.aborted && req.aborted()) { batch.status = 'aborted'; persist(run); return res; }
      setOnline(false, 'save did not reach ESO');
      return hold('no signal');
    }
    if (o === 'auth') { batch.status = 'held'; persist(run, true); setLoggedOut(true); return res; }
    reject(run, batch, res); persist(run, true);
    return res;
  }
  async function handleView(kind, req) {
    const run = getRun(kind.recordId);
    touchCurrent(run);
    if (run.tmp && !run.realId) return serveTemplate(run, kind.view, req.url);
    const res = await rawRequest({ ...req, url: rewriteUrl(req.url) });
    const o = outcome(res);
    if (o === 'ok') {
      setOnline(true); setLoggedOut(false);
      const j = tryJSON(res.text);
      run.views[kind.view] = { text: res.text, ts: Date.now() };
      observeMeta(run, j);
      if (run.fresh && j && j.data && !run.batches.some(b => String(b.scope).toLowerCase() === kind.view.toLowerCase())) captureTemplate(run, kind.view, res.text);
      persist(run);
      return res;
    }
    if (o === 'net') {
      setOnline(false, 'tab could not load');
      const cached = run.views[kind.view];
      if (cached) {
        log(run, `No signal: showing the saved copy of the ${kind.view} tab.`, 'warn');
        return fakeOk(applyHeldToView(run, kind.view, cached.text), req.url);
      }
      return res;
    }
    if (o === 'auth') setLoggedOut(true);
    return res;
  }
  async function handleCreate(kind, req) {
    const res = await rawRequest(req);
    const o = outcome(res);
    if (o === 'ok') {
      setOnline(true); setLoggedOut(false);
      const j = tryJSON(res.text);
      if (j && typeof j.data === 'string') {
        const run = getRun(j.data);
        run.fresh = true; run.createBody = req.body; run.createdAt = Date.now();
        touchCurrent(run); persist(run);
        log(run, 'New run started.', 'info');
      }
      return res;
    }
    if (o === 'net') {
      setOnline(false, 'could not start a run');
      if (S.templates && S.templates.views && S.templates.views.Incident) {
        const tmpId = 'esosave-' + uuid();
        const run = getRun(tmpId);
        run.tmp = true; run.pendingCreate = { body: req.body }; run.crew = S.templates.crew || null;
        run.incidentNumber = 'PENDING (no signal)';
        touchCurrent(run); persist(run);
        log(run, 'No signal: started the run on this device. ESO will assign the incident number when signal returns.', 'warn');
        return fakeOk(JSON.stringify({ result: 'Success', data: tmpId }), req.url);
      }
      log(null, 'No signal and no blank-run template saved yet, so ESO could not start a new run.', 'error');
      return res;
    }
    if (o === 'auth') setLoggedOut(true);
    return res;
  }
  async function handleRecord(kind, req) {
    const run = getRun(kind.recordId);
    if (run.tmp && !run.realId) {
      if (/^Attachments$/i.test(kind.tail)) return fakeOk(JSON.stringify({ data: { model: { attachments: [], incidentNumber: run.incidentNumber } }, meta: { state: 'draft' }, responseStatus: null }), req.url);
      if (/^Validate/i.test(kind.tail)) return fakeOk(JSON.stringify({ issues: [] }), req.url);
      return { status: 0, statusText: '', text: '', headers: '', url: req.url, netError: true, contentType: '' };
    }
    const res = await rawRequest({ ...req, url: rewriteUrl(req.url) });
    const o = outcome(res);
    if (o === 'ok') {
      setOnline(true); setLoggedOut(false);
      observeMeta(run, tryJSON(res.text));
      if (kind.method !== 'GET' && /lock|final|submit/i.test(kind.tail)) { setLocked(run, true); persist(run); }
    } else if (o === 'net') setOnline(false, 'request failed');
    else if (o === 'auth') setLoggedOut(true);
    return res;
  }

  // Blank views of a freshly created run, kept so a run can be started with no signal at all.
  function captureTemplate(run, view, text) {
    if (!S.templates || S.templates.recordId !== run.recordId) S.templates = { recordId: run.recordId, views: {}, crew: run.crew || null, ts: Date.now() };
    S.templates.views[view] = text;
    if (run.crew) S.templates.crew = run.crew;
    post('persistTemplates', { templates: S.templates });
  }
  function serveTemplate(run, view, url) {
    const t = S.templates && S.templates.views && S.templates.views[view];
    let text;
    if (t) {
      text = t.split(S.templates.recordId).join(run.recordId);
      const j = tryJSON(text);
      if (j && j.data && j.data.model) {
        if ('incidentNumber' in j.data.model) j.data.model.incidentNumber = run.incidentNumber;
        if (j.data.model.response && 'incidentNumber' in j.data.model.response) j.data.model.response.incidentNumber = run.incidentNumber;
        text = JSON.stringify(j);
      }
    } else {
      // No blank copy of this tab has been seen yet: hand the app the smallest thing that looks like one.
      const model = { crew: (S.templates && S.templates.crew) || run.crew || [], version: null };
      if (view === 'Incident') model.response = { incidentNumber: run.incidentNumber };
      text = JSON.stringify({
        data: { model, optionalData: { patients: [{ patientCareRecordId: run.recordId, isLocked: false, firstName: null, lastName: null }], pcrHeader: {} } },
        meta: { state: 'draft', esosaveSynthesized: true }, responseStatus: null,
      });
      log(run, `No signal: no saved blank copy of the ${view} tab yet, showing an empty one.`, 'warn');
    }
    return fakeOk(applyHeldToView(run, view, text), url);
  }

  // ------------------------------------------------------------------ XMLHttpRequest wrapper
  function deliver(xhr, res) {
    const rt = xhr.responseType || '';
    let response = res.text;
    if (rt === 'json') { response = tryJSON(res.text); if (response === undefined) response = null; }
    const props = {
      readyState: 4,
      status: res.netError ? 0 : res.status,
      statusText: res.netError ? '' : (res.statusText || ''),
      responseText: (rt === '' || rt === 'text') ? res.text : '',
      response,
      responseURL: res.url || xhr._es.url,
      responseXML: null,
    };
    for (const [k, v] of Object.entries(props)) {
      try { Object.defineProperty(xhr, k, { value: v, configurable: true, writable: false }); } catch (e) { /* ignore */ }
    }
    const hdrs = res.headers || '';
    try {
      Object.defineProperty(xhr, 'getAllResponseHeaders', { value: () => hdrs, configurable: true });
      Object.defineProperty(xhr, 'getResponseHeader', { value: (n) => { const m = new RegExp('^' + escapeRe(String(n)) + ':\\s*(.*)$', 'im').exec(hdrs); return m ? m[1].trim() : null; }, configurable: true });
    } catch (e) { /* ignore */ }
    const fire = (t) => { try { xhr.dispatchEvent(new ProgressEvent(t, { lengthComputable: false, loaded: 0, total: 0 })); } catch (e) { try { xhr.dispatchEvent(new Event(t)); } catch (_) { /* ignore */ } } };
    fire('readystatechange');
    fire(res.netError ? 'error' : 'load');
    fire('loadend');
  }

  class ESOSaveXHR extends RealXHR {
    constructor() { super(); this._es = { method: 'GET', url: '', headers: {}, async: true, virtual: false, sent: false }; }
    open(method, url, async, user, password) {
      this._es.method = String(method || 'GET');
      this._es.url = typeof url === 'string' ? url : String(url);
      this._es.async = async !== false;
      const kind = classify(this._es.method, this._es.url);
      this._es.kind = kind;
      const u = kind ? rewriteUrl(this._es.url) : this._es.url;
      return arguments.length > 2 ? super.open(method, u, async, user, password) : super.open(method, u);
    }
    setRequestHeader(name, value) {
      this._es.headers[name] = value;
      if (String(name).toLowerCase() === 'x-custom-xsrf-token' && value) S.xsrf = value;
      return super.setRequestHeader(name, value);
    }
    send(body) {
      const es = this._es;
      const rt = this.responseType || '';
      const kind = es.kind;
      const virtualizable = kind && es.async && (rt === '' || rt === 'text' || rt === 'json') && (body == null || typeof body === 'string');
      if (!virtualizable) {
        if (kind) {
          this.addEventListener('loadend', () => {
            if (this.status === 0) setOnline(false, 'request failed'); else setOnline(true);
          });
        }
        return super.send(body);
      }
      es.virtual = true;
      const req = { method: es.method, url: es.url, headers: es.headers, body: body == null ? undefined : body, timeout: this.timeout || 0, aborted: () => !!es.aborted };
      pipeline(kind, req).then(res => { if (!es.aborted) deliver(this, res); },
        () => { if (!es.aborted) deliver(this, { status: 0, statusText: '', text: '', headers: '', url: es.url, netError: true }); });
    }
    abort() { if (this._es.virtual) { this._es.aborted = true; return; } return super.abort(); }
  }
  window.XMLHttpRequest = ESOSaveXHR;

  // ------------------------------------------------------------------ fetch wrapper (ESO uses XHR, but be safe)
  if (realFetch) {
    window.fetch = async function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const method = (init && init.method) || (input && input.method) || 'GET';
        const kind = classify(method, url);
        const bodyOk = !init || init.body == null || typeof init.body === 'string';
        if (!kind || !bodyOk) return realFetch(input, init);
        const headers = {};
        const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
        h.forEach((v, k) => { headers[k] = v; });
        const res = await pipeline(kind, { method, url, headers, body: init && init.body != null ? init.body : undefined });
        if (res.netError) throw new TypeError('Failed to fetch');
        const rh = new Headers();
        for (const line of (res.headers || '').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) { try { rh.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch (e) { /* ignore */ } } }
        return new Response(res.text, { status: res.status, statusText: res.statusText, headers: rh });
      } catch (e) {
        if (e instanceof TypeError) throw e;
        return realFetch(input, init);
      }
    };
  }

  // ------------------------------------------------------------------ signature canvas snapshots
  const blankCache = new Map();
  function isBlank(c, url) {
    const k = c.width + 'x' + c.height;
    if (!blankCache.has(k)) { const b = document.createElement('canvas'); b.width = c.width; b.height = c.height; blankCache.set(k, b.toDataURL('image/png')); }
    return blankCache.get(k) === url;
  }
  function labelFor(c) {
    let el = c;
    for (let i = 0; i < 8 && el; i++) {
      let sib = el.previousElementSibling;
      while (sib) {
        const t = (sib.innerText || sib.textContent || '').trim();
        if (t && t.length < 120) return t;
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
      if (el) {
        const lab = el.querySelector('label, h1, h2, h3, h4, h5, legend, .title, [class*="title" i], [class*="label" i]');
        const t = lab && (lab.innerText || lab.textContent || '').trim();
        if (t && t.length < 120) return t;
      }
    }
    return 'Signature';
  }
  function snapshot(c) {
    try {
      const url = c.toDataURL('image/png');
      if (!url || url.length < 200 || isBlank(c, url) || c.__esosaveLast === url) return;
      c.__esosaveLast = url;
      post('sig', { recordId: S.currentRecordId, ts: Date.now(), label: labelFor(c), dataUrl: url, w: c.width, h: c.height });
    } catch (e) { /* tainted canvas or similar */ }
  }
  function onPointerUp(ev) {
    const path = ev.composedPath ? ev.composedPath() : [];
    let c = path.find(n => n && n.tagName === 'CANVAS');
    if (!c && ev.target && ev.target.closest) c = ev.target.closest('canvas');
    if (!c) return;
    setTimeout(() => snapshot(c), 120);
  }
  for (const t of ['pointerup', 'touchend', 'mouseup']) document.addEventListener(t, onPointerUp, true);

  // ------------------------------------------------------------------ status / messaging with the extension
  function summary(run) {
    const counts = { total: run.batches.length, held: 0, rejected: 0, acked: 0, pending: 0 };
    for (const b of run.batches) counts[b.status] = (counts[b.status] || 0) + 1;
    return {
      recordId: run.recordId, realId: run.realId, tmp: run.tmp, pendingCreate: !!run.pendingCreate,
      incidentNumber: run.incidentNumber, state: run.state, locked: run.locked, lockedAt: run.lockedAt,
      createdAt: run.createdAt, lastSeenAt: run.lastSeenAt, lastSavedAt: run.lastSavedAt,
      restoredFrom: run.restoredFrom, counts, log: run.log.slice(-60),
      hasViews: Object.keys(run.views).length, hasCrew: !!(run.crew && run.crew.length),
    };
  }
  function buildStatus() {
    const runs = Object.values(S.runs).map(summary).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return {
      version: VERSION, online: S.online, loggedOut: S.loggedOut, pushing: S.pushing, ready: S.ready, hasToken: !!S.xsrf,
      currentRecordId: S.currentRecordId, runs, lastEvent: S.lastEvent,
      held: runs.reduce((n, r) => n + r.counts.held + (r.pendingCreate ? 1 : 0), 0),
      rejected: runs.reduce((n, r) => n + r.counts.rejected, 0),
      hasTemplates: !!(S.templates && S.templates.views && S.templates.views.Incident),
    };
  }
  let emitTimer = null;
  function emit() {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => post('status', buildStatus()), 50);
  }

  function mergeStored(stored) {
    for (const [id, r] of Object.entries(stored || {})) {
      if (!r || !Array.isArray(r.batches)) continue;
      const mem = S.runs[id];
      if (!mem) { S.runs[id] = { ...newRun(id), ...r, pushing: false }; continue; }
      const merged = { ...newRun(id), ...r, pushing: false };
      merged.views = { ...(r.views || {}), ...(mem.views || {}) };
      merged.keyMap = { ...(r.keyMap || {}), ...(mem.keyMap || {}) };
      merged.crew = mem.crew || r.crew || null;
      merged.incidentNumber = mem.incidentNumber || r.incidentNumber || null;
      merged.state = mem.state || r.state;
      merged.log = [...(r.log || []), ...(mem.log || [])];
      for (const b of mem.batches) merged.batches.push({ ...b, seq: merged.nextSeq++ });
      S.runs[id] = merged;
    }
  }
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__esosave !== 'to-page') return;
    const { type, payload } = ev.data;
    try {
      if (type === 'init') {
        mergeStored(payload.runs);
        if (payload.templates && payload.templates.views) S.templates = payload.templates;
        if (payload.settings) Object.assign(S.settings, payload.settings);
        S.ready = true;
        emit();
        if (anyHeld()) { log(null, 'Found changes held from before. Pushing as soon as ESO answers.', 'warn'); kick(500); }
      } else if (type === 'settings') {
        Object.assign(S.settings, payload || {}); emit();
      } else if (type === 'action') {
        const a = payload || {};
        if (a.name === 'pushNow') { probe().then(() => kick(0)); }
        else if (a.name === 'pushIntoCurrent') { if (S.currentRecordId) restoreInto(a.recordId, S.currentRecordId); else log(S.runs[a.recordId], 'Open a run in ESO first, then push into it.', 'warn'); }
        else if (a.name === 'pushIntoNew') { restoreInto(a.recordId, null); }
        else if (a.name === 'retryRejected') { const run = S.runs[a.recordId]; if (run) { for (const b of run.batches) if (b.status === 'rejected') { b.status = 'held'; b.error = null; } persist(run); kick(0); } }
        else if (a.name === 'dropRejected') { const run = S.runs[a.recordId]; if (run) { for (const b of run.batches) if (b.status === 'rejected') b.status = 'dropped'; persist(run); emit(); } }
        else if (a.name === 'forget') { delete S.runs[a.recordId]; if (S.currentRecordId === a.recordId) S.currentRecordId = null; emit(); }
        else if (a.name === 'status') { emit(); }
      }
    } catch (e) { log(null, 'ESO Save internal error: ' + (e && e.message), 'error'); }
  });

  window.__esosave = Object.freeze({
    version: VERSION,
    status: buildStatus,
    run: (id) => { const r = S.runs[id]; return r ? JSON.parse(JSON.stringify({ ...r, pushing: undefined })) : null; },
    probe,
    kick: () => kick(0),
  });
  document.documentElement.setAttribute('data-esosave', VERSION);
  emit();
})();
