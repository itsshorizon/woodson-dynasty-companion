#!/usr/bin/env node
/**
 * One version number, one command.
 *
 *   node scripts/release.js 1.36.0    set the version everywhere it lives
 *   node scripts/release.js --check   fail if the copies have drifted (CI runs this)
 *
 * The version lives in four files: version.json, BUILD_ID in app.js,
 * CACHE_NAME in sw.js and every ?v= in index.html. A missed one serves a mix
 * of old and new code, so nobody bumps them by hand any more.
 * After setting a version, edit "title" and "notes" in version.json: that is
 * the text the update prompt and Patch Notes show.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);

// Each place the version is written: how to find it and how to replace it.
const SPOTS = [
  { file: 'version.json', re: /("version":\s*")([^"]+)(")/g },
  { file: 'app.js', re: /(const BUILD_ID = ')([^']+)(')/g },
  { file: 'sw.js', re: /(const CACHE_NAME = 'wcc-v)([^']+)(')/g },
  { file: 'index.html', re: /(\?v=)([0-9][0-9A-Za-z.-]*)(")/g },
];

function found() {
  return SPOTS.map((s) => ({ file: s.file, versions: [...read(s.file).matchAll(s.re)].map((m) => m[2]) }));
}

/** Local files index.html loads that the service worker would not cache for offline use. */
function uncached() {
  const html = read('index.html');
  const sw = read('sw.js');
  const local = [...html.matchAll(/(?:src|href)="([^":]+\.(?:js|css))(?:\?[^"]*)?"/g)].map((m) => m[1]);
  return local.filter((f) => !sw.includes(`'./${f}'`));
}

const arg = process.argv[2];
if (arg === '--check') {
  const all = found();
  const versions = new Set(all.flatMap((x) => x.versions));
  const problems = [];
  all.forEach((x) => { if (!x.versions.length) problems.push(`${x.file}: no version found`); });
  if (versions.size > 1) problems.push(`versions differ: ${all.map((x) => `${x.file}=${[...new Set(x.versions)].join('/')}`).join(', ')}`);
  uncached().forEach((f) => problems.push(`${f} is loaded by index.html but missing from CORE_ASSETS in sw.js`));
  if (problems.length) {
    console.error('Release check failed:\n  ' + problems.join('\n  ') + '\nFix with: node scripts/release.js <version>');
    process.exit(1);
  }
  console.log(`Release check passed: ${[...versions][0]} in ${all.reduce((n, x) => n + x.versions.length, 0)} places.`);
} else if (/^\d+\.\d+\.\d+$/.test(arg || '')) {
  SPOTS.forEach((s) => write(s.file, read(s.file).replace(s.re, `$1${arg}$3`)));
  console.log(`Version set to ${arg}. Now edit "title" and "notes" in version.json.`);
} else {
  console.error('Usage: node scripts/release.js <major.minor.patch> | --check');
  process.exit(1);
}
