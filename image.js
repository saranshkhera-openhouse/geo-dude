/* geo-dude image pipeline — decode any input format, resize, compress, stamp GPS.
   Pure-ish functions: no DOM state, no UI. Consumed by app.js. */
'use strict';

const MAX_EDGE  = 2560;              // long-edge cap in px
const MAX_BYTES = 2.5 * 1024 * 1024; // ~2.5 MB per photo
const QUALITY_LADDER = [0.92, 0.85, 0.78, 0.70, 0.62, 0.54];
const HEIC_CDN = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

/* ---------- coordinate parsing ------------------------------------------- */

/* Parse whatever someone pastes into a { lat, lng } pair, or return
   { error } explaining what was wrong. Accepts:
     28.505615, 77.092740        the Google Maps "copy coordinates" format
     28.505615 77.09274          whitespace separated
     28.505615°N, 77.092740°E    with degree signs and hemisphere letters
     https://maps.google.com/…@28.5056,77.0927,17z      a shared map link
     https://…?q=28.5056,77.0927
   Rejects anything out of range, so a transposed pair (77, 28 in India)
   is caught rather than silently writing a location in the Arabian Sea. */
function parseLatLng(raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'empty' };

  let body = text;

  // A pasted map URL: pull the coordinate pair out of @lat,lng or q=lat,lng.
  const at = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const q  = text.match(/[?&](?:q|ll|center|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (at) body = `${at[1]},${at[2]}`;
  else if (q) body = `${q[1]},${q[2]}`;
  else if (/^https?:\/\//i.test(text)) {
    return { error: "that link doesn't contain coordinates — open the place in " +
                    'Google Maps, right-click the exact spot, and copy the numbers' };
  }

  // Hemisphere letters, if present, decide the sign.
  const letters = body.toUpperCase().match(/[NSEW]/g) || [];
  const nums = body.replace(/[^\d.\-+\s,]/g, ' ')
                   .split(/[\s,]+/)
                   .filter((t) => t !== '' && t !== '-' && t !== '+')
                   .map(Number);

  if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) {
    return { error: 'enter two numbers, like 28.505615, 77.092740' };
  }
  if (nums.length > 2) {
    return { error: 'that looks like more than one coordinate pair' };
  }

  let [lat, lng] = nums;
  if (letters.length === 2) {
    // "77.09E, 28.50N" — letters tell us which number is which.
    if (letters[0] === 'E' || letters[0] === 'W') [lat, lng] = [lng, lat];
    const latLetter = letters.find((c) => c === 'N' || c === 'S');
    const lngLetter = letters.find((c) => c === 'E' || c === 'W');
    lat = Math.abs(lat) * (latLetter === 'S' ? -1 : 1);
    lng = Math.abs(lng) * (lngLetter === 'W' ? -1 : 1);
  }

  if (Math.abs(lat) > 90) {
    return { error: `latitude must be between -90 and 90 (got ${lat})` };
  }
  if (Math.abs(lng) > 180) {
    return { error: `longitude must be between -180 and 180 (got ${lng})` };
  }
  return { lat, lng };
}

/* ---------- GPS / EXIF ---------------------------------------------------- */

/* Decimal degrees -> EXIF rational DMS, e.g. 28.502937 ->
   [[28,1],[30,1],[105493,10000]]. Seconds keep 4 decimal places (~0.003 m). */
function toDMS(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const sec = (minFloat - m) * 60;
  return [[d, 1], [m, 1], [Math.round(sec * 10000), 10000]];
}

/* Return a new JPEG data-URL with GPS tags set to lat/lng.
   All non-GPS metadata in the original is preserved.
   Throws a reader-friendly Error if the JPEG can't be parsed — piexif's own
   messages ("'unpack' error. Mismatch between symbol and string length") mean
   nothing to someone looking at the page. */
function stampGps(dataUrl, lat, lng) {
  try {
    return stampGpsUnsafe(dataUrl, lat, lng);
  } catch (err) {
    console.error('geo-dude: EXIF write failed —', err);
    throw new Error('not a readable JPEG, so it was skipped');
  }
}

