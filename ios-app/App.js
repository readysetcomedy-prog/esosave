import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import DocumentScanner, { ResponseType } from 'react-native-document-scanner-plugin';
import { Directory, File, Paths } from 'expo-file-system';
import EsosaveOcr from './modules/esosave-ocr';
const FS = require('./facesheet.js'); // the same reader the extension fills from

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
function saveScan(req, pages, text) {
  const dir = scansDir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const f = new File(dir, id + '.json');
  f.write(JSON.stringify({ id, type: req.type, record: req.record, incident: req.incident, at: Date.now(), pages, ...(text ? { text } : {}) }));
  return id;
}
// a scan not yet taken by the extension is dropped (the crew scanned it again)
function dropScan(id) {
  try { const f = new File(scansDir(), id + '.json'); if (f.exists) f.delete(); } catch (e) { /* taken already, or gone */ }
}
// the text on the pages, as the extension would read it, read here instead so the crew sees it now
async function readPages(pages) {
  if (!EsosaveOcr) return null;
  const texts = [];
  for (const p of pages) { try { texts.push(await EsosaveOcr.read(p)); } catch (e) { texts.push(''); } }
  return texts.join('\n');
}
// what a facesheet read gives: the lines the fill would write, and what it could not find
const WANT = [['Name', /^Name:/], ['Date of birth', /^DOB:/], ['Sex', /^Sex:/], ['Address', /^Address/], ['Phone', /phone/i], ['SSN', /^SSN:/]];
function assess(text) {
  const plan = FS.facesheetPlan(FS.parseFacesheet(text || ''), null);
  const lines = plan.lines || [];
  const missing = WANT.filter(([, re]) => !lines.some(l => re.test(l))).map(([n]) => n);
  return { lines, missing, skipped: plan.skipped || [] };
}

