// Optional diagnostic: what does the iPad's Bluetooth see, and what does a chosen device expose?
// Used to find out whether a cardiac monitor (e.g. a LIFEPAK 15) can be read directly. Off unless
// the switch on the main screen is turned on; nothing scans until Scan is tapped.
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

let managerModule = null;
function getManager() {
  if (!managerModule) {
    const { BleManager } = require('react-native-ble-plx');
    managerModule = new BleManager();
  }
  return managerModule;
}

const hex = (b64) => { try { return Array.from(atob(b64), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(' '); } catch { return '?'; } };

export default function MonitorTest() {
  const [state, setState] = useState('idle');
  const [devices, setDevices] = useState({});
  const [report, setReport] = useState('');
  const [error, setError] = useState('');
  const scanning = useRef(false);

  useEffect(() => () => { try { getManager().stopDeviceScan(); } catch {} }, []);

  const scan = async () => {
    setError(''); setReport(''); setDevices({});
    const m = getManager();
    try {
      const st = await m.state();
      if (st !== 'PoweredOn') { setError(`Bluetooth is ${st}. Turn it on in Settings and try again.`); return; }
    } catch (e) { setError('Bluetooth not available: ' + (e.message || e)); return; }
    setState('scanning'); scanning.current = true;
    m.startDeviceScan(null, { allowDuplicates: false }, (err, d) => {
      if (err) { setError('Scan error: ' + (err.message || err)); stop(); return; }
      if (!d) return;
      setDevices((prev) => ({ ...prev, [d.id]: { id: d.id, name: d.name || d.localName || '(no name)', rssi: d.rssi, services: d.serviceUUIDs || [], mfg: d.manufacturerData ? hex(d.manufacturerData) : '' } }));
    });
    setTimeout(stop, 15000);
  };
  const stop = () => { if (!scanning.current) return; scanning.current = false; try { getManager().stopDeviceScan(); } catch {} setState('idle'); };

  const inspect = async (dev) => {
    stop(); setState('connecting'); setError('');
    const m = getManager();
    const lines = [`Device: ${dev.name}`, `ID: ${dev.id}`, `RSSI: ${dev.rssi}`, `Advertised services: ${dev.services.join(', ') || 'none'}`, dev.mfg ? `Manufacturer data: ${dev.mfg}` : '', ''];
    try {
      const d = await m.connectToDevice(dev.id, { timeout: 15000 });
      await d.discoverAllServicesAndCharacteristics();
      const services = await d.services();
      lines.push(`${services.length} service(s):`);
      for (const s of services) {
        lines.push(`\nSERVICE ${s.uuid}`);
        const chars = await s.characteristics();
        for (const c of chars) {
          const props = [c.isReadable && 'read', c.isWritableWithResponse && 'write', c.isWritableWithoutResponse && 'write-noresp', c.isNotifiable && 'notify', c.isIndicatable && 'indicate'].filter(Boolean).join(',');
          let value = '';
          if (c.isReadable) { try { const r = await c.read(); value = r.value ? `  value: ${hex(r.value)}` : ''; } catch (e) { value = `  (read failed: ${e.message || e})`; } }
          lines.push(`  CHAR ${c.uuid} [${props}]${value}`);
        }
      }
      try { await d.cancelConnection(); } catch {}
    } catch (e) { lines.push(`\nConnect/discover failed: ${e.message || e}`); }
    setReport(lines.filter((l) => l !== undefined).join('\n'));
    setState('idle');
  };

  const list = Object.values(devices).sort((a, b) => (b.rssi || -999) - (a.rssi || -999));
  return (
    <View style={s.card}>
      <Text style={s.h}>Monitor test (experimental)</Text>
      <Text style={s.p}>Lists every Bluetooth device the iPad can see, and everything a chosen device exposes. A monitor that only uses classic Bluetooth will not appear here at all; that is a result too.</Text>
      <View style={s.row}>
        <Pressable style={s.btn} onPress={state === 'scanning' ? stop : scan}><Text style={s.btnText}>{state === 'scanning' ? 'Stop scan' : 'Scan (15 s)'}</Text></Pressable>
        {report ? <Pressable style={[s.btn, s.sec]} onPress={() => Share.share({ message: report })}><Text style={s.btnText}>Share report</Text></Pressable> : null}
      </View>
      {error ? <Text style={s.err}>{error}</Text> : null}
      {state === 'connecting' ? <Text style={s.p}>Connecting and reading services…</Text> : null}
      {list.map((d) => (
        <Pressable key={d.id} style={s.dev} onPress={() => inspect(d)}>
          <Text style={s.devName}>{d.name}</Text>
          <Text style={s.devSub}>{d.id} · RSSI {d.rssi}{d.services.length ? ` · ${d.services.length} advertised service(s)` : ''}</Text>
        </Pressable>
      ))}
      {state === 'idle' && !list.length && !report ? <Text style={s.p}>No devices listed yet. Tap Scan with the monitor switched on and nearby.</Text> : null}
      {report ? <ScrollView style={s.report}><Text style={s.mono} selectable>{report}</Text></ScrollView> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 18, marginBottom: 16 },
  h: { fontSize: 18, fontWeight: '700', marginBottom: 8, color: '#111' },
  p: { fontSize: 15, lineHeight: 22, color: '#222', marginBottom: 8 },
  row: { flexDirection: 'row', gap: 10, marginVertical: 6 },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  sec: { backgroundColor: '#475569' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  err: { color: '#b91c1c', fontSize: 14, marginVertical: 6 },
  dev: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 10, marginTop: 8 },
  devName: { fontSize: 16, fontWeight: '700', color: '#111' },
  devSub: { fontSize: 12, color: '#555', marginTop: 2 },
  report: { maxHeight: 360, marginTop: 10, backgroundColor: '#f4f4f5', borderRadius: 8, padding: 10 },
  mono: { fontFamily: 'Menlo', fontSize: 12, color: '#111' },
});
