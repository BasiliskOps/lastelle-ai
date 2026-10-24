// Hero scene: Leonardo's Vitruvian Man rendered as particles sampled from the
// original drawing. Particles wake from the navel, swirl through a sequence of
// forms (genome, atom, neural lattice, Dyson swarm, galaxy), collapse back into
// the navel, and the figure is redrawn outward from it. Loops.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const host = document.getElementById('hero-canvas');
if (host) start(host);

async function start(host) {
  const params = new URLSearchParams(location.search);
  const frozen = params.has('t') ? parseFloat(params.get('t')) : null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = window.innerWidth < 760;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: frozen !== null });
  } catch (e) { host.classList.add('no-webgl'); return; }
  const DPR = Math.min(window.devicePixelRatio || 1, mobile ? 1.6 : 1.75);
  renderer.setPixelRatio(DPR);
  renderer.setClearColor(0x070403, 1);
  host.appendChild(renderer.domElement);

  // ---------- data ----------
  const buf = await fetch(host.dataset.points).then(r => r.arrayBuffer());
  const TOTAL = buf.byteLength / 5;
  const N = mobile ? 70000 : TOTAL;
  const xy = new Int16Array(buf, 0, TOTAL * 2);
  const ink8 = new Uint8Array(buf, TOTAL * 4, TOTAL);

  const rng = mulberry(11);
  const man = new Float32Array(N * 3), ink = new Float32Array(N), rnd = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    man[i * 3] = xy[i] / 16000;
    man[i * 3 + 1] = xy[TOTAL + i] / 16000;
    man[i * 3 + 2] = (rng() - 0.5) * 0.02;
    ink[i] = ink8[i] / 255;
    rnd[i * 4] = rng(); rnd[i * 4 + 1] = rng(); rnd[i * 4 + 2] = rng(); rnd[i * 4 + 3] = rng();
  }
  const forms = [man, helix(N, rng), atom(N, rng), lattice(N, rng), dyson(N, rng), galaxy(N, rng)];

  const geo = new THREE.BufferGeometry();
  forms.forEach((f, i) => geo.setAttribute(i === 0 ? 'position' : 'p' + i, new THREE.BufferAttribute(f, 3)));
  geo.setAttribute('aR', new THREE.BufferAttribute(rnd, 4));
  geo.setAttribute('aInk', new THREE.BufferAttribute(ink, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

  const uniforms = {
    uTime: { value: 0 }, uA: { value: 0 }, uB: { value: 0 }, uP: { value: 0 }, uMode: { value: 0 },
    uSize: { value: parseFloat(params.get('s') || '0.0034') }, uAlpha: { value: parseFloat(params.get('a') || '0.35') }, uProj: { value: 800 }, uDpr: { value: DPR },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  // ---------- scene ----------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  const bgUni = { uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uFocus: { value: new THREE.Vector2(0.62, 0.5) }, uRad: { value: 0.3 }, uPulse: { value: 0 } };
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: bgUni, vertexShader: BG_VERT, fragmentShader: BG_FRAG, depthWrite: false, depthTest: false }));
  bg.frustumCulled = false; bg.renderOrder = -1;
  scene.add(bg);
  const rig = new THREE.Group();
  rig.add(points);
  scene.add(rig);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bp = (params.get('b') || '0.38,0.35,0.55').split(',').map(Number);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), bp[0], bp[1], bp[2]);
  composer.addPass(bloom);
  const finish = new ShaderPass({ uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() } }, vertexShader: FIN_VERT, fragmentShader: FIN_FRAG });
  composer.addPass(finish);

  // ---------- layout ----------
  let W = 1, H = 1, focusX = 0;
  function layout() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    camera.aspect = W / H;
    const wide = W / H > 1.15;
    // figure diameter as a share of the frame height
    const share = wide ? 0.80 : Math.min(0.78, (W / H) * 0.86);
    const dist = 2 / (share * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    camera.position.set(0, 0, dist);
    camera.updateProjectionMatrix();
    // shift the figure right on wide frames so copy can sit left
    const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist * camera.aspect;
    focusX = wide ? halfW * 0.34 : 0;
    const focusY = wide ? 0 : Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist * 0.30;
    rig.position.set(focusX, focusY, 0);
    uniforms.uProj.value = (H * DPR) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    bgUni.uRes.value.set(W * DPR, H * DPR);
    finish.uniforms.uRes.value.set(W * DPR, H * DPR);
    const v = new THREE.Vector3(focusX, focusY, 0).project(camera);
    bgUni.uFocus.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    bgUni.uRad.value = share * 0.5;
  }
  layout();
  new ResizeObserver(layout).observe(host);

  // ---------- timeline ----------
  // modes: 0 hold, 1 swirl transition, 2 collapse into navel and redraw
  const T = [
    { m: 0, a: 0, d: 4.2 },
    { m: 1, a: 0, b: 1, d: 3.4 },
    { m: 0, a: 1, d: 2.2 },
    { m: 1, a: 1, b: 2, d: 1.9 },
    { m: 0, a: 2, d: 2.2 },
    { m: 1, a: 2, b: 3, d: 1.9 },
    { m: 0, a: 3, d: 2.2 },
    { m: 1, a: 3, b: 4, d: 1.9 },
    { m: 0, a: 4, d: 2.4 },
    { m: 1, a: 4, b: 5, d: 2.0 },
    { m: 0, a: 5, d: 2.6 },
    { m: 2, a: 5, b: 0, d: 4.6 },
  ];
  const LOOP = T.reduce((s, x) => s + x.d, 0);
  function setTimeline(t) {
    let u = ((t % LOOP) + LOOP) % LOOP;
    for (const seg of T) {
      if (u <= seg.d) {
        uniforms.uMode.value = seg.m;
        uniforms.uA.value = seg.a;
        uniforms.uB.value = seg.m === 0 ? seg.a : seg.b;
        uniforms.uP.value = u / seg.d;
        bgUni.uPulse.value = seg.m === 2 ? Math.max(0, 1 - Math.abs(u / seg.d - 0.42) * 6) : (seg.m === 1 && seg.a === 0 ? Math.max(0, 1 - u / seg.d * 2.2) * 0.6 : 0);
        return;
      }
      u -= seg.d;
    }
  }

  // ---------- pointer parallax ----------
  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  if (!mobile) host.addEventListener('pointermove', e => {
    const r = host.getBoundingClientRect();
    ptr.tx = (e.clientX - r.left) / r.width - 0.5;
    ptr.ty = (e.clientY - r.top) / r.height - 0.5;
  });
  host.addEventListener('pointerleave', () => { ptr.tx = 0; ptr.ty = 0; });

  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }, { threshold: 0 }).observe(host);

  const clock = new THREE.Clock();
  let t = 0;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (frozen === null) { if (!reduced) t += dt; }
    else t = (window.__heroT != null) ? window.__heroT : frozen;
    ptr.x += (ptr.tx - ptr.x) * 0.04; ptr.y += (ptr.ty - ptr.y) * 0.04;
    rig.rotation.y = ptr.x * 0.16;
    rig.rotation.x = ptr.y * 0.10;
    setTimeline(t);
    uniforms.uTime.value = t; bgUni.uTime.value = t; finish.uniforms.uTime.value = t;
    composer.render();
  }
  window.__heroFrame = (tt) => { window.__heroT = tt; frame(); };
  if (reduced) { new ResizeObserver(() => frame()).observe(host); frame(); window.__heroReady = true; return; }
  if (params.has('still')) { frame(); window.__heroReady = true; return; }
  renderer.setAnimationLoop(() => { if (visible && !document.hidden) frame(); });
  window.__heroReady = true;
}

