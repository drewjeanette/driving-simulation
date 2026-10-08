#!/usr/bin/env node
/**
 * Builds the simulator for andrewjeanette.com/drive/ and copies it into a
 * checkout of the website repository (default: ../andrewjeanette.com/drive).
 *
 *   npm run publish:site                 # uses ../andrewjeanette.com
 *   SITE_DIR=/path/to/site npm run publish:site
 *
 * Never copies API keys: config.json is excluded, and the build itself has no
 * key in it unless VITE_GOOGLE_MAPS_API_KEY was set, which this script refuses.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(process.env.SITE_DIR ?? join(root, '..', 'andrewjeanette.com'));
const target = join(site, 'drive');

if (process.env.VITE_GOOGLE_MAPS_API_KEY) {
  console.error(
    'Refusing to publish: VITE_GOOGLE_MAPS_API_KEY is set and would be baked into a public repo.',
  );
  console.error('Unset it; the site injects the key at deploy time via config.json instead.');
  process.exit(1);
}
if (!existsSync(join(site, 'package.json'))) {
  console.error(`Website checkout not found at ${site}. Set SITE_DIR.`);
  process.exit(1);
}

execSync('npm run build', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, BASE_PATH: '/drive/', VITE_GOOGLE_MAPS_API_KEY: '' },
});

rmSync(target, { recursive: true, force: true });
cpSync(join(root, 'dist'), target, {
  recursive: true,
  filter: (src) => !src.endsWith('.map') && !src.endsWith('config.json'),
});

const size = (dir) =>
  readdirSync(dir).reduce((n, f) => {
    const p = join(dir, f);
    return n + (statSync(p).isDirectory() ? size(p) : statSync(p).size);
  }, 0);
console.log(`Published to ${target} (${(size(target) / 1e6).toFixed(1)} MB)`);
