#!/usr/bin/env node
/* Copies the shared core and clipper into web/, so the published page and the
 * CLI can never drift apart. Run before committing a change to lib/core.js. */
const fs = require('fs');
for (const [from, to] of [
  ['lib/core.js', 'web/core.js'],
  ['node_modules/clipper-lib/clipper.js', 'web/clipper.js'],
]) {
  fs.copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
