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

  const VERSION = '0.12.1';
  const API_PREFIX_RE = /^\/ehr\/api\/+/i;
  const FAKE_OK_TEXT = '{"result":"Success","data":[]}';
  const PROBE_PATH = '/ehr/api/thirdpartydata/partners';

  const RealXHR = window.XMLHttpRequest;
  const realFetch = window.fetch ? window.fetch.bind(window) : null;

  // ------------------------------------------------------------------ state
  const S = {
    runs: Object.create(null),   // recordId -> run
    templates: null,             // { recordId, views: { Incident: text, ... } } blank views of a fresh run
    // What the app requests when each tab opens (from a recording of the real app; grows as the
    // extension watches live tab loads). {id} is the record id.
    tabRequests: {
      Incident: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Incident?getMultiPatientData=true&getPcrHeaderData=true' }],
      Patient: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Patient' },
                { method: 'POST', url: '/ehr/api/WebApi?path=api/LongitudinalRecordDetails', body: '{"ehrEncounterId":"{id}"}' }],
      Vitals: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Vitals' },
               { method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/CardiacMonitor' }],
      FlowchartTreatments: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/FlowchartTreatments' },
                            { method: 'GET', url: '/ehr/api/thirdpartydata/partners' }],
      Assessments: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Assessments?getAssessmentListsData=true' }],
      Narrative: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Narrative' }],
      Forms: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Forms' }],
      Billing: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Billing' }],
      Signatures: [{ method: 'GET', url: '/ehr/api/PatientCareRecords/{id}/Views/Signatures' }],
    },
    apiCache: new Map(),         // "METHOD path?query body" -> last good response, served when ESO is unreachable
    learning: null,              // { view, recordId, until } while a live tab load is being watched
    // How the app names each vitals field when it saves it (path below the vital -> fieldRef, dataType).
    // Seeded from a recording of the real app; grows as live saves are observed.
    fieldDefs: {
      'bloodPressure.bloodPressureSystolic': ['BLOODPRESSURESYSTOLIC', 'string'], 'bloodPressure.bloodPressureDiastolic': ['BLOODPRESSUREDIASTOLIC', 'string'],
      'bloodPressure.bloodPressureMethodId': ['BLOODPRESSUREMETHODID', 'singleselect'], 'bloodPressure.shockIndex': ['SHOCKINDEX', 'string'],
      'revisedTraumaScore.revisedTraumaBp': ['REVISEDTRAUMABP', 'integer'], 'revisedTraumaScore.revisedTraumaRr': ['REVISEDTRAUMARR', 'integer'],
      'revisedTraumaScore.revisedTraumaGcs': ['REVISEDTRAUMAGCS', 'integer'], 'revisedTraumaScore.revisedTraumaTotalScore': ['REVISEDTRAUMATOTALSCORE', 'integer'],
      'pulse.pulseRate': ['PULSERATE', 'string'], 'pulse.pulseRhythmId': ['PULSERHYTHMID', 'singleselect'], 'pulse.pulseRateMethodID': ['PULSERATEMETHODID', 'singleselect'],
      'pulse.pulseStrengthId': ['PULSESTRENGTHID', 'singleselect'], 'glucoseAndTemp.temperatureF': ['TEMPERATUREF', 'string'],
      'glucoseAndTemp.temperatureMethodId': ['TEMPERATUREMETHODID', 'singleselect'], 'glucoseAndTemp.glucose': ['GLUCOSE', 'string'],
      'respiration.respirationRate': ['RESPIRATIONRATE', 'string'], 'respiration.respirationQualityId': ['RESPIRATIONQUALITYID', 'singleselect'],
      'respiration.respirationRhythmId': ['RESPIRATIONRHYTHMID', 'singleselect'], 'glasgowComaScale.glascowComaEyesId': ['GLASCOWCOMAEYESID', 'singleselect'],
      'glasgowComaScale.glascowComaMotorId': ['GLASCOWCOMAMOTORID', 'singleselect'], 'glasgowComaScale.glascowComaVerbalId': ['GLASCOWCOMAVERBALID', 'singleselect'],
      'glasgowComaScale.glascowComaTotalScore': ['GLASCOWCOMATOTALSCORE', 'integer'], 'glasgowComaScale.glasgowComaQualifierIds': ['GLASGOWCOMAQUALIFIERIDS', 'multiselect'],
      'painScaleTypeId': ['PAINSCALETYPEID', 'singleselect'], 'painScale': ['PAINSCALE', 'integer'], 'cardiacMonitoring.ecgTypeId': ['ECGTYPEID', 'singleselect'],
      'cardiacMonitoring.ecgRhythm': ['ECGRHYTHM', 'multiselect'], 'cardiacMonitoring.ecgMethodOfInterpretationIds': ['ECGMETHODOFINTERPRETATIONIDS', 'multiselect'],
      'cardiacMonitoring.ecgNotes': ['ECGNOTES', 'string'], 'cardiacMonitoring.isMISuspected': ['ISMISUSPECTED', 'boolean'],
      'avpuId': ['AVPUID', 'singleselect'], 'patientSide': ['PATIENTSIDE', 'integer'], 'patientPosture': ['PATIENTPOSTURE', 'integer'],
      'etCO2SPO2CO.spO2': ['SPO2', 'string'], 'etCO2SPO2CO.onOxygen': ['ONOXYGEN', 'boolean'], 'etCO2SPO2CO.etCO2mmHg': ['ETCO2MMHG', 'string'],
      'etCO2SPO2CO.etCO2Percentage': ['ETCO2PERCENTAGE', 'string'], 'etCO2SPO2CO.etCO2kPa': ['ETCO2KPA', 'string'], 'etCO2SPO2CO.coDecimal': ['CODECIMAL', 'string'],
      'flaccPainScale.flaccFaceId': ['FLACCFACEID', 'singleselect'], 'flaccPainScale.flaccLegsId': ['FLACCLEGSID', 'singleselect'], 'flaccPainScale.flaccActivityId': ['FLACCACTIVITYID', 'singleselect'],
      'flaccPainScale.flaccConsolabilityId': ['FLACCCONSOLABILITYID', 'singleselect'], 'flaccPainScale.flaccCryId': ['FLACCCRYID', 'singleselect'],
      'rassScore.rassScoreId': ['RASSSCOREID', 'singleselect'], 'rassScore.barsScoreId': ['BARSSCOREID', 'singleselect'],
      'pediatricTraumaScore.pediatricTraumaAirwayId': ['PEDIATRICTRAUMAAIRWAYID', 'singleselect'], 'pediatricTraumaScore.pediatricTraumaCnsId': ['PEDIATRICTRAUMACNSID', 'singleselect'],
      'pediatricTraumaScore.pediatricTraumaWoundsId': ['PEDIATRICTRAUMAWOUNDSID', 'singleselect'], 'pediatricTraumaScore.pediatricTraumaSizeId': ['PEDIATRICTRAUMASIZEID', 'singleselect'],
      'pediatricTraumaScore.pediatricTraumaBpId': ['PEDIATRICTRAUMABPID', 'singleselect'], 'pediatricTraumaScore.pediatricTraumaSkeletalId': ['PEDIATRICTRAUMASKELETALID', 'singleselect'],
      'pediatricTraumaScore.pediatricTraumaTotalScore': ['PEDIATRICTRAUMATOTALSCORE', 'integer'],
    },
    settings: { purgeHoursAfterLock: 0, probeSec: 20, heldProbeSec: 8, sendPrompt: true, unsentList: true },
    online: navigator.onLine !== false,
    loggedOut: false,
    pushing: false,
    ready: false,                // stored state has been merged in
    xsrf: null,                  // last x-custom-xsrf-token seen on a live request
    currentRecordId: null,
    lastEvent: null,
    lastView: null,              // { view, recordId, ts } of the most recent live tab load
    user: null,                  // the ESO login's full name, from the metadata ESO's views carry
    userId: null,                // and their agency person id, the same id the crew list uses
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
      sends: [], emailedAt: null,
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
  const heldSends = (run) => (run.sends || []).filter(x => x.status === 'held').length;
  const hasHeld = (run) => run.batches.some(b => b.status === 'held') || heldSends(run) > 0;
  const needsPush = (run) => !!run.pendingCreate || hasHeld(run);

  function log(run, msg, level = 'info') {
    const entry = { ts: Date.now(), msg, level };
    if (run) { run.log.push(entry); if (run.log.length > 400) run.log.splice(0, run.log.length - 400); persist(run); }
    S.lastEvent = { ...entry, recordId: run ? run.recordId : null };
    emit();
  }

  const persistTimers = new Map();
  function persist(run, now) {
    if (!run.batches.length && !run.pendingCreate) return; // nothing worth keeping yet
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
    if (res.status >= 500) {
      // 502/503/504 (and HTML error pages) mean ESO is unreachable. A 500 whose body is ESO's own
      // JSON is the server refusing this request: treating it as "no signal" would retry it forever.
      const j = res.status === 500 && /json/i.test(res.contentType || '') ? tryJSON(res.text) : null;
      return j && typeof j === 'object' ? 'rejected' : 'net';
    }
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
  // ------------------------------------------------------------------ tab prefetch
  // The moment a run is open (which needs signal), quietly fetch every tab's data so any tab can be
  // served from the saved copy if signal drops before the medic has opened it.
  const relUrl = (url) => { try { const u = new URL(url, location.href); return u.pathname.replace(/\/{2,}/g, '/') + u.search; } catch { return String(url); } };
  const templatize = (str, id) => (str && id) ? String(str).split(id).join('{id}') : str;
  const fill = (tpl, id) => String(tpl).split('{id}').join(id);
  const cacheKey = (method, url, body) => method.toUpperCase() + ' ' + relUrl(url) + (body ? ' ' + body : '');
  function cacheable(method, url) {
    const path = relUrl(url);
    if (!API_PREFIX_RE.test(path.split('?')[0].replace(/^\/+/, '/'))) return false;
    if (/\/autosave\b/i.test(path)) return false;
    const m = method.toUpperCase();
    if (m === 'GET') return true;
    return m === 'POST' && /\/WebApi\b/i.test(path);
  }
  function cachePut(method, url, body, res) {
    if (!cacheable(method, url) || outcome(res) !== 'ok') return;
    S.apiCache.set(cacheKey(method, url, body), { status: res.status, text: res.text, contentType: res.contentType, ts: Date.now() });
    if (S.apiCache.size > 400) S.apiCache.delete(S.apiCache.keys().next().value);
  }
  function cacheGet(method, url, body) { return S.apiCache.get(cacheKey(method, url, body)) || null; }
  function cachedResponse(entry, url) {
    return { status: entry.status, statusText: 'OK', text: entry.text, url, netError: false, contentType: entry.contentType || 'application/json; charset=utf-8',
      headers: `content-type: ${entry.contentType || 'application/json; charset=utf-8'}\r\nx-esosave: cached\r\n` };
  }

  function noteTabRequest(view, method, urlTpl, bodyTpl) {
    if (!view || !urlTpl) return false;
    const list = S.tabRequests[view] || (S.tabRequests[view] = []);
    if (list.some(r => r.method === method && r.url === urlTpl && (r.body || '') === (bodyTpl || ''))) return false;
    if (list.length >= 12) return false;
    list.push(bodyTpl ? { method, url: urlTpl, body: bodyTpl } : { method, url: urlTpl });
    post('persistTabRequests', { tabRequests: S.tabRequests });
    return true;
  }
  // A live tab load: remember its own request, then watch the next few seconds for the companion
  // requests the app makes for that tab.
  function learnTab(view, recordId, req) {
    noteTabRequest(view, 'GET', templatize(relUrl(req.url), recordId));
    S.learning = { view, recordId, until: Date.now() + 3000 };
  }
  function maybeLearnCompanion(req) {
    const L = S.learning;
    if (!L || Date.now() > L.until) { S.learning = null; return; }
    if (!cacheable(req.method, req.url) || /configurationBundle|\/Views\//i.test(req.url)) return;
    noteTabRequest(L.view, req.method.toUpperCase(), templatize(relUrl(req.url), L.recordId), templatize(req.body, L.recordId));
  }

  const prefetchTimers = new Map();
  function schedulePrefetch(run, { force = false, delay = 1500 } = {}) {
    if (run.tmp && !run.realId) return;
    if (run.locked) return;
    clearTimeout(prefetchTimers.get(run.recordId));
    prefetchTimers.set(run.recordId, setTimeout(() => { prefetchTimers.delete(run.recordId); prefetchViews(run, force); }, delay));
  }
  async function prefetchViews(run, force) {
    if (!S.online || S.loggedOut || !S.xsrf) return;
    if (run.prefetching) return;
    run.prefetching = true;
    const id = run.realId || run.recordId;
    try {
      let tabs = 0;
      for (const [view, reqs] of Object.entries(S.tabRequests)) {
        if (!S.online || S.loggedOut) break;
        let gotTab = false;
        for (const r of reqs) {
          const url = location.origin + fill(r.url, id);
          const body = r.body ? fill(r.body, id) : undefined;
          if (!force && cacheGet(r.method, url, body)) { if (/\/Views\//i.test(url)) gotTab = true; continue; }
          const res = await rawRequest({ method: r.method, url, headers: headersFor(!!body), body, timeout: 20000 });
          const o = outcome(res);
          if (o === 'net') { setOnline(false, 'tab prefetch failed'); run.prefetching = false; return; }
          if (o !== 'ok') continue;
          cachePut(r.method, url, body, res);
          if (/\/Views\//i.test(url)) {
            const j = tryJSON(res.text);
            if (j && j.data && j.data.model) {
              run.views[view] = { text: res.text, ts: Date.now(), prefetched: true };
              observeMeta(run, j);
              if (run.fresh && !run.batches.some(b => String(b.scope).toLowerCase() === view.toLowerCase())) captureTemplate(run, view, res.text);
              gotTab = true;
            }
          }
          await new Promise(res2 => setTimeout(res2, 150));
        }
        if (gotTab) tabs++;
      }
      run.prefetchedAt = Date.now();
      persist(run);
      log(run, `Saved a copy of ${tabs} tab${tabs === 1 ? '' : 's'} for offline use.`, 'info');
    } finally { run.prefetching = false; }
  }

  function setOnline(v, why) {
    if (S.online === v) return;
    S.online = v;
    log(null, v ? 'Signal is back.' : ('NO SIGNAL' + (why ? ' - ' + why : '')), v ? 'good' : 'warn');
    if (v) { kick(0); const cur = S.currentRecordId && S.runs[S.currentRecordId]; if (cur) schedulePrefetch(cur, { force: true, delay: 4000 }); }
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
        schedulePrefetch(run, { force: true, delay: 3000 });
        persist(run);
      }
      const target = run.realId || run.recordId;
      for (let i = 0; i < run.batches.length; i++) {
        const b = run.batches[i];
        if (b.status !== 'held') continue;
        const res = await sendBatch(run, target, b);
        const o = outcome(res);
        if (o === 'ok') { ack(run, b, res); persist(run); emit(); continue; }
        if (o === 'net' && !(b.synthetic && (b.attempts || 0) >= 2)) { b.attempts = (b.attempts || 0) + 1; setOnline(false, 'push failed'); return false; }
        if (o === 'auth') { setLoggedOut(true); return false; }
        if (b.synthetic) { b.status = 'dropped'; b.error = summarize(res); log(run, `ESO refused the copied vital, so it was dropped (${b.error}). Enter it by hand.`, 'error'); persist(run); emit(); continue; }
        reject(run, b, res); persist(run); emit();
      }
      for (const x of (run.sends || [])) {
        if (x.status !== 'held') continue;
        const res = await sendCall(target, x.kind);
        const o = outcome(res);
        if (o === 'net') { setOnline(false, 'send failed'); return false; }
        if (o === 'auth') { setLoggedOut(true); return false; }
        if (o === 'ok') { x.status = 'sent'; x.sentAt = Date.now(); if (x.kind === 'email') { run.emailedAt = Date.now(); post('persistEmailed', { pcrId: target, ts: run.emailedAt }); } log(run, `${x.kind === 'fax' ? 'Fax' : 'Email'} sent to ${x.destinationName || 'the destination'} now that signal is back.`, 'good'); }
        else { x.status = 'failed'; x.error = summarize(res); log(run, `ESO refused the ${x.kind} that was held: ${x.error}`, 'error'); }
        persist(run); emit(); scheduleUnsentScan(5000);
      }
      if (!hasHeld(run)) {
        const bad = run.batches.filter(b => b.status === 'rejected').length;
        log(run, bad ? `Pushed everything ESO would take for ${run.incidentNumber || 'this run'}; ${bad} change${bad === 1 ? '' : 's'} rejected (see above).` : `All changes for ${run.incidentNumber || 'this run'} are on ESO.`, bad ? 'warn' : 'good');
      }
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
  // Which tab a saved change belongs to. Scopes the app uses match the tab names; anything else
  // (e.g. the record header) travels with the Incident tab.
  const PAGE_SCOPES = ['incident', 'patient', 'vitals', 'flowchartTreatments', 'assessments', 'narrative', 'forms', 'billing', 'signatures'];
  function pageOf(scope) {
    const s = String(scope || '').toLowerCase();
    return PAGE_SCOPES.find(p => p.toLowerCase() === s) || 'incident';
  }
  async function restoreInto(sourceId, targetId, pages) {
    const src = S.runs[sourceId];
    if (!src) return;
    const wanted = Array.isArray(pages) && pages.length ? new Set(pages) : null; // null = every page
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
      if (wanted && !wanted.has(pageOf(b.scope))) continue;
      tgt.batches.push({ seq: tgt.nextSeq++, ts: Date.now(), origTs: b.ts, scope: b.scope, ops: b.ops, status: 'held', attempts: 0, restored: true });
      n++;
    }
    persist(tgt);
    const pagesTxt = wanted ? ` (pages: ${[...wanted].join(', ')})` : ' (every page)';
    log(tgt, `${created ? 'Created a NEW run and queued' : 'Queued'} ${n} saved change${n === 1 ? '' : 's'} from ${src.incidentNumber || sourceId}${pagesTxt} ` +
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
    // who is signed in to ESO: every view carries the login's name. A run belongs to the login
    // that first worked it on this device.
    const who = meta && meta.user && typeof meta.user.fullName === 'string' ? meta.user.fullName.trim() : '';
    if (who && !meta.esosaveOffline && !meta.esosaveSynthesized) {
      const pid = typeof meta.user.agencyPersonId === 'string' ? meta.user.agencyPersonId : null;
      if (S.user !== who || S.userId !== pid) { S.user = who; S.userId = pid; emit(); }
      if (!run.owner) { run.owner = who; persist(run); emit(); }
    }
    const model = j.data && j.data.model;
    const num = (model && (model.incidentNumber || (model.response && model.response.incidentNumber))) || null;
    if (num && run.incidentNumber !== num) { run.incidentNumber = num; persist(run); emit(); }
    if (model && model.incidentTimes && typeof model.incidentTimes === 'object') {
      const t = {};
      for (const [k, v] of Object.entries(model.incidentTimes)) if (/Time$/.test(k)) t[k] = v == null ? null : hhmm(v);
      if (JSON.stringify(t) !== JSON.stringify(run.times || {})) { run.times = t; emit(); }
    }
    const patients = j.data && j.data.optionalData && j.data.optionalData.patients;
    if (Array.isArray(patients)) {
      const me = patients.find(p => p && p.patientCareRecordId === (run.realId || run.recordId));
      if (me && typeof me.isLocked === 'boolean') setLocked(run, me.isLocked);
    }
    if (model && Array.isArray(model.crew) && model.crew.length && model.crew[0] && 'personnelId' in model.crew[0]) run.crew = model.crew;
  }
  // ESO stores a call time as "01/01/1890 13:05:00": only the clock part means anything.
  function hhmm(v) { const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(v)); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; }
  const TIME_ADDR_RE = /^incident\.incidentTimes\.(\w+Time)$/;
  function noteTimes(run, ops) {
    let changed = false;
    for (const op of ops) {
      const m = TIME_ADDR_RE.exec(op.address || '');
      if (!m || op.verb === 'ADD') continue;
      const v = op.verb === 'DELETE' || op.value == null ? null : hhmm(op.value);
      run.times = run.times || {};
      if (run.times[m[1]] !== v) { run.times[m[1]] = v; changed = true; }
    }
    if (changed) emit();
  }
  // What the Patient and Narrative tabs hold, for the quick buttons: which history items are on
  // the run and which acuity is set. Read from the served tab, then kept current from the app's
  // own saves (and the extension's held ones).
  function noteLists(run, view, j) {
    const model = j && j.data && j.data.model;
    if (!model) return;
    if (view === 'Patient') {
      run.lists = run.lists || {};
      const ids = (a) => Array.isArray(a) ? a.map(x => x && x.itemId).filter(x => x != null) : [];
      if (Array.isArray(model.patientMedicalHistories)) run.lists.histories = ids(model.patientMedicalHistories);
      if (Array.isArray(model.patientMedications)) run.lists.meds = ids(model.patientMedications);
      if (Array.isArray(model.patientAllergies)) run.lists.allergies = ids(model.patientAllergies);
      run.lists.historyNone = model.patientHistoriesPertinentNegativeId || null;
    }
    if (view === 'Narrative' && model.patientComplaint) {
      run.lists = run.lists || {};
      run.lists.initialAcuity = model.patientComplaint.initialPatientAcuityId || null;
      run.lists.finalAcuity = model.patientComplaint.finalPatientAcuityId || null;
    }
    if (view === 'Narrative' && model.patientTransport) {
      run.lists = run.lists || {};
      for (const k of TRANSPORT_KEYS) run.lists[k] = Array.isArray(model.patientTransport[k]) ? model.patientTransport[k].map(Number) : [];
    }
    if (view === 'Narrative' && model.injuries) {
      run.lists = run.lists || {};
      run.lists.mechanismOfInjuryIds = Array.isArray(model.injuries.mechanismOfInjuryIds) ? model.injuries.mechanismOfInjuryIds.map(Number) : [];
    }
  }
  const TRANSPORT_KEYS = ['howPatientWasMovedToStretcherIds', 'patientMovedFromSceneToAmbulanceMethodIds', 'patientMovedFromAmbulanceToDestinationMethodIds', 'patientPositionDuringTransportIds'];
  const TRANSPORT_ADDR_RE = /^narrative\.(?:patientTransport|injuries)\.(\w+Ids)\.\['(\d+)'\]$/;
  const LIST_ADDR_RE = /^patient\.(patientMedicalHistories|patientMedications|patientAllergies)\.\['(\d+)'\]$/;
  const LIST_KEY = { patientMedicalHistories: 'histories', patientMedications: 'meds', patientAllergies: 'allergies' };
  const CREW_ADDR_RE = /^incident\.crew\.\['([^']+)'\]$/;
  function noteListOps(run, ops) {
    let changed = false;
    for (const op of ops) {
      const c = CREW_ADDR_RE.exec(op.address || '');
      if (c) {
        run.crew = run.crew || [];
        if (op.verb === 'ADD' && op.value && typeof op.value === 'object' && op.value.personnelId && !run.crew.some(x => x && x.itemId === c[1])) { run.crew.push({ itemId: c[1], ...op.value }); changed = true; }
        if (op.verb === 'DELETE' && run.crew.some(x => x && x.itemId === c[1])) { run.crew = run.crew.filter(x => !(x && x.itemId === c[1])); changed = true; }
        continue;
      }
      const m = LIST_ADDR_RE.exec(op.address || '');
      if (m) {
        const k = LIST_KEY[m[1]];
        run.lists = run.lists || {}; run.lists[k] = run.lists[k] || [];
        const id = Number(m[2]);
        if (op.verb === 'ADD' && !run.lists[k].includes(id)) { run.lists[k].push(id); changed = true; }
        if (op.verb === 'DELETE' && run.lists[k].includes(id)) { run.lists[k] = run.lists[k].filter(x => x !== id); changed = true; }
        continue;
      }
      const t = TRANSPORT_ADDR_RE.exec(op.address || '');
      if (t && (TRANSPORT_KEYS.includes(t[1]) || t[1] === 'mechanismOfInjuryIds')) {
        run.lists = run.lists || {}; run.lists[t[1]] = run.lists[t[1]] || [];
        const id = Number(t[2]);
        if (op.verb === 'ADD' && !run.lists[t[1]].includes(id)) { run.lists[t[1]].push(id); changed = true; }
        if (op.verb === 'DELETE' && run.lists[t[1]].includes(id)) { run.lists[t[1]] = run.lists[t[1]].filter(x => x !== id); changed = true; }
        continue;
      }
      if (op.address === 'narrative.patientComplaint.initialPatientAcuityId') { run.lists = run.lists || {}; run.lists.initialAcuity = op.value == null ? null : op.value; changed = true; }
      if (op.address === 'narrative.patientComplaint.finalPatientAcuityId') { run.lists = run.lists || {}; run.lists.finalAcuity = op.value == null ? null : op.value; changed = true; }
      if (op.address === 'patient.patientHistoriesPertinentNegativeId') { run.lists = run.lists || {}; run.lists.historyNone = op.value == null ? null : op.value; changed = true; }
    }
    if (changed) emit();
  }
  function setLocked(run, locked) {
    if (locked && !run.locked) { run.locked = true; run.lockedAt = Date.now(); log(run, `Run ${run.incidentNumber || ''} is locked. It will be cleared from this device${Number(S.settings.purgeHoursAfterLock) ? ' after ' + S.settings.purgeHoursAfterLock + ' hour(s)' : ' now'}.`, 'good'); }
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
      for (const [k, v] of Object.entries(req.headers)) if (k.toLowerCase() === 'x-custom-xsrf-token' && v) {
        const first = !S.xsrf;
        S.xsrf = v;
        if (first && anyHeld()) kick(300); // held changes were waiting on the app's token: push now
      }
    }
    if (kind.type !== 'view' && kind.type !== 'autosave' && kind.type !== 'create') maybeLearnCompanion(req);
    switch (kind.type) {
      case 'autosave': return handleAutosave(kind, req);
      case 'view': return handleView(kind, req);
      case 'create': return handleCreate(kind, req);
      case 'record': return handleRecord(kind, req);
      default: {
        const res = await rawRequest(req);
        const o = outcome(res);
        if (o === 'net') {
          setOnline(false, 'request failed');
          const hit = cacheGet(req.method, req.url, req.body);
          if (hit) return cachedResponse(hit, req.url);
        } else {
          // A GET here may have been answered by the browser's own cache while offline, so only a
          // POST (never cached) counts as proof that ESO is reachable.
          if (req.method.toUpperCase() === 'POST') setOnline(true);
          if (o === 'auth') setLoggedOut(true); else { setLoggedOut(false); cachePut(req.method, req.url, req.body, res); if (o === 'ok' && /configurationBundle/i.test(kind.path)) learnBundle(res.text); }
        }
        return res;
      }
    }
  }
  // ------------------------------------------------------------------ ESO's configuration bundle
  // Fetched by the app on every tab switch; it carries every pick list, including the agency's
  // saved facilities (UDL.LOCATIONS, each with its location type). Parsed once per version.
  let bundleSeen = null;
  function learnBundle(text) {
    const head = text.slice(0, 200);
    const ver = /"bundleVersion"\s*:\s*"([^"]+)"/.exec(head);
    if (ver && ver[1] === bundleSeen) return;
    let j; try { j = JSON.parse(text); } catch (e) { return; }
    const lists = j && j.lists;
    if (!lists || !lists['UDL.LOCATIONS']) return;
    bundleSeen = ver ? ver[1] : String(Date.now());
    const vals = (k) => (lists[k] && Array.isArray(lists[k].values)) ? lists[k].values : [];
    S.facilities = {
      at: Date.now(),
      items: vals('UDL.LOCATIONS').filter(x => x && x.itemId && x.itemName).map(x => ({ id: x.itemId, name: x.itemName, typeId: x.locationTypeId || null, city: x.city || null })),
      locationTypes: vals('SL.LOCATIONTYPE').map(x => ({ id: x.itemId, name: x.itemName })),
      destinationTypes: vals('SL.DESTINATIONTYPE').map(x => ({ id: x.itemId, name: x.itemName, locationTypeId: x.parentItemId || null })),
    };
    post('facilities', S.facilities);
  }
  // ------------------------------------------------------------------ fax / email after lock
  // ESO's own calls, recorded from the app: GET .../Fax/CanSend and .../Email/canSend answer
  // {ok, destinationName, error}; POST .../Fax/Send and .../Email/Send take {sendDateTime};
  // POST /FaxHistory/Search {incidentStartDate, incidentEndDate} lists faxes agency-wide;
  // POST /PatientCareRecords/Search lists the feed (status filter value 2 = locked).
  const esoDate = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  const canSendCache = new Map(); // pcrId -> { at, fax, email }
  async function canSend(pcrId, fresh) {
    const hit = canSendCache.get(pcrId);
    if (hit && !fresh && Date.now() - hit.at < 3600 * 1000) return hit;
    const get = async (path) => { const res = await rawRequest({ method: 'GET', url: apiUrl(`/PatientCareRecords/${pcrId}/${path}`), headers: headersFor(false), timeout: 20000 }); const j = outcome(res) === 'ok' ? tryJSON(res.text) : null; return j && typeof j === 'object' ? { ok: !!j.ok, destinationName: j.destinationName || null, error: j.error || null } : { ok: false, destinationName: null, error: outcome(res) === 'net' ? 'no signal' : summarize(res), unknown: true }; };
    const out = { at: Date.now(), fax: await get('Fax/CanSend'), email: await get('Email/canSend') };
    if (!out.fax.unknown && !out.email.unknown) canSendCache.set(pcrId, out);
    return out;
  }
  async function faxHistory(days) {
    const res = await rawRequest({ method: 'POST', url: apiUrl('/FaxHistory/Search'), headers: headersFor(true), timeout: 30000,
      body: JSON.stringify({ incidentStartDate: esoDate(daysAgo(days)) + ' 00:00:00', incidentEndDate: esoDate(new Date()) + ' 23:59:59' }) });
    if (outcome(res) !== 'ok') return null;
    const j = tryJSON(res.text);
    return j && Array.isArray(j.data) ? j.data : null;
  }
  const FAX_FAILED_RE = /fail|error|reject|cancel/i;
  function sentEntry(history, pcrId) {
    let best = null;
    for (const f of history || []) { if (f && f.pcrId === pcrId && !FAX_FAILED_RE.test(String(f.status || ''))) { best = f; } }
    return best;
  }
  function sendCall(pcrId, kind) {
    return rawRequest({ method: 'POST', url: apiUrl(`/PatientCareRecords/${pcrId}/${kind === 'email' ? 'Email' : 'Fax'}/Send`), headers: headersFor(true), timeout: 30000,
      body: JSON.stringify({ sendDateTime: fmtEsoLocal(new Date()) }) });
  }
  // Right after the app locks a run: is there somewhere to send it, and has it gone already?
  async function afterLock(run) {
    if (S.settings.sendPrompt === false) return;
    const pcrId = run.realId || run.recordId;
    const c = await canSend(pcrId, true);
    if (!c.fax.ok && !c.email.ok) {
      log(run, `Locked. Nothing to send: ${c.fax.error || c.email.error || 'no fax or email on file for the destination'}.`, 'info');
      return;
    }
    const history = await faxHistory(45);
    const already = history ? sentEntry(history, pcrId) : null;
    if (already) { log(run, `Locked. Already faxed to ${already.destination} at ${already.sentAt}.`, 'info'); return; }
    if (run.emailedAt || (S.emailed && S.emailed[pcrId])) { log(run, 'Locked. Already emailed from this device.', 'info'); return; }
    if ((run.sends || []).some(x => x.status === 'held' || x.status === 'sent')) return;
    log(run, `Locked. Asking whether to ${c.fax.ok ? 'fax' : 'email'} it to ${(c.fax.ok ? c.fax : c.email).destinationName}.`, 'info');
    post('event', { name: 'sendPrompt', recordId: run.recordId, pcrId, incidentNumber: run.incidentNumber, fax: c.fax, email: c.email, historyKnown: !!history });
  }
  // Send now, or hold it with the run's other changes when there is no signal.
  async function sendRecord(recordId, kind) {
    const run = S.runs[recordId] || null;
    const pcrId = run ? (run.realId || run.recordId) : recordId;
    const c = canSendCache.get(pcrId);
    const destinationName = c && c[kind] && c[kind].destinationName || null;
    const fail = (error) => { if (run) log(run, `Could not ${kind} the run: ${error}`, 'error'); post('event', { name: 'sent', recordId, pcrId, kind, ok: false, error }); };
    if (run && (!S.online || S.loggedOut || run.pendingCreate || run.pushing || hasHeld(run))) {
      run.sends = run.sends || [];
      run.sends.push({ kind, destinationName, ts: Date.now(), status: 'held' });
      persist(run, true); emit(); kick(300);
      log(run, `No signal: the ${kind} to ${destinationName || 'the destination'} is held on this device and will go when signal returns.`, 'warn');
      return post('event', { name: 'sent', recordId, pcrId, kind, ok: true, held: true, destinationName });
    }
    const res = await sendCall(pcrId, kind);
    const o = outcome(res);
    if (o === 'ok') {
      if (run) { run.sends = run.sends || []; run.sends.push({ kind, destinationName, ts: Date.now(), status: 'sent', sentAt: Date.now() }); if (kind === 'email') run.emailedAt = Date.now(); persist(run); log(run, `${kind === 'fax' ? 'Fax' : 'Email'} sent to ${destinationName || 'the destination'}.`, 'good'); }
      if (kind === 'email') { S.emailed = S.emailed || {}; S.emailed[pcrId] = Date.now(); post('persistEmailed', { pcrId, ts: Date.now() }); }
      setOnline(true); emit(); scheduleUnsentScan(4000);
      return post('event', { name: 'sent', recordId, pcrId, kind, ok: true, destinationName });
    }
    if (o === 'auth') { setLoggedOut(true); return fail('ESO logged you out. Log in and try again.'); }
    if (o === 'net') return fail(run ? 'ESO did not answer. Try again in a moment.' : 'No signal. Try again when ESO answers.');
    fail(`ESO refused: ${summarize(res)}`);
  }
  // Agency-wide: locked runs from the last 15 days that have a fax or email destination and no
  // fax in ESO's history (and no email sent from a device running this extension).
  let unsentTimer = null;
  function scheduleUnsentScan(delay) { if (S.settings.unsentList === false) return; clearTimeout(unsentTimer); unsentTimer = setTimeout(() => scanUnsent().catch(() => {}), delay == null ? 2000 : delay); }
  async function scanUnsent() {
    if (S.settings.unsentList === false || !S.online || S.loggedOut || !S.xsrf || S.scanning) return;
    S.scanning = true;
    try {
      const rows = [];
      for (let index = 0; index < 1000; index += 100) {
        const res = await rawRequest({ method: 'POST', url: apiUrl('/PatientCareRecords/Search'), headers: headersFor(true), timeout: 30000,
          body: JSON.stringify({ startDate: esoDate(daysAgo(15)), endDate: esoDate(new Date()), index, count: 100, filters: [{ fieldRef: 'PCRSEARCHSTATUS', itemId: 6, value: [2] }] }) });
        if (outcome(res) !== 'ok') { if (outcome(res) === 'net') setOnline(false, 'feed did not load'); return; }
        const j = tryJSON(res.text);
        const page = j && Array.isArray(j.data) ? j.data : [];
        rows.push(...page);
        if (page.length < 100) break;
      }
      const history = await faxHistory(45);
      if (!history) return;
      const emailed = S.emailed || {};
      for (const run of Object.values(S.runs)) if (run.emailedAt) emailed[run.realId || run.recordId] = run.emailedAt;
      const candidates = rows.filter(r => r && r.pcrId && !r.deleted && r.destinationName && !sentEntry(history, r.pcrId) && !emailed[r.pcrId]).slice(0, 40);
      const items = [];
      for (const r of candidates) {
        const c = await canSend(r.pcrId);
        if (c.fax.unknown && c.email.unknown) continue;
        if (!c.fax.ok && !c.email.ok) continue;
        items.push({ pcrId: r.pcrId, incidentNumber: r.incidentNumber, incidentDateTime: r.incidentDateTime, patientName: r.patientName, destinationName: c.fax.destinationName || c.email.destinationName || r.destinationName, fax: c.fax.ok, email: c.email.ok });
      }
      S.unsent = { at: Date.now(), items, locked: rows.length };
      emit();
    } finally { S.scanning = false; }
  }
  setInterval(() => { if (S.unsent && Date.now() - S.unsent.at > 3600 * 1000) scheduleUnsentScan(0); }, 60 * 1000);

  // ------------------------------------------------------------------ copy a vital
  const VITAL_ITEM_RE = /^vitals\.vitalSigns\.\['[^']+'\]\.(.+)$/;
  function learnFieldDefs(ops) {
    let changed = false;
    for (const op of ops) {
      const m = VITAL_ITEM_RE.exec(op.address || '');
      if (!m || !op.fieldRef) continue;
      let path = m[1];
      if (op.dataType === 'multiselect') path = path.replace(/\.\['[^']*'\]$/, '');
      if (S.fieldDefs[path]) continue;
      S.fieldDefs[path] = [op.fieldRef, op.dataType || 'string'];
      changed = true;
    }
    if (changed) post('persistFieldDefs', { fieldDefs: S.fieldDefs });
  }
  function fmtEsoLocal(d) {
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  // The saves the app itself would make to enter this vital again, with a new time. Only fields the
  // app has been seen saving (seeded from a recording, grown from live saves) are sent: a made-up
  // field name would make ESO refuse the whole batch. Anything else in the vital is reported back.
  // ESO's own bookkeeping on a vital (seen in the Vitals view); the app never saves these.
  const VITAL_META = new Set(['itemId', 'vitalSignDateTime', 'mobileToMobile', 'softDeleted', 'fileId', 'imageType', 'version']);
  function vitalCopyOps(vital, newKey) {
    const base = `vitals.vitalSigns.['${newKey}']`;
    const ops = [{ verb: 'ADD', address: base, fieldRef: 'VITALSIGN', value: { vitalSignDateTime: fmtEsoLocal(new Date()) }, dataType: 'collectionWithData', isComplexType: true }];
    const skipped = [];
    // the app sends text fields as text even when they hold a number; the view returns numbers
    const coerce = (v, type) => type === 'string' ? String(v) : type === 'integer' && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v;
    const walk = (obj, path) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined || v === '') continue;
        if (!path && VITAL_META.has(k)) continue;
        const p = path ? path + '.' + k : k;
        const def = S.fieldDefs[p];
        if (Array.isArray(v)) {
          const vals = v.filter(el => el !== null && typeof el !== 'object');
          if (!vals.length) { if (v.length) skipped.push(p); continue; }
          if (!def) { skipped.push(p); continue; }
          for (const el of vals) ops.push({ verb: 'ADD', address: `${base}.${p}.['${el}']`, fieldRef: def[0], value: el, dataType: 'multiselect' });
        } else if (typeof v === 'object') walk(v, p);
        else if (!def) skipped.push(p);
        else if (def[1] === 'multiselect') ops.push({ verb: 'ADD', address: `${base}.${p}.['${v}']`, fieldRef: def[0], value: v, dataType: 'multiselect' });
        else ops.push({ verb: 'EDIT', address: `${base}.${p}`, fieldRef: def[0], value: coerce(v, def[1]), dataType: def[1] });
      }
    };
    walk(vital, '');
    return { ops, skipped };
  }
  async function currentVitals(run) {
    const id = run.realId || run.recordId;
    if (S.online && !S.loggedOut && !(run.tmp && !run.realId)) {
      const url = apiUrl(`/PatientCareRecords/${id}/Views/Vitals`);
      const res = await rawRequest({ method: 'GET', url, headers: headersFor(false), timeout: 15000 });
      if (outcome(res) === 'ok') { run.views.Vitals = { text: res.text, ts: Date.now() }; cachePut('GET', url, undefined, res); }
      else log(run, `Could not re-read the vitals list (${summarize(res)}); using the saved copy.`, 'warn');
    }
    const cached = run.views.Vitals;
    if (!cached) return null;
    const j = tryJSON(applyHeldToView(run, 'Vitals', cached.text));
    return j && j.data && j.data.model && Array.isArray(j.data.model.vitalSigns) ? j.data.model.vitalSigns : null;
  }
  // A copy is a batch the extension made up, so it is treated more carefully than the app's own
  // saves: sent directly when there is signal, and never allowed to flip the card to NO SIGNAL or
  // to sit in the queue blocking real saves if ESO refuses it.
  async function copyVital(recordId, timeText, nth) {
    const fail = (error) => post('event', { name: 'vitalCopied', ok: false, error });
    const run = S.runs[recordId];
    if (!run) return fail('Run not found.');
    const list = await currentVitals(run);
    if (!list) return fail('Could not read the vitals list.');
    const matches = list.filter(v => v && typeof v.vitalSignDateTime === 'string' && v.vitalSignDateTime.slice(-8) === timeText);
    const vital = matches[nth || 0] || matches[0];
    if (!vital) return fail('That vital has not been saved by ESO yet. Wait a moment and try again.');
    const newKey = uuid();
    const { ops, skipped } = vitalCopyOps(vital, newKey);
    if (ops.length < 2) return fail('Nothing in that vital can be copied.' + (skipped.length ? ' Unknown fields: ' + skipped.join(', ') : ''));
    const note = skipped.length ? ` Not copied (never seen the app save them): ${skipped.join(', ')}.` : '';
    const batch = { seq: run.nextSeq++, ts: Date.now(), scope: 'vitals', ops, status: 'pending', attempts: 0, synthetic: 'copyVital' };
    if (!S.online || S.loggedOut || run.pendingCreate || run.pushing || hasHeld(run)) {
      batch.status = 'held'; run.batches.push(batch); persist(run, true); emit(); kick(300);
      log(run, `Copied the ${timeText} vital as a new entry (${ops.length - 1} fields); held until it can be pushed.${note}`, 'warn');
      return post('event', { name: 'vitalCopied', ok: true, held: true });
    }
    const id = run.realId || run.recordId;
    const res = await rawRequest({ method: 'POST', url: apiUrl(`/PatientCareRecords/${id}/autosave?scope=vitals`), headers: headersFor(true), body: rewriteKeys(JSON.stringify(ops), run.keyMap), timeout: 30000 });
    const o = outcome(res);
    if (o === 'ok') {
      run.batches.push(batch); ack(run, batch, res); setOnline(true); setLoggedOut(false); persist(run); emit();
      log(run, `Copied the ${timeText} vital as a new entry (${ops.length - 1} fields).${note}`, 'good');
      return post('event', { name: 'vitalCopied', ok: true });
    }
    if (o === 'auth') setLoggedOut(true);
    const why = o === 'net' ? 'ESO did not answer. Check the signal and try again.' : `ESO refused the copy: ${summarize(res)}`;
    log(run, `Could not copy the ${timeText} vital: ${why}${note}`, 'error');
    fail(why);
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
    learnFieldDefs(ops);
    noteTimes(run, ops);
    noteListOps(run, ops);
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
      S.lastView = { view: kind.view, recordId: kind.recordId, ts: Date.now() };
      noteLists(run, kind.view, j);
      emit();
      cachePut('GET', req.url, undefined, res);
      learnTab(kind.view, kind.recordId, req);
      if (!run.prefetchedAt) schedulePrefetch(run);
      observeMeta(run, j);
      if (run.fresh && j && j.data && !run.batches.some(b => String(b.scope).toLowerCase() === kind.view.toLowerCase())) captureTemplate(run, kind.view, res.text);
      persist(run);
      return res;
    }
    if (o === 'net') {
      setOnline(false, 'tab could not load');
      const exact = cacheGet('GET', req.url, undefined);
      const cached = exact ? { text: exact.text } : run.views[kind.view];
      if (cached) {
        log(run, `No signal: showing the saved copy of the ${kind.view} tab.`, 'warn');
        const text = applyHeldToView(run, kind.view, cached.text);
        S.lastView = { view: kind.view, recordId: kind.recordId, ts: Date.now() };
        noteLists(run, kind.view, tryJSON(text));
        emit();
        return fakeOk(text, req.url);
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
      const tplId = S.templates && S.templates.recordId;
      const hit = tplId ? cacheGet(req.method, req.url.split(run.recordId).join(tplId), req.body ? req.body.split(run.recordId).join(tplId) : undefined) : null;
      if (hit) return cachedResponse({ ...hit, text: hit.text.split(tplId).join(run.recordId) }, req.url);
      return { status: 0, statusText: '', text: '', headers: '', url: req.url, netError: true, contentType: '' };
    }
    const res = await rawRequest({ ...req, url: rewriteUrl(req.url) });
    const o = outcome(res);
    if (o === 'ok') {
      setOnline(true); setLoggedOut(false);
      observeMeta(run, tryJSON(res.text));
      cachePut(req.method, req.url, req.body, res);
      if (kind.method !== 'GET' && /^unlock$/i.test(kind.tail)) { setLocked(run, false); persist(run); }
      else if (kind.method !== 'GET' && /lock|final|submit/i.test(kind.tail)) { setLocked(run, true); persist(run); afterLock(run); }
      if (kind.method === 'POST' && /^Email\/Send$/i.test(kind.tail)) { run.emailedAt = Date.now(); persist(run); post('persistEmailed', { pcrId: run.realId || run.recordId, ts: run.emailedAt }); scheduleUnsentScan(5000); }
      if (kind.method === 'POST' && /^Fax\/Send$/i.test(kind.tail)) scheduleUnsentScan(5000);
    } else if (o === 'net') {
      setOnline(false, 'request failed');
      const hit = cacheGet(req.method, req.url, req.body);
      if (hit) return cachedResponse(hit, req.url);
    }
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
            if (this.status === 0) setOnline(false, 'request failed');
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
    const pages = {};
    for (const b of run.batches) { counts[b.status] = (counts[b.status] || 0) + 1; if (b.status !== 'dropped') pages[pageOf(b.scope)] = (pages[pageOf(b.scope)] || 0) + 1; }
    return {
      recordId: run.recordId, realId: run.realId, tmp: run.tmp, pendingCreate: !!run.pendingCreate,
      incidentNumber: run.incidentNumber, state: run.state, locked: run.locked, lockedAt: run.lockedAt,
      createdAt: run.createdAt, lastSeenAt: run.lastSeenAt, lastSavedAt: run.lastSavedAt,
      restoredFrom: run.restoredFrom, counts, pages, log: run.log.slice(-60), times: run.times || null,
      sends: (run.sends || []).map(x => ({ kind: x.kind, status: x.status, destinationName: x.destinationName, ts: x.ts })), emailedAt: run.emailedAt || null,
      lists: run.lists || null, owner: run.owner || null, crewIds: (run.crew || []).map(c => c && c.personnelId).filter(Boolean),
      hasViews: Object.keys(run.views).length, hasCrew: !!(run.crew && run.crew.length),
    };
  }
  function buildStatus() {
    const runs = Object.values(S.runs).map(summary).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return {
      version: VERSION, online: S.online, loggedOut: S.loggedOut, pushing: S.pushing, ready: S.ready, hasToken: !!S.xsrf,
      currentRecordId: S.currentRecordId, runs, lastEvent: S.lastEvent, lastView: S.lastView, user: S.user, userId: S.userId,
      held: runs.reduce((n, r) => n + r.counts.held + (r.pendingCreate ? 1 : 0) + r.sends.filter(x => x.status === 'held').length, 0),
      unsent: S.unsent || null,
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
      merged.times = mem.times || r.times || null;
      merged.sends = [...(r.sends || []), ...(mem.sends || [])];
      merged.emailedAt = mem.emailedAt || r.emailedAt || null;
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
        if (S.ready) return; // the stored state is merged once; a second copy would double every held batch
        mergeStored(payload.runs);
        if (payload.templates && payload.templates.views) S.templates = payload.templates;
        if (payload.fieldDefs && typeof payload.fieldDefs === 'object') for (const [k, v] of Object.entries(payload.fieldDefs)) if (Array.isArray(v) && !S.fieldDefs[k]) S.fieldDefs[k] = v;
        if (payload.tabRequests && typeof payload.tabRequests === 'object') {
          for (const [view, reqs] of Object.entries(payload.tabRequests)) if (Array.isArray(reqs)) for (const r of reqs) if (r && r.url) noteTabRequest(view, r.method || 'GET', r.url, r.body);
        }
        if (payload.settings) Object.assign(S.settings, payload.settings);
        if (payload.emailed && typeof payload.emailed === 'object') S.emailed = payload.emailed;
        S.ready = true;
        emit();
        scheduleUnsentScan(20000);
        if (anyHeld()) { log(null, 'Found changes held from before. Pushing as soon as ESO answers.', 'warn'); kick(500); }
      } else if (type === 'settings') {
        Object.assign(S.settings, payload || {}); emit();
      } else if (type === 'action') {
        const a = payload || {};
        if (a.name === 'pushNow') { probe().then(() => kick(0)); }
        else if (a.name === 'pushIntoCurrent') { if (S.currentRecordId) restoreInto(a.recordId, S.currentRecordId, a.pages); else log(S.runs[a.recordId], 'Open a run in ESO first, then push into it.', 'warn'); }
        else if (a.name === 'pushIntoNew') { restoreInto(a.recordId, null, a.pages); }
        else if (a.name === 'retryRejected') { const run = S.runs[a.recordId]; if (run) { for (const b of run.batches) if (b.status === 'rejected') { b.status = 'held'; b.error = null; } persist(run); kick(0); } }
        else if (a.name === 'dropRejected') { const run = S.runs[a.recordId]; if (run) { for (const b of run.batches) if (b.status === 'rejected') b.status = 'dropped'; persist(run); emit(); } }
        else if (a.name === 'forget') { delete S.runs[a.recordId]; if (S.currentRecordId === a.recordId) S.currentRecordId = null; emit(); }
        else if (a.name === 'status') { emit(); }
        else if (a.name === 'note') { const run = S.runs[a.recordId]; if (run) log(run, String(a.msg || ''), a.level || 'info'); }
        else if (a.name === 'copyVital') { copyVital(a.recordId || S.currentRecordId, String(a.time || ''), Number(a.nth) || 0); }
        else if (a.name === 'send') { sendRecord(a.recordId, a.kind === 'email' ? 'email' : 'fax'); }
        else if (a.name === 'scanUnsent') { scheduleUnsentScan(0); }
        else if (a.name === 'facilities') { if (S.facilities) post('facilities', S.facilities); }
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
  // Tell the extension side this script is listening. On browsers that load this file as a page
  // script (Safari) it can start a moment after the extension side, which would otherwise post
  // the stored state into thin air and lose every held change on a reload.
  post('hello', { version: VERSION });
  emit();
})();
