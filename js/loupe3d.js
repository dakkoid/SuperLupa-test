// Smart loupe over a leaf: a small real-time scene. The leaf and the stone are procedural (GLSL), the loupe is
// modelled from the poster; its lens shows the scene behind it magnified 2×–20× (the "digital zoom" of the product).
// Drag to move the loupe over the leaf; the buttons switch the zoom.
import * as THREE from './three.module.min.js';
import { EffectComposer } from './pp/EffectComposer.js';
import { RenderPass } from './pp/RenderPass.js';
import { UnrealBloomPass } from './pp/UnrealBloomPass.js';
import { OutputPass } from './pp/OutputPass.js';

const SEG = 180;
const LEVELS = [
  { label: '2×', m: 2, card: ['ЛИСТ', 'СТРУКТУРА'] },
  { label: '5×', m: 5, card: ['ЖИЛКОВАНИЕ', 'СЕТЧАТОЕ'] },
  { label: '10×', m: 10, card: ['АРЕОЛЫ', 'МЕЛКИЕ ЖИЛКИ'] },
  { label: '20×', m: 20, card: ['ТКАНЬ', 'КЛЕТКИ'] },
];
const CYAN = '#5FD4FF';
const TILT = 1.0;                     // handle toward the lower right
const SCALE = .62;                    // loupe size against the leaf (glass radius in scene units)
const LIFT = 2.7;                     // distance from the leaf to the glass, along the view ray
const MM_PER_UNIT = 15;               // the leaf is ~9 cm long
const LEAF = { a: 0.42, L: 6.0, ox: -2.7393, oz: -1.2233 };

