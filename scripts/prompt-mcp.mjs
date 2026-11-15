import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try { await import('@modelcontextprotocol/sdk/server/mcp.js'); }
catch { console.error('本地 MCP 尚缺官方 @modelcontextprotocol/sdk；需批准最小依赖后安装，未启动任何协议服务。'); process.exit(1); }
const envFile = await readFile('.env', 'utf8').catch(() => '');
const local = Object.fromEntries(envFile.split(/\r?\n/).filter(l => !l.trim().startsWith('#') && l.includes('=')).map(l => { const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
await mkdir('.playground', { recursive: true });
await build({ entryPoints: ['scripts/prompt-mcp-server.ts'], outfile: '.playground/prompt-mcp.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel:'silent', external:['genkit','@genkit-ai/*','@modelcontextprotocol/*','zod'] });
const child = spawn(process.execPath, ['.playground/prompt-mcp.cjs'], { cwd:root, stdio:'inherit', env:{...process.env, LLM_GATEWAY_TOKEN: process.env.LLM_GATEWAY_TOKEN || local.llm_gateway_token || '', LLM_GATEWAY_URL:process.env.LLM_GATEWAY_URL || local.llm_gateway_url || 'http://192.168.8.10:8088/v1'} });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit', code=>{process.exitCode=code??1;});
