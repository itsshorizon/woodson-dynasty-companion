#!/usr/bin/env node
/**
 * Builds www/: the app exactly as shipped, and nothing else.
 *
 *   node scripts/build-www.js
 *
 * GitHub Pages serves the repo root, which also holds the data pipeline,
 * Cloud Functions, tests and docs. A native shell (Capacitor: see
 * capacitor.config.json and docs/AUDIT.md) or any other host needs only the
 * app, so this copies the shippable files into www/ and checks that
 * index.html loads no code from another site.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

// Folders shipped whole, plus root files by extension. Anything new at the
// root with one of these extensions ships automatically.
const DIRS = ['assets', 'data', 'vendor'];
const ROOT_EXT = ['.html', '.css', '.js', '.png', '.json'];
const SKIP = new Set(['package.json', 'package-lock.json', 'capacitor.config.json', 'firebase.json']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
let files = 0;
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && ROOT_EXT.includes(path.extname(e.name)) && !SKIP.has(e.name)) {
    fs.copyFileSync(path.join(ROOT, e.name), path.join(OUT, e.name));
    files++;
  }
}
DIRS.forEach((d) => copyDir(path.join(ROOT, d), path.join(OUT, d)));

// Remote code is a store-review and offline risk: fail the build if any creeps in.
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const remote = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map((m) => m[1]);
if (remote.length) {
  console.error('index.html loads code from another site:\n  ' + remote.join('\n  ') + '\nMove it into vendor/.');
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(OUT, 'version.json'), 'utf8')).version;
console.log(`Built www/ for ${version}: ${files} root files + ${DIRS.join(', ')}.`);
