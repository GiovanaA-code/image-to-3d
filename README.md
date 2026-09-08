# Image to 3D

Turn a drawing into a printable cookie cutter. Drop in line art, pick a size,
download the STL. Everything runs in the browser: no upload, no server, no
account.

## How it works

1. **Silhouette.** The dark stroke is thresholded (so a watermark over the art
   simply disappears), small gaps in it are sealed, then a flood fill runs
   inward from the image border. Whatever the flood cannot reach is the figure.
2. **Trace.** Marching squares over that mask. Every edge sits on the integer
   pixel lattice, so the loops chain by exact equality and come out closed.
   Douglas-Peucker then thins the pixel staircase to within half a pixel.
3. **Outline.** Scale to millimetres, keep outer boundaries only, and round off
   any detail finer than the nozzle - it could not print anyway, and it would
   make the tapered edge self-intersect.
4. **Solid.** Four vertical profiles (inner face, blade outer face, tapered tip,
   foot flange) are resampled onto a shared point count and joined as quad
   strips, so the mesh closes by construction.

## Geometry

Measured off a commercial cutter and matched to it:

| | |
|---|---|
| Blade | 1.0 mm thick, 14.5 mm tall |
| Cutting edge | top 2.0 mm taper down to 0.4 mm |
| Foot flange | 3.0 mm reach, 2.5 mm tall |

Only the **outer** face of the blade slopes in. The inner face is what shapes
the cookie, so it stays dead vertical for the full height and the cookie comes
out at exactly the size shown.

Print with the flange on the bed and the cutting edge up. No supports.

## Development

```
npm install
npm run serve     # http://localhost:8731
node cli.js art.jpg --tall 70 -o cutter.stl
```

`lib/core.js` holds the entire pipeline and has no I/O and no Node APIs, so the
CLI and the web page run identical geometry. `npm run build` copies it into
`web/`; run it before committing a change to the core.

The published page is the contents of `web/`. Pushing to `main` updates it.
