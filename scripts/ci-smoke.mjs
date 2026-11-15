// UI regression only. Production model verification lives in scripts/ci/live-smoke.mjs.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
const base = 'http://127.0.0.1:3127';
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '3127', '--strictPort'], { cwd: resolve('apps/web'), stdio: 'inherit' });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('Vite exited before readiness');
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error('Vite readiness timed out');
  const test = spawn(process.execPath, ['scripts/frontend-regressions.mjs'], { stdio: 'inherit', env: { ...process.env, WEB_BASE_URL: base } });
  const [code] = await once(test, 'exit');
  if (code !== 0) throw new Error(`Browser regressions exited ${code}`);
} finally { server.kill('SIGTERM'); }
