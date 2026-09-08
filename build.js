#!/usr/bin/env node
/*
 * Copies the shared core and clipper into docs/, then stamps each script tag in
 * docs/index.html with a hash of the file it points at.
 *
 * The stamp is what makes updates actually reach people. Without it the browser
 * keeps serving the core.js it cached on the visitor's first visit, so a push
 * changes the site for nobody. index.html itself revalidates on every load, and
 * a changed hash in the URL forces a fresh fetch of the script.
 *
 * Run before committing any change under lib/.
 */
const fs = require('fs');
const crypto = require('crypto');

const copies = [
  ['lib/core.js', 'docs/core.js'],
  ['node_modules/clipper-lib/clipper.js', 'docs/clipper.js'],
];

const stamp = {};
for (const [from, to] of copies) {
  const data = fs.readFileSync(from);
  fs.writeFileSync(to, data);
  const name = to.replace(/^docs\//, '');
  stamp[name] = crypto.createHash('sha256').update(data).digest('hex').slice(0, 10);
  console.log(`${from} -> ${to}  (${stamp[name]})`);
}

const page = 'docs/index.html';
let html = fs.readFileSync(page, 'utf8');
for (const [name, hash] of Object.entries(stamp)) {
  const re = new RegExp(`(<script src=")${name}(\\?v=[0-9a-f]+)?(")`);
  if (!re.test(html)) throw new Error(`no <script src="${name}"> in ${page}`);
  html = html.replace(re, `$1${name}?v=${hash}$3`);
}
fs.writeFileSync(page, html);
console.log(`${page} stamped`);
