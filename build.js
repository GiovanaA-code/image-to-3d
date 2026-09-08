#!/usr/bin/env node
/* Copies the shared core and clipper into docs/, so the published page and the
 * CLI can never drift apart. Run before committing a change to lib/core.js. */
const fs = require('fs');
for (const [from, to] of [
  ['lib/core.js', 'docs/core.js'],
  ['node_modules/clipper-lib/clipper.js', 'docs/clipper.js'],
]) {
  fs.copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
