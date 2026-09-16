/* Mock of the ESO EHR web API, shaped after a recording of the real app.
 *
 *   POST /ehr/api/PatientCareRecords                         -> {"result":"Success","data":"<id>"}
 *   POST /ehr/api/PatientCareRecords/:id/autosave?scope=X    -> {"result":"Success","data":[{originalKey,newKey,baseAddress}]}
 *   GET  /ehr/api/PatientCareRecords/:id/Views/:view         -> {data:{model,optionalData},meta:{state},responseStatus:null}
 *   GET  /ehr/api/PatientCareRecords/:id/Attachments         -> {data:{model:{attachments:[],incidentNumber}},meta:{state}}
 *   GET  /ehr/api/PatientCareRecords/:id/Validate            -> {issues:[]}
 *   POST /ehr/api/PatientCareRecords/:id/Lock                -> state = locked (the real lock call was not recorded)
 *   GET  /ehr/api/thirdpartydata/partners                    -> []
 *
 * Strictness that matters for the extension: every ADD of a complex item gets a server key, and any
 * later op that references an unknown item key is rejected, exactly like a stale temporary key would be.
 *
 * Test controls: POST /__control {loggedOut, rejectValue, failAutosaves, refuseAutosaves}, GET /__record/:id, GET /__records
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');

export function parseAddress(addr) {
  const out = [];
  const re = /\['([^']*)'\]|[^.[\]]+/g;
  let m;
  while ((m = re.exec(addr))) out.push(m[1] !== undefined ? { key: m[1], bracket: true } : { key: m[0], bracket: false });
  return out;
}
const isGuidish = (k) => /^[0-9a-f-]{20,}$/i.test(k) || /^esosave-/.test(k);
const findItem = (arr, key) => arr.find(x => x && typeof x === 'object' ? String(x.itemId) === key : String(x) === key);

export function applyToTree(tree, op) {
  const toks = parseAddress(op.address);
  let cur = tree;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i], nxt = toks[i + 1];
    if (t.bracket) {
      if (Array.isArray(cur)) { let it = findItem(cur, t.key); if (!it) { it = { itemId: t.key }; cur.push(it); } cur = it; }
      else cur = cur[t.key] ?? (cur[t.key] = {});
    } else {
      if (cur[t.key] == null || typeof cur[t.key] !== 'object') cur[t.key] = nxt.bracket ? [] : {};
      cur = cur[t.key];
    }
  }
  const last = toks[toks.length - 1];
  const val = op.value === undefined ? null : op.value;
  if (op.verb === 'DELETE') {
    if (last.bracket && Array.isArray(cur)) { const i = cur.findIndex(x => x && typeof x === 'object' ? String(x.itemId) === last.key : String(x) === last.key); if (i >= 0) cur.splice(i, 1); }
    else if (!Array.isArray(cur)) cur[last.key] = null;
    return;
  }
  if (last.bracket) {
    if (Array.isArray(cur)) {
      const ex = findItem(cur, last.key);
      if (val && typeof val === 'object' && !Array.isArray(val)) { if (ex && typeof ex === 'object') Object.assign(ex, val); else cur.push({ itemId: last.key, ...val }); }
      else if (!ex) cur.push(val === null ? last.key : val);
    } else cur[last.key] = val;
  } else cur[last.key] = val;
}

export function createMockEso() {
  const records = new Map();
  const control = { loggedOut: false, rejectValue: null, failAutosaves: 0, refuseAutosaves: 0, log: [] };
  let seq = 0;

  function newRecord() {
    const id = randomUUID();
    seq++;
    const rec = {
      id, incidentNumber: `TEST-${String(seq).padStart(4, '0')}`, state: 'draft', locked: false,
      tree: {}, ops: [], mappings: [], knownKeys: new Set(), autosaves: 0,
      crew: [{ personnelId: 'person-1', itemId: randomUUID(), firstName: 'TEST', lastName: 'MEDIC', rank: 0 }],
    };
    rec.knownKeys.add(rec.crew[0].itemId);
    records.set(id, rec);
    return rec;
  }
  function autosave(rec, ops) {
    if (rec.locked) return [400, { result: 'Failure', message: 'Record is locked' }];
    if (control.failAutosaves > 0) { control.failAutosaves--; return [502, '<html><body>502 Bad Gateway</body></html>', 'text/html']; }
    if (control.refuseAutosaves > 0) { control.refuseAutosaves--; return [500, { result: 'Failure', message: 'Object reference not set to an instance of an object.' }]; }
    // ESO's bookkeeping on a vital is returned in the view but is not a field the app can set
    if (ops.some && ops.some(o => o && /^(MOBILETOMOBILE|SOFTDELETED|FILEID|IMAGETYPE)$/.test(o.fieldRef))) return [500, { errorCode: 'OTHER', correlationId: randomUUID().replace(/-/g, '') }];
    if (!Array.isArray(ops)) return [400, { result: 'Failure', message: 'Body must be an array of operations' }];
    const mappings = [];
    const localMap = {};
    const rewrite = (s) => s.replace(/[0-9a-f-]{20,}/gi, k => localMap[k] || k);
    for (const raw of ops) {
      if (control.rejectValue != null && raw.value === control.rejectValue) return [400, { result: 'Failure', message: `Rejected value ${control.rejectValue}` }];
      const op = JSON.parse(rewrite(JSON.stringify(raw)));
      const toks = parseAddress(op.address);
      const last = toks[toks.length - 1];
      const complexAdd = op.verb === 'ADD' && last.bracket && (op.isComplexType || ['collectionWithData', 'fieldGroup', 'binary', 'collection'].includes(op.dataType));
      // every guid-looking key in the path (other than the one being added) must be known
      const scalarValueKey = last.bracket && !complexAdd && (op.dataType === 'multiselect' || (op.verb === 'ADD' && (op.value === null || typeof op.value !== 'object')));
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (!t.bracket || !isGuidish(t.key)) continue;
        if (i === toks.length - 1 && (complexAdd || scalarValueKey)) continue;
        if (!rec.knownKeys.has(t.key)) return [400, { result: 'Failure', message: `Unknown key ${t.key} in ${op.address}` }];
      }
      if (scalarValueKey && op.verb === 'ADD') rec.knownKeys.add(last.key);
      if (complexAdd && isGuidish(last.key)) {
        const newKey = randomUUID();
        localMap[last.key] = newKey;
        rec.knownKeys.add(newKey);
        mappings.push({ baseAddress: op.address.slice(0, op.address.lastIndexOf('.[')), originalKey: last.key, newKey });
        op.address = op.address.replace(`['${last.key}']`, `['${newKey}']`);
      }
      applyToTree(rec.tree, op);
      rec.ops.push(op);
    }
    rec.mappings.push(...mappings);
    rec.autosaves++;
    return [200, { result: 'Success', data: mappings }];
  }
  const VITAL_SHAPE = { avpuId: null, patientSide: null, patientPosture: null, painScale: null, painScaleTypeId: null, mobileToMobile: false, softDeleted: null, fileId: null, imageType: null,
    bloodPressure: { bloodPressureSystolic: null, bloodPressureDiastolic: null, bloodPressureMethodId: null, shockIndex: null },
    pulse: { pulseRate: null, pulseRhythmId: null, pulseStrengthId: null, pulseRateMethodID: null },
    respiration: { respirationRate: null, respirationRhythmId: null, respirationQualityId: null },
    etCO2SPO2CO: { spO2: null, etCO2: null, etCO2mmHg: null, etCO2Percentage: null, etCO2kPa: null, co: null, coDecimal: null, onOxygen: null },
    glucoseAndTemp: { temperatureF: null, temperatureC: null, glucose: null, temperatureMethodId: null },
    cardiacMonitoring: { ecg12LeadIschemia: [], ecg12LeadComments: null, ecgTypeId: null, ecgRhythm: [], ecgMethodOfInterpretationIds: [], ecgNotes: null, isMISuspected: null },
    glasgowComaScale: { glascowComaEyesId: null, glascowComaVerbalId: null, glascowComaMotorId: null, glascowComaTotalScore: null, glasgowComaQualifierIds: [] },
    revisedTraumaScore: { revisedTraumaGcs: null, revisedTraumaBp: null, revisedTraumaRr: null, revisedTraumaTotalScore: null } };
  function realVital(v) {
    const num = (x) => (typeof x === 'string' && x.trim() !== '' && !isNaN(Number(x))) ? Number(x) : x;
    const merge = (shape, val) => { const out = { ...shape }; for (const [k, x] of Object.entries(val || {})) out[k] = (x && typeof x === 'object' && !Array.isArray(x)) ? merge(shape[k] || {}, x) : num(x); return out; };
    return merge(VITAL_SHAPE, v);
  }
  function view(rec, name) {
    const scope = name.charAt(0).toLowerCase() + name.slice(1);
    const model = JSON.parse(JSON.stringify(rec.tree[scope] || {}));
    if (name === 'Incident') { model.response = { incidentNumber: rec.incidentNumber, ...(model.response || {}) }; model.crew = rec.crew; }
    if (name === 'Signatures' || name === 'Narrative' || name === 'FlowchartTreatments') model.crew = rec.crew;
    if (!('version' in model)) model.version = null;
    // a saved vital comes back the way ESO returns it: numbers for numeric text, every group
    // present with nulls, plus bookkeeping fields the app never saves
    if (name === 'Vitals' && Array.isArray(model.vitalSigns)) model.vitalSigns = model.vitalSigns.map(realVital);
    return {
      data: { model, optionalData: { patients: [{ patientCareRecordId: rec.id, isLocked: rec.locked, firstName: null, lastName: null }], pcrHeader: { isPositiveIdEnabled: true, positiveIdVerified: null } } },
      meta: { configVersion: '5.3.19', state: rec.state, user: { fullName: 'TEST, MEDIC' } },
      responseStatus: null,
    };
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname.replace(/\/{2,}/g, '/');
    control.log.push({ method: req.method, path: path + u.search, t: Date.now() });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, payload, type) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
      };
      // ---- test controls
      if (path === '/__control' && req.method === 'POST') { Object.assign(control, JSON.parse(body || '{}')); return send(200, { ok: true, control: { ...control, log: undefined } }); }
      if (path === '/__records') return send(200, [...records.values()].map(r => ({ id: r.id, incidentNumber: r.incidentNumber, state: r.state, autosaves: r.autosaves, ops: r.ops.length })));
      if (path.startsWith('/__record/')) {
        const r = records.get(path.split('/')[2]);
        return r ? send(200, { id: r.id, incidentNumber: r.incidentNumber, state: r.state, tree: r.tree, ops: r.ops, mappings: r.mappings, crew: r.crew, autosaves: r.autosaves }) : send(404, { error: 'no such record' });
      }
      if (path === '/__log') return send(200, control.log);
      // ---- static app
      if (path === '/ehr' || path === '/ehr/') return send(200, readFileSync(join(publicDir, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      if (path === '/ehr/app.js') return send(200, readFileSync(join(publicDir, 'app.js'), 'utf8'), 'text/javascript');
      if (path === '/login/') return send(200, '<html><body><h1>ESO login</h1></body></html>', 'text/html; charset=utf-8');
      // ---- api
      if (!path.startsWith('/ehr/api/')) return send(404, { error: 'not found' });
      if (control.loggedOut) { res.writeHead(302, { location: '/login/?ReturnUrl=' + encodeURIComponent(path) }); return res.end(); }
      const rest = path.slice('/ehr/api/'.length);
      if (rest === 'thirdpartydata/partners') return send(200, { partners: [] });
      if (rest.startsWith('WebApi') && req.method === 'POST') return send(200, { result: '', status: 204 });
      if (rest.startsWith('custom/lookup')) return send(200, { items: [1, 2, 3] });
      if (rest === 'PatientCareRecords' && req.method === 'POST') { const r = newRecord(); return send(200, { result: 'Success', data: r.id }); }
      const m = /^PatientCareRecords\/([^/]+)(?:\/(.*))?$/.exec(rest);
      if (!m) return send(404, { error: 'unknown api' });
      const rec = records.get(m[1]);
      if (!rec) return send(404, { result: 'Failure', message: 'No such record' });
      const tail = m[2] || '';
      if (tail === 'autosave' && req.method === 'POST') {
        let ops; try { ops = JSON.parse(body); } catch { ops = null; }
        const [st, payload, type] = autosave(rec, ops);
        return send(st, payload, type);
      }
      const v = /^Views\/([^/]+)$/.exec(tail);
      if (v && req.method === 'GET') return send(200, view(rec, v[1]));
      if (tail === 'CardiacMonitor') return send(200, { data: [], hasImportedCases: false });
      if (tail === 'Attachments') return send(200, { data: { model: { attachments: [], incidentNumber: rec.incidentNumber } }, meta: { state: rec.state }, responseStatus: null });
      if (tail.startsWith('Validate')) return send(200, { issues: [] });
      if (tail === 'Lock' && req.method === 'POST') { rec.state = 'locked'; rec.locked = true; return send(200, { result: 'Success', data: null }); }
      if (tail === 'Unlock' && req.method === 'POST') { rec.state = 'draft'; rec.locked = false; return send(200, { result: 'Success', data: null }); }
      return send(404, { error: 'unknown api: ' + rest });
    });
  });

  return {
    server, records, control,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mock = createMockEso();
  const url = await mock.listen();
  console.log('mock ESO at', url + '/ehr/');
}