// ------------------------------------------------------------------ helpers
function filleted(pts, steps = 10) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y, f = 0] = pts[i];
    if (!f || i === 0 || i === pts.length - 1) { out.push(new THREE.Vector2(x, y)); continue; }
    const p = new THREE.Vector2(x, y), a = new THREE.Vector2(pts[i - 1][0], pts[i - 1][1]), b = new THREE.Vector2(pts[i + 1][0], pts[i + 1][1]);
    const da = a.clone().sub(p).normalize(), db = b.clone().sub(p).normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(da.dot(db), -1, 1));
    const t = Math.min(f / Math.tan(ang / 2), a.distanceTo(p) * .49, b.distanceTo(p) * .49);
    const p0 = p.clone().add(da.clone().multiplyScalar(t)), p1 = p.clone().add(db.clone().multiplyScalar(t));
    for (let k = 0; k <= steps; k++) {
      const q = k / steps, u = 1 - q;
      out.push(new THREE.Vector2(u * u * p0.x + 2 * u * q * p.x + q * q * p1.x, u * u * p0.y + 2 * u * q * p.y + q * q * p1.y));
    }
  }
  return out;
}
const lathe = (pts, seg = SEG) => new THREE.LatheGeometry(filleted(pts), seg);
const easeIO = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// fine circumferential lathe-turned streaks: normal map whose bumps run around the handle
function brushedNormal() {
  const w = 64, h = 1024, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), r = rng(7);
  const row = new Float32Array(h); let v = 0;
  for (let y = 0; y < h; y++) { v = v * .55 + (r() - .5); row[y] = v; }
  for (let y = 0; y < h; y++) {
    const d = (row[(y + 1) % h] - row[(y + h - 1) % h]) * .5;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = 128; img.data[i + 1] = 128 + d * 60; img.data[i + 2] = 255; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ------------------------------------------------------------------ HUD drawn on the transparent screen
class Hud {
  constructor(thumb) {
    this.S = 1024; this.c = document.createElement('canvas'); this.c.width = this.c.height = this.S;
    this.g = this.c.getContext('2d'); this.thumb = thumb;
    this.tex = new THREE.CanvasTexture(this.c); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 8;
  }
  draw(st) {
    const g = this.g, S = this.S, C = S / 2;
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath(); g.arc(C, C, C - 6, 0, Math.PI * 2); g.clip();
    const cyan = (a) => `rgba(95,212,255,${a})`, white = (a) => `rgba(240,250,255,${a})`;
    const glassFill = 'rgba(6,20,28,.5)';
    const ls = (v) => { if ('letterSpacing' in g) g.letterSpacing = v; };
    // outer tick ring
    g.strokeStyle = white(.22); g.lineWidth = 2.5;
    for (let i = 0; i < 96; i++) {
      const a = i / 96 * Math.PI * 2, r0 = C - 18, r1 = r0 - (i % 8 === 0 ? 20 : 9);
      g.beginPath(); g.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); g.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); g.stroke();
    }
    // recognition card (top left); the label types in after each switch
    const ca = st.card;
    g.globalAlpha = ca.alpha;
    g.font = '800 46px Montserrat, sans-serif'; ls('0px');
    const tw0 = g.measureText(ca.text[0]).width;
    g.font = '700 25px Montserrat, sans-serif'; ls('3px');
    const tw1 = g.measureText(ca.text[1]).width;
    const cx = 178, cy = 214, ch = 118, cw = Math.max(tw0, tw1) + 132;
    roundRect(g, cx, cy, cw, ch, 22); g.fillStyle = glassFill; g.fill(); g.strokeStyle = white(.6); g.lineWidth = 3; g.stroke();
    g.save(); g.translate(cx + 54, cy + 59); g.rotate(-.7); g.strokeStyle = white(.95); g.lineWidth = 4.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, -32); g.quadraticCurveTo(27, -5, 0, 30); g.quadraticCurveTo(-27, -5, 0, -32); g.stroke();
    g.beginPath(); g.moveTo(0, -18); g.lineTo(0, 40); g.stroke(); g.restore();
    const n1 = Math.round(ca.type * ca.text[0].length), n2 = Math.round(THREE.MathUtils.clamp(ca.type * 1.6 - .6, 0, 1) * ca.text[1].length);
    g.fillStyle = white(1); g.font = '800 46px Montserrat, sans-serif'; ls('0px');
    g.fillText(ca.text[0].slice(0, n1), cx + 102, cy + 58);
    g.fillStyle = white(.78); g.font = '700 25px Montserrat, sans-serif'; ls('3px');
    g.fillText(ca.text[1].slice(0, n2), cx + 104, cy + 96);
    ls('0px');
    // thumbnail of the detected structure
    const tx = cx, ty = cy + ch + 18, tW = 196, tH = 150;
    g.save(); roundRect(g, tx, ty, tW, tH, 18); g.clip();
    if (this.thumb && this.thumb.complete) g.drawImage(this.thumb, 280, 300, 420, 322, tx, ty, tW, tH);
    g.fillStyle = 'rgba(6,20,28,.2)'; g.fillRect(tx, ty, tW, tH); g.restore();
    roundRect(g, tx, ty, tW, tH, 18); g.strokeStyle = white(.6); g.lineWidth = 3; g.stroke();
    g.globalAlpha = 1;
    // measurement frame, dashed leader, scale bar and readout
    const m = st.measure, mx = 610, my = 548, ms = 132 * m.scale;
    g.globalAlpha = m.alpha;
    g.strokeStyle = cyan(.4); g.lineWidth = 2; g.strokeRect(mx - ms / 2, my - ms / 2, ms, ms);
    g.strokeStyle = cyan(1); g.lineWidth = 5; g.lineCap = 'round';
    const k = 28;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = mx + sx * ms / 2, y = my + sy * ms / 2;
      g.beginPath(); g.moveTo(x - sx * k, y); g.lineTo(x, y); g.lineTo(x, y - sy * k); g.stroke();
    }
    g.fillStyle = cyan(1); g.beginPath(); g.arc(mx, my, 5, 0, Math.PI * 2); g.fill();
    g.setLineDash([9, 9]); g.strokeStyle = white(.85); g.lineWidth = 3;
    const lx = mx + ms / 2 + 4, ly = my + 26;
    g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 40, ly + 40); g.lineTo(lx + 64, ly + 40); g.stroke();
    g.setLineDash([]);
    const bx = lx + 74, by = ly + 40;
    g.strokeStyle = white(1); g.lineWidth = 4;
    g.beginPath(); g.moveTo(bx, by - 12); g.lineTo(bx, by + 12); g.moveTo(bx, by); g.lineTo(bx + 92, by); g.moveTo(bx + 92, by - 12); g.lineTo(bx + 92, by + 12); g.stroke();
    g.fillStyle = white(1); g.font = '700 32px Montserrat, sans-serif';
    g.fillText(m.text, bx - 4, by - 24);
    g.globalAlpha = 1;
    // zoom pills
    const pw = 640, ph = 96, px = C - pw / 2, py = 752;
    roundRect(g, px, py, pw, ph, ph / 2); g.fillStyle = glassFill; g.fill(); g.strokeStyle = white(.45); g.lineWidth = 3; g.stroke();
    const slot = (pw - 24) / 4, ax = px + 12 + slot * (st.pill + .5);
    roundRect(g, ax - slot / 2 + 6, py + 12, slot - 12, ph - 24, (ph - 24) / 2);
    g.fillStyle = cyan(.24); g.fill(); g.strokeStyle = cyan(1); g.lineWidth = 4.5; g.stroke();
    g.font = '700 40px Montserrat, sans-serif'; g.textAlign = 'center';
    LEVELS.forEach((L, i) => {
      const on = 1 - Math.min(1, Math.abs(st.pill - i));
      g.fillStyle = white(.7 + .3 * on);
      g.fillText(L.label, px + 12 + slot * (i + .5), py + ph / 2 + 14);
    });
    g.textAlign = 'left';
    g.restore();
    this.tex.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ studio environment: dark room, a few soft boxes
