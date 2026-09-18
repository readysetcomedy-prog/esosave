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
      if (view === 'Incident') renderDelays(out.body);
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
    for (const f of document.querySelectorAll('#incident eso-field')) {
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
      const id = Number(li.dataset.itemid);
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