function stampGpsUnsafe(dataUrl, lat, lng) {
  let exif;
  try {
    exif = piexif.load(dataUrl);
  } catch (e) {
    // No/unreadable EXIF — start a fresh, otherwise-empty structure.
    exif = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  }
  exif.GPS = exif.GPS || {};
  const G = piexif.GPSIFD;
  exif.GPS[G.GPSVersionID]    = [2, 3, 0, 0];
  exif.GPS[G.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
  exif.GPS[G.GPSLatitude]     = toDMS(lat);
  exif.GPS[G.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
  exif.GPS[G.GPSLongitude]    = toDMS(lng);
  exif.GPS[G.GPSMapDatum]     = 'WGS-84';
  return piexif.insert(piexif.dump(exif), dataUrl);
}

/* ---------- encode worker pool ------------------------------------------- */

/* JPEG encoding is the whole cost of a photo (~500 ms for 12 MP on a phone),
   so run it in workers: off the main thread (no jank) and across cores. */
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
let pool = null;       // { workers, idle, queue, seq, pending } once started
let poolBroken = false;

function supportsWorkerEncode() {
  return typeof Worker !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined'
      && typeof createImageBitmap !== 'undefined';
}

function startPool() {
  if (pool || poolBroken || !supportsWorkerEncode()) return pool;
  try {
    const workers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker('worker.js');
      w.onmessage = (e) => {
        const job = pool.pending.get(e.data.id);
        if (!job) return;
        pool.pending.delete(e.data.id);
        pool.idle.push(w);
        drainQueue();
        e.data.ok ? job.resolve(e.data) : job.reject(new Error(e.data.error));
      };
      w.onerror = () => { poolBroken = true; };
      workers.push(w);
    }
    pool = { workers, idle: [...workers], queue: [], seq: 0, pending: new Map() };
  } catch {
    poolBroken = true;   // CSP or no-worker environment: fall back to main thread
  }
  return pool;
}

function drainQueue() {
  if (!pool) return;
  while (pool.queue.length && pool.idle.length) {
    const w = pool.idle.pop();
    const { msg, transfer, id, resolve, reject } = pool.queue.shift();
    pool.pending.set(id, { resolve, reject });
    try {
      w.postMessage(msg, transfer);
    } catch (err) {
      pool.pending.delete(id);
      pool.idle.push(w);
      reject(err);
    }
  }
}

/* Hand a bitmap to a worker. The bitmap is transferred, so the caller must not
   use or close it afterwards — the worker owns and closes it. */
function encodeInWorker(bitmap) {
  const p = startPool();
  if (!p) return null;
  const id = ++p.seq;
  return new Promise((resolve, reject) => {
    p.queue.push({
      id, resolve, reject,
      msg: { id, bitmap, maxEdge: MAX_EDGE, maxBytes: MAX_BYTES },
      transfer: [bitmap],
    });
    drainQueue();
  });
}

/* ---------- format sniffing ---------------------------------------------- */

/* Extension/MIME are unreliable (iOS often reports HEIC as ""), so read magic
   bytes. Returns 'jpeg' | 'png' | 'heic' | 'webp' | 'gif' | 'unknown'. */
async function sniffFormat(file) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const be32 = (o) => (head[o] << 24 | head[o + 1] << 16 | head[o + 2] << 8 | head[o + 3]) >>> 0;
  const ascii = (o, n) => String.fromCharCode(...head.slice(o, o + n));

  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'jpeg';
  if (be32(0) === 0x89504E47) return 'png';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(4, 4) === 'ftyp') {
    // ISO-BMFF: HEIC/HEIF brands (heic, heix, hevc, mif1, msf1, heim…)
    const brand = ascii(8, 4);
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|miaf)$/.test(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return 'unknown';
}

/* ---------- HEIC ---------------------------------------------------------- */

let heicLoading = null;

/* Load heic2any on first HEIC only — it's ~1.3 MB, so JPEG batches skip it. */
function loadHeicDecoder() {
  if (window.heic2any) return Promise.resolve();
  if (heicLoading) return heicLoading;
  heicLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HEIC_CDN;
    s.onload = () => window.heic2any
      ? resolve()
      : reject(new Error('HEIC decoder loaded but did not initialise'));
    s.onerror = () => reject(new Error('could not load the HEIC decoder (offline?)'));
    document.head.append(s);
  });
  return heicLoading;
}

/* ---------- decode ------------------------------------------------------- */

/* Any supported input -> ImageBitmap. Caller must .close() it. */
async function decodeToBitmap(file, format) {
  if (format === 'heic') {
    await loadHeicDecoder();
    // heic2any returns a Blob (or array of them for multi-image HEICs).
    let out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.94 });
    if (Array.isArray(out)) out = out[0];
    return createImageBitmap(out);
  }
  // JPEG/PNG/WebP/GIF: the browser decodes natively and off the main thread.
  return createImageBitmap(file);
}

/* ---------- resize + encode ---------------------------------------------- */

function targetSize(w, h) {
  const long = Math.max(w, h);
  if (long <= MAX_EDGE) return { w, h, resized: false };
  const k = MAX_EDGE / long;
  return { w: Math.round(w * k), h: Math.round(h * k), resized: true };
}

function drawToCanvas(bitmap, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Flatten any transparency (PNG) onto white rather than black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

const canvasToBlob = (canvas, quality) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => b ? resolve(b) : reject(new Error('JPEG encoding failed')),
                'image/jpeg', quality));

/* Encode at the highest quality on the ladder that fits under MAX_BYTES.
   Returns the smallest attempt if even the floor is too big. */
async function encodeUnderCap(canvas) {
  let last = null;
  for (const q of QUALITY_LADDER) {
    const blob = await canvasToBlob(canvas, q);
    last = { blob, quality: q };
    if (blob.size <= MAX_BYTES) return last;
  }
  return last;
}

