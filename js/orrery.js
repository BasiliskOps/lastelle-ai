// The orrery: a small, living model of our corner of the sky.
// Matte bodies in the site's own palette, lit only by the Sun, each on its true axis.
// Two arrangements share this engine:
//   "tellurion" – Sun, Earth and the tidally locked Moon
//   "system"    – the Sun and all eight planets at stylised scale (the default)
// WebGL2, no dependencies. Earth and Moon carry real relief (NASA LOLA/LRO, Solar System Scope);
// the other planets are drawn procedurally from their known anatomy.
//
// Continuity: the clock only ever moves forward in small steps (a long frame slows it, never skips it),
// it pauses off screen and resumes exactly where it stopped, and every time-driven value the GPU sees
// is a bounded phase that wraps seamlessly, so the motion stays smooth however long the page is open.
// If the GPU drops the context, everything is rebuilt and the orrery carries on from the same moment.
(() => {
  const host = document.querySelector('.plate-graphic');
  if (!host) return;
  const canvas = host.querySelector('canvas');
  if (!canvas) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const BASE = new URL('../assets/orrery/', document.currentScript ? document.currentScript.src : location.href);
  const params = new URLSearchParams(location.search);
  const SCENE = params.get('orrery') || host.dataset.scene || 'system';
  const RINGS = params.get('rings') === '1' || host.dataset.orbits === 'on';

  const N = 97;
  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;

  // ---------- shaders ----------
  const COMMON = `#version 300 es
precision highp float;
const float PI=3.14159265;
uniform mat4 uVP;
uniform vec3 uSun, uEye;
`;
  const vsBody = COMMON + `
in vec2 aST;
uniform vec3 uCenter; uniform float uRadius; uniform mat3 uRot;
out vec3 vW, vP, vE, vNo; out vec2 vUV;
void main(){
  float lon=aST.x*2.*PI-PI, lat=(aST.y-.5)*PI;
  vec3 d=vec3(cos(lat)*sin(lon),sin(lat),cos(lat)*cos(lon));
  vP=d;                                             // body frame
  vE=uRot*vec3(cos(lon),0.,-sin(lon));              // east
  vNo=uRot*vec3(-sin(lat)*sin(lon),cos(lat),-sin(lat)*cos(lon)); // north
  vW=uCenter+uRadius*(uRot*d);
  vUV=vec2(aST.x,1.-aST.y);
  gl_Position=uVP*vec4(vW,1.);
}`;

  const fsBody = COMMON + `
in vec3 vW, vP, vE, vNo; in vec2 vUV;
uniform vec3 uCenter; uniform float uRadius; uniform mat3 uRot;
uniform int uKind;      // 0 Sun, 1 Mercury, 2 Venus, 3 Earth, 4 Mars, 5 Jupiter, 6 Saturn, 7 Uranus, 8 Neptune, 9 Moon
uniform float uFill;
uniform vec3 uPhase;    // wrapped phases in [0, 2pi): x Sun granulation, y Venus clouds, z Jupiter bands
uniform sampler2D uEarth, uMoon;
uniform vec4 uRingShadow; // xyz centre, w inner radius (for Saturn's rings shadowing the globe: unused w=0)
out vec4 o;
vec3 lin(vec3 c){return pow(c,vec3(2.2));}
// drift through noise space along a large circle: locally a straight, steady drift, but the offset stays
// bounded and returns exactly to its start after one turn, so the phase can wrap with no visible seam
vec3 drift(float ph,float R){return R*vec3(1.-cos(ph),0.,sin(ph));}
float h1(float n){return fract(sin(n)*43758.5453);}
vec3 h3(vec3 p){return fract(sin(vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6))))*43758.5453);}
float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float n=dot(i,vec3(1.,57.,113.));
  return mix(mix(mix(h1(n),h1(n+1.),f.x),mix(h1(n+57.),h1(n+58.),f.x),f.y),
             mix(mix(h1(n+113.),h1(n+114.),f.x),mix(h1(n+170.),h1(n+171.),f.x),f.y),f.z);}
float fbm(vec3 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n3(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}
float cells(vec3 p){vec3 i=floor(p),f=fract(p);float d=8.;
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec3 c=vec3(x,y,z);vec3 r=c+h3(i+c)-f;d=min(d,dot(r,r));}
  return sqrt(d);}
float atanh1(float x){x=clamp(x,-.985,.985);return .5*log((1.+x)/(1.-x));}

// site palette (sRGB → linear)
vec3 PAPER(){return lin(vec3(.925,.902,.851));}

// procedural planets: height h and albedo a at body-frame point P
// soft matte colours, one recognisable identity per body
vec3 C(float r,float g,float b){return lin(vec3(r,g,b)/255.);}
void planet(int k,vec3 P,out float h,out vec3 a){
  float lat=P.y, lon=atan(P.x,P.z);
  if(k==1){                                      // Mercury: grey, heavily cratered, bright rays
    float c=cells(P*5.)+.5*cells(P*11.);
    float bowl=1.-smoothstep(.0,.42,c), rimc=exp(-pow((c-.45)/.08,2.));
    h=.6*rimc-.8*bowl+.3*fbm(P*9.);
    a=mix(C(122.,116.,110.),C(178.,172.,164.),.35+.45*fbm(P*4.)+.25*rimc);
  } else if(k==2){                               // Venus: pale butter cloud deck in slow chevrons
    float s=fbm(vec3(P.x*2.,lat*6.+1.4*sin(P.x*3.+P.z*2.),P.z*2.)+drift(uPhase.y,8.));
    h=.12*s; a=mix(C(214.,196.,150.),C(236.,224.,190.),s);
  } else if(k==4){                               // Mars: rust plains, dark Syrtis-like terrain, white cap
    float s=fbm(P*3.5), c=cells(P*4.);
    h=.5*s+.4*(1.-smoothstep(0.,.35,c));
    a=mix(C(196.,120.,82.),C(128.,78.,58.),smoothstep(.48,.66,s));
    a=mix(a,C(236.,232.,226.),smoothstep(.86,.92,abs(lat)+.04*s));
  } else if(k==5){                               // Jupiter: cream zones, tan-brown belts, the Great Red Spot
    float w=fbm(vec3(P.x*2.5,lat*10.,P.z*2.5)+drift(uPhase.z,8.))-.5;
    float y=lat+.05*w;
    float b=.5+.5*sin(y*21.+.7)*(.7+.3*sin(y*47.));
    h=.25*b+.2*w;
    a=mix(C(232.,218.,190.),C(176.,132.,98.),b*.85);
    vec2 g=vec2(lon-.8,(lat+.37)*2.4); float gd=length(g);
    a=mix(a,C(196.,110.,80.),smoothstep(.28,.17,gd)); h+=.4*smoothstep(.3,.15,gd);
  } else if(k==6){                               // Saturn: butterscotch, faint belts
    float w=fbm(vec3(P.x*2.,lat*9.,P.z*2.))-.5;
    float b=.5+.5*sin((lat+.04*w)*16.+.3)*(.6+.4*sin(lat*39.));
    h=.18*b+.1*w;
    a=mix(C(230.,206.,150.),C(196.,164.,108.),b*.7);
  } else if(k==7){                               // Uranus: soft cyan, almost featureless
    h=.05*fbm(P*3.); a=C(160.,206.,212.)*(.95+.06*sin(lat*9.));
  } else {                                       // Neptune: soft blue, darker bands, the dark spot
    float s=fbm(vec3(P.x*2.,lat*8.,P.z*2.));
    h=.2*s; a=mix(C(84.,118.,186.),C(126.,156.,214.),.45+.3*sin(lat*10.)+.2*s);
    vec2 g=vec2(lon+.6,(lat+.32)*2.); a=mix(a,C(52.,72.,128.),smoothstep(.25,.16,length(g)));
  }
}

void main(){
  vec3 V=normalize(uEye-vW);
  vec3 N=normalize(vW-uCenter);
  if(uKind==0){                                  // the Sun: soft pale gold, a little warmer at the limb, alive
    float mu=max(dot(N,V),0.);
    float g=cells(vP*26.+drift(uPhase.x,8.).xzy);
    vec3 c=mix(C(232.,196.,120.),C(250.,236.,196.),pow(mu,.6));
    c*=.95+.08*smoothstep(.15,.6,g);
    o=vec4(pow(c,vec3(1./2.2)),1.);
    return;
  }
  vec3 T=normalize(vE), B=normalize(vNo);
  vec3 alb; vec3 Nr=N;
  if(uKind==3){                                  // Earth: real relief, sage continents on soft seas
    vec4 t=texture(uEarth,vUV);
    Nr=normalize(N-(atanh1(2.*t.r-1.)*T+atanh1(2.*t.g-1.)*B)*1.1);
    alb=mix(C(104.,142.,170.),C(170.,166.,124.),smoothstep(.25,.75,t.b));          // soft sea blue, sage land
  } else if(uKind==9){                           // the Moon: LRO albedo, LOLA relief
    vec4 t=texture(uMoon,vUV);
    Nr=normalize(N-(atanh1(2.*t.r-1.)*T+atanh1(2.*t.g-1.)*B)*.85);
    alb=C(176.,172.,166.)*(.55+.6*t.b);
  } else {
    float h0; vec3 a0; planet(uKind,vP,h0,a0); alb=a0;
    float e=.012, hx, hy; vec3 dummy;
    planet(uKind,normalize(vP+e*inverse(uRot)*T),hx,dummy);
    planet(uKind,normalize(vP+e*inverse(uRot)*B),hy,dummy);
    Nr=normalize(N-((hx-h0)*T+(hy-h0)*B)/e*.035);
  }
  // light: the Sun alone, a soft terminator, a little warmth bounced back from the page
  vec3 L=normalize(uSun-vW);
  float nl=dot(Nr,L), ng=dot(N,L);
  float wrap=.06+.30*uFill;
  float diff=clamp((nl+wrap)/(1.+wrap),0.,1.)*smoothstep(-.12-.3*uFill,.10,ng);
  // Saturn's rings throw a shadow band across the globe
  if(uRingShadow.w>0.){
    vec3 rn=uRot*vec3(0.,1.,0.);
    float tt=dot(uCenter-vW,rn)/dot(L,rn);
    if(tt>0.){ float rr=length(vW+L*tt-uCenter)/uRadius;
      float dens=smoothstep(1.24,1.30,rr)*(1.-smoothstep(2.24,2.30,rr))*(1.-.85*(smoothstep(1.93,1.95,rr)-smoothstep(2.01,2.03,rr)));
      diff*=1.-.55*dens; }
  }
  vec3 sun=lin(vec3(1.,.95,.86))*1.15;
  vec3 amb=PAPER()*(.13+.30*uFill)+lin(vec3(.80,.74,.64))*.06*(.5+.5*N.y);
  float rim=pow(1.-max(dot(N,V),0.),3.)*.16;     // a soft edge so the night side never melts into the page
  vec3 c=alb*(sun*diff+amb)+PAPER()*rim*(.4+.6*diff);
  c=c/(1.+c*.12);
  o=vec4(pow(c,vec3(1./2.2)),1.);
}`;

  // Saturn's rings: a thin annulus with the real C, B and A rings, the Cassini division and the Encke gap
  const vsRing = COMMON + `
in vec2 aST;
uniform vec3 uCenter; uniform float uRadius; uniform mat3 uRot;
out vec3 vW; out float vR;
void main(){
  float r=mix(1.22,2.30,aST.x), a=aST.y*2.*PI;
  vR=r; vW=uCenter+uRadius*(uRot*vec3(r*cos(a),0.,r*sin(a)));
  gl_Position=uVP*vec4(vW,1.);
}`;
  const fsRing = COMMON + `
in vec3 vW; in float vR;
uniform vec3 uCenter; uniform float uRadius; uniform mat3 uRot;
out vec4 o;
vec3 lin(vec3 c){return pow(c,vec3(2.2));}
void main(){
  float r=vR, d=0.;
  d+=.28*smoothstep(1.23,1.27,r)*(1.-smoothstep(1.50,1.53,r));
  d+=.92*smoothstep(1.52,1.57,r)*(1.-smoothstep(1.92,1.95,r));
  d+=.62*smoothstep(2.02,2.06,r)*(1.-smoothstep(2.24,2.29,r));
  d*=1.-.9*(1.-smoothstep(.0,.007,abs(r-2.215)));
  d*=.82+.18*sin(r*150.);
  if(d<.01) discard;
  vec3 L=normalize(uSun-vW);
  vec3 n=uRot*vec3(0.,1.,0.);
  float lit=.35+.65*abs(dot(n,L));
  // the planet's shadow across the rings
  vec3 oc=vW-uCenter; float b=dot(oc,L), c=dot(oc,oc)-uRadius*uRadius;
  if(b<0.&&b*b-c>0.) lit*=.25;
  vec3 col=mix(lin(vec3(150.,138.,118.)/255.),lin(vec3(224.,208.,172.)/255.),.35+.5*d)*(lit*1.05+.08);
  col=col/(1.+col*.12);
  float al=clamp(d*1.05,0.,.95);
  o=vec4(pow(col,vec3(1./2.2))*al,al);
}`;

  // orbit lines (optional): hairline circles in the plane, anti-aliased across their width
  const vsOrbit = COMMON + `
in vec2 aST;
uniform float uR, uW;
out float vA;
void main(){
  float a=aST.y*2.*PI, r=uR+(aST.x-.5)*uW;
  vA=aST.x;
  gl_Position=uVP*vec4(r*cos(a),0.,-r*sin(a),1.);
}`;
  const fsOrbit = COMMON + `
in float vA;
uniform float uAlpha;
out vec4 o;
void main(){
  float e=1.-abs(vA*2.-1.);
  float al=uAlpha*smoothstep(0.,.6,e);
  vec3 c=vec3(.318,.282,.227);                     // the site's secondary ink
  o=vec4(c*al,al);
}`;

  // the sphere grid, shared by every body, the ring annulus and the orbit lines
  const st = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { st[(j * N + i) * 2] = i / (N - 1); st[(j * N + i) * 2 + 1] = j / (N - 1); }
  const idx = new Uint16Array((N - 1) * (N - 1) * 6); let q = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1; idx.set([a, b, d, a, d, c], q); q += 6; }

  // the surface maps are decoded once and kept, so a GPU reset never refetches them
  const loadImage = name => new Promise((res, rej) => {
    const img = new Image(); img.decoding = 'async';
    img.onload = () => res(img); img.onerror = rej;
    img.src = new URL(name + '-surface.jpg', BASE).href;
  });

  // ---------- GL state (rebuilt from scratch if the context is lost) ----------
  let gl = null, body = null, ring = null, orbitProg = null, vao = null;
  const maps = {};
  let images = null;

  function compile(vsrc, fsrc) {
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) { if (!gl.isContextLost()) console.error(gl.getShaderInfoLog(x)); return null; } return x; };
    const v = sh(gl.VERTEX_SHADER, vsrc), f = sh(gl.FRAGMENT_SHADER, fsrc);
    if (!v || !f) return null;
    const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'aST'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { if (!gl.isContextLost()) console.error(gl.getProgramInfoLog(p)); return null; }
    const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }

  function upload(img) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return tex;
  }

  // build every GPU resource; returns false if WebGL2 or a shader is unavailable
  function setup() {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, depth: true });
    if (!gl) return false;
    body = compile(vsBody, fsBody); ring = compile(vsRing, fsRing); orbitProg = compile(vsOrbit, fsOrbit);
    if (!body || !ring || !orbitProg) return false;
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, st, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    if (images) { maps.earth = upload(images.earth); maps.moon = upload(images.moon); }
    return true;
  }

  // ---------- small math ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2);
    return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; };
  const look = (e, c) => { const z = norm(sub(e, c)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]; };
  const mul4 = (a, b) => { const r = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return r; };
  // column-major 3x3 rotations
  const Ry = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; };
  const Rz = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; };
  const mul3 = (a, b) => { const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[j * 3 + i] += a[k * 3 + i] * b[j * 3 + k]; return r; };
  // a body's orientation: spin about its own axis, then the axis tilted (obliquity) toward a fixed direction in space
  const orient = (tilt, spin, toward = 0) => mul3(Ry(toward), mul3(Rz(-tilt), Ry(spin % TAU)));
  const orbit = (r, a, incl = 0) => [r * Math.cos(a), r * Math.sin(a) * Math.sin(incl), -r * Math.sin(a) * Math.cos(incl)];
  // a steady drift of `speed` noise units per second around a circle of radius R, as a phase wrapped to [0, 2pi)
  const phase = (t, speed, R) => (t * speed / R) % TAU;

  // ---------- the two arrangements ----------
  // spin rates are art-directed; tilts are real
  function tellurion(t) {
    const sun = [0, 0, 0];
    const ea = (0.12 + t * 0.05) % TAU;                   // Earth's year: ~2 minutes around the Sun
    const E = orbit(1.72, ea);
    const ma = (2.4 + t * 0.42) % TAU;                    // the Moon's month: ~15 s around Earth
    const M = (() => { const o = orbit(0.70, ma, 5.14 * DEG); return [E[0] + o[0], E[1] + o[1], E[2] + o[2]]; })();
    return {
      sun, eye: [0, 1.0, 5.3], target: [0.62, -0.02, 0], fov: 30,
      bodies: [
        { kind: 0, c: sun, r: 0.46, rot: orient(7.25 * DEG, t * 0.05) },
        { kind: 3, c: E, r: 0.46, rot: orient(23.44 * DEG, 1.85 + t * 0.12, -1.25) },  // North America in daylight, then turning
        { kind: 9, c: M, r: 0.125, rot: orient(1.54 * DEG, ma - Math.PI / 2 + Math.PI) },  // tidally locked: near side faces Earth
      ],
    };
  }
  function system(t) {
    const sun = [0, 0, 0];
    const P = [ // kind, orbit r, size, tilt°, start angle, spin
      [1, 0.50, 0.048, 0.03, 2.4, 0.05], [2, 0.78, 0.078, 177.4, -0.6, -0.03], [3, 1.06, 0.084, 23.44, 0.95, 0.30],
      [4, 1.34, 0.062, 25.19, 3.6, 0.29], [5, 1.74, 0.190, 3.13, -2.2, 0.70], [6, 2.18, 0.158, 26.73, 0.55, 0.65],
      [7, 2.56, 0.108, 97.77, 2.7, -0.40], [8, 2.90, 0.104, 28.32, -0.35, 0.42]];
    const bodies = [{ kind: 0, c: sun, r: 0.25, rot: orient(7.25 * DEG, t * 0.05) }];
    let saturn = null, earth = null;
    for (const [k, r, s, tilt, a0, w] of P) {
      const a = (a0 + t * 0.26 * Math.pow(r / 0.50, -1.5)) % TAU;   // Kepler's third law: Mercury ~24 s, Neptune ~4 min
      const c = orbit(r, a);
      const b = { kind: k, c, r: s, rot: orient(tilt * DEG, t * w + (k === 3 ? 0.55 : 0), 0.4) };
      bodies.push(b); if (k === 6) saturn = b; if (k === 3) earth = b;
    }
    const ma = (t * 0.9) % TAU;
    const mo = orbit(0.15, ma, 5.14 * DEG);
    bodies.push({ kind: 9, c: [earth.c[0] + mo[0], earth.c[1] + mo[1], earth.c[2] + mo[2]], r: 0.024, rot: orient(1.54 * DEG, ma + Math.PI / 2) });
    return { sun, eye: [0, 3.5, 6.6], target: [0, -0.32, 0], fov: 31, bodies, saturn, radii: P.map(p => p[1]), fill: 1 };
  }
  const arrange = SCENE === 'tellurion' ? tellurion : system;

  // Responsive fit: the whole system, every body over its full orbit and the full camera drift, must stay
  // inside its own slot so it never reaches the cards at any width. Measured once per slot size; at sizes
  // where it already fits, the scale is exactly 1 and nothing changes.
  const PAD = 6;                                         // px of clear paper kept between the outermost body and the slot edge
  let fitKey = '', fitK = 1;
  function fitScale(hw, hh) {
    const key = hw + 'x' + hh;
    if (key === fitKey) return fitK;
    const P0 = persp(arrange(0).fov * DEG, hw / hh, 0.5, 40);
    let maxX = 0, maxUp = 0, maxDown = 0;
    for (let t = 0; t <= 340; t += 0.5) {                // 340 s covers a full orbit of the slowest body (Neptune)
      const S = arrange(t);
      for (const dr of [-0.05, 0, 0.05]) {               // the camera drift's full range
        const eye = [S.eye[0] * Math.cos(dr) + S.eye[2] * Math.sin(dr), S.eye[1], -S.eye[0] * Math.sin(dr) + S.eye[2] * Math.cos(dr)];
        const M = mul4(P0, look(eye, S.target));
        for (const b of S.bodies) {
          const c = b.c, wc = M[3] * c[0] + M[7] * c[1] + M[11] * c[2] + M[15];
          const x = (M[0] * c[0] + M[4] * c[1] + M[8] * c[2] + M[12]) / wc * hw / 2;
          const y = (M[1] * c[0] + M[5] * c[1] + M[9] * c[2] + M[13]) / wc * hh / 2;
          const rad = b.r * (b.kind === 6 ? 2.3 : 1) * P0[5] / wc * hh / 2;   // Saturn's rings reach 2.3 radii
          maxX = Math.max(maxX, Math.abs(x) + rad); maxUp = Math.max(maxUp, y + rad); maxDown = Math.max(maxDown, -y + rad);
        }
      }
    }
    fitKey = key;
    fitK = Math.min(1, (hw / 2 - PAD) / maxX, (hh / 2 - PAD) / maxUp, (hh / 2 - PAD) / maxDown);
    return fitK;
  }

  let quality = 1;
  function draw(t) {
    if (!gl || gl.isContextLost() || !maps.earth || !maps.moon) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
    // the canvas overhangs its cell on every side (see site.css); the scene is framed to the cell as before,
    // and the overhang just gives the orbits room, so nothing is ever clipped
    const hw = Math.max(1, host.clientWidth), hh = Math.max(1, host.clientHeight);
    const cw = Math.max(1, canvas.clientWidth), ch = Math.max(1, canvas.clientHeight);
    const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);

    const S = arrange(t);
    const drift = 0.05 * Math.sin((t * 0.07) % TAU);
    const eye = [S.eye[0] * Math.cos(drift) + S.eye[2] * Math.sin(drift), S.eye[1], -S.eye[0] * Math.sin(drift) + S.eye[2] * Math.cos(drift)];
    const P = persp(S.fov * DEG, hw / hh, 0.5, 40);
    const k = fitScale(hw, hh);                          // 1 wherever the whole system already fits its slot
    P[0] *= k * hw / cw; P[5] *= k * hh / ch;            // framed to the slot, drawn into the (possibly larger) canvas
    const vp = mul4(P, look(eye, S.target));

    gl.useProgram(body.p);
    gl.uniformMatrix4fv(body.u.uVP, false, vp);
    gl.uniform3fv(body.u.uEye, eye); gl.uniform3fv(body.u.uSun, S.sun);
    gl.uniform3f(body.u.uPhase, phase(t, 0.05, 8), phase(t, 0.02, 8), phase(t, 0.03, 8));
    gl.uniform1f(body.u.uFill, S.fill || 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, maps.earth);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maps.moon);
    gl.uniform1i(body.u.uEarth, 0); gl.uniform1i(body.u.uMoon, 1);
    for (const b of S.bodies) {
      gl.uniform1i(body.u.uKind, b.kind);
      gl.uniform3fv(body.u.uCenter, b.c); gl.uniform1f(body.u.uRadius, b.r);
      gl.uniformMatrix3fv(body.u.uRot, false, b.rot);
      gl.uniform4f(body.u.uRingShadow, 0, 0, 0, b.kind === 6 ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    }
    if (RINGS && S.radii) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.useProgram(orbitProg.p);
      gl.uniformMatrix4fv(orbitProg.u.uVP, false, vp);
      const px = 2 * Math.tan(S.fov * DEG / 2) * Math.hypot(...eye) / (hh * dpr);   // world size of one pixel at the scene's distance
      gl.uniform1f(orbitProg.u.uW, 2.4 * px); gl.uniform1f(orbitProg.u.uAlpha, 0.30);
      for (const r of S.radii) { gl.uniform1f(orbitProg.u.uR, r); gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0); }
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
    if (S.saturn) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.useProgram(ring.p);
      gl.uniformMatrix4fv(ring.u.uVP, false, vp); gl.uniform3fv(ring.u.uSun, S.sun);
      gl.uniform3fv(ring.u.uCenter, S.saturn.c); gl.uniform1f(ring.u.uRadius, S.saturn.r);
      gl.uniformMatrix3fv(ring.u.uRot, false, S.saturn.rot);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }

  if (!setup()) { host.classList.add('off'); return; }

  // the one clock: it only ever advances by small real steps, so nothing ever jumps, loops or resets
  let t = 0;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    if (setup()) draw(t); else host.classList.add('off');
  }, false);

  // its maps are only fetched once the section is getting close, so they never compete with the hero
  const near = new Promise(res => { const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); res(); } }, { rootMargin: '150% 0px' }); io.observe(host); });
  near.then(() => Promise.all([loadImage('earth'), loadImage('moon')])).then(([earth, moon]) => {
    images = { earth, moon };
    if (!gl.isContextLost()) { maps.earth = upload(earth); maps.moon = upload(moon); }
    if (reduced) { new ResizeObserver(() => draw(t)).observe(host); draw(t); host.classList.add('ready'); return; }
    let visible = false, last = 0, slow = 0, frames = 0;
    new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; }, { threshold: 0 }).observe(host);
    const loop = now => {
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1); last = now;   // a long frame slows time, never skips it
      if (visible && !document.hidden) {
        t += dt; draw(t);
        frames++; if (dt > 0.024) slow++;
        if (frames === 90) { if (slow > 30 && quality > 0.6) quality -= 0.15; frames = slow = 0; }
      }
      requestAnimationFrame(loop);
    };
    draw(t); host.classList.add('ready');
    requestAnimationFrame(n => { last = n; loop(n); });
  }).catch(() => host.classList.add('off'));
})();
