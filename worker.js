/* geo-dude encode worker — resize + JPEG-encode one image off the main thread.
   Receives an ImageBitmap (transferred, zero-copy), returns compressed bytes. */
'use strict';

const QUALITY_LADDER = [0.92, 0.85, 0.78, 0.70, 0.62, 0.54];

function drawToCanvas(bitmap, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

self.onmessage = async (e) => {
  const { id, bitmap, maxEdge, maxBytes } = e.data;
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const k = long > maxEdge ? maxEdge / long : 1;
    const w = Math.round(bitmap.width * k);
    const h = Math.round(bitmap.height * k);
    const canvas = drawToCanvas(bitmap, w, h);
    bitmap.close();

    let blob = null, quality = null;
    for (const q of QUALITY_LADDER) {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
      quality = q;
      if (blob.size <= maxBytes) break;
    }
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, ok: true, buf, width: w, height: h, quality, resized: k < 1 }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
