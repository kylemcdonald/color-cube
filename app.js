import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import * as C from './colormath.js';
import { readImage } from './cloud.js';

// All colors are computed by hand already encoded for the display; three must not convert them.
THREE.ColorManagement.enabled = false;

const $ = (s) => document.querySelector(s);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const GK = C.GAMUT_KEYS;
const BOX_ID = '#ff3ddc';
const ID = { srgb: C.SPACES.srgb.id, p3: C.SPACES.p3.id, adobe: C.SPACES.adobe.id, box: BOX_ID };
const NAME = { srgb: 'sRGB', p3: 'Display P3', adobe: 'Adobe RGB', box: 'Lab box' };

// ---------------------------------------------------------------- state
const P3_OK = window.matchMedia?.('(color-gamut: p3)').matches;
const DEFAULTS = {
  k: 1, base: 128, white: 'D65', view: 'lab', ortho: false, axes: true, bg: 'dark',
  layers: {
    srgb: { edges: true, faces: false, labels: true },
    p3: { edges: true, faces: false, labels: true },
    adobe: { edges: true, faces: false, labels: true },
    box: { edges: true, faces: false, labels: true },
  },
  faceOp: 0.3, sliceOp: 0.8, showL: true, showH: false, showS: false, L: 50, hue: 135, sMode: 'sat', sat: 1, chroma: 60,
  disp: P3_OK ? 'p3' : 'srgb', oog: 'hatch', ref: 'disp',
  cloudOn: true, cloudAlpha: -0.6, cloudSpace: 'auto',
};
let state = structuredClone(DEFAULTS);
try {
  const s = JSON.parse(localStorage.getItem('labbox-state') || 'null');
  if (s) state = { ...state, ...s, layers: { ...state.layers, ...(s.layers || {}) } };
} catch {}
const save = () => { try { localStorage.setItem('labbox-state', JSON.stringify(state)); } catch {} };
const A = () => state.k * state.base;
C.setLabWhite(state.white);

// ---------------------------------------------------------------- view spaces
const S6 = Math.sqrt(6), S2 = Math.SQRT2, S3 = Math.sqrt(3);
// Stand RGB cubes on the black corner, red toward +x, yellow toward -z, matching CIELAB's hue layout.
function rgbScene(p) {
  const q = [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5];
  return [(2 * q[0] - q[1] - q[2]) / S6 / S3, (q[0] + q[1] + q[2]) / 3, (q[2] - q[1]) / S2 / S3];
}
const VIEWS = {
  lab: { name: 'CIELAB  (L*, a*, b*)', map: (x, l) => [l[1] / 100, (l[0] - 50) / 100, -l[2] / 100], grid: () => labGrid(false) },
  labn: { name: 'CIELAB, a*b* ÷ box (box is a cube)', map: (x, l) => [l[1] / A() * 0.5, (l[0] - 50) / 100, -l[2] / A() * 0.5], grid: () => labGrid(true) },
  oklab: { name: 'OKLab', map: (x) => { const o = C.xyzToOklab(x); return [o[1] * 3, o[0] - 0.5, -o[2] * 3]; }, grid: oklabGrid },
  xyz: { name: 'CIE XYZ (D65, linear)', map: (x) => [x[0] - 0.5, x[1] - 0.5, x[2] - 0.5], grid: xyzGrid },
};
for (const g of GK) {
  VIEWS[g + '_enc'] = { name: `${C.SPACES[g].name}, encoded R′G′B′`, map: (x) => rgbScene(C.encode(g, C.xyzToLin(g, x))), grid: () => rgbGrid(g) };
  VIEWS[g + '_lin'] = { name: `${C.SPACES[g].name}, linear RGB`, map: (x) => rgbScene(C.xyzToLin(g, x)), grid: () => rgbGrid(g) };
}
const toScene = (pt) => VIEWS[state.view].map(pt.xyz, pt.lab);
const labPt = (lab) => ({ lab, xyz: C.labToXyz(lab) });

// ---------------------------------------------------------------- cube parametrization
const corner = (i) => [i & 1 ? 1 : 0, i & 2 ? 1 : 0, i & 4 ? 1 : 0];
const CUBE_EDGES = [];
for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) if (!(i & (1 << b))) CUBE_EDGES.push([i, i | (1 << b)]);

function paramPoint(key, p) {
  if (key === 'box') return labPt([p[0] * 100, (2 * p[1] - 1) * A(), (2 * p[2] - 1) * A()]);
  const xyz = C.linToXyz(key, C.decode(key, p));
  return { xyz, lab: C.xyzToLab(xyz) };
}

// ---------------------------------------------------------------- renderer / scene
const viewEl = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(DPR());
viewEl.prepend(renderer.domElement);
const gl = renderer.getContext();
const GL_P3 = 'drawingBufferColorSpace' in gl;

const labelRenderer = new CSS2DRenderer({ element: $('#labels') });
const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(32, 1, 0.2, 60);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
let camera = state.ortho ? orthoCam : persp;
persp.position.set(2.9, 1.8, 3.6);
let controls = makeControls();
function makeControls(target) {
  const c = new OrbitControls(camera, renderer.domElement);
  c.enableDamping = true; c.dampingFactor = 0.12;
  if (target) c.target.copy(target);
  return c;
}
function syncOrtho() {
  const d = persp.position.distanceTo(controls.target);
  const h = d * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
  const asp = persp.aspect;
  Object.assign(orthoCam, { left: -h * asp, right: h * asp, top: h, bottom: -h, zoom: 1 });
  orthoCam.position.copy(persp.position); orthoCam.quaternion.copy(persp.quaternion);
  orthoCam.updateProjectionMatrix();
}
function setOrtho(on) {
  const t = controls.target.clone();
  if (on && camera === persp) { syncOrtho(); camera = orthoCam; }
  else if (!on && camera === orthoCam) {
    const dir = orthoCam.position.clone().sub(t).normalize();
    const dist = persp.position.distanceTo(t) / orthoCam.zoom;
    persp.position.copy(t).addScaledVector(dir, dist); camera = persp;
  }
  controls.dispose(); controls = makeControls(t);
}
function camPreset(kind) {
  const t = new THREE.Vector3(0, 0, 0);
  const dist = 6.3;
  const dir = { iso: [1.75, 1.05, 2.15], top: [0, 1, 1e-4], front: [0, 0, 1], side: [1, 0, 0] }[kind];
  const v = new THREE.Vector3(...dir).normalize().multiplyScalar(dist);
  for (const cam of [persp, orthoCam]) { cam.position.copy(v); cam.up.set(0, 1, 0); cam.lookAt(t); }
  orthoCam.zoom = 1; if (camera === orthoCam) syncOrtho();
  controls.target.copy(t); controls.update();
}
$('#camBtns').addEventListener('click', (e) => {
  const kind = e.target.dataset.cam; if (!kind) return;
  // axis-aligned views read best without perspective
  if (state.ortho !== (kind !== 'iso')) { state.ortho = kind !== 'iso'; save(); $('#ortho').checked = state.ortho; setOrtho(state.ortho); }
  camPreset(kind);
});

