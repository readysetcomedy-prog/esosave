import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import MonitorTest from './MonitorTest';

// The app itself does nothing. It exists so Safari can find the ESO Save extension.
export default function App() {
  const [monitorTest, setMonitorTest] = useState(false); // off every launch on purpose
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>ESO Save</Text>
      <Text style={styles.lead}>This app carries the ESO Save extension for Safari. You never need to open it again once the extension is turned on.</Text>
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
        <Text style={styles.step}>Always use the Safari app itself, not a home-screen shortcut. Extensions do not run in home-screen web apps.</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={[styles.h, { marginBottom: 0, flex: 1 }]}>Monitor test (experimental)</Text>
          <Switch value={monitorTest} onValueChange={setMonitorTest} />
        </View>
        <Text style={styles.step}>Off by default. Turn on to see whether the iPad can read a cardiac monitor over Bluetooth. Does nothing until you tap Scan.</Text>
      </View>
      {monitorTest ? <MonitorTest /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72, backgroundColor: '#15803d', minHeight: '100%' },
  title: { fontSize: 34, fontWeight: '800', color: '#fff' },
  lead: { fontSize: 17, color: '#fff', marginTop: 8, marginBottom: 20, lineHeight: 24 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 18, marginBottom: 16 },
  h: { fontSize: 18, fontWeight: '700', marginBottom: 8, color: '#111' },
  step: { fontSize: 16, lineHeight: 23, color: '#222', marginBottom: 6 },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
});
