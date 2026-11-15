import { useEffect, useRef, useState } from 'react';

export interface SoftAuroraProps {
  color1?: string;
  color2?: string;
  brightness?: number;
  speed?: number;
}

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform float uTime;
uniform vec3 uResolution;
uniform float uSpeed;
uniform float uScale;
uniform float uBrightness;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec2 uMouse;
uniform bool uEnableMouse;

#define TAU 6.28318

vec3 gradientHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 234.6)), dot(p, vec3(269.5, 183.3, 198.3)), dot(p, vec3(169.5, 283.3, 156.9)));
  vec3 h = fract(sin(p) * 43758.5453123);
  float phi = acos(2.0 * h.x - 1.0);
  float theta = TAU * h.y;
  return vec3(cos(theta) * sin(phi), sin(theta) * cos(phi), cos(phi));
}

float quinticSmooth(float t) {
  float t2 = t * t;
  float t3 = t * t2;
  return 6.0 * t3 * t2 - 15.0 * t2 * t2 + 10.0 * t3;
}

vec3 cosineGradient(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(TAU * (c * t + d));
}

float perlin3D(float amplitude, float frequency, float px, float py, float pz) {
  float x = px * frequency;
  float y = py * frequency;
  float fx = floor(x); float fy = floor(y); float fz = floor(pz);
  float cx = ceil(x);  float cy = ceil(y);  float cz = ceil(pz);
  float sx = quinticSmooth(x - fx);
  float sy = quinticSmooth(y - fy);
  float sz = quinticSmooth(pz - fz);
  float d000 = dot(gradientHash(vec3(fx, fy, fz)), vec3(x - fx, y - fy, pz - fz));
  float d100 = dot(gradientHash(vec3(cx, fy, fz)), vec3(x - cx, y - fy, pz - fz));
  float d010 = dot(gradientHash(vec3(fx, cy, fz)), vec3(x - fx, y - cy, pz - fz));
  float d110 = dot(gradientHash(vec3(cx, cy, fz)), vec3(x - cx, y - cy, pz - fz));
  float d001 = dot(gradientHash(vec3(fx, fy, cz)), vec3(x - fx, y - fy, pz - cz));
  float d101 = dot(gradientHash(vec3(cx, fy, cz)), vec3(x - cx, y - fy, pz - cz));
  float d011 = dot(gradientHash(vec3(fx, cy, cz)), vec3(x - fx, y - cy, pz - cz));
  float d111 = dot(gradientHash(vec3(cx, cy, cz)), vec3(x - cx, y - cy, pz - cz));
  float ly0 = mix(mix(d000, d100, sx), mix(d010, d110, sx), sy);
  float ly1 = mix(mix(d001, d101, sx), mix(d011, d111, sx), sy);
  return amplitude * mix(ly0, ly1, sz);
}

float auroraGlow(float t, vec2 shift) {
  vec2 uv = gl_FragCoord.xy / uResolution.y + shift;
  float noiseVal = 0.0;
  float freq = 2.5;
  float amp = 1.0;
  vec2 samplePos = uv * uScale;
  for (float i = 0.0; i < 3.0; i += 1.0) {
    noiseVal += perlin3D(amp, freq, samplePos.x, samplePos.y, t);
    amp *= 0.1;
    freq *= 2.0;
  }
  float yBand = uv.y * 10.0 - 5.0;
  return 0.3 * max(exp(1.0 - 1.1 * abs(noiseVal + yBand)), 0.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  float t = uSpeed * 0.4 * uTime;
  vec2 shift = uEnableMouse ? (uMouse - 0.5) * 0.25 : vec2(0.0);
  float glow1 = auroraGlow(t, shift);
  float glow2 = auroraGlow(t, shift);
  vec3 g1 = cosineGradient(uv.x + uTime * uSpeed * 0.2, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.3, 0.20, 0.20));
  vec3 g2 = cosineGradient(uv.x + uTime * uSpeed * 0.1, vec3(0.5), vec3(0.5), vec3(2.0, 1.0, 0.0), vec3(0.5, 0.20, 0.25));
  vec3 col = (0.99 * glow1 * g1 * uColor1 + 0.99 * glow2 * g2 * uColor2) * uBrightness;
  gl_FragColor = vec4(col, clamp(length(col), 0.0, 1.0));
}
`;

function hexToVec3(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export function SoftAurora({ color1 = '#e8b84d', color2 = '#605cff', brightness = 0.55, speed = 0.6 }: SoftAuroraProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      setFallback(true);
      return;
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) {
      setFallback(true);
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setFallback(true);
      return;
    }

    container.appendChild(canvas);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uRes = gl.getUniformLocation(prog, 'uResolution');
    const uMouse = gl.getUniformLocation(prog, 'uMouse');
    const uEnableMouse = gl.getUniformLocation(prog, 'uEnableMouse');
    gl.uniform1f(gl.getUniformLocation(prog, 'uSpeed'), speed);
    gl.uniform1f(gl.getUniformLocation(prog, 'uScale'), 1.5);
    gl.uniform1f(gl.getUniformLocation(prog, 'uBrightness'), brightness);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uColor1'), hexToVec3(color1));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uColor2'), hexToVec3(color2));

    const finePointer = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: fine)') : null;
    const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const mouseEnabled = finePointer?.matches ?? false;
    gl.uniform1i(uEnableMouse, mouseEnabled ? 1 : 0);

    const curMouse = [0.5, 0.5];
    let tgtMouse = [0.5, 0.5];
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      tgtMouse = [(e.clientX - r.left) / Math.max(r.width, 1), 1.0 - (e.clientY - r.top) / Math.max(r.height, 1)];
    };
    const onLeave = () => { tgtMouse = [0.5, 0.5]; };
    if (mouseEnabled) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseleave', onLeave);
    }

    const resize = () => {
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 0.5), 1);
      const w = Math.max(1, Math.floor((container.clientWidth || 1) * dpr));
      const h = Math.max(1, Math.floor((container.clientHeight || 1) * dpr));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform3f(uRes, w, h, w / Math.max(h, 1));
    };
    window.addEventListener('resize', resize);
    resize();

    let rafId = 0;
    let running = false;
    const renderFrame = (time: number) => {
      if (!running) return;
      rafId = window.requestAnimationFrame(renderFrame);
      gl.uniform1f(uTime, time * 0.001);
      if (mouseEnabled) {
        curMouse[0] += 0.05 * (tgtMouse[0] - curMouse[0]);
        curMouse[1] += 0.05 * (tgtMouse[1] - curMouse[1]);
        gl.uniform2f(uMouse, curMouse[0], curMouse[1]);
      } else {
        gl.uniform2f(uMouse, 0.5, 0.5);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const start = () => {
      if (running) return;
      if (motionQuery?.matches) {
        gl.uniform1f(uTime, 0);
        gl.uniform2f(uMouse, 0.5, 0.5);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return;
      }
      if (document.hidden) return;
      running = true;
      rafId = window.requestAnimationFrame(renderFrame);
    };
    const stop = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
      running = false;
    };
    const onVis = () => { if (document.hidden) stop(); else start(); };
    const onMotion = () => { stop(); start(); };
    motionQuery?.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', onVis);
    start();

    return () => {
      stop();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      motionQuery?.removeEventListener('change', onMotion);
      if (mouseEnabled) {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseleave', onLeave);
      }
      if (canvas.parentNode === container) container.removeChild(canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [color1, color2, brightness, speed]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${fallback ? 'vela-aurora-glow' : ''}`}
    />
  );
}
