import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import DocumentScanner, { ResponseType } from 'react-native-document-scanner-plugin';
import { Directory, File, Paths } from 'expo-file-system';

// The app carries the ESO Save extension for Safari, and lends it a document scanner: the
// extension opens esosave://scan?type=…&record=…&incident=…&pages=N from ESO's Attachments
// dialog, the pages are scanned here (VisionKit: edges found, page straightened) and left in the
// shared container, and the extension picks them up and attaches them when Safari is back.
const APP_GROUP = 'group.com.ruralmedems.esosave';
const SCANS_DIR = 'scans';

function scansDir() {
  const base = Paths.appleSharedContainers && Paths.appleSharedContainers[APP_GROUP];
  if (!base) throw new Error('The shared container is missing. Reinstall ESO Save.');
  const dir = new Directory(base, SCANS_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}
function pruneOld() {
  try {
    const dir = scansDir();
    for (const f of dir.list()) {
      if (!(f instanceof File) || !/\.json$/.test(f.name)) continue;
      const stamp = Number((/^(\d+)-/.exec(f.name) || [])[1]);
      if (stamp && Date.now() - stamp > 24 * 3600 * 1000) f.delete();
    }
  } catch (e) { /* nothing to prune */ }
}
function parseScanUrl(url) {
  const m = /^esosave:\/\/scan\??(.*)$/i.exec(url || '');
  if (!m) return null;
  const q = {};
  for (const part of m[1].split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent(i < 0 ? part : part.slice(0, i)), v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    q[k] = v;
  }
  return { type: q.type || 'Other', record: q.record || '', incident: q.incident || '', pages: Math.max(1, Math.min(20, Number(q.pages) || 1)) };
}
function saveScan(req, pages) {
  const dir = scansDir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const f = new File(dir, id + '.json');
  f.write(JSON.stringify({ id, type: req.type, record: req.record, incident: req.incident, at: Date.now(), pages }));
  return id;
}

export default function App() {
  const [scan, setScan] = useState(null);   // the request from Safari
  const [state, setState] = useState('idle'); // idle | scanning | done | cancelled | error
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const busy = useRef(false);

  async function runScanner(req) {
    if (busy.current) return;
    busy.current = true;
    setScan(req); setState('scanning'); setError('');
    try {
      const r = await DocumentScanner.scanDocument({ responseType: ResponseType.Base64, croppedImageQuality: 70, maxNumDocuments: req.pages });
      const pages = (r && r.scannedImages) || [];
      if (r && r.status === 'cancel' || !pages.length) { setState('cancelled'); return; }
      saveScan(req, pages.slice(0, req.pages));
      setCount(pages.length); setState('done');
    } catch (e) {
      setError(String((e && e.message) || e)); setState('error');
    } finally { busy.current = false; }
  }
  useEffect(() => {
    pruneOld();
    const handle = (url) => { const req = parseScanUrl(url); if (req) runScanner(req); };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>ESO Save</Text>
      {scan ? (
        <View style={styles.card}>
          <Text style={styles.h}>{scan.type}{scan.incident ? ` for ${scan.incident}` : ''}</Text>
          {state === 'scanning' && <Text style={styles.step}>The scanner is open. Line the page up and take the picture; it is straightened and cropped for you.</Text>}
          {state === 'done' && (
            <>
              <Text style={styles.step}>{count === 1 ? 'One page scanned.' : `${count} pages scanned.`} Tap <Text style={styles.b}>‹ Safari</Text> at the top left to go back to ESO. The {count === 1 ? 'page attaches itself' : 'pages attach themselves'} to the run as <Text style={styles.b}>{scan.incident ? scan.incident + ':' : ''}{scan.type}</Text>.</Text>
              <Pressable style={styles.btn} onPress={() => runScanner(scan)}><Text style={styles.btnText}>Scan it again instead</Text></Pressable>
            </>
          )}
          {state === 'cancelled' && (
            <>
              <Text style={styles.step}>Nothing was scanned. Tap <Text style={styles.b}>‹ Safari</Text> at the top left to go back to ESO, or scan now.</Text>
              <Pressable style={styles.btn} onPress={() => runScanner(scan)}><Text style={styles.btnText}>Scan</Text></Pressable>
            </>
          )}
          {state === 'error' && (
            <>
              <Text style={styles.step}>The scanner could not run: {error}</Text>
              <Pressable style={styles.btn} onPress={() => runScanner(scan)}><Text style={styles.btnText}>Try again</Text></Pressable>
            </>
          )}
        </View>
      ) : (
        <Text style={styles.lead}>This app carries the ESO Save extension for Safari and its paperwork scanner. You never need to open it yourself once the extension is turned on.</Text>
      )}
      <View style={styles.card}>
        <Text style={styles.h}>Turn it on (one time)</Text>
        <Text style={styles.step}>1. Open Settings, then Apps, then Safari, then Extensions.</Text>
        <Text style={styles.step}>2. Tap ESO Save and turn it on.</Text>
        <Text style={styles.step}>3. Under "Allow on websites", set esosuite.net to Allow.</Text>
        <Text style={styles.step}>4. Open ESO in Safari. A green ESO Save card appears in the bottom-left corner of the page.</Text>
        <Pressable style={styles.btn} onPress={() => Linking.openSettings()}>
          <Text style={styles.btnText}>Open Settings</Text>
        </Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.h}>What it does</Text>
        <Text style={styles.step}>Keeps every change to a run on this iPad until ESO confirms it saved. If signal drops, keep charting: the card turns amber, and everything pushes itself when signal returns. If a run is lost, the Runs button on the card puts it back.</Text>
        <Text style={styles.step}>Paperwork: pressing Camera in ESO's Attachments dialog asks what the paperwork is, opens this scanner, and attaches the straightened pages to the run under that name. A facesheet is read and offered to fill the Patient and Billing pages.</Text>
        <Text style={styles.step}>Always use the Safari app itself, not a home-screen shortcut. Extensions do not run in home-screen web apps.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72, backgroundColor: '#15803d', minHeight: '100%' },
  title: { fontSize: 34, fontWeight: '800', color: '#fff' },
  lead: { fontSize: 17, color: '#fff', marginTop: 8, marginBottom: 20, lineHeight: 24 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 18, marginBottom: 16, marginTop: 12 },
  h: { fontSize: 18, fontWeight: '700', marginBottom: 8, color: '#111' },
  step: { fontSize: 16, lineHeight: 23, color: '#222', marginBottom: 6 },
  b: { fontWeight: '700' },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