// ---------------------------------------------------------------- shared surface shader
const mat3 = (m) => new THREE.Matrix3().set(...m[0], ...m[1], ...m[2]);
const U = {
  uM0: { value: new THREE.Matrix3() }, uM1: { value: new THREE.Matrix3() }, uM2: { value: new THREE.Matrix3() }, uMD: { value: new THREE.Matrix3() },
  uW: { value: new THREE.Vector3() }, uA: { value: 128 }, uRef: { value: 3 }, uOog: { value: 1 }, uDpr: { value: 1 },
  uC0: { value: new THREE.Color(ID.srgb) }, uC1: { value: new THREE.Color(ID.p3) }, uC2: { value: new THREE.Color(ID.adobe) }, uC3: { value: new THREE.Color(BOX_ID) },
  uView: { value: 0 }, uVM: { value: new THREE.Matrix3() }, uVO: { value: new THREE.Vector3() }, uDec: { value: 0 }, uVX: { value: new THREE.Matrix3() }, uViewG: { value: -1 }, uDispG: { value: 0 },
};
// Fragments recover their color from the interpolated scene position (inverting the view map) rather than from an
// interpolated Lab attribute, so gamut tests agree with the drawn geometry: in an RGB view, that space's gamut
// boundary is a flat cube face and the cut lands exactly on it.
const VERT = /* glsl */`
  varying vec3 vPos;
  void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */`
  varying vec3 vPos;
  uniform mat3 uM0, uM1, uM2, uMD, uVM, uVX; uniform vec3 uW, uVO; uniform float uA, uOpacity, uDpr;
  uniform int uRef, uOog, uOutBox, uView, uDec, uViewG, uDispG; uniform vec4 uMask; uniform vec3 uC0, uC1, uC2, uC3;
  float finv(float t) { const float e = 6.0 / 29.0; return t > e ? t * t * t : 3.0 * e * e * (t - 4.0 / 29.0); }
  float fwd(float t) { const float e = 6.0 / 29.0; return t > e * e * e ? pow(t, 1.0 / 3.0) : t / (3.0 * e * e) + 4.0 / 29.0; }
  float dec(float x) {
    float a = abs(x);
    a = uDec == 1 ? (a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4)) : uDec == 2 ? pow(a, 563.0 / 256.0) : uDec == 3 ? a * a * a : a;
    return sign(x) * a;
  }
  float finvp(float t) { const float e = 6.0 / 29.0; return t > e ? 3.0 * t * t : 3.0 * e * e; }
  float fwdp(float t) { const float e = 6.0 / 29.0; return t > e * e * e ? pow(t, -2.0 / 3.0) / 3.0 : 1.0 / (3.0 * e * e); }
  float decp(float x) {
    float a = abs(x);
    return uDec == 1 ? (a <= 0.04045 ? 1.0 / 12.92 : 2.4 / 1.055 * pow((a + 0.055) / 1.055, 1.4)) : uDec == 2 ? 563.0 / 256.0 * pow(a, 563.0 / 256.0 - 1.0) : uDec == 3 ? 3.0 * a * a : 1.0;
  }
  float enc(float x) { x = clamp(x, 0.0, 1.0); return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
  mat3 diag(vec3 v) { return mat3(v.x, 0.0, 0.0, 0.0, v.y, 0.0, 0.0, 0.0, v.z); }
  // Contour widths use |s| / |grad s| with grad s from the chain rule, not fwidth(s): finite differences of a
  // strongly curved s (linear light near black in an encoded view) are noise, while the position is affine.
  vec3 dx, dy;
  float pxDist(float s, vec3 g) { return abs(s) / max(length(vec2(dot(g, dx), dot(g, dy))), 1e-20); }
  // Signed distance of c to the unit cube, and that distance in pixels given D = dc/dposition.
  float sdg(vec3 c, mat3 D, out float px) {
    float s = 1e9; vec3 g = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      vec3 r = vec3(D[0][i], D[1][i], D[2][i]);
      if (c[i] < s) { s = c[i]; g = r; }
      if (1.0 - c[i] < s) { s = 1.0 - c[i]; g = r; }
    }
    px = pxDist(s, g);
    return s;
  }
  float lmask(float px, float w) { return 1.0 - smoothstep(w - 0.6, w + 0.6, px); }
  void main() {
    dx = dFdx(vPos); dy = dFdy(vPos);
    vec3 t = uVM * vPos + uVO, vLab, xyz;
    mat3 J, JL; // d XYZ / d position, d Lab / d position
    if (uView == 0) {
      vLab = t;
      float fy = (t.x + 16.0) / 116.0;
      vec3 f = vec3(fy + t.y / 500.0, fy, fy - t.z / 200.0);
      xyz = uW * vec3(finv(f.x), finv(f.y), finv(f.z));
      JL = uVM;
      J = diag(uW * vec3(finvp(f.x), finvp(f.y), finvp(f.z))) * mat3(vec3(1.0 / 116.0), vec3(1.0 / 500.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0 / 200.0)) * uVM;
    } else {
      xyz = uVX * vec3(dec(t.x), dec(t.y), dec(t.z));
      vec3 q = xyz / uW, f = vec3(fwd(q.x), fwd(q.y), fwd(q.z)), fp = vec3(fwdp(q.x), fwdp(q.y), fwdp(q.z)) / uW;
      vLab = vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
      J = uVX * diag(vec3(decp(t.x), decp(t.y), decp(t.z))) * uVM;
      JL = mat3(vec3(0.0, 500.0 * fp.x, 0.0), vec3(116.0 * fp.y, -500.0 * fp.y, 200.0 * fp.y), vec3(0.0, 0.0, -200.0 * fp.z)) * J;
    }
    vec3 d = uMD * xyz;
    float p0, p1, p2, pd, pv, pb;
    float s0 = sdg(uM0 * xyz, uM0 * J, p0), s1 = sdg(uM1 * xyz, uM1 * J, p1), s2 = sdg(uM2 * xyz, uM2 * J, p2), sdisp = sdg(d, uMD * J, pd);
    // An RGB view's own gamut is measured in its own coordinates: affine in position, so exact even near black.
    float sv = sdg(t, uVM, pv);
    if (uViewG == 0) { s0 = sv; p0 = pv; } else if (uViewG == 1) { s1 = sv; p1 = pv; } else if (uViewG == 2) { s2 = sv; p2 = pv; }
    if (uViewG == uDispG) { sdisp = sv; pd = pv; }
    float sa = uA - abs(vLab.y), sbb = uA - abs(vLab.z), sb = min(sa, sbb);
    int bi = sa < sbb ? 1 : 2;
    pb = pxDist(sb, vec3(JL[0][bi], JL[1][bi], JL[2][bi]));
    float sout = uOutBox == 1 ? sb : uRef == 0 ? s0 : uRef == 1 ? s1 : uRef == 2 ? s2 : uRef == 3 ? sdisp : 1.0;
    float pout = uOutBox == 1 ? pb : uRef == 0 ? p0 : uRef == 1 ? p1 : uRef == 2 ? p2 : pd;
    vec3 col = vec3(enc(d.r), enc(d.g), enc(d.b));
    float alpha = uOpacity;
    if (sout < 0.0) {
      // Cut-away meshes are already clipped on the CPU; this only trims where flat facets overshoot by over a pixel.
      if (uOog == 3 && pout > 1.0) discard;
      if (uOog == 1) { float st = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / (7.0 * uDpr))); col = mix(col, vec3(0.42), 0.25 + 0.6 * st); }
      else if (uOog == 2) { col = vec3(0.3 + 0.25 * dot(col, vec3(0.3, 0.55, 0.15))); }
    }
    float w = 0.9 * uDpr, hw = 2.0 * uDpr;
    vec4 PX = vec4(p0, p1, p2, pb);
    vec3 CC[4]; CC[0] = uC0; CC[1] = uC1; CC[2] = uC2; CC[3] = uC3;
    for (int i = 0; i < 4; i++) {
      if (uMask[i] < 0.5) continue;
      float h = lmask(PX[i], hw), m = lmask(PX[i], w);
      col = mix(col, vec3(0.04), 0.85 * h); col = mix(col, CC[i], m);
      alpha = max(alpha, h);
    }
    gl_FragColor = vec4(col, alpha);
  }`;
function surfMat(mask, outBox) {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, uMask: { value: new THREE.Vector4(...mask) }, uOutBox: { value: outBox ? 1 : 0 }, uOpacity: { value: 0.3 } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
}

// ---------------------------------------------------------------- materials (persistent)
const lineMats = [];
function lineMat(opts) { const m = new LineMaterial(opts); lineMats.push(m); return m; }
const OBJ = {};
for (const key of [...GK, 'box']) {
  const isBox = key === 'box';
  OBJ[key] = {
    casing: lineMat({ color: new THREE.Color(ID[key]), linewidth: isBox ? 7 : 6.5, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 16 }),
    core: lineMat({ vertexColors: true, linewidth: isBox ? 3 : 2.6, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -16 }),
    face: isBox ? surfMat([1, 1, 1, 0], false) : surfMat([0, 0, 0, 1], true),
  };
}
const sliceMat = { L: surfMat([1, 1, 1, 1], false), H: surfMat([1, 1, 1, 1], false), S: surfMat([1, 1, 1, 1], false) };
const gridMat = new THREE.LineBasicMaterial({ color: 0x4a4a50 });

// Inverse of the current view map: t = M·p + O, then either Lab = t, or Lab-white XYZ = X·dec(t).
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RGB_SCENE_INV = C.inv([[2 / S6 / S3, -1 / S6 / S3, -1 / S6 / S3], [1 / 3, 1 / 3, 1 / 3], [0, -1 / S2 / S3, 1 / S2 / S3]]);
function viewInverse() {
  const v = state.view;
  if (v === 'lab' || v === 'labn') { const s = v === 'lab' ? 100 : 2 * A(); return { lab: true, M: [[0, 100, 0], [s, 0, 0], [0, 0, -s]], O: [50, 0, 0] }; }
  if (v === 'xyz') return { M: I3, O: [0.5, 0.5, 0.5], X: C.lab.A };
  if (v === 'oklab') {
    const K = C.inv(C.OK2);
    return { M: C.mmul(K, [[0, 1, 0], [1 / 3, 0, 0], [0, 0, -1 / 3]]), O: C.mul(K, [0.5, 0, 0]), dec: 3, X: C.mmul(C.lab.A, C.mmul(C.SPACES.srgb.toXYZ, C.inv(C.OK1))) };
  }
  const [g, kind] = v.split('_');
  return { g, M: RGB_SCENE_INV, O: [0.5, 0.5, 0.5], dec: kind === 'enc' ? (g === 'adobe' ? 2 : 1) : 0, X: C.mmul(C.lab.A, C.SPACES[g].toXYZ) };
}
function updateUniforms() {
  const ms = GK.map((g) => C.labXyzToLin(g));
  U.uM0.value.copy(mat3(ms[0])); U.uM1.value.copy(mat3(ms[1])); U.uM2.value.copy(mat3(ms[2]));
  U.uMD.value.copy(mat3(C.labXyzToLin(state.disp)));
  U.uW.value.set(...C.lab.W);
  U.uA.value = A();
  U.uRef.value = { srgb: 0, p3: 1, adobe: 2, disp: 3, none: -1 }[state.ref];
  U.uOog.value = { clip: 0, hatch: 1, grey: 2, hide: 3 }[state.oog];
  U.uDpr.value = DPR();
  const vx = viewInverse();
  U.uView.value = vx.lab ? 0 : 1; U.uDec.value = vx.dec || 0; U.uViewG.value = GK.indexOf(vx.g); U.uDispG.value = GK.indexOf(state.disp);
  U.uVM.value.copy(mat3(vx.M)); U.uVO.value.set(...vx.O); U.uVX.value.copy(mat3(vx.X || I3));
  for (const key of [...GK, 'box']) OBJ[key].face.uniforms.uOpacity.value = state.faceOp;
  for (const m of Object.values(sliceMat)) {
    m.uniforms.uOpacity.value = state.sliceOp;
    m.depthWrite = state.sliceOp > 0.98;
  }
}

// ---------------------------------------------------------------- geometry
const mainGroup = new THREE.Group(), sliceGroup = new THREE.Group();
scene.add(mainGroup, sliceGroup);
function clearGroup(g) {
  for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
}
const dispRGB = (xyz) => C.displayColor(xyz, state.disp).slice(0, 3);

function edgeLines(key, n = 72) {
  const pos = [], col = [];
  for (const [i, j] of CUBE_EDGES) {
    const a = corner(i), b = corner(j);
    let prev = null;
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      const P = paramPoint(key, a.map((v, q) => v + (b[q] - v) * t));
      const cur = { p: toScene(P), c: dispRGB(P.xyz) };
      if (prev) { pos.push(...prev.p, ...cur.p); col.push(...prev.c, ...cur.c); }
      prev = cur;
    }
  }
  const mk = (mat, withColor, order) => {
    const g = new LineSegmentsGeometry(); g.setPositions(pos); if (withColor) g.setColors(col);
    const l = new LineSegments2(g, mat); l.renderOrder = order; return l;
  };
  return [mk(OBJ[key].casing, false, 1), mk(OBJ[key].core, true, 2)];
}

// Half-spaces (each value >= 0 inside) that 'cut away' removes, for clipping meshes on the CPU.
function clipFns(outBox) {
  if (state.oog !== 'hide') return null;
  if (outBox) { const a = A(); return (P) => [a - P.lab[1], a + P.lab[1], a - P.lab[2], a + P.lab[2]]; }
  const g = state.ref === 'disp' ? state.disp : state.ref;
  if (g === 'none') return null;
  return (P) => { const l = C.xyzToLin(g, P.xyz); return [l[0], l[1], l[2], 1 - l[0], 1 - l[1], 1 - l[2]]; };
}

// n+1 knots on [0, 1] for one grid axis, given pt(s, w) -> scene position (s along the axis, w across it). Spaced
// so the flat facets stray about equally far from the true surface (chord error ~ curvature·h², so density ~
// sqrt(curvature), measured on a few cross-sections), half mixed with uniform spacing.
function knots(n, pt) {
  const m = 4 * n, W = 8, d2 = new Float64Array(m + 1);
  for (let k = 0; k <= W; k++) {
    const P = []; for (let i = 0; i <= m; i++) P.push(pt(i / m, k / W));
    for (let i = 1; i < m; i++) d2[i] = Math.max(d2[i], Math.hypot(...[0, 1, 2].map((c) => P[i - 1][c] - 2 * P[i][c] + P[i + 1][c])));
  }
  d2[0] = d2[1]; d2[m] = d2[m - 1];
  const dens = []; for (let i = 0; i < m; i++) dens.push(Math.sqrt((d2[i] + d2[i + 1]) / 2));
  const mean = dens.reduce((a, b) => a + b, 0) / m || 1, cum = [0];
  for (let i = 0; i < m; i++) cum.push(cum[i] + dens[i] + mean);
  const out = [0];
  for (let j = 1, i = 0; j < n; j++) {
    const t = j / n * cum[m];
    while (cum[i + 1] < t) i++;
    out.push((i + (t - cum[i]) / (cum[i + 1] - cum[i])) / m);
  }
  out.push(1);
  return out;
}

// Grid of (n+1)^2 points from fn(q, u, v) -> {xyz, lab}, triangulated. With `clip`, triangles are clipped in (u, v)
// against each half-space, solving each crossing on the true surface by bisection, so cut edges end exactly on the
// boundary instead of wherever the flat facets happen to cross it.
function gridMesh(n, fn, mat, quads, clip = null) {
  const pos = [], idx = [];
  const id = (V) => V.id ?? (pos.push(...toScene(V.P)), V.id = pos.length / 3 - 1);
  const vert = (q, u, v) => { const P = fn(q, u, v); return { u, v, P, g: clip?.(P) }; };
  const cut = (q, A, B, k) => {
    let lo = A.g[k] >= 0 ? A : B, hi = lo === A ? B : A; // order by side, so shared edges cut identically
    let [u0, v0, u1, v1] = [lo.u, lo.v, hi.u, hi.v];
    for (let it = 0; it < 32; it++) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2, M = vert(q, um, vm);
      if (M.g[k] >= 0) { lo = M; u0 = um; v0 = vm; } else { u1 = um; v1 = vm; }
    }
    return lo;
  };
  const tri = (q, poly) => {
    if (clip) {
      for (let k = 0; poly.length && k < poly[0].g.length; k++) {
        if (poly.every((p) => p.g[k] >= 0)) continue;
        const out = [];
        poly.forEach((a, i) => {
          const b = poly[(i + 1) % poly.length], ia = a.g[k] >= 0;
          if (ia) out.push(a);
          if (ia !== (b.g[k] >= 0)) out.push(cut(q, a, b, k));
        });
        poly = out;
      }
    }
    for (let i = 1; i + 1 < poly.length; i++) idx.push(id(poly[0]), id(poly[i]), id(poly[i + 1]));
  };
  for (const q of quads) {
    const sc = (u, v) => toScene(fn(q, u, v)), us = knots(n, sc), vs = knots(n, (v, u) => sc(u, v)), G = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) G.push(vert(q, us[i], vs[j]));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j, c = a + n + 1;
      tri(q, [G[a], G[c], G[a + 1]]); tri(q, [G[a + 1], G[c], G[c + 1]]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat); m.renderOrder = 5; return m;
}
const FACES = [0, 1, 2].flatMap((ax) => [0, 1].map((s) => ({ ax, s })));
function cubeFaces(key, n) {
  return gridMesh(n, ({ ax, s }, u, v) => {
    const p = [0, 0, 0]; p[ax] = s; p[(ax + 1) % 3] = u; p[(ax + 2) % 3] = v;
    return paramPoint(key, p);
  }, OBJ[key].face, FACES, clipFns(key !== 'box'));
}

const label = (text, pos, cls = '', color) => {
  const el = document.createElement('div');
  el.className = 'lbl ' + cls; el.textContent = text;
  if (color) el.style.color = color;
  const o = new CSS2DObject(el); o.position.set(...pos); return o;
};
const CORNER_NAMES = { 1: 'R', 2: 'G', 4: 'B', 6: 'C', 5: 'M', 3: 'Y' };

const sliceR = () => Math.max(A(), 150);
// Constant-saturation cone (C* = s·L*, CIE saturation s = C*/L*) or constant-chroma cylinder (C* = c).
const surfC = (L) => (state.sMode === 'sat' ? state.sat * L : state.chroma);
const surfLabel = () => (state.sMode === 'sat' ? `s = C*/L* = ${state.sat.toFixed(2)}` : `C* = ${fmt(state.chroma)}`);

function rebuildMain() {
  clearGroup(mainGroup);
  for (const key of [...GK, 'box']) {
    const L = state.layers[key];
    if (L.edges) mainGroup.add(...edgeLines(key));
    if (L.faces) mainGroup.add(cubeFaces(key, key === 'box' ? 56 : 36));
    if (L.labels && key !== 'box') {
      for (const [i, nm] of Object.entries(CORNER_NAMES)) mainGroup.add(label(nm, toScene(paramPoint(key, corner(+i))), '', ID[key]));
    }
  }
  if (state.layers.box.labels) {
    const a = A();
    mainGroup.add(label(`(+${fmt(a, 0)}, +${fmt(a, 0)})`, toScene(labPt([100, a, a])), '', BOX_ID));
    mainGroup.add(label(`(−${fmt(a, 0)}, −${fmt(a, 0)})`, toScene(labPt([100, -a, -a])), '', BOX_ID));
    mainGroup.add(label('W', toScene(labPt([100, 0, 0])), '', '#fff'));
    mainGroup.add(label('K', toScene(labPt([0, 0, 0])), '', '#999'));
  }
  if (state.axes) {
    const { segs, labels } = VIEWS[state.view].grid();
    if (segs.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(segs.flat(2), 3));
      mainGroup.add(new THREE.LineSegments(g, gridMat));
    }
    for (const l of labels) mainGroup.add(label(l.t, l.p, l.c || 'ax'));
  }
}
function rebuildSlices() {
  clearGroup(sliceGroup);
  const R = sliceR();
  if (state.showL) {
    sliceGroup.add(gridMesh(64, (q, u, v) => labPt([state.L, (2 * u - 1) * R, (2 * v - 1) * R]), sliceMat.L, [0], clipFns(false)));
  }
  if (state.showH) {
    const h = state.hue * Math.PI / 180, ca = Math.cos(h), sa = Math.sin(h);
    sliceGroup.add(gridMesh(64, (q, u, v) => { const c = (2 * u - 1) * R; return labPt([v * 100, c * ca, c * sa]); }, sliceMat.H, [0], clipFns(false)));
  }
  if (state.showS) {
    sliceGroup.add(gridMesh(72, (q, u, v) => { const h = u * 2 * Math.PI, L = v * 100, c = surfC(L); return labPt([L, c * Math.cos(h), c * Math.sin(h)]); }, sliceMat.S, [0], clipFns(false)));
  }
}

// ---------------------------------------------------------------- image point cloud
// One point per unique 8-bit color. A color seen n times gets alpha 1 - (1 - α)^n, which is what n stacked points
// of alpha α would blend to, so density reads the same as drawing every pixel.
const cloudMat = new THREE.ShaderMaterial({
  uniforms: { uAlpha: { value: 0.25 }, uSize: { value: 1 } },
  vertexShader: /* glsl */`
    attribute vec3 aCol; attribute float aCount; uniform float uAlpha, uSize; varying vec4 vC;
    void main() {
      vC = vec4(aCol, 1.0 - pow(1.0 - uAlpha, aCount));
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize;
    }`,
  fragmentShader: /* glsl */`varying vec4 vC; void main() { gl_FragColor = vC; }`,
  transparent: true, depthWrite: false,
});
const cloudPts = new THREE.Points(new THREE.BufferGeometry(), cloudMat);
cloudPts.renderOrder = 4; cloudPts.frustumCulled = false;
scene.add(cloudPts);
let cloudImg = null, cloudKey = '';
// 1 CSS px, or 0.5 CSS px on high-density screens (one device pixel at 2x).
const cloudSize = () => (DPR() >= 2 ? 0.5 : 1) * DPR();
const cloudSpace = () => (state.cloudSpace === 'auto' ? cloudImg?.space || 'srgb' : state.cloudSpace);
function updateCloud() {
  cloudMat.uniforms.uAlpha.value = Math.pow(10, state.cloudAlpha);
  cloudMat.uniforms.uSize.value = cloudSize();
  cloudPts.visible = !!cloudImg && state.cloudOn;
  if (!cloudPts.visible) return;
  const g = cloudSpace();
  const key = [cloudImg.id, g, state.view, state.white, state.disp, state.view === 'labn' ? A() : ''].join('|');
  if (key === cloudKey) return;
  cloudKey = key;
  const { keys, counts } = cloudImg, n = keys.length, lut = Array.from({ length: 256 }, (_, i) => C.SPACES[g].dec(i / 255));
  const pos = new Float32Array(3 * n), col = new Float32Array(3 * n), map = VIEWS[state.view].map;
  for (let i = 0; i < n; i++) {
    const k = keys[i], xyz = C.linToXyz(g, [lut[k >>> 16], lut[(k >>> 8) & 255], lut[k & 255]]);
    pos.set(map(xyz, C.xyzToLab(xyz)), 3 * i);
    col.set(dispRGB(xyz), 3 * i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aCount', new THREE.BufferAttribute(counts, 1));
  cloudPts.geometry.dispose(); cloudPts.geometry = geo;
}
function cloudInfo() {
  const el = $('#cloudInfo');
  if (!cloudImg) { el.textContent = "Drop an image anywhere on the page to plot each pixel's color as a point."; return; }
  const c = cloudImg, sp = NAME[cloudSpace()];
  const src = state.cloudSpace !== 'auto' ? 'set by hand' : c.space ? `from ${c.how}` : `${c.how}, assumed`;
  el.innerHTML = `<b>${escapeHtml(c.name)}</b> · ${c.w}×${c.h}${c.step > 1 ? ` (every ${c.step}th pixel)` : ''}<br>
    ${c.n.toLocaleString()} px · ${c.keys.length.toLocaleString()} unique colors<br>pixels read as <b>${sp}</b> <span class="dim">(${escapeHtml(src)})</span>`;
}
const escapeHtml = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
async function loadCloud(file) {
  if (!file) return;
  $('#cloudInfo').textContent = `Reading ${file.name}…`;
  try {
    cloudImg = { ...(await readImage(file)), id: Date.now() };
  } catch (err) {
    $('#cloudInfo').innerHTML = `<span class="bad">Couldn't read ${escapeHtml(file.name)}: ${escapeHtml(String(err.message || err))}</span>`;
    return;
  }
  state.cloudOn = true; save(); syncControls(); updateLegend(); updateCloud();
}

