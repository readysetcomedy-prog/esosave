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
  const app = window.app = {
    recordId: null, keyMap: {}, dirty: [], responses: [], views: {}, autosaveMs: 300, flushing: false, errors: [],
    async start() {
      const r = await xhr('POST', '/ehr/api/PatientCareRecords', JSON.stringify({ createdDateTime: '09/15/2026 14:08:24 -05:00' }));
      const j = JSON.parse(r.text);
      this.recordId = j.data; this.keyMap = {}; this.dirty = []; this.views = {};
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
      if (view === 'Incident') { renderDelays(out.body); renderSS(out.body); loadBundle(); }
      document.getElementById('narrative').style.display = view === 'Narrative' ? 'block' : 'none';
      if (view === 'Patient') renderHistory(out.body);
      if (view === 'Narrative') { renderAcuity(out.body); renderTransport(out.body); }
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
  const TRANSPORT = {
    howPatientWasMovedToStretcherIds: [[15110, 'Ambulated with assistance'], [15111, 'Ambulated to stretcher no assistance'], [15112, 'Lifted to stretcher'], [15113, 'Lifted to stretcher via draw-sheet'], [15114, 'Lifted to stretcher via Hoyer lift'], [15115, 'Lifted to stretcher with backboard'], [15119, 'Via stand and pivot'], [15120, 'Via stair chair']],
    patientMovedFromSceneToAmbulanceMethodIds: [[7180, 'Assisted/Walk'], [7182, 'Stairchair'], [7183, 'Stretcher'], [10552, 'Wheelchair']],
    patientMovedFromAmbulanceToDestinationMethodIds: [[7193, 'Assisted/Walk'], [7195, 'Stairchair'], [7196, 'Stretcher'], [10555, 'Wheelchair']],
    patientPositionDuringTransportIds: [[7186, 'Fowlers (Semi-Upright Sitting)'], [7189, 'Semi-Fowlers'], [7190, 'Sitting'], [7191, 'Supine'], [10558, 'Trendelenburg']],
  };
  app.transport = {};
  function renderTransport(body) {
    const m = body && body.data && body.data.model && body.data.model.patientTransport;
    for (const f of document.querySelectorAll('#narrative eso-field.ms')) {
      const k = f.dataset.key; const ids = ((m && m[k]) || []).map(Number); app.transport[k] = ids;
      f.querySelector('.display-value').textContent = ids.map(id => (TRANSPORT[k].find(t => t[0] === id) || [0, id])[1]).join(', ');
    }
  }
  document.querySelectorAll('#narrative eso-field.ms .shelf-click-indicator').forEach(ic => ic.addEventListener('click', () => {
    const f = ic.closest('eso-field'); const k = f.dataset.key;
    openShelf({ title: f.dataset.title, items: TRANSPORT[k], multi: true, checked: app.transport[k] || [], onOk: (ids) => {
      const had = app.transport[k] || [];
      for (const id of ids) if (!had.includes(id)) app.addScalar('narrative', `narrative.patientTransport.${k}.['${id}']`, id);
      for (const id of had) if (!ids.includes(id)) app.del('narrative', `narrative.patientTransport.${k}.['${id}']`, 'multiselect');
      app.transport[k] = ids;
      f.querySelector('.display-value').textContent = ids.map(id => (TRANSPORT[k].find(t => t[0] === id) || [0, id])[1]).join(', ');
    } });
  }));
  // ---- single-select fields the way ESO draws them: display value, click indicator, and quick-pick
  // buttons shown while the field is empty. Ids and names are ESO's.
  const SS = {
    PRIORITYID: { label: 'Response Mode to Scene', addr: 'incident.response.priorityId', list: [[338, 'Emergent'], [339, 'Non-Emergent'], [336, 'Emergent Downgraded to Non-Emergent'], [337, 'Non-Emergent Upgraded to Emergent']], quick: { 338: 'Emergent', 336: 'Emergent Downgraded to Non-Emergent', 339: 'Non-Emergent' } },
    RESPONSEMODELIGHTSANDSIRENSUSE: { label: 'Response Mode Lights & Sirens Use', addr: 'incident.response.responseModeLightsAndSirensUseId', list: [[14797, 'Lights and Sirens'], [14798, 'Lights and No Sirens'], [14799, 'No Lights or Sirens']], quick: { 14797: 'Lights & Sirens', 14799: 'No Lights or Sirens', 14798: 'Lights and No Sirens' } },
    RESPONSEMODEINTERSECTIONNAVIGATION: { label: 'Response Mode Intersection Navigation', addr: 'incident.response.responseModeIntersectionNavigationId', list: [[14803, 'Against Normal Light Patterns'], [14804, 'With Automated Light Changing Technology'], [14805, 'With Normal Light Patterns']], quick: { 14805: 'With Normal Light Pattern', 14803: 'Against Normal Light Pattern', 14804: 'With Light Change Tech' } },
    RESPONSEMODESCHEDULED: { label: 'Response Mode Scheduled', addr: 'incident.response.responseModeScheduledId', list: [[14807, 'No (Unscheduled)'], [14808, 'Yes (Scheduled)']], quick: { 14807: 'No', 14808: 'Yes' } },
    RESPONSEMODESPEED: { label: 'Response Mode Speed', addr: 'incident.response.responseModeSpeedId', list: [[14810, 'Speed-Enhanced per Local Policy'], [14811, 'Speed-Normal Traffic']], quick: { 14811: 'Normal Traffic', 14810: 'Enhanced per Policy' } },
    EMDPERFORMEDID: { label: 'EMD Performed', addr: 'incident.response.emdPerformedID', list: [[6868, 'No'], [6869, 'Yes, With Pre-Arrival Instructions'], [6870, 'Yes, Without Pre-Arrival Instructions'], [10307, 'Yes, Unknown if Pre-Arrival Instructions Given']], quick: { 6869: 'Yes, w/ Instructions', 6870: 'Yes, w/o Instructions', 10307: 'Yes, Unknown', 6868: 'No' } },
    UNITDISPOSITIONITEMID: { label: 'Unit Disposition', addr: 'incident.disposition.unitDispositionItemID', list: [[14402, 'Patient Contact Made'], [14403, 'Canceled on Scene'], [14404, 'Canceled Prior to Arrival at Scene'], [14405, 'No Patient Contact'], [14406, 'No Patient Found']] },
    PATIENTEVALUATIONCAREDISPOSITIONITEMID: { label: 'Patient Evaluation and/or Care Disposition', addr: 'incident.disposition.patientEvaluationCareDispositionItemID', list: [[14410, 'Patient Evaluated and Care Provided'], [14411, 'Patient Evaluated and Refused Care'], [14412, 'Patient Evaluated, No Care Required'], [14413, 'Patient Refused Evaluation and Care']] },
    CREWDISPOSITIONITEMID: { label: 'Crew Disposition', addr: 'incident.disposition.crewDispositionItemID', list: [[14415, 'Initiated and Continued Primary Care'], [14417, 'Provided Care Supporting Primary EMS Crew'], [14420, 'Back in Service, No Care or Support Services Required'], [14421, 'Back in Service, Care or Support Services Refused']] },
    TRANSPORTDISPOSITIONITEMID: { label: 'Transport Disposition', addr: 'incident.disposition.transportDispositionItemID', list: [[14435, 'Transport by This EMS Unit (This Crew Only)'], [14436, 'Transport by This EMS Unit, with a Member of Another Crew'], [14439, 'Patient Refused Transport'], [14441, 'No Transport']] },
    REFUSALRELEASEITEMIDS: { label: 'Reason for Refusal or Release', addr: 'incident.disposition.refusalReleaseItemIDs', multi: true, list: [[14443, 'Against Medical Advice'], [14444, 'Patient/Guardian Indicates Ambulance Transport is Not Necessary'], [14445, 'Released Following Protocol Guidelines']] },
    TRANSPORTMODEID: { label: 'Transport Mode', addr: 'incident.disposition.transportModeID', list: [[11850, 'Emergent (Immediate Response)'], [11851, 'Emergent Downgraded to Non-Emergent'], [11852, 'Non-Emergent'], [11853, 'Non-Emergent Upgraded to Emergent']] },
    TRANSPORTMODELIGHTSANDSIRENSUSE: { label: 'Transport Mode Lights & Sirens Use', addr: 'incident.disposition.transportModeLightsAndSirensUseId', list: [[14813, 'Lights and Sirens'], [14814, 'Lights and No Sirens'], [14815, 'No Lights or Sirens']], quick: { 14813: 'Lights & Sirens', 14815: 'No Lights or Sirens', 14814: 'Lights and No Sirens' } },
    TRANSPORTMETHODID: { label: 'Transport Method', addr: 'incident.disposition.transportMethodID', list: [[10353, 'Ground-Ambulance'], [10352, 'Air Medical-Rotor Craft'], [10355, 'Ground-Bariatric']], quick: { 10353: 'Ambulance', 10352: 'Rotor Craft', 10355: 'Bariatric' } },
    LEVELOFSERVICEID: { label: 'Level Of Service', addr: 'incident.disposition.levelOfServiceId', list: [[8196, 'Advanced Life Support'], [8197, 'Basic Life Support'], [8198, 'Critical Care']], quick: { 8197: 'BLS', 8196: 'ALS', 8198: 'Critical Care' } },
  };
  app.ss = {}; // ref -> value id(s)
  function ssHtml(ref) {
    const d = SS[ref];
    const qp = d.quick ? `<div class="quick-picks">${Object.entries(d.quick).map(([id, l]) => `<button class="btn" data-id="${id}">${l}</button>`).join('')}</div>` : '';
    return `<eso-field class="field" data-field-ref="${ref}"><div class="label-container"><label>${d.label}</label></div><div class="line field-area"><div class="display-value"></div><div class="shelf-click-indicator">&#9776;</div></div>${qp}</eso-field>`;
  }
  const nameOf = (ref, id) => (SS[ref].list.find(x => x[0] === Number(id)) || [0, ''])[1];
  function ssRender(ref) {
    const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); if (!f) return;
    const v = app.ss[ref];
    const names = Array.isArray(v) ? v.map(id => nameOf(ref, id)).join(', ') : (v ? nameOf(ref, v) : '');
    f.querySelector('.display-value').textContent = names;
    const qp = f.querySelector('.quick-picks'); if (qp) qp.style.display = names ? 'none' : '';
    // like ESO: patient/transport dispositions only apply once contact was made; transport mode only when transporting
    if (ref === 'UNITDISPOSITIONITEMID') for (const dep of ['PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'TRANSPORTDISPOSITIONITEMID']) document.querySelector(`eso-field[data-field-ref="${dep}"]`).toggleAttribute('disabled', v !== 14402);
    if (ref === 'TRANSPORTDISPOSITIONITEMID') for (const dep of ['TRANSPORTMODEID', 'TRANSPORTMODELIGHTSANDSIRENSUSE', 'TRANSPORTMETHODID']) document.querySelector(`eso-field[data-field-ref="${dep}"]`).toggleAttribute('disabled', !(v === 14435 || v === 14436));
  }
  function ssSet(ref, id) {
    const d = SS[ref];
    if (d.multi) { app.ss[ref] = (app.ss[ref] || []).concat([id]); app.addScalar('incident', `${d.addr}.['${id}']`, id); }
    else { app.ss[ref] = id; app.edit('incident', d.addr, id, 'singleselect'); }
    ssRender(ref);
  }
  document.getElementById('response').innerHTML = ['PRIORITYID', 'RESPONSEMODELIGHTSANDSIRENSUSE', 'RESPONSEMODEINTERSECTIONNAVIGATION', 'RESPONSEMODESCHEDULED', 'RESPONSEMODESPEED', 'EMDPERFORMEDID'].map(ssHtml).join('');
  document.getElementById('disposition').innerHTML = ['UNITDISPOSITIONITEMID', 'PATIENTEVALUATIONCAREDISPOSITIONITEMID', 'CREWDISPOSITIONITEMID', 'TRANSPORTDISPOSITIONITEMID', 'REFUSALRELEASEITEMIDS', 'TRANSPORTMODEID', 'TRANSPORTMODELIGHTSANDSIRENSUSE', 'TRANSPORTMETHODID', 'LEVELOFSERVICEID'].map(ssHtml).join('');
  for (const ref of Object.keys(SS)) {
    const f = document.querySelector(`eso-field[data-field-ref="${ref}"]`); if (!f) continue;
    f.querySelectorAll('.quick-picks button').forEach(b => b.addEventListener('click', () => { if (f.hasAttribute('disabled')) return; ssSet(ref, Number(b.dataset.id)); }));
    f.querySelector('.shelf-click-indicator').addEventListener('click', () => {
      if (f.hasAttribute('disabled')) return;
      const d = SS[ref];
      openShelf({ title: d.label, items: d.list, multi: !!d.multi, checked: d.multi ? (app.ss[ref] || []) : [], onPick: (id) => ssSet(ref, id), onOk: (ids) => { for (const id of ids) if (!(app.ss[ref] || []).includes(id)) ssSet(ref, id); } });
    });
    ssRender(ref);
  }
  function renderSS(body) {
    const m = body && body.data && body.data.model; if (!m) return;
    for (const [ref, d] of Object.entries(SS)) {
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