// ---------- shape generators (unit radius, origin = navel) ----------
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.2831853 * r()); }
function sphere(r, rad, out, o) {
  const u = r() * 2 - 1, a = r() * 6.2831853, s = Math.sqrt(1 - u * u);
  out[o] = s * Math.cos(a) * rad; out[o + 1] = u * rad; out[o + 2] = s * Math.sin(a) * rad;
}

function helix(N, r) {
  const o = new Float32Array(N * 3), turns = 2.6, len = 2.1, R = 0.36, rungs = 34;
  for (let i = 0; i < N; i++) {
    const k = r();
    let x, y, z;
    if (k < 0.62) {
      const t = r(), s = r() < 0.5 ? 0 : Math.PI, a = t * turns * 6.2831853 + s;
      const th = 0.022;
      x = Math.cos(a) * R + gauss(r) * th; z = Math.sin(a) * R + gauss(r) * th; y = (t - 0.5) * len + gauss(r) * th;
    } else {
      const n = Math.floor(r() * rungs), t = (n + 0.5) / rungs, a = t * turns * 6.2831853, f = r() * 2 - 1;
      x = Math.cos(a) * R * f; z = Math.sin(a) * R * f; y = (t - 0.5) * len + gauss(r) * 0.006;
      if (r() < 0.08) { x += gauss(r) * 0.03; z += gauss(r) * 0.03; }
    }
    o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
  }
  return o;
}

