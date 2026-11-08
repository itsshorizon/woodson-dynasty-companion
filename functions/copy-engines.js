// Cloud Functions only upload this folder, so copy the shared pure engines
// from the app root into lib/ before every deploy (firebase.json predeploy).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lib = path.join(__dirname, 'lib');
fs.mkdirSync(lib, { recursive: true });
for (const f of ['push-engine.js', 'activity-engine.js']) {
  fs.copyFileSync(path.join(root, f), path.join(lib, f));
}
console.log('Copied engines into functions/lib');
