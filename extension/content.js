/* ESO Save - extension-side content script (isolated world).
 *
 * - Makes sure the page-world interceptor (inject.js) is installed.
 * - Owns storage: every run's recorded batches, signature snapshots, blank-run templates, settings.
 * - Draws the always-visible status bar and the panel with the run list, restore buttons and log.
 */
(() => {
  'use strict';
  const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
  const INJECT_SRC = /*__INJECT_SRC__*/null;

  // ---------------------------------------------------------------- install the page-world script
  function ensureInjected() {
    if (document.documentElement.hasAttribute('data-esosave')) return;
    // Chrome honours "world": "MAIN" in the manifest. Safari does not, so load the same file from
    // the extension bundle as a page script (allowed by every CSP that trusts the extension origin),
    // and as a last resort inline it (ESO's own CSP allows inline scripts).
    try {
      const s = document.createElement('script');
      s.src = api.runtime.getURL('inject.js');
      s.async = false;
      s.onload = () => s.remove();
      s.onerror = () => { s.remove(); injectInline(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { injectInline(); }
    setTimeout(() => { if (!document.documentElement.hasAttribute('data-esosave')) injectInline(); }, 1500);
  }
  function injectInline() {
    if (document.documentElement.hasAttribute('data-esosave') || !INJECT_SRC) return;
    try {
      const s = document.createElement('script');
      s.textContent = INJECT_SRC;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* nothing else to try */ }
  }
  ensureInjected();

  const toPage = (type, payload) => window.postMessage({ __esosave: 'to-page', type, payload }, location.origin);

  // ---------------------------------------------------------------- storage
  const storage = api.storage.local;
  const sget = (keys) => new Promise(res => storage.get(keys, (v) => res(v || {})));
  const sset = (obj) => new Promise(res => storage.set(obj, () => res()));
  const sremove = (keys) => new Promise(res => storage.remove(keys, () => res()));
  const DEFAULT_SETTINGS = { purgeHoursAfterLock: 24, probeSec: 20, heldProbeSec: 8 };

  async function loadAll() {
    const all = await sget(null);
    const runs = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith('run:')) runs[k.slice(4)] = v;
    return { runs, templates: all.templates || null, settings: { ...DEFAULT_SETTINGS, ...(all.settings || {}) }, all };
  }
  async function purgeLocked(settings) {
    const { runs, all } = await loadAll();
    const hours = Number(settings.purgeHoursAfterLock);
    const cutoff = Date.now() - Math.max(0, hours) * 3600 * 1000;
    const dead = Object.values(runs).filter(r => r.locked && r.lockedAt && r.lockedAt <= cutoff && !r.batches.some(b => b.status === 'held' || b.status === 'rejected'));
    if (!dead.length) return;
    const keys = [];
    for (const r of dead) { keys.push('run:' + r.recordId, 'sigs:' + r.recordId); toPage('action', { name: 'forget', recordId: r.recordId }); }
    await sremove(keys.filter(k => k in all || k.startsWith('run:')));
  }

  let settings = { ...DEFAULT_SETTINGS };
  (async () => {
    const data = await loadAll();
    settings = data.settings;
    await purgeLocked(settings);
    const fresh = await loadAll();
    toPage('init', { runs: fresh.runs, templates: fresh.templates, settings });
    setInterval(() => purgeLocked(settings), 10 * 60 * 1000);
  })();
  // The page script may have been injected before our listener existed; ask for a status once ready.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__esosave !== 'to-ext') return;
    const { type, payload } = ev.data;
    if (type === 'persistRun' && payload && payload.run) {
      await sset({ ['run:' + payload.run.recordId]: payload.run });
    } else if (type === 'persistTemplates') {
      await sset({ templates: payload.templates });
    } else if (type === 'sig' && payload) {
      const key = 'sigs:' + (payload.recordId || 'unknown');
      const cur = (await sget(key))[key] || [];
      cur.push(payload);
      while (cur.length > 60) cur.shift();
      await sset({ [key]: cur });
      if (panelOpen) renderPanel();
    } else if (type === 'status' && payload) {
      lastStatus = payload;
      renderBar();
      if (panelOpen) renderPanel();
      try { api.runtime.sendMessage({ type: 'badge', held: payload.held, rejected: payload.rejected, online: payload.online }); } catch (e) { /* worker asleep */ }
    }
  });

  // ---------------------------------------------------------------- UI
  let lastStatus = null;
  let panelOpen = false;
  let host, shadow, bar, panel;
  const fmtTime = (t) => t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
  const fmtWhen = (t) => t ? new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646; height: 34px; display: flex; align-items: center; gap: 10px;
           padding: 0 12px; font-size: 14px; font-weight: 600; color: #fff; cursor: pointer; user-select: none;
           box-shadow: 0 -2px 8px rgba(0,0,0,.25); transition: background .2s; }
    .bar.good { background: #15803d; } .bar.warn { background: #b45309; } .bar.bad { background: #b91c1c; } .bar.info { background: #1d4ed8; }
    .bar.warn, .bar.bad { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #fff; flex: none; }
    .bar .msg { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar .small { font-weight: 400; opacity: .9; font-size: 12px; }
    .bar .btn { background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.5); color: #fff; border-radius: 6px; padding: 3px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .panel { position: fixed; right: 8px; bottom: 42px; width: min(560px, calc(100vw - 16px)); max-height: min(78vh, 720px); overflow: auto; z-index: 2147483647;
             background: #fff; color: #111; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.35); padding: 14px 16px; font-size: 14px; line-height: 1.4; }
    .panel h1 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; justify-content: space-between; }
    .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #555; margin: 14px 0 6px; }
    .panel .x { cursor: pointer; font-size: 20px; padding: 0 6px; color: #666; }
    .run { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
    .run.current { border-color: #1d4ed8; box-shadow: 0 0 0 2px rgba(29,78,216,.15); }
    .run .head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .run .num { font-weight: 700; font-size: 15px; }
    .pill { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 600; margin-left: 4px; }
    .pill.good { background: #dcfce7; color: #166534; } .pill.warn { background: #fef3c7; color: #92400e; } .pill.bad { background: #fee2e2; color: #991b1b; } .pill.info { background: #dbeafe; color: #1e40af; } .pill.gray { background: #eee; color: #444; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    button.a { background: #1d4ed8; color: #fff; border: 0; border-radius: 6px; padding: 6px 10px; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.a.sec { background: #e5e7eb; color: #111; } button.a.danger { background: #b91c1c; }
    button.a:disabled { opacity: .5; cursor: default; }
    .log { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: #f6f6f6; border-radius: 8px; padding: 8px; max-height: 180px; overflow: auto; margin-top: 8px; white-space: pre-wrap; }
    .log .error { color: #b91c1c; font-weight: 700; } .log .warn { color: #b45309; } .log .good { color: #15803d; }
    .sigs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .sig { border: 1px solid #ddd; border-radius: 8px; padding: 6px; width: 160px; font-size: 11px; }
    .sig img { width: 100%; height: 60px; object-fit: contain; background: #fff; border-bottom: 1px solid #eee; margin-bottom: 4px; }
    .sig a { color: #1d4ed8; }
    .muted { color: #666; font-size: 12px; }
    label.s { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
    input[type=number] { width: 70px; padding: 4px; }
  `;

  function mountUI() {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.id = 'esosave-host';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = CSS; shadow.appendChild(style);
    bar = document.createElement('div'); bar.className = 'bar info'; bar.innerHTML = '<span class="dot"></span><span class="msg">ESO Save starting…</span>';
    bar.addEventListener('click', (e) => { if (e.target.closest('.btn')) return; togglePanel(); });
    shadow.appendChild(bar);
    document.body.appendChild(host);
    renderBar();
  }
  if (document.body) mountUI(); else document.addEventListener('DOMContentLoaded', mountUI);
  // ESO might replace the body; keep the bar alive.
  setInterval(() => { if (host && !document.body.contains(host)) document.body.appendChild(host); }, 3000);

  function barState(s) {
    if (!s) return { cls: 'info', msg: 'ESO Save starting…' };
    const cur = s.runs.find(r => r.recordId === s.currentRecordId);
    const num = cur && cur.incidentNumber ? cur.incidentNumber : null;
    const heldTxt = s.held ? `${s.held} change${s.held === 1 ? '' : 's'} held on this device` : '';
    if (s.rejected) return { cls: 'bad', msg: `ESO REJECTED ${s.rejected} change${s.rejected === 1 ? '' : 's'}${num ? ' for ' + num : ''} - tap for details`, btn: 'Details' };
    if (s.loggedOut) return { cls: 'bad', msg: `LOGGED OUT of ESO${s.held ? ' - ' + heldTxt + ', will push after you log in' : ''}`, btn: 'Details' };
    if (!s.online) return { cls: 'warn', msg: `NO SIGNAL${s.held ? ' - ' + heldTxt : ' - keep working, changes are being kept here'}${num ? ' (' + num + ')' : ''}`, btn: s.held ? 'Push now' : null };
    if (s.pushing) return { cls: 'info', msg: `Pushing held changes to ESO…${num ? ' (' + num + ')' : ''}` };
    if (s.held) return { cls: 'warn', msg: `${heldTxt}${num ? ' for ' + num : ''} - pushing shortly`, btn: 'Push now' };
    const saved = cur && cur.lastSavedAt ? ` · last save ${fmtTime(cur.lastSavedAt)}` : '';
    return { cls: 'good', msg: `ESO Save · signal OK${num ? ' · ' + num : ''}${saved}`, small: true };
  }
  function renderBar() {
    if (!bar) return;
    const st = barState(lastStatus);
    bar.className = 'bar ' + st.cls;
    bar.innerHTML = `<span class="dot"></span><span class="msg ${st.small ? 'small' : ''}">${esc(st.msg)}</span>` +
      (st.btn ? `<span class="btn" data-act="${st.btn === 'Push now' ? 'push' : 'open'}">${esc(st.btn)}</span>` : '') +
      `<span class="btn" data-act="open">Runs</span>`;
    bar.querySelectorAll('.btn').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.act === 'push') toPage('action', { name: 'pushNow' }); else togglePanel(true);
    }));
  }
  function togglePanel(force) {
    panelOpen = force === undefined ? !panelOpen : !!force;
    if (panelOpen) { if (!panel) { panel = document.createElement('div'); panel.className = 'panel'; shadow.appendChild(panel); } renderPanel(); panel.style.display = 'block'; }
    else if (panel) panel.style.display = 'none';
  }
  async function renderPanel() {
    if (!panel || !panelOpen) return;
    const s = lastStatus || { runs: [], online: true };
    const all = await sget(null);
    const parts = [];
    parts.push(`<h1><span>ESO Save</span><span class="x" data-act="close">×</span></h1>`);
    parts.push(`<div class="muted">${s.online ? 'Signal OK' : 'NO SIGNAL'}${s.loggedOut ? ' · logged out' : ''}${s.pushing ? ' · pushing' : ''} · ${s.runs.length} run${s.runs.length === 1 ? '' : 's'} on this device` +
      `${s.hasTemplates ? '' : ' · <span title="Start one run with signal so a blank-run template is saved">no offline new-run template yet</span>'}</div>`);
    parts.push(`<div class="actions"><button class="a" data-act="push">Push all held changes now</button><button class="a sec" data-act="export-all">Export everything</button><button class="a sec" data-act="settings">Settings</button></div>`);
    if (settingsOpen) {
      parts.push(`<div class="run"><label class="s">Clear a run from this device <input type="number" min="0" max="720" id="purge" value="${esc(settings.purgeHoursAfterLock)}"> hours after it is locked (0 = right away)</label>` +
        `<div class="actions"><button class="a" data-act="save-settings">Save</button></div></div>`);
    }
    if (!s.runs.length) parts.push(`<p class="muted">No runs recorded yet. Open a run in ESO and every save will be recorded here.</p>`);
    for (const r of s.runs) {
      const sigs = all['sigs:' + r.recordId] || [];
      const c = r.counts;
      const pills = [];
      if (r.pendingCreate) pills.push('<span class="pill warn">not yet created on ESO</span>');
      if (c.held) pills.push(`<span class="pill warn">${c.held} held</span>`);
      if (c.rejected) pills.push(`<span class="pill bad">${c.rejected} rejected</span>`);
      if (r.locked) pills.push('<span class="pill good">locked</span>');
      else if (!c.held && !c.rejected && c.total) pills.push('<span class="pill good">all on ESO</span>');
      if (r.recordId === s.currentRecordId) pills.push('<span class="pill info">open now</span>');
      if (r.restoredFrom) pills.push('<span class="pill gray">restored</span>');
      parts.push(`<div class="run ${r.recordId === s.currentRecordId ? 'current' : ''}" data-id="${esc(r.recordId)}">
        <div class="head"><span class="num">${esc(r.incidentNumber || '(no incident number yet)')}</span><span>${pills.join('')}</span></div>
        <div class="muted">${c.total} save${c.total === 1 ? '' : 's'} recorded · started ${fmtWhen(r.createdAt)} · last activity ${fmtWhen(r.lastSeenAt)}${r.lastSavedAt ? ' · last confirmed by ESO ' + fmtTime(r.lastSavedAt) : ''}${sigs.length ? ` · ${sigs.length} signature image${sigs.length === 1 ? '' : 's'}` : ''}</div>
        <div class="actions">
          <button class="a" data-act="into-current" ${!s.currentRecordId || s.currentRecordId === r.recordId || !c.total ? 'disabled' : ''} title="Push every recorded change of this run into the run that is open in ESO right now">Push into the open run</button>
          <button class="a" data-act="into-new" ${!c.total || !s.online ? 'disabled' : ''} title="Create a brand-new run on ESO and push every recorded change into it">Push into a NEW run</button>
          ${c.rejected ? '<button class="a sec" data-act="retry">Retry rejected</button><button class="a sec" data-act="drop">Drop rejected</button>' : ''}
          <button class="a sec" data-act="export">Export backup</button>
          <button class="a sec" data-act="toggle-log">Log</button>
          <button class="a danger" data-act="clear" title="Remove this run's recorded changes and signature images from this device">Clear</button>
        </div>
        ${openLogs.has(r.recordId) ? `<div class="log">${r.log.map(l => `<div class="${esc(l.level)}">${esc(fmtTime(l.ts))}  ${esc(l.msg)}</div>`).join('') || '<div class="muted">nothing yet</div>'}</div>` : ''}
        ${openLogs.has(r.recordId) && sigs.length ? `<div class="sigs">${sigs.map((g, i) => `<div class="sig"><img src="${g.dataUrl}" alt=""><div>${esc(g.label)}</div><div class="muted">${esc(fmtWhen(g.ts))} · <a href="${g.dataUrl}" download="signature-${esc(r.incidentNumber || r.recordId)}-${i + 1}.png">save image</a></div></div>`).join('')}</div>` : ''}
      </div>`);
    }
    parts.push(`<p class="muted">Everything here stays on this device until ESO confirms it. Locked runs clear after ${esc(settings.purgeHoursAfterLock)} hour(s). Signature images are a backup in case a signature never reaches ESO.</p>`);
    panel.innerHTML = parts.join('');
    panel.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', onPanelAction));
  }
  const openLogs = new Set();
  let settingsOpen = false;
  async function onPanelAction(e) {
    const el = e.currentTarget;
    const act = el.dataset.act;
    const runEl = el.closest('.run');
    const id = runEl && runEl.dataset.id;
    if (act === 'close') togglePanel(false);
    else if (act === 'push') toPage('action', { name: 'pushNow' });
    else if (act === 'settings') { settingsOpen = !settingsOpen; renderPanel(); }
    else if (act === 'save-settings') {
      const v = Number(panel.querySelector('#purge').value);
      settings.purgeHoursAfterLock = Number.isFinite(v) && v >= 0 ? v : 24;
      await sset({ settings }); toPage('settings', settings); settingsOpen = false; renderPanel();
    }
    else if (act === 'toggle-log') { if (openLogs.has(id)) openLogs.delete(id); else openLogs.add(id); renderPanel(); }
    else if (act === 'into-current') { if (confirm('Push every recorded change of this run into the run that is open in ESO now?')) toPage('action', { name: 'pushIntoCurrent', recordId: id }); }
    else if (act === 'into-new') { if (confirm('Create a brand-new run on ESO and push every recorded change of this run into it?')) toPage('action', { name: 'pushIntoNew', recordId: id }); }
    else if (act === 'retry') toPage('action', { name: 'retryRejected', recordId: id });
    else if (act === 'drop') { if (confirm('Drop the rejected changes? They will stay in the export but will not be pushed again.')) toPage('action', { name: 'dropRejected', recordId: id }); }
    else if (act === 'export') exportRuns([id]);
    else if (act === 'export-all') exportRuns(null);
    else if (act === 'clear') {
      if (!confirm('Remove this run\'s recorded changes and signature images from this device? This cannot be undone.')) return;
      await sremove(['run:' + id, 'sigs:' + id]);
      toPage('action', { name: 'forget', recordId: id });
      openLogs.delete(id);
      renderPanel();
    }
  }
  async function exportRuns(ids) {
    const all = await sget(null);
    const out = { exportedAt: new Date().toISOString(), version: (lastStatus && lastStatus.version) || null, runs: {}, signatures: {} };
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('run:') && (!ids || ids.includes(k.slice(4)))) out.runs[k.slice(4)] = v;
      if (k.startsWith('sigs:') && (!ids || ids.includes(k.slice(5)))) out.signatures[k.slice(5)] = v;
    }
    const name = ids && ids.length === 1 && out.runs[ids[0]] ? (out.runs[ids[0]].incidentNumber || ids[0]) : 'all-runs';
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `esosave-${String(name).replace(/[^\w.-]+/g, '_')}.json`; a.target = '_blank';
    shadow.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
})();
