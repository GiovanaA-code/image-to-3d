/*
 * core.js - the whole cookie cutter pipeline, with no I/O and no Node APIs.
 *
 * Takes raw RGBA pixels in, gives STL bytes out, so the CLI and the browser
 * app run byte-for-byte the same geometry. The only dependency is clipper-lib,
 * which is UMD and loads in both.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('clipper-lib'));
  else root.CutterCore = factory(root.ClipperLib);
}(typeof self !== 'undefined' ? self : this, function (ClipperLib) {
'use strict';

const S = 1000;   // clipper works in integers; 1 unit = 1 micron

const DEFAULTS = {
  size: 80, tall: 0, wide: 0,          // scale: pick one
  height: 14.5, blade: 1.0,            // blade wall
  base: 3.0, baseh: 2.5,               // foot flange, measured out from the blade face
  edge: 2.0, tip: 0.4,                 // tapered cutting edge
  threshold: 128, seal: 2,             // silhouette extraction
  detail: 0.005, round: 0.8,            // outline cleanup
};

// ---------------------------------------------------------------- silhouette

/** Separable square-window max (dilate) or min (erode). */
function morph(mask, w, h, r, dilate) {
  const pick = dilate ? Math.max : Math.min;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) v = pick(v, mask[y * w + i]);
      tmp[y * w + x] = v;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let v = dilate ? 0 : 1;
      for (let i = Math.max(0, y - r); i <= Math.min(h - 1, y + r); i++) v = pick(v, tmp[i * w + x]);
      out[y * w + x] = v;
    }
  return out;
}

/**
 * Line art (watermark and all) -> a filled mask of the figure.
 * Threshold the dark stroke, seal small gaps in it, then flood fill inward from
 * the border: whatever the flood cannot reach is inside the drawing.
 * Returns { mask, w, h, coverage } on a border-padded grid.
 */
function silhouetteMask(rgba, srcW, srcH, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const pad = 4, w = srcW + pad * 2, h = srcH + pad * 2;

  let ink = new Uint8Array(w * h);
  for (let y = 0; y < srcH; y++)
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      // Transparent pixels are background, not black.
      if (rgba[i + 3] > 32 && lum < o.threshold) ink[(y + pad) * w + (x + pad)] = 1;
    }
  if (o.seal > 0) ink = morph(morph(ink, w, h, o.seal, true), w, h, o.seal, false);

  const outside = new Uint8Array(w * h);
  const stack = [0];
  outside[0] = 1;
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    const step = q => { if (!outside[q] && !ink[q]) { outside[q] = 1; stack.push(q); } };
    if (x > 0) step(p - 1);
    if (x < w - 1) step(p + 1);
    if (y > 0) step(p - w);
    if (y < h - 1) step(p + w);
  }

  const mask = new Uint8Array(w * h);
  let filled = 0;
  for (let p = 0; p < w * h; p++) if (!outside[p]) { mask[p] = 1; filled++; }
  return { mask, w, h, coverage: filled / (w * h) };
}

// -------------------------------------------------------------------- trace

/**
 * Mask -> closed polygons along the pixel boundaries (marching squares).
 * Every edge runs on the integer lattice, so loops chain by exact equality and
 * come out watertight without any tolerance fudging.
 */
