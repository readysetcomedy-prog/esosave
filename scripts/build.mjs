// Builds dist/chrome (production) and dist/test (adds localhost so the mock ESO can be used).
// content.js gets the page-world interceptor embedded as a string so it can be injected inline
// on browsers that do not honour "world": "MAIN" (Safari).
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension');
const dist = join(root, 'dist');

const inject = readFileSync(join(src, 'inject.js'), 'utf8');
const content = readFileSync(join(src, 'content.js'), 'utf8')
  .replace('/*__INJECT_SRC__*/null', () => JSON.stringify(inject));
if (content === readFileSync(join(src, 'content.js'), 'utf8')) {
  throw new Error('build: failed to embed inject.js into content.js');
}

function emit(name, mutateManifest) {
  const out = join(dist, name);
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true });
  writeFileSync(join(out, 'content.js'), content);
  const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
  mutateManifest?.(manifest);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('built', out);
}

emit('chrome');
emit('test', (m) => {
  const extra = ['http://127.0.0.1/*', 'http://localhost/*'];
  m.host_permissions.push(...extra);
  for (const cs of m.content_scripts) cs.matches.push(...extra);
  for (const w of m.web_accessible_resources) w.matches.push(...extra);
});
// Same as "test" but without the MAIN-world manifest entry, so the inline-injection path
// (what Safari ends up using) is exercised by the test-suite too.
emit('test-inline', (m) => {
  const extra = ['http://127.0.0.1/*', 'http://localhost/*'];
  m.host_permissions.push(...extra);
  m.content_scripts = m.content_scripts.filter(cs => cs.world !== 'MAIN');
  for (const cs of m.content_scripts) cs.matches.push(...extra);
  for (const w of m.web_accessible_resources) w.matches.push(...extra);
});

// Safari build: identical extension, but a non-persistent background page instead of a service
// worker (Safari before 16.4 has no service-worker backgrounds, and on iOS they get killed anyway).
// It is copied into the Expo wrapper's Safari target so EAS Build ships it inside the iOS app.
emit('safari', (m) => {
  m.background = { scripts: ['background.js'], persistent: false };
});
{
  const target = join(root, 'ios-app', 'targets', 'esosave', 'assets');
  if (existsSync(target)) rmSync(target, { recursive: true });
  cpSync(join(dist, 'safari'), target, { recursive: true });
  console.log('copied Safari build to', target);
}
