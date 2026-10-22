import { requireNativeModule } from 'expo-modules-core';

// the native reader; absent in a build without it (Expo Go), in which case the extension reads
// the scan itself when it is claimed, as before
let mod = null;
try { mod = requireNativeModule('EsosaveOcr'); } catch (e) { mod = null; }
export default mod;