function atom(N, r) {
  const o = new Float32Array(N * 3), balls = [];
  for (let b = 0; b < 14; b++) { const p = [0, 0, 0]; sphere(r, 0.09 * Math.cbrt(r()), p, 0); balls.push(p); }
  const orbits = [[0, 0], [1.05, 0.5], [-1.05, -0.5]];
  for (let i = 0; i < N; i++) {
    const k = r(); let x, y, z;
    if (k < 0.2) {
      const b = balls[Math.floor(r() * balls.length)], p = [0, 0, 0]; sphere(r, 0.055 * Math.sqrt(r()), p, 0);
      x = b[0] + p[0]; y = b[1] + p[1]; z = b[2] + p[2];
    } else {
      const [tilt, yaw] = orbits[Math.floor(r() * 3)];
      let a = r() * 6.2831853, rr = 0.98, th = 0.007;
      if (k > 0.9) { a = Math.floor(r() * 2) * Math.PI + Math.floor(k * 30) * 0.21; const p = [0, 0, 0]; sphere(r, 0.035 * Math.cbrt(r()), p, 0); x = Math.cos(a) * rr * 1.0 + p[0]; y = Math.sin(a) * rr * 0.34 + p[1]; z = p[2]; }
      else { x = Math.cos(a) * rr + gauss(r) * th; y = Math.sin(a) * rr * 0.34 + gauss(r) * th; z = gauss(r) * th; }
      const c = Math.cos(tilt), s = Math.sin(tilt);
      const x2 = x * c - y * s, y2 = x * s + y * c;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      x = x2 * cy + z * sy; z = -x2 * sy + z * cy; y = y2;
    }
    o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
  }
  return o;
}

function lattice(N, r) {
  const layers = [6, 10, 10, 10, 6], nodes = [];
  layers.forEach((n, li) => {
    const x = (li / (layers.length - 1) - 0.5) * 2.0;
    for (let j = 0; j < n; j++) { const y = (j / (n - 1) - 0.5) * (n > 6 ? 1.75 : 1.15); nodes.push([x, y, Math.sin(j * 1.7 + li) * 0.18, li]); }
  });
  const edges = [];
  for (const a of nodes) for (const b of nodes) if (b[3] === a[3] + 1 && r() < 0.55) edges.push([a, b]);
  const o = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (r() < 0.36) {
      const n = nodes[Math.floor(r() * nodes.length)], p = [0, 0, 0]; sphere(r, 0.038 * (0.75 + 0.25 * r()), p, 0);
      x = n[0] + p[0]; y = n[1] + p[1]; z = n[2] + p[2];
    } else {
      const [a, b] = edges[Math.floor(r() * edges.length)], t = r();
      x = a[0] + (b[0] - a[0]) * t; y = a[1] + (b[1] - a[1]) * t; z = a[2] + (b[2] - a[2]) * t;
      x += gauss(r) * 0.002; y += gauss(r) * 0.002;
    }
    o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
  }
  return o;
}

