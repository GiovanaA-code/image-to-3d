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
  size: 80, tall: 0, wide: 0,          // scale: pick one, or set tall+wide to stretch freely
  height: 20.0, blade: 1.0,            // blade wall, floor to cutting edge
  base: 3.0, baseh: 5.0,               // foot flange, measured out from the blade face
  edge: 2.0, tip: 0.4,                 // tapered cutting edge
  threshold: 128, saturation: 40,      // ink = darker than this, or more coloured
  bgTol: 0,                            // background = this close to the border colour (0 = auto)
  contrast: 24,                        // an edge this strong stops the fill whatever the colours
  leak: 3,                             // discard background reached through a channel thinner than 2x this
  seal: 2, crop: true,
  detail: 0.005, round: 0.8,           // outline cleanup
  minIsland: 0.05,                     // drop pieces smaller than this share of the biggest
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
 * Trim uniform borders: the black frame around a screenshot, or a plain margin.
 *
 * A frame is fatal without this. The flood fill below starts at the image
 * border, so a frame traps it outside and every pixel within the frame reads as
 * figure. Returns the rectangle to work inside.
 */
function autoCrop(rgba, w, h, tol) {
  tol = tol == null ? 32 : tol;
  let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
  const at = (x, y) => { const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  // A line counts as border only if it is entirely one colour, bar a couple of
  // pixels of compression noise. Anything looser eats the artwork: a row
  // holding just the tip of a star is 99% background, so a 95% rule would trim
  // it away and leave the star cut off flat.
  const uniform = (fixed, from, to, horizontal) => {
    const ref = horizontal ? at(from, fixed) : at(fixed, from);
    const n = to - from + 1;
    let odd = 0;
    const allowed = Math.max(1, Math.floor(n * 0.001));
    for (let v = from; v <= to; v++) {
      const p = horizontal ? at(v, fixed) : at(fixed, v);
      if (Math.abs(p[0] - ref[0]) > tol || Math.abs(p[1] - ref[1]) > tol ||
          Math.abs(p[2] - ref[2]) > tol) { if (++odd > allowed) return false; }
    }
    return true;
  };
  // Never eat more than a third of a side: that would be cropping the artwork.
  const limX = Math.floor(w / 3), limY = Math.floor(h / 3);
  while (y0 < limY && uniform(y0, x0, x1, true)) y0++;
  while (y1 > h - 1 - limY && uniform(y1, x0, x1, true)) y1--;
  while (x0 < limX && uniform(x0, y0, y1, false)) x0++;
  while (x1 > w - 1 - limX && uniform(x1, y0, y1, false)) x1--;
  if (x1 - x0 < 16 || y1 - y0 < 16) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  return { x0, y0, x1, y1 };
}

/**
 * Artwork (watermark and all) -> a filled mask of the figure.
 *
 * Threshold the dark or coloured stroke, seal small gaps in it, then flood fill
 * inward from the border: whatever the flood cannot reach is the figure.
 *
 * Ink alone was enough for line art, but it opens a hole in anything drawn with
 * a pale area - a white pompom, a white beard - which is neither dark nor
 * coloured and so reads as background. The fill pours through that hole and
 * eats the figure from the inside, or splits it in two and the cutter comes out
 * in pieces. So the flood is walled in by three things instead: ink, a colour
 * plainly off the background's own (learned from the ring around the artwork),
 * and any steep edge, which is what separates a white beard from white paper
 * when no colour rule can.
 *
 * Whatever gets through anyway is caught afterwards, by discarding background
 * that could only be reached down a channel narrower than the nozzle prints.
 *
 * Returns { mask, w, h, coverage } on a border-padded grid.
 */
function silhouetteMask(rgba, srcW, srcH, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const box = o.crop === false ? { x0: 0, y0: 0, x1: srcW - 1, y1: srcH - 1 }
                               : autoCrop(rgba, srcW, srcH);
  const cw = box.x1 - box.x0 + 1, ch = box.y1 - box.y0 + 1;
  // Wide enough that the leak cleanup below cannot chew through the frame:
  // autoCrop trims to the figure's bounding box, so this pad is the only
  // guaranteed background there is.
  const pad = Math.max(4, o.leak * 2 + 2), w = cw + pad * 2, h = ch + pad * 2;

  let ink = new Uint8Array(w * h);
  // Colours on the padded grid, so the flood can read a pixel without mapping
  // back into the source every time. The pad is filled with the background
  // colour further down, not with the edge pixel it sits against: autoCrop
  // trims to the figure's bounding box, so the figure touches all four sides
  // and repeating those pixels would wall the flood into disconnected pockets.
  const col = new Uint8Array(w * h * 3);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = ((y + box.y0) * srcW + (x + box.x0)) * 4, q = ((y + pad) * w + x + pad) * 3;
      col[q] = rgba[i]; col[q + 1] = rgba[i + 1]; col[q + 2] = rgba[i + 2];
    }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = ((y + box.y0) * srcW + (x + box.x0)) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const sat = mx ? 255 * (mx - mn) / mx : 0;
      // Dark OR strongly coloured. Luminance alone misses a bright outline - a
      // gold star drawn on white reads at luminance 201, well clear of any
      // sensible dark threshold, and the fill would pour straight through it.
      // Saturation separates them cleanly: paper and pale grey watermarks sit
      // under 30, coloured artwork runs far above it.
      // Transparent pixels are background, not black.
      if (rgba[i + 3] > 32 && (lum < o.threshold || sat > o.saturation))
        ink[(y + pad) * w + (x + pad)] = 1;
    }

  // The background colour, read off the ring just inside the crop. A median
  // rather than a mean: if the figure runs off the edge it contributes some of
  // the ring, and a mean would drag the colour towards it.
  const ring = [];
  for (let x = 0; x < cw; x++) { ring.push(pad * w + x + pad); ring.push((ch - 1 + pad) * w + x + pad); }
  for (let y = 0; y < ch; y++) { ring.push((y + pad) * w + pad); ring.push((y + pad) * w + cw - 1 + pad); }
  const bg = [0, 1, 2].map(k => {
    const v = ring.map(p => col[p * 3 + k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  // Paint the pad with it, giving the flood a clean frame to start from and to
  // travel round the artwork on, whichever sides the figure runs off.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= pad && x < pad + cw && y >= pad && y < pad + ch) continue;
      const q = (y * w + x) * 3;
      col[q] = bg[0]; col[q + 1] = bg[1]; col[q + 2] = bg[2];
    }
  const dev = p => {
    p *= 3;
    const dr = Math.abs(col[p] - bg[0]), dg = Math.abs(col[p + 1] - bg[1]),
          db = Math.abs(col[p + 2] - bg[2]);
    return dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
  };
  // Deliberately loose. A photographed cookie throws a drop shadow that is
  // further off the background than its own white beard is, so no single
  // tolerance can call the shadow background and the beard figure. This one
  // only has to catch a colour that is plainly not the background; the edge
  // test below is what actually finds the figure.
  let tol = o.bgTol;
  if (!(tol > 0)) {
    // How far the ring strays from its own median, ignoring the worst tenth so
    // a figure running off the edge cannot set the tolerance. Flat artwork
    // lands near zero and takes the floor; a vignette gets room to breathe.
    const spread = ring.map(dev).sort((a, b) => a - b)[Math.floor(ring.length * 0.9)];
    tol = Math.min(60, Math.max(12, spread + 8));
  }

  // A white beard on white paper defeats every colour rule: it sits a handful
  // of shades off the background, closer than the vignette the tolerance had
  // to be widened for. What still separates them is the edge itself, so a
  // steep enough gradient stops the fill on its own. Flat background measures
  // near zero here and a soft shadow stays low, while the beard's boundary
  // runs past 100.
  const grad = new Float32Array(w * h);
  const lumAt = p => { p *= 3; return 0.299 * col[p] + 0.587 * col[p + 1] + 0.114 * col[p + 2]; };
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = lumAt(p - w + 1) + 2 * lumAt(p + 1) + lumAt(p + w + 1)
               - lumAt(p - w - 1) - 2 * lumAt(p - 1) - lumAt(p + w - 1);
      const gy = lumAt(p + w - 1) + 2 * lumAt(p + w) + lumAt(p + w + 1)
               - lumAt(p - w - 1) - 2 * lumAt(p - w) - lumAt(p - w + 1);
      grad[p] = Math.sqrt(gx * gx + gy * gy) / 4;
    }

  // The wall the flood cannot cross: ink, an edge, or anything off the
  // background colour. Seal it as one piece rather than sealing the ink alone -
  // a gap in a hand-drawn outline is a gap in the wall however it got there,
  // and closing the ink by itself used to inflate the JPEG's coloured ringing
  // into blobs that walled off clean background and came out as part of the
  // cookie.
  let wall = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++)
    if (ink[p] || dev(p) > tol || grad[p] > o.contrast) wall[p] = 1;
  if (o.seal > 0) wall = morph(morph(wall, w, h, o.seal, true), w, h, o.seal, false);

  const fill = barrier => {
    const seen = new Uint8Array(w * h);
    const stack = [0];
    seen[0] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      const step = q => { if (!seen[q] && !barrier[q]) { seen[q] = 1; stack.push(q); } };
      if (x > 0) step(p - 1);
      if (x < w - 1) step(p + 1);
      if (y > 0) step(p - w);
      if (y < h - 1) step(p + w);
    }
    return seen;
  };
  let outside = fill(wall);

  // Any wall this thin has a hole in it somewhere, and one hole is enough: on a
  // photographed cookie the fill slips through a few pixels where the beard
  // meets the paper and then spreads through the whole beard, which comes back
  // as a cutter in two pieces. So take the background it found, open it, and
  // keep only what still reaches the frame. A channel narrower than the opening
  // is a leak by definition - nothing that thin survives the nozzle either -
  // while the real background around the figure is far wider than that.
  if (o.leak > 0) {
    const open = morph(morph(outside, w, h, o.leak, false), w, h, o.leak, true);
    const barrier = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) barrier[p] = open[p] ? 0 : 1;
    outside = fill(barrier);
  }

  const mask = new Uint8Array(w * h);
  let filled = 0;
  for (let p = 0; p < w * h; p++) if (!outside[p]) { mask[p] = 1; filled++; }
  return { mask, w, h, box: box, coverage: filled / (w * h) };
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
  // Height and width together mean a deliberate stretch: honour both axes even
  // though the figure comes out distorted. Otherwise one number drives both.
  const free = o.tall > 0 && o.wide > 0;
  const kx = free ? o.wide / bw : o.tall ? o.tall / bh : o.wide ? o.wide / bw : o.size / Math.max(bw, bh);
  const ky = free ? o.tall / bh : kx;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Pixel rows run downward; flip so the model sits the right way up.
  cs = cs.map(c => c.map(p => [(p[0] - cx) * kx, (cy - p[1]) * ky]));
  // Thin the pixel staircase to within half a pixel. Everything downstream
  // (four offset passes for the rounding) is superlinear in point count, and
  // half a pixel is far below anything the nozzle resolves.
  cs = cs.map(c => simplify(c, Math.min(kx, ky) * 0.5));

  let shape = union(toClip(cs)).filter(p => ClipperLib.Clipper.Orientation(p));
  if (!shape.length) throw new Error('the outline came out empty');

  // Drop specks: a signature in the corner, a stray mark, a bit of dirt on the
  // scan. They are real closed shapes, so nothing upstream rejects them, and
  // each one would come out as its own little loose cutter.
  const areas = shape.map(p => Math.abs(ClipperLib.Clipper.Area(p)));
  const biggest = Math.max.apply(null, areas);
  shape = shape.filter((p, i) => areas[i] >= biggest * o.minIsland);
  shape = ClipperLib.Clipper.CleanPolygons(shape, o.detail * S);

  // Shrink-then-grow erases spikes finer than the nozzle, grow-then-shrink
  // erases notches just as fine. Detail that small cannot print, and leaving it
  // in makes the tapered edge self-intersect.
  if (o.round > 0) {
    shape = offset(offset(shape, -o.round), o.round);
    shape = offset(offset(shape, o.round), -o.round);
    if (!shape.length) throw new Error('the artwork is too thin for a cutter at this size');
  }
  // Drop specks again. The first pass ran before the rounding and could only
  // see the specks the tracing found; the rounding makes its own, pinching a
  // thin neck - the drooping tip of a hat - off into a crumb of a few square
  // millimetres that would print as a loose fleck beside the cutter.
  {
    const a = shape.map(p => Math.abs(ClipperLib.Clipper.Area(p)));
    const big = Math.max.apply(null, a);
    shape = shape.filter((p, i) => a[i] >= big * o.minIsland);
  }

  // Only now drop surplus points. Cleaning before the rounding would cut across
  // the pixel staircase and flatten real curves into long straight facets;
  // afterwards the curve is already smooth and this just thins the vertices.
  shape = ClipperLib.Clipper.CleanPolygons(shape, o.detail * S);

  // The size asked for has to be the size delivered. Specks that were dropped
  // above, and spikes the rounding shaved off, both sat inside the bounding box
  // the scale was derived from - so measure what is actually left and correct
  // for it. Scaling finished polygons is exact, and far cheaper than rounding
  // a second time.
  let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (const r of shape) for (const p of r) {
    if (p.X < fx0) fx0 = p.X;
    if (p.X > fx1) fx1 = p.X;
    if (p.Y < fy0) fy0 = p.Y;
    if (p.Y > fy1) fy1 = p.Y;
  }
  let fw = (fx1 - fx0) / S, fh = (fy1 - fy0) / S;
  const wantX = free ? o.wide / fw : o.tall ? o.tall / fh : o.wide ? o.wide / fw : o.size / Math.max(fw, fh);
  const wantY = free ? o.tall / fh : wantX;
  if (Math.abs(wantX - 1) > 1e-6 || Math.abs(wantY - 1) > 1e-6) {
    for (const r of shape) for (const p of r) { p.X = Math.round(p.X * wantX); p.Y = Math.round(p.Y * wantY); }
    fw *= wantX; fh *= wantY;
  }
  return { shape, size: { w: fw, h: fh } };
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

/**
 * A finished mask -> { stl, size }: everything downstream of the silhouette.
 *
 * Split out so a mask from somewhere else - a segmentation model in the page,
 * which reads a photograph far better than any threshold can - reaches the
 * exact same outline, rounding and mesh as the built-in fill.
 */
function generateFromMask(mask, w, h, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const loops = traceMask(mask, w, h);
  if (!loops.length) throw new Error('no outline found');
  const built = buildShape(loops, o);
  const tris = buildMesh(built.shape, o);
  return { stl: toStl(tris, 'cookie cutter'), size: built.size, triangles: tris.length / 3 };
}

/** rgba pixels -> { stl, size, coverage }: the whole pipeline in one call. */
function generate(rgba, w, h, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const sil = silhouetteMask(rgba, w, h, o);
  if (sil.coverage < 0.005) throw new Error('nothing was detected - the artwork may be too faint');
  if (sil.coverage > 0.97) throw new Error('the outline is not closed - the fill leaked out of it');
  const r = generateFromMask(sil.mask, sil.w, sil.h, o);
  r.coverage = sil.coverage;
  r.mask = sil;
  return r;
}

return { DEFAULTS, silhouetteMask, traceMask, buildShape, buildMesh, toStl, generate, generateFromMask };
}));
