// Color math: RGB spaces, CIELAB (D65 or D50/Bradford), OKLab. Plain arrays, row-major 3x3.

export const mul = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
export const mmul = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
export function inv(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const xyToXYZ = (x, y) => [x / y, 1, (1 - x - y) / y];

export const WHITES = { D65: xyToXYZ(0.3127, 0.329), D50: xyToXYZ(0.3457, 0.3585) };

function rgbToXyz(prim, white) {
  const P = prim.map(([x, y]) => xyToXYZ(x, y)); // columns
  const Pm = [0, 1, 2].map((r) => P.map((c) => c[r]));
  const S = mul(inv(Pm), white);
  return Pm.map((r) => r.map((v, j) => v * S[j]));
}

// Transfer functions, sign-symmetric so out-of-range values stay continuous.
const srgbEnc = (x) => { const a = Math.abs(x), s = Math.sign(x); return s * (a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055); };
const srgbDec = (x) => { const a = Math.abs(x), s = Math.sign(x); return s * (a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4)); };
const ADOBE_G = 563 / 256;
const gammaEnc = (x) => Math.sign(x) * Math.pow(Math.abs(x), 1 / ADOBE_G);
const gammaDec = (x) => Math.sign(x) * Math.pow(Math.abs(x), ADOBE_G);

export const SPACES = {
  srgb: { key: 'srgb', name: 'sRGB', short: 'sRGB', prim: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], enc: srgbEnc, dec: srgbDec, id: '#eeeeee' },
  p3: { key: 'p3', name: 'Display P3', short: 'P3', prim: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], enc: srgbEnc, dec: srgbDec, id: '#ff9a1f' },
  adobe: { key: 'adobe', name: 'Adobe RGB (1998)', short: 'Adobe', prim: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], enc: gammaEnc, dec: gammaDec, id: '#22c7ff' },
};
export const GAMUT_KEYS = ['srgb', 'p3', 'adobe'];
for (const s of Object.values(SPACES)) {
  s.toXYZ = rgbToXyz(s.prim, WHITES.D65); // linear RGB -> XYZ(D65)
  s.fromXYZ = inv(s.toXYZ);
}

// Bradford D65 -> D50
const BFD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
export function bradford(src, dst) {
  const s = mul(BFD, src), d = mul(BFD, dst);
  return mmul(inv(BFD), mmul([[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]], BFD));
}
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// Lab reference-white state. A: XYZ65 -> XYZ(white), Ainv back.
export const lab = { white: 'D65', W: WHITES.D65, A: I3, Ainv: I3 };
export function setLabWhite(w) {
  lab.white = w;
  lab.W = WHITES[w];
  lab.A = w === 'D65' ? I3 : bradford(WHITES.D65, WHITES[w]);
  lab.Ainv = inv(lab.A);
}

const E = 6 / 29;
const f = (t) => (t > E * E * E ? Math.cbrt(t) : t / (3 * E * E) + 4 / 29);
const finv = (t) => (t > E ? t * t * t : 3 * E * E * (t - 4 / 29));
export function xyzToLab(xyz65) {
  const v = mul(lab.A, xyz65);
  const fx = f(v[0] / lab.W[0]), fy = f(v[1] / lab.W[1]), fz = f(v[2] / lab.W[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToXyz(L) {
  const fy = (L[0] + 16) / 116;
  const v = [lab.W[0] * finv(fy + L[1] / 500), lab.W[1] * finv(fy), lab.W[2] * finv(fy - L[2] / 200)];
  return mul(lab.Ainv, v);
}
export { finv as labFinv };

export const OK1 = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]];
export const OK2 = [[0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099], [0.0259040371, 0.7827717662, -0.808675766]];
export function xyzToOklab(xyz65) {
  const lms = mul(OK1, mul(SPACES.srgb.fromXYZ, xyz65)).map(Math.cbrt);
  return mul(OK2, lms);
}

export const xyzToLin = (key, xyz) => mul(SPACES[key].fromXYZ, xyz);
export const linToXyz = (key, rgb) => mul(SPACES[key].toXYZ, rgb);
export const encode = (key, lin) => lin.map(SPACES[key].enc);
export const decode = (key, rgb) => rgb.map(SPACES[key].dec);
export const inGamutLin = (rgb, eps = 1e-9) => rgb[0] >= -eps && rgb[1] >= -eps && rgb[2] >= -eps && rgb[0] <= 1 + eps && rgb[1] <= 1 + eps && rgb[2] <= 1 + eps;

// Matrix used by shaders: Lab-white XYZ -> linear RGB of `key`.
export const labXyzToLin = (key) => mmul(SPACES[key].fromXYZ, lab.Ainv);

// Display color for a XYZ65 point: encoded RGB in the display space, clipped. Returns [r,g,b,inGamut].
export function displayColor(xyz, dispKey) {
  const l = xyzToLin(dispKey, xyz);
  const ok = inGamutLin(l, 1e-6);
  const e = l.map((v) => SPACES[dispKey].enc(Math.min(1, Math.max(0, v))));
  return [e[0], e[1], e[2], ok];
}
