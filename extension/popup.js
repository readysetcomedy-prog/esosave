const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
const sget = (k) => new Promise(res => api.storage.local.get(k, v => res(v || {})));
const sremove = (k) => new Promise(res => api.storage.local.remove(k, () => res()));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => t ? new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

async function render() {
  const all = await sget(null);
  const runs = Object.entries(all).filter(([k]) => k.startsWith('run:')).map(([, v]) => v).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const list = document.getElementById('list');
  if (!runs.length) { list.innerHTML = '<p class="muted">No runs recorded on this device.</p>'; return; }
  list.innerHTML = runs.map(r => {
    const held = r.batches.filter(b => b.status === 'held').length;
    const rejected = r.batches.filter(b => b.status === 'rejected').length;
    const sigs = (all['sigs:' + r.recordId] || []).length;
    return `<div class="run" data-id="${esc(r.recordId)}">
      <div><span class="num">${esc(r.incidentNumber || '(no incident number yet)')}</span>
        ${held ? `<span class="pill warn">${held} held</span>` : ''}${rejected ? `<span class="pill bad">${rejected} rejected</span>` : ''}${r.locked ? '<span class="pill good">locked</span>' : (!held && !rejected && r.batches.length ? '<span class="pill good">all on ESO</span>' : '')}</div>
      <div class="muted">${r.batches.length} saves · ${sigs} signature images · last activity ${esc(when(r.lastSeenAt))}</div>
      <button class="sec" data-act="export">Export</button><button class="danger" data-act="clear">Clear</button>
    </div>`;
  }).join('');
  list.querySelectorAll('button').forEach(b => b.addEventListener('click', async (e) => {
    const id = e.target.closest('.run').dataset.id;
    if (e.target.dataset.act === 'export') exportRuns([id]);
    else if (confirm('Remove this run from this device?')) { await sremove(['run:' + id, 'sigs:' + id]); render(); }
  }));
}
async function exportRuns(ids) {
  const all = await sget(null);
  const out = { exportedAt: new Date().toISOString(), runs: {}, signatures: {} };
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('run:') && (!ids || ids.includes(k.slice(4)))) out.runs[k.slice(4)] = v;
    if (k.startsWith('sigs:') && (!ids || ids.includes(k.slice(5)))) out.signatures[k.slice(5)] = v;
  }
  const name = ids && ids.length === 1 && out.runs[ids[0]] ? (out.runs[ids[0]].incidentNumber || ids[0]) : 'all-runs';
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `esosave-${String(name).replace(/[^\w.-]+/g, '_')}.json`; document.body.appendChild(a); a.click(); a.remove();
}
document.getElementById('export').addEventListener('click', () => exportRuns(null));
render();
