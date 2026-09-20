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
  const control = { loggedOut: false, rejectValue: null, failAutosaves: 0, refuseAutosaves: 0, faxStatus: 'SUCCESS', userName: 'TEST, MEDIC', userId: 'person-1', dbDown: false, scanner: false, log: [] };
  // a stand-in for the extension's settings table (Supabase's REST shape): one row per ESO login
  const dbUsers = new Map();
  const dbTables = { call_log_entries: [], users: [], ambulances: [] }; // the agency's own tables, seeded by tests
  const dbTpl = { esosave_templates: new Map(), esosave_template_shares: [] }; // the crew's templates
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
      crew: [{ personnelId: control.userId, itemId: randomUUID(), firstName: (control.userName.split(',')[1] || 'MEDIC').trim(), lastName: control.userName.split(',')[0].trim(), rank: 0, roleIds: [], certification: ({ 'person-1': 'cred-b1', 'person-2': 'cred-p2', 'person-m': 'cred-bm', 'person-j': 'cred-bj', 'd4e45fac-ee36-4ac8-bf9a-3fb3e265c0d0': 'cred-bg' })[control.userId] || null }],
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

  const native = { scans: [], opened: [], consumed: [], claimed: [] };
  function multipart(buf, boundary) {
    const out = [];
    const sep = Buffer.from('--' + boundary);
    let pos = buf.indexOf(sep);
    while (pos !== -1) {
      let start = pos + sep.length;
      if (buf.slice(start, start + 2).toString() === '--') break;
      start += 2; // CRLF
      const hEnd = buf.indexOf('\r\n\r\n', start); if (hEnd === -1) break;
      const headers = buf.slice(start, hEnd).toString('utf8');
      const next = buf.indexOf(sep, hEnd + 4); if (next === -1) break;
      const data = buf.slice(hEnd + 4, next - 2);
      const name = (/name="([^"]*)"/.exec(headers) || [])[1] || '';
      const filename = (/filename="([^"]*)"/.exec(headers) || [])[1];
      const contentType = (/content-type:\s*([^\r\n]+)/i.exec(headers) || [])[1] || null;
      out.push({ name, filename, contentType, data, text: filename === undefined ? data.toString('utf8') : null });
      pos = next;
    }
    return out;
  }
  // a slice of ESO's field catalog (address -> field ref, type, name, list), enough for Templates
  const F = (fieldRef, dataType, displayName, listRef) => ({ fieldRef, dataType, displayName, listRef, associatedListRefs: [], constraints: {}, showField: true, tags: ['PCR_TAB'] });
  const FIELD_CONFIGS = {
    'incident.response.incidentNumber': F('INCIDENTNUMBER', 'string', 'Incident Number'),
    'incident.response.unitId': F('UNITID', 'singleselect', 'Unit', 'UDL.UNIT'),
    'incident.response.runTypeId': F('RUNTYPEID', 'singleselect', 'Run Type', 'SL.RUNTYPE'),
    'incident.response.priorityId': F('PRIORITYID', 'singleselect', 'Priority', 'SL.RESPONSEPRIORITY'),
    'incident.response.emdPerformedID': F('EMDPERFORMEDID', 'singleselect', 'EMD Performed', 'SL.EMDPERFORMED'),
    'incident.additionalFactors.dispatchDelays': F('DISPATCHDELAYS', 'multiselect', 'Dispatch Delays', 'SL.DISPATCHDELAY'),
    'incident.crew.roleIds': F('PERSONNELROLEIDS', 'multiselect', 'Roles', 'SL.CREWROLE'),
    'incident.scene.manualAddress.locationName': F('SCENELOCATIONNAME', 'string', 'Location Name'),
    'patient.demographics.lastName': F('PATIENTLASTNAME', 'string', 'Last Name'),
    'patient.demographics.weight': F('PATIENTWEIGHT', 'number', 'Weight'),
    'patient.demographics.raceIds': F('PATIENTRACEIDS', 'multiselect', 'Race', 'SL.RACE'),
    'patient.patientMedicalHistories': F('PATIENTMEDICALHISTORY', 'fieldGroup', 'Patient History'),
    'patient.patientMedicalHistories.itemId': F('PATIENTMEDICALHISTORYITEMID', 'singleselect', 'Item', 'SL.MEDICALHISTORY'),
    'patient.patientMedicalHistories.comment': F('PATIENTMEDICALHISTORYCOMMENT', 'string', 'Comments'),
    'patient.patientHistoriesPertinentNegativeId': F('PATIENTHISTORIESPERTINENTNEGATIVEID', 'pertinentNegative', 'Reason Unable To Obtain', 'SL.PERTINENTNEGATIVEHISTORY'),
    'vitals.vitalSigns': F('VITALSIGN', 'collectionWithData', 'Vital Signs'),
    'vitals.vitalSigns.vitalSignDateTime': F('VITALSIGNDATETIME', 'datetime', 'Vital Sign Date Time'),
    'vitals.vitalSigns.bloodPressure.bloodPressureSystolic': F('BLOODPRESSURESYSTOLIC', 'string', 'Systolic'),
    'vitals.vitalSigns.bloodPressure.bloodPressureDiastolic': F('BLOODPRESSUREDIASTOLIC', 'string', 'Diastolic'),
    'vitals.vitalSigns.pulse.pulseRate': F('PULSERATE', 'string', 'Rate'),
    'vitals.vitalSigns.glasgowComaScale.glascowComaTotalScore': F('GLASCOWCOMATOTALSCORE', 'integer', 'Total Score'),
    'vitals.vitalSigns.softDeleted': F('VITALSIGNSOFTDELETED', 'boolean', 'Soft Deleted'),
    'flowchartTreatments.treatments': F('FLOWCHARTTREATMENT', 'collectionWithData', 'Treatments'),
    'flowchartTreatments.treatments.flowchartTreatmentRegistryId': F('FLOWCHARTTREATMENTREGISTRYID', 'singleselect', 'Treatment', 'UDL.FLOWCHARTTREATMENTREGISTRY'),
    'flowchartTreatments.treatments.dose': F('FLOWCHARTTREATMENTDOSE', 'number', 'Dose'),
    'flowchartTreatments.treatments.doseUnitId': F('FLOWCHARTTREATMENTDOSEUNITID', 'singleselect', 'Measure', 'UDL.AGENCYFLOWCHARTMEDICATIONMEASURE'),
    'flowchartTreatments.treatments.comments': F('FLOWCHARTTREATMENTCOMMENTS', 'string', 'Comments'),
    'flowchartTreatments.treatments.successful': F('FLOWCHARTTREATMENTSUCCESSFUL', 'boolean', 'Successful'),
    'assessments.assessmentsV2': F('ASSESSMENT2', 'collectionWithData', 'Assessments'),
    'assessments.assessmentsV2.findings': F('ASSESSMENT2FINDINGS', 'binary', 'Findings'),
    'assessments.assessmentsV2.abdomenSection.comments': F('ASSESSMENT2ABDOMENSECTIONCOMMENTS', 'string', 'Abdomen Comments'),
    'narrative.clinicalImpression.primaryImpressionId': F('PRIMARYIMPRESSIONID', 'singleselect', 'Primary Impression', 'SL.PRIMARYIMPRESSION'),
    'narrative.narrative.narrativeText': F('NARRATIVETEXT', 'string', 'Narrative'),
    'narrative.supportingSignsAndSymptomsEnhanced.signsAndSymptomsEnhanced': F('SIGNSANDSYMPTOMSENHANCED', 'collectionWithData', 'Signs/Symptoms'),
    'narrative.supportingSignsAndSymptomsEnhanced.signsAndSymptomsEnhanced.primaryId': F('SIGNSANDSYMPTOMSENHANCEDPRIMARYID', 'singleselect', 'Category', 'SL.SUPPORTINGPRIMARY'),
    'narrative.supportingSignsAndSymptomsEnhanced.signsAndSymptomsEnhanced.signId': F('SIGNSANDSYMPTOMSENHANCEDSIGNID', 'singleselect', 'Sign/Symptom', 'SL.SUPPORTINGSIGNSYMPTOM'),
    'forms.specialtyForms.cpr.witnessedById': F('CPRWITNESSEDBYID', 'singleselect', 'Witnessed By', 'SL.CPRWITNESSEDBY'),
    'billing.transport.physiciansCertificationStatement': F('BILLINGPHYSICIANSCERTIFICATIONSTATEMENT', 'boolean', "Physician's Certification Statement (PCS)"),
    'signatures.standardSignatures.standardRefusal.capacityAssessment.legalIds': F('STANDARDREFUSALLEGALIDS', 'multiselect', 'Legal', 'UDL.STANDARDREFUSAL_LEGAL'),
    'signatures.standardSignatures.patientSignature.strokes': F('PATIENTSIGNATURESTROKES', 'strokes', 'Signature'),
  };
  const V = (pairs, extra) => ({ values: pairs.map(([itemId, itemName], i) => ({ itemId, itemName, parentItemId: null, ...(extra ? extra(itemId, i) : {}) })) });
  const TPL_LISTS = {
    'SL.RUNTYPE': V([[325, 'Emergency Interfacility Transfer'], [326, '911 Response (Scene)'], [327, 'Mutual Aid']]),
    'SL.RESPONSEPRIORITY': V([[330, 'Emergent'], [331, 'Non-Emergent']]),
    'SL.EMDPERFORMED': V([[340, 'Yes'], [341, 'No']]),
    'SL.DISPATCHDELAY': V([[350, 'None/No Delay'], [351, 'Weather'], [352, 'Traffic']]),
    'SL.MEDICALHISTORY': V([[1337168, 'Hypertension'], [1337170, 'Diabetes'], [1337172, 'COPD']]),
    'SL.PERTINENTNEGATIVEHISTORY': V([[360, 'Unable to Obtain'], [361, 'Not Applicable']]),
    'UDL.FLOWCHARTTREATMENTREGISTRY': { values: [{ itemId: 1416, itemName: 'Oxygen', isMedication: true }, { itemId: 1417, itemName: 'Aspirin', isMedication: true }, { itemId: 1418, itemName: 'IV Therapy', isMedication: false }] },
    'UDL.AGENCYFLOWCHARTMEDICATIONMEASURE': { values: [{ itemId: 9001, itemName: 'L/min', parentItemId: 1416 }, { itemId: 9002, itemName: 'mg', parentItemId: 1417 }] },
    'SL.PRIMARYIMPRESSION': V([[500, 'Chest Pain'], [501, 'Abdominal Pain'], [502, 'Weakness']]),
    'SL.SUPPORTINGPRIMARY': V([[711, 'Cardiovascular'], [712, 'Respiratory']]),
    'SL.SUPPORTINGSIGNSYMPTOM': V([[791, 'Chest pain'], [792, 'Shortness of breath']]),
    'SL.CPRWITNESSEDBY': V([[600, 'Bystander'], [601, 'EMS']]),
    'UDL.STANDARDREFUSAL_LEGAL': V([['aaaa-1', 'Adult'], ['aaaa-2', 'Emancipated minor']]),
    'UDL.UNIT': V([[3001, '23'], [3002, '16']]),
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname.replace(/\/{2,}/g, '/');
    control.log.push({ method: req.method, path: path + u.search, t: Date.now() });
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
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
        return r ? send(200, { id: r.id, incidentNumber: r.incidentNumber, state: r.state, tree: r.tree, ops: r.ops, mappings: r.mappings, crew: r.crew, autosaves: r.autosaves, attachments: (r.attachments || []).map(a => ({ itemId: a.itemId, name: a.name, description: a.description, bytes: a.bytes, contentType: a.contentType })) }) : send(404, { error: 'no such record' });
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
      if (path === '/__db_tpl_dump') return send(200, { templates: [...dbTpl.esosave_templates.values()], shares: dbTpl.esosave_template_shares });
      if (path === '/__db_tpl_reset' && req.method === 'POST') { dbTpl.esosave_templates.clear(); dbTpl.esosave_template_shares.length = 0; return send(200, { ok: true }); }
      // the templates tables, as PostgREST serves them: eq./in.() filters, or=(...), upsert on the id, delete by filter
      const tm = /^\/__db\/(esosave_templates|esosave_template_shares)$/.exec(path);
      if (tm) {
        if (control.dbDown) { res.writeHead(503); return res.end(); }
        if (req.headers.apikey !== 'test-anon') return send(401, { message: 'No API key found in request' });
        const table = tm[1];
        const rowsOf = () => table === 'esosave_templates' ? [...dbTpl.esosave_templates.values()] : dbTpl.esosave_template_shares.slice();
        const cond = (row, key, expr) => { const m = /^(eq|in|ilike)\.(.*)$/.exec(expr); if (!m) return true; if (m[1] === 'eq') return String(row[key]) === m[2]; if (m[1] === 'ilike') return new RegExp('^' + m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(row[key])); const set = m[2].replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).filter(Boolean); return set.includes(String(row[key])); };
        const matches = (row) => {
          for (const [k, v] of u.searchParams) {
            if (k === 'select' || k === 'order' || k === 'limit') continue;
            if (k === 'or') { const parts = v.replace(/^\(|\)$/g, '').split(/,(?![^(]*\))/); if (!parts.some(pt => { const i = pt.indexOf('.'); const key = pt.slice(0, i); const expr = pt.slice(i + 1); return cond(row, key, expr); })) return false; continue; }
            if (!cond(row, k, v)) return false;
          }
          return true;
        };
        if (req.method === 'GET') return send(200, rowsOf().filter(matches));
        const b = JSON.parse(body || '{}');
        if (req.method === 'POST') {
          const rows = Array.isArray(b) ? b : [b]; const out = [];
          for (const r of rows) {
            if (table === 'esosave_templates') {
              const id = r.id || randomUUID();
              if (dbTpl.esosave_templates.has(id) && !/merge-duplicates/.test(req.headers.prefer || '')) return send(409, { code: '23505', message: 'duplicate key' });
              const row = { ...(dbTpl.esosave_templates.get(id) || { created_at: new Date().toISOString(), share: 'private', body: {} }), ...r, id, updated_at: new Date().toISOString() };
              // the unique indexes: one name per shared category, one per person among private ones
              const same = (x) => x.id !== id && String(x.name).toLowerCase() === String(row.name).toLowerCase();
              if ([...dbTpl.esosave_templates.values()].some(x => same(x) && (row.share === 'private' ? x.share === 'private' && x.owner_id === row.owner_id : x.share === row.share))) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint "esosave_templates_shared_name"' });
              dbTpl.esosave_templates.set(id, row); out.push(row);
            } else {
              if (!dbTpl.esosave_templates.has(r.template_id)) return send(409, { code: '23503', message: 'foreign key' });
              const i = dbTpl.esosave_template_shares.findIndex(x => x.template_id === r.template_id && x.person_id === r.person_id);
              if (i >= 0 && !/merge-duplicates/.test(req.headers.prefer || '')) return send(409, { code: '23505', message: 'duplicate key' });
              if (i >= 0) dbTpl.esosave_template_shares[i] = { ...dbTpl.esosave_template_shares[i], ...r }; else dbTpl.esosave_template_shares.push({ ...r });
              out.push(r);
            }
          }
          return send(201, /return=representation/.test(req.headers.prefer || '') ? out : '');
        }
        if (req.method === 'PATCH') {
          const hit = rowsOf().filter(matches);
          for (const row of hit) Object.assign(row, b, table === 'esosave_templates' ? { updated_at: new Date().toISOString() } : {});
          return send(200, /return=representation/.test(req.headers.prefer || '') ? hit : '');
        }
        if (req.method === 'DELETE') {
          const hit = rowsOf().filter(matches);
          if (table === 'esosave_templates') { for (const row of hit) { dbTpl.esosave_templates.delete(row.id); dbTpl.esosave_template_shares = dbTpl.esosave_template_shares.filter(x => x.template_id !== row.id); } }
          else dbTpl.esosave_template_shares = dbTpl.esosave_template_shares.filter(x => !hit.includes(x));
          return send(200, /return=representation/.test(req.headers.prefer || '') ? hit : '');
        }
        return send(405, { error: 'method' });
      }
      // the ESO Save app's side of the iPad scanner, as the Safari extension handler would answer
      if (path === '/__native' && req.method === 'POST') {
        const m = JSON.parse(body || '{}');
        if (m.type === 'ping') return send(200, { ok: true, native: true, scanner: control.scanner !== false });
        if (m.type === 'scans') return send(200, { scans: native.scans.filter(x => !x.taken).map(x => ({ id: x.id, type: x.type, record: x.record, incident: x.incident, at: x.at })) });
        if (m.type === 'claim') { const x = native.scans.find(y => y.id === m.id && !y.taken); if (!x) return send(200, { scan: null }); x.taken = true; native.claimed.push(m.id); return send(200, { scan: { ...x, taken: undefined } }); }
        if (m.type === 'consume') { native.scans = native.scans.filter(x => x.id !== m.id); native.consumed.push(m.id); return send(200, { ok: true }); }
        if (m.type === 'open') { native.opened.push(m.url); return send(200, { ok: true }); }
        return send(200, { ok: false });
      }
      if (path === '/__native_seed' && req.method === 'POST') { const b = JSON.parse(body || '{}'); native.scans.push(...(b.scans || [])); return send(200, { ok: true }); }
      if (path === '/__native_dump') return send(200, native);
      if (path === '/__native_reset' && req.method === 'POST') { native.scans = []; native.opened = []; native.consumed = []; native.claimed = []; return send(200, { ok: true }); }
      if (path === '/__db_seed' && req.method === 'POST') { const b = JSON.parse(body || '{}'); dbTables[b.table] = b.rows || []; return send(200, { ok: true }); }
      // the agency's tables, read the way Supabase's REST answers: ?col=eq.v, ?col=in.(a,b)
      { const m = /^\/__db\/(call_log_entries|users|ambulances)$/.exec(path);
        if (m) {
          if (control.dbDown) { res.writeHead(503); return res.end(); }
          if (req.headers.apikey !== 'test-anon') return send(401, { message: 'No API key found in request' });
          let rows = dbTables[m[1]].slice();
          for (const [k, v] of u.searchParams) {
            if (['select', 'order', 'limit'].includes(k)) continue;
            const eq = /^eq\.(.*)$/.exec(v), inn = /^in\.\((.*)\)$/.exec(v);
            if (eq) rows = rows.filter(r => String(r[k]) === eq[1]);
            else if (inn) { const set = inn[1].split(',').map(x => decodeURIComponent(x)); rows = rows.filter(r => set.includes(String(r[k]))); }
          }
          const lim = Number(u.searchParams.get('limit')); if (lim) rows = rows.slice(0, lim);
          return send(200, rows);
        } }
      if (path === '/__db_set' && req.method === 'POST') { const r = JSON.parse(body || '{}'); dbUsers.set(r.name, { settings: {}, ...r, updated_at: r.updated_at || new Date().toISOString() }); return send(200, { ok: true }); }
      // ---- the settings table, the way Supabase's REST answers: GET ?name=eq.X, POST upsert, PATCH ?name=eq.X
      if (path === '/__db/esosave_users') {
        if (control.dbDown) { res.writeHead(503); return res.end(); }
        if (req.headers.apikey !== 'test-anon') return send(401, { message: 'No API key found in request' });
        const eq = /^eq\.(.*)$/.exec(u.searchParams.get('name') || '');
        const pq = /^eq\.(.*)$/.exec(u.searchParams.get('person_id') || '');
        const byPid = pq ? [...dbUsers.values()].find(r => r.person_id === pq[1]) : null;
        if (req.method === 'GET') return send(200, pq ? [byPid].filter(Boolean) : eq ? [dbUsers.get(eq[1])].filter(Boolean) : [...dbUsers.values()]);
        const b = JSON.parse(body || '{}');
        if (req.method === 'PATCH' && pq) {
          if (!byPid) return send(200, []);
          if (b.name && b.name !== byPid.name) { dbUsers.delete(byPid.name); byPid.name = b.name; dbUsers.set(b.name, byPid); }
          Object.assign(byPid, b, { updated_at: new Date().toISOString() });
          return send(200, /return=representation/.test(req.headers.prefer || '') ? [byPid] : '');
        }
        if (req.method === 'POST') {
          const rows = Array.isArray(b) ? b : [b];
          const out = [];
          for (const r of rows) {
            if (dbUsers.has(r.name) && !/merge-duplicates/.test(req.headers.prefer || '')) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
            if (r.person_id && [...dbUsers.values()].some(x => x.person_id === r.person_id && x.name !== r.name)) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint "esosave_users_person_id"' });
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
        configVersion: '5.3.19', bundleVersion: '5.3.19.1', mdmVersion: '3.3', fieldConfigs: FIELD_CONFIGS, lists: {
          ...TPL_LISTS,
          'UDL.LOCATIONS': { values: [
            { itemId: 'loc-anderson', itemName: 'Anderson Hospital', locationTypeId: 6540, city: 'Maryville' },
            { itemId: 'loc-stjohns', itemName: "HSHS St. John's", locationTypeId: 6540, city: 'Springfield' },
            { itemId: 'loc-sbl', itemName: 'Sarah Bush Lincoln', locationTypeId: 6540, city: 'Mattoon' },
            { itemId: 'loc-breese', itemName: 'Breese Nursing Home', locationTypeId: 6542, city: 'Breese' },
            { itemId: 'loc-lakeland', itemName: 'Lakeland Rehab & Healthcare', locationTypeId: 6545, city: 'Effingham' },
          ] },
          'UDL.CREW': { values: [
            { itemId: 'person-1', firstName: 'MEDIC', lastName: 'TEST', credentials: [{ credentialName: 'EMT-Basic', personCredentialID: 'cred-b1', credentialId: 'd4874fd4' }] },
            { itemId: 'person-2', firstName: 'PAT', lastName: 'MEDIC', credentials: [{ credentialName: 'EMT-Paramedic', personCredentialID: 'cred-p2', credentialId: '0316067f' }] },
            { itemId: 'person-m', firstName: 'ALEX', lastName: 'JONES', credentials: [{ credentialName: 'EMT-Basic', personCredentialID: 'cred-bm', credentialId: 'd4874fd4' }] },
            { itemId: 'person-j', firstName: 'JANE', lastName: 'SMITH', credentials: [{ credentialName: 'EMT-Basic', personCredentialID: 'cred-bj', credentialId: 'd4874fd4' }] },
            { itemId: 'd4e45fac-ee36-4ac8-bf9a-3fb3e265c0d0', firstName: 'MICHAEL', lastName: 'GASTON', credentials: [{ credentialName: 'EMT-Basic', personCredentialID: 'cred-bg', credentialId: 'd4874fd4' }] },
          ] },
          'SL.LOCATIONTYPE': { values: [{ itemId: 6535, itemName: 'Home/Residence' }, { itemId: 6540, itemName: 'Hospital' }, { itemId: 6542, itemName: 'Nursing home' }, { itemId: 6545, itemName: 'Rehabilitation Center' }] },
          'SL.DESTINATIONTYPE': { values: [{ itemId: 6575, itemName: 'Hospital', parentItemId: 6540 }, { itemId: 6577, itemName: 'Nursing Home', parentItemId: 6542 }, { itemId: 6580, itemName: 'Rehabilitation Center', parentItemId: 6545 }, { itemId: 6582, itemName: 'Home', parentItemId: 6535 }] },
          // what a facesheet fill needs, as ESO lists them
          'UDL.PLACESSTATES': { values: [{ itemId: 260, stateName: 'Illinois', stateAbbr: 'IL', itemName: 'Illinois' }, { itemId: 261, stateName: 'Indiana', stateAbbr: 'IN', itemName: 'Indiana' }, { itemId: 269, stateName: 'Missouri', stateAbbr: 'MO', itemName: 'Missouri' }] },
          'SL.PHONETYPES': { values: [{ itemId: 12833, itemName: 'Daytime' }, { itemId: 12834, itemName: 'Evening' }, { itemId: 12830, itemName: 'Home' }, { itemId: 12831, itemName: 'Home Mobile' }, { itemId: 12827, itemName: 'Work' }, { itemId: 12828, itemName: 'Work Mobile' }] },
          'SL.SEX': { values: [{ itemId: 15359, itemName: 'Female' }, { itemId: 15360, itemName: 'Male' }, { itemId: 15361, itemName: 'Unknown' }] },
          'SL.GENDER': { values: [{ itemId: 314, itemName: 'Female' }, { itemId: 313, itemName: 'Male' }, { itemId: 10316, itemName: 'Unknown (Unable to Determine)' }] },
          'SL.RACE': { values: [{ itemId: 315, itemName: 'American Indian or Alaska Native' }, { itemId: 316, itemName: 'Asian' }, { itemId: 317, itemName: 'Black or African American' }, { itemId: 10317, itemName: 'Hispanic or Latino' }, { itemId: 1338789, itemName: 'Middle Eastern or North African' }, { itemId: 318, itemName: 'Native Hawaiian or Other Pacific Islander' }, { itemId: 319, itemName: 'White' }] },
          'UDL.BILLINGINSURANCEPRIMARYPAYER': { values: [{ itemId: 6503, itemName: 'Insurance' }, { itemId: 6504, itemName: 'Medicaid' }, { itemId: 6505, itemName: 'Medicare' }, { itemId: 6506, itemName: 'Not Billed (for any reason)' }, { itemId: 6508, itemName: 'Self Pay' }] },
          'SL.BILLING_INSURANCE_RELATIONSHIP': { values: [{ itemId: 5780, itemName: 'Self' }, { itemId: 5781, itemName: 'Spouse' }, { itemId: 5782, itemName: 'Child/Dependent' }, { itemId: 5783, itemName: 'Parent' }, { itemId: 5784, itemName: 'Other Relationship' }] },
          'UDL.INSURANCECOMPANY': { values: [{ isOtherInsurance: true, itemId: '837a41ec-8038-4835-ab43-5c3807219a7f', itemName: 'Other Insurance' }] },
        },
      });
      if (rest.startsWith('WebApi') && req.method === 'POST') return send(200, { result: '', status: 204 });
      // ESO's places table, looked up after a zip is typed: GET /placesSearch?city=&stateId=&zip=
      if (rest === 'placesSearch' && req.method === 'GET') {
        const zip = u.searchParams.get('zip') || '', st = Number(u.searchParams.get('stateId'));
        const places = [{ placeId: 'd18c7e7e-01e7-4498-a5fe-c53f6cde4159', city: 'Salem', stateId: 260, state: 'Illinois', county: 'Marion', zip: '62881' }, { placeId: 'place-brownstown', city: 'Brownstown', stateId: 260, state: 'Illinois', county: 'Fayette', zip: '62418' }, { placeId: 'place-effingham', city: 'Effingham', stateId: 260, state: 'Illinois', county: 'Effingham', zip: '62401' }];
        return send(200, { data: places.filter(p => p.zip === zip && p.stateId === st), meta: null, responseStatus: null });
      }
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
      rec.attachments = rec.attachments || [];
      if (tail === 'Attachments' && req.method === 'GET') return send(200, { data: { model: { attachments: rec.attachments.map(a => ({ ...a, bytes: undefined })), incidentNumber: rec.incidentNumber } }, meta: { state: rec.state, user: { agencyPersonId: control.userId, claims: ['CREW'], fullName: control.userName } }, responseStatus: null });
      if (tail === 'Attachments' && req.method === 'POST') {
        // multipart, as ESO's dialog sends it: a description part and a file part
        const bm = /boundary=([^;]+)/.exec(req.headers['content-type'] || ''); if (!bm) return send(400, { result: 'Failure', message: 'not multipart' });
        const parts = multipart(raw, bm[1].trim());
        const file = parts.find(p => p.name === 'file'), desc = parts.find(p => p.name === 'description');
        if (!file) return send(400, { result: 'Failure', message: 'no file' });
        const ext = (file.filename.split('.').pop() || '').toLowerCase();
        const a = { itemId: randomUUID(), extension: ext, name: file.filename, link: `PatientCareRecords/${rec.id}/Attachments/`, hicCsvLink: null, m2MLink: null, description: desc && desc.text ? desc.text : null, bytes: file.data.length, contentType: file.contentType };
        a.link += a.itemId;
        rec.attachments.push(a);
        return send(200, { result: 'Success', data: { ...a, bytes: undefined, contentType: undefined } });
      }
      const da = /^Attachments\/([^/]+)$/.exec(tail);
      if (da && req.method === 'DELETE') { const before = rec.attachments.length; rec.attachments = rec.attachments.filter(a => a.itemId !== da[1]); return before === rec.attachments.length ? send(404, { result: 'Failure', message: 'no such attachment' }) : send(200, { result: 'Success', data: null }); }
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
