import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await mkdir('.playground', { recursive: true });
await build({
  entryPoints: ['apps/api/src/playground.ts'], outfile: '.playground/server.cjs',
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  external: ['firebase-admin', 'firebase-admin/*', 'genkit', '@genkit-ai/*', 'zod'],
});
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const [command, args] of [
  [process.execPath, ['.playground/server.cjs']],
  [process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.playground.config.ts']],
]) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code, signal) => { if (!stopping) stop(signal ? 1 : code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