function dyson(N, r) {
  const o = new Float32Array(N * 3), rings = [];
  for (let k = 0; k < 9; k++) rings.push({ R: 0.52 + k * 0.06, tilt: (r() - 0.5) * 2.4, yaw: r() * 6.28, n: 40 + k * 9 });
  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (r() < 0.24) {
      const p = [0, 0, 0]; sphere(r, 0.24 * (r() < 0.75 ? 1 : Math.cbrt(r())), p, 0); x = p[0]; y = p[1]; z = p[2];
    } else {
      const g = rings[Math.floor(r() * rings.length)];
      const cell = Math.floor(r() * g.n), a0 = cell / g.n * 6.2831853;
      // small square collector panels along the ring
      const a = a0 + (r() - 0.5) * 0.045, h = (r() - 0.5) * 0.05;
      x = Math.cos(a) * g.R; y = h; z = Math.sin(a) * g.R;
      const c = Math.cos(g.tilt), s = Math.sin(g.tilt);
      const y2 = y * c - z * s, z2 = y * s + z * c;
      const cy = Math.cos(g.yaw), sy = Math.sin(g.yaw);
      const x3 = x * cy + z2 * sy, z3 = -x * sy + z2 * cy;
      x = x3; y = y2; z = z3;
    }
    o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
  }
  return o;
}

function galaxy(N, r) {
  const o = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (r() < 0.18) { const p = [0, 0, 0]; sphere(r, 0.16 * Math.cbrt(r()), p, 0); x = p[0]; y = p[1] * 0.55; z = p[2]; }
    else {
      const arm = r() < 0.5 ? 0 : Math.PI, d = Math.pow(r(), 0.8) * 1.1 + 0.05;
      const a = arm + Math.log(d + 0.05) * 2.6 + gauss(r) * (0.22 / (d + 0.3));
      x = Math.cos(a) * d + gauss(r) * 0.03; z = Math.sin(a) * d + gauss(r) * 0.03; y = gauss(r) * 0.025 * (1.2 - d);
    }
    o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
  }
  return o;
}

// ---------- shaders ----------
const NOISE = /* glsl */`
vec3 hash3(vec3 p){ p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453)*2.0-1.0; }
vec3 flow(vec3 p, float t){
  return vec3(sin(p.y*2.1+t*0.7)+sin(p.z*3.3-t*0.5), sin(p.z*2.4+t*0.6)+sin(p.x*3.1+t*0.4), sin(p.x*2.2-t*0.5)+sin(p.y*2.9+t*0.3))*0.5;
}`;