// ---------------------------------------------------------------- axes per view
const fmt = (v, d = 1) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d);
function labGrid(norm) {
  const a = A();
  const R = norm ? a : Math.min(300, Math.max(150, Math.ceil(a / 50) * 50));
  const vals = norm ? [-1, -0.5, 0, 0.5, 1].map((t) => t * a) : Array.from({ length: (2 * R) / 50 + 1 }, (_, i) => -R + 50 * i);
  const txt = (v) => (norm ? { '-1': '−A', '-0.5': '−A/2', 0: '0', 0.5: '+A/2', 1: '+A' }[String(v / a)] ?? fmt(v, 0) : fmt(v, 0));
  const S = (L, x, y) => toScene(labPt([L, x, y]));
  const segs = [], labels = [];
  for (const v of vals) { segs.push([S(0, v, -R), S(0, v, R)], [S(0, -R, v), S(0, R, v)]); }
  for (const v of vals) {
    labels.push({ t: txt(v), p: S(0, v, -R * 1.1) });
    labels.push({ t: txt(v), p: S(0, R * 1.1, v) });
  }
  labels.push({ t: 'a* →', p: S(0, R * 0.55, -R * 1.22), c: 'axt' }, { t: 'b* →', p: S(0, R * 1.24, R * 0.55), c: 'axt' });
  segs.push([S(0, -R, R), S(100, -R, R)]);
  for (let L = 0; L <= 100; L += 20) {
    segs.push([S(L, -R, R), S(L, -R * 1.04, R)]);
    labels.push({ t: String(L), p: S(L, -R * 1.1, R) });
  }
  labels.push({ t: 'L*', p: S(108, -R, R), c: 'axt' });
  return { segs, labels };
}
function oklabGrid() {
  const S = (L, a, b) => [a * 3, L - 0.5, -b * 3];
  const segs = [], labels = [], R = 0.4;
  for (let i = -4; i <= 4; i++) {
    const v = i / 10;
    segs.push([S(0, v, -R), S(0, v, R)], [S(0, -R, v), S(0, R, v)]);
    if (i % 2 === 0) labels.push({ t: v.toFixed(1), p: S(0, v, -R * 1.12) }, { t: v.toFixed(1), p: S(0, R * 1.12, v) });
  }
  labels.push({ t: 'a →', p: S(0, R * 0.55, -R * 1.25), c: 'axt' }, { t: 'b →', p: S(0, R * 1.25, R * 0.55), c: 'axt' });
  segs.push([S(0, -R, R), S(1, -R, R)]);
  for (let L = 0; L <= 1.001; L += 0.25) labels.push({ t: L.toFixed(2), p: S(L, -R * 1.12, R) });
  labels.push({ t: 'L', p: S(1.08, -R, R), c: 'axt' });
  return { segs, labels };
}
function xyzGrid() {
  const S = (x, y, z) => [x - 0.5, y - 0.5, z - 0.5];
  const segs = [], labels = [];
  for (let i = 0; i <= 4; i++) { const v = i / 4; segs.push([S(v, 0, 0), S(v, 0, 1.1)], [S(0, 0, v), S(1.1, 0, v)]); }
  segs.push([S(0, 0, 0), S(0, 1.1, 0)]);
  for (const v of [0.5, 1]) labels.push({ t: v.toFixed(1), p: S(v, 0, 1.18) }, { t: v.toFixed(1), p: S(1.18, 0, v) }, { t: v.toFixed(1), p: S(-0.06, v, 0) });
  labels.push({ t: 'X', p: S(1.25, 0, 0), c: 'axt' }, { t: 'Y', p: S(0, 1.2, 0), c: 'axt' }, { t: 'Z', p: S(0, 0, 1.25), c: 'axt' });
  return { segs, labels };
}
function rgbGrid(g) {
  const k = C.SPACES[g].short;
  return { segs: [[rgbScene([0, 0, 0]), rgbScene([1, 1, 1])]], labels: [{ t: `${k} neutral axis`, p: rgbScene([1.08, 1.08, 1.08]), c: 'axt' }] };
}

