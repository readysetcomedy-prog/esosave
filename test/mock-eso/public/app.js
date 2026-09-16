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
      return out;
    },
    async lock() { const r = await xhr('POST', `/ehr/api/PatientCareRecords/${this.recordId}/Lock`); await this.openTab('Incident'); return r.status; },
    async attachments() { const r = await xhr('GET', `/ehr/api/PatientCareRecords/${this.recordId}/Attachments`); return JSON.parse(r.text); },
    uuid,
  };
  setInterval(() => app.flush(), app.autosaveMs);
  app.clicks = [];
  document.getElementById('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    app.clicks.push(t.dataset.view);
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    app.openTab(t.dataset.view);
  });
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
