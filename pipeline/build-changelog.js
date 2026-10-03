/**
 * build-changelog.js
 *
 * Rebuilds data/changelog.json (every release's title, date and notes) from
 * the git history of version.json, so the in-app Patch Notes stay complete no
 * matter who ships a release. Runs in the daily GitHub Action (needs full
 * history: actions/checkout with fetch-depth: 0).
 *
 * Run: node pipeline/build-changelog.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

// Oldest first, so a version's date is when it first shipped and its notes
// are the last edit made under that version number.
const commits = git('log', '--reverse', '--format=%H|%aI', '--', 'version.json')
  .trim().split('\n').filter(Boolean).map((line) => {
    const [sha, date] = line.split('|');
    return { sha, date };
  });

const byVersion = new Map();
for (const c of commits) {
  let data;
  try { data = JSON.parse(git('show', `${c.sha}:version.json`)); } catch (e) { continue; }
  if (!data || !data.version) continue;
  const notes = Array.isArray(data.notes) ? data.notes : data.notes ? [data.notes] : [];
  const prev = byVersion.get(data.version);
  byVersion.set(data.version, {
    version: data.version,
    title: data.title || `Version ${data.version}`,
    date: prev ? prev.date : c.date,
    notes,
  });
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
};
const entries = [...byVersion.values()].sort((a, b) => cmp(a.version, b.version));

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'changelog.json'), JSON.stringify({ entries }, null, 1));
console.log(`Changelog: ${entries.length} releases (${entries[entries.length - 1]?.version} → ${entries[0]?.version})`);