const VERT = /* glsl */`
uniform float uTime, uP, uSize, uProj, uDpr, uAlpha;
uniform int uA, uB, uMode;
attribute vec3 p1, p2, p3, p4, p5;
attribute vec4 aR;
attribute float aInk;
varying vec3 vCol;
varying float vA;
${NOISE}
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
vec3 formRaw(int i){ if(i==0) return position; if(i==1) return p1; if(i==2) return p2; if(i==3) return p3; if(i==4) return p4; return p5; }
vec3 form(int i){
  vec3 p = formRaw(i);
  if(i==0) return p + vec3(0.0,0.0,sin(uTime*0.6+aR.w*6.28)*0.004);
  float spin = uTime*0.28 + float(i)*1.3;
  if(i==1) return rotX(0.18) * rotY(spin) * p;
  if(i==2) return rotX(0.25) * rotY(spin*0.9) * p;
  if(i==3) return rotX(0.12) * rotY(sin(uTime*0.35)*0.55) * p;
  if(i==4) return rotX(0.38) * rotY(spin*0.7) * p;
  return rotX(1.05) * rotY(spin*0.6) * p * 1.05;
}
float eio(float t){ return t<0.5 ? 4.0*t*t*t : 1.0-pow(-2.0*t+2.0,3.0)*0.5; }
mat2 r2(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
void main(){
  vec3 A = form(uA), B = form(uB), pos;
  float glow = 0.0, size = 1.0, dn = length(position.xy), manW = 0.0;
  if(uMode==0){
    pos = A; manW = uA==0 ? 1.0 : 0.0;
  } else if(uMode==1){
    float sweep = clamp(0.5 - A.y*0.42, 0.0, 1.0);
    float delay = uA==0 ? dn*0.42 + aR.x*0.12 : sweep*0.52 + aR.x*0.1;
    float win = uA==0 ? 0.44 : 0.36;
    float t = clamp((uP - delay)/win, 0.0, 1.0);
    float e = eio(t);
    float arc = sin(3.14159*t);
    manW = uA==0 ? 1.0 - e : 0.0;
    pos = mix(A, B, e);
    // coherent vortex about the navel axis
    float ang = arc * (uA==0 ? 1.9 + aR.y*0.9 : 0.8 + aR.y*0.5);
    pos.xy = r2(ang) * pos.xy * (1.0 + arc*0.18);
    pos.z += arc * (aR.z-0.5) * 0.5;
    pos += flow(pos*1.4 + aR.xyz*0.6, uTime) * arc * 0.05;
    glow = arc*0.55;
    if(uA==0){
      // light wave travelling outward from the navel through the drawing
      float front = uP*2.2;
      glow += exp(-pow((dn - front)*9.0, 2.0)) * (1.0 - t) * 1.4;
    }
  } else {
    // collapse into the navel, then redraw the figure outward from it
    float split = 0.42;
    if(uP < split){
      float t = clamp((uP/split - aR.x*0.35)/0.65, 0.0, 1.0);
      float e = t*t*t;
      pos = mix(A, vec3(0.0), e);
      pos.xy = r2(e*e*(4.0+aR.y*3.0)) * pos.xy;
      glow = e*0.6;
      size = mix(1.0, 0.5, e);
    } else {
      float u = (uP - split)/(1.0 - split);
      float t = clamp((u - dn*0.5 - aR.x*0.08)/0.4, 0.0, 1.0);
      float e = 1.0 - pow(1.0 - t, 3.0);
      vec3 from = vec3(0.0) + (aR.xyz - 0.5)*0.01;
      pos = mix(from, B, e);
      pos.xy = r2((1.0-e)*(1.5+aR.y)) * pos.xy;
      glow = (1.0 - e)*0.5 + exp(-pow((dn - (u*1.8-0.15))*10.0, 2.0))*0.7;
      size = mix(0.55, 1.0, e); manW = e;
    }
  }
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float ink = (uMode==0 && uA!=0) ? 0.55 + aR.w*0.35 : aInk;
  gl_PointSize = max(1.0, uSize * uProj * (0.7 + ink*0.7) * (1.0 + glow*0.5) * size / -mv.z);
  vec3 amber = vec3(0.92, 0.46, 0.13);
  vec3 honey = vec3(1.0, 0.74, 0.40);
  vec3 bone  = vec3(1.0, 0.93, 0.80);
  vec3 c = mix(amber, honey, smoothstep(0.2, 0.9, ink + aR.y*0.25));
  c = mix(c, bone, clamp(glow*0.55 + step(0.985, aR.w)*0.6, 0.0, 1.0));
  vCol = c;
  vA = uAlpha * (0.22 + ink*0.55) * (1.0 + glow*0.9) * mix(1.0, 1.9, manW);
}`;

