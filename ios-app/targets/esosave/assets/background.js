/* ESO Save - background service worker.
 * Keeps the toolbar badge showing how many changes are held, and clears locked runs on a schedule
 * even when no ESO tab is open.
 */
const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'badge') return;
  const held = Number(msg.held || 0), rejected = Number(msg.rejected || 0);
  const text = rejected ? '!' : (held ? String(held) : '');
  const color = rejected ? '#b91c1c' : (held ? '#b45309' : (msg.online === false ? '#b45309' : '#15803d'));
  try { api.action.setBadgeText({ text }); api.action.setBadgeBackgroundColor({ color }); } catch (e) { /* ignore */ }
});

async function purge() {
  const all = await new Promise(res => api.storage.local.get(null, v => res(v || {})));
  const hours = Number((all.settings && all.settings.purgeHoursAfterLock) ?? 0);
  const cutoff = Date.now() - Math.max(0, hours) * 3600 * 1000;
  const keys = [];
  for (const [k, r] of Object.entries(all)) {
    if (!k.startsWith('run:') || !r || !r.locked || !r.lockedAt || r.lockedAt > cutoff) continue;
    if ((r.batches || []).some(b => b.status === 'held' || b.status === 'rejected')) continue;
    keys.push(k, 'sigs:' + r.recordId);
  }
  if (keys.length) await new Promise(res => api.storage.local.remove(keys, () => res()));
}
try {
  api.alarms.create('esosave-purge', { periodInMinutes: 60 });
  api.alarms.onAlarm.addListener((a) => { if (a.name === 'esosave-purge') purge(); });
} catch (e) { /* alarms unavailable */ }
api.runtime.onInstalled.addListener(() => { purge(); });
