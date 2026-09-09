/*
 * ai-worker.js - the segmentation model, off the main thread.
 *
 * It has to be off it. On a machine without usable WebGPU the model runs on the
 * CPU and takes the better part of a minute, and on the main thread that is a
 * frozen page: the progress bar stops moving, nothing responds, and it reads as
 * a crash rather than as work in progress.
 *
 * Speaks a tiny protocol over postMessage:
 *   in  { url, model, dtype, device }
 *   out { type: 'progress', loaded, total, file }
 *       { type: 'mask', mask, w, h }        one byte per pixel, transferred
 *       { type: 'error', message }
 */
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

let seg = null, loaded = null;

self.onmessage = async e => {
  const { url, model, dtype, device } = e.data;
  try {
    // Changing any of these means a different session, so build a new one.
    const key = model + '|' + dtype + '|' + device;
    if (key !== loaded) {
      if (seg && seg.dispose) await seg.dispose();
      seg = await pipeline('background-removal', model, {
        dtype: dtype,
        device: device,
        progress_callback: p => {
          if (p.status === 'progress' && p.total)
            self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
        },
      });
      loaded = key;
    }
    const out = await seg(url);
    const r = Array.isArray(out) ? out[0] : out;
    // Threshold here rather than shipping the whole cut-out back: the page only
    // ever wants the silhouette, and this is one byte a pixel instead of four.
    const n = r.width * r.height, mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = r.data[i * r.channels + r.channels - 1] > 128 ? 1 : 0;
    self.postMessage({ type: 'mask', mask: mask, w: r.width, h: r.height }, [mask.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