const FRAG = /* glsl */`
varying vec3 vCol; varying float vA;
void main(){
  vec2 q = gl_PointCoord - 0.5; float d = dot(q,q);
  if(d > 0.25) discard;
  float a = exp(-d*14.0);
  gl_FragColor = vec4(vCol * a * vA, 1.0);
}`;

const BG_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BG_FRAG = /* glsl */`
uniform float uTime, uRad, uPulse; uniform vec2 uRes, uFocus; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1)))*43758.5); }
float caustic(vec2 uv, float t){
  vec2 p = mod(uv*6.2831853, 6.2831853) - 250.0;
  vec2 i = p; float c = 1.0, inten = 0.005;
  for(int n=0;n<5;n++){
    float tt = t*(1.0 - 3.5/float(n+1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0/length(vec2(p.x/(sin(i.x+tt)/inten), p.y/(cos(i.y+tt)/inten)));
  }
  c /= 5.0; c = 1.17 - pow(max(c, 0.0), 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.0);
}
void main(){
  vec2 uv = vUv; float asp = uRes.x/uRes.y;
  vec2 p = vec2((uv.x - uFocus.x)*asp, uv.y - uFocus.y);
  float r = length(p);
  vec3 col = vec3(0.028, 0.016, 0.010);
  // warm haze from above, Wallace interior
  col += vec3(0.24, 0.115, 0.035) * pow(clamp(uv.y, 0.0, 1.0), 1.8) * 0.7;
  // soft vertical shaft of light from above the figure
  col += vec3(0.30, 0.15, 0.05) * exp(-pow((uv.x - uFocus.x)*asp*2.4, 2.0)) * smoothstep(0.2, 1.0, uv.y) * 0.35;
  // water caustics thrown on the wall, slow
  vec2 cp = vec2(uv.x*asp, uv.y*1.6)*0.55;
  float cs = caustic(cp, uTime*0.22);
  float wall = smoothstep(1.05, 0.25, uv.y) * smoothstep(-0.1, 0.6, uv.y);
  col += vec3(0.85, 0.45, 0.14) * cs * 0.30 * (0.2 + wall) * smoothstep(0.05, 0.6, uv.y);
  // backlit disc behind the figure
  float disc = smoothstep(uRad*1.18, uRad*0.15, r);
  col += vec3(0.42, 0.20, 0.06) * disc * 0.42;
  col += vec3(0.95, 0.55, 0.20) * exp(-pow((r - uRad*1.06)*38.0, 2.0)) * 0.06;
  // core pulse at the navel
  col += vec3(1.0, 0.7, 0.35) * exp(-r*r*900.0/(0.2+uPulse)) * uPulse * 0.9;
  // floor horizon line
  col += vec3(0.5, 0.26, 0.08) * exp(-pow((uv.y - 0.11)*60.0, 2.0)) * 0.05;
  // vignette
  vec2 v = uv - 0.5; col *= 1.0 - dot(v*vec2(0.9,1.2), v*vec2(0.9,1.2))*1.25;
  gl_FragColor = vec4(col, 1.0);
}`;

const FIN_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const FIN_FRAG = /* glsl */`
uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)))*43758.5453); }
void main(){
  vec2 d = (vUv - 0.5);
  float ca = 0.0016 * length(d) * 2.0;
  vec3 c;
  c.r = texture2D(tDiffuse, vUv + d*ca*1.0).r;
  c.g = texture2D(tDiffuse, vUv).g;
  c.b = texture2D(tDiffuse, vUv - d*ca*1.0).b;
  // gentle warm grade
  c = pow(c, vec3(0.98, 1.0, 1.06));
  float g = h(vUv*uRes + fract(uTime*7.31)*vec2(91.7, 37.3)) - 0.5;
  c += g * 0.035;
  gl_FragColor = vec4(c, 1.0);
}`;
