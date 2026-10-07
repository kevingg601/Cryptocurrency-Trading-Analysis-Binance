const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const [staging, archive] = process.argv.slice(2);
if (!staging || !archive) throw new Error('Usage: node scripts/verify-desktop.cjs STAGING APP_ASAR');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let count = 0;
function verify(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { verify(file); continue; }
    const relative = path.relative(staging, file);
    if (hash(fs.readFileSync(file)) !== hash(asar.extractFile(archive, relative))) throw new Error(`Archive mismatch: ${relative}`);
    count++;
  }
}
verify(staging);
console.log(`Verified ${count} packaged files against staging (SHA-256).`);
