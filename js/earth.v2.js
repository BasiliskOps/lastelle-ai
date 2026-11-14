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
uniform vec2 uRes; uniform float uTanY, uAspect, uTex, uFluid, uRot, uExpo, uTour;
uniform vec3 uC, uF, uUp, uSun;
uniform sampler2D uDay, uClouds, uOcean, uDisp, uDayHi, uCloudsHi; uniform vec4 uCrop; uniform float uHi;` + DOMAIN + `
// the full planet at standard detail, and a high-detail window over the region the orbit covers
bool inCrop(vec2 ll, out vec2 cu){ cu = vec2(fract(ll.x - uCrop.x) / uCrop.z, (ll.y - uCrop.y) / uCrop.w);
  return uHi > 0.0 && cu.x > 0.002 && cu.x < 0.998 && cu.y > 0.002 && cu.y < 0.998; }
float cloudTex(vec2 ll, vec2 dx, vec2 dy){ vec2 cu; ll.x = fract(ll.x);
  if (inCrop(ll, cu)) { float h = textureGrad(uCloudsHi, cu, dx / uCrop.zw, dy / uCrop.zw).r;
    return uHi >= 1.0 ? h : mix(textureGrad(uClouds, ll, dx, dy).r, h, uHi); }
  return textureGrad(uClouds, ll, dx, dy).r; }
vec3 dayTex(vec2 ll, vec2 dx, vec2 dy){ vec2 cu;
  if (inCrop(ll, cu)) { vec3 h = textureGrad(uDayHi, cu, dx / uCrop.zw, dy / uCrop.zw).rgb;
    return uHi >= 1.0 ? h : mix(textureGrad(uDay, ll, dx, dy).rgb, h, uHi); }
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
  vec2 ll = dirToLL(n, uRot + uTour);
  float tc = cloudTex(ll, dx, dy);
  du = dirToDom(n);
  vec2 e = min(du, 1.0 - du);
  inF = uFluid * smoothstep(0.0, 0.04, min(e.x, e.y));
  if (inF <= 0.0) return tc;
  vec2 dl = dirToLL(domToDir(du - texture(uDisp, du).xy * inF), uRot + uTour);
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
    vec2 uv = dirToLL(n, uTour), dx = dFdx(uv), dy = dFdy(uv);
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
  float shimmer = 0.88 + 0.12 * n1(vAlong * 0.05 - uTime * 9.0);
  float core = exp(-s * s * 60.0) * pow(life, 1.6) * 3.2;
  float body = exp(-s * s * 10.0) * pow(life, 2.6) * 0.18;
  float glow = exp(-s * s * 2.5) * pow(life, 3.5) * 0.015;
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
    v = (1.0 - smoothstep(0.42, 0.7, star)) * 0.9 + exp(-dot(p, p) * 70.0) * 2.6;
    v += (exp(-a.y * 110.0) * (1.0 - a.x) + exp(-a.x * 110.0) * (1.0 - a.y)) * 1.2;
  } else v = exp(-dot(p, p) * 9.0);
  v = max(v, 0.0) * (1.0 - smoothstep(0.8, 1.0, length(gl_PointCoord * 2.0 - 1.0)));
  o = vec4(vec3(1.0) * v * vI, 1.0);
}`;
  const V_HEAD = H + `in vec2 aP;` + V_PX + `uniform vec2 uPos; uniform float uQ; out vec2 vP;
void main(){ vP = aP * uQ; gl_Position = px(uPos + vP); }`;
  const F_HEAD = H + `in vec2 vP; out vec4 o; uniform sampler2D uLogo; uniform float uS, uGlint, uTw, uFade, uFlare, uQ;