// ---------------------------------------------------------------- legend overlay
function updateLegend() {
  const refName = { disp: `display (${state.disp === 'p3' ? 'P3' : 'sRGB'})`, srgb: 'sRGB', p3: 'Display P3', adobe: 'Adobe RGB', none: '—' }[state.ref];
  const oog = { hatch: 'hatched', grey: 'greyed', hide: 'cut away', clip: 'shown clipped' }[state.oog];
  $('#legend').innerHTML = `
    <div class="t">${VIEWS[state.view].name}</div>
    <div>${['srgb', 'p3', 'adobe'].map((k) => `<span class="chip" style="background:${ID[k]}"></span>${NAME[k]}`).join(' &nbsp;')}</div>
    <div><span class="chip" style="background:${BOX_ID}"></span>Lab box L* 0–100, a*b* ±${fmt(A(), 1)} &nbsp;<span class="dim">(${state.white})</span></div>
    <div class="dim">Edge casing = space · core = true color (clipped to ${state.disp === 'p3' ? 'P3' : 'sRGB'})</div>
    <div class="dim">Box faces &amp; slices outside ${refName}: ${oog} · gamut faces outside box: ${oog}</div>
    <div class="dim">Thin contour lines = crossing of that space's boundary</div>
    ${cloudImg && state.cloudOn ? `<div class="dim">Points = pixels of ${escapeHtml(cloudImg.name)}, read as ${NAME[cloudSpace()]}</div>` : ''}`;
}

// ---------------------------------------------------------------- 2D slices
const abWrap = $('#abWrap'), hWrap = $('#hWrap'), sWrap = $('#sWrap');
let abCanvas, hCanvas, sCanvas;
const PLOT_PAD = { l: 30, r: 6, t: 6, b: 20 };
function makeCanvas(wrap, aspect) {
  wrap.querySelector('canvas')?.remove();
  const c = document.createElement('canvas');
  wrap.prepend(c);
  const w = wrap.clientWidth || 360, h = Math.round(w * aspect);
  c.style.height = h + 'px';
  c.width = Math.round(w * DPR()); c.height = Math.round(h * DPR());
  c._w = w; c._h = h; c._cache = null;
  let ctx;
  try { ctx = c.getContext('2d', { colorSpace: state.disp === 'p3' ? 'display-p3' : 'srgb' }); } catch { ctx = c.getContext('2d'); }
  c._ctx = ctx;
  return c;
}
function setupCanvases() {
  abCanvas = makeCanvas(abWrap, 1);
  hCanvas = makeCanvas(hWrap, 0.62);
  sCanvas = makeCanvas(sWrap, 0.5);
  drawSlices();
}

