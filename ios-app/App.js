import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
    const taken = new Directory(dir, 'taken');
    for (const f of [...dir.list(), ...(taken.exists ? taken.list() : [])]) {
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
  const back = /^https:\/\/(www\.)?esosuite\.net\//i.test(q.back || '') ? q.back : 'https://www.esosuite.net/ehr/';
  return { type: q.type || 'Other', record: q.record || '', incident: q.incident || '', pages: Math.max(1, Math.min(20, Number(q.pages) || 1)), back };
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
      const r = await DocumentScanner.scanDocument({ responseType: ResponseType.Base64, croppedImageQuality: 85, maxNumDocuments: req.pages });
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

  // Back to ESO: the page the scan left from opens in Safari (a fresh tab; the extension closes
  // the old one). iOS offers an app no way to jump back to the tab itself. A plain web link
  // would open in whatever browser the iPad has as its default (Chrome, on ours), where the
  // extension is not; the x-safari- form asks for Safari by name. Should iOS ever refuse it,
  // the plain link is the fallback.
  const backToEso = () => {
    const url = scan && scan.back ? scan.back : 'https://www.esosuite.net/ehr/';
    Linking.openURL(url.replace(/^https:\/\//i, 'x-safari-https://')).catch(() => Linking.openURL(url).catch(() => {}));
  };
  if (scan) {
    return (
      <View style={styles.scanPage}>
        <StatusBar style="light" />
        <Image source={require('./assets/icon.png')} style={styles.logo} />
        <Text style={styles.scanTitle}>ESO Save</Text>
        {state === 'scanning' && <Text style={styles.scanLead}>Scanning {scan.type}{scan.incident ? ` for ${scan.incident}` : ''}…</Text>}
        {state === 'done' && (
          <>
            <Text style={styles.scanLead}>{count === 1 ? 'One page' : `${count} pages`} scanned as {scan.incident ? scan.incident + ':' : ''}{scan.type}</Text>
            <Pressable style={styles.bigBtn} onPress={backToEso}><Text style={styles.bigBtnText}>Attach to ESO</Text></Pressable>
            <Text style={styles.scanHint}>Opens the run in Safari; the {count === 1 ? 'page attaches itself' : 'pages attach themselves'}.</Text>
            <Pressable style={styles.linkBtn} onPress={() => runScanner(scan)}><Text style={styles.linkText}>Scan it again instead</Text></Pressable>
          </>
        )}
        {state === 'cancelled' && (
          <>
            <Text style={styles.scanLead}>Nothing was scanned.</Text>
            <Pressable style={styles.bigBtn} onPress={() => runScanner(scan)}><Text style={styles.bigBtnText}>Scan</Text></Pressable>
            <Pressable style={styles.linkBtn} onPress={backToEso}><Text style={styles.linkText}>Back to ESO without scanning</Text></Pressable>
          </>
        )}
        {state === 'error' && (
          <>
            <Text style={styles.scanLead}>The scanner could not run: {error}</Text>
            <Pressable style={styles.bigBtn} onPress={() => runScanner(scan)}><Text style={styles.bigBtnText}>Try again</Text></Pressable>
            <Pressable style={styles.linkBtn} onPress={backToEso}><Text style={styles.linkText}>Back to ESO</Text></Pressable>
          </>
        )}
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>ESO Save</Text>
      <Text style={styles.lead}>This app carries the ESO Save extension for Safari and its paperwork scanner. You never need to open it yourself once the extension is turned on.</Text>
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
  scanPage: { flex: 1, backgroundColor: '#15803d', alignItems: 'center', justifyContent: 'center', padding: 32 },
  logo: { width: 180, height: 180, borderRadius: 40, marginBottom: 18 },
  scanTitle: { fontSize: 40, fontWeight: '800', color: '#fff', marginBottom: 10 },
  scanLead: { fontSize: 20, color: '#fff', textAlign: 'center', marginBottom: 26, lineHeight: 28 },
  bigBtn: { backgroundColor: '#fff', borderRadius: 16, paddingVertical: 22, paddingHorizontal: 48, minWidth: 320, alignItems: 'center' },
  bigBtnText: { color: '#15803d', fontWeight: '800', fontSize: 26 },
  scanHint: { fontSize: 15, color: '#d1fae5', textAlign: 'center', marginTop: 14 },
  linkBtn: { marginTop: 28, padding: 10 },
  linkText: { color: '#fff', fontSize: 16, textDecorationLine: 'underline' },
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
