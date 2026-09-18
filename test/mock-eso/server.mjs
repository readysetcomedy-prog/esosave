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
  const control = { loggedOut: false, rejectValue: null, failAutosaves: 0, refuseAutosaves: 0, faxStatus: 'SUCCESS', userName: 'TEST, MEDIC', userId: 'person-1', dbDown: false, log: [] };
  // a stand-in for the extension's settings table (Supabase's REST shape): one row per ESO login
  const dbUsers = new Map();
  const faxHistory = []; // agency-wide, like ESO's Fax History
  const emails = [];
  let faxSeq = 7370000;
  let seq = 0;

  function newRecord() {
    const id = randomUUID();
    seq++;
    const rec = {
      id, incidentNumber: `TEST-${String(seq).padStart(4, '0')}`, state: 'draft', locked: false,
      tree: {}, ops: [], mappings: [], knownKeys: new Set(), autosaves: 0,
      incidentDateTime: new Date(), destination: null, // { name, fax, email }
      crew: [{ personnelId: control.userId, itemId: randomUUID(), firstName: (control.userName.split(',')[1] || 'MEDIC').trim(), lastName: control.userName.split(',')[0].trim(), rank: 0, roleIds: [] }],
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
    if (name === 'Incident') {
      model.response = { incidentNumber: rec.incidentNumber, ...(model.response || {}) };
      // roles saved through the app's own ops ride along with the crew list
      model.crew = rec.crew.map(c => { const saved = Array.isArray(model.crew) ? model.crew.find(x => x && String(x.itemId) === String(c.itemId)) : null; return { ...c, roleIds: (saved && Array.isArray(saved.roleIds) ? saved.roleIds : c.roleIds || []).map(Number) }; });
      const t = {}; for (const k of ['psapCall', 'dispatched', 'enRoute', 'onScene', 'atPatient', 'departScene', 'atDestination', 'transferPatient', 'callClosed']) { t[k + 'Time'] = null; t[k + 'Date'] = null; }
      model.incidentTimes = { ...t, ...(model.incidentTimes || {}) };
    }
    if (name === 'Signatures' || name === 'Narrative' || name === 'FlowchartTreatments') model.crew = rec.crew;
    if (name === 'Patient') {
      // keyed groups come back as arrays of {itemId,...}, the way ESO returns them
      for (const k of ['patientMedicalHistories', 'patientAllergies', 'patientMedications']) {
        const v = model[k];
        const arr = v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).map(([id, x]) => ({ itemId: id, comment: null, ...(x && typeof x === 'object' ? x : {}) })) : (Array.isArray(v) ? v : []);
        model[k] = arr.map(x => ({ comment: null, ...x, itemId: /^\d+$/.test(String(x.itemId)) ? Number(x.itemId) : x.itemId }));
      }
      if (!('patientHistoriesPertinentNegativeId' in model)) model.patientHistoriesPertinentNegativeId = null;
    }
    if (name === 'Assessments') {
      model.assessmentsV2 = (model.assessmentsV2 || []).map(a => ({ ...a, findings: (a.findings || []).map(f => ({ present: true, ...f })) }));
      if (!model.assessments) model.assessments = [];
    }
    if (name === 'Narrative') {
      model.patientComplaint = { initialPatientAcuityId: null, finalPatientAcuityId: null, ...(model.patientComplaint || {}) };
      const pt = model.patientTransport || {};
      for (const k of ['howPatientWasMovedToStretcherIds', 'patientMovedFromSceneToAmbulanceMethodIds', 'patientMovedFromAmbulanceToDestinationMethodIds', 'patientPositionDuringTransportIds']) pt[k] = (pt[k] || []).map(x => /^\d+$/.test(String(x)) ? Number(x) : x);
      model.patientTransport = pt;
      model.injuries = { ...(model.injuries || {}), mechanismOfInjuryIds: ((model.injuries || {}).mechanismOfInjuryIds || []).map(x => /^\d+$/.test(String(x)) ? Number(x) : x) };
    }
    if (!('version' in model)) model.version = null;
    // a saved vital comes back the way ESO returns it: numbers for numeric text, every group
    // present with nulls, plus bookkeeping fields the app never saves
    if (name === 'Vitals' && Array.isArray(model.vitalSigns)) model.vitalSigns = model.vitalSigns.map(realVital);
    return {
      data: { model, optionalData: { patients: [{ patientCareRecordId: rec.id, isLocked: rec.locked, firstName: null, lastName: null }], pcrHeader: { isPositiveIdEnabled: true, positiveIdVerified: null } } },
      meta: { configVersion: '5.3.19', state: rec.state, user: { agencyPersonId: control.userId, claims: ['CREW'], fullName: control.userName } },
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
      // shape a record the way an admin would: destination, lock state, incident date
      if (path.startsWith('/__shape/') && req.method === 'POST') {
        const r = records.get(path.split('/')[2]); if (!r) return send(404, { error: 'no such record' });
        const b = JSON.parse(body || '{}');
        if ('destination' in b) r.destination = b.destination;
        if ('locked' in b) { r.locked = !!b.locked; r.state = r.locked ? 'locked' : 'draft'; }
        if (b.incidentDateTime) r.incidentDateTime = new Date(b.incidentDateTime);
        if (Array.isArray(b.crew)) { r.crew = b.crew.map(c => ({ itemId: randomUUID(), firstName: null, lastName: null, rank: 0, ...c })); for (const c of r.crew) r.knownKeys.add(c.itemId); }
        return send(200, { ok: true });
      }
      if (path === '/__faxes') return send(200, { faxHistory, emails });
      if (path === '/__db_dump') return send(200, [...dbUsers.values()]);
      if (path === '/__db_set' && req.method === 'POST') { const r = JSON.parse(body || '{}'); dbUsers.set(r.name, { settings: {}, ...r, updated_at: r.updated_at || new Date().toISOString() }); return send(200, { ok: true }); }
      // ---- the settings table, the way Supabase's REST answers: GET ?name=eq.X, POST upsert, PATCH ?name=eq.X
      if (path === '/__db/esosave_users') {
        if (control.dbDown) { res.writeHead(503); return res.end(); }
        if (req.headers.apikey !== 'test-anon') return send(401, { message: 'No API key found in request' });
        const eq = /^eq\.(.*)$/.exec(u.searchParams.get('name') || '');
        if (req.method === 'GET') return send(200, eq ? [dbUsers.get(eq[1])].filter(Boolean) : [...dbUsers.values()]);
        const b = JSON.parse(body || '{}');
        if (req.method === 'POST') {
          const rows = Array.isArray(b) ? b : [b];
          const out = [];
          for (const r of rows) {
            if (dbUsers.has(r.name) && !/merge-duplicates/.test(req.headers.prefer || '')) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
            const row = { ...(dbUsers.get(r.name) || { settings: {} }), ...r, updated_at: new Date().toISOString() };
            dbUsers.set(r.name, row); out.push(row);
          }
          return send(201, /return=representation/.test(req.headers.prefer || '') ? out : '');
        }
        if (req.method === 'PATCH' && eq) {
          const row = dbUsers.get(eq[1]); if (!row) return send(200, []);
          Object.assign(row, b, { updated_at: new Date().toISOString() });
          return send(200, /return=representation/.test(req.headers.prefer || '') ? [row] : '');
        }
        return send(405, { error: 'method' });
      }
      // ---- static app
      if (path === '/ehr' || path === '/ehr/') return send(200, readFileSync(join(publicDir, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      if (path === '/ehr/app.js') return send(200, readFileSync(join(publicDir, 'app.js'), 'utf8'), 'text/javascript');
      if (path === '/login/') return send(200, '<html><body><h1>ESO login</h1></body></html>', 'text/html; charset=utf-8');
      // ---- api
      if (!path.startsWith('/ehr/api/')) return send(404, { error: 'not found' });
      if (control.loggedOut) { res.writeHead(302, { location: '/login/?ReturnUrl=' + encodeURIComponent(path) }); return res.end(); }
      const rest = path.slice('/ehr/api/'.length);
      if (rest === 'thirdpartydata/partners') return send(200, { partners: [] });
      // ESO's configuration bundle: every pick list, including the agency's saved facilities
      if (rest.startsWith('configurationBundle/') && req.method === 'GET') return send(200, {
        configVersion: '5.3.19', bundleVersion: '5.3.19.1', mdmVersion: '3.3', fieldConfigs: [], lists: {
          'UDL.LOCATIONS': { values: [
            { itemId: 'loc-anderson', itemName: 'Anderson Hospital', locationTypeId: 6540, city: 'Maryville' },
            { itemId: 'loc-stjohns', itemName: "HSHS St. John's", locationTypeId: 6540, city: 'Springfield' },
            { itemId: 'loc-sbl', itemName: 'Sarah Bush Lincoln', locationTypeId: 6540, city: 'Mattoon' },
            { itemId: 'loc-breese', itemName: 'Breese Nursing Home', locationTypeId: 6542, city: 'Breese' },
            { itemId: 'loc-lakeland', itemName: 'Lakeland Rehab & Healthcare', locationTypeId: 6545, city: 'Effingham' },
          ] },
          'SL.LOCATIONTYPE': { values: [{ itemId: 6535, itemName: 'Home/Residence' }, { itemId: 6540, itemName: 'Hospital' }, { itemId: 6542, itemName: 'Nursing home' }, { itemId: 6545, itemName: 'Rehabilitation Center' }] },
          'SL.DESTINATIONTYPE': { values: [{ itemId: 6575, itemName: 'Hospital', parentItemId: 6540 }, { itemId: 6577, itemName: 'Nursing Home', parentItemId: 6542 }, { itemId: 6580, itemName: 'Rehabilitation Center', parentItemId: 6545 }, { itemId: 6582, itemName: 'Home', parentItemId: 6535 }] },
        },
      });
      if (rest.startsWith('WebApi') && req.method === 'POST') return send(200, { result: '', status: 204 });
      if (rest.startsWith('custom/lookup')) return send(200, { items: [1, 2, 3] });
      if (rest === 'PatientCareRecords' && req.method === 'POST') { const r = newRecord(); return send(200, { result: 'Success', data: r.id }); }
      const esoDate = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
      const esoStamp = (d) => `${esoDate(d)} @${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      const parseEso = (t) => { const m = /^(\d\d)\/(\d\d)\/(\d{4})/.exec(String(t || '')); return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null; };
      // the records feed: POST /PatientCareRecords/Search {startDate,endDate,index,count,filters:[{fieldRef:'PCRSEARCHSTATUS',itemId:6,value:[2]}]}
      if (rest === 'PatientCareRecords/Search' && req.method === 'POST') {
        const q = JSON.parse(body || '{}');
        const from = parseEso(q.startDate), to = parseEso(q.endDate); if (to) to.setHours(23, 59, 59, 999);
        const st = (q.filters || []).find(f => f.fieldRef === 'PCRSEARCHSTATUS');
        const wantLocked = st && Array.isArray(st.value) && st.value.includes(2);
        const rows = [...records.values()].filter(r => (!from || r.incidentDateTime >= from) && (!to || r.incidentDateTime <= to) && (!st || (wantLocked ? r.locked : !r.locked)))
          .sort((a, b) => b.incidentDateTime - a.incidentDateTime)
          .map(r => ({ status: r.locked ? 'REPORT_LOCKED' : 'REPORT_UNLOCKED', incidentDateTime: r.incidentDateTime.toISOString(), incidentNumber: r.incidentNumber, unitId: null, sceneLocation: null, patientName: 'TEST, PATIENT', leadProviderNonCrewName: null, leadProviderAgencyPersonId: null, cardiacAttachmentCount: 0, otherAttachmentCount: 0, pcrId: r.id, incidentUnitId: null, destinationName: r.destination ? r.destination.name : null, fax: null, deleted: false, callNature: null }));
        const index = Number(q.index) || 0, count = Number(q.count) || 100;
        return send(200, { callNatureIsActive: false, data: rows.slice(index, index + count), meta: null, responseStatus: null });
      }
      if (rest === 'FaxHistory/Search' && req.method === 'POST') {
        const q = JSON.parse(body || '{}');
        const from = parseEso(q.incidentStartDate), to = parseEso(q.incidentEndDate); if (to) to.setHours(23, 59, 59, 999);
        const rows = faxHistory.filter(f => { const r = records.get(f.pcrId); const d = r ? r.incidentDateTime : new Date(); return (!from || d >= from) && (!to || d <= to); }).slice().reverse();
        return send(200, { data: rows });
      }
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
      if (/^lock$/i.test(tail) && req.method === 'POST') { rec.state = 'locked'; rec.locked = true; return send(200, { result: 'Success', data: null }); }
      if (/^unlock$/i.test(tail) && req.method === 'POST') { rec.state = 'draft'; rec.locked = false; return send(200, { result: 'Success', data: null }); }
      // fax / email, exactly as ESO answers
      const canSend = (kind) => {
        const d = rec.destination;
        if (!d) return { ok: false, destinationName: null, error: 'This record has no selected destination.', resultCode: -1 };
        if (kind === 'fax' && !d.fax) return { ok: false, destinationName: null, error: "The patient's destination does not have an associated fax number", resultCode: -2 };
        if (kind === 'email' && !d.email) return { ok: false, destinationName: null, error: "The patient's destination does not have an associated email address", resultCode: -2 };
        return { ok: true, destinationName: d.name, error: null, resultCode: 0 };
      };
      if (/^Fax\/CanSend$/i.test(tail) && req.method === 'GET') return send(200, canSend('fax'));
      if (/^Email\/canSend$/i.test(tail) && req.method === 'GET') return send(200, canSend('email'));
      if (/^Fax\/Send$/i.test(tail) && req.method === 'POST') {
        const c = canSend('fax'); if (!c.ok) return send(400, { result: 'Failure', message: c.error });
        faxHistory.push({ itemId: String(++faxSeq), sentAt: esoStamp(new Date()), incident: rec.incidentNumber, destination: rec.destination.name, status: control.faxStatus, pcrId: rec.id });
        return send(200, { result: 'Success', data: null });
      }
      if (/^Email\/Send$/i.test(tail) && req.method === 'POST') {
        const c = canSend('email'); if (!c.ok) return send(400, { result: 'Failure', message: c.error });
        emails.push({ pcrId: rec.id, incident: rec.incidentNumber, destination: rec.destination.name, at: Date.now() });
        return send(200, { result: 'Success', data: null });
      }
      return send(404, { error: 'unknown api: ' + rest });
    });
  });

  return {
    server, records, control, faxHistory, emails,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mock = createMockEso();
  const url = await mock.listen();
  console.log('mock ESO at', url + '/ehr/');
}