// in-gamut test helpers on Lab-white XYZ
const finv = C.labFinv;
function labXyzW(L, a, b, out) {
  const W = C.lab.W, fy = (L + 16) / 116;
  out[0] = W[0] * finv(fy + a / 500); out[1] = W[1] * finv(fy); out[2] = W[2] * finv(fy - b / 200);
}
const inM = (M, x) => {
  for (let c = 0; c < 3; c++) { const v = M[c][0] * x[0] + M[c][1] * x[1] + M[c][2] * x[2]; if (v < -1e-7 || v > 1 + 1e-7) return false; }
  return true;
};
function maxChroma(M, L, h) {
  if (L <= 0.01 || L >= 99.99) return 0;
  const ca = Math.cos(h), sa = Math.sin(h), x = [0, 0, 0];
  const ok = (c) => (labXyzW(L, c * ca, c * sa, x), inM(M, x));
  let lo = 0, hi = 0;
  while (hi < 400) { hi += 2; if (!ok(hi)) break; lo = hi; }
  for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}

// Fill a slice canvas: pix(xCss, yCss) -> [L, a, b] or null.
function fillCanvas(c, key, pix) {
  const ctx = c._ctx;
  if (!c._cache || c._cache.key !== key) {
    const W = c.width, H = c.height, d = DPR();
    let img;
    try { img = ctx.createImageData(W, H, { colorSpace: state.disp === 'p3' ? 'display-p3' : 'srgb' }); } catch { img = ctx.createImageData(W, H); }
    const MD = C.labXyzToLin(state.disp), MR = state.ref === 'none' ? null : C.labXyzToLin(state.ref === 'disp' ? state.disp : state.ref);
    const enc = C.SPACES[state.disp].enc, x = [0, 0, 0], lin = [0, 0, 0];
    const bg = [18, 18, 20];
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const o = (py * W + px) * 4;
      const lab = pix(px / d, py / d);
      if (!lab) { img.data[o] = bg[0]; img.data[o + 1] = bg[1]; img.data[o + 2] = bg[2]; img.data[o + 3] = 255; continue; }
      labXyzW(lab[0], lab[1], lab[2], x);
      for (let k = 0; k < 3; k++) lin[k] = MD[k][0] * x[0] + MD[k][1] * x[1] + MD[k][2] * x[2];
      let r = enc(Math.min(1, Math.max(0, lin[0]))), g = enc(Math.min(1, Math.max(0, lin[1]))), b = enc(Math.min(1, Math.max(0, lin[2])));
      if (MR && !inM(MR, x)) {
        if (state.oog === 'hide') { r = g = b = bg[0] / 255; }
        else if (state.oog === 'grey') { r = g = b = 0.3 + 0.25 * (0.3 * r + 0.55 * g + 0.15 * b); }
        else if (state.oog === 'hatch') { const st = ((px + py) % Math.round(7 * d)) < 3.5 * d ? 1 : 0; const t = 0.25 + 0.6 * st; r = r + (0.42 - r) * t; g = g + (0.42 - g) * t; b = b + (0.42 - b) * t; }
      }
      img.data[o] = r * 255; img.data[o + 1] = g * 255; img.data[o + 2] = b * 255; img.data[o + 3] = 255;
    }
    c._cache = { key, img };
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(c._cache.img, 0, 0);
  ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0);
  return ctx;
}
function stroke(ctx, pts, color, width = 1.6, dash = null, close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
  ctx.setLineDash(dash || []);
  ctx.lineWidth = width + 2.2; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke();
  ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  ctx.setLineDash([]);
}
function axisText(ctx, t, x, y, align = 'center', base = 'top') {
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#9a9aa0'; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(t, x, y);
}
const plotR = () => Math.max(A(), 150) * 1.06;
function abXform(c) {
  const R = plotR(), p = PLOT_PAD, w = c._w - p.l - p.r, h = c._h - p.t - p.b, s = Math.min(w, h) / (2 * R);
  const cx = p.l + w / 2, cy = p.t + h / 2;
  return { R, s, toPx: (a, b) => [cx + a * s, cy - b * s], toLab: (x, y) => [(x - cx) / s, (cy - y) / s], inside: (x, y) => x >= p.l && x <= c._w - p.r && y >= p.t && y <= c._h - p.b };
}
function hXform(c) {
  const R = plotR(), p = PLOT_PAD, w = c._w - p.l - p.r, h = c._h - p.t - p.b;
  const cx = p.l + w / 2;
  return { R, toPx: (cc, L) => [cx + cc / R * w / 2, p.t + (1 - L / 100) * h], toCL: (x, y) => [(x - cx) / (w / 2) * R, (1 - (y - p.t) / h) * 100], inside: (x, y) => x >= p.l && x <= c._w - p.r && y >= p.t && y <= c._h - p.b };
}
function drawSlices() {
  if (!abCanvas) return;
  const a = A(), hr = state.hue * Math.PI / 180, keyBase = `${state.white}|${state.disp}|${state.ref}|${state.oog}|${plotR().toFixed(2)}`;
  // a*b* plane
  {
    const c = abCanvas, X = abXform(c);
    const ctx = fillCanvas(c, `${keyBase}|${state.L}`, (x, y) => X.inside(x, y) ? [state.L, ...X.toLab(x, y)] : null);
    for (let v = -300; v <= 300; v += 50) {
      if (Math.abs(v) > X.R) continue;
      const [px] = X.toPx(v, 0), [, py] = X.toPx(0, v);
      axisText(ctx, fmt(v, 0), px, c._h - PLOT_PAD.b + 4);
      axisText(ctx, fmt(v, 0), PLOT_PAD.l - 3, py, 'right', 'middle');
      ctx.fillStyle = '#ffffff22'; ctx.fillRect(px, PLOT_PAD.t, 0.5, c._h - PLOT_PAD.t - PLOT_PAD.b); ctx.fillRect(PLOT_PAD.l, py, c._w - PLOT_PAD.l - PLOT_PAD.r, 0.5);
    }
    axisText(ctx, 'a* →', c._w - PLOT_PAD.r - 4, c._h - PLOT_PAD.b - 14, 'right'); axisText(ctx, '↑ b*', PLOT_PAD.l + 4, PLOT_PAD.t + 3, 'left');
    for (const g of GK) {
      const M = C.labXyzToLin(g), pts = [];
      for (let i = 0; i < 360; i += 1) { const h = i * Math.PI / 180, cc = maxChroma(M, state.L, h); pts.push(X.toPx(cc * Math.cos(h), cc * Math.sin(h))); }
      stroke(ctx, pts, ID[g], 1.5);
    }
    stroke(ctx, [X.toPx(-a, -a), X.toPx(a, -a), X.toPx(a, a), X.toPx(-a, a)], BOX_ID, 1.8);
    const sc = surfC(state.L);
    if (sc > 0) { ctx.beginPath(); ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.strokeStyle = '#ffffffaa'; const [cx, cy] = X.toPx(0, 0); ctx.arc(cx, cy, sc * X.s, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    const e = X.R * 1.5;
    stroke(ctx, [X.toPx(-e * Math.cos(hr), -e * Math.sin(hr)), X.toPx(e * Math.cos(hr), e * Math.sin(hr))], '#ffffffaa', 1, [3, 3], false);
    const [hx, hy] = X.toPx(X.R * 0.86 * Math.cos(hr), X.R * 0.86 * Math.sin(hr));
    axisText(ctx, `h ${state.hue}°`, hx, hy, 'center', 'middle');
  }
  // constant-hue plane: x = signed chroma along h (left = h + 180°), y = L*
  {
    const c = hCanvas, X = hXform(c), ca = Math.cos(hr), sa = Math.sin(hr);
    const ctx = fillCanvas(c, `${keyBase}|h${state.hue}`, (x, y) => { if (!X.inside(x, y)) return null; const [cc, L] = X.toCL(x, y); return [L, cc * ca, cc * sa]; });
    for (let v = -300; v <= 300; v += 50) {
      if (Math.abs(v) > X.R) continue;
      const [px] = X.toPx(v, 0);
      axisText(ctx, fmt(Math.abs(v), 0), px, c._h - PLOT_PAD.b + 4);
      ctx.fillStyle = '#ffffff22'; ctx.fillRect(px, PLOT_PAD.t, 0.5, c._h - PLOT_PAD.t - PLOT_PAD.b);
    }
    for (let L = 0; L <= 100; L += 25) { const [, py] = X.toPx(0, L); axisText(ctx, String(L), PLOT_PAD.l - 3, py, 'right', 'middle'); }
    axisText(ctx, `C* @ ${state.hue}° →`, c._w - PLOT_PAD.r - 2, c._h - PLOT_PAD.b - 13, 'right');
    axisText(ctx, `← C* @ ${(state.hue + 180) % 360}°`, PLOT_PAD.l + 3, c._h - PLOT_PAD.b - 13, 'left');
    for (const g of GK) {
      const M = C.labXyzToLin(g), right = [], left = [];
      for (let L = 0; L <= 100; L += 0.5) { right.push(X.toPx(maxChroma(M, L, hr), L)); left.push(X.toPx(-maxChroma(M, L, hr + Math.PI), L)); }
      stroke(ctx, [...right, ...left.reverse()], ID[g], 1.5);
    }
    const bw = a / Math.max(Math.abs(ca), Math.abs(sa));
    stroke(ctx, [X.toPx(-bw, 0), X.toPx(bw, 0), X.toPx(bw, 100), X.toPx(-bw, 100)], BOX_ID, 1.8);
    const [, ly] = X.toPx(0, state.L);
    stroke(ctx, [[PLOT_PAD.l, ly], [c._w - PLOT_PAD.r, ly]], '#ffffffaa', 1, [3, 3], false);
    for (const sgn of [1, -1]) {
      const pts = []; for (let L = 0; L <= 100; L += 2) pts.push(X.toPx(sgn * surfC(L), L));
      ctx.save(); ctx.beginPath(); ctx.rect(PLOT_PAD.l, PLOT_PAD.t, c._w - PLOT_PAD.l - PLOT_PAD.r, c._h - PLOT_PAD.t - PLOT_PAD.b); ctx.clip();
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.strokeStyle = '#ffffffaa'; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
  }
  drawSatSurface(keyBase);
}

// Unrolled saturation/chroma surface: x = hue 0–360°, y = L*.
function sXform(c) {
  const p = PLOT_PAD, w = c._w - p.l - p.r, h = c._h - p.t - p.b;
  return {
    toPx: (hue, L) => [p.l + hue / 360 * w, p.t + (1 - L / 100) * h],
    toHL: (x, y) => [(x - p.l) / w * 360, (1 - (y - p.t) / h) * 100],
    inside: (x, y) => x >= p.l && x <= c._w - p.r && y >= p.t && y <= c._h - p.b,
  };
}
const surfLab = (hue, L) => { const c = surfC(L), r = hue * Math.PI / 180; return [L, c * Math.cos(r), c * Math.sin(r)]; };
function drawSatSurface(keyBase) {
  const c = sCanvas, X = sXform(c);
  $('#sval').textContent = surfLabel();
  const ctx = fillCanvas(c, `${keyBase}|${state.sMode}|${state.sat}|${state.chroma}`, (x, y) => (X.inside(x, y) ? surfLab(...X.toHL(x, y)) : null));
  for (let hh = 0; hh <= 360; hh += 60) {
    const [px] = X.toPx(hh, 0);
    axisText(ctx, String(hh), px, c._h - PLOT_PAD.b + 4, hh === 360 ? 'right' : 'center');
    ctx.fillStyle = '#ffffff22'; ctx.fillRect(px, PLOT_PAD.t, 0.5, c._h - PLOT_PAD.t - PLOT_PAD.b);
  }
  for (let L = 0; L <= 100; L += 25) { const [, py] = X.toPx(0, L); axisText(ctx, String(L), PLOT_PAD.l - 3, py, 'right', 'middle'); }
  axisText(ctx, 'hue° →', c._w - PLOT_PAD.r - 4, c._h - PLOT_PAD.b - 14, 'right');
  // Boundaries are traced by scanning columns and rows for in/out transitions, then bisecting.
  const a = A(), x = [0, 0, 0];
  const tests = GK.map((g) => { const M = C.labXyzToLin(g); return [ID[g], (lab) => (labXyzW(lab[0], lab[1], lab[2], x), inM(M, x))]; });
  tests.push([BOX_ID, (lab) => Math.abs(lab[1]) <= a && Math.abs(lab[2]) <= a]);
  const W = c._w - PLOT_PAD.l - PLOT_PAD.r, H = c._h - PLOT_PAD.t - PLOT_PAD.b;
  for (const [color, ok] of tests) {
    const pts = [];
    const scan = (n, m, at) => {
      for (let i = 0; i <= n; i++) {
        let prev = ok(surfLab(...at(i / n, 0)));
        for (let j = 1; j <= m; j++) {
          const cur = ok(surfLab(...at(i / n, j / m)));
          if (cur !== prev) {
            let lo = (j - 1) / m, hi = j / m;
            for (let k = 0; k < 10; k++) { const mid = (lo + hi) / 2; if (ok(surfLab(...at(i / n, mid))) === prev) lo = mid; else hi = mid; }
            pts.push(at(i / n, (lo + hi) / 2));
          }
          prev = cur;
        }
      }
    };
    scan(Math.round(W), Math.round(H), (u, v) => [u * 360, v * 100]);
    scan(Math.round(H), Math.round(W), (u, v) => [v * 360, u * 100]);
    const px = pts.map(([hh, L]) => X.toPx(hh, L));
    ctx.fillStyle = 'rgba(0,0,0,.85)'; for (const [qx, qy] of px) ctx.fillRect(qx - 1.6, qy - 1.6, 3.2, 3.2);
    ctx.fillStyle = color; for (const [qx, qy] of px) ctx.fillRect(qx - 0.8, qy - 0.8, 1.6, 1.6);
  }
  const [hx] = X.toPx(state.hue, 0), [, ly] = X.toPx(0, state.L);
  stroke(ctx, [[hx, PLOT_PAD.t], [hx, c._h - PLOT_PAD.b]], '#ffffffaa', 1, [3, 3], false);
  stroke(ctx, [[PLOT_PAD.l, ly], [c._w - PLOT_PAD.r, ly]], '#ffffffaa', 1, [3, 3], false);
}

// hover readout + drag interactions
function readout(lab) {
  if (!lab) return;
  const [L, a, b] = lab, Cc = Math.hypot(a, b), h = ((Math.atan2(b, a) * 180 / Math.PI) + 360) % 360;
  const xyz = C.labToXyz(lab);
  const dc = C.displayColor(xyz, state.disp);
  const css = state.disp === 'p3' ? `color(display-p3 ${dc[0]} ${dc[1]} ${dc[2]})` : `rgb(${dc[0] * 255} ${dc[1] * 255} ${dc[2] * 255})`;
  const inBox = Math.abs(a) <= A() && Math.abs(b) <= A() && L >= 0 && L <= 100;
  const rows = GK.map((g) => {
    const lin = C.xyzToLin(g, xyz), enc = C.encode(g, lin), ok = C.inGamutLin(lin, 1e-6);
    return `<tr><td><span class="chip" style="background:${ID[g]}"></span>${NAME[g]}</td>${enc.map((v) => `<td class="${v < -5e-4 || v > 1.0005 ? 'bad' : ''}">${(v * 255).toFixed(1)}</td>`).join('')}<td>${ok ? 'in' : '<span class="bad">out</span>'}</td></tr>`;
  }).join('');
  $('#readout').innerHTML = `<div class="row" style="margin:0 0 3px"><span class="swatch" style="background:${css}"></span>
    <span class="mono">L* ${fmt(L)} a* ${fmt(a)} b* ${fmt(b)} &nbsp;C* ${fmt(Cc)} h ${fmt(h)}°</span>
    <span class="${inBox ? '' : 'bad'}" style="margin-left:auto;white-space:nowrap">${inBox ? 'in box' : 'outside box'}</span></div>
    <table><tr><th>8-bit code</th><th>R</th><th>G</th><th>B</th><th></th></tr>${rows}</table>`;
}
function bindPlot(wrap, getLab, onDrag) {
  let down = false;
  const pos = (e) => { const r = wrap.querySelector('canvas').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  wrap.addEventListener('pointermove', (e) => { const p = pos(e); readout(getLab(...p)); if (down) onDrag(...p); });
  wrap.addEventListener('pointerdown', (e) => { down = true; wrap.setPointerCapture(e.pointerId); onDrag(...pos(e)); });
  wrap.addEventListener('pointerup', () => { down = false; });
}
bindPlot(abWrap, (x, y) => { const X = abXform(abCanvas); return X.inside(x, y) ? [state.L, ...X.toLab(x, y)] : null; }, (x, y) => {
  const [a, b] = abXform(abCanvas).toLab(x, y);
  let h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  set({ hue: Math.round(h * 2) / 2 }, 'slice');
});
bindPlot(hWrap, (x, y) => {
  const X = hXform(hCanvas); if (!X.inside(x, y)) return null;
  const [cc, L] = X.toCL(x, y), hr = state.hue * Math.PI / 180; return [L, cc * Math.cos(hr), cc * Math.sin(hr)];
}, (x, y) => { const [, L] = hXform(hCanvas).toCL(x, y); set({ L: Math.round(Math.min(100, Math.max(0, L)) * 2) / 2 }, 'slice'); });
bindPlot(sWrap, (x, y) => { const X = sXform(sCanvas); return X.inside(x, y) ? surfLab(...X.toHL(x, y)) : null; }, (x, y) => {
  const [hh, L] = sXform(sCanvas).toHL(x, y);
  set({ hue: Math.round(Math.min(360, Math.max(0, hh)) * 2) / 2 % 360, L: Math.round(Math.min(100, Math.max(0, L)) * 2) / 2 }, 'slice');
});

// ---------------------------------------------------------------- volume statistics
const GRID = { half: 320, n: 256 }; GRID.step = (2 * GRID.half) / GRID.n;
let SAT = null, EXT = null;
function computeStats() {
  const { n, step: st, half } = GRID, W = C.lab.W, N1 = n + 1;
  const Ms = GK.map((g) => C.labXyzToLin(g));
  const cnt = GK.map(() => new Uint16Array(n * n)), any = new Uint16Array(n * n);
  const xc = new Float64Array(n * 9), zc = new Float64Array(n * 9), yc = new Float64Array(9);
  for (let li = 0; li < 100; li++) {
    const L = li + 0.5, fy = (L + 16) / 116, Y = W[1] * finv(fy);
    for (let i = 0; i < n; i++) {
      const v = -half + (i + 0.5) * st, X = W[0] * finv(fy + v / 500), Z = W[2] * finv(fy - v / 200);
      for (let g = 0; g < 3; g++) for (let c = 0; c < 3; c++) { xc[i * 9 + g * 3 + c] = Ms[g][c][0] * X; zc[i * 9 + g * 3 + c] = Ms[g][c][2] * Z; }
    }
    for (let g = 0; g < 3; g++) for (let c = 0; c < 3; c++) yc[g * 3 + c] = Ms[g][c][1] * Y;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let inAny = false;
      for (let g = 0; g < 3; g++) {
        const o = g * 3;
        const r = xc[i * 9 + o] + yc[o] + zc[j * 9 + o];
        if (r < 0 || r > 1) continue;
        const gg = xc[i * 9 + o + 1] + yc[o + 1] + zc[j * 9 + o + 1];
        if (gg < 0 || gg > 1) continue;
        const b = xc[i * 9 + o + 2] + yc[o + 2] + zc[j * 9 + o + 2];
        if (b < 0 || b > 1) continue;
        cnt[g][i * n + j]++; inAny = true;
      }
      if (inAny) any[i * n + j]++;
    }
  }
  const sat = (arr) => {
    const S = new Float64Array(N1 * N1);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[(i + 1) * N1 + j + 1] = arr[i * n + j] + S[i * N1 + j + 1] + S[(i + 1) * N1 + j] - S[i * N1 + j];
    return S;
  };
  SAT = { srgb: sat(cnt[0]), p3: sat(cnt[1]), adobe: sat(cnt[2]), any: sat(any) };
  // extremes and corners from the cube surfaces
  EXT = {};
  for (const g of GK) {
    let ma = 0, mb = 0, mc = 0;
    for (const { ax, s } of FACES) for (let i = 0; i <= 48; i++) for (let j = 0; j <= 48; j++) {
      const p = [0, 0, 0]; p[ax] = s; p[(ax + 1) % 3] = i / 48; p[(ax + 2) % 3] = j / 48;
      const l = paramPoint(g, p).lab;
      ma = Math.max(ma, Math.abs(l[1])); mb = Math.max(mb, Math.abs(l[2])); mc = Math.max(mc, Math.hypot(l[1], l[2]));
    }
    const corners = Object.entries(CORNER_NAMES).map(([i, nm]) => ({ nm, lab: paramPoint(g, corner(+i)).lab }));
    EXT[g] = { ma, mb, mc, corners };
  }
}
function satQuery(S, A) {
  const { n, step, half } = GRID, N1 = n + 1;
  const u = Math.min(n, Math.max(0, (A + half) / step)), l = Math.min(n, Math.max(0, (half - A) / step));
  const at = (x, y) => {
    const x0 = Math.min(n - 1, Math.floor(x)), y0 = Math.min(n - 1, Math.floor(y)), fx = x - x0, fy = y - y0;
    const s = (i, j) => S[i * N1 + j];
    return (s(x0, y0) * (1 - fx) + s(x0 + 1, y0) * fx) * (1 - fy) + (s(x0, y0 + 1) * (1 - fx) + s(x0 + 1, y0 + 1) * fx) * fy;
  };
  return at(u, u) - at(l, u) - at(u, l) + at(l, l);
}
function metrics(a) {
  const cell = GRID.step * GRID.step, boxVol = 100 * 4 * a * a, out = {};
  for (const g of [...GK, 'any']) {
    const tot = SAT[g][SAT[g].length - 1] * cell, inb = satQuery(SAT[g], a) * cell;
    out[g] = { vol: tot, inBox: inb, pGamutInBox: inb / tot, pBoxInGamut: inb / boxVol };
  }
  out.boxVol = boxVol;
  return out;
}
const pct = (v) => (v >= 0.99995 ? '100' : (Math.floor(v * 1000) / 10).toFixed(1)) + '%';
function updateStats() {
  if (!SAT) return;
  const a = A(), m = metrics(a);
  $('#kval2').textContent = state.k.toFixed(3);
  const row = (g) => {
    const e = EXT[g], kc = Math.max(e.ma, e.mb) / state.base;
    return `<tr><td><span class="chip" style="background:${ID[g]}"></span>${C.SPACES[g].short}</td><td>${(m[g].vol / 1000).toFixed(0)}k</td><td>${fmt(e.ma)}</td><td>${fmt(e.mb)}</td>
      <td class="${kc > state.k ? 'bad' : ''}">${kc.toFixed(3)}</td><td>${pct(m[g].pGamutInBox)}</td><td>${pct(m[g].pBoxInGamut)}</td></tr>`;
  };
  $('#stats').innerHTML = `<tr><th>Gamut</th><th title="volume in ΔE³">vol</th><th>|a*|max</th><th>|b*|max</th><th title="k at which the box contains the whole gamut">k fits</th><th title="share of the gamut inside the box">in box</th><th title="share of the box occupied by the gamut">of box</th></tr>
    ${GK.map(row).join('')}
    <tr><td class="dim">any of 3</td><td>${(m.any.vol / 1000).toFixed(0)}k</td><td></td><td></td><td></td><td>${pct(m.any.pGamutInBox)}</td><td>${pct(m.any.pBoxInGamut)}</td></tr>
    <tr><td class="dim">Lab box</td><td>${(m.boxVol / 1000).toFixed(0)}k</td><td colspan="5" class="dim" style="text-align:left;font-family:inherit">${pct(1 - m.any.pBoxInGamut)} of box volume is outside all three</td></tr>`;
  $('#corners').innerHTML = `<tr><th></th><th></th><th>L*</th><th>a*</th><th>b*</th><th>C*</th><th>h°</th></tr>` + GK.map((g) => EXT[g].corners.map(({ nm, lab }, i) => {
    const out = (v) => (Math.abs(v) > a ? 'bad' : '');
    return `<tr><td>${i ? '' : `<span class="chip" style="background:${ID[g]}"></span>${C.SPACES[g].short}`}</td><td>${nm}</td><td>${fmt(lab[0])}</td><td class="${out(lab[1])}">${fmt(lab[1])}</td><td class="${out(lab[2])}">${fmt(lab[2])}</td><td>${fmt(Math.hypot(lab[1], lab[2]))}</td><td>${fmt((Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360)}</td></tr>`;
  }).join('')).join('');
  drawKChart();
}

// coverage-vs-k chart
const kWrap = $('#kchartWrap');
const kCanvas = document.createElement('canvas'); kWrap.prepend(kCanvas);
const KMIN = 0.25, KMAX = 2;
let kHover = null, kCurves = null;
function kGeom() {
  const w = kWrap.clientWidth || 360, h = 150, p = { l: 32, r: 16, t: 8, b: 20 };
  return { w, h, p, x: (k) => p.l + (k - KMIN) / (KMAX - KMIN) * (w - p.l - p.r), y: (v) => p.t + (1 - v) * (h - p.t - p.b), k: (x) => KMIN + (x - p.l) / (w - p.l - p.r) * (KMAX - KMIN) };
}
function drawKChart() {
  if (!SAT) return;
  const G = kGeom(), d = DPR();
  kCanvas.width = G.w * d; kCanvas.height = G.h * d; kCanvas.style.height = G.h + 'px';
  const ctx = kCanvas.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = '#0e0e0f'; ctx.fillRect(0, 0, G.w, G.h);
  if (!kCurves || kCurves.base !== state.base || kCurves.white !== state.white) {
    const ks = Array.from({ length: 141 }, (_, i) => KMIN + (KMAX - KMIN) * i / 140);
    kCurves = { base: state.base, white: state.white, ks, m: ks.map((k) => metrics(k * state.base)) };
  }
  for (let v = 0; v <= 1; v += 0.25) {
    ctx.fillStyle = '#ffffff14'; ctx.fillRect(G.p.l, G.y(v), G.w - G.p.l - G.p.r, 1);
    axisText(ctx, (v * 100) + '%', G.p.l - 4, G.y(v), 'right', 'middle');
  }
  for (let k = 0.5; k <= 2; k += 0.25) axisText(ctx, k.toFixed(2), G.x(k), G.h - G.p.b + 5);
  ctx.lineWidth = 2;
  for (const g of GK) {
    for (const [field, dash] of [['pGamutInBox', []], ['pBoxInGamut', [5, 4]]]) {
      ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = ID[g];
      kCurves.ks.forEach((k, i) => { const p = [G.x(k), G.y(kCurves.m[i][g][field])]; i ? ctx.lineTo(...p) : ctx.moveTo(...p); });
      ctx.stroke();
    }
    const kc = Math.max(EXT[g].ma, EXT[g].mb) / state.base;
    if (kc <= KMAX) { ctx.setLineDash([]); ctx.fillStyle = ID[g]; ctx.beginPath(); ctx.arc(G.x(kc), G.y(1), 3.5, 0, 7); ctx.fill(); }
  }
  ctx.setLineDash([]);
  const kx = G.x(Math.min(KMAX, Math.max(KMIN, state.k)));
  ctx.fillStyle = BOX_ID; ctx.fillRect(kx - 1, G.p.t, 2, G.h - G.p.t - G.p.b);
  if (kHover != null) { ctx.fillStyle = '#ffffff66'; ctx.fillRect(G.x(kHover), G.p.t, 1, G.h - G.p.t - G.p.b); }
}
kWrap.addEventListener('pointermove', (e) => {
  if (!SAT) return;
  const r = kCanvas.getBoundingClientRect(), x = e.clientX - r.left, G = kGeom();
  const k = G.k(x);
  if (k < KMIN || k > KMAX) { kHover = null; $('#ktip').style.display = 'none'; drawKChart(); return; }
  kHover = k; const m = metrics(k * state.base);
  const tip = $('#ktip');
  tip.innerHTML = `k ${k.toFixed(2)} · ±${(k * state.base).toFixed(0)}<br>` + GK.map((g) => `<span class="chip" style="background:${ID[g]}"></span>${C.SPACES[g].short.padEnd(5, ' ')} in box ${pct(m[g].pGamutInBox).padStart(6)} · of box ${pct(m[g].pBoxInGamut).padStart(6)}`).join('<br>');
  tip.style.display = 'block';
  tip.style.left = Math.min(x + 12, G.w - tip.offsetWidth - 2) + 'px'; tip.style.top = (G.h + 4) + 'px';
  if (e.buttons) set({ k: Math.round(k * 200) / 200 }, 'k');
  drawKChart();
});
kWrap.addEventListener('pointerleave', () => { kHover = null; $('#ktip').style.display = 'none'; drawKChart(); });
kWrap.addEventListener('pointerdown', (e) => { const r = kCanvas.getBoundingClientRect(); const k = kGeom().k(e.clientX - r.left); if (k >= KMIN && k <= KMAX) set({ k: Math.round(k * 200) / 200 }, 'k'); });

// ---------------------------------------------------------------- controls wiring
const viewSel = $('#viewSel');
viewSel.innerHTML = [['lab', 'labn', 'oklab', 'xyz'], GK.map((g) => g + '_enc'), GK.map((g) => g + '_lin')]
  .map((grp, i) => `<optgroup label="${['Perceptual / CIE', 'Encoded RGB cubes', 'Linear RGB cubes'][i]}">${grp.map((k) => `<option value="${k}">${VIEWS[k].name}</option>`).join('')}</optgroup>`).join('');

function syncControls() {
  $('#k').value = Math.min(2, Math.max(0.25, state.k)); $('#kNum').value = state.k;
  $('#base').value = state.base; $('#white').value = state.white;
  $('#Aval').textContent = fmt(A(), 1);
  viewSel.value = state.view; $('#ortho').checked = state.ortho; $('#axes').checked = state.axes; $('#bg').value = state.bg;
  for (const tr of document.querySelectorAll('.layers tr[data-o]')) for (const cb of tr.querySelectorAll('input')) cb.checked = state.layers[tr.dataset.o][cb.dataset.l];
  $('#faceOp').value = state.faceOp; $('#sliceOp').value = state.sliceOp; $('#showL').checked = state.showL; $('#showH').checked = state.showH; $('#showS').checked = state.showS;
  syncSurfControls();
  $('#disp').value = state.disp; $('#oog').value = state.oog; $('#ref').value = state.ref;
  $('#cloudOn').checked = state.cloudOn; $('#cloudSpace').value = state.cloudSpace; $('#cloudAlpha').value = state.cloudAlpha;
  $('#cloudAlphaVal').textContent = Math.pow(10, state.cloudAlpha).toPrecision(2); cloudInfo();
  $('#Lsl').value = state.L; $('#Lval').textContent = fmt(state.L); $('#hsl').value = state.hue % 180; $('#hval').textContent = fmt(state.hue);
  $('#dispNote').textContent = state.disp === 'p3'
    ? (GL_P3 && P3_OK ? 'Rendering in Display P3: colors outside sRGB are shown as they are.' : 'Display P3 is selected, but this screen or browser reports no P3 support, so colors may be clamped.')
    : 'Rendering in sRGB: P3 and Adobe colors outside sRGB are clipped.';
}
// what: 'all' | 'k' | 'slice' | 'style' | 'view'
function set(patch, what = 'all') {
  Object.assign(state, patch);
  save(); syncControls(); updateUniforms(); updateLegend();
  if (what === 'white') { C.setLabWhite(state.white); updateUniforms(); computeStats(); kCurves = null; }
  if (what === 'disp') { applyBg(); setupCanvases(); }
  if (what !== 'slice') rebuildMain();
  rebuildSlices();
  if (what === 'style') { for (const c of [abCanvas, hCanvas, sCanvas]) c._cache = null; }
  drawSlices();
  if (what !== 'slice' && what !== 'style') updateStats();
  updateCloud();
}
const num = (el) => parseFloat(el.value);
$('#k').addEventListener('input', (e) => set({ k: num(e.target) }, 'k'));
$('#kNum').addEventListener('change', (e) => { const v = num(e.target); if (v > 0) set({ k: v }, 'k'); });
$('#base').addEventListener('change', (e) => { const v = num(e.target); if (v > 0) set({ base: v }, 'k'); });
$('#white').addEventListener('change', (e) => set({ white: e.target.value }, 'white'));
viewSel.addEventListener('change', (e) => set({ view: e.target.value }, 'view'));
$('#ortho').addEventListener('change', (e) => { state.ortho = e.target.checked; save(); setOrtho(state.ortho); });
$('#axes').addEventListener('change', (e) => set({ axes: e.target.checked }, 'view'));
$('#bg').addEventListener('change', (e) => { state.bg = e.target.value; save(); applyBg(); });
for (const tr of document.querySelectorAll('.layers tr[data-o]')) for (const cb of tr.querySelectorAll('input')) {
  cb.addEventListener('change', () => { state.layers[tr.dataset.o][cb.dataset.l] = cb.checked; set({}, 'view'); });
}
$('#faceOp').addEventListener('input', (e) => { state.faceOp = num(e.target); save(); updateUniforms(); });
$('#sliceOp').addEventListener('input', (e) => { state.sliceOp = num(e.target); save(); updateUniforms(); });
$('#showL').addEventListener('change', (e) => set({ showL: e.target.checked }, 'slice'));
$('#showH').addEventListener('change', (e) => set({ showH: e.target.checked }, 'slice'));
$('#showS').addEventListener('change', (e) => set({ showS: e.target.checked }, 'slice'));
const SURF_RANGE = { sat: { min: 0, max: 5, step: 0.01, key: 'sat' }, chroma: { min: 0, max: 200, step: 0.5, key: 'chroma' } };
function syncSurfControls() {
  const r = SURF_RANGE[state.sMode];
  $('#sMode').value = state.sMode;
  for (const el of [$('#ssl'), $('#sNum')]) { el.min = r.min; el.max = r.max; el.step = r.step; el.value = state[r.key]; }
}
$('#sMode').addEventListener('change', (e) => set({ sMode: e.target.value }, 'slice'));
$('#ssl').addEventListener('input', (e) => set({ [SURF_RANGE[state.sMode].key]: num(e.target) }, 'slice'));
$('#sNum').addEventListener('change', (e) => { const v = num(e.target); if (v >= 0) set({ [SURF_RANGE[state.sMode].key]: v }, 'slice'); });
$('#disp').addEventListener('change', (e) => set({ disp: e.target.value }, 'disp'));
$('#oog').addEventListener('change', (e) => set({ oog: e.target.value }, 'style'));
$('#ref').addEventListener('change', (e) => set({ ref: e.target.value }, 'style'));
$('#Lsl').addEventListener('input', (e) => set({ L: num(e.target) }, 'slice'));
$('#hsl').addEventListener('input', (e) => set({ hue: num(e.target) }, 'slice'));
$('#cloudOn').addEventListener('change', (e) => { state.cloudOn = e.target.checked; save(); updateLegend(); updateCloud(); });
$('#cloudSpace').addEventListener('change', (e) => { state.cloudSpace = e.target.value; save(); syncControls(); updateLegend(); updateCloud(); });
$('#cloudAlpha').addEventListener('input', (e) => { state.cloudAlpha = num(e.target); save(); syncControls(); updateCloud(); });
$('#cloudPick').addEventListener('click', () => $('#cloudFile').click());
$('#cloudFile').addEventListener('change', (e) => { loadCloud(e.target.files[0]); e.target.value = ''; });
$('#cloudClear').addEventListener('click', () => { cloudImg = null; cloudKey = ''; syncControls(); updateLegend(); updateCloud(); });
// Drag and drop anywhere on the page. dragenter/leave fire per child element, so count depth.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  loadCloud([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')) || e.dataTransfer.files[0]);
});

function applyBg() {
  const bg = { dark: 0x161618, grey: 0x777777, black: 0x000000 }[state.bg];
  renderer.setClearColor(bg);
  gridMat.color.setHex(state.bg === 'grey' ? 0x5a5a5e : 0x3e3e44);
  if (GL_P3) gl.drawingBufferColorSpace = state.disp === 'p3' ? 'display-p3' : 'srgb';
}

// ---------------------------------------------------------------- resize + loop
function resize() {
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setPixelRatio(DPR());
  renderer.setSize(w, h); labelRenderer.setSize(w, h);
  persp.aspect = w / h; persp.updateProjectionMatrix();
  if (camera === orthoCam) {
    const hh = (orthoCam.top - orthoCam.bottom) / 2;
    orthoCam.left = -hh * w / h; orthoCam.right = hh * w / h; orthoCam.updateProjectionMatrix();
  }
  for (const m of lineMats) m.resolution.set(w, h);
  U.uDpr.value = DPR();
  cloudMat.uniforms.uSize.value = cloudSize();
}
let resizeT = 0;
new ResizeObserver(() => {
  resize();
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (abCanvas && Math.abs(abWrap.clientWidth - abCanvas._w) > 1) setupCanvases(); drawKChart(); }, 120);
}).observe(document.body);

function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot
applyBg();
resize();
if (state.ortho) { state.ortho = false; camPreset('iso'); state.ortho = true; setOrtho(true); } else camPreset('iso');
syncControls(); updateUniforms(); updateLegend();
rebuildMain(); rebuildSlices();
setupCanvases();
window.labbox = { set, state, camPreset };
loop();
setTimeout(() => { computeStats(); updateStats(); }, 30);
