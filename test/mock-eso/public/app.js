/* Fake ESO app. Mirrors what the real one does:
 *  - uses XMLHttpRequest with an x-custom-xsrf-token header
 *  - batches dirty fields per scope and POSTs them to /autosave every few hundred ms
 *  - invents GUIDs for new list items and switches to the server's key after the response
 *  - GETs Views/<tab> when switching tabs
 */
(() => {
  const XSRF = 'test-xsrf-token';
  const uuid = () => crypto.randomUUID();
  function xhr(method, url, body) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open(method, url, true);
      x.setRequestHeader('accept', 'application/json, text/plain, */*');
      x.setRequestHeader('x-custom-xsrf-token', XSRF);
      if (body !== undefined) x.setRequestHeader('content-type', 'application/json;charset=UTF-8');
      x.onloadend = () => resolve({ status: x.status, text: x.responseText, headers: x.getAllResponseHeaders() });
      x.send(body === undefined ? null : body);
    });
  }
  // the extension's buttons live in its own hosts (one fixed, one inside each scroller): a test looks in all of them
  const hosts = () => [document.getElementById('esosave-host'), ...document.querySelectorAll('.esosave-ride')].filter(h => h && h.shadowRoot);
  window.__q = (sel) => { for (const h of hosts()) { const r = h.shadowRoot.querySelector(sel); if (r) return r; } return null; };
  window.__qa = (sel) => hosts().flatMap(h => Array.from(h.shadowRoot.querySelectorAll(sel)));
  const app = window.app = {
    recordId: null, keyMap: {}, dirty: [], responses: [], views: {}, autosaveMs: 300, flushing: false, errors: [],
    async start() {
      const r = await xhr('POST', '/ehr/api/PatientCareRecords', JSON.stringify({ createdDateTime: '09/15/2026 14:08:24 -05:00' }));
      const j = JSON.parse(r.text);
      this.recordId = j.data; this.keyMap = {}; this.dirty = []; this.views = {}; this.rf = {}; this.num = {}; this.ss = {};
      await this.openTab('Incident');
      return this.recordId;
    },
    use(recordId) { this.recordId = recordId; this.keyMap = {}; this.dirty = []; this.views = {}; return this.openTab('Incident'); },
    edit(scope, address, value, dataType = 'string') { this.dirty.push({ scope, op: { verb: 'EDIT', address, fieldRef: 'X', value, dataType } }); },
    add(scope, address, value, dataType = 'collectionWithData') { this.dirty.push({ scope, op: { verb: 'ADD', address, fieldRef: 'X', value, dataType, isComplexType: true } }); },
    addScalar(scope, address, value, dataType = 'multiselect') { this.dirty.push({ scope, op: { verb: 'ADD', address, fieldRef: 'X', value, dataType } }); },
    del(scope, address, dataType = 'binary') { this.dirty.push({ scope, op: { verb: 'DELETE', address, fieldRef: 'X', value: null, dataType } }); },
    sign(scope, address, strokes) { this.edit(scope, address, { strokes, signTimestamp: '09/15/2026 14:18:45' }, 'strokes'); },
    rewrite(text) { const keys = Object.keys(this.keyMap); if (!keys.length) return text; return text.replace(new RegExp(keys.join('|'), 'g'), k => this.keyMap[k]); },
    async flush() {
      if (this.flushing || !this.dirty.length || !this.recordId) return;
      this.flushing = true;
      try {
        while (this.dirty.length) {
          const scope = this.dirty[0].scope;
          const ops = [];
          while (this.dirty.length && this.dirty[0].scope === scope) ops.push(this.dirty.shift().op);
          const body = this.rewrite(JSON.stringify(ops));
          const r = await xhr('POST', `/ehr/api/PatientCareRecords/${this.recordId}/autosave?scope=${scope}`, body);
          const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
          this.responses.push({ scope, status: r.status, text: r.text, held: /x-esosave/i.test(r.headers) });
          if (r.status === 200 && j && j.result === 'Success') { for (const m of (j.data || [])) this.keyMap[m.originalKey] = m.newKey; }
          else this.errors.push({ scope, status: r.status, text: r.text });
        }
      } finally { this.flushing = false; }
      render();
    },
    async openTab(view) {
      location.hash = `#/pcr/${this.recordId}/${view.toLowerCase()}`; // the real app keeps the run in the address
      const q = view === 'Incident' ? '?getMultiPatientData=true&getPcrHeaderData=true' : view === 'Assessments' ? '?getAssessmentListsData=true' : '';
      const r = await xhr('GET', `/ehr/api/PatientCareRecords/${this.recordId}/Views/${view}${q}`);
      const out = { status: r.status, body: (() => { try { return JSON.parse(r.text); } catch { return null; } })(), companions: [] };
      // the real app asks for more when some tabs open
      const extra = view === 'Vitals' ? [['GET', `/ehr/api/PatientCareRecords/${this.recordId}/CardiacMonitor`]]
        : view === 'Patient' ? [['POST', '/ehr/api/WebApi?path=api/LongitudinalRecordDetails', JSON.stringify({ ehrEncounterId: this.recordId })]]
        : view === 'FlowchartTreatments' ? [['GET', '/ehr/api/thirdpartydata/partners']]
        : view === 'CustomTab' ? [['GET', `/ehr/api/custom/lookup?record=${this.recordId}`]] : [];
      for (const [m, u, b] of extra) { const c = await xhr(m, u, b); out.companions.push({ url: u, status: c.status, text: c.text }); }
      this.views[view] = out;
      render();
      if (view === 'Vitals') renderVitals(out.body);
      document.getElementById('patient').style.display = view === 'Patient' ? 'block' : 'none';
      document.getElementById('incident').style.display = view === 'Incident' ? 'block' : 'none';
      document.getElementById('assess').style.display = view === 'Assessments' ? 'block' : 'none';
      if (view === 'Assessments') {
        const list = (out.body && out.body.data && out.body.data.model && out.body.data.model.assessmentsV2) || [];
        app.assessments = list.map(a => ({ key: String(a.itemId), time: String(a.assessmentTime || '').slice(-8), findings: (a.findings || []).map(f => ({ key: String(f.itemId), findingId: f.findingId, findingLocationId: f.findingLocationId, present: f.present })) }));
        renderAx();
      }
      if (view === 'Incident') { renderDelays(out.body); renderSS(out.body); renderCrew(out.body); loadBundle(); }
      document.getElementById('narrative').style.display = view === 'Narrative' ? 'block' : 'none';
      document.getElementById('signatures').style.display = view === 'Signatures' ? 'block' : 'none';
      if (view === 'Patient') { renderHistory(out.body); renderSS(out.body, 'patient'); renderNum(out.body, 'patient'); }
      if (view === 'Narrative') { renderAcuity(out.body); renderTransport(out.body); renderSS(out.body, 'narrative'); renderNum(out.body, 'narrative'); }
      return out;
    },
    // the real app validates, then POSTs lock with a timestamp; unlock likewise
    async lock() {
      await xhr('GET', `/ehr/api//PatientCareRecords/${this.recordId}/Validate?lrIsLinked=false`);
      const r = await xhr('POST', `/ehr/api/PatientCareRecords/${this.recordId}/lock`, JSON.stringify({ lockDateTime: '09/17/2026 10:44:47' }));
      await this.openTab('Incident'); return r.status;
    },
    async unlock() { const r = await xhr('POST', `/ehr/api/PatientCareRecords/${this.recordId}/unlock`, JSON.stringify({ unlockDateTime: '09/17/2026 10:44:19' })); await this.openTab('Incident'); return r.status; },
    async fax() { const c = JSON.parse((await xhr('GET', `/ehr/api/PatientCareRecords/${this.recordId}/Fax/CanSend`)).text); if (!c.ok) return c; const r = await xhr('POST', `/ehr/api/PatientCareRecords/${this.recordId}/Fax/Send`, JSON.stringify({ sendDateTime: '09/17/2026 10:40:14' })); return JSON.parse(r.text); },
    async attachments() { const r = await xhr('GET', `/ehr/api/PatientCareRecords/${this.recordId}/Attachments`); return JSON.parse(r.text); },
    uuid,
  };
  setInterval(() => app.flush(), app.autosaveMs);
  app.clicks = [];
  app.quickOpened = 0;
  document.getElementById('quick').addEventListener('click', () => { app.quickOpened++; });
  document.getElementById('quickincident').addEventListener('click', () => { app.quickOpened++; });
  document.getElementById('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    e.preventDefault();
    app.clicks.push(t.dataset.view);
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    app.openTab(t.dataset.view);
  });
  function renderVitals(body) {
    const list = (body && body.data && body.data.model && body.data.model.vitalSigns) || [];
    const table = document.getElementById('vitals');
    table.innerHTML = '<tr><th>Time</th><th>BP</th><th>Pulse</th><th></th></tr>' + list.map(v =>
      `<tr><td class="t">${(v.vitalSignDateTime || '').slice(-8)}</td><td>${(v.bloodPressure && v.bloodPressure.bloodPressureSystolic) || '--'}/${(v.bloodPressure && v.bloodPressure.bloodPressureDiastolic) || '--'}</td><td>${(v.pulse && v.pulse.pulseRate) || '--'}</td><td><button class="x">×</button></td></tr>`).join('');
  }
  // ---- ESO-style pickers. Names and ids are a slice of ESO's own lists.
  const HISTORY = [[12224, 'None Reported'], [1337167, '1st Degree Heart Block'], [535, 'Asthma'], [14827, 'Asthma - mild, persistent'], [10103, 'Atrial Fibrillation'],
    [541, 'Chronic Obstructive Pulmonary Disease (COPD)'], [540, 'Congestive Heart Failure (CHF)'], [545, 'Diabetes'], [11914, 'Type 1 Diabetes'], [11915, 'Type 2 Diabetes'],
    [547, 'Hypertension (HTN)'], [1337844, 'Pulmonary Hypertension, Other Secondary'], [553, 'Seizures'], [555, 'Stroke/CVA']];
  const ACUITY = { initial: [[10586, 'Critical (Red)'], [10587, 'Emergent (Yellow)'], [10588, 'Lower Acuity (Green)'], [14756, 'Non-Acute/Routine']],
    final: [[11838, 'Critical (Red)'], [11839, 'Emergent (Yellow)'], [11840, 'Lower Acuity (Green)'], [14755, 'Non-Acute/Routine']] };
  const MEDS = [[12223, 'None Reported'], [485, 'Lisinopril'], [7913, 'Metoprolol'], [7905, 'Metformin'], [1338755, 'Insulin Detemir'], [478, 'Insulin'], [7608, 'Aspirin']];
  const ALLERGIES = [[518, 'No known allergies'], [11027, 'Other drug allergy'], [528, 'Penicillin allergy'], [10243, 'Sulfa'], [1338104, 'Sulfamethoxazole'], [527, 'Latex allergy']];
  const GROUPS = { hist: { addr: 'patientMedicalHistories', items: HISTORY, list: 'histlist', btn: 'addhist', title: 'Add History' },
    allergy: { addr: 'patientAllergies', items: ALLERGIES, list: 'allergylist', btn: 'addallergy', title: 'Add Allergies' },
    med: { addr: 'patientMedications', items: MEDS, list: 'medlist', btn: 'addmed', title: 'Add Medications' } };
  app.histories = []; app.allergies = []; app.meds = []; app.acuity = { initial: null, final: null }; app.shelfOpens = 0;
  const held = { hist: 'histories', allergy: 'allergies', med: 'meds' };
  function renderHistory(body) {
    const m = body && body.data && body.data.model;
    for (const [k, g] of Object.entries(GROUPS)) {
      app[held[k]] = ((m && m[g.addr]) || []).map(h => h.itemId);
      document.getElementById(g.list).innerHTML = app[held[k]].map(id => `<li>${(g.items.find(h => h[0] === id) || [0, id])[1]}</li>`).join('');
    }
  }
  function renderAcuity(body) {
    const m = body && body.data && body.data.model;
    app.acuity.initial = m && m.patientComplaint ? m.patientComplaint.initialPatientAcuityId : null;
    app.acuity.final = m && m.patientComplaint ? m.patientComplaint.finalPatientAcuityId : null;
    document.getElementById('ia').textContent = (ACUITY.initial.find(a => a[0] === app.acuity.initial) || [0, ''])[1];
    document.getElementById('fa').textContent = (ACUITY.final.find(a => a[0] === app.acuity.final) || [0, ''])[1];
  }
  // delays: ESO's own None/No Delay button is shown while the field is empty and saves a multiselect ADD
  const DELAY_ADDR = { DISPATCHDELAYS: 'dispatchDelays', RESPONSEDELAYS: 'responseDelays', SCENEDELAYS: 'sceneDelays', TRANSPORTDELAYS: 'transportDelays', TURNAROUNDDELAYS: 'turnAroundDelays' };
  const DELAY_NAMES = { 6430: 'None/No Delay', 357: 'None/No Delay', 372: 'None/No Delay', 385: 'None/No Delay', 399: 'None/No Delay', 365: 'Crowd' };
  function renderDelays(body) {
    const m = body && body.data && body.data.model && body.data.model.additionalFactors;
    for (const f of document.querySelectorAll('#incident eso-field[data-list]')) {
      const ids = (m && m[DELAY_ADDR[f.dataset.fieldRef]]) || [];
      f.querySelector('.display-value').textContent = ids.map(id => DELAY_NAMES[id] || id).join(', ');
      f.querySelector('.none-or-pn-btn').style.display = ids.length ? 'none' : '';
    }
  }
  document.querySelectorAll('#incident .none-or-pn-btn').forEach(b => b.addEventListener('click', () => {
    const f = b.closest('eso-field'); const id = Number(f.dataset.list);
    app.addScalar('incident', `incident.additionalFactors.${DELAY_ADDR[f.dataset.fieldRef]}.['${id}']`, id);
    f.querySelector('.display-value').textContent = 'None/No Delay'; b.style.display = 'none';
  }));
  const TRANSPORT_ADDR = { mechanismOfInjuryIds: 'narrative.injuries' };
  const TRANSPORT = {
    mechanismOfInjuryIds: [[7117, 'Blunt'], [7118, 'Burn'], [7119, 'Other'], [7120, 'Penetrating']],
    howPatientWasMovedToStretcherIds: [[15110, 'Ambulated with assistance'], [15111, 'Ambulated to stretcher no assistance'], [15112, 'Lifted to stretcher'], [15113, 'Lifted to stretcher via draw-sheet'], [15114, 'Lifted to stretcher via Hoyer lift'], [15115, 'Lifted to stretcher with backboard'], [15119, 'Via stand and pivot'], [15120, 'Via stair chair']],
    patientMovedFromSceneToAmbulanceMethodIds: [[7180, 'Assisted/Walk'], [7182, 'Stairchair'], [7183, 'Stretcher'], [10552, 'Wheelchair']],
    patientMovedFromAmbulanceToDestinationMethodIds: [[7193, 'Assisted/Walk'], [7195, 'Stairchair'], [7196, 'Stretcher'], [10555, 'Wheelchair']],
    patientPositionDuringTransportIds: [[7186, 'Fowlers (Semi-Upright Sitting)'], [7189, 'Semi-Fowlers'], [7190, 'Sitting'], [7191, 'Supine'], [10558, 'Trendelenburg']],
  };
  app.transport = {};
  // like ESO: Mechanism of Injury is disabled until Possible Patient Injury? is Yes or Unknown
  const INJURED = { Yes: 7113, No: 7114, Unknown: 7115 };
  document.querySelectorAll('eso-field[data-field-ref="ISINJUREDID"] .quick-picks button').forEach(b => b.addEventListener('click', () => {
    const f = b.closest('eso-field'); const v = b.dataset.injured;
    app.edit('narrative', 'narrative.injuries.injuredId', INJURED[v], 'singleselect');
    f.querySelector('.display-value').textContent = v; f.querySelector('.quick-picks').style.display = 'none'; f.querySelector('.area-wrap').removeAttribute('style');
    document.querySelector('eso-field[data-field-ref="MECHANISMOFINJURYIDS"]').toggleAttribute('disabled', v === 'No');
  }));
  function renderTransport(body) {
    const model = body && body.data && body.data.model;
    for (const f of document.querySelectorAll('#narrative eso-field.ms')) {
      const k = f.dataset.key; const src = model && (k === 'mechanismOfInjuryIds' ? model.injuries : model.patientTransport); const ids = ((src && src[k]) || []).map(Number); app.transport[k] = ids;
      f.querySelector('.display-value').textContent = ids.map(id => (TRANSPORT[k].find(t => t[0] === id) || [0, id])[1]).join(', ');
    }
  }
  document.querySelectorAll('#narrative eso-field.ms .shelf-click-indicator').forEach(ic => ic.addEventListener('click', () => {
    const f = ic.closest('eso-field'); const k = f.dataset.key;
    openShelf({ title: f.dataset.title, items: TRANSPORT[k], multi: true, checked: app.transport[k] || [], onOk: (ids) => {
      const had = app.transport[k] || [];
      const base = TRANSPORT_ADDR[k] || 'narrative.patientTransport';
      for (const id of ids) if (!had.includes(id)) app.addScalar('narrative', `${base}.${k}.['${id}']`, id);
      for (const id of had) if (!ids.includes(id)) app.del('narrative', `${base}.${k}.['${id}']`, 'multiselect');
      app.transport[k] = ids;
      f.querySelector('.display-value').textContent = ids.map(id => (TRANSPORT[k].find(t => t[0] === id) || [0, id])[1]).join(', ');
    } });
  }));
  // ---- single-select fields the way ESO draws them: display value, click indicator, and quick-pick
  // buttons shown while the field is empty. Ids and names are ESO's.
  const SS = {
    RUNTYPEID: { label: 'Run Type', addr: 'incident.response.runTypeId', list: [[325, 'Emergency Interfacility Transfer'], [329, 'Standby'], [324, 'Emergency Response (Intercept)'], [328, 'Emergency Response (Mutual Aid)'], [323, 'Emergency Response (Primary Response Area)'], [14628, 'Hospital to Non-Hospital Facility Transfer'], [14627, 'Hospital-to-Hospital Transfer'], [14630, 'Non-Hospital Facility to Hospital Transfer']], quick: { 323: '911 Response', 325: 'Emergency IFT', 324: 'Emergency Response (Intercept)' } },
    MUTUALAIDID: { label: 'Mutual Aid', addr: 'incident.response.mutualAidID', list: [[12635, 'Mutual Aid Given'], [12637, 'Mutual Aid Received'], [1338313, 'No Unit Available'], [334, 'Rendezvous for level of care'], [335, 'Rendezvous for patient pickup']], quick: { 334: 'Rv for level of care', 335: 'Rv for patient pickup' } },
    EMDCOMPLAINTID: { label: 'EMD Complaint', addr: 'incident.response.emdComplaintId', list: [[6834, 'Abdominal Pain/Problems'], [12706, 'Altered Mental Status'], [6839, 'Breathing Problem'], [6843, 'Chest Pain (Non-Traumatic)'], [6845, 'Convulsions/Seizure'], [6850, 'Falls'], [6859, 'Sick Person'], [6862, 'Traffic Accident']], quick: { 6839: 'Breathing Problem', 6859: 'Sick Person', 6862: 'Traffic Accident' } },
    REQUESTEDBYITEMID: { label: 'Requested By', addr: 'incident.response.requestedByItemID', list: [[433, 'Patient'], [434, 'Family'], [435, 'Bystander'], [436, 'Physician'], [438, 'Law Enforcement'], [9356, 'Fire Department'], [12696, 'Other Healthcare Provider'], [439, 'Other']], quick: { 433: 'Patient', 434: 'Family', 435: 'Bystander' } },
    PRIORITYID: { label: 'Response Mode to Scene', addr: 'incident.response.priorityId', list: [[338, 'Emergent'], [339, 'Non-Emergent'], [336, 'Emergent Downgraded to Non-Emergent'], [337, 'Non-Emergent Upgraded to Emergent']], quick: { 338: 'Emergent', 336: 'Emergent Downgraded to Non-Emergent', 339: 'Non-Emergent' } },
    RESPONSEMODELIGHTSANDSIRENSUSE: { label: 'Response Mode Lights & Sirens Use', addr: 'incident.response.responseModeLightsAndSirensUseId', list: [[14797, 'Lights and Sirens'], [14798, 'Lights and No Sirens'], [14799, 'No Lights or Sirens']], quick: { 14797: 'Lights & Sirens', 14799: 'No Lights or Sirens', 14798: 'Lights and No Sirens' } },
    RESPONSEMODEINTERSECTIONNAVIGATION: { label: 'Response Mode Intersection Navigation', addr: 'incident.response.responseModeIntersectionNavigationId', list: [[14803, 'Against Normal Light Patterns'], [14804, 'With Automated Light Changing Technology'], [14805, 'With Normal Light Patterns']], quick: { 14805: 'With Normal Light Pattern', 14803: 'Against Normal Light Pattern', 14804: 'With Light Change Tech' } },
    RESPONSEMODESCHEDULED: { label: 'Response Mode Scheduled', addr: 'incident.response.responseModeScheduledId', list: [[14807, 'No (Unscheduled)'], [14808, 'Yes (Scheduled)']], quick: { 14807: 'No', 14808: 'Yes' } },
    RESPONSEMODESPEED: { label: 'Response Mode Speed', addr: 'incident.response.responseModeSpeedId', list: [[14810, 'Speed-Enhanced per Local Policy'], [14811, 'Speed-Normal Traffic']], quick: { 14811: 'Normal Traffic', 14810: 'Enhanced per Policy' } },
    EMDPERFORMEDID: { label: 'EMD Performed', addr: 'incident.response.emdPerformedID', list: [[6868, 'No'], [6869, 'Yes, With Pre-Arrival Instructions'], [6870, 'Yes, Without Pre-Arrival Instructions'], [10307, 'Yes, Unknown if Pre-Arrival Instructions Given']], quick: { 6869: 'Yes, w/ Instructions', 6870: 'Yes, w/o Instructions', 10307: 'Yes, Unknown', 6868: 'No' } },
    UNITID: { label: 'Unit', addr: 'incident.response.unitId', list: [[3001, '23'], [3002, '16'], [3003, 'NT02']] },
    UNITCAPABILITYID: { label: 'Unit Capability', addr: 'incident.response.unitCapabilityID', list: [[14135, 'Ground Transport (ALS Equipped)'], [14136, 'Ground Transport (BLS Equipped)'], [14138, 'Non-Transport-Medical Treatment (ALS Equipped)'], [14139, 'Non-Transport-Medical Treatment (BLS Equipped)']] },
    UNITSLEVELOFCAREID: { label: "Unit's Level Of Care", addr: 'incident.response.unitsLevelOfCareID', list: [[9686, 'ALS-Paramedic'], [9681, 'BLS-Basic /EMT']] },
    UNITDISPOSITIONITEMID: { label: 'Unit Disposition', addr: 'incident.disposition.unitDispositionItemID', list: [[14402, 'Patient Contact Made'], [14403, 'Canceled on Scene'], [14404, 'Canceled Prior to Arrival at Scene'], [14405, 'No Patient Contact'], [14406, 'No Patient Found']] },
    PATIENTEVALUATIONCAREDISPOSITIONITEMID: { label: 'Patient Evaluation and/or Care Disposition', addr: 'incident.disposition.patientEvaluationCareDispositionItemID', list: [[14410, 'Patient Evaluated and Care Provided'], [14411, 'Patient Evaluated and Refused Care'], [14412, 'Patient Evaluated, No Care Required'], [14413, 'Patient Refused Evaluation and Care']] },
    CREWDISPOSITIONITEMID: { label: 'Crew Disposition', addr: 'incident.disposition.crewDispositionItemID', list: [[14415, 'Initiated and Continued Primary Care'], [14417, 'Provided Care Supporting Primary EMS Crew'], [14420, 'Back in Service, No Care or Support Services Required'], [14421, 'Back in Service, Care or Support Services Refused']] },
    TRANSPORTDISPOSITIONITEMID: { label: 'Transport Disposition', addr: 'incident.disposition.transportDispositionItemID', list: [[14435, 'Transport by This EMS Unit (This Crew Only)'], [14436, 'Transport by This EMS Unit, with a Member of Another Crew'], [14439, 'Patient Refused Transport'], [14441, 'No Transport']] },
    REFUSALRELEASEITEMIDS: { label: 'Reason for Refusal or Release', addr: 'incident.disposition.refusalReleaseItemIDs', multi: true, list: [[14443, 'Against Medical Advice'], [14444, 'Patient/Guardian Indicates Ambulance Transport is Not Necessary'], [14445, 'Released Following Protocol Guidelines']] },
    TRANSPORTDUETOITEMIDS: { label: 'Transport Due To', addr: 'incident.disposition.transportDueToItemIDs', multi: true, list: [[429, 'Closest Facility'], [431, 'Diversion'], [426, 'Family Choice'], [9365, 'Insurance'], [9366, 'Law Enforcement'], [9367, 'On-Line/On-Scene Medical Direction'], [432, 'Other'], [425, "Patient's Choice"], [430, "Patient's Physician's Choice"], [427, 'Protocol'], [9368, 'Regional Specialty Center']] },
    TRANSPORTMODEID: { label: 'Transport Mode', addr: 'incident.disposition.transportModeID', list: [[11850, 'Emergent (Immediate Response)'], [11851, 'Emergent Downgraded to Non-Emergent'], [11852, 'Non-Emergent'], [11853, 'Non-Emergent Upgraded to Emergent']] },
    TRANSPORTMODELIGHTSANDSIRENSUSE: { label: 'Transport Mode Lights & Sirens Use', addr: 'incident.disposition.transportModeLightsAndSirensUseId', list: [[14813, 'Lights and Sirens'], [14814, 'Lights and No Sirens'], [14815, 'No Lights or Sirens']], quick: { 14813: 'Lights & Sirens', 14815: 'No Lights or Sirens', 14814: 'Lights and No Sirens' } },
    TRANSPORTMETHODID: { label: 'Transport Method', addr: 'incident.disposition.transportMethodID', list: [[10353, 'Ground-Ambulance'], [10352, 'Air Medical-Rotor Craft'], [10355, 'Ground-Bariatric']], quick: { 10353: 'Ambulance', 10352: 'Rotor Craft', 10355: 'Bariatric' } },
    LEVELOFSERVICEID: { label: 'Level Of Service', addr: 'incident.disposition.levelOfServiceId', list: [[8196, 'Advanced Life Support'], [8197, 'Basic Life Support'], [8198, 'Critical Care']], quick: { 8197: 'BLS', 8196: 'ALS', 8198: 'Critical Care' } },
    // Narrative tab
    PRIMARYIMPRESSIONID: { scope: 'narrative', host: 'narrative-ss', label: 'Primary Impression', addr: 'narrative.clinicalImpression.primaryImpressionId', list: [[575, 'Abdominal Pain'], [595, 'Acute Respiratory Distress (Dyspnea)'], [578, 'Altered Mental Status'], [582, 'Chest Pain / Discomfort'], [12640, 'Chest pain on breathing'], [585, 'Generalized Weakness'], [602, 'Injury'], [10733, 'Injury of Head'], [604, 'No Complaints or Injury/Illness Noted'], [10698, 'Seizures with status epilepticus'], [10699, 'Seizures without status epilepticus'], [600, 'Stroke'], [601, 'Syncope / Fainting']] },
    SECONDARYIMPRESSIONID: { scope: 'narrative', host: 'narrative-ss', label: 'Secondary Impression', addr: 'narrative.clinicalImpression.secondaryImpressionId', list: [[610, 'Abdominal Pain'], [630, 'Acute Respiratory Distress (Dyspnea)'], [613, 'Altered Mental Status'], [617, 'Chest Pain / Discomfort'], [620, 'Generalized Weakness'], [637, 'Injury'], [1338786, 'Near Syncope'], [639, 'Syncope / Fainting']] },
    PROVIDEDCARELEVELID: { scope: 'narrative', host: 'narrative-ss', label: 'Local Protocol Provided Care Level', addr: 'narrative.clinicalImpression.providedCareLevelId', list: [[14195, 'ALS - AEMT/Intermediate'], [14196, 'ALS - Paramedic'], [14194, 'BLS - All Levels'], [14200, 'No Care Provided']] },
    CHIEFTIMEUNITSOFCOMPLAINTDURATION: { scope: 'narrative', host: 'narrative-ss', label: 'Unit', addr: 'narrative.patientComplaint.chiefTimeUnitsOfComplaintDuration', list: [[7080, 'Seconds'], [7081, 'Minutes'], [7082, 'Hours'], [7083, 'Days'], [7084, 'Weeks'], [7085, 'Months'], [7086, 'Years']] },
    CHIEFCOMPLAINTORGANSYSTEMID: { scope: 'narrative', host: 'narrative-ss', label: 'Chief Complaint System', addr: 'narrative.clinicalImpression.chiefComplaintOrganSystemId', list: [[7110, 'Behavioral/Psychiatric'], [7103, 'Cardiovascular'], [7104, 'CNS/Neuro '], [7105, 'Endocrine/Metabolic'], [7106, 'GI '], [7107, 'Global/General'], [10559, 'Lymphatic/Immune'], [7108, 'Musculoskeletal/Skin'], [7109, 'Reproductive'], [7111, 'Pulmonary'], [7112, 'Renal ']], quick: { 7107: 'Global/General', 7108: 'Musculoskeletal/Skin', 7103: 'Cardiovascular' } },
    CHIEFCOMPLAINTANATOMICLOCATIONID: { scope: 'narrative', host: 'narrative-ss', label: 'Anatomic Location', addr: 'narrative.patientComplaint.chiefComplaintAnatomicLocationId', list: [[7094, 'Abdomen'], [7095, 'Back'], [7096, 'Chest'], [7097, 'Extremity-Lower'], [7098, 'Extremity-Upper'], [7099, 'General/Global'], [7100, 'Genitalia'], [7101, 'Head'], [7102, 'Neck']] },
    // Patient tab
    PATIENTRACEIDS: { scope: 'patient', host: 'patient-ss', label: 'Race', addr: 'patient.demographics.raceIds', multi: true, list: [[315, 'American Indian or Alaska Native'], [316, 'Asian'], [317, 'Black or African American'], [10317, 'Hispanic or Latino'], [1338789, 'Middle Eastern or North African'], [318, 'Native Hawaiian or Other Pacific Islander'], [319, 'White']], quick: { 319: 'White', 317: 'Black' } },
  };
  app.ss = {}; // ref -> value id(s)
  app.ssSetForTest = (ref, id) => ssSet(ref, id);
  function ssHtml(ref) {
    const d = SS[ref];
    const qp = d.quick ? `<div class="quick-picks">${Object.entries(d.quick).map(([id, l]) => `<button class="btn" data-id="${id}">${l}</button>`).join('')}<button class="btn other standard-select-icon">Other &#9776;</button></div>` : '';
    return `<eso-field class="field" data-field-ref="${ref}"><div class="label-container"><label>${d.label}</label></div><eso-control><div class="area-wrap"><div class="line field-area"><div class="display-value"></div><div class="shelf-click-indicator">&#9776;</div></div></div>${qp}</eso-control></eso-field>`;
  }
  const nameOf = (ref, id) => (SS[ref].list.find(x => x[0] === Number(id)) || [0, ''])[1];
  function ssRender(ref) {
    const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); if (!f) return;
    const v = app.ss[ref];
    const names = Array.isArray(v) ? v.map(id => nameOf(ref, id)).join(', ') : (v ? nameOf(ref, v) : '');
    f.querySelector('.display-value').textContent = names;
    const qp = f.querySelector('.quick-picks'); if (qp) qp.style.display = names ? 'none' : '';
    // like ESO: while the quick-picks show, the value line and its list icon are folded away
    if (qp) f.querySelector('.area-wrap').setAttribute('style', names ? '' : 'overflow:hidden;width:0;visibility:hidden;position:absolute');
    // like ESO: patient/transport dispositions only apply once contact was made; transport mode only when transporting
    if (ref === 'UNITDISPOSITIONITEMID') for (const dep of ['PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'TRANSPORTDISPOSITIONITEMID']) document.querySelector(`eso-field[data-field-ref="${dep}"]`).toggleAttribute('disabled', v !== 14402);
    if (ref === 'RUNTYPEID') { // ESO only shows Mutual Aid for that run type: folded away in a hidden wrapper, disabled
      const mf = document.querySelector('eso-field[data-field-ref="MUTUALAIDID"]'); const wrap = mf.parentElement;
      wrap.setAttribute('style', v === 328 ? 'margin:0;padding:0' : 'margin:0;padding:0;overflow:hidden;height:0px;visibility:hidden;position:absolute');
      wrap.classList.toggle('eso-hide', v !== 328); mf.toggleAttribute('disabled', v !== 328);
    }
    if (ref === 'TRANSPORTDISPOSITIONITEMID') for (const dep of ['TRANSPORTMODEID', 'TRANSPORTMODELIGHTSANDSIRENSUSE', 'TRANSPORTMETHODID']) document.querySelector(`eso-field[data-field-ref="${dep}"]`).toggleAttribute('disabled', !(v === 14435 || v === 14436));
  }
  function ssSet(ref, id) {
    const d = SS[ref];
    if (d.multi) { if ((app.ss[ref] || []).includes(id)) return; app.ss[ref] = (app.ss[ref] || []).concat([id]); app.addScalar(d.scope || 'incident', `${d.addr}.['${id}']`, id); }
    else { app.ss[ref] = id; app.edit(d.scope || 'incident', d.addr, id, 'singleselect'); }
    ssRender(ref);
  }
  document.getElementById('response').innerHTML = ['UNITID', 'UNITCAPABILITYID', 'UNITSLEVELOFCAREID', 'RUNTYPEID', '__MUTUAL__', 'PRIORITYID', 'RESPONSEMODELIGHTSANDSIRENSUSE', 'RESPONSEMODEINTERSECTIONNAVIGATION', 'RESPONSEMODESCHEDULED', 'RESPONSEMODESPEED', 'EMDCOMPLAINTID', 'EMDPERFORMEDID', 'REQUESTEDBYITEMID'].map(r => r === '__MUTUAL__' ? `<div eso-show-hide-slide="" class="eso-hide" style="margin:0;padding:0;overflow:hidden;height:0px;visibility:hidden;position:absolute">${ssHtml('MUTUALAIDID')}</div>` : ssHtml(r)).join('');
  document.getElementById('disposition').innerHTML = ['UNITDISPOSITIONITEMID', 'PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'CREWDISPOSITIONITEMID', 'TRANSPORTDISPOSITIONITEMID', 'REFUSALRELEASEITEMIDS', 'TRANSPORTMODEID', 'TRANSPORTMODELIGHTSANDSIRENSUSE', 'TRANSPORTMETHODID', 'TRANSPORTDUETOITEMIDS', 'LEVELOFSERVICEID'].map(ssHtml).join('');
  // ---- numeric fields, as ESO draws them: display value with a suffix, numpad indicator, and a
  // number shelf (masked input + numpad + OK) when tapped
  const NUM = {
    CHIEFCOMPLAINTDURATION: { scope: 'narrative', host: 'narrative-ss', label: 'Duration of Chief Complaint', addr: 'narrative.patientComplaint.chiefComplaintDuration', type: 'integer', suffix: '' },
    PATIENTWEIGHT: { scope: 'patient', host: 'patient-ss', label: 'Weight', addr: 'patient.demographics.weight', type: 'number', suffix: 'lbs' },
    HEIGHTFTCOMPONENT: { scope: 'patient', host: 'patient-ss', label: 'Height', addr: 'patient.demographics.heightFtComponent', type: 'integer', suffix: 'ft', max: 1 },
    HEIGHTINCOMPONENT: { scope: 'patient', host: 'patient-ss', label: 'Height', addr: 'patient.demographics.heightInComponent', type: 'number', suffix: 'in' },
  };
  app.num = {};
  const numHtml = (ref) => `<eso-field class="field" data-field-ref="${ref}"><div class="label-container"><label>${NUM[ref].label}</label></div><div class="line field-area"><div class="display-value placeholder"></div><div class="shelf-click-indicator numpad-icon">#</div></div></eso-field>`;
  function numRender(ref) {
    const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); if (!f) return;
    const v = app.num[ref]; const dv = f.querySelector('.display-value');
    dv.textContent = v == null || v === '' ? '' : `${v}${NUM[ref].suffix ? ' ' + NUM[ref].suffix : ''}`; dv.classList.toggle('placeholder', v == null || v === '');
  }
  function renderNum(body, scope) {
    const m = body && body.data && body.data.model; if (!m) return;
    for (const [ref, d] of Object.entries(NUM)) { if (d.scope !== scope) continue; const v = d.addr.split('.').slice(1).reduce((o, k) => o && o[k], m); app.num[ref] = v == null ? null : v; numRender(ref); }
  }
  function openNumShelf({ title, value, max, onOk }) {
    app.shelfOpens++;
    const el = document.createElement('shelf-panel');
    el.innerHTML = `<header><h1>${title}</h1><button class="btn green-btn workflow-btn">OK</button></header><main class="viewport"><div class="content">
      <div class="banded"><eso-display-field class="no-label"><eso-masked-input><input value="${value == null ? '' : value}" placeholder="enter a number"></eso-masked-input></eso-display-field></div>
      <eso-numpad><numpad>${['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', 'back'].map(c => `<button class="btn numpad-btn" data-char="${c}">${c === 'back' ? '<div class="back"></div>' : c}</button>`).join('')}<div class="clear"><a data-char="clear">Clear</a></div></numpad></eso-numpad></div></main>`;
    const input = el.querySelector('input');
    // like ESO: the numpad keys act on mousedown/touchstart and feed the input
    el.querySelectorAll('[data-char]').forEach(b => b.addEventListener('mousedown', (e) => { e.preventDefault(); const c = b.dataset.char; input.value = c === 'clear' ? '' : c === 'back' ? input.value.slice(0, -1) : input.value + c; input.dispatchEvent(new Event('change', { bubbles: true })); }));
    el.querySelector('header button').addEventListener('click', () => {
      const v = input.value.trim();
      if (v && !new RegExp(`^\\d{0,${max || 3}}(\\.\\d)?$`).test(v)) { el.classList.add('invalid'); return; } // ESO keeps the shelf open on an invalid number
      onOk(v === '' ? null : Number(v)); el.remove();
    });
    shelfHost.appendChild(el);
  }
  for (const [ref, d] of Object.entries(NUM)) {
    document.getElementById(d.host).insertAdjacentHTML('beforeend', numHtml(ref));
    const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`);
    f.querySelector('.shelf-click-indicator').addEventListener('click', () => openNumShelf({ title: d.label + (d.suffix ? ` (${d.suffix})` : ''), value: app.num[ref], max: d.max, onOk: (v) => { app.num[ref] = v; app.edit(d.scope, d.addr, v, d.type); numRender(ref); } }));
  }
  // ---- the Patient Refusal Form (Signatures tab): a modal of ESO's own, not a picker; each
  // multi-select inside opens a picker on top. Ids are the agency's GUIDs or ESO's.
  const RF = {
    STANDARDREFUSALLEGALIDS: { label: 'Legal', addr: 'signatures.standardSignatures.standardRefusal.capacityAssessment.legalIds', list: [['e8baca53-0bd8-4041-9761-392b38716aed', '18 years of age or older'], ['0d212922-7ebc-4444-82f8-4cf0332ee498', 'Under 18 years of age'], ['76ad7f8b-9e96-49e2-b8fb-def651b6a709', 'Minor - married'], ['f1271937-0b4c-446e-a5c7-62ec5441dc28', 'Minor - pregnant'], ['ee20b271-ca90-41db-a8f0-f67148f124dd', 'Minor - emancipated'], ['b7121c7f-3203-4a0e-9311-6b5945d2f7c3', 'Parent/Legal guardian present'], ['7858469c-2cc1-4a1f-b218-d765889f74a1', 'Unable to determine']] },
    STANDARDREFUSALDECISIONMAKINGIDS: { label: 'Decision-Making', addr: 'signatures.standardSignatures.standardRefusal.capacityAssessment.decisionMakingIds', list: [['afd73a13-f1d9-4115-9df1-24af3eb74578', 'Presents a significant life threat to self or others'], ['6cafdf25-3c18-47a0-a977-dfb580cecf0a', 'Unable to understand information in order to communicate a choice'], ['24225284-0292-4f52-8645-91edc0f58ba2', 'Disoriented to person/place/time/event'], ['fedb6b92-b47f-4d1b-bb6d-ec51264038c5', 'Possible ETOH/drug use'], ['339389e9-0fd3-46e6-b188-17a19e1d7ce3', 'Unable to determine'], ['0ebe23fe-29a7-43a3-881e-33995648ffd6', 'Cleared capacity assessment']] },
    STANDARDREFUSALMEDICALIDS: { label: 'Medical', addr: 'signatures.standardSignatures.standardRefusal.capacityAssessment.medicalIds', list: [['e0518ddf-2722-43b4-b51e-444d09680bb9', 'Abnormal glucose'], ['0bdb29e0-de10-4b23-b373-c21090d86ade', 'Altered level of consciousness (ALOC)'], ['326c3754-6634-4e96-8db5-52f979b88c4e', 'Unable to determine'], ['7f59c7f9-779a-45ce-9eb5-0d95d8b70fb0', 'Cleared capacity assessment']] },
    STANDARDREFUSALPATIENTNOTIFICATIONIDS: { label: 'Patient / Parent / Legal Guardian Notifications', addr: 'signatures.standardSignatures.standardRefusal.patientNotifications.patientNotificationIds', list: [['70736d53-e0ce-4f4e-bffc-232ec55acb51', 'Medical treatment/evaluation recommendation(s)'], ['29cfa6f3-46ce-451b-9e6e-2caf6cdd6e25', 'Further harm could result without medical treatment or evaluation'], ['5844b0ae-ee6b-4ef4-b187-935fde6945c6', 'Transport by means other than ambulance could be hazardous in light of present illness/injury'], ['51237c84-63a5-4171-8d6a-928ec9a3d65a', 'EMS preference to provide transport to the closest appropriate medical facility']] },
    STANDARDREFUSALPATIENTREFUSALIDS: { label: 'Patient Refusals', addr: 'signatures.standardSignatures.standardRefusal.patientRefusals.patientRefusalIds', list: [[12817, 'Assessment'], [12818, 'Treatment'], [12819, 'Transport by EMS'], [12820, 'Recommended Destination']] },
  };
  app.rf = {};
  app.refusalOpens = 0;
  document.getElementById('openrefusal').addEventListener('click', () => {
    app.refusalOpens++;
    const el = document.createElement('standard-refusal'); el.className = 'signature-panel';
    el.innerHTML = `<jump-link-shelf-panel><header><h1>Patient Refusal Form</h1><button class="btn workflow-btn green-btn">OK</button></header><main><div class="content">${Object.entries(RF).map(([ref, d]) =>
      `<eso-field class="field" data-field-ref="${ref}"><div class="label-container"><label>${d.label}</label></div><div class="line field-area"><div class="display-value"></div><div class="shelf-click-indicator multi-select-icon">&#9776;</div></div></eso-field>`).join('')}</div></main></jump-link-shelf-panel>`;
    const show = (ref) => { const f = el.querySelector(`eso-field[data-field-ref="${ref}"]`); f.querySelector('.display-value').textContent = (app.rf[ref] || []).map(id => (RF[ref].list.find(x => x[0] === id) || [0, id])[1]).join(', '); };
    for (const [ref, d] of Object.entries(RF)) {
      show(ref);
      el.querySelector(`eso-field[data-field-ref="${ref}"] .shelf-click-indicator`).addEventListener('click', () => {
        openShelf({ title: d.label, items: d.list, multi: true, checked: app.rf[ref] || [], onOk: (ids) => {
          const had = app.rf[ref] || [];
          for (const id of ids) if (!had.includes(id)) app.addScalar('signatures', `${d.addr}.['${id}']`, id);
          for (const id of had) if (!ids.includes(id)) app.del('signatures', `${d.addr}.['${id}']`, 'multiselect');
          app.rf[ref] = ids; show(ref);
        } });
      });
    }
    el.querySelector('header button').addEventListener('click', () => el.remove());
    shelfHost.appendChild(el);
  });
  for (const [ref, d] of Object.entries(SS)) if (d.host) document.getElementById(d.host).insertAdjacentHTML('beforeend', ssHtml(ref));
  for (const ref of Object.keys(SS)) {
    const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); if (!f) continue;
    f.querySelectorAll('.quick-picks button[data-id]').forEach(b => b.addEventListener('click', () => { if (f.hasAttribute('disabled')) return; ssSet(ref, Number(b.dataset.id)); }));
    const otherBtn = f.querySelector('.quick-picks button.other'); if (otherBtn) otherBtn.addEventListener('click', () => f.querySelector('.shelf-click-indicator').click());
    f.querySelector('.shelf-click-indicator').addEventListener('click', () => {
      if (f.hasAttribute('disabled')) return;
      const d = SS[ref];
      openShelf({ title: d.label, items: d.list, multi: !!d.multi, checked: d.multi ? (app.ss[ref] || []) : [], onPick: (id) => ssSet(ref, id), onOk: (ids) => {
        for (const id of ids) if (!(app.ss[ref] || []).includes(id)) ssSet(ref, id);
        for (const id of (app.ss[ref] || []).slice()) if (!ids.includes(id)) { app.ss[ref] = app.ss[ref].filter(x => x !== id); app.del(d.scope || 'incident', `${d.addr}.['${id}']`, 'multiselect'); ssRender(ref); }
      } });
    });
    ssRender(ref);
  }
  function renderSS(body, scope = 'incident') {
    const m = body && body.data && body.data.model; if (!m) return;
    for (const [ref, d] of Object.entries(SS)) {
      if ((d.scope || 'incident') !== scope) continue;
      const v = d.addr.split('.').slice(1).reduce((o, k) => o && o[k], m);
      app.ss[ref] = Array.isArray(v) ? v.map(Number) : (v == null ? null : Number(v));
      ssRender(ref);
    }
  }
  // locations: type + name pickers in Predefined mode; the bundle is what the extension learns facilities from
  let bundle = null;
  async function loadBundle() { if (bundle) return bundle; const r = await xhr('GET', '/ehr/api/configurationBundle/agency/5.3.19.1/root'); bundle = JSON.parse(r.text); return bundle; }
  app.locations = { scene: { type: null, name: null }, destination: { type: null, name: null } };
  document.querySelectorAll('eso-location').forEach(loc => {
    const scope = loc.dataset.scope;
    loc.querySelectorAll('.button-group button').forEach(b => b.addEventListener('click', () => {
      loc.querySelectorAll('.button-group button').forEach(x => x.classList.toggle('selected', x === b));
      loc.dataset.mode = b.dataset.mode;
      loc.querySelector('.predef').style.display = b.dataset.mode === 'predefined' ? '' : 'none';
      loc.querySelector('.manual').style.display = b.dataset.mode === 'manual' ? '' : 'none';
    }));
    const typeField = loc.querySelector('[data-kind=type]'), nameField = loc.querySelector('[data-kind=name]');
    typeField.querySelector('.shelf-click-indicator').addEventListener('click', async () => {
      const b = await loadBundle();
      const list = scope === 'scene' ? b.lists['SL.LOCATIONTYPE'].values : b.lists['SL.DESTINATIONTYPE'].values;
      openShelf({ title: typeField.querySelector('label').textContent, items: list.map(i => [i.itemId, i.itemName]), multi: false, checked: [], onPick: (id) => {
        const it = list.find(i => i.itemId === id); app.locations[scope].type = it;
        app.edit('incident', `incident.${scope}.predefinedAddress.locationTypeID`, id, 'singleselect');
        typeField.querySelector('.display-value').textContent = it.itemName; nameField.removeAttribute('disabled');
        app.locations[scope].name = null; nameField.querySelector('.display-value').textContent = '';
      } });
    });
    nameField.querySelector('.shelf-click-indicator').addEventListener('click', async () => {
      if (nameField.hasAttribute('disabled')) return;
      const b = await loadBundle(); const t = app.locations[scope].type;
      const locTypeId = scope === 'scene' ? t.itemId : t.parentItemId;
      const list = b.lists['UDL.LOCATIONS'].values.filter(l => l.locationTypeId === locTypeId); // filterLocations: only this type
      openShelf({ title: nameField.querySelector('label').textContent, items: list.map(i => [i.itemId, i.itemName]), multi: false, checked: [], onPick: (id) => {
        const it = list.find(i => i.itemId === id); app.locations[scope].name = it;
        app.edit('incident', `incident.${scope}.predefinedAddress.predefinedLocationID`, id, 'singleselect');
        nameField.querySelector('.display-value').textContent = it.itemName;
      } });
    });
  });
  // ---- crew, the way ESO draws it in multi-role mode: tap a member to edit (a shelf with the
  // Roles multi-select, whose picker is a shelf on top); OK saves the role adds/deletes
  const CREWROLE = [[14107, 'Lead - At Scene'], [14108, 'Lead - Transport'], [14102, 'Driver - Response'], [14103, 'Driver - Transport'], [14105, 'Other Caregiver - At Scene'], [14106, 'Other Caregiver - Transport'], [14104, 'Other']];
  app.crew = [];
  const roleNames = (ids) => ids.map(id => (CREWROLE.find(r => r[0] === id) || [0, id])[1]).join(', ');
  function renderCrew(body) {
    const m = body && body.data && body.data.model;
    app.crew = ((m && m.crew) || []).map(c => ({ itemId: c.itemId, personnelId: c.personnelId, name: `${c.lastName || 'TEST'}, ${c.firstName || 'MEDIC'}`, roleIds: (c.roleIds || []).map(Number) }));
    const el = document.getElementById('crew');
    el.innerHTML = app.crew.map((c, i) => `<grid-row class="noselect" data-i="${i}"><grid-cell class="clickable"><div class="crew-info"><strong><div class="name">${c.name}</div></strong><aside>Roles: ${roleNames(c.roleIds)}</aside><aside>EMT-P</aside></div></grid-cell></grid-row>`).join('');
    el.querySelectorAll('grid-cell.clickable').forEach(cell => cell.addEventListener('click', () => {
      const c = app.crew[Number(cell.closest('grid-row').dataset.i)];
      app.shelfOpens++;
      const sh = document.createElement('shelf-panel');
      sh.innerHTML = `<header><h1>${c.name}</h1><button class="btn green-btn workflow-btn">OK</button></header><main class="viewport"><div class="content"><field-set>
        <eso-field class="field" data-field-ref="PERSONNELROLEIDS"><div class="label-container"><label>Roles</label></div><eso-control><div class="field-area"><div class="display-value">${roleNames(c.roleIds)}</div><div class="shelf-click-indicator multi-select-icon">&#9776;</div></div></eso-control></eso-field></field-set></div></main>`;
      let ids = c.roleIds.slice();
      sh.querySelector('.shelf-click-indicator').addEventListener('click', () => openShelf({ title: 'Roles', items: CREWROLE, multi: true, checked: ids, onOk: (picked) => { ids = picked; sh.querySelector('.display-value').textContent = roleNames(ids); } }));
      sh.querySelector('header button').addEventListener('click', () => {
        for (const id of ids) if (!c.roleIds.includes(id)) app.addScalar('incident', `incident.crew.['${c.itemId}'].roleIds.['${id}']`, id);
        for (const id of c.roleIds) if (!ids.includes(id)) app.del('incident', `incident.crew.['${c.itemId}'].roleIds.['${id}']`, 'multiselect');
        c.roleIds = ids; cell.querySelector('aside').textContent = 'Roles: ' + roleNames(ids); sh.remove();
      });
      shelfHost.appendChild(sh);
    }));
  }
  // ---- the CAD import dialog, as ESO's modal service draws it: eso-modal holding an eso-modal-dialog,
  // a row per CAD record (tap selects), Import once one is selected, then a success alert whose
  // button refreshes the tab
  app.cads = [{ cadId: 1, dt: '09/18/2026 @16:21:00', incidentNumber: '260918-024', unit: '23' }, { cadId: 2, dt: '09/18/2026 @12:54:00', incidentNumber: '260918-017', unit: '16' }, { cadId: 3, dt: '09/18/2026 @10:07:00', incidentNumber: '260918-031', unit: 'NT02' }, { cadId: 4, dt: '09/17/2026 @11:53:00', incidentNumber: '260917-099', unit: '23' }];
  app.cadImports = 0;
  document.getElementById('cadimport').addEventListener('click', () => {
    const m = document.createElement('eso-modal'); m.setAttribute('modal-type', 'modal');
    m.innerHTML = `<eso-modal-dialog class="modal-grid"><h1>CAD Import - Select an incident</h1><div class="content-container">
      <grid-row class="grid-header"><grid-cell>Date & Time</grid-cell><grid-cell>Incident Number</grid-cell><grid-cell>Scene Location</grid-cell><grid-cell>Unit</grid-cell><grid-cell>Patient Name</grid-cell></grid-row>
      ${app.cads.map(c => `<grid-row data-cad="${c.cadId}"><grid-cell><strong>${c.dt}</strong></grid-cell><grid-cell><strong>${c.incidentNumber}</strong></grid-cell><grid-cell><strong></strong></grid-cell><grid-cell><strong>${c.unit}</strong></grid-cell><grid-cell><strong>- -</strong></grid-cell></grid-row>`).join('')}
      </div><div class="button-set"><button class="btn cancel">Cancel</button><button class="btn green-btn import" style="display:none">Import</button></div></eso-modal-dialog>`;
    let sel = null;
    m.querySelectorAll('grid-row[data-cad]').forEach(r => r.addEventListener('click', () => { m.querySelectorAll('grid-row').forEach(x => x.classList.remove('selected')); r.classList.add('selected'); sel = app.cads.find(c => String(c.cadId) === r.dataset.cad); m.querySelector('.import').style.display = ''; }));
    m.querySelector('.cancel').addEventListener('click', () => m.remove());
    m.querySelector('.import').addEventListener('click', () => {
      if (!sel) return;
      app.cadImports++;
      const unitId = (SS.UNITID.list.find(u => u[1] === sel.unit) || [null])[0]; if (unitId) ssSet('UNITID', unitId);
      app.edit('incident', 'incident.response.incidentNumber', sel.incidentNumber);
      m.remove();
      const ok = document.createElement('eso-modal'); ok.setAttribute('modal-type', 'modal');
      ok.innerHTML = '<eso-modal-dialog><h1>CAD Import Success!</h1><div>Successfully imported CAD data.</div><div class="button-set"><button class="btn green-btn">Refresh with new data</button></div></eso-modal-dialog>';
      ok.querySelector('button').addEventListener('click', async () => { ok.remove(); await app.flush(); app.openTab('Incident'); }); // like ESO: the import is saved before the refresh
      document.body.appendChild(ok);
    });
    document.body.appendChild(m);
  });
  // ---- the Attachments dialog, as ESO draws it: a row per attachment (file name, description
  // underneath), Close / Camera / Add Attachment. Camera takes a photo at once and uploads it with
  // an empty description; Add Attachment opens ESO's second dialog (file, Description, Attach).
  app.cameraClicks = 0; app.attachClicks = 0; app.uploads = 0;
  function photoBlob() {
    return new Promise((res) => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const g = c.getContext('2d'); g.fillStyle = '#ccc'; g.fillRect(0, 0, 40, 30); c.toBlob(res, 'image/jpeg', 0.8); });
  }
  function upload(file, name, description) {
    return new Promise((resolve) => {
      const fd = new FormData(); fd.append('description', description || ''); fd.append('file', file, name);
      const x = new XMLHttpRequest();
      x.open('POST', `/ehr/api/PatientCareRecords/${app.recordId}/Attachments`, true);
      x.setRequestHeader('accept', 'application/json, text/plain, */*');
      x.setRequestHeader('x-custom-xsrf-token', XSRF);
      x.onloadend = () => { app.uploads++; resolve({ status: x.status, text: x.responseText }); };
      x.send(fd);
    });
  }
  document.getElementById('attachments').addEventListener('click', async () => {
    const m = document.createElement('eso-modal'); m.setAttribute('modal-type', 'modal');
    const dlg = document.createElement('eso-modal-dialog'); dlg.className = 'eso-modal-dialog'; m.appendChild(dlg);
    const render = async () => {
      const got = (await app.attachments()).data.model;
      const list = got.attachments; app.incidentNumber = () => got.incidentNumber;
      dlg.innerHTML = `<header>Attachments</header><div class="content"><div class="content-container"><div class="attachments-grid">
        ${list.map(a => `<grid-row class="noselect"><grid-cell class="icon-cell file-icon-cell"><div class="file-icon">.${a.extension}</div></grid-cell><grid-cell class="detail-cell"><strong>${a.name}</strong><aside class="ellipsify${a.description ? '' : ' nodata'}">${a.description || ''}</aside></grid-cell></grid-row>`).join('')}
        </div>${list.length ? '' : '<div class="no-selections-msg"><p>No attachments for this record<br><small>Click below to add one</small></p></div>'}</div>
        <div class="button-set"><button class="btn close">Close</button><button class="btn green-btn camera">Camera</button><button class="btn green-btn add">Add Attachment</button></div></div>`;
      dlg.querySelector('.close').addEventListener('click', () => m.remove());
      dlg.querySelector('.camera').addEventListener('click', async () => {
        app.cameraClicks++;
        const n = list.length + 1;
        await upload(await photoBlob(), `${app.incidentNumber()}Photo${n}.jpg`, '');
        render();
      });
      dlg.querySelector('.add').addEventListener('click', () => {
        app.attachClicks++;
        const d = document.createElement('eso-modal-dialog'); d.className = 'eso-modal-dialog';
        d.innerHTML = `<header>Add Attachment</header><div class="content"><div class="content-container"><grid-row class="field-with-button"><grid-cell><eso-display-field label="File" class="file-field eso-field"><div class="label-container"><label>File</label></div><eso-control class="underline"><div class="filename">Browse to select a file</div></eso-control></eso-display-field></grid-cell><grid-cell class="button-cell"><input type="file"><button class="btn browse">Browse</button></grid-cell></grid-row>
          <eso-field class="eso-field" data-field-ref="ATTACHMENTDESCRIPTION"><div class="label-container"><label>Description</label></div><eso-control class="underline"><eso-text><input type="text" class="input" maxlength="255"></eso-text></eso-control></eso-field>
          <footer class="button-set"><button class="btn cancel">Cancel</button><button type="submit" class="btn green-btn attach">Attach</button></footer></div></div>`;
        const input = d.querySelector('input[type=file]');
        input.addEventListener('change', () => { d.querySelector('.filename').textContent = input.files[0] ? input.files[0].name : 'Browse to select a file'; });
        d.querySelector('.cancel').addEventListener('click', () => d.remove());
        d.querySelector('.attach').addEventListener('click', async () => {
          const f = input.files[0]; if (!f) return;
          const n = list.length + 1;
          await upload(f, `${app.incidentNumber()}Photo${n}.${(f.name.split('.').pop() || 'jpg')}`, d.querySelector('eso-text input').value);
          d.remove(); render();
        });
        m.appendChild(d);
      });
    };
    await render();
    document.body.appendChild(m);
  });
  // a test stands in for the medic browsing to a file
  app.pickFile = (name, text) => {
    const input = document.querySelector('eso-modal-dialog input[type=file]'); if (!input) return false;
    const dt = new DataTransfer(); dt.items.add(new File([text || 'x'], name, { type: /pdf$/i.test(name) ? 'application/pdf' : 'image/jpeg' }));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;
  };
  // ---- loaded mileage, the way ESO does it: only with both addresses; a Calculating dialog, then
  // the three mileage fields are saved and the button goes; otherwise an alert dialog
  app.lockClicks = 0;
  document.getElementById('lockrecord').addEventListener('click', () => { app.lockClicks++; app.lock(); });
  app.calcClicks = 0; app.mileage = null;
  document.getElementById('calcMileage').addEventListener('click', () => {
    app.calcClicks++;
    const ready = ['scene', 'destination'].every(k => app.locations[k].name);
    const dlg = document.createElement('eso-modal-dialog');
    if (!ready) {
      dlg.innerHTML = '<h1>Missing address information</h1><p>Scene and destination addresses must have a valid address or GPS coordinates defined to calculate mileage.</p><div class="button-set"><button class="btn">OK</button></div>';
      dlg.querySelector('button').addEventListener('click', () => dlg.remove());
      document.body.appendChild(dlg); return;
    }
    dlg.innerHTML = '<h1>Calculating loaded mileage...</h1>';
    document.body.appendChild(dlg);
    setTimeout(() => {
      dlg.remove();
      app.edit('incident', 'incident.mileage.sceneMileage', 0, 'number'); app.edit('incident', 'incident.mileage.destinationMileage', 12.3, 'number'); app.edit('incident', 'incident.mileage.geocodedLoadedMiles', 12.3, 'number');
      app.mileage = 12.3; document.getElementById('loadedmiles').textContent = '12.3'; document.getElementById('calcMileage').style.display = 'none';
    }, 400);
  });
  // ---- assessments, the way ESO's app keeps them: every location starts Not_Assessed; Quick Ax sets a
  // whole category; the Mental Status section has Alert and Oriented x4
  const AX_CATS = { MentalStatus: ['MentalStatus'], Skin: ['Skin'], HEENT: ['Head', 'Face', 'Eyes', 'Neck'],
    Chest: ['GeneralAnterior', 'LeftAnterior', 'RightAnterior', 'GeneralPosterior', 'LeftSide', 'RightSide', 'HeartSounds', 'LungSounds_Bilateral', 'LungSounds_LL', 'LungSounds_LU', 'LungSounds_RL', 'LungSounds_RU'],
    Abdomen: ['AbdomenGeneral'], Back: ['BackGeneral'], PelvisGUGI: ['PelvisGUGI'], Extremities: ['ArmWholeArmAndHandLeft', 'ArmWholeArmAndHandRight', 'LegWholeLegAndFootLeft', 'LegWholeLegAndFootRight'], Neurological: ['Neurological'] };
  const AX_NAMES = { MentalStatus: 'Mental Status', Skin: 'Skin', HEENT: 'HEENT', Chest: 'Chest', Abdomen: 'Abdomen', Back: 'Back', PelvisGUGI: 'Pelvis/GU/GI', Extremities: 'Extremities', Neurological: 'Neurological' };
  app.assessments = []; // { key, findings: [{key, findingId, findingLocationId, present}] }
  const axAddr = (a) => `assessments.assessmentsV2.['${a.key}']`;
  function axSet(a, loc, findingId) {
    for (const f of a.findings.filter(f => f.findingLocationId === loc)) { app.del('assessments', `${axAddr(a)}.findings.['${f.key}']`, 'binary'); }
    a.findings = a.findings.filter(f => f.findingLocationId !== loc);
    const f = { key: uuid(), findingId, findingLocationId: loc, present: true };
    a.findings.push(f);
    app.dirty.push({ scope: 'assessments', op: { verb: 'ADD', address: `${axAddr(a)}.findings.['${f.key}']`, fieldRef: 'ASSESSMENT2FINDINGS', value: { findingId, findingLocationId: loc, present: true }, dataType: 'binary' } });
  }
  function axAddFinding(a, loc, findingId) {
    const f = { key: uuid(), findingId, findingLocationId: loc, present: true }; a.findings.push(f);
    app.dirty.push({ scope: 'assessments', op: { verb: 'ADD', address: `${axAddr(a)}.findings.['${f.key}']`, fieldRef: 'ASSESSMENT2FINDINGS', value: { findingId, findingLocationId: loc, present: true }, dataType: 'binary' } });
  }
  const catNormal = (a, cat) => AX_CATS[cat].every(loc => a.findings.some(f => f.findingLocationId === loc && f.findingId === 'No_Abnormalities'));
  function renderAx() {
    document.getElementById('axlist').innerHTML = app.assessments.map(a => `<assessment-record data-item-id="${a.key}"><header><section class="date-and-time">${a.time}</section><section class="ax-edit-buttons"><button class="btn link-btn delete">Delete</button><button class="btn link-btn has-bg quick-assess" title="Quick Ax">Quick Ax</button><button class="btn link-btn has-bg anatomical-figure">Figure</button></section></header>` +
      Object.keys(AX_CATS).map(cat => `<div class="assessment-summary" data-cat="${cat}"><span class="heading"><strong>${AX_NAMES[cat]}</strong></span><span class="no-abnormalities-or-not-assessed"><span class="finding-display ${catNormal(a, cat) ? 'assess-circle-check-bg' : ''}"></span></span></div>`).join('') + '</assessment-record>').join('');
  }
  app.quickAxOpens = 0; app.mentalOpens = 0;
  document.getElementById('addax').addEventListener('click', () => {
    const a = { key: uuid(), time: new Date().toTimeString().slice(0, 8), findings: [] };
    app.dirty.push({ scope: 'assessments', op: { verb: 'ADD', address: axAddr(a), fieldRef: 'ASSESSMENT2', value: { assessmentDate: '09/18/2026 09:00:00', assessmentTime: '09/18/2026 09:00:00' }, dataType: 'collectionWithData', isComplexType: true } });
    for (const locs of Object.values(AX_CATS)) for (const loc of locs) axAddFinding(a, loc, 'Not_Assessed');
    app.assessments.unshift(a); renderAx();
  });
  document.getElementById('axlist').addEventListener('click', (e) => {
    const rec = e.target.closest('assessment-record'); if (!rec) return;
    const a = app.assessments.find(x => x.key === rec.dataset.itemId);
    if (e.target.closest('.quick-assess')) {
      app.quickAxOpens++;
      const el = document.createElement('shelf-panel');
      el.innerHTML = `<header><h1>Quick Ax</h1><button class="btn green-btn workflow-btn">OK</button></header><div class="disclaimer">If No Abnormalities is selected…</div><div class="categories">` +
        Object.keys(AX_CATS).map(cat => `<div class="category" data-cat="${cat}"><header class="name">${AX_NAMES[cat]} <a class="assess">Assess</a></header><div class="buttons"><button class="btn radio-btn na ${catNormal(a, cat) ? 'selected' : ''}"><span class="label">${cat === 'MentalStatus' || cat === 'Neurological' ? 'Normal Baseline' : 'No Abnormalities'}</span></button><button class="btn radio-btn nas ${AX_CATS[cat].every(loc => a.findings.some(f => f.findingLocationId === loc && f.findingId === 'Not_Assessed')) ? 'selected' : ''}"><span class="label">Not Assessed</span></button></div></div>`).join('') + '</div>';
      el.querySelectorAll('.category').forEach(c => {
        const cat = c.dataset.cat;
        c.querySelector('.na').addEventListener('click', () => {
          const hasFindings = AX_CATS[cat].some(loc => a.findings.some(f => f.findingLocationId === loc && !['No_Abnormalities', 'Not_Assessed'].includes(f.findingId)));
          const apply = () => { for (const loc of AX_CATS[cat]) axSet(a, loc, 'No_Abnormalities'); c.querySelector('.na').classList.add('selected'); c.querySelector('.nas').classList.remove('selected'); };
          if (!hasFindings) return apply();
          // ESO asks before wiping findings in a category
          const d = document.createElement('eso-modal-dialog'); d.innerHTML = '<header>Change assessment?</header><div class="dialog-content">By changing this you will lose assessment information for this section.</div><div class="button-set"><button class="btn green-btn">Change assessment</button></div>';
          d.querySelector('button').addEventListener('click', () => { apply(); d.remove(); }); document.body.appendChild(d);
        });
      });
      el.querySelector('header button').addEventListener('click', () => { el.remove(); renderAx(); });
      shelfHost.appendChild(el);
    } else if (e.target.closest('.assessment-summary')) {
      const cat = e.target.closest('.assessment-summary').dataset.cat;
      if (cat === 'MentalStatus') app.mentalOpens++;
      const ao = ['Oriented_Person', 'Oriented_Place', 'Oriented_Time', 'Oriented_Event'].every(id => a.findings.some(f => f.findingLocationId === 'MentalStatus' && f.findingId === id));
      const el = document.createElement('shelf-panel');
      el.innerHTML = `<nav class="jumplinks"><ul>${Object.keys(AX_CATS).map(c => `<li class="${c === cat ? 'selected' : ''}"><div><div>${AX_NAMES[c]}</div></div></li>`).join('')}</ul></nav><header><h1>Assessment - ${a.time}</h1><button class="btn green-btn workflow-btn">OK</button></header><div class="assessment-entry"><main class="assessment">` +
        (cat === 'MentalStatus' ? `<section><header><h2>Mental Status</h2><div><button class="btn radio-btn ${catNormal(a, 'MentalStatus') ? 'selected' : ''}"><span class="label">Normal Baseline For Patient</span></button><button class="btn radio-btn"><span class="label">Not Assessed</span></button></div></header></section><section><header><h2>Orientation</h2><div><button class="btn radio-btn aox4 ${ao ? 'selected' : ''}"><span class="label">Alert and Oriented x4</span></button></div></header></section>` : `<section><header><h2>${AX_NAMES[cat]}</h2><div><button class="btn radio-btn"><span class="label">No Abnormalities</span></button><button class="btn radio-btn"><span class="label">Not Assessed</span></button></div></header></section>`) + '</main></div>';
      const aox = el.querySelector('.aox4');
      if (aox) aox.addEventListener('click', () => { for (const id of ['Oriented_Person', 'Oriented_Place', 'Oriented_Time', 'Oriented_Event']) if (!a.findings.some(f => f.findingLocationId === 'MentalStatus' && f.findingId === id)) axAddFinding(a, 'MentalStatus', id); aox.classList.add('selected'); });
      el.querySelector('header button').addEventListener('click', () => { el.remove(); renderAx(); });
      shelfHost.appendChild(el);
    }
  });
  const shelfHost = document.getElementById('shelfhost');
  function openShelf({ title, items, multi, checked, onOk, onPick }) {
    app.shelfOpens++;
    const el = document.createElement('shelf-panel');
    el.innerHTML = `<header><h1>${title}</h1><button class="btn green-btn workflow-btn">OK</button></header>
      <div class="search"><eso-search-input><label>Search</label><input type="text"><div class="cancel"></div></eso-search-input></div>
      <main class="viewport"><div class="content"><${multi ? 'eso-multi-select-panel' : 'eso-single-select-panel'}><ul></ul></${multi ? 'eso-multi-select-panel' : 'eso-single-select-panel'}></div></main>`;
    const ul = el.querySelector('ul'); const input = el.querySelector('input');
    const state = new Set(checked || []);
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      // like ESO's virtual list: only the matches are in the DOM
      ul.innerHTML = items.filter(([, name]) => !q || name.toLowerCase().includes(q)).map(([id, name]) =>
        `<li data-itemid="${id}" tabindex="0"><div class="label-content"><div class="selection-indicator"><check-mark class="${state.has(id) ? 'selected' : ''}"></check-mark></div><div class="label-container"><div>${name}<mark></mark></div><div class="description ng-hide"></div></div><div class="aside"></div></div></li>`).join('');
    };
    input.addEventListener('input', draw);
    ul.addEventListener('click', (e) => {
      const li = e.target.closest('li'); if (!li) return;
      const id = /^\d+$/.test(li.dataset.itemid) ? Number(li.dataset.itemid) : li.dataset.itemid;
      if (multi) { if (state.has(id)) state.delete(id); else state.add(id); draw(); }
      else { onPick(id); el.remove(); }
    });
    el.querySelector('header button').addEventListener('click', () => { onOk && onOk([...state]); el.remove(); });
    draw();
    shelfHost.appendChild(el);
  }
  for (const [k, g] of Object.entries(GROUPS)) {
    document.getElementById(g.btn).addEventListener('click', () => {
      openShelf({ title: g.title, items: g.items, multi: true, checked: app[held[k]], onOk: (ids) => {
        for (const id of ids) if (!app[held[k]].includes(id)) app.add('patient', `patient.${g.addr}.['${id}']`, { itemId: id }, 'fieldGroup');
        for (const id of app[held[k]]) if (!ids.includes(id)) app.del('patient', `patient.${g.addr}.['${id}']`, 'fieldGroup');
        app[held[k]] = ids;
        document.getElementById(g.list).innerHTML = ids.map(id => `<li>${(g.items.find(h => h[0] === id) || [0, id])[1]}</li>`).join('');
      } });
    });
  }
  document.querySelectorAll('.picker-icon').forEach(ic => ic.addEventListener('click', () => {
    const which = ic.dataset.field;
    openShelf({ title: which === 'initial' ? 'Initial Patient Acuity' : 'Final Patient Acuity', items: ACUITY[which], multi: false, checked: app.acuity[which] ? [app.acuity[which]] : [], onPick: (id) => {
      app.acuity[which] = id;
      app.edit('narrative', `narrative.patientComplaint.${which}PatientAcuityId`, id, 'singleselect');
      document.getElementById(which === 'initial' ? 'ia' : 'fa').textContent = ACUITY[which].find(a => a[0] === id)[1];
    } });
  }));
  function render() {
    const el = document.getElementById('status');
    if (el) el.textContent = `record ${app.recordId}\nresponses ${app.responses.length} errors ${app.errors.length}\nkeyMap ${JSON.stringify(app.keyMap)}`;
  }
  // signature pad
  const c = document.getElementById('sig');
  const ctx = c.getContext('2d');
  let drawing = false;
  c.addEventListener('pointerdown', (e) => { drawing = true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); });
  c.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(e.offsetX, e.offsetY); ctx.lineWidth = 2; ctx.stroke(); });
  c.addEventListener('pointerup', () => { drawing = false; });
})();
