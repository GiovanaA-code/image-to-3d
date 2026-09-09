#!/usr/bin/env node
/*
 * cli.js - command line front end for lib/core.js.
 * Loads the image, hands raw pixels to the core, writes the STL out.
 * The browser app calls the exact same core, so both produce identical models.
 */
const fs = require('fs');
const { Jimp } = require('jimp');
const core = require('./lib/core');

function parseArgs(argv) {
  const o = Object.assign({}, core.DEFAULTS, { out: null, in: null, maxSide: 1400 });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!(k in o)) throw new Error(`unknown option --${k}`);
      o[k] = parseFloat(argv[++i]);
      if (Number.isNaN(o[k])) throw new Error(`--${k} needs a number`);
    } else o.in = a;
  }
  if (!o.in) {
    console.log(`usage: node cli.js <art.png|jpg> [options]

  --size   N   largest dimension in mm      (default ${core.DEFAULTS.size})
  --tall   N   figure height in mm          (overrides --size)
  --wide   N   figure width in mm           (overrides --size)
               giving both stretches the figure to that exact box
  --height N   total blade height in mm     (default ${core.DEFAULTS.height})
  --blade  N   blade wall thickness in mm   (default ${core.DEFAULTS.blade})
  --base   N   flange reach past the blade  (default ${core.DEFAULTS.base})
  --baseh  N   flange height in mm          (default ${core.DEFAULTS.baseh})
  --edge   N   tapered cutting edge in mm   (default ${core.DEFAULTS.edge})
  --tip    N   wall thickness at the tip    (default ${core.DEFAULTS.tip})
  --threshold N  ink cutoff 0-255           (default ${core.DEFAULTS.threshold})
  --seal   N   gap-closing radius in px     (default ${core.DEFAULTS.seal})
  --detail N   contour simplification in mm (default ${core.DEFAULTS.detail})
  --round  N   smooth detail finer than N mm(default ${core.DEFAULTS.round})
  -o FILE      output STL (default: <input>.stl)`);
    process.exit(1);
  }
  if (!o.out) o.out = o.in.replace(/\.[^.]+$/, '') + '.stl';
  return o;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const img = await Jimp.read(o.in);
  // Big scans cost time in every pass below and add nothing the nozzle can print.
  if (Math.max(img.width, img.height) > o.maxSide) img.scaleToFit({ w: o.maxSide, h: o.maxSide });

  const r = core.generate(img.bitmap.data, img.width, img.height, o);
  fs.writeFileSync(o.out, r.stl);

  console.log(`${o.out}
  cookie     ${r.size.w.toFixed(1)} x ${r.size.h.toFixed(1)} mm
  blade      ${o.blade} mm thick, ${o.height} mm tall, tapering to ${o.tip} mm
  base       ${o.base} mm reach, ${o.baseh} mm tall
  mesh       ${r.triangles} triangles`);
})().catch(e => { console.error('error:', e.message); process.exit(1); });
