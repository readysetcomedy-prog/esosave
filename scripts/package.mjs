// Zips dist/chrome into dist/esosave-chrome-<version>.zip for hand-off to IT or the Web Store.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')).version;
const out = join(root, 'dist', `esosave-chrome-${version}.zip`);
if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-qr', out, '.'], { cwd: join(root, 'dist', 'chrome'), stdio: 'inherit' });
console.log('wrote', out);