function studio() {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial({ color: '#0d0f11', side: THREE.BackSide })));
  const panel = (w, h, col, k, pos, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look); env.add(m);
  };
  panel(14, 5, '#fff6ea', 5.0, [0, 12, 3], [0, 0, 0]);          // overhead soft box
  panel(2.2, 16, '#ffffff', 7.0, [11, 1, 6], [0, 0, 0]);        // key strip, right front
  panel(1.6, 14, '#ffe2c0', 3.0, [-12, 0, -4], [0, 0, 0]);      // warm strip, left back
  panel(10, 1.2, '#9fe9ff', 1.1, [0, -8, 9], [0, 0, 0]);        // cool floor bounce
  panel(6, 6, '#ffffff', 1.4, [-6, 3, 13], [0, 0, 0]);          // frontal fill
  return env;
}

// ------------------------------------------------------------------ the scene: procedural leaf on dark stone (GLSL)
// One shading function is used twice: by the ground plane, and by the lens, which evaluates the same scene
// at magnified coordinates. The leaf is procedural, so it stays sharp at any zoom: veins → areoles → cells → chloroplasts.
const SCENE_GLSL = /* glsl */`
uniform vec3 uLight;
uniform vec3 uLensC; uniform vec3 uLensN; uniform float uLensR;
uniform vec3 uHA; uniform vec3 uHB; uniform float uHR;
uniform vec3 uCaus; uniform float uCausK;
#define PI 3.14159265
const vec2 LEAF_O = vec2(${LEAF.ox.toFixed(3)}, ${LEAF.oz.toFixed(3)});
const float LEAF_A = ${LEAF.a.toFixed(4)};
const float LEAF_L = ${LEAF.L.toFixed(3)};
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float h1(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 65536);
  q *= uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967295.0);
}
vec2 h2(vec2 p) { return vec2(h1(p), h1(p + vec2(311.0, 173.0))); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i; vec2 u = f * f * (3. - 2. * f);
  return mix(mix(h1(i), h1(i + vec2(1, 0)), u.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), u.x), u.y);
}
// x: distance to the nearest site, y: ~distance to the cell wall, z: random value of the cell (all in cell units)
vec3 voro(vec2 p, float jit) {
  vec2 n = floor(p), f = p - n; float d1 = 9., d2 = 9.; vec2 id = n;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + .5 + jit * (h2(n + g) - .5) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = n + g; } else if (d < d2) d2 = d;
  }
  d1 = sqrt(d1); d2 = sqrt(d2);
  return vec3(d1, .5 * (d2 - d1), h1(id + 7.));
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
// thin line of half-width w at distance d, antialiased; lines thinner than a pixel fade instead of shimmering
float lineM(float d, float w, float fp) { return (1. - smoothstep(w - fp * .5, w + fp * .5, d)) * clamp(2. * w / fp, 0., 1.); }
float fadeL(float s, float fp) { return smoothstep(2.5 * fp, 7. * fp, s); }

vec2 leafSpace(vec2 p) { vec2 d = p - LEAF_O; float c = cos(LEAF_A), s = sin(LEAF_A); return vec2(c * d.x + s * d.y, -s * d.x + c * d.y); }
float midY(float x) { return .09 * sin(PI * clamp(x / LEAF_L, 0., 1.)); }
float halfW(float x) { float t = clamp(x / LEAF_L, 0., 1.); return 3.0 * pow(t, .55) * pow(1. - t, .85); }
float edgeW(float x) { float s = fract(x / .23); return halfW(x) * (.93 + .08 * s * s); }
float leafCov(vec2 p, float fp) {
  vec2 q = leafSpace(p); float y = abs(q.y - midY(q.x)), ew = edgeW(q.x);
  float c = (1. - smoothstep(ew - fp, ew + fp, y)) * step(0., q.x) * step(q.x, LEAF_L);
  float pet = (1. - smoothstep(.03 - fp, .03 + fp, y)) * step(-.85, q.x) * step(q.x, .05);
  return max(c, pet);
}
vec3 groundCol(vec2 p, float fp) {
  float n = vnoise(p * 1.1) * .55 + vnoise(p * 6.) * .3 + vnoise(p * 23.) * .15;
  float g = (vnoise(p * 90.) - .5) * smoothstep(.03, .006, fp) * .9
          + (vnoise(p * 420.) - .5) * smoothstep(.006, .0015, fp) * .9
          + (h1(p * 1900.) - .5) * smoothstep(.0015, .0004, fp) * .9;
  float sp = step(.985, h1(p * 260.)) * smoothstep(.01, .003, fp) * .8;          // tiny mineral glints
  return srgb(vec3(.165, .172, .18)) * (.7 + .55 * n + .35 * g + sp);
}
vec4 leafCol(vec2 p, float fp) {
  vec2 q = leafSpace(p); float x = q.x, y = q.y - midY(q.x), ay = abs(y), t = clamp(x / LEAF_L, 0., 1.);
  float cov = leafCov(p, fp);
  if (cov <= 0.) return vec4(0.);
  float big = vnoise(q * 1.6) * .6 + vnoise(q * 5.5) * .4;
  float ew = max(edgeW(x), .02);
  vec3 c = mix(srgb(vec3(.11, .27, .05)), srgb(vec3(.33, .56, .13)), clamp(.25 + .45 * (1. - ay / ew) + .45 * (big - .5) - .12 * t, 0., 1.));
  c *= .92 + .16 * vnoise(q * 40.) * smoothstep(.02, .004, fp);
  c *= .82 + .3 * smoothstep(.25, .75, vnoise(q * 2.7 + 5.));
  c *= 1. - .35 * smoothstep(.72, 1., ay / ew);
  c = mix(c, srgb(vec3(.42, .52, .12)), .35 * smoothstep(.8, 1., t));
  // --- tissue: cells and chloroplasts (only when they are large enough on screen)
  float fC = fadeL(.0045, fp);
  if (fC > 0.) {
    vec3 vC = voro(q / .0045, .9);
    float wall = lineM(vC.y * .0045, .00038, fp);
    float dome = 1. - vC.x * vC.x;
    c *= mix(1., (1. + (vC.z - .5) * .2) * (.74 + .34 * dome), fC);
    c = mix(c, srgb(vec3(.12, .27, .05)), wall * .6 * fC);
    float fK = fadeL(.0012, fp);
    if (fK > 0.) {
      vec3 vK = voro(q / .0012, .9);
      float blob = (1. - smoothstep(.24, .32, vK.x)) * smoothstep(.12, .3, vC.y);
      c = mix(c, srgb(vec3(.08, .30, .04)), blob * .75 * fK);
    }
  }
  vec3 vein = srgb(vec3(.66, .78, .34));
  // --- minor venation: two nested closed networks (areoles)
  float fB = fadeL(.018, fp);
  if (fB > 0.) {
    vec3 vB = voro(q / .018 + 31.7, .85); float dB = vB.y * .018;
    c *= 1. - .14 * lineM(dB, .0022, fp) * fB;                              // soft dark flank
    c = mix(c, vein * .78, lineM(dB, .0009, fp) * .6 * fB);
  }
  vec3 vA = voro(q / .07, .85); float dA = vA.y * .07; float fA = fadeL(.07, fp);
  c *= mix(1., .9 + .16 * (1. - vA.x * vA.x) + (vA.z - .5) * .1, fA);
  c *= 1. - .18 * lineM(dA, .0065, fp) * fA;
  c = mix(c, vein * .85, lineM(dA, .003, fp) * .75 * fA * (.55 + .45 * smoothstep(.006, .002, fp)));
  // --- secondary veins (side of the point only), tube shading
  float sg = y >= 0. ? 1. : -1.;
  float dS = 9., wS = .02;
  for (int i = 0; i < 9; i++) {
    float hi = h1(vec2(float(i), sg * 3.));
    float xi = .32 + float(i) * .56 + (hi - .5) * .22;
    float Wv = halfW(xi + .45) * (.9 + .25 * h1(vec2(float(i) + 9., sg)));
    vec2 P0 = vec2(xi, 0.), P1 = P0 + vec2(.28 * Wv + .08, sg * .40 * Wv), P2 = P0 + vec2(.75 * Wv + .16, sg * .74 * Wv), P3 = P0 + vec2(1.35 * Wv + .24, sg * .93 * Wv);
    float d = min(min(segD(vec2(x, y), P0, P1), segD(vec2(x, y), P1, P2)), segD(vec2(x, y), P2, P3));
    float w = .015 * (1. - .5 * float(i) / 8.) * (1. - .5 * smoothstep(0., 1.1 * Wv, length(vec2(x, y) - P0)));
    if (d - w < dS - wS) { dS = d; wS = w; }
  }
  float mS = lineM(dS, wS, fp);
  c *= 1. - .3 * (lineM(dS, wS * 1.7, fp) - mS);
  float prS = sqrt(clamp(1. - (dS / wS) * (dS / wS), 0., 1.));
  c = mix(c, vein * (.68 + .36 * prS), mS);
  // --- midrib, with elongated cells along it at high zoom
  float wM = .036 * (1. - t) + .009;
  float mM = lineM(ay, wM, fp) * step(-.85, x);
  c *= 1. - .3 * (lineM(ay, wM * 1.6, fp) - mM);
  float prM = sqrt(clamp(1. - (ay / wM) * (ay / wM), 0., 1.));
  vec3 mid = vein * (.66 + .38 * prM);
  float fM = fadeL(.0035, fp);
  if (fM > 0. && mM > 0.) {
    vec3 vM = voro(vec2(x / .013, y / .0035) + 91.3, .6);
    mid *= mix(1., (1. + (vM.z - .5) * .12) * (1. - .22 * lineM(vM.y * .0035, .00025, fp)), fM);
  }
  c = mix(c, mid, mM);
  return vec4(c, cov);
}
float loupeShadow(vec3 P) {
  vec3 L = uLight; float s = 1.;
  float dn = dot(L, uLensN);
  if (abs(dn) > 1e-3) {
    float t = dot(uLensC - P, uLensN) / dn;
    if (t > 0.) {
      vec3 q = P + L * t; float r = length(q - uLensC) / uLensR;
      float soft = .03 + t * .05;
      float ring = smoothstep(.93 - soft, .95, r) * (1. - smoothstep(1.14, 1.16 + soft, r));
      float glass = 1. - smoothstep(.93 - soft, .95, r);
      s = min(1. - .85 * ring, 1. - .4 * glass);
    }
  }
  vec3 d2 = uHB - uHA, w = P - uHA;
  float e = dot(d2, d2), f = dot(d2, w), b = dot(L, d2), c = dot(L, w);
  float u = clamp((f - c * b) / max(e - b * b, 1e-5), 0., 1.);
  float sl = u * b - c;
  if (sl > 0.) {
    float dist = length(w + L * sl - d2 * u);
    s = min(s, 1. - .82 * (1. - smoothstep(uHR * .7, uHR * 1.25 + sl * .05, dist)));
  }
  return s;
}
vec3 sceneColor(vec3 P, float fp, vec3 V) {
  vec2 p = P.xz;
  vec3 g = groundCol(p, fp);
  vec2 lo = uLight.xz / uLight.y * .025;                       // the leaf lies slightly above the stone
  g *= 1. - .5 * leafCov(p - lo, max(fp, .006));
  vec4 lf = leafCol(p, fp);
  vec3 c = mix(g, lf.rgb, lf.a);
  float sh = loupeShadow(P);
  vec2 qq = leafSpace(p); float bump = vnoise(qq * 9.) * .6 + vnoise(qq * 31.) * .4;
  float spec = pow(max(dot(normalize(uLight + V), vec3(0., 1., 0.)), 0.), 140.) * (.2 + 1.2 * bump * bump) * lf.a * .35;
  float caus = uCausK * exp(-dot(P.xz - uCaus.xz, P.xz - uCaus.xz) / (.045 * .045));
  return c * (.4 + .85 * sh) + c * caus * vec3(1.7, 1.55, 1.2) + spec * sh * vec3(.55, .6, .5);
}
`;
const groundVert = /* glsl */`varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const groundFrag = /* glsl */`
${SCENE_GLSL}
uniform vec3 uBg;
varying vec3 vW;
void main() {
  float fp = max(length(fwidth(vW.xz)), 1e-6);
  vec3 c = sceneColor(vW, fp, normalize(cameraPosition - vW));
  float d = length(vW.xz - cameraPosition.xz * .25);
  c = mix(c, uBg, smoothstep(5.5, 13., d));
  gl_FragColor = vec4(c, 1.0);
}`;
const lensVert = /* glsl */`varying vec3 vW; varying vec2 vL; void main(){ vL = position.xy; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const lensFrag = /* glsl */`
${SCENE_GLSL}
uniform float uM; uniform vec3 uFocus; uniform vec3 uBg; uniform float uGain; uniform float uScan;
varying vec3 vW; varying vec2 vL;
void main() {
  float r = length(vL) / .97;
  vec3 ro = cameraPosition, rd = normalize(vW - ro);
  vec3 col = uBg;
  if (rd.y < -1e-3) {
    vec3 Q = ro + rd * (-ro.y / rd.y);
    vec3 P = uFocus + (Q - uFocus) / uM * (.9 + .1 * r * r);   // digital zoom around what the lens centre looks at
    P.y = 0.;
    float fp = max(length(fwidth(P.xz)), 1e-7);
    col = sceneColor(P, fp, -rd);
    col = mix(col, uBg, smoothstep(5.5, 13., length(P.xz)));
  }
  col *= mix(1., .5, smoothstep(.72, 1., r));
  float band = exp(-pow((vL.y / .97 * .5 + .5 - uScan) * 24.0, 2.0)) * step(.001, uScan) * step(uScan, .999);
  col += vec3(.2, .65, 1.) * band * .25;
  gl_FragColor = vec4(col * uGain, 1.0);
}`;
// ------------------------------------------------------------------ the loupe model
function buildLoupe(lensMat, hud) {
  const grp = new THREE.Group();
  const add = (geo, mat, parent = grp) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };
  const brushed = brushedNormal(); brushed.repeat.set(1, 6);
  const chrome = new THREE.MeshPhysicalMaterial({ color: '#dcd8d2', metalness: 1, roughness: .13, clearcoat: .4, clearcoatRoughness: .1 });
  const satin = new THREE.MeshPhysicalMaterial({ color: '#cdc7bd', metalness: 1, roughness: .26, normalMap: brushed, normalScale: new THREE.Vector2(.5, .5),
    anisotropy: .75, anisotropyRotation: Math.PI / 2 });
  const black = new THREE.MeshPhysicalMaterial({ color: '#0f1113', roughness: .3, clearcoat: .8, clearcoatRoughness: .15 });
  const led = new THREE.MeshStandardMaterial({ color: '#06222c', emissive: CYAN, emissiveIntensity: 2.4 });

  const head = new THREE.Group(); head.rotation.x = Math.PI / 2; grp.add(head);
  add(lathe([[.985, 0], [.985, -.105, .025], [1.075, -.13, .05], [1.135, -.07, .06], [1.135, .07, .06], [1.075, .13, .05], [.985, .105, .025], [.985, 0]]), chrome, head);
  add(lathe([[.95, -.03], [.992, -.03, .01], [.992, .03, .01], [.95, .03]]), black, head);
  // the lens itself: shows the scene behind it, magnified (lensMat), under a reflective glass skin and the HUD
  const face = new THREE.Group(); face.rotation.z = -TILT; grp.add(face);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(.97, 128), lensMat); face.add(disc);
  // glass skin: only reflections (fresnel + two soft-box highlights), added on top of the lens image
  const skin = new THREE.ShaderMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vW; varying vec3 vN;
      void main(){
        vec3 V = normalize(cameraPosition - vW), n = normalize(vN); if (dot(n, V) < 0.) n = -n;
        float fr = .03 + .6 * pow(1. - max(dot(V, n), 0.), 5.);
        vec3 R = reflect(-V, n);
        float box = pow(max(dot(R, normalize(vec3(-.35, 1., -.25))), 0.), 90.) * 1.6;
        float strip = smoothstep(.985, .998, dot(R, normalize(vec3(.8, .45, .4)))) * .7;
        gl_FragColor = vec4(vec3(.92, .96, 1.) * (fr * .35 + (box + strip) * (.25 + fr)), 1.);
      }` });
  const dome = add(lathe([[0, .05], [.5, .04], [.85, .024], [.975, .012]], 128), skin, head); dome.renderOrder = 1;
  const hudMat = new THREE.MeshBasicMaterial({ map: hud.tex, transparent: true, depthWrite: false, color: new THREE.Color(1.3, 1.3, 1.3) });
  const hudMesh = new THREE.Mesh(new THREE.CircleGeometry(.97, 128), hudMat); hudMesh.position.z = .056; hudMesh.renderOrder = 2; face.add(hudMesh);

  add(lathe([[.12, -1.62], [.15, -1.6, .02], [.13, -1.46, .06], [.168, -1.31, .07], [.13, -1.13, .05], [.11, -1.06]]), chrome);
  add(lathe([[.15, -1.72], [.163, -1.71, .01], [.163, -1.61, .01], [.15, -1.6]]), black);
  add(new THREE.TorusGeometry(.1645, .006, 12, 96).rotateX(Math.PI / 2).translate(0, -1.665, 0), led);
  add(lathe([[.182, -2.02], [.188, -2.0, .01], [.188, -1.77, .015], [.168, -1.73, .015], [.15, -1.72]]), chrome);
  add(lathe([[.212, -4.5], [.214, -4.48], [.19, -2.04, .02], [.182, -2.02]]), satin);
  add(lathe([[.19, -4.57], [.21, -4.56, .006], [.21, -4.51, .006], [.19, -4.5]]), black);
  add(lathe([[0, -4.76], [.14, -4.74, .06], [.212, -4.65, .07], [.212, -4.57]]), chrome);
  const btn = new THREE.Mesh(new THREE.CapsuleGeometry(.03, .09, 6, 18), black); btn.position.set(0, -1.885, .176); grp.add(btn);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(.013, 16, 12), led); dot.position.set(0, -1.885, .21); grp.add(dot);

  const tilt = new THREE.Group(); tilt.rotation.z = TILT; tilt.add(grp);
  const pivot = new THREE.Group(); pivot.add(tilt);
  return pivot;
}

function leafInside(x, z) {
  const dx = x - LEAF.ox, dz = z - LEAF.oz, c = Math.cos(LEAF.a), s = Math.sin(LEAF.a);
  const u = c * dx + s * dz, v = -s * dx + c * dz;
  if (u < .05 || u > LEAF.L * .97) return false;
  const t = u / LEAF.L, mid = .09 * Math.sin(Math.PI * t);
  return Math.abs(v - mid) < 3 * Math.pow(t, .55) * Math.pow(1 - t, .85) * .92;
}
function leafPoint(u, v) {          // leaf space -> world xz
  const c = Math.cos(LEAF.a), s = Math.sin(LEAF.a), y = v + .09 * Math.sin(Math.PI * u / LEAF.L);
  return [LEAF.ox + c * u - s * y, LEAF.oz + s * u + c * y];
}

// ------------------------------------------------------------------ viewer
export async function mountLoupe(host, { onLevel } = {}) {
  const canvas = host.querySelector('canvas');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' }); }
  catch (e) { host.classList.add('no-webgl'); return null; }
  if (!renderer.capabilities.isWebGL2) { host.classList.add('no-webgl'); return null; }
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;

  const BG = new THREE.Color('#121518');
  const scene = new THREE.Scene(); scene.background = BG;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studio(), .03).texture;
  const Ldir = new THREE.Vector3(-.45, .8, -.42).normalize();
  const key = new THREE.DirectionalLight('#fff3e0', 2.4); key.position.copy(Ldir).multiplyScalar(10); scene.add(key);
  const fill = new THREE.DirectionalLight('#d8ecff', .45); fill.position.set(6, 3, 8); scene.add(fill);
  const rimC = new THREE.DirectionalLight('#8fe6ff', 1.2); rimC.position.set(-6, 4, -8); scene.add(rimC);

  const thumb = new Image(); thumb.src = new URL('../tex/leaf_10x.jpg', import.meta.url).href;
  try { await Promise.all([document.fonts.load('800 30px Montserrat'), document.fonts.load('700 30px Montserrat')]); } catch (e) { /* fallback */ }

  const shared = {
    uLight: { value: Ldir }, uLensC: { value: new THREE.Vector3() }, uLensN: { value: new THREE.Vector3(0, 0, 1) }, uLensR: { value: 1 },
    uHA: { value: new THREE.Vector3() }, uHB: { value: new THREE.Vector3() }, uHR: { value: .1 },
    uCaus: { value: new THREE.Vector3() }, uCausK: { value: 0 }, uBg: { value: new THREE.Color(BG).convertSRGBToLinear() },
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShaderMaterial({ uniforms: shared, vertexShader: groundVert, fragmentShader: groundFrag }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const lensMat = new THREE.ShaderMaterial({ uniforms: { ...shared, uM: { value: 2 }, uFocus: { value: new THREE.Vector3() }, uGain: { value: 1.08 }, uScan: { value: 0 } },
    vertexShader: lensVert, fragmentShader: lensFrag, side: THREE.DoubleSide });
  const hud = new Hud(thumb);
  const loupe = buildLoupe(lensMat, hud); loupe.scale.setScalar(SCALE); scene.add(loupe);

  const camera = new THREE.PerspectiveCamera(30, 1, .1, 100);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), .2, .45, 1.05));
  composer.addPass(new OutputPass());

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  canvas.tabIndex = 0; canvas.style.touchAction = 'none';
  let aspect = 1, onResize = null;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false); composer.setPixelRatio(dpr); composer.setSize(w, h);
    camera.aspect = aspect = w / h; camera.updateProjectionMatrix();
    if (onResize) onResize();
  }
  new ResizeObserver(resize).observe(host); resize();

  // ---- state
  const st = { level: 0, from: 0, to: 0, k: 1, pill: 0, auto: !reduce, timer: 0, cardT: 1, measT: 1, logM: Math.log(2), card: null };
  const F = new THREE.Vector3(.4, 0, .1), T = F.clone(), Fv = new THREE.Vector3(), tgt = new THREE.Vector3();
  let t = 0, idle = 99, dragging = false;
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ndc = new THREE.Vector2(), hit = new THREE.Vector3();
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (ray.ray.intersectPlane(plane, hit)) { T.copy(hit); T.y = 0; if (T.length() > 4.2) T.setLength(4.2); }
  }
  canvas.addEventListener('pointerdown', (e) => { dragging = true; idle = 0; canvas.setPointerCapture(e.pointerId); pick(e); host.classList.add('touched'); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) { pick(e); idle = 0; } });
  const end = () => { dragging = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('lostpointercapture', end);
  canvas.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: [-.3, 0], ArrowRight: [.3, 0], ArrowUp: [0, -.3], ArrowDown: [0, .3] }[e.key];
    if (k) { T.x += k[0]; T.z += k[1]; if (T.length() > 4.2) T.setLength(4.2); idle = 0; e.preventDefault(); }
    const n = { '1': 0, '2': 1, '3': 2, '4': 3 }[e.key]; if (n !== undefined) setLevel(n, true);
  });

  const DUR = .9, HOLD = 3.2;
  function setLevel(i, user = false) {
    i = ((i % LEVELS.length) + LEVELS.length) % LEVELS.length;
    if (user) { st.auto = false; st.timer = 0; }
    if (i === st.to && st.k < 1) return;
    st.from = st.to; st.to = i; st.k = 0; st.cardT = 0; st.measT = 0;
    if (onLevel) onLevel(i);
  }
  const N = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), M4 = new THREE.Matrix4();
  const C = new THREE.Vector3(), toCam = new THREE.Vector3(), hd = new THREE.Vector3();
  function layout(dt) {
    // camera: slow sway, follows the loupe a little
    tgt.lerp(new THREE.Vector3(F.x * .6, 0, F.z * .6), 1 - Math.pow(.2, dt));
    const az = .12 + (reduce ? 0 : .18 * Math.sin(t * .07)), el = .88, dist = 10.2 * Math.max(1, .82 / aspect);
    camera.position.set(tgt.x + dist * Math.sin(az) * Math.cos(el), dist * Math.sin(el), tgt.z + dist * Math.cos(az) * Math.cos(el));
    camera.lookAt(tgt.x, 1.0, tgt.z + .7); camera.updateMatrixWorld();
    // the lens centre sits on the camera ray through the focus point, so the centre of the glass looks exactly at F
    toCam.copy(camera.position).sub(F).normalize();
    C.copy(F).addScaledVector(toCam, LIFT);
    N.copy(camera.position).sub(C).normalize().lerp(up, .3).normalize();
    N.x += Fv.x * .05; N.z += Fv.z * .05; N.normalize();                      // leans into the motion
    X.crossVectors(up, N).normalize(); Y.crossVectors(N, X);
    M4.makeBasis(X, Y, N); loupe.quaternion.setFromRotationMatrix(M4); loupe.position.copy(C);
    loupe.updateMatrixWorld(true);
    // uniforms for shadows and the lens
    hd.set(Math.sin(TILT), -Math.cos(TILT), 0).applyQuaternion(loupe.quaternion);
    shared.uLensC.value.copy(C); shared.uLensN.value.copy(N); shared.uLensR.value = 1.0 * SCALE;
    shared.uHA.value.copy(C).addScaledVector(hd, 1.1 * SCALE); shared.uHB.value.copy(C).addScaledVector(hd, 4.8 * SCALE); shared.uHR.value = .2 * SCALE;
    shared.uCaus.value.copy(C).addScaledVector(Ldir, -C.y / Ldir.y);
    shared.uCausK.value = .9 * Math.abs(N.dot(Ldir));
    lensMat.uniforms.uFocus.value.copy(F);
  }
  function update(dt) {
    t += dt; idle += dt;
    if (!dragging && idle > 3.5 && !reduce) {                               // drift along the leaf on its own
      const [x, z] = leafPoint(LEAF.L * (.5 + .27 * Math.sin(t * .085)), .5 * Math.sin(t * .19 + 1));
      T.set(x, 0, z);
    }
    const prev = F.clone();
    F.lerp(T, 1 - Math.pow(dragging ? .0005 : .15, dt));
    Fv.copy(F).sub(prev).divideScalar(Math.max(dt, 1e-3)).clampLength(0, 3);
    // zoom: continuous, eased in log space
    if (st.k < 1) st.k = Math.min(1, st.k + dt / (reduce ? .01 : DUR));
    const target = Math.log(LEVELS[st.to].m);
    st.logM += (target - st.logM) * (1 - Math.pow(.004, dt));
    if (reduce) st.logM = target;
    lensMat.uniforms.uM.value = Math.exp(st.logM);
    const zin = LEVELS[st.to].m >= LEVELS[st.from].m;
    lensMat.uniforms.uScan.value = st.k < 1 ? (zin ? 1 - st.k : st.k) : 0;
    st.pill += (st.to - st.pill) * Math.min(1, dt * 10);
    st.cardT = Math.min(1, st.cardT + dt / 1.1); st.measT = Math.min(1, st.measT + dt / .8);
    if (st.auto && st.k >= 1) { st.timer += dt; if (st.timer > HOLD) { st.timer = 0; setLevel(st.to + 1); } }
    if (!st.auto && st.k >= 1) { st.timer += dt; if (st.timer > 12) { st.auto = !reduce; st.timer = 0; } }
    layout(dt);
    // what is under the lens decides the recognition card
    const onLeaf = leafInside(F.x, F.z);
    const text = onLeaf ? LEVELS[st.to].card : ['КАМЕНЬ', 'ПОВЕРХНОСТЬ'];
    if (!st.card || st.card[0] !== text[0]) { st.card = text; st.cardT = 0; }
    const M = Math.exp(st.logM);
    const span = 2 * .97 * SCALE * camera.position.distanceTo(F) / camera.position.distanceTo(C) / M;   // ground width seen by the lens
    const mm = 132 / 1024 * span * MM_PER_UNIT;
    hud.draw({
      pill: st.pill,
      card: { alpha: .25 + .75 * Math.min(1, st.cardT * 3), type: THREE.MathUtils.clamp((st.cardT - .15) / .6, 0, 1), text: st.card },
      measure: { alpha: Math.min(1, st.measT * 2.5), scale: 1 + .35 * Math.pow(1 - st.measT, 3), text: (mm >= 1 ? mm.toFixed(1) : mm.toFixed(2)).replace('.', ',') + ' мм' },
    });
  }
  update(0);

  let visible = true, prevT = performance.now();
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(host);
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - prevT) / 1000, 0), .05); prevT = now;
    if (!visible || document.hidden || api.frozen) return;
    update(dt);
    composer.render();
  }
  const api = { scene, camera, renderer, loupe, frozen: false, render: () => composer.render(), setLevel: (i) => setLevel(i, true), levels: LEVELS.map(l => l.label),
    // test hook: put the loupe over a point (world x, z) at a zoom level and render one still frame
    setPose(x, z, level = 0) {
      this.frozen = true; T.set(x, 0, z); F.copy(T); Fv.set(0, 0, 0); tgt.set(x * .6, 0, z * .6);
      st.from = st.to = level; st.k = 1; st.cardT = st.measT = 1; st.pill = level; st.auto = false; st.logM = Math.log(LEVELS[level].m);
      update(0); st.cardT = 1; update(0); composer.render();
    } };
  onResize = () => { if (api.frozen) { update(0); composer.render(); } };
  requestAnimationFrame(frame);
  host.classList.add('ready');
  return api;
}