/* ---------- the pipeline -------------------------------------------------- */

/* Turn one picked file into a GPS-stamped JPEG under the size cap.
   `onStage(label)` reports progress for slow steps (HEIC decode).
   Returns { bytes, name, format, wasConverted, wasResized, wasRecompressed,
             quality, width, height, inBytes, outBytes }. */
async function processPhoto(file, lat, lng, onStage) {
  const format = await sniffFormat(file);
  if (format === 'gif' || format === 'unknown') {
    throw new Error(`unsupported format${format === 'gif' ? ' (GIF)' : ''}`);
  }

  const passthroughCandidate = format === 'jpeg' && file.size <= MAX_BYTES;

  // Fast path: a JPEG already under the cap only needs EXIF — never re-encode,
  // so its pixels and all its other metadata survive untouched.
  if (passthroughCandidate) {
    const dataUrl = await blobToDataURL(file);
    const dims = await peekDims(file);
    if (!dims || Math.max(dims.w, dims.h) <= MAX_EDGE) {
      return {
        bytes: dataUrlToBytes(stampGps(dataUrl, lat, lng)),
        name: toJpegName(file.name),
        format, wasConverted: false, wasResized: false, wasRecompressed: false,
        quality: null, width: dims ? dims.w : null, height: dims ? dims.h : null,
        inBytes: file.size, outBytes: null,
      };
    }
  }

  if (format === 'heic' && onStage) onStage('converting HEIC');
  const bitmap = await decodeToBitmap(file, format);

  // Preferred path: encode in a worker (off-thread, parallel across cores).
  const job = encodeInWorker(bitmap);
  if (job) {
    let r;
    try {
      r = await job;             // the worker owns and closes the bitmap
    } catch (err) {
      poolBroken = true;         // fall back for the rest of this batch
      throw err;
    }
    const blob = new Blob([r.buf], { type: 'image/jpeg' });
    const stamped = stampGps(await blobToDataURL(blob), lat, lng);
    return {
      bytes: dataUrlToBytes(stamped),
      name: toJpegName(file.name),
      format,
      wasConverted: format !== 'jpeg',
      wasResized: r.resized,
      wasRecompressed: true,
      quality: r.quality, width: r.width, height: r.height,
      inBytes: file.size, outBytes: blob.size,
    };
  }

  // Fallback: no Worker/OffscreenCanvas (older Safari) — encode inline.
  try {
    const { w, h, resized } = targetSize(bitmap.width, bitmap.height);
    const canvas = drawToCanvas(bitmap, w, h);
    const { blob, quality } = await encodeUnderCap(canvas);
    canvas.width = canvas.height = 0;   // free the backing store promptly

    const stamped = stampGps(await blobToDataURL(blob), lat, lng);
    return {
      bytes: dataUrlToBytes(stamped),
      name: toJpegName(file.name),
      format,
      wasConverted: format !== 'jpeg',
      wasResized: resized,
      wasRecompressed: true,
      quality, width: w, height: h,
      inBytes: file.size, outBytes: blob.size,
    };
  } finally {
    bitmap.close();
  }
}

/* ---------- small shared helpers ----------------------------------------- */

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(new Error('could not read the file'));
  r.readAsDataURL(blob);
});

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Read a JPEG's SOF dimensions without decoding pixels, so the passthrough
   path can check the resolution cap cheaply. Null if not determinable. */
async function peekDims(file) {
  const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
    if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
    }
    if (m === 0xDA) break;
    i += 2 + len;
  }
  return null;
}

/* Output is always JPEG, so give converted files a .jpg name. */
function toJpegName(name) {
  return /\.jpe?g$/i.test(name) ? name : name.replace(/\.[^.\/\\]*$/, '') + '.jpg';
}

/* ---------- thumbnails --------------------------------------------------- */

/* Small preview as a data URL. Decoding a 12 MP file into a 200 px canvas and
   discarding the bitmap keeps peak memory flat across a big batch — the old
   <img src=blobURL> kept every full-size image decoded. */
async function makeThumb(file, format, edge = 220) {
  let bitmap;
  try {
    bitmap = await decodeToBitmap(file, format);
  } catch {
    return null;   // unreadable: the grid shows a neutral tile
  }
  try {
    const k = edge / Math.max(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * Math.min(k, 1)));
    const h = Math.max(1, Math.round(bitmap.height * Math.min(k, 1)));
    const canvas = drawToCanvas(bitmap, w, h);
    const blob = await canvasToBlob(canvas, 0.72);
    canvas.width = canvas.height = 0;
    return URL.createObjectURL(blob);
  } finally {
    bitmap.close();
  }
}

window.GeoImage = {
  sniffFormat, processPhoto, makeThumb, toJpegName,
  stampGps, toDMS, dataUrlToBytes, parseLatLng,
  MAX_EDGE, MAX_BYTES, POOL_SIZE,
  usingWorkers: () => !!pool && !poolBroken,
};