void main(){
  vec2 p = vP; float r = length(p);
  // the logo itself, in light
  vec2 su = vec2(0.5 + p.x / (uS * uTw), 0.5 - p.y / (uS * uTw));
  // sampled outside any branch so the GPU's mip choice stays sane at the square's edges (Apple GPUs drew a line there)
  float inside = step(0.0, su.x) * step(su.x, 1.0) * step(0.0, su.y) * step(su.y, 1.0);
  float logo = texture(uLogo, clamp(su, 0.0, 1.0)).a * inside;
  float v = logo * 1.4;
  // a white-hot centre and its corona
  v += exp(-r * r / (uS * uS * 0.0016)) * 9.0;
  v += exp(-r / (uS * 0.07)) * 0.45;
  v += exp(-r * r / (uS * uS * 0.25)) * 0.03;
  // cross flares along the star's own arms, long and thin, flaring on each glint
  vec2 a = abs(p);
  float L = uS * uFlare;
  float hx = exp(-a.y / 0.6) * exp(-pow(a.x / L, 1.3)), vy = exp(-a.x / 0.6) * exp(-pow(a.y / (L * 0.85), 1.3));
  float wide = exp(-a.y / 2.0) * exp(-a.x / (L * 0.45)) + exp(-a.x / 2.0) * exp(-a.y / (L * 0.4));

  v *= 1.0 - smoothstep(0.6, 0.95, max(abs(vP.x), abs(vP.y)) / uQ);
  o = vec4(vec3(1.0) * max(v, 0.0) * uFade, 1.0);
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
  // every program is compiled and linked before any result is read back, so the driver can build them in
  // parallel; with KHR_parallel_shader_compile the page waits for them without blocking the main thread
  let broken = false;
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  function program(vs, fs, attrs) {
    const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram(), sv = mk(gl.VERTEX_SHADER, vs), sf = mk(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, sv); gl.attachShader(p, sf);
    (attrs || ['aP']).forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    const check = () => {
      if (gl.getProgramParameter(p, gl.LINK_STATUS)) return;
      [sv, sf].forEach(s => { if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[earth]', gl.getShaderInfoLog(s)); });
      console.error('[earth]', gl.getProgramInfoLog(p)); broken = true;
    };
    const L = {};
    const u = n => (n in L) ? L[n] : (L[n] = gl.getUniformLocation(p, n));
    return {
      p, check, use() { gl.useProgram(p); return this; },
      f(n, ...v) { const l = u(n); if (l) gl['uniform' + v.length + 'f'](l, ...v); return this; },
      v(n, a) { const l = u(n); if (l) gl['uniform' + a.length + 'fv'](l, a); return this; },
      arr(n, a) { const l = u(n); if (l) gl.uniform4fv(l, a); return this; },
      t(n, unit, tex) { const l = u(n); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); if (l) gl.uniform1i(l, unit); return this; },
    };
  }
  const P = {
    earth: program(H + 'in vec2 aP; void main(){ gl_Position = vec4(aP, 0.0, 1.0); }', F_EARTH),
    advect: program(VSQ, F_ADVECT), div: program(VSQ, F_DIV), curl: program(VSQ, F_CURL), vort: program(VSQ, F_VORT),
    press: program(VSQ, F_PRESS), grad: program(VSQ, F_GRAD), scale: program(VSQ, F_SCALE), splat: program(VSQ, F_SPLAT),
    wind: program(VSQ, F_WIND), disp: program(VSQ, F_DISP),
    star: program(V_STAR, F_STAR, ['aS']), line: program(V_LINE, F_LINE, ['aS']),
    trail: program(V_TRAIL, F_TRAIL, ['aA', 'aB']), spark: program(V_SPARK, F_SPARK, ['aA', 'aB']), head: program(V_HEAD, F_HEAD, ['aP']),
    pre: program(VSQ, F_PRE), down: program(VSQ, F_DOWN), up: program(VSQ, F_UP), comp: program(VSQ, F_COMP),
  };
  const progs = Object.values(P);
  const compiled = () => !parallel || progs.every(q => gl.getProgramParameter(q.p, parallel.COMPLETION_STATUS_KHR));
  const settle = () => { if (!compiled()) { requestAnimationFrame(settle); return; } progs.forEach(q => q.check()); if (broken) fallback(); else start(); };
  settle();
  function start() {
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
  const LOGO = 'M1023.14 167.50C1023.22 169.48 1023.30 171.47 1023.38 173.45C1023.46 175.43 1023.53 177.42 1023.61 179.40C1023.69 181.38 1023.76 183.37 1023.84 185.35C1023.92 187.33 1024.01 189.32 1024.09 191.30C1024.17 193.28 1024.26 195.27 1024.35 197.25C1024.44 199.23 1024.53 201.22 1024.62 203.20C1024.71 205.18 1024.80 207.17 1024.89 209.15C1024.99 211.13 1025.08 213.11 1025.17 215.10C1025.27 217.08 1025.36 219.06 1025.46 221.05C1025.56 223.03 1025.65 225.01 1025.75 226.99C1025.85 228.98 1025.94 230.96 1026.04 232.94C1026.14 234.92 1026.24 236.91 1026.33 238.89C1026.43 240.87 1026.53 242.86 1026.63 244.84C1026.73 246.82 1026.82 248.80 1026.92 250.79C1027.02 252.77 1027.12 254.75 1027.22 256.73C1027.32 258.72 1027.42 260.70 1027.52 262.68C1027.62 264.66 1027.72 266.65 1027.82 268.63C1027.92 270.61 1028.02 272.59 1028.12 274.58C1028.22 276.56 1028.32 278.54 1028.42 280.52C1028.52 282.51 1028.63 284.49 1028.73 286.47C1028.83 288.45 1028.93 290.44 1029.04 292.42C1029.14 294.40 1029.24 296.38 1029.35 298.37C1029.45 300.35 1029.56 302.33 1029.66 304.31C1029.77 306.29 1029.87 308.28 1029.98 310.26C1030.09 312.24 1030.19 314.22 1030.30 316.21C1030.41 318.19 1030.52 320.17 1030.63 322.15C1030.74 324.13 1030.85 326.12 1030.96 328.10C1031.07 330.08 1031.18 332.06 1031.30 334.04C1031.41 336.02 1031.53 338.01 1031.64 339.99C1031.76 341.97 1031.88 343.95 1031.99 345.93C1032.11 347.91 1032.23 349.90 1032.36 351.88C1032.48 353.86 1032.60 355.84 1032.73 357.82C1032.86 359.80 1032.99 361.78 1033.12 363.76C1033.25 365.74 1033.38 367.72 1033.52 369.70C1033.66 371.69 1033.80 373.67 1033.94 375.65C1034.08 377.62 1034.23 379.60 1034.38 381.58C1034.53 383.56 1034.69 385.54 1034.85 387.52C1035.01 389.50 1035.17 391.48 1035.34 393.46C1035.51 395.43 1035.68 397.41 1035.86 399.39C1036.04 401.36 1036.23 403.34 1036.42 405.32C1036.60 407.29 1036.79 409.27 1036.99 411.24C1037.19 413.22 1037.39 415.19 1037.61 417.17C1037.82 419.14 1038.03 421.11 1038.26 423.09C1038.49 425.06 1038.72 427.03 1038.96 429.00C1039.20 430.97 1039.45 432.94 1039.72 434.91C1039.98 436.88 1040.25 438.84 1040.53 440.81C1040.82 442.77 1041.12 444.73 1041.43 446.69C1041.75 448.65 1042.07 450.61 1042.42 452.57C1042.77 454.52 1043.14 456.47 1043.53 458.42C1043.93 460.36 1044.34 462.30 1044.79 464.24C1045.24 466.17 1045.71 468.10 1046.22 470.02C1046.73 471.94 1047.27 473.85 1047.86 475.74C1048.44 477.64 1049.06 479.53 1049.73 481.40C1050.39 483.27 1051.10 485.12 1051.85 486.96C1052.61 488.79 1053.41 490.61 1054.25 492.41C1055.10 494.20 1056.00 495.98 1056.94 497.72C1057.89 499.46 1058.89 501.18 1059.93 502.87C1060.97 504.56 1062.06 506.22 1063.20 507.85C1064.34 509.47 1065.53 511.07 1066.76 512.62C1067.99 514.18 1069.26 515.70 1070.58 517.19C1071.89 518.67 1073.26 520.12 1074.65 521.53C1076.05 522.94 1077.48 524.32 1078.96 525.65C1080.43 526.98 1081.94 528.27 1083.48 529.51C1085.03 530.76 1086.61 531.96 1088.23 533.11C1089.84 534.27 1091.49 535.38 1093.17 536.44C1094.84 537.50 1096.55 538.51 1098.29 539.47C1100.02 540.43 1101.79 541.35 1103.58 542.21C1105.36 543.08 1107.17 543.89 1109.00 544.66C1110.83 545.43 1112.68 546.15 1114.55 546.84C1116.41 547.52 1118.29 548.15 1120.19 548.75C1122.08 549.35 1123.99 549.90 1125.90 550.42C1127.81 550.95 1129.74 551.43 1131.67 551.89C1133.60 552.35 1135.54 552.77 1137.49 553.17C1139.43 553.58 1141.38 553.95 1143.33 554.31C1145.28 554.67 1147.24 555.01 1149.20 555.34C1151.16 555.66 1153.12 555.97 1155.08 556.27C1157.04 556.57 1159.01 556.85 1160.97 557.13C1162.94 557.41 1164.90 557.68 1166.87 557.94C1168.84 558.21 1170.81 558.46 1172.78 558.71C1174.75 558.96 1176.72 559.20 1178.69 559.44C1180.66 559.68 1182.63 559.91 1184.60 560.14C1186.57 560.37 1188.55 560.59 1190.52 560.81C1192.49 561.03 1194.46 561.25 1196.44 561.46C1198.41 561.68 1200.39 561.88 1202.36 562.09C1204.34 562.29 1206.31 562.49 1208.29 562.68C1210.26 562.88 1212.24 563.07 1214.21 563.25C1216.19 563.44 1218.17 563.62 1220.14 563.80C1222.12 563.97 1224.10 564.15 1226.08 564.31C1228.05 564.48 1230.03 564.64 1232.01 564.80C1233.99 564.96 1235.97 565.12 1237.95 565.27C1239.93 565.42 1241.91 565.57 1243.89 565.71C1245.87 565.86 1247.85 566.00 1249.83 566.14C1251.81 566.27 1253.79 566.41 1255.77 566.54C1257.75 566.67 1259.73 566.80 1261.71 566.92C1263.69 567.05 1265.67 567.17 1267.66 567.29C1269.64 567.41 1271.62 567.53 1273.60 567.64C1275.58 567.76 1277.56 567.87 1279.55 567.99C1281.53 568.10 1283.51 568.21 1285.49 568.32C1287.47 568.43 1289.46 568.54 1291.44 568.65C1293.42 568.76 1295.40 568.86 1297.38 568.97C1299.37 569.08 1301.35 569.18 1303.33 569.29C1305.31 569.40 1307.29 569.50 1309.28 569.61C1311.26 569.72 1313.24 569.83 1315.22 569.94C1317.21 570.04 1319.19 570.16 1321.17 570.27C1323.15 570.38 1325.13 570.49 1327.11 570.61C1329.10 570.72 1331.08 570.84 1333.06 570.96C1335.04 571.07 1337.02 571.19 1339.00 571.31C1340.99 571.43 1342.97 571.55 1344.95 571.66C1346.93 571.78 1348.91 571.90 1350.89 572.01C1352.88 572.12 1354.86 572.23 1356.84 572.33C1358.82 572.44 1360.81 572.53 1362.79 572.63C1364.77 572.72 1366.75 572.81 1368.74 572.89C1370.72 572.97 1372.70 573.05 1374.69 573.12C1376.67 573.19 1378.66 573.24 1380.64 573.30C1382.62 573.36 1384.61 573.41 1386.59 573.46C1388.58 573.51 1390.56 573.56 1392.55 573.62C1394.53 573.67 1396.52 573.72 1398.50 573.77C1396.50 573.83 1394.51 573.88 1392.51 573.93C1390.52 573.99 1388.52 574.04 1386.53 574.09C1384.53 574.14 1382.54 574.19 1380.54 574.25C1378.55 574.31 1376.55 574.37 1374.56 574.44C1372.56 574.51 1370.57 574.58 1368.57 574.67C1366.58 574.75 1364.59 574.84 1362.59 574.93C1360.60 575.02 1358.61 575.12 1356.61 575.23C1354.62 575.33 1352.63 575.44 1350.63 575.56C1348.64 575.67 1346.65 575.79 1344.66 575.90C1342.66 576.02 1340.67 576.14 1338.68 576.26C1336.69 576.38 1334.69 576.50 1332.70 576.61C1330.71 576.73 1328.72 576.85 1326.72 576.96C1324.73 577.08 1322.74 577.19 1320.75 577.31C1318.75 577.42 1316.76 577.53 1314.77 577.64C1312.77 577.75 1310.78 577.86 1308.79 577.97C1306.80 578.07 1304.80 578.18 1302.81 578.29C1300.82 578.40 1298.82 578.50 1296.83 578.61C1294.84 578.72 1292.84 578.82 1290.85 578.93C1288.86 579.04 1286.87 579.15 1284.87 579.26C1282.88 579.37 1280.89 579.49 1278.89 579.60C1276.90 579.71 1274.91 579.83 1272.92 579.95C1270.92 580.06 1268.93 580.18 1266.94 580.30C1264.95 580.42 1262.96 580.55 1260.96 580.67C1258.97 580.80 1256.98 580.93 1254.99 581.06C1253.00 581.20 1251.01 581.33 1249.01 581.47C1247.02 581.61 1245.03 581.75 1243.04 581.90C1241.05 582.04 1239.06 582.19 1237.07 582.35C1235.08 582.50 1233.09 582.66 1231.10 582.82C1229.11 582.98 1227.12 583.15 1225.14 583.32C1223.15 583.49 1221.16 583.66 1219.17 583.84C1217.18 584.02 1215.19 584.20 1213.21 584.39C1211.22 584.58 1209.23 584.77 1207.25 584.97C1205.26 585.16 1203.28 585.37 1201.29 585.57C1199.31 585.78 1197.32 585.99 1195.34 586.20C1193.35 586.42 1191.37 586.64 1189.38 586.86C1187.40 587.08 1185.42 587.31 1183.44 587.54C1181.45 587.77 1179.47 588.01 1177.49 588.25C1175.51 588.49 1173.53 588.74 1171.55 588.99C1169.57 589.25 1167.59 589.51 1165.61 589.77C1163.63 590.04 1161.66 590.32 1159.68 590.60C1157.71 590.88 1155.73 591.18 1153.76 591.48C1151.79 591.79 1149.82 592.10 1147.85 592.44C1145.88 592.77 1143.92 593.12 1141.95 593.49C1139.99 593.86 1138.03 594.25 1136.08 594.67C1134.13 595.09 1132.18 595.53 1130.25 596.00C1128.31 596.48 1126.38 596.98 1124.46 597.53C1122.54 598.07 1120.62 598.65 1118.73 599.27C1116.83 599.89 1114.95 600.55 1113.08 601.26C1111.22 601.97 1109.36 602.72 1107.54 603.52C1105.71 604.31 1103.90 605.16 1102.11 606.06C1100.33 606.95 1098.57 607.90 1096.84 608.89C1095.11 609.89 1093.41 610.94 1091.74 612.03C1090.07 613.12 1088.43 614.26 1086.83 615.45C1085.23 616.64 1083.66 617.87 1082.12 619.15C1080.59 620.43 1079.09 621.75 1077.64 623.12C1076.18 624.48 1074.76 625.88 1073.38 627.32C1072.00 628.76 1070.65 630.24 1069.36 631.76C1068.06 633.28 1066.81 634.83 1065.60 636.42C1064.39 638.01 1063.23 639.63 1062.11 641.29C1061.00 642.94 1059.93 644.63 1058.92 646.35C1057.90 648.07 1056.93 649.81 1056.01 651.59C1055.10 653.36 1054.23 655.16 1053.41 656.98C1052.59 658.79 1051.82 660.64 1051.09 662.50C1050.36 664.35 1049.68 666.23 1049.04 668.12C1048.40 670.01 1047.81 671.92 1047.25 673.84C1046.69 675.75 1046.17 677.68 1045.68 679.61C1045.19 681.55 1044.74 683.49 1044.32 685.44C1043.89 687.39 1043.50 689.35 1043.13 691.31C1042.76 693.27 1042.42 695.24 1042.10 697.21C1041.78 699.18 1041.49 701.16 1041.22 703.13C1040.95 705.11 1040.70 707.09 1040.48 709.07C1040.25 711.06 1040.04 713.04 1039.86 715.03C1039.67 717.02 1039.51 719.01 1039.35 721.00C1039.20 722.99 1039.07 724.98 1038.94 726.97C1038.82 728.96 1038.71 730.96 1038.61 732.95C1038.51 734.94 1038.42 736.94 1038.34 738.93C1038.25 740.92 1038.18 742.92 1038.11 744.91C1038.03 746.91 1037.96 748.90 1037.90 750.90C1037.83 752.89 1037.78 754.89 1037.72 756.88C1037.66 758.88 1037.60 760.87 1037.55 762.87C1037.50 764.86 1037.44 766.86 1037.39 768.85C1037.34 770.85 1037.28 772.84 1037.23 774.84C1037.18 776.83 1037.13 778.83 1037.08 780.82C1037.02 782.82 1036.97 784.82 1036.92 786.81C1036.87 788.81 1036.81 790.80 1036.76 792.80C1036.71 794.79 1036.66 796.79 1036.61 798.78C1036.56 800.78 1036.50 802.77 1036.45 804.77C1036.40 806.76 1036.35 808.76 1036.30 810.75C1036.25 812.75 1036.21 814.74 1036.16 816.74C1036.11 818.74 1036.06 820.73 1036.02 822.73C1035.97 824.72 1035.92 826.72 1035.88 828.71C1035.83 830.71 1035.79 832.70 1035.74 834.70C1035.70 836.69 1035.66 838.69 1035.61 840.68C1035.57 842.68 1035.53 844.68 1035.49 846.67C1035.45 848.67 1035.40 850.66 1035.36 852.66C1035.32 854.65 1035.28 856.65 1035.24 858.64C1035.21 860.64 1035.17 862.64 1035.13 864.63C1035.09 866.63 1035.05 868.62 1035.01 870.62C1034.98 872.61 1034.94 874.61 1034.90 876.60C1034.87 878.60 1034.83 880.60 1034.79 882.59C1034.76 884.59 1034.72 886.58 1034.69 888.58C1034.65 890.57 1034.62 892.57 1034.58 894.56C1034.55 896.56 1034.52 898.56 1034.48 900.55C1034.45 902.55 1034.42 904.54 1034.38 906.54C1034.35 908.53 1034.32 910.53 1034.28 912.53C1034.25 914.52 1034.22 916.52 1034.19 918.51C1034.16 920.51 1034.13 922.50 1034.09 924.50C1034.06 926.50 1034.03 928.49 1034.00 930.49C1033.97 932.48 1033.94 934.48 1033.91 936.47C1033.88 938.47 1033.85 940.46 1033.82 942.46C1033.79 944.46 1033.76 946.45 1033.73 948.45C1033.70 950.44 1033.67 952.44 1033.65 954.43C1033.62 956.43 1033.59 958.43 1033.56 960.42C1033.53 962.42 1033.50 964.41 1033.48 966.41C1033.45 968.40 1033.42 970.40 1033.39 972.40C1033.36 974.39 1033.34 976.39 1033.31 978.38C1033.28 980.38 1033.26 982.37 1033.23 984.37C1033.20 986.37 1033.18 988.36 1033.15 990.36C1033.12 992.35 1033.10 994.35 1033.07 996.35C1033.04 998.34 1033.02 1000.34 1032.99 1002.33C1032.97 1004.33 1032.94 1006.32 1032.92 1008.32C1032.89 1010.32 1032.87 1012.31 1032.84 1014.31C1032.82 1016.30 1032.79 1018.30 1032.77 1020.29C1032.74 1022.29 1032.72 1024.29 1032.69 1026.28C1032.67 1028.28 1032.64 1030.27 1032.62 1032.27C1032.59 1034.26 1032.57 1036.26 1032.54 1038.26C1032.52 1040.25 1032.50 1042.25 1032.47 1044.24C1032.45 1046.24 1032.42 1048.24 1032.40 1050.23C1032.38 1052.23 1032.35 1054.22 1032.33 1056.22C1032.30 1058.21 1032.28 1060.21 1032.25 1062.21C1032.23 1064.20 1032.21 1066.20 1032.18 1068.19C1032.16 1070.19 1032.13 1072.18 1032.11 1074.18C1032.09 1076.18 1032.06 1078.17 1032.04 1080.17C1032.01 1082.16 1031.99 1084.16 1031.97 1086.15C1031.94 1088.15 1031.92 1090.15 1031.89 1092.14C1031.87 1094.14 1031.85 1096.13 1031.82 1098.13C1031.80 1100.13 1031.77 1102.12 1031.75 1104.12C1031.73 1106.11 1031.70 1108.11 1031.68 1110.10C1031.66 1112.10 1031.63 1114.10 1031.61 1116.09C1031.58 1118.09 1031.56 1120.08 1031.54 1122.08C1031.51 1124.07 1031.49 1126.07 1031.46 1128.07C1031.44 1130.06 1031.42 1132.06 1031.39 1134.05C1031.37 1136.05 1031.35 1138.04 1031.32 1140.04C1031.30 1142.04 1031.27 1144.03 1031.25 1146.03C1031.23 1148.02 1031.20 1150.02 1031.18 1152.02C1031.16 1154.01 1031.13 1156.01 1031.11 1158.00C1031.08 1160.00 1031.06 1161.99 1031.04 1163.99C1031.01 1165.99 1030.99 1167.98 1030.96 1169.98C1030.94 1171.97 1030.92 1173.97 1030.89 1175.96C1030.87 1177.96 1030.84 1179.96 1030.82 1181.95C1030.79 1183.95 1030.77 1185.94 1030.75 1187.94C1030.72 1189.94 1030.70 1191.93 1030.67 1193.93C1030.65 1195.92 1030.62 1197.92 1030.60 1199.91C1030.58 1201.91 1030.55 1203.91 1030.53 1205.90C1030.50 1207.90 1030.48 1209.89 1030.46 1211.89C1030.43 1213.88 1030.41 1215.88 1030.38 1217.88C1030.36 1219.87 1030.33 1221.87 1030.31 1223.86C1030.29 1225.86 1030.26 1227.85 1030.24 1229.85C1030.22 1231.85 1030.19 1233.84 1030.17 1235.84C1030.14 1237.83 1030.12 1239.83 1030.10 1241.83C1030.07 1243.82 1030.05 1245.82 1030.03 1247.81C1030.00 1249.81 1029.98 1251.80 1029.96 1253.80C1029.93 1255.80 1029.91 1257.79 1029.89 1259.79C1029.86 1261.78 1029.84 1263.78 1029.82 1265.77C1029.80 1267.77 1029.77 1269.77 1029.75 1271.76C1029.73 1273.76 1029.70 1275.75 1029.68 1277.75C1029.66 1279.75 1029.64 1281.74 1029.61 1283.74C1029.59 1285.73 1029.57 1287.73 1029.55 1289.72C1029.52 1291.72 1029.50 1293.72 1029.48 1295.71C1029.46 1297.71 1029.44 1299.70 1029.41 1301.70C1029.39 1303.69 1029.37 1305.69 1029.35 1307.69C1029.32 1309.68 1029.30 1311.68 1029.28 1313.67C1029.26 1315.67 1029.24 1317.67 1029.21 1319.66C1029.19 1321.66 1029.17 1323.65 1029.15 1325.65C1029.13 1327.64 1029.11 1329.64 1029.08 1331.64C1029.06 1333.63 1029.04 1335.63 1029.02 1337.62C1028.99 1339.62 1028.97 1341.61 1028.95 1343.61C1028.93 1345.61 1028.91 1347.60 1028.88 1349.60C1028.86 1351.59 1028.84 1353.59 1028.82 1355.59C1028.79 1357.58 1028.77 1359.58 1028.75 1361.57C1028.73 1363.57 1028.70 1365.56 1028.68 1367.56C1028.66 1369.56 1028.64 1371.55 1028.61 1373.55C1028.59 1375.54 1028.57 1377.54 1028.55 1379.53C1028.52 1381.53 1028.50 1383.53 1028.48 1385.52C1028.46 1387.52 1028.43 1389.51 1028.41 1391.51C1028.39 1393.51 1028.37 1395.50 1028.34 1397.50C1028.32 1399.49 1028.30 1401.49 1028.28 1403.48C1028.25 1405.48 1028.23 1407.48 1028.21 1409.47C1028.19 1411.47 1028.16 1413.46 1028.14 1415.46C1028.12 1417.45 1028.10 1419.45 1028.07 1421.45C1028.05 1423.44 1028.03 1425.44 1028.01 1427.43C1027.98 1429.43 1027.96 1431.43 1027.94 1433.42C1027.92 1435.42 1027.89 1437.41 1027.87 1439.41C1027.85 1441.40 1027.82 1443.40 1027.80 1445.40C1027.78 1447.39 1027.76 1449.39 1027.73 1451.38C1027.71 1453.38 1027.69 1455.37 1027.66 1457.37C1027.64 1459.37 1027.62 1461.36 1027.59 1463.36C1027.57 1465.35 1027.55 1467.35 1027.52 1469.35C1027.50 1471.34 1027.48 1473.34 1027.45 1475.33C1027.43 1477.33 1027.40 1479.32 1027.38 1481.32C1027.35 1483.32 1027.33 1485.31 1027.30 1487.31C1027.28 1489.30 1027.25 1491.30 1027.23 1493.29C1027.20 1495.29 1027.17 1497.29 1027.15 1499.28C1027.12 1501.28 1027.10 1503.27 1027.07 1505.27C1027.04 1507.26 1027.01 1509.26 1026.99 1511.26C1026.96 1513.25 1026.93 1515.25 1026.91 1517.24C1026.88 1519.24 1026.85 1521.24 1026.82 1523.23C1026.80 1525.23 1026.77 1527.22 1026.74 1529.22C1026.71 1531.21 1026.69 1533.21 1026.66 1535.21C1026.63 1537.20 1026.60 1539.20 1026.57 1541.19C1026.55 1543.19 1026.52 1545.18 1026.49 1547.18C1026.46 1549.18 1026.43 1551.17 1026.40 1553.17C1026.38 1555.16 1026.35 1557.16 1026.32 1559.15C1026.29 1561.15 1026.26 1563.15 1026.23 1565.14C1026.20 1567.14 1026.18 1569.13 1026.15 1571.13C1026.12 1573.12 1026.09 1575.12 1026.06 1577.12C1026.03 1579.11 1026.00 1581.11 1025.97 1583.10C1025.94 1585.10 1025.92 1587.09 1025.89 1589.09C1025.86 1591.09 1025.83 1593.08 1025.80 1595.08C1025.77 1597.07 1025.74 1599.07 1025.71 1601.06C1025.69 1603.06 1025.66 1605.06 1025.63 1607.05C1025.60 1609.05 1025.57 1611.04 1025.54 1613.04C1025.51 1615.03 1025.49 1617.03 1025.46 1619.03C1025.43 1621.02 1025.40 1623.02 1025.38 1625.01C1025.35 1627.01 1025.32 1629.00 1025.29 1631.00C1025.27 1633.00 1025.24 1634.99 1025.21 1636.99C1025.19 1638.98 1025.16 1640.98 1025.14 1642.97C1025.11 1644.97 1025.09 1646.97 1025.06 1648.96C1025.04 1650.96 1025.01 1652.95 1024.99 1654.95C1024.96 1656.94 1024.94 1658.94 1024.91 1660.94C1024.89 1662.93 1024.87 1664.93 1024.84 1666.92C1024.82 1668.92 1024.80 1670.91 1024.78 1672.91C1024.75 1674.91 1024.73 1676.90 1024.71 1678.90C1024.69 1680.89 1024.67 1682.89 1024.65 1684.89C1024.63 1686.88 1024.61 1688.88 1024.59 1690.87C1024.57 1692.87 1024.55 1694.86 1024.53 1696.86C1024.51 1698.86 1024.49 1700.85 1024.47 1702.85C1024.45 1704.84 1024.44 1706.84 1024.42 1708.84C1024.40 1710.83 1024.38 1712.83 1024.37 1714.82C1024.35 1716.82 1024.34 1718.81 1024.32 1720.81C1024.30 1722.81 1024.29 1724.80 1024.27 1726.80C1024.26 1728.79 1024.24 1730.79 1024.23 1732.79C1024.22 1734.78 1024.20 1736.78 1024.19 1738.77C1024.18 1740.77 1024.16 1742.77 1024.15 1744.76C1024.14 1746.76 1024.13 1748.75 1024.12 1750.75C1024.11 1752.74 1024.10 1754.74 1024.09 1756.74C1024.08 1758.73 1024.07 1760.73 1024.06 1762.72C1024.04 1764.72 1024.03 1766.72 1024.02 1768.71C1024.01 1770.71 1024.00 1772.70 1023.99 1774.70C1023.97 1776.70 1023.96 1778.69 1023.94 1780.69C1023.92 1782.68 1023.90 1784.68 1023.87 1786.67C1023.85 1788.67 1023.82 1790.67 1023.80 1792.66C1023.77 1794.66 1023.74 1796.65 1023.71 1798.65C1023.67 1800.64 1023.64 1802.64 1023.61 1804.64C1023.58 1806.63 1023.55 1808.63 1023.52 1810.62C1023.48 1812.62 1023.45 1814.61 1023.42 1816.61C1023.39 1818.61 1023.36 1820.60 1023.33 1822.60C1023.29 1824.59 1023.26 1826.59 1023.23 1828.58C1023.20 1830.58 1023.17 1832.57 1023.14 1834.57C1023.10 1832.57 1023.07 1830.58 1023.04 1828.58C1023.01 1826.58 1022.98 1824.58 1022.94 1822.59C1022.91 1820.59 1022.88 1818.59 1022.85 1816.59C1022.82 1814.60 1022.79 1812.60 1022.75 1810.60C1022.72 1808.61 1022.69 1806.61 1022.66 1804.61C1022.63 1802.61 1022.60 1800.62 1022.56 1798.62C1022.53 1796.62 1022.50 1794.62 1022.47 1792.63C1022.45 1790.63 1022.42 1788.63 1022.39 1786.63C1022.37 1784.64 1022.35 1782.64 1022.33 1780.64C1022.31 1778.64 1022.30 1776.65 1022.28 1774.65C1022.27 1772.65 1022.26 1770.65 1022.25 1768.66C1022.24 1766.66 1022.23 1764.66 1022.21 1762.66C1022.20 1760.67 1022.19 1758.67 1022.18 1756.67C1022.17 1754.67 1022.16 1752.68 1022.15 1750.68C1022.14 1748.68 1022.13 1746.68 1022.12 1744.69C1022.11 1742.69 1022.09 1740.69 1022.08 1738.69C1022.07 1736.70 1022.05 1734.70 1022.04 1732.70C1022.03 1730.70 1022.01 1728.71 1022.00 1726.71C1021.98 1724.71 1021.97 1722.71 1021.95 1720.72C1021.93 1718.72 1021.92 1716.72 1021.90 1714.72C1021.88 1712.73 1021.87 1710.73 1021.85 1708.73C1021.83 1706.73 1021.82 1704.74 1021.80 1702.74C1021.78 1700.74 1021.76 1698.74 1021.74 1696.75C1021.72 1694.75 1021.70 1692.75 1021.68 1690.75C1021.66 1688.76 1021.64 1686.76 1021.62 1684.76C1021.60 1682.76 1021.58 1680.77 1021.56 1678.77C1021.54 1676.77 1021.51 1674.77 1021.49 1672.78C1021.47 1670.78 1021.45 1668.78 1021.42 1666.79C1021.40 1664.79 1021.38 1662.79 1021.35 1660.79C1021.33 1658.80 1021.31 1656.80 1021.28 1654.80C1021.26 1652.80 1021.23 1650.81 1021.21 1648.81C1021.18 1646.81 1021.16 1644.81 1021.13 1642.82C1021.11 1640.82 1021.08 1638.82 1021.05 1636.82C1021.03 1634.83 1021.00 1632.83 1020.97 1630.83C1020.95 1628.83 1020.92 1626.84 1020.89 1624.84C1020.86 1622.84 1020.84 1620.84 1020.81 1618.85C1020.78 1616.85 1020.75 1614.85 1020.72 1612.86C1020.70 1610.86 1020.67 1608.86 1020.64 1606.86C1020.61 1604.87 1020.58 1602.87 1020.55 1600.87C1020.52 1598.87 1020.50 1596.88 1020.47 1594.88C1020.44 1592.88 1020.41 1590.88 1020.38 1588.89C1020.35 1586.89 1020.32 1584.89 1020.29 1582.90C1020.26 1580.90 1020.24 1578.90 1020.21 1576.90C1020.18 1574.91 1020.15 1572.91 1020.12 1570.91C1020.09 1568.91 1020.06 1566.92 1020.03 1564.92C1020.01 1562.92 1019.98 1560.92 1019.95 1558.93C1019.92 1556.93 1019.89 1554.93 1019.86 1552.93C1019.83 1550.94 1019.81 1548.94 1019.78 1546.94C1019.75 1544.95 1019.72 1542.95 1019.69 1540.95C1019.67 1538.95 1019.64 1536.96 1019.61 1534.96C1019.58 1532.96 1019.55 1530.96 1019.53 1528.97C1019.50 1526.97 1019.47 1524.97 1019.44 1522.97C1019.41 1520.98 1019.39 1518.98 1019.36 1516.98C1019.33 1514.98 1019.31 1512.99 1019.28 1510.99C1019.25 1508.99 1019.22 1507.00 1019.20 1505.00C1019.17 1503.00 1019.15 1501.00 1019.12 1499.01C1019.09 1497.01 1019.07 1495.01 1019.04 1493.01C1019.02 1491.02 1018.99 1489.02 1018.96 1487.02C1018.94 1485.02 1018.91 1483.03 1018.89 1481.03C1018.86 1479.03 1018.84 1477.03 1018.82 1475.04C1018.79 1473.04 1018.77 1471.04 1018.74 1469.04C1018.72 1467.05 1018.70 1465.05 1018.67 1463.05C1018.65 1461.05 1018.63 1459.06 1018.60 1457.06C1018.58 1455.06 1018.56 1453.07 1018.53 1451.07C1018.51 1449.07 1018.49 1447.07 1018.46 1445.08C1018.44 1443.08 1018.42 1441.08 1018.40 1439.08C1018.37 1437.09 1018.35 1435.09 1018.33 1433.09C1018.31 1431.09 1018.28 1429.10 1018.26 1427.10C1018.24 1425.10 1018.22 1423.10 1018.19 1421.11C1018.17 1419.11 1018.15 1417.11 1018.13 1415.11C1018.10 1413.12 1018.08 1411.12 1018.06 1409.12C1018.04 1407.12 1018.01 1405.13 1017.99 1403.13C1017.97 1401.13 1017.95 1399.13 1017.92 1397.14C1017.90 1395.14 1017.88 1393.14 1017.86 1391.14C1017.83 1389.15 1017.81 1387.15 1017.79 1385.15C1017.76 1383.15 1017.74 1381.16 1017.72 1379.16C1017.70 1377.16 1017.67 1375.17 1017.65 1373.17C1017.63 1371.17 1017.61 1369.17 1017.58 1367.18C1017.56 1365.18 1017.54 1363.18 1017.52 1361.18C1017.49 1359.19 1017.47 1357.19 1017.45 1355.19C1017.43 1353.19 1017.40 1351.20 1017.38 1349.20C1017.36 1347.20 1017.34 1345.20 1017.32 1343.21C1017.29 1341.21 1017.27 1339.21 1017.25 1337.21C1017.23 1335.22 1017.20 1333.22 1017.18 1331.22C1017.16 1329.22 1017.14 1327.23 1017.12 1325.23C1017.09 1323.23 1017.07 1321.23 1017.05 1319.24C1017.03 1317.24 1017.01 1315.24 1016.98 1313.24C1016.96 1311.25 1016.94 1309.25 1016.92 1307.25C1016.90 1305.25 1016.87 1303.26 1016.85 1301.26C1016.83 1299.26 1016.81 1297.26 1016.79 1295.27C1016.76 1293.27 1016.74 1291.27 1016.72 1289.28C1016.70 1287.28 1016.67 1285.28 1016.65 1283.28C1016.63 1281.29 1016.61 1279.29 1016.58 1277.29C1016.56 1275.29 1016.54 1273.30 1016.52 1271.30C1016.49 1269.30 1016.47 1267.30 1016.45 1265.31C1016.42 1263.31 1016.40 1261.31 1016.38 1259.31C1016.35 1257.32 1016.33 1255.32 1016.31 1253.32C1016.28 1251.32 1016.26 1249.33 1016.24 1247.33C1016.21 1245.33 1016.19 1243.33 1016.17 1241.34C1016.14 1239.34 1016.12 1237.34 1016.10 1235.34C1016.07 1233.35 1016.05 1231.35 1016.03 1229.35C1016.00 1227.35 1015.98 1225.36 1015.95 1223.36C1015.93 1221.36 1015.91 1219.37 1015.88 1217.37C1015.86 1215.37 1015.83 1213.37 1015.81 1211.38C1015.78 1209.38 1015.76 1207.38 1015.74 1205.38C1015.71 1203.39 1015.69 1201.39 1015.66 1199.39C1015.64 1197.39 1015.61 1195.40 1015.59 1193.40C1015.57 1191.40 1015.54 1189.40 1015.52 1187.41C1015.49 1185.41 1015.47 1183.41 1015.44 1181.41C1015.42 1179.42 1015.40 1177.42 1015.37 1175.42C1015.35 1173.42 1015.32 1171.43 1015.30 1169.43C1015.28 1167.43 1015.25 1165.43 1015.23 1163.44C1015.20 1161.44 1015.18 1159.44 1015.16 1157.45C1015.13 1155.45 1015.11 1153.45 1015.08 1151.45C1015.06 1149.46 1015.04 1147.46 1015.01 1145.46C1014.99 1143.46 1014.97 1141.47 1014.94 1139.47C1014.92 1137.47 1014.89 1135.47 1014.87 1133.48C1014.85 1131.48 1014.82 1129.48 1014.80 1127.48C1014.77 1125.49 1014.75 1123.49 1014.73 1121.49C1014.70 1119.49 1014.68 1117.50 1014.66 1115.50C1014.63 1113.50 1014.61 1111.50 1014.58 1109.51C1014.56 1107.51 1014.54 1105.51 1014.51 1103.51C1014.49 1101.52 1014.46 1099.52 1014.44 1097.52C1014.42 1095.53 1014.39 1093.53 1014.37 1091.53C1014.34 1089.53 1014.32 1087.54 1014.30 1085.54C1014.27 1083.54 1014.25 1081.54 1014.22 1079.55C1014.20 1077.55 1014.18 1075.55 1014.15 1073.55C1014.13 1071.56 1014.10 1069.56 1014.08 1067.56C1014.06 1065.56 1014.03 1063.57 1014.01 1061.57C1013.98 1059.57 1013.96 1057.57 1013.94 1055.58C1013.91 1053.58 1013.89 1051.58 1013.86 1049.58C1013.84 1047.59 1013.81 1045.59 1013.79 1043.59C1013.77 1041.59 1013.74 1039.60 1013.72 1037.60C1013.69 1035.60 1013.67 1033.61 1013.64 1031.61C1013.62 1029.61 1013.60 1027.61 1013.57 1025.62C1013.55 1023.62 1013.52 1021.62 1013.50 1019.62C1013.47 1017.63 1013.45 1015.63 1013.42 1013.63C1013.40 1011.63 1013.37 1009.64 1013.35 1007.64C1013.32 1005.64 1013.29 1003.64 1013.27 1001.65C1013.24 999.65 1013.22 997.65 1013.19 995.65C1013.16 993.66 1013.14 991.66 1013.11 989.66C1013.09 987.66 1013.06 985.67 1013.03 983.67C1013.00 981.67 1012.98 979.68 1012.95 977.68C1012.92 975.68 1012.90 973.68 1012.87 971.69C1012.84 969.69 1012.81 967.69 1012.79 965.69C1012.76 963.70 1012.73 961.70 1012.70 959.70C1012.67 957.70 1012.64 955.71 1012.61 953.71C1012.59 951.71 1012.56 949.71 1012.53 947.72C1012.50 945.72 1012.47 943.72 1012.44 941.73C1012.41 939.73 1012.38 937.73 1012.35 935.73C1012.32 933.74 1012.29 931.74 1012.26 929.74C1012.23 927.74 1012.20 925.75 1012.16 923.75C1012.13 921.75 1012.10 919.75 1012.07 917.76C1012.04 915.76 1012.01 913.76 1011.97 911.77C1011.94 909.77 1011.91 907.77 1011.87 905.77C1011.84 903.78 1011.81 901.78 1011.77 899.78C1011.74 897.78 1011.71 895.79 1011.67 893.79C1011.64 891.79 1011.60 889.80 1011.57 887.80C1011.53 885.80 1011.50 883.80 1011.46 881.81C1011.43 879.81 1011.39 877.81 1011.35 875.81C1011.32 873.82 1011.28 871.82 1011.24 869.82C1011.20 867.83 1011.17 865.83 1011.13 863.83C1011.09 861.83 1011.05 859.84 1011.01 857.84C1010.97 855.84 1010.93 853.85 1010.89 851.85C1010.85 849.85 1010.81 847.85 1010.77 845.86C1010.72 843.86 1010.68 841.86 1010.64 839.87C1010.60 837.87 1010.55 835.87 1010.51 833.87C1010.46 831.88 1010.42 829.88 1010.37 827.88C1010.33 825.89 1010.28 823.89 1010.24 821.89C1010.19 819.90 1010.14 817.90 1010.09 815.90C1010.04 813.90 1009.99 811.91 1009.95 809.91C1009.90 807.91 1009.85 805.92 1009.79 803.92C1009.74 801.92 1009.69 799.93 1009.64 797.93C1009.59 795.93 1009.54 793.94 1009.49 791.94C1009.43 789.94 1009.38 787.94 1009.33 785.95C1009.28 783.95 1009.22 781.95 1009.17 779.96C1009.12 777.96 1009.07 775.96 1009.01 773.97C1008.96 771.97 1008.91 769.97 1008.86 767.98C1008.80 765.98 1008.75 763.98 1008.70 761.99C1008.64 759.99 1008.59 757.99 1008.53 755.99C1008.47 754.00 1008.41 752.00 1008.34 750.00C1008.28 748.01 1008.21 746.01 1008.13 744.02C1008.06 742.02 1007.98 740.02 1007.89 738.03C1007.81 736.03 1007.72 734.04 1007.61 732.04C1007.51 730.05 1007.40 728.05 1007.27 726.06C1007.14 724.07 1007.00 722.07 1006.85 720.08C1006.69 718.09 1006.52 716.10 1006.32 714.11C1006.13 712.12 1005.92 710.14 1005.69 708.15C1005.45 706.17 1005.20 704.19 1004.92 702.21C1004.65 700.23 1004.35 698.26 1004.02 696.29C1003.69 694.31 1003.34 692.35 1002.97 690.39C1002.59 688.42 1002.19 686.47 1001.75 684.52C1001.31 682.57 1000.85 680.62 1000.35 678.69C999.85 676.76 999.32 674.83 998.75 672.92C998.18 671.00 997.57 669.10 996.92 667.21C996.26 665.33 995.57 663.45 994.83 661.60C994.08 659.74 993.30 657.90 992.46 656.09C991.62 654.28 990.74 652.48 989.80 650.72C988.87 648.96 987.88 647.22 986.85 645.51C985.82 643.80 984.73 642.12 983.60 640.47C982.47 638.83 981.29 637.21 980.07 635.63C978.84 634.06 977.57 632.51 976.26 631.01C974.95 629.50 973.59 628.03 972.20 626.60C970.80 625.18 969.37 623.78 967.89 622.43C966.42 621.08 964.91 619.77 963.37 618.51C961.82 617.24 960.24 616.02 958.62 614.85C957.00 613.68 955.35 612.55 953.67 611.47C951.99 610.40 950.28 609.37 948.54 608.39C946.80 607.41 945.02 606.48 943.23 605.60C941.44 604.72 939.62 603.89 937.78 603.10C935.95 602.32 934.09 601.59 932.21 600.89C930.34 600.20 928.45 599.56 926.55 598.95C924.64 598.34 922.73 597.78 920.80 597.24C918.88 596.71 916.94 596.22 915.00 595.76C913.06 595.29 911.10 594.86 909.15 594.45C907.19 594.04 905.23 593.66 903.27 593.30C901.30 592.93 899.34 592.59 897.37 592.26C895.40 591.93 893.42 591.62 891.45 591.31C889.47 591.01 887.50 590.72 885.52 590.43C883.54 590.15 881.57 589.87 879.59 589.60C877.61 589.33 875.63 589.07 873.65 588.82C871.66 588.56 869.68 588.31 867.70 588.06C865.72 587.82 863.73 587.58 861.75 587.34C859.77 587.10 857.78 586.87 855.80 586.65C853.81 586.42 851.83 586.20 849.84 585.98C847.86 585.76 845.87 585.55 843.89 585.34C841.90 585.13 839.91 584.92 837.92 584.73C835.94 584.53 833.95 584.33 831.96 584.15C829.97 583.96 827.98 583.77 825.99 583.60C824.00 583.42 822.01 583.24 820.02 583.08C818.03 582.91 816.04 582.74 814.05 582.58C812.06 582.42 810.07 582.27 808.07 582.12C806.08 581.97 804.09 581.82 802.10 581.68C800.11 581.53 798.11 581.39 796.12 581.26C794.13 581.12 792.13 580.99 790.14 580.86C788.15 580.72 786.15 580.60 784.16 580.47C782.17 580.35 780.17 580.22 778.18 580.10C776.19 579.98 774.19 579.86 772.20 579.75C770.20 579.63 768.21 579.52 766.21 579.40C764.22 579.29 762.23 579.18 760.23 579.07C758.24 578.96 756.24 578.85 754.25 578.74C752.25 578.63 750.26 578.52 748.26 578.42C746.27 578.31 744.27 578.21 742.28 578.10C740.28 578.00 738.29 577.89 736.29 577.79C734.30 577.68 732.30 577.58 730.31 577.48C728.32 577.37 726.32 577.27 724.33 577.16C722.33 577.06 720.34 576.95 718.34 576.84C716.35 576.74 714.35 576.63 712.36 576.52C710.36 576.40 708.37 576.29 706.37 576.18C704.38 576.07 702.39 575.95 700.39 575.84C698.40 575.72 696.40 575.61 694.41 575.50C692.41 575.39 690.42 575.28 688.42 575.18C686.43 575.08 684.43 574.98 682.44 574.89C680.44 574.80 678.45 574.72 676.45 574.65C674.45 574.57 672.46 574.50 670.46 574.43C668.47 574.37 666.47 574.32 664.47 574.26C662.47 574.20 660.48 574.15 658.48 574.10C656.48 574.04 654.49 573.99 652.49 573.94C650.49 573.88 648.50 573.83 646.50 573.77C648.49 573.72 650.48 573.67 652.46 573.61C654.45 573.56 656.44 573.51 658.43 573.45C660.42 573.40 662.40 573.35 664.39 573.29C666.38 573.24 668.37 573.18 670.36 573.12C672.34 573.05 674.33 572.98 676.32 572.91C678.30 572.83 680.29 572.75 682.28 572.66C684.27 572.57 686.25 572.48 688.24 572.38C690.22 572.28 692.21 572.17 694.20 572.06C696.18 571.95 698.17 571.84 700.15 571.73C702.14 571.61 704.12 571.50 706.11 571.39C708.09 571.27 710.08 571.16 712.07 571.05C714.05 570.94 716.04 570.83 718.02 570.72C720.01 570.62 721.99 570.51 723.98 570.40C725.97 570.30 727.95 570.20 729.94 570.09C731.92 569.99 733.91 569.89 735.90 569.78C737.88 569.68 739.87 569.58 741.85 569.47C743.84 569.37 745.83 569.26 747.81 569.16C749.80 569.05 751.78 568.95 753.77 568.84C755.76 568.73 757.74 568.62 759.73 568.51C761.71 568.40 763.70 568.29 765.68 568.18C767.67 568.06 769.65 567.95 771.64 567.84C773.62 567.72 775.61 567.60 777.60 567.48C779.58 567.36 781.57 567.24 783.55 567.12C785.53 566.99 787.52 566.87 789.50 566.74C791.49 566.61 793.47 566.47 795.46 566.34C797.44 566.20 799.42 566.06 801.41 565.92C803.39 565.78 805.38 565.63 807.36 565.49C809.34 565.34 811.32 565.18 813.31 565.02C815.29 564.87 817.27 564.70 819.25 564.54C821.23 564.37 823.22 564.20 825.20 564.02C827.18 563.85 829.16 563.67 831.14 563.48C833.12 563.30 835.10 563.10 837.08 562.91C839.06 562.71 841.03 562.51 843.01 562.30C844.99 562.10 846.97 561.89 848.94 561.67C850.92 561.45 852.90 561.23 854.87 561.01C856.85 560.78 858.83 560.56 860.80 560.32C862.78 560.09 864.75 559.85 866.72 559.61C868.70 559.36 870.67 559.12 872.64 558.86C874.62 558.61 876.59 558.35 878.56 558.08C880.53 557.82 882.50 557.55 884.47 557.27C886.44 556.99 888.40 556.70 890.37 556.40C892.34 556.10 894.30 555.80 896.26 555.47C898.23 555.15 900.19 554.82 902.14 554.46C904.10 554.10 906.05 553.73 908.00 553.33C909.95 552.94 911.90 552.52 913.83 552.07C915.77 551.62 917.70 551.14 919.62 550.63C921.54 550.11 923.46 549.56 925.35 548.98C927.25 548.39 929.14 547.76 931.01 547.09C932.89 546.42 934.75 545.71 936.58 544.95C938.42 544.19 940.24 543.38 942.03 542.53C943.83 541.67 945.60 540.77 947.35 539.82C949.09 538.87 950.81 537.86 952.50 536.81C954.19 535.76 955.85 534.66 957.47 533.52C959.10 532.37 960.69 531.18 962.25 529.94C963.80 528.71 965.33 527.42 966.81 526.10C968.29 524.78 969.74 523.41 971.15 522.00C972.56 520.60 973.93 519.16 975.26 517.68C976.58 516.20 977.87 514.68 979.11 513.13C980.35 511.57 981.55 509.98 982.70 508.36C983.85 506.74 984.96 505.09 986.01 503.40C987.07 501.72 988.08 500.00 989.03 498.26C989.99 496.51 990.90 494.74 991.76 492.95C992.62 491.16 993.43 489.34 994.19 487.50C994.96 485.67 995.67 483.81 996.35 481.94C997.02 480.07 997.65 478.18 998.25 476.29C998.84 474.39 999.39 472.48 999.91 470.56C1000.43 468.64 1000.90 466.71 1001.36 464.77C1001.81 462.83 1002.23 460.89 1002.63 458.94C1003.03 456.99 1003.40 455.04 1003.75 453.08C1004.11 451.12 1004.44 449.16 1004.76 447.20C1005.08 445.24 1005.37 443.27 1005.66 441.30C1005.95 439.34 1006.22 437.37 1006.49 435.39C1006.75 433.42 1007.01 431.45 1007.25 429.48C1007.49 427.50 1007.73 425.53 1007.96 423.55C1008.18 421.58 1008.40 419.60 1008.62 417.62C1008.83 415.65 1009.03 413.67 1009.23 411.69C1009.43 409.71 1009.62 407.73 1009.81 405.75C1010.00 403.77 1010.19 401.79 1010.37 399.81C1010.55 397.83 1010.72 395.85 1010.89 393.87C1011.06 391.89 1011.23 389.91 1011.39 387.92C1011.55 385.94 1011.71 383.96 1011.86 381.98C1012.01 379.99 1012.16 378.01 1012.30 376.03C1012.45 374.04 1012.59 372.06 1012.73 370.08C1012.86 368.09 1013.00 366.11 1013.13 364.12C1013.26 362.14 1013.39 360.15 1013.52 358.17C1013.65 356.18 1013.77 354.20 1013.89 352.22C1014.02 350.23 1014.14 348.25 1014.26 346.26C1014.38 344.28 1014.49 342.29 1014.61 340.30C1014.73 338.32 1014.84 336.33 1014.96 334.35C1015.07 332.36 1015.18 330.38 1015.29 328.39C1015.41 326.41 1015.52 324.42 1015.63 322.44C1015.74 320.45 1015.85 318.46 1015.95 316.48C1016.06 314.49 1016.17 312.51 1016.28 310.52C1016.38 308.53 1016.49 306.55 1016.59 304.56C1016.70 302.58 1016.80 300.59 1016.91 298.61C1017.01 296.62 1017.12 294.63 1017.22 292.65C1017.32 290.66 1017.43 288.68 1017.53 286.69C1017.63 284.70 1017.73 282.72 1017.84 280.73C1017.94 278.74 1018.04 276.76 1018.14 274.77C1018.24 272.79 1018.34 270.80 1018.44 268.81C1018.54 266.83 1018.64 264.84 1018.74 262.86C1018.84 260.87 1018.94 258.88 1019.04 256.90C1019.14 254.91 1019.24 252.92 1019.34 250.94C1019.44 248.95 1019.54 246.97 1019.64 244.98C1019.73 242.99 1019.83 241.01 1019.93 239.02C1020.03 237.03 1020.13 235.05 1020.22 233.06C1020.32 231.08 1020.42 229.09 1020.52 227.10C1020.61 225.12 1020.71 223.13 1020.81 221.14C1020.90 219.16 1021.00 217.17 1021.09 215.18C1021.19 213.20 1021.28 211.21 1021.37 209.23C1021.47 207.24 1021.56 205.25 1021.65 203.27C1021.74 201.28 1021.83 199.29 1021.92 197.31C1022.01 195.32 1022.09 193.33 1022.18 191.35C1022.26 189.36 1022.34 187.37 1022.43 185.38C1022.51 183.40 1022.58 181.41 1022.66 179.42C1022.74 177.44 1022.81 175.45 1022.89 173.46C1022.97 171.47 1023.05 169.49 1023.14 167.50Z';
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
  // the visitor's part of the world, roughly, from their clock alone (no location request)
  const visitor = (() => {
    const lon = -new Date().getTimezoneOffset() / 60 * 15 * DEG;
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    const south = /^America\/(Sao_Paulo|Argentina|Buenos_Aires|Santiago|Lima|Bogota|Montevideo|Asuncion|La_Paz|Caracas|Guayaquil|Recife|Fortaleza|Bahia|Manaus|Belem)/.test(tz);
    const lat = /^Europe\//.test(tz) ? 48 : /^America\//.test(tz) ? (south ? -15 : 38) : /^Australia\//.test(tz) ? -28 : /^Africa\//.test(tz) ? 5
      : /^Pacific\/(Auckland|Chatham)/.test(tz) ? -40 : /^Asia\//.test(tz) ? 28 : /^Atlantic\//.test(tz) ? 35 : 25;
    return { lon, lat: lat * DEG };
  })();
  // the hour is set so the visitor's region sits in mid-morning light, with noon some way to the east
  const clockV = (() => {
    if (params.has('utc')) return clock0;
    const a = almanac(clock0), sl = Math.atan2(a.sun[1], a.sun[0]);
    let d = visitor.lon + 50 * DEG - sl; d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return clock0 - d / (2 * Math.PI) * 86400000;
  })();
  const A0 = almanac(clockV);
  const subLat = Math.asin(A0.sun[2]), subLon = Math.atan2(A0.sun[1], A0.sun[0]);
  const LAT0 = Math.max(-45 * DEG, Math.min(50 * DEG, params.has('utc') ? subLat + 14 * DEG : visitor.lat)), LON0 = subLon - 50 * DEG, BETA = 14 * DEG;
  const s0 = [Math.cos(LAT0) * Math.cos(LON0), Math.cos(LAT0) * Math.sin(LON0), Math.sin(LAT0)];
  const uh = V.norm(V.add(A0.sun, V.sc(s0, -V.dot(A0.sun, s0)))), wv = V.cross(s0, uh);
  const f0 = V.add(V.sc(uh, Math.sin(BETA)), V.sc(wv, Math.cos(BETA)));

  // high-detail window: half the globe in longitude and in latitude, centred ahead of the spacecraft,
  // cut straight out of the full-resolution maps so only the region in view is held on the GPU
  const crop = (() => {
    const lonC = LON0 - 25 * DEG, latTop = Math.min(90 * DEG, Math.max(0, LAT0 + 55 * DEG));
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
  let hiAt = -1;
  const loaded = base.then(() => { texOK = 1; });
  const hi = hiSz ? base.then(() => Promise.all([window8k(TX.dayHi, 'earth/day-' + hiSz + '.jpg', false, hiSz), window8k(TX.cloudsHi, 'earth/clouds-' + hiSz + '.jpg', true, hiSz)]))
    .then(() => { hiOK = 1; }).catch(e => console.warn('[earth] detail', e)) : Promise.resolve();
  const ORBIT = 0.0016;                               // radians of orbit per second
  const CLOUD = 0.00006;
  const TOUR = 0.0006;                                // the slow tour: the ground turns beneath the sunlight, turns per second
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
    Object.assign(comet, { pts, tab, L, M, start: t, speed: rnd(0.22, 0.28) * 1000, S: small ? 30 : 44,
      TRAIL: small ? 0.8 : 1.0, hist: [], flying: true, nextGlint: t + rnd(0.5, 0.9), nextShed: t, dist: 0 });
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
        // small ice crystals shed from the head: sharp, brief, catching the light as they tumble away
        while (t >= c.nextShed) {
          c.nextShed += rnd(0.025, 0.05);
          const off = rnd(-1, 1) * S * 0.2;
          c.parts.push({ k: 1, x: p[0] - ty * off, y: p[1] + tx * off, vx: -tx * rnd(6, 20) + rnd(-10, 10), vy: -ty * rnd(6, 20) + rnd(-4, 14), b: t, life: rnd(0.5, 1.2), r: rnd(0.12, 0.32) * S, rot: rnd(-0.6, 0.6), spin: rnd(-2.5, 2.5), I: rnd(0.6, 1.3) });
          if (Math.random() < 0.5) c.parts.push({ k: 0, x: p[0] + rnd(-3, 3), y: p[1] + rnd(-3, 3), vx: rnd(-16, 16), vy: rnd(-6, 22), b: t, life: rnd(0.4, 1.0), r: rnd(2, 3.5), rot: 0, spin: 0, I: rnd(0.5, 1.1) });
        }
        if (false && t >= c.nextGlint) {
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
        const w = (S * 0.12) * (0.3 + 0.7 * life) + 1.0;
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
      const tw = 1 + 0.03 * Math.sin(t * 13);
      const flare = 1;
      P.head.use().f('uView', W, Hh).f('uPos', c.x, c.y).f('uQ', S * 1.6).t('uLogo', 0, TX.logo)
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
  // the detail maps ease in over a second and a half from the moment they are ready
  function hiFade(tt) {
    if (!hiOK) return 0;
    if (tFix !== null) return 1;
    const ms = performance.now(); if (hiAt < 0) hiAt = ms;
    const x = Math.min(1, (ms - hiAt) / 1500); return x * x * (3 - 2 * x);
  }
  let tFix = frozen;
  const now = () => tFix !== null ? tFix : t;
  function draw(tt, dt) {
    const rig = rigAt(tt), A = almanac(clockV + tt * 1000);
    const rot = (tt * CLOUD) % 1;
    if (fl.on && fl.sim) {
      if (!fl.sim.primed) {
        const S = fl.sim; if (!S.pi) { S.pi = 0; S.pt = tt; }
        const end = tFix !== null ? 90 : Math.min(90, S.pi + 30);
        fl.fill = 1; for (; S.pi < end; S.pi++) fluidStep(1 / 30, S.pt - 3 + S.pi / 30, rig, rot); fl.fill = 0;
        if (S.pi >= 90) { S.primed = true; S.pi = 0; }
      }
      if (dt > 0) fluidStep(Math.min(dt, 1 / 30), tt, rig, rot);
    }
    gl.disable(gl.BLEND);
    // the planet
    P.earth.use().f('uRes', canvas.width, canvas.height).f('uTanY', tanY).f('uAspect', W / Hh).f('uTex', texOK).f('uFluid', fl.on && fl.sim ? 1 : 0)
      .f('uRot', rot).f('uTour', -tt * TOUR).f('uExpo', 0.30).v('uC', rig.C).v('uF', rig.f).v('uRt', rig.right).v('uUp', rig.up).v('uSun', A.sun)
      .v('uS', rig.s).v('uFh', rig.fH).v('uDom', fl.dom)
      .t('uDay', 0, TX.day).t('uClouds', 1, TX.clouds).t('uOcean', 2, TX.ocean).t('uDayHi', 5, TX.dayHi).t('uCloudsHi', 6, TX.cloudsHi).v('uCrop', crop).f('uHi', hiFade(tt))
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
  const primedP = new Promise(res => { const c = () => (!fl.on || !fl.sim || fl.sim.primed || frozen !== null) ? res() : requestAnimationFrame(c); c(); });
  Promise.all([loaded, skyP, primedP, frozen !== null ? hi : null]).then(() => {
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
  }
})();
