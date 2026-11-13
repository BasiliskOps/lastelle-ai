// Hero: Earth from orbit, in real time. WebGL2, no dependencies.
//
//  - The planet: real surface maps, a single-scattering atmosphere computed along every ray, sun glint on
//    the sea, and the day/night line where the real Sun puts it right now.
//  - The clouds are a live fluid. A stable-fluids solver (after Pavel Dobryakov's WebGL-Fluid-Simulation,
//    MIT) runs on the patch of Earth in view: winds and cyclones churn the real cloud cover, the ground
//    slides beneath as the orbit carries on, and a cursor or finger drawn across the planet stirs it.
//  - The sky: every star to magnitude 6 (Hipparcos) and the constellation figures, placed for this exact
//    moment and this exact point in orbit, hidden by the planet and dimmed through the limb.
//  - The logo star: drawn in light, a hot core with cross flares, a shimmering trail and shed sparkles,
//    all rendered in high dynamic range and bloomed.
//
// Earth maps: Solar System Scope (CC BY 4.0). Star data: d3-celestial, Olaf Frohn (BSD-3-Clause).
// If WebGL2 or float render targets are unavailable, the previous hero (js/hero.min.js) takes over.
(() => {
  const host = document.getElementById('hero-canvas');
  if (!host) return;
  const SELF = document.currentScript ? document.currentScript.src : location.href;
  const fallback = () => { host.removeAttribute('data-scene'); import(new URL('hero.min.js', SELF).href).catch(() => host.classList.add('no-webgl')); };

  const params = new URLSearchParams(location.search);
  const frozen = params.has('t') ? parseFloat(params.get('t')) : null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 760;
  const clock0 = params.has('utc') ? Date.parse(params.get('utc')) : Date.now();

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: frozen !== null });
  if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) { fallback(); return; }
  gl.getExtension('OES_texture_float_linear');

  // ===================================================================== shaders
  const H = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n';
  const VSQ = H + `in vec2 aP; uniform vec2 uTexel; out vec2 vUv, vL, vR, vT, vB;
void main(){ vUv = aP * 0.5 + 0.5; vL = vUv - vec2(uTexel.x, 0.0); vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y); vB = vUv - vec2(0.0, uTexel.y); gl_Position = vec4(aP, 0.0, 1.0); }`;
  const FQ = H + 'in vec2 vUv, vL, vR, vT, vB; out vec4 o;\n';

  // ---- fluid (velocity in sim texels per second)
  const F_ADVECT = FQ + `uniform sampler2D uVel, uSrc; uniform vec2 uSimTexel, uDrift; uniform float uDt, uDiss;
void main(){ vec2 c = vUv - uDt * (texture(uVel, vUv).xy + uDrift) * uSimTexel; o = texture(uSrc, c) / (1.0 + uDiss * uDt); }`;
  const F_DIV = FQ + `uniform sampler2D uVel;
void main(){ float L = texture(uVel, vL).x, R = texture(uVel, vR).x, T = texture(uVel, vT).y, B = texture(uVel, vB).y;
  vec2 C = texture(uVel, vUv).xy; if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x; if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0); }`;
  const F_CURL = FQ + `uniform sampler2D uVel;
void main(){ o = vec4(0.5 * (texture(uVel, vR).y - texture(uVel, vL).y - texture(uVel, vT).x + texture(uVel, vB).x), 0.0, 0.0, 1.0); }`;
  const F_VORT = FQ + `uniform sampler2D uVel, uCurl; uniform float uCurlK, uDt;
void main(){ float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x, T = texture(uCurl, vT).x, B = texture(uCurl, vB).x, C = texture(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L)); f /= length(f) + 1e-4; f *= uCurlK * C; f.y *= -1.0;
  o = vec4(clamp(texture(uVel, vUv).xy + f * uDt, -1000.0, 1000.0), 0.0, 1.0); }`;
  const F_PRESS = FQ + `uniform sampler2D uP, uDiv;
void main(){ o = vec4((texture(uP, vL).x + texture(uP, vR).x + texture(uP, vT).x + texture(uP, vB).x - texture(uDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0); }`;
  const F_GRAD = FQ + `uniform sampler2D uP, uVel;
void main(){ o = vec4(texture(uVel, vUv).xy - vec2(texture(uP, vR).x - texture(uP, vL).x, texture(uP, vT).x - texture(uP, vB).x), 0.0, 1.0); }`;
  const F_SCALE = FQ + `uniform sampler2D uSrc; uniform float uK; void main(){ o = uK * texture(uSrc, vUv); }`;
  const F_SPLAT = FQ + `uniform sampler2D uSrc; uniform vec2 uPt; uniform vec3 uCol; uniform float uRad, uAsp;
void main(){ vec2 p = vUv - uPt; p.x *= uAsp; o = vec4(texture(uSrc, vUv).xyz + exp(-dot(p, p) / uRad) * uCol, 1.0); }`;
  // the weather the winds relax toward, laid out as Earth's general circulation: easterly trade winds in
  // the tropics converging on the equator, westerlies in the mid-latitudes meandering in long Rossby waves,
  // polar easterlies beyond, and low-pressure systems that turn counter-clockwise in the north and
  // clockwise in the south, wound up by the westerlies into comma-shaped storms
  const F_WIND = FQ + `uniform sampler2D uSrc; uniform float uT, uDt, uAsp, uSpeed, uRate; uniform vec4 uCyc[3];
uniform vec3 uS, uRt, uFh; uniform vec4 uDom;
vec3 domToDir(vec2 uv){ vec2 d = mix(uDom.xy, uDom.zw, uv); float r = length(d);
  return normalize(uS * cos(r) + (uRt * d.x + uFh * d.y) / max(r, 1e-6) * sin(r)); }
void main(){
  vec3 n = domToDir(vUv);
  float lat = asin(clamp(n.z, -1.0, 1.0)), lon = atan(n.y, n.x), al = abs(lat), hs = sign(lat + 1e-6);
  vec3 east = normalize(vec3(-n.y, n.x, 0.0) + 1e-6), north = cross(n, east);
  // zonal wind by latitude (positive = from the west)
  float trades = -0.55 * smoothstep(0.62, 0.30, al) * smoothstep(0.0, 0.10, al);
  float wester = 1.0 * smoothstep(0.42, 0.62, al) * smoothstep(1.15, 0.85, al);
  float polar = -0.30 * smoothstep(1.05, 1.25, al);
  // the westerlies meander north and south in long waves that travel slowly east
  float rossby = sin(lon * 5.0 - uT * 0.03) * 0.35 * smoothstep(0.42, 0.62, al) * smoothstep(1.15, 0.85, al);
  // trade winds turn toward the equator, where they meet and rise
  float conv = -0.22 * hs * smoothstep(0.62, 0.30, al) * smoothstep(0.0, 0.12, al);
  vec3 w = east * (trades + wester + polar) + north * (rossby + conv);
  vec2 v = vec2(dot(w, uRt), dot(w, uFh)) * 0.03;
  for (int i = 0; i < 3; i++) {
    vec2 d = (vUv - uCyc[i].xy) * vec2(uAsp, 1.0); float r = length(d) / uCyc[i].z;
    float spin = sign(domToDir(uCyc[i].xy).z + 1e-6);
    v += vec2(-d.y, d.x) / max(length(d), 1e-4) * uCyc[i].w * spin * r * exp(0.5 - 0.5 * r * r) * uCyc[i].z;
  }
  vec2 cur = texture(uSrc, vUv).xy;
  o = vec4(mix(cur, v * uSpeed, 1.0 - exp(-uRate * uDt)), 0.0, 1.0);
}`;
  // domain <-> planet: an azimuthal-equidistant map centred under the spacecraft, x to the right, y ahead
  const DOMAIN = `
uniform vec3 uS, uRt, uFh; uniform vec4 uDom;
vec3 domToDir(vec2 uv){ vec2 d = mix(uDom.xy, uDom.zw, uv); float r = length(d);
  return normalize(uS * cos(r) + (uRt * d.x + uFh * d.y) / max(r, 1e-6) * sin(r)); }
vec2 dirToDom(vec3 n){ float c = clamp(dot(n, uS), -1.0, 1.0), r = acos(c); vec3 h = n - uS * c;
  vec2 d = r * vec2(dot(h, uRt), dot(h, uFh)) / max(length(h), 1e-6); return (d - uDom.xy) / (uDom.zw - uDom.xy); }
vec2 dirToLL(vec3 n, float rot){ return vec2(atan(n.y, n.x) / 6.2831853 + 0.5 + rot, 0.5 - asin(clamp(n.z, -1.0, 1.0)) / 3.14159265); }`;
  // the cloud field keeps returning to the real cloud cover beneath it, so it always reads as Earth
  // how far the winds have pushed the cloud deck at each point: carried with the flow, fed by it, and
  // easing back over a few seconds, so the clouds are always drawn from the sharp map, just moved
  const F_DISP = FQ + `uniform sampler2D uVel, uSrc; uniform vec2 uSimTexel, uDrift; uniform float uDt, uK;
void main(){
  vec2 v = texture(uVel, vUv).xy;
  vec2 c = vUv - uDt * (v + uDrift) * uSimTexel;
  vec2 d = texture(uSrc, c).xy + v * uSimTexel * uDt;
  vec2 e = min(vUv, 1.0 - vUv); d *= smoothstep(0.0, 0.06, min(e.x, e.y));
  o = vec4(d * exp(-uK * uDt), 0.0, 1.0); }`;

  // ---- the planet (linear HDR out)
  const NS = mobile ? 10 : 14;
  const F_EARTH = H + `out vec4 o;
uniform vec2 uRes; uniform float uTanY, uAspect, uTex, uFluid, uRot, uExpo;
uniform vec3 uC, uF, uUp, uSun;
uniform sampler2D uDay, uClouds, uOcean, uDisp, uDayHi, uCloudsHi; uniform vec4 uCrop; uniform float uHi;` + DOMAIN + `
// the full planet at standard detail, and a high-detail window over the region the orbit covers
bool inCrop(vec2 ll, out vec2 cu){ cu = vec2(fract(ll.x - uCrop.x) / uCrop.z, (ll.y - uCrop.y) / uCrop.w);
  return uHi > 0.5 && cu.x > 0.002 && cu.x < 0.998 && cu.y > 0.002 && cu.y < 0.998; }
float cloudTex(vec2 ll, vec2 dx, vec2 dy){ vec2 cu; ll.x = fract(ll.x);
  if (inCrop(ll, cu)) return textureGrad(uCloudsHi, cu, dx / uCrop.zw, dy / uCrop.zw).r;
  return textureGrad(uClouds, ll, dx, dy).r; }
vec3 dayTex(vec2 ll, vec2 dx, vec2 dy){ vec2 cu;
  if (inCrop(ll, cu)) return textureGrad(uDayHi, cu, dx / uCrop.zw, dy / uCrop.zw).rgb;
  return textureGrad(uDay, ll, dx, dy).rgb; }
const float PI = 3.14159265, R = 1.0, RA = 1.024, HR = 0.0034, HM = 0.0010;
const vec3 BR = vec3(10.0, 25.0, 62.0); const float BM = 10.0, SUN = 22.0;
vec2 sph(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r * r, h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9); h = sqrt(h); return vec2(-b - h, -b + h); }
float depth(float h, float Hs, float cz){
  float X = (R + h) / Hs, c = sqrt(1.5707963 * X), e = -h / Hs;
  if (cz >= 0.0) return Hs * exp(e) * c / ((c - 1.0) * cz + 1.0);
  float s = sqrt(max(1.0 - cz * cz, 0.0)), cs = sqrt(1.5707963 * X * s);
  return Hs * (2.0 * cs * exp(min(e + X * (1.0 - s), 60.0)) - exp(e) * c / ((c - 1.0) * (-cz) + 1.0)); }
vec3 sunT(float h, float cz){ return exp(-(BR * depth(h, HR, cz) + BM * 1.1 * depth(h, HM, cz))); }
vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
float cloudAt(vec3 n, vec2 dx, vec2 dy, out float inF, out vec2 du){
  vec2 ll = dirToLL(n, uRot);
  float tc = cloudTex(ll, dx, dy);
  du = dirToDom(n);
  vec2 e = min(du, 1.0 - du);
  inF = uFluid * smoothstep(0.0, 0.04, min(e.x, e.y));
  if (inF <= 0.0) return tc;
  vec2 dl = dirToLL(domToDir(du - texture(uDisp, du).xy * inF), uRot);
  return cloudTex(dl, dx, dy);
}
void main(){
  vec2 q = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 rd = normalize(uF + q.x * uTanY * uAspect * uRt + q.y * uTanY * uUp), ro = uC;
  vec2 ta = sph(ro, rd, RA), tp = sph(ro, rd, R);
  bool hit = tp.x > 0.0 && tp.x < 1e8;
  float mu = dot(rd, uSun);
  float phR = 0.0596831 * (1.0 + mu * mu), g = 0.76;
  float phM = 0.1193662 * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 ins = vec3(0.0), Tv = vec3(1.0);
  if (ta.y > 0.0 && ta.x < 1e8) {
    float t0 = max(ta.x, 0.0), t1 = hit ? tp.x : ta.y, L = t1 - t0, ds = L / float(${NS}), odr = 0.0, odm = 0.0;
    for (int i = 0; i < ${NS}; i++) {
      vec3 p = ro + rd * (t0 + L * (float(i) + 0.5) / float(${NS}));
      float r = length(p), h = max(r - R, 0.0), dr = exp(-h / HR) * ds, dm = exp(-h / HM) * ds;
      odr += dr * 0.5; odm += dm * 0.5;
      float cz = dot(p / r, uSun);
      vec3 T = exp(-(BR * (odr + depth(h, HR, cz)) + BM * 1.1 * (odm + depth(h, HM, cz))));
      ins += T * (BR * dr * phR + BM * dm * phM);
      odr += dr * 0.5; odm += dm * 0.5;
    }
    Tv = exp(-(BR * odr + BM * 1.1 * odm));
  }
  vec3 col = vec3(0.0);
  if (hit) {
    vec3 p = ro + rd * tp.x, n = normalize(p);
    vec2 uv = dirToLL(n, 0.0), dx = dFdx(uv), dy = dFdy(uv);
    dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
    float ndl = dot(n, uSun);
    vec3 day = lin(dayTex(uv, dx, dy));
    // true colour from orbit: land muted and earthy, open ocean a deep navy that is almost black
    float lum = dot(day, vec3(0.2126, 0.7152, 0.0722));
    vec3 land = mix(vec3(lum), day, 0.62) * vec3(1.02, 0.97, 0.90) * 0.88;
    vec3 sea = mix(vec3(0.0035, 0.0090, 0.0200), day * vec3(0.10, 0.16, 0.26), 0.35);
    float ocean = textureGrad(uOcean, uv, dx, dy).r;
    day = mix(vec3(0.010, 0.025, 0.065), day, uTex); ocean = mix(1.0, ocean, uTex);
    // clouds: the live fluid where it runs, the real cloud cover elsewhere
    float inF; vec2 du;
    float cl = smoothstep(0.08, 0.75, cloudAt(n, dx, dy, inF, du)) * uTex;
    // cloud relief from the field's own gradient, so the deck has body and catches the light
    vec3 dpx = dFdx(p), dpy = dFdy(p), r1 = cross(dpy, n), r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    vec3 grad = (dFdx(cl) * r1 + dFdy(cl) * r2) / (abs(det) > 1e-12 ? det : 1e-12);
    vec3 cn = normalize(n - grad * 0.0012);
    // shadow cast by the deck along the sunlight
    vec3 ns = normalize(n + (uSun - n * ndl) * 0.007);
    float i2; vec2 d2;
    float cs = smoothstep(0.08, 0.75, cloudAt(ns, dx, dy, i2, d2)) * uTex;
    vec3 Ts = sunT(0.0, ndl);
    float lit = max(ndl, 0.0);
    vec3 alb = mix(land, sea, ocean);
    vec3 ground = alb * lit * (1.0 - 0.6 * cs) / PI;
    vec3 hv = normalize(uSun - rd);
    float nh = max(dot(n, hv), 0.0), fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    ground += ocean * (1.0 - cl) * (1.0 - cs) * lit * pow(nh, 28.0) * 0.025 * (0.25 + fres);
    float cd = clamp(dot(cn, uSun), 0.0, 1.0);
    float cw = mix(lit, cd * 1.08 + 0.05 * lit, 0.7) * 0.94 + 0.035 * smoothstep(-0.08, 0.06, ndl);
    vec3 cloudCol = vec3(0.80, 0.82, 0.86) * cw / PI;
    vec3 surf = mix(ground, cloudCol, cl);
    surf += alb * vec3(0.20, 0.32, 0.55) * 0.05 * smoothstep(-0.1, 0.3, ndl);
    col = surf * Ts * SUN * Tv;
  }
  col += ins * SUN + vec3(0.0006, 0.0008, 0.0014);
  o = vec4(col * uExpo, 1.0);
}`;

  // ---- the sky: stars and constellation figures, rotated to this moment
  const SKYV = `
uniform vec3 uC, uF, uRt, uUp; uniform float uTanY, uAspect, uGst;
vec3 toEarth(float ra, float de){ vec3 d = vec3(cos(de) * cos(ra), cos(de) * sin(ra), sin(de));
  float c = cos(uGst), s = sin(uGst); return vec3(c * d.x + s * d.y, -s * d.x + c * d.y, d.z); }
vec4 project(vec3 d){ return vec4(dot(d, uRt) / (uTanY * uAspect), dot(d, uUp) / uTanY, 0.0, dot(d, uF)); }`;
  const SKYF = `
uniform vec2 uRes; uniform vec3 uC, uF, uRt, uUp; uniform float uTanY, uAspect;
// hidden by the planet; dimmed by the column of air along a grazing ray
vec3 sightline(){
  vec2 q = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 rd = normalize(uF + q.x * uTanY * uAspect * uRt + q.y * uTanY * uUp);
  float b = dot(uC, rd), c = dot(uC, uC) - 1.0;
  if (b < 0.0 && b * b - c > 0.0) return vec3(-1.0);
  float hmin = b < 0.0 ? sqrt(max(dot(uC, uC) - b * b, 0.0)) - 1.0 : length(uC) - 1.0;
  float col = 0.0034 * exp(-hmin / 0.0034) * sqrt(6.2831853 * (1.0 + hmin) / 0.0034);
  return exp(-vec3(10.0, 25.0, 62.0) * col * 1.4);
}`;
  const V_STAR = H + `in vec4 aS; uniform float uDpr, uTime;` + SKYV + `
out float vI; out vec3 vCol;
void main(){
  vec3 d = toEarth(aS.x, aS.y);
  gl_Position = project(d);
  float m = aS.z;
  vI = clamp(12.0 * pow(10.0, -0.4 * (m - 1.0)), 0.30, 24.0) * (0.93 + 0.07 * sin(uTime * (0.7 + fract(aS.x * 91.7) * 1.6) + aS.y * 40.0));
  float t = clamp((aS.w + 0.3) / 2.2, 0.0, 1.0);
  vCol = mix(vec3(0.78, 0.86, 1.0), vec3(1.0, 0.86, 0.68), t);
  gl_PointSize = clamp(3.0 + 1.1 * (4.0 - m), 2.6, 8.0) * uDpr;
}`;
  const F_STAR = H + `in float vI; in vec3 vCol; out vec4 o;` + SKYF + `
void main(){ vec3 T = sightline(); if (T.x < 0.0) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
  float k = exp(-r2 * 9.0); o = vec4(vCol * vI * k * T, 1.0); }`;
  const V_LINE = H + `in vec2 aS;` + SKYV + `
void main(){ gl_Position = project(toEarth(aS.x, aS.y)); }`;
  const F_LINE = H + `out vec4 o; uniform float uA;` + SKYF + `
void main(){ vec3 T = sightline(); if (T.x < 0.0) discard; o = vec4(vec3(0.62, 0.72, 1.0) * uA * T, 1.0); }`;

  // ---- the logo star (positions in css px)
  const V_PX = `uniform vec2 uView; vec4 px(vec2 p){ return vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0); }`;
  const V_TRAIL = H + `in vec4 aA; in float aB;` + V_PX + `
out float vSide, vLife, vAlong;
void main(){ gl_Position = px(aA.xy); vSide = aA.z; vLife = aA.w; vAlong = aB; }`;
  const F_TRAIL = H + `in float vSide, vLife, vAlong; out vec4 o; uniform float uTime, uGain;
float h(float n){ return fract(sin(n) * 43758.5453); }
float n1(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h(i), h(i + 1.0), f); }
void main(){
  float s = vSide;
  float life = vLife;
  float shimmer = 0.62 + 0.38 * n1(vAlong * 0.09 - uTime * 7.0) * (0.7 + 0.3 * n1(vAlong * 0.31 + uTime * 3.0));
  float core = exp(-s * s * 90.0) * pow(life, 1.2) * 4.0;
  float body = exp(-s * s * 14.0) * pow(life, 1.8) * 0.45;
  float glow = exp(-s * s * 3.0) * pow(life, 2.6) * 0.06;
  o = vec4(vec3(1.0) * (core * shimmer + body * (0.6 + 0.4 * shimmer) + glow) * uGain, 1.0);
}`;
  const V_SPARK = H + `in vec4 aA; in vec2 aB;` + V_PX + `uniform float uDpr;
out float vI, vRot, vKind;
void main(){ gl_Position = px(aA.xy); gl_PointSize = aA.z * uDpr; vI = aA.w; vRot = aB.x; vKind = aB.y; }`;
  const F_SPARK = H + `in float vI, vRot, vKind; out vec4 o;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float c = cos(vRot), s = sin(vRot); p = mat2(c, -s, s, c) * p;
  float v;
  if (vKind > 0.5) {
    // a four-pointed sparkle with concave sides and a hot centre
    vec2 a = abs(p); float star = pow(a.x, 0.5) + pow(a.y, 0.5);
    v = smoothstep(1.0, 0.55, star) * 1.6 + exp(-dot(p, p) * 30.0) * 3.0;
    v += (exp(-a.y * 60.0) * (1.0 - a.x) + exp(-a.x * 60.0) * (1.0 - a.y)) * 0.9;
  } else v = exp(-dot(p, p) * 9.0);
  o = vec4(vec3(1.0) * v * vI, 1.0);
}`;
  const V_HEAD = H + `in vec2 aP;` + V_PX + `uniform vec2 uPos; uniform float uQ; out vec2 vP;
void main(){ vP = aP * uQ; gl_Position = px(uPos + vP); }`;
  const F_HEAD = H + `in vec2 vP; out vec4 o; uniform sampler2D uLogo; uniform float uS, uGlint, uTw, uFade, uFlare;
void main(){
  vec2 p = vP; float r = length(p);
  // the logo itself, in light
  vec2 su = vec2(0.5 + p.x / (uS * uTw), 0.5 - p.y / (uS * uTw));
  float logo = (su.x > 0.0 && su.x < 1.0 && su.y > 0.0 && su.y < 1.0) ? texture(uLogo, vec2(su.x, su.y)).a : 0.0;
  float v = logo * (5.0 + 5.0 * uGlint);
  // a white-hot centre and its corona
  v += exp(-r * r / (uS * uS * 0.0025)) * (10.0 + 16.0 * uGlint);
  v += exp(-r / (uS * 0.10)) * (0.6 + 0.8 * uGlint);
  v += exp(-r * r / (uS * uS * 0.5)) * 0.05;
  // cross flares along the star's own arms, long and thin, flaring on each glint
  vec2 a = abs(p);
  float L = uS * uFlare;
  float hx = exp(-a.y / 0.6) * exp(-pow(a.x / L, 1.3)), vy = exp(-a.x / 0.6) * exp(-pow(a.y / (L * 0.85), 1.3));
  float wide = exp(-a.y / 2.0) * exp(-a.x / (L * 0.45)) + exp(-a.x / 2.0) * exp(-a.y / (L * 0.4));
  v += (hx + vy) * (2.4 + 3.5 * uGlint) + wide * 0.25;
  // finer diagonal glints, only as it catches the light
  vec2 d = vec2(p.x + p.y, p.x - p.y) * 0.7071; vec2 ad = abs(d);
  v += (exp(-ad.y / 0.45) * exp(-ad.x / (L * 0.42)) + exp(-ad.x / 0.45) * exp(-ad.y / (L * 0.42))) * (0.25 + 2.6 * uGlint);
  o = vec4(vec3(1.0) * v * uFade, 1.0);
}`;

  // ---- bloom and the final image
  const F_PRE = FQ + `uniform sampler2D uSrc, uFx; uniform vec2 uSrcTexel; uniform float uThr, uKnee;
vec3 tap(vec2 u){ return texture(uSrc, u).rgb + texture(uFx, u).rgb; }
void main(){ vec2 t = uSrcTexel;
  vec3 c = (tap(vUv + vec2(-t.x, -t.y)) + tap(vUv + vec2(t.x, -t.y)) + tap(vUv + vec2(-t.x, t.y)) + tap(vUv + vec2(t.x, t.y))) * 0.25;
  float br = max(c.r, max(c.g, c.b)); float s = clamp(br - uThr + uKnee, 0.0, 2.0 * uKnee); s = s * s / (4.0 * uKnee + 1e-5);
  o = vec4(c * max(s, br - uThr) / max(br, 1e-5), 1.0); }`;
  const F_DOWN = FQ + `uniform sampler2D uSrc; uniform vec2 uSrcTexel;
void main(){ vec2 t = uSrcTexel;
  vec3 a = texture(uSrc, vUv).rgb * 0.5;
  vec3 b = (texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(t.x, t.y)).rgb) * 0.125;
  o = vec4(a + b, 1.0); }`;
  const F_UP = FQ + `uniform sampler2D uSrc; uniform vec2 uSrcTexel; uniform float uK;
void main(){ vec2 t = uSrcTexel;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(t.x, 0.0)).rgb + texture(uSrc, vUv - vec2(t.x, 0.0)).rgb + texture(uSrc, vUv + vec2(0.0, t.y)).rgb + texture(uSrc, vUv - vec2(0.0, t.y)).rgb) * 2.0;
  c += texture(uSrc, vUv + t).rgb + texture(uSrc, vUv - t).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(-t.x, t.y)).rgb;
  o = vec4(c / 16.0 * uK, 1.0); }`;
  const F_COMP = FQ + `uniform sampler2D uHdr, uFx, uBloom; uniform float uBloomK, uWide, uTime; uniform vec2 uRes;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec3 b = texture(uBloom, vUv).rgb * uBloomK;
  vec3 c = pow(aces(texture(uHdr, vUv).rgb + b * 0.5), vec3(1.0 / 2.2));
  if (uWide > 0.5) {
    float s = (1.0 - smoothstep(0.0, 0.68, vUv.x)) * 0.70 + (1.0 - smoothstep(0.0, 0.45, vUv.y)) * 0.42;
    c *= 1.0 - clamp(s, 0.0, 0.84);
  } else c = mix(c, vec3(0.012, 0.014, 0.020), 1.0 - smoothstep(0.0, 0.32, vUv.y));
  // the logo star and its glow ride above the shading, so they stay pure white
  vec3 fx = pow(aces(texture(uFx, vUv).rgb + b * 0.5), vec3(1.0 / 2.2));
  c = 1.0 - (1.0 - c) * (1.0 - fx);
  c += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

  // ===================================================================== GL plumbing
  let broken = false;
  function program(vs, fs, attrs) {
    const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('[earth]', gl.getShaderInfoLog(s), src.slice(0, 200)); broken = true; } return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    (attrs || ['aP']).forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('[earth]', gl.getProgramInfoLog(p)); broken = true; }
    const L = {};
    const u = n => (n in L) ? L[n] : (L[n] = gl.getUniformLocation(p, n));
    return {
      p, use() { gl.useProgram(p); return this; },
      f(n, ...v) { const l = u(n); if (l) gl['uniform' + v.length + 'f'](l, ...v); return this; },
      v(n, a) { const l = u(n); if (l) gl['uniform' + a.length + 'fv'](l, a); return this; },
      arr(n, a) { const l = u(n); if (l) gl.uniform4fv(l, a); return this; },
      t(n, unit, tex) { const l = u(n); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); if (l) gl.uniform1i(l, unit); return this; },
    };
  }
  const P = {
    advect: program(VSQ, F_ADVECT), div: program(VSQ, F_DIV), curl: program(VSQ, F_CURL), vort: program(VSQ, F_VORT),
    press: program(VSQ, F_PRESS), grad: program(VSQ, F_GRAD), scale: program(VSQ, F_SCALE), splat: program(VSQ, F_SPLAT),
    wind: program(VSQ, F_WIND), disp: program(VSQ, F_DISP),
    earth: program(H + 'in vec2 aP; void main(){ gl_Position = vec4(aP, 0.0, 1.0); }', F_EARTH),
    star: program(V_STAR, F_STAR, ['aS']), line: program(V_LINE, F_LINE, ['aS']),
    trail: program(V_TRAIL, F_TRAIL, ['aA', 'aB']), spark: program(V_SPARK, F_SPARK, ['aA', 'aB']), head: program(V_HEAD, F_HEAD, ['aP']),
    pre: program(VSQ, F_PRE), down: program(VSQ, F_DOWN), up: program(VSQ, F_UP), comp: program(VSQ, F_COMP),
  };
  if (broken) { fallback(); return; }

  host.dataset.scene = 'earth';
  host.appendChild(canvas);

  const tri = gl.createVertexArray(); gl.bindVertexArray(tri);
  const triBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function target(w, h, filter) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h, tx: [1 / w, 1 / h], free() { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); } };
  }
  function pair(w, h, f) { let a = target(w, h, f), b = target(w, h, f);
    return { get read() { return a; }, get write() { return b; }, swap() { const t = a; a = b; b = t; }, free() { a.free(); b.free(); } }; }
  function quad(prog, out, texel) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.viewport(0, 0, out ? out.w : canvas.width, out ? out.h : canvas.height);
    prog.f('uTexel', ...(texel || (out ? out.tx : [1 / canvas.width, 1 / canvas.height])));
    gl.bindVertexArray(tri); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // check float targets actually render here
  { const t = target(4, 4, gl.NEAREST); const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; t.free();
    if (!ok) { host.removeChild(canvas); fallback(); return; } }

  // ===================================================================== textures
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  function texture(w, h, data) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data || new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function fill(t, img, wrap, mono) {
    gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (mono) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, img);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (wrap) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  const TX = { day: texture(1, 1), clouds: texture(1, 1), dayHi: texture(1, 1), cloudsHi: texture(1, 1), ocean: texture(1, 1), logo: texture(1, 1, new Uint8Array([0, 0, 0, 0])) };
  const BASE = new URL('../assets/', SELF);
  const maxT = gl.getParameter(gl.MAX_TEXTURE_SIZE), mem = navigator.deviceMemory || 8;
  const texBig = !mobile && maxT >= 8192 && mem >= 4;
  const sz = '2048', hiSz = texBig ? 8192 : maxT >= 4096 ? 4096 : 0;
  let texOK = 0;
  const base = Promise.all([['day', 'earth/day-' + sz + '.jpg'], ['clouds', 'earth/clouds-' + sz + '.jpg'], ['ocean', 'earth/ocean-4096.jpg']].map(([k, f]) =>
    new Promise((res, rej) => { const im = new Image(); im.decoding = 'async'; im.onload = () => { fill(TX[k], im, true, k !== 'day'); res(); }; im.onerror = rej; im.src = new URL(f, BASE).href; })
  )).catch(e => console.warn('[earth] maps', e));

  // the logo star, rasterised once from the brand mark
  const LOGO = 'M1023.1 1770.5C1023.0 1707.0 1022.4 1651.5 1020.0 1492.5C1019.5 1454.5 1018.6 1385.5 1018.0 1339.0C1017.5 1292.5 1016.6 1222.3 1016.0 1183.0C1015.5 1143.7 1014.5 1071.5 1014.0 1022.5C1011.4 795.7 1009.2 722.9 1004.0 691.7C999.6 665.1 989.1 643.4 972.7 626.8C955.2 609.1 941.2 601.1 917.0 595.1C908.7 593.1 880.9 589.1 860.0 587.0C808.9 581.8 785.0 580.1 735.5 578.0C721.2 577.4 704.3 576.5 698.0 575.9C691.7 575.4 677.5 574.9 666.5 574.8L646.5 574.7L662.5 573.9C671.3 573.6 695.4 572.3 716.0 571.1C736.6 570.0 761.8 568.6 772.0 568.0C844.3 564.0 870.2 561.3 906.2 553.9C930.0 549.1 939.3 545.5 954.5 535.5C982.8 516.7 1000.0 484.3 1006.0 438.5C1011.1 399.4 1017.7 303.5 1021.1 220.0C1021.7 205.4 1022.5 187.7 1022.9 180.5L1023.7 167.5L1023.9 179.0C1024.0 185.3 1024.5 198.4 1025.0 208.0C1025.5 217.6 1026.4 234.1 1027.0 244.5C1027.5 254.9 1028.4 273.4 1029.0 285.5C1034.1 398.9 1034.6 407.2 1039.6 440.0C1042.4 458.5 1047.7 477.6 1054.1 491.7C1063.4 512.4 1081.3 530.6 1102.9 541.4C1116.5 548.2 1125.6 551.3 1141.0 554.4C1174.2 560.9 1217.9 565.0 1300.0 569.0C1312.4 569.6 1332.6 570.9 1345.0 571.7C1357.4 572.6 1374.5 573.6 1383.0 574.0L1398.5 574.6L1378.5 574.8C1367.5 574.9 1352.2 575.4 1344.5 575.9C1336.8 576.4 1320.2 577.4 1307.5 578.0C1253.4 580.6 1249.5 580.9 1200.5 585.5C1132.5 591.8 1109.7 597.6 1087.5 614.2C1068.8 628.2 1056.4 645.7 1048.6 669.0C1044.1 682.5 1042.4 692.6 1040.5 716.3C1037.5 755.9 1034.3 906.8 1032.0 1122.5C1030.1 1299.9 1029.1 1402.8 1028.5 1469.5C1028.1 1506.3 1027.2 1574.8 1026.4 1621.5C1025.7 1668.2 1025.0 1734.6 1024.9 1769.0C1024.8 1803.4 1024.4 1832.8 1024.0 1834.5C1023.6 1836.2 1023.2 1807.3 1023.1 1770.5Z';
  {
    const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
    const x = c.getContext('2d'), k = (n / 2) / 432;
    x.translate(n / 2, n / 2); x.scale(k, k); x.translate(-1023.4, -574.6);
    x.beginPath(); x.rect(579.5, 113.8, 885, 885); x.clip();
    x.fillStyle = '#fff'; x.fill(new Path2D(LOGO), 'evenodd');
    gl.bindTexture(gl.TEXTURE_2D, TX.logo); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  // ===================================================================== the sky, from the catalogue
  const sky = { stars: 0, lines: 0, vaoS: gl.createVertexArray(), vaoL: gl.createVertexArray() };
  const skyP = fetch(new URL('sky/sky.json', BASE)).then(r => r.json()).then(j => {
    const D = Math.PI / 18000, s = j.stars, l = j.lines;
    const a = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 4) { a[i] = s[i] * D; a[i + 1] = s[i + 1] * D; a[i + 2] = s[i + 2] / 100; a[i + 3] = s[i + 3] / 100; }
    const b = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) b[i] = l[i] * D;
    gl.bindVertexArray(sky.vaoS); let buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(sky.vaoL); buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, b, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    sky.stars = a.length / 4; sky.lines = b.length / 2;
  }).catch(e => console.warn('[earth] sky', e));

  // ===================================================================== where we are, right now
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sc: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; },
  };
  const DEG = Math.PI / 180;
  // Greenwich sidereal angle and the Sun's direction in the Earth-fixed frame (low-precision almanac)
  function almanac(ms) {
    const n = ms / 86400000 + 2440587.5 - 2451545.0;
    const gst = ((280.46061837 + 360.98564736629 * n) % 360) * DEG;
    const L = (280.460 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
    const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG, eps = (23.439 - 4e-7 * n) * DEG;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), de = Math.asin(Math.sin(eps) * Math.sin(lam));
    const x = Math.cos(de) * Math.cos(ra), y = Math.cos(de) * Math.sin(ra), c = Math.cos(gst), s = Math.sin(gst);
    return { gst, sun: [c * x + s * y, -s * x + c * y, Math.sin(de)] };
  }
  // the spacecraft starts some way west of the noon point, so the planet below is in daylight with the
  // Sun high on the right and evening falling at the far left; its heading is set by where the Sun is
  const A0 = almanac(clock0);
  const subLat = Math.asin(A0.sun[2]), subLon = Math.atan2(A0.sun[1], A0.sun[0]);
  const LAT0 = Math.max(-45 * DEG, Math.min(50 * DEG, subLat + 14 * DEG)), LON0 = subLon - 50 * DEG, BETA = 14 * DEG;
  const s0 = [Math.cos(LAT0) * Math.cos(LON0), Math.cos(LAT0) * Math.sin(LON0), Math.sin(LAT0)];
  const uh = V.norm(V.add(A0.sun, V.sc(s0, -V.dot(A0.sun, s0)))), wv = V.cross(s0, uh);
  const f0 = V.add(V.sc(uh, Math.sin(BETA)), V.sc(wv, Math.cos(BETA)));

  // high-detail window: half the globe in longitude and in latitude, centred ahead of the spacecraft,
  // cut straight out of the full-resolution maps so only the region in view is held on the GPU
  const crop = (() => {
    const lonC = LON0 + 15 * DEG, latTop = Math.min(90 * DEG, Math.max(0, LAT0 + 55 * DEG));
    return [(((lonC - Math.PI / 2) / (2 * Math.PI) + 0.5) % 1 + 1) % 1, 0.5 - latTop / Math.PI, 0.5, 0.5];
  })();
  let hiOK = 0;
  async function window8k(t, file, mono, S) {
    const blob = await (await fetch(new URL(file, BASE))).blob();
    const W = S / 2, Hc = S / 4, x0 = Math.round(crop[0] * S), y0 = Math.round(crop[1] * S / 2);
    const parts = x0 + W <= S ? [[x0, W, 0]] : [[x0, S - x0, 0], [0, W - (S - x0), S - x0]];
    const fmt = mono ? [gl.R8, gl.RED] : [gl.RGB8, gl.RGB];
    const bms = await Promise.all(parts.map(([sx, sw]) => createImageBitmap(blob, sx, y0, sw, Hc, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })));
    gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt[0], W, Hc, 0, fmt[1], gl.UNSIGNED_BYTE, null);
    parts.forEach(([, , dx], i) => { gl.texSubImage2D(gl.TEXTURE_2D, 0, dx, 0, fmt[1], gl.UNSIGNED_BYTE, bms[i]); bms[i].close && bms[i].close(); });
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  const hi = hiSz ? Promise.all([window8k(TX.dayHi, 'earth/day-' + hiSz + '.jpg', false, hiSz), window8k(TX.cloudsHi, 'earth/clouds-' + hiSz + '.jpg', true, hiSz)])
    .then(() => { hiOK = 1; }).catch(e => console.warn('[earth] detail', e)) : Promise.resolve();
  const loaded = Promise.all([base, hi]).then(() => { texOK = 1; if (fl.sim) fl.sim.primed = false; });
  const ORBIT = 0.0016;                               // radians of orbit per second
  const CLOUD = 0.00006;
                                // the real cloud cover's slow drift, turns per second

  let W = 1, Hh = 1, DPR = 1, alt = 0.4, tanY = 0.4, wide = true, pitch = 0;
  function rigAt(t) {
    const a = t * ORBIT, ca = Math.cos(a), sa = Math.sin(a);
    const s = V.add(V.sc(s0, ca), V.sc(f0, sa)), fH = V.add(V.sc(f0, ca), V.sc(s0, -sa));
    const right = V.norm(V.cross(fH, s));
    const f = V.norm(V.add(V.sc(fH, Math.cos(pitch)), V.sc(s, -Math.sin(pitch))));
    const up = V.cross(right, f);
    return { s, fH, C: V.sc(s, 1 + alt), f, right, up };
  }
  function rayAt(rig, qx, qy) { return V.norm(V.add(V.add(rig.f, V.sc(rig.right, qx * tanY * (W / Hh))), V.sc(rig.up, qy * tanY))); }
  function hitPlanet(rig, rd) {
    const b = V.dot(rig.C, rd), c = V.dot(rig.C, rig.C) - 1, h = b * b - c;
    if (h < 0 || -b < 0) return null;
    return V.norm(V.add(rig.C, V.sc(rd, -b - Math.sqrt(h))));
  }
  function toDomain(rig, n) {
    const c = Math.max(-1, Math.min(1, V.dot(n, rig.s))), r = Math.acos(c), h = V.add(n, V.sc(rig.s, -c)), hl = Math.hypot(...h) || 1e-6;
    return [r * V.dot(h, rig.right) / hl, r * V.dot(h, rig.fH) / hl];
  }

  // ===================================================================== the fluid
  const fl = { on: !reduced, dom: [0, 0, 1, 1], asp: 1, sim: null };
  function fluidSize() {
    const rig = rigAt(0);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
      const n = hitPlanet(rig, rayAt(rig, i / 8 - 1, j / 8 - 1)); if (!n) continue;
      const d = toDomain(rig, n); x0 = Math.min(x0, d[0]); x1 = Math.max(x1, d[0]); y0 = Math.min(y0, d[1]); y1 = Math.max(y1, d[1]);
    }
    if (x0 > x1) { x0 = -0.5; x1 = 0.5; y0 = -0.5; y1 = 0.5; }
    const m = 0.05; fl.dom = [x0 - m, y0 - m, x1 + m, y1 + m];
    fl.asp = (fl.dom[2] - fl.dom[0]) / (fl.dom[3] - fl.dom[1]);
    const dims = b => fl.asp >= 1 ? [Math.round(b * fl.asp), b] : [b, Math.round(b / fl.asp)];
    const [sw, sh] = dims(mobile ? 96 : 128), [dw, dh] = dims(mobile ? 900 : (texBig ? 1600 : 1100));
    if (fl.sim && fl.sim.sw === sw && fl.sim.sh === sh) return;
    if (fl.sim) { fl.sim.vel.free(); fl.sim.disp.free(); fl.sim.p.free(); fl.sim.div.free(); fl.sim.curl.free(); }
    fl.sim = { sw, sh, dw, dh, simTx: [1 / sw, 1 / sh], vel: pair(sw, sh, gl.LINEAR), disp: pair(sw, sh, gl.LINEAR), p: pair(sw, sh, gl.NEAREST), div: target(sw, sh, gl.NEAREST), curl: target(sw, sh, gl.NEAREST), primed: false };
  }
  const cyc = new Float32Array(12);
  function cyclones(t) {
    // x, y (domain), radius, spin: slow storms wandering across the patch
    const C = [[0.66, 0.42, 0.13, 1.0, 0.011, 0.007], [0.30, 0.66, 0.10, -0.85, -0.008, 0.009], [0.48, 0.18, 0.09, 0.9, 0.009, -0.006]];
    C.forEach(([x, y, r, w, vx, vy], i) => {
      cyc[i * 4] = ((x + vx * t) % 1 + 1) % 1; cyc[i * 4 + 1] = 0.08 + 0.84 * (((y + vy * t) % 1 + 1) % 1);
      cyc[i * 4 + 2] = r; cyc[i * 4 + 3] = Math.abs(w) * 0.55;
    });
  }
  function fluidStep(dt, t, rig, rot) {
    const S = fl.sim, k = Math.min(S.sw, S.sh);
    const drift = [0, -ORBIT * S.sh / (fl.dom[3] - fl.dom[1])];
    cyclones(t);
    P.wind.use().t('uSrc', 0, S.vel.read.tex).f('uT', t).f('uDt', dt).f('uAsp', fl.asp).f('uSpeed', k * 0.25).f('uRate', 0.5).arr('uCyc', cyc)
      .v('uS', rig.s).v('uRt', rig.right).v('uFh', rig.fH).v('uDom', fl.dom);
    quad(P.wind, S.vel.write); S.vel.swap();
    for (const sp of stir.splats.splice(0)) {
      P.splat.use().t('uSrc', 0, S.vel.read.tex).f('uPt', sp[0], sp[1]).f('uCol', sp[2], sp[3], 0).f('uRad', 0.0022).f('uAsp', fl.asp);
      quad(P.splat, S.vel.write); S.vel.swap();
    }
    P.curl.use().t('uVel', 0, S.vel.read.tex); quad(P.curl, S.curl);
    P.vort.use().t('uVel', 0, S.vel.read.tex).t('uCurl', 1, S.curl.tex).f('uCurlK', 0).f('uDt', dt); quad(P.vort, S.vel.write); S.vel.swap();
    P.div.use().t('uVel', 0, S.vel.read.tex); quad(P.div, S.div);
    P.scale.use().t('uSrc', 0, S.p.read.tex).f('uK', 0.8); quad(P.scale, S.p.write); S.p.swap();
    P.press.use().t('uDiv', 1, S.div.tex);
    for (let i = 0; i < (mobile ? 16 : 22); i++) { P.press.t('uP', 0, S.p.read.tex); quad(P.press, S.p.write); S.p.swap(); }
    P.grad.use().t('uP', 0, S.p.read.tex).t('uVel', 1, S.vel.read.tex); quad(P.grad, S.vel.write); S.vel.swap();
    P.advect.use().t('uVel', 0, S.vel.read.tex).t('uSrc', 1, S.vel.read.tex).f('uSimTexel', ...S.simTx).f('uDrift', ...drift).f('uDt', dt).f('uDiss', 0.15);
    quad(P.advect, S.vel.write); S.vel.swap();
    // clouds: how far the winds have pushed the deck
    if (fl.fill) { P.scale.use().t('uSrc', 0, S.disp.read.tex).f('uK', 0); quad(P.scale, S.disp.write); S.disp.swap(); }
    P.disp.use().t('uVel', 0, S.vel.read.tex).t('uSrc', 1, S.disp.read.tex).f('uSimTexel', ...S.simTx).f('uDrift', ...drift).f('uDt', dt).f('uK', 0.15);
    quad(P.disp, S.disp.write); S.disp.swap();
  }

  // a cursor or finger drawn across the planet stirs the weather
  const card = host.parentElement || host;
  const stir = { last: null, splats: [] };
  function stirAt(cx, cy, tms) {
    if (!fl.sim) return;
    const r = host.getBoundingClientRect();
    const qx = (cx - r.left) / r.width * 2 - 1, qy = 1 - (cy - r.top) / r.height * 2;
    if (Math.abs(qx) > 1 || Math.abs(qy) > 1) { stir.last = null; return; }
    const rig = rigAt(now()), n = hitPlanet(rig, rayAt(rig, qx, qy));
    if (!n) { stir.last = null; return; }
    const d = toDomain(rig, n), u = (d[0] - fl.dom[0]) / (fl.dom[2] - fl.dom[0]), v = (d[1] - fl.dom[1]) / (fl.dom[3] - fl.dom[1]);
    if (stir.last && tms - stir.last[2] < 200) {
      const dt = Math.max(8, tms - stir.last[2]) / 1000, S = fl.sim;
      let fx = (u - stir.last[0]) / dt * S.sw * 0.9, fy = (v - stir.last[1]) / dt * S.sh * 0.9;
      const m = Math.hypot(fx, fy), cap = 900; if (m > cap) { fx *= cap / m; fy *= cap / m; }
      if (stir.splats.length < 12) stir.splats.push([u, v, fx, fy]);
    }
    stir.last = [u, v, tms];
  }
  card.addEventListener('pointermove', e => stirAt(e.clientX, e.clientY, e.timeStamp));
  card.addEventListener('pointerleave', () => { stir.last = null; });

  // ===================================================================== the logo star
  const comet = { on: !reduced, hist: [], parts: [], start: 0, next: 2.6, trailBuf: gl.createBuffer(), partBuf: gl.createBuffer(),
    vaoT: gl.createVertexArray(), vaoP: gl.createVertexArray(), vaoH: gl.createVertexArray(), glintT: -1e9, nextGlint: 0, nextShed: 0 };
  gl.bindVertexArray(comet.vaoT); gl.bindBuffer(gl.ARRAY_BUFFER, comet.trailBuf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
  gl.bindVertexArray(comet.vaoP); gl.bindBuffer(gl.ARRAY_BUFFER, comet.partBuf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
  gl.bindVertexArray(comet.vaoH); { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW); }
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const trailData = new Float32Array(2400 * 2 * 5), partData = new Float32Array(1200 * 6);
  const rnd = (a, b) => a + Math.random() * (b - a);
  function launch(t) {
    const small = W < 760, pad = 90;
    const p0 = [-pad, Hh + pad * 0.3 - Math.random() * Hh * 0.15], p1 = [W * rnd(0.22, 0.34), Hh * rnd(0.08, 0.26)], p2 = [W + pad, Hh * rnd(0.28, 0.50)];
    const M = 300, tab = [0], pts = []; let L = 0;
    for (let i = 0; i <= M; i++) {
      const s = i / M, u = 1 - s;
      const x = u * u * p0[0] + 2 * u * s * p1[0] + s * s * p2[0], y = u * u * p0[1] + 2 * u * s * p1[1] + s * s * p2[1];
      if (i) { L += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]); tab.push(L); }
      pts.push([x, y]);
    }
    Object.assign(comet, { pts, tab, L, M, start: t, speed: rnd(0.38, 0.50) * 1000, S: small ? 30 : 44,
      TRAIL: small ? 1.4 : 1.8, hist: [], flying: true, nextGlint: t + rnd(0.5, 0.9), nextShed: t, dist: 0 });
  }
  function along(d) {
    const { tab, pts, M } = comet; let lo = 0, hi = M;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (tab[m] < d) lo = m; else hi = m; }
    const f = (d - tab[lo]) / Math.max(1e-6, tab[hi] - tab[lo]);
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  }
  function cometStep(t, dt) {
    if (!comet.flying && t >= comet.next && W > 1) launch(t);
    const c = comet, S = c.S || 40;
    if (c.flying) {
      const d = (t - c.start) * c.speed;
      if (d >= c.L) { c.flying = false; c.next = t + rnd(7, 12); }
      else {
        const p = along(d), q = along(Math.min(c.L, d + 2)), dl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, tx = (q[0] - p[0]) / dl, ty = (q[1] - p[1]) / dl;
        c.x = p[0]; c.y = p[1]; c.e = d / c.L;
        c.hist.push([p[0], p[1], t, d]);
        while (t >= c.nextShed) {
          c.nextShed += rnd(0.03, 0.07);
          const off = rnd(-1, 1) * S * 0.3;
          c.parts.push({ k: 1, x: p[0] - ty * off, y: p[1] + tx * off, vx: -tx * rnd(4, 18) + rnd(-8, 8), vy: -ty * rnd(4, 18) + rnd(0, 16), b: t, life: rnd(0.7, 1.5), r: rnd(0.35, 0.75) * S, rot: rnd(-0.3, 0.3), spin: rnd(-1.2, 1.2), I: rnd(0.8, 1.6) });
          for (let m = 0; m < 3; m++) c.parts.push({ k: 0, x: p[0] + rnd(-4, 4), y: p[1] + rnd(-4, 4), vx: rnd(-22, 22), vy: rnd(-8, 30), b: t, life: rnd(0.5, 1.4), r: rnd(3, 6), rot: 0, spin: 0, I: rnd(0.6, 1.6) });
        }
        if (t >= c.nextGlint) {
          c.glintT = t; c.nextGlint = t + rnd(0.7, 1.5);
          const nb = 5 + (Math.random() * 4 | 0);
          for (let b = 0; b < nb; b++) { const a = rnd(0, 6.2832), sp = rnd(30, 80);
            c.parts.push({ k: 1, x: p[0], y: p[1], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, b: t, life: rnd(0.45, 0.85), r: rnd(0.3, 0.6) * S, rot: rnd(-0.4, 0.4), spin: rnd(-3, 3), I: rnd(1.2, 2.2), drag: 1 }); }
        }
      }
    }
    while (c.hist.length && t - c.hist[0][2] > c.TRAIL) c.hist.shift();
    for (let i = c.parts.length - 1; i >= 0; i--) {
      const p = c.parts[i];
      if (t - p.b >= p.life) { c.parts.splice(i, 1); continue; }
      if (p.drag) { const k = Math.exp(-dt * 2.5); p.vx *= k; p.vy *= k; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
    }
  }
  function cometDraw(t) {
    const c = comet, S = c.S || 40;
    // the trail: a ribbon that follows the true path, tapering, shimmering, fading with age
    const h = c.hist;
    if (h.length > 1) {
      let n = 0;
      for (let i = 0; i < h.length; i++) {
        const a = h[Math.max(0, i - 1)], b = h[Math.min(h.length - 1, i + 1)];
        let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
        const life = Math.max(0, 1 - (t - h[i][2]) / c.TRAIL);
        const w = (S * 0.34) * (0.25 + 0.75 * Math.pow(life, 0.7)) + 1.5;
        for (const sd of [-1, 1]) {
          trailData[n++] = h[i][0] - ty * w * sd; trailData[n++] = h[i][1] + tx * w * sd; trailData[n++] = sd; trailData[n++] = life; trailData[n++] = h[i][3];
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, c.trailBuf); gl.bufferData(gl.ARRAY_BUFFER, trailData.subarray(0, n), gl.DYNAMIC_DRAW);
      P.trail.use().f('uView', W, Hh).f('uTime', t).f('uGain', c.flying ? Math.min(1, c.e / 0.05) : 1);
      gl.bindVertexArray(c.vaoT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, n / 5);
    }
    // sparkles pop in and out; motes drift and fade
    if (c.parts.length) {
      let n = 0;
      for (const p of c.parts) {
        if (n >= partData.length - 6) break;
        const a = (t - p.b) / p.life;
        const pop = p.k ? Math.sin(Math.PI * Math.min(1, a * 1.12)) : 1 - a;
        const tw = p.k ? 0.7 + 0.3 * Math.sin(t * 26 + p.b * 50) : 1;
        partData[n++] = p.x; partData[n++] = p.y; partData[n++] = p.r * (p.k ? (0.4 + 0.6 * pop) : 1); partData[n++] = p.I * pop * tw * (p.k ? 1 : 0.6);
        partData[n++] = p.rot; partData[n++] = p.k;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, c.partBuf); gl.bufferData(gl.ARRAY_BUFFER, partData.subarray(0, n), gl.DYNAMIC_DRAW);
      P.spark.use().f('uView', W, Hh).f('uDpr', DPR);
      gl.bindVertexArray(c.vaoP); gl.drawArrays(gl.POINTS, 0, n / 6);
    }
    // the star itself
    if (c.flying) {
      const e = c.e, fade = e < 0.05 ? e / 0.05 : e > 0.93 ? (1 - e) / 0.07 : 1;
      const g = Math.exp(-(t - c.glintT) / 0.22);
      const tw = 1 + 0.05 * Math.sin(t * 11) + 0.03 * Math.sin(t * 29) + 0.22 * g;
      const flare = (0.85 + 0.12 * Math.sin(t * 17)) * (1 + 1.3 * g);
      P.head.use().f('uView', W, Hh).f('uPos', c.x, c.y).f('uQ', S * flare * 4.5).t('uLogo', 0, TX.logo)
        .f('uS', S).f('uGlint', g).f('uTw', tw).f('uFade', fade).f('uFlare', flare);
      gl.bindVertexArray(c.vaoH); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // ===================================================================== frame
  let hdr = null, fx = null, mips = [];
  function layout() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, r.width); Hh = Math.max(1, r.height);
    const stacked = getComputedStyle(host).position === 'relative';
    wide = !stacked && W / Hh > 1.15;
    const want = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.6);
    DPR = Math.min(want, Math.sqrt((mobile ? 1.3e6 : 2.8e6) / (W * Hh)));
    canvas.width = Math.max(1, Math.round(W * DPR)); canvas.height = Math.max(1, Math.round(Hh * DPR));
    const asp = W / Hh;
    alt = asp > 1.15 ? 0.40 : 0.50;
    tanY = Math.tan((asp > 1.15 ? 20 : 27) * DEG);
    pitch = Math.acos(1 / (1 + alt)) + Math.atan((wide ? 0.30 : 0.42) * tanY);
    if (hdr) { hdr.free(); fx.free(); mips.forEach(m => m.free()); }
    hdr = target(canvas.width, canvas.height, gl.LINEAR); fx = target(canvas.width, canvas.height, gl.LINEAR);
    mips = []; let w = canvas.width >> 1, h = canvas.height >> 1;
    for (let i = 0; i < 6 && w > 4 && h > 4; i++) { mips.push(target(w, h, gl.LINEAR)); w >>= 1; h >>= 1; }
    fluidSize();
    if (!running) draw(now(), 0);
  }

  let t = 0, running = false, frameCount = 0;
  let tFix = frozen;
  const now = () => tFix !== null ? tFix : t;
  function draw(tt, dt) {
    const rig = rigAt(tt), A = almanac(clock0 + tt * 1000);
    const rot = (tt * CLOUD) % 1;
    if (fl.on && fl.sim) {
      if (!fl.sim.primed) { fl.fill = 1; for (let i = 0; i < 90; i++) fluidStep(1 / 30, tt - 3 + i / 30, rig, rot); fl.fill = 0; fl.sim.primed = true; }
      if (dt > 0) fluidStep(Math.min(dt, 1 / 30), tt, rig, rot);
    }
    gl.disable(gl.BLEND);
    // the planet
    P.earth.use().f('uRes', canvas.width, canvas.height).f('uTanY', tanY).f('uAspect', W / Hh).f('uTex', texOK).f('uFluid', fl.on && fl.sim ? 1 : 0)
      .f('uRot', rot).f('uExpo', 0.30).v('uC', rig.C).v('uF', rig.f).v('uRt', rig.right).v('uUp', rig.up).v('uSun', A.sun)
      .v('uS', rig.s).v('uFh', rig.fH).v('uDom', fl.dom)
      .t('uDay', 0, TX.day).t('uClouds', 1, TX.clouds).t('uOcean', 2, TX.ocean).t('uDayHi', 5, TX.dayHi).t('uCloudsHi', 6, TX.cloudsHi).v('uCrop', crop).f('uHi', hiOK)
      .t('uDisp', 3, fl.sim ? fl.sim.disp.read.tex : TX.ocean);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo); gl.viewport(0, 0, hdr.w, hdr.h);
    gl.bindVertexArray(tri); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // the sky and the star, added in light
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    const cam = p => p.f('uRes', canvas.width, canvas.height).f('uTanY', tanY).f('uAspect', W / Hh).f('uGst', A.gst)
      .v('uC', rig.C).v('uF', rig.f).v('uRt', rig.right).v('uUp', rig.up);
    if (sky.stars) { cam(P.star.use()).f('uDpr', DPR).f('uTime', tt); gl.bindVertexArray(sky.vaoS); gl.drawArrays(gl.POINTS, 0, sky.stars); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fx.fbo); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (comet.on) cometDraw(tt);
    gl.disable(gl.BLEND);
    // bloom
    P.pre.use().t('uSrc', 0, hdr.tex).t('uFx', 1, fx.tex).f('uSrcTexel', ...hdr.tx).f('uThr', 3.0).f('uKnee', 0.5); quad(P.pre, mips[0]);
    for (let i = 1; i < mips.length; i++) { P.down.use().t('uSrc', 0, mips[i - 1].tex).f('uSrcTexel', ...mips[i - 1].tx); quad(P.down, mips[i]); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = mips.length - 1; i > 0; i--) { P.up.use().t('uSrc', 0, mips[i].tex).f('uSrcTexel', ...mips[i].tx).f('uK', 1.0); quad(P.up, mips[i - 1]); }
    gl.disable(gl.BLEND);
    P.comp.use().t('uHdr', 0, hdr.tex).t('uBloom', 1, mips[0].tex).t('uFx', 2, fx.tex).f('uBloomK', 0.18).f('uWide', wide ? 1 : 0).f('uTime', tt).f('uRes', canvas.width, canvas.height);
    quad(P.comp, null);
    frameCount++;
  }

  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }, { threshold: 0 }).observe(host);
  new ResizeObserver(layout).observe(host);
  layout();

  const ready = () => { window.__heroReady = true; };
  Promise.all([loaded, skyP]).then(() => {
    if (frozen !== null) {
      // a still for review: run the weather and, if asked, the star up to the requested moment
      if (fl.sim) fl.sim.primed = false;
      if (fl.sim && params.has('sim')) { draw(now(), 0); for (let i = 0, n = Math.round(parseFloat(params.get('sim')) * 30); i < n; i++) { tFix = frozen + i / 30; draw(tFix, 1 / 30); } }
      const cs = params.get('star');
      if (cs !== null && comet.on) { launch(frozen); const end = frozen + parseFloat(cs) * comet.L / comet.speed; let x = frozen; for (; x <= end; x += 1 / 60) cometStep(x, 1 / 60); tFix = x - 1 / 60; }
      else comet.on = false;
      draw(now(), 0); ready(); return;
    }
    if (reduced) { draw(0, 0); ready(); return; }
    ready();
  });
  setTimeout(ready, 9000);
  canvas.addEventListener('webglcontextlost', e => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  if (frozen !== null || reduced) return;
  running = true;
  let last = 0;
  function loop(ms) {
    requestAnimationFrame(loop);
    if (!visible || document.hidden) { last = 0; return; }
    const dt = last ? Math.min((ms - last) / 1000, 0.1) : 0; last = ms;
    t += dt;
    if (comet.on) cometStep(t, dt);
    draw(t, dt);
  }
  requestAnimationFrame(loop);
})();