export default function App() {
  const [scan, setScan] = useState(null);   // the request from Safari
  const [state, setState] = useState('idle'); // idle | scanning | reading | done | cancelled | error
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [review, setReview] = useState(null); // a facesheet: what was read, what was not
  const busy = useRef(false);
  const shots = useRef([]);   // a facesheet's reads so far: { pages, text, n }
  const savedId = useRef(null);

  // combine: a second scan of the same facesheet, its text joined after the better read, so the
  // fill finds every label either read gave (the first value wins, nothing is guessed)
  async function runScanner(req, combine) {
    if (busy.current) return;
    busy.current = true;
    setScan(req); setState('scanning'); setError('');
    if (!combine) { shots.current = []; setReview(null); }
    try {
      const r = await DocumentScanner.scanDocument({ responseType: ResponseType.Base64, croppedImageQuality: 90, maxNumDocuments: req.pages });
      const pages = ((r && r.scannedImages) || []).slice(0, req.pages);
      if (r && r.status === 'cancel' || !pages.length) { if (!shots.current.length) setState('cancelled'); else setState('done'); return; }
      let text = null;
      if (req.type === 'Facesheet' && EsosaveOcr) {
        setState('reading');
        const t = await readPages(pages);
        shots.current.push({ pages, text: t || '', n: assess(t).lines.length });
        const best = shots.current.slice().sort((a, b) => b.n - a.n);
        text = best.map(x => x.text).join('\n');
        const a = assess(text);
        setReview({ ...a, reads: shots.current.length });
        if (savedId.current) dropScan(savedId.current);
        savedId.current = saveScan(req, best[0].pages, text);
        setCount(best[0].pages.length);
      } else {
        if (savedId.current) dropScan(savedId.current);
        savedId.current = saveScan(req, pages);
        setCount(pages.length);
      }
      setState('done');
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

  // Back to ESO: iOS puts a small "◀ Safari" link in the top-left corner of the screen whenever
  // this app was opened from Safari, and that link returns to the very tab the scan left from.
  // Opening the run's address ourselves went to whatever browser the iPad calls its default, so
  // the screen points the crew at that corner instead; the pages attach themselves once Safari
  // is back.
  const Corner = ({ children }) => (
    <View style={styles.corner} pointerEvents="none">
      <Text style={styles.cornerArrow}>⬉</Text>
      <Text style={styles.cornerText}>{children}</Text>
    </View>
  );
  if (scan) {
    return (
      <View style={styles.scanPage}>
        <StatusBar style="light" />
        <Image source={require('./assets/icon.png')} style={styles.logo} />
        <Text style={styles.scanTitle}>ESO Save</Text>
        {state === 'scanning' && <Text style={styles.scanLead}>Scanning {scan.type}{scan.incident ? ` for ${scan.incident}` : ''}…</Text>}
        {state === 'reading' && <Text style={styles.scanLead}>Reading the facesheet…</Text>}
        {state === 'done' && review && (
          <>
            <Corner>Tap ◀ Safari up here to go back to ESO</Corner>
            <Text style={styles.scanLead}>Read from the facesheet{review.reads > 1 ? ` (${review.reads} scans combined)` : ''}:</Text>
            <View style={styles.readBox}>
              {review.lines.length ? review.lines.map((l, i) => <Text key={i} style={styles.readLine}>✓ {l}</Text>) : <Text style={styles.readMiss}>Nothing could be read into the Patient page.</Text>}
              {review.missing.map((m, i) => <Text key={'m' + i} style={styles.readMiss}>✗ {m} not found</Text>)}
            </View>
            {review.missing.length ? <Text style={styles.scanHint}>Something missing? Scan it again: the whole page in the frame, the tablet still, no glare or shadow. Combine keeps what this read found and adds what the next one finds. Whatever is not read is left for you to enter.</Text> : <Text style={styles.scanHint}>Check these over on the Patient page once it is filled.</Text>}
            <Text style={styles.scanBig}>Tap ◀ Safari in the top-left corner</Text>
            <Text style={styles.scanHint}>That takes you back to the run; the page attaches itself and ESO Save offers to fill the Patient page from it.</Text>
            <View style={styles.row}>
              <Pressable style={styles.linkBtn} onPress={() => runScanner(scan, true)}><Text style={styles.linkText}>Scan again and combine</Text></Pressable>
              <Pressable style={styles.linkBtn} onPress={() => runScanner(scan)}><Text style={styles.linkText}>Scan it again instead</Text></Pressable>
            </View>
          </>
        )}
        {state === 'done' && !review && (
          <>
            <Corner>Tap ◀ Safari up here to go back to ESO</Corner>
            <Text style={styles.scanLead}>{count === 1 ? 'One page' : `${count} pages`} scanned as {scan.incident ? scan.incident + ':' : ''}{scan.type}</Text>
            <Text style={styles.scanBig}>Tap ◀ Safari in the top-left corner</Text>
            <Text style={styles.scanHint}>That takes you back to the run, and the {count === 1 ? 'page attaches itself' : 'pages attach themselves'}.</Text>
            <Pressable style={styles.linkBtn} onPress={() => runScanner(scan)}><Text style={styles.linkText}>Scan it again instead</Text></Pressable>
          </>
        )}
        {state === 'cancelled' && (
          <>
            <Corner>◀ Safari goes back to ESO</Corner>
            <Text style={styles.scanLead}>Nothing was scanned.</Text>
            <Pressable style={styles.bigBtn} onPress={() => runScanner(scan)}><Text style={styles.bigBtnText}>Scan</Text></Pressable>
            <Text style={styles.scanHint}>Or tap ◀ Safari in the top-left corner to go back without scanning.</Text>
          </>
        )}
        {state === 'error' && (
          <>
            <Corner>◀ Safari goes back to ESO</Corner>
            <Text style={styles.scanLead}>The scanner could not run: {error}</Text>
            <Pressable style={styles.bigBtn} onPress={() => runScanner(scan)}><Text style={styles.bigBtnText}>Try again</Text></Pressable>
            <Text style={styles.scanHint}>Or tap ◀ Safari in the top-left corner to go back to ESO.</Text>
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
  readBox: { alignSelf: 'stretch', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, padding: 14, marginBottom: 18 },
  readLine: { color: '#fff', fontSize: 17, lineHeight: 26 },
  readMiss: { color: '#fecaca', fontSize: 17, lineHeight: 26, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 18 },
  scanPage: { flex: 1, backgroundColor: '#15803d', alignItems: 'center', justifyContent: 'center', padding: 32 },
  logo: { width: 180, height: 180, borderRadius: 40, marginBottom: 18 },
  scanTitle: { fontSize: 40, fontWeight: '800', color: '#fff', marginBottom: 10 },
  scanLead: { fontSize: 20, color: '#fff', textAlign: 'center', marginBottom: 26, lineHeight: 28 },
  bigBtn: { backgroundColor: '#fff', borderRadius: 16, paddingVertical: 22, paddingHorizontal: 48, minWidth: 320, alignItems: 'center' },
  bigBtnText: { color: '#15803d', fontWeight: '800', fontSize: 26 },
  scanBig: { fontSize: 30, fontWeight: '800', color: '#fff', textAlign: 'center', lineHeight: 38 },
  scanHint: { fontSize: 17, color: '#d1fae5', textAlign: 'center', marginTop: 14, lineHeight: 24 },
  // the callout that sits just under iOS's own "◀ Safari" link in the top-left corner
  corner: { position: 'absolute', top: 52, left: 16, flexDirection: 'row', alignItems: 'flex-start', maxWidth: 360 },
  cornerArrow: { fontSize: 44, color: '#fde047', lineHeight: 48, marginRight: 8 },
  cornerText: { fontSize: 20, fontWeight: '700', color: '#fde047', lineHeight: 26, marginTop: 8, flexShrink: 1 },
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