function traceMask(mask, w, h) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const edges = new Map();                       // "x,y" -> list of end points
  const add = (ax, ay, bx, by) => {
    const k = ax + ',' + ay;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push([bx, by]);
  };
  // Walk each solid pixel; every side facing a hole becomes a boundary edge,
  // wound so the material stays on one consistent side.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x, y - 1)) add(x, y, x + 1, y);
      if (!solid(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!solid(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!solid(x - 1, y)) add(x, y + 1, x, y);
    }

  const loops = [];
  for (const [startKey, list] of edges) {
    while (list.length) {
      const loop = [];
      let cur = startKey.split(',').map(Number);
      let next = list.pop();
      while (next) {
        loop.push(cur);
        cur = next;
        const k = cur[0] + ',' + cur[1];
        const outs = edges.get(k);
        next = outs && outs.length ? outs.pop() : null;
        if (cur[0] + ',' + cur[1] === startKey) break;
      }
      if (loop.length > 3) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Douglas-Peucker on a closed ring. Unlike Clipper's collinear pruning, this is
 * bounded: no point of the result sits further than eps from the original, so a
 * half-pixel eps thins the staircase by an order of magnitude without ever
 * flattening a real curve into a facet.
 */
function simplify(pts, eps) {
  if (pts.length < 32) return pts;
  const keep = new Uint8Array(pts.length);
  const dist2 = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a[0] + t * dx - p[0], qy = a[1] + t * dy - p[1];
    return qx * qx + qy * qy;
  };
  const e2 = eps * eps;
  const run = (lo, hi) => {                       // iterative: rings get deep
    const stack = [[lo, hi]];
    while (stack.length) {
      const [i, j] = stack.pop();
      if (j <= i + 1) continue;
      let far = -1, best = e2;
      for (let k = i + 1; k < j; k++) {
        const d = dist2(pts[k], pts[i], pts[j]);
        if (d > best) { best = d; far = k; }
      }
      if (far < 0) continue;
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  };
  // Split the ring at two opposite anchors so it can be treated as two chains.
  const mid = pts.length >> 1;
  keep[0] = keep[mid] = 1;
  run(0, mid);
  run(mid, pts.length - 1);
  const out = pts.filter((p, i) => keep[i]);
  return out.length > 3 ? out : pts;
}

/** Drop points that sit on the straight run between their neighbours. */
function dropCollinear(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    if (cross !== 0) out.push(p);
  }
  return out.length > 3 ? out : pts;
}

// ---------------------------------------------------------------- 2D shape

const toClip = cs => cs.map(c => c.map(p => ({ X: Math.round(p[0] * S), Y: Math.round(p[1] * S) })));

function union(paths) {
  const c = new ClipperLib.Clipper(), sol = new ClipperLib.Paths();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  c.Execute(ClipperLib.ClipType.ctUnion, sol,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol;
}

function offset(paths, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.25), sol = new ClipperLib.Paths();
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  co.Execute(sol, delta * S);
  return sol;
}

/**
 * Traced loops -> the final 2D outline, scaled to millimetres and centred.
 * Keeps outer boundaries only (the cutter follows the figure's silhouette, not
 * its interior detail) and rounds off anything the nozzle could not print.
 */
function buildShape(loops, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  let cs = loops.map(dropCollinear);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cs) for (const p of c) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const bw = maxX - minX, bh = maxY - minY;
  const k = o.tall ? o.tall / bh : o.wide ? o.wide / bw : o.size / Math.max(bw, bh);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Pixel rows run downward; flip so the model sits the right way up.
  cs = cs.map(c => c.map(p => [(p[0] - cx) * k, (cy - p[1]) * k]));
  // Thin the pixel staircase to within half a pixel. Everything downstream
  // (four offset passes for the rounding) is superlinear in point count, and
  // half a pixel is far below anything the nozzle resolves.
  cs = cs.map(c => simplify(c, k * 0.5));

  let shape = union(toClip(cs)).filter(p => ClipperLib.Clipper.Orientation(p));
  if (!shape.length) throw new Error('the outline came out empty');
  shape = ClipperLib.Clipper.CleanPolygons(shape, o.detail * S);

  // Shrink-then-grow erases spikes finer than the nozzle, grow-then-shrink
  // erases notches just as fine. Detail that small cannot print, and leaving it
  // in makes the tapered edge self-intersect.
  if (o.round > 0) {
    shape = offset(offset(shape, -o.round), o.round);
    shape = offset(offset(shape, o.round), -o.round);
    if (!shape.length) throw new Error('the artwork is too thin for a cutter at this size');
  }
  // Only now drop surplus points. Cleaning before the rounding would cut across
  // the pixel staircase and flatten real curves into long straight facets;
  // afterwards the curve is already smooth and this just thins the vertices.
  shape = ClipperLib.Clipper.CleanPolygons(shape, o.detail * S);
  return { shape, size: { w: bw * k, h: bh * k } };
}

// ------------------------------------------------------------------- 3D mesh

/** Resample a closed contour to exactly n points, evenly spaced along its length. */
function resample(pts, n) {
  const m = pts.length, seg = [];
  let total = 0;
  for (let i = 0; i < m; i++) {
    const p = pts[i], q = pts[(i + 1) % m];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    seg.push(d); total += d;
  }
  const out = [];
  let i = 0, walked = 0;
  for (let k = 0; k < n; k++) {
    const target = total * k / n;
    while (i < m - 1 && walked + seg[i] < target) { walked += seg[i]; i++; }
    const t = seg[i] > 0 ? (target - walked) / seg[i] : 0;
    const p = pts[i], q = pts[(i + 1) % m];
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

/**
 * Turn the 2D outline into the solid, printed cutting-edge up.
 *
 * Four vertical profiles - inner face, blade outer face, tapered tip, and the
 * foot flange - are resampled onto one shared point count, so every surface is
 * a quad strip with exact vertex correspondence and the solid closes by
 * construction. Polygon triangulation is deliberately avoided: on rings this
 * thin, ear clipping silently drops triangles and leaves the mesh open.
 */
function buildMesh(shape, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const tris = [];
  const tri = (a, b, c) => tris.push(a, b, c);

  const clean = paths => paths.map(r => {
    const pts = r.map(p => [p.X / S, p.Y / S]);
    return pts.filter((p, i) => {
      const q = pts[(i - 1 + pts.length) % pts.length];
      return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9;
    });
  });
  // Sorting by centroid keeps island i of one profile paired with island i of
  // the others when the artwork has several separate pieces.
  const byIsland = paths => clean(paths).sort((a, b) => {
    const c = r => r.reduce((s, p) => [s[0] + p[0] / r.length, s[1] + p[1] / r.length], [0, 0]);
    const ca = c(a), cb = c(b);
    return ca[0] - cb[0] || ca[1] - cb[1];
  });

  const prof = {
    inner:  byIsland(offset(shape, -o.blade / 2)),
    outer:  byIsland(offset(shape, o.blade / 2)),
    tip:    byIsland(offset(shape, o.tip - o.blade / 2)),
    flange: byIsland(offset(shape, o.blade / 2 + o.base)),
  };
  const islands = prof.inner.length;
  for (const name of Object.keys(prof))
    if (prof[name].length !== islands)
      throw new Error('the outline breaks apart when thickened - try a larger size');

  for (let i = 0; i < islands; i++) {
    const n = Math.max(prof.inner[i].length, prof.outer[i].length,
                       prof.tip[i].length, prof.flange[i].length);
    for (const name of Object.keys(prof)) prof[name][i] = resample(prof[name][i], n);
    // Clipper starts each offset contour at its own arbitrary vertex. Left
    // unaligned, the strips connect points that are out of phase and the taper
    // bulges outward instead of drawing in.
    const ref = prof.outer[i][0];
    for (const name of Object.keys(prof)) {
      if (name === 'outer') continue;
      const p = prof[name][i];
      let best = 0, bestD = Infinity;
      for (let k = 0; k < p.length; k++) {
        const d = (p[k][0] - ref[0]) ** 2 + (p[k][1] - ref[1]) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      prof[name][i] = p.slice(best).concat(p.slice(0, best));
    }
  }

  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const loft = (bot, top, z0, z1) => {                 // side surface
    for (let i = 0; i < bot.length; i++) {
      const j = (i + 1) % bot.length;
      const b0 = [bot[i][0], bot[i][1], z0], b1 = [bot[j][0], bot[j][1], z0];
      const t0 = [top[i][0], top[i][1], z1], t1 = [top[j][0], top[j][1], z1];
      if (!same(bot[i], bot[j])) tri(b0, b1, t1);
      if (!same(top[i], top[j])) tri(b0, t1, t0);
    }
  };
  const cap = (out, inn, z, dir) => {                  // flat annulus
    for (let i = 0; i < out.length; i++) {
      const j = (i + 1) % out.length;
      const a = [out[i][0], out[i][1], z], b = [out[j][0], out[j][1], z];
      const c = [inn[j][0], inn[j][1], z], d = [inn[i][0], inn[i][1], z];
      if (dir > 0) { tri(a, b, c); tri(a, c, d); }
      else { tri(a, c, b); tri(a, d, c); }
    }
  };

  const edge = Math.min(o.edge, o.height);
  const straight = o.height - edge;
  if (straight <= o.baseh) throw new Error('the cutting edge overlaps the base flange');

  for (let i = 0; i < islands; i++) {
    const inner = prof.inner[i], outer = prof.outer[i];
    const tip = prof.tip[i], flange = prof.flange[i];
    cap(flange, inner, 0, -1);                 // bottom face
    loft(flange, flange, 0, o.baseh);          // flange outer wall
    cap(flange, outer, o.baseh, 1);            // shelf on top of the flange
    loft(outer, outer, o.baseh, straight);     // straight blade wall
    loft(outer, tip, straight, o.height);      // tapered cutting edge
    cap(tip, inner, o.height, 1);              // the cutting tip itself
    loft(inner, inner, o.height, 0);           // inner wall, normals face inward
  }
  return tris;
}

/** Binary STL. Normals are left at zero; slicers recompute them from winding. */
function toStl(tris, name) {
  const count = tris.length / 3;
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf), bytes = new Uint8Array(buf);
  const header = (name || 'cookie cutter').slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12;
    for (let v = 0; v < 3; v++)
      for (let c = 0; c < 3; c++) { view.setFloat32(o, tris[t * 3 + v][c], true); o += 4; }
    o += 2;
  }
  return bytes;
}

/** rgba pixels -> { stl, size, coverage }: the whole pipeline in one call. */
function generate(rgba, w, h, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const sil = silhouetteMask(rgba, w, h, o);
  if (sil.coverage < 0.005) throw new Error('nothing was detected - the artwork may be too faint');
  if (sil.coverage > 0.97) throw new Error('the outline is not closed - the fill leaked out of it');
  const loops = traceMask(sil.mask, sil.w, sil.h);
  if (!loops.length) throw new Error('no outline found');
  const built = buildShape(loops, o);
  const tris = buildMesh(built.shape, o);
  return { stl: toStl(tris, 'cookie cutter'), size: built.size,
           triangles: tris.length / 3, coverage: sil.coverage, mask: sil };
}

return { DEFAULTS, silhouetteMask, traceMask, buildShape, buildMesh, toStl, generate };
}));
