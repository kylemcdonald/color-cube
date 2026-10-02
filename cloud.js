// Image loading for the point cloud: raw code values (no browser color management) and a guess at their space.
import * as C from './colormath.js';

const MAX_PIXELS = 4e6;

// Browsers convert tagged images to sRGB when drawing them to a canvas, clipping anything wider. Removing the color
// tags first makes the file untagged, which is drawn into an sRGB canvas unchanged.
const PNG_DROP = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP']);
async function stripPNG(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset), parts = [buf.subarray(0, 8)];
  let icc = null, hint = null;
  for (let o = 8; o + 8 <= buf.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(...buf.subarray(o + 4, o + 8)), end = o + 12 + len;
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'iCCP') {
      const z = data.indexOf(0) + 2;
      try { icc = new Uint8Array(await new Response(new Blob([data.subarray(z)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()); } catch {}
    } else if (type === 'sRGB') hint = { space: 'srgb', how: 'PNG sRGB chunk' };
    else if (type === 'cICP') {
      const g = { 1: 'srgb', 12: 'p3' }[data[0]];
      if (g && data[1] === 13) hint = { space: g, how: 'PNG cICP chunk' };
    }
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(o, end));
    o = end;
  }
  return { bytes: concat(parts), icc, hint };
}
function stripJPEG(buf) {
  const parts = [buf.subarray(0, 2)], icc = [];
  let o = 2;
  while (o + 4 <= buf.length && buf[o] === 0xff) {
    const m = buf[o + 1];
    if (m === 0xda || m === 0xd9) break; // image data follows
    const end = o + 2 + ((buf[o + 2] << 8) | buf[o + 3]);
    const seg = buf.subarray(o, end);
    if (m === 0xe2 && String.fromCharCode(...seg.subarray(4, 16)) === 'ICC_PROFILE\0') icc.push([seg[16], seg.subarray(18)]);
    else parts.push(seg);
    o = end;
  }
  parts.push(buf.subarray(o));
  return { bytes: concat(parts), icc: icc.length ? concat(icc.sort((a, b) => a[0] - b[0]).map((x) => x[1])) : null };
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ICC: compare the D50-adapted colorant matrix with each known space, then fall back to the description text.
function iccTags(icc) {
  const dv = new DataView(icc.buffer, icc.byteOffset), tags = {};
  const n = dv.getUint32(128);
  for (let i = 0; i < n; i++) {
    const o = 132 + 12 * i;
    tags[String.fromCharCode(...icc.subarray(o, o + 4))] = [dv.getUint32(o + 4), dv.getUint32(o + 8)];
  }
  return { dv, tags };
}
function iccDesc(icc) {
  try {
    const { dv, tags } = iccTags(icc), t = tags.desc; if (!t) return '';
    const type = String.fromCharCode(...icc.subarray(t[0], t[0] + 4));
    if (type === 'desc') return String.fromCharCode(...icc.subarray(t[0] + 12, t[0] + 12 + dv.getUint32(t[0] + 8) - 1));
    if (type === 'mluc') {
      const len = dv.getUint32(t[0] + 20), off = t[0] + dv.getUint32(t[0] + 24);
      let s = ''; for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(off + i));
      return s;
    }
  } catch {}
  return '';
}
function iccColorants(icc) {
  try {
    const { dv, tags } = iccTags(icc);
    const col = (sig) => { const o = tags[sig][0] + 8; return [0, 1, 2].map((k) => dv.getInt32(o + 4 * k) / 65536); };
    const cs = ['rXYZ', 'gXYZ', 'bXYZ'].map(col);
    return [0, 1, 2].map((r) => cs.map((c) => c[r]));
  } catch { return null; }
}
const D50A = C.bradford(C.WHITES.D65, C.WHITES.D50);
function detect(icc, hint) {
  if (icc) {
    const desc = iccDesc(icc), m = iccColorants(icc);
    if (m) for (const g of C.GAMUT_KEYS) {
      const ref = C.mmul(D50A, C.SPACES[g].toXYZ);
      if (ref.every((row, i) => row.every((v, j) => Math.abs(v - m[i][j]) < 0.006))) return { space: g, how: `ICC “${desc}”` };
    }
    const re = [[/adobe\s*rgb|adobergb|compatible with adobe/i, 'adobe'], [/p3/i, 'p3'], [/srgb|iec\s*61966/i, 'srgb']].find(([r]) => r.test(desc));
    if (re) return { space: re[1], how: `ICC “${desc}” (by name)` };
    return { space: null, how: `unrecognized ICC “${desc}”` };
  }
  return hint || { space: null, how: 'untagged' };
}

// -> { name, w, h, n (pixels used), keys (unique 0xRRGGBB, sorted), counts, space, how }
export async function readImage(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bytes = buf, icc = null, hint = null;
  if (buf[0] === 0x89 && buf[1] === 0x50) ({ bytes, icc, hint } = await stripPNG(buf));
  else if (buf[0] === 0xff && buf[1] === 0xd8) ({ bytes, icc } = stripJPEG(buf));
  const bmp = await createImageBitmap(new Blob([bytes], { type: file.type }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width: w, height: h } = bmp, cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0); bmp.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  // Stride-sample very large images (sampling, unlike resizing, never invents colors).
  const step = Math.max(1, Math.ceil(w * h / MAX_PIXELS));
  const keys = new Uint32Array(Math.ceil(w * h / step));
  let n = 0;
  for (let i = 0; i < w * h; i += step) {
    const o = 4 * i;
    if (px[o + 3] >= 128) keys[n++] = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
  }
  const sorted = keys.subarray(0, n).sort(), uk = [], uc = [];
  for (let i = 0; i < n;) {
    let j = i; while (j < n && sorted[j] === sorted[i]) j++;
    uk.push(sorted[i]); uc.push(j - i); i = j;
  }
  return { name: file.name, w, h, n, step, keys: Uint32Array.from(uk), counts: Float32Array.from(uc), ...detect(icc, hint) };
}
