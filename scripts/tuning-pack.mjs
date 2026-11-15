import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { compilePromptResources } from './prompt-build.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv.indexOf('--output');
const destination = resolve(root, requested < 0 ? '.playground/vela-tuning' : process.argv[requested + 1]);
if (await stat(destination).catch(() => null)) throw new Error('Output already exists; choose a fresh --output directory to preserve editable prompts and results');
await mkdir(dirname(destination), { recursive: true });
const staging = await mkdtemp(resolve(dirname(destination), '.vela-tuning-pack-'));
const sha = data => createHash('sha256').update(data).digest('hex');
try {
  const resources = await compilePromptResources();
  const deps = {};
  for (const name of ['genkit', 'zod', '@modelcontextprotocol/sdk']) deps[name] = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  await mkdir(resolve(staging, 'runtime'));
  await mkdir(resolve(staging, 'cases'));
  await mkdir(resolve(staging, 'reports'));
  await writeFile(resolve(staging, 'reports/.gitkeep'), '');
  await cp(resolve(root,'scripts/tuning-README.md'),resolve(staging,'README.md'));
  await cp(resolve(root,'scripts/tuning-assets'),staging,{recursive:true});
  await cp(resolve(root, 'apps/api/prompts'), resolve(staging, 'prompts'), { recursive: true });
  // Explicit synthetic resource allowlist; never copy environment, trace or user data.
  for (const name of ['catalog.json', 'products.json', 'fixed-results.json', 'ab-cases.json', 'hydrogen-regression-cases.json']) await cp(resolve(root, 'apps/api/playground-fixtures', name), resolve(staging, 'cases', name));
  const result = await build({ absWorkingDir:root, entryPoints:['scripts/prompt-mcp-server.ts'], outfile:resolve(staging,'runtime/server.cjs'), bundle:true, platform:'node', target:'node22', format:'cjs', metafile:true, logLevel:'silent', external:['genkit','genkit/*','zod','@modelcontextprotocol/*'] });
  const compilerResult = await build({ absWorkingDir:root, entryPoints:['scripts/prompt-build.mjs'], outfile:resolve(staging,'runtime/compiler.mjs'), bundle:true, platform:'node', target:'node22', format:'esm', metafile:true, logLevel:'silent', external:['genkit','genkit/*'] });
  const inputs = await Promise.all([...new Set([...Object.keys(result.metafile.inputs),...Object.keys(compilerResult.metafile.inputs),'scripts/tuning-pack.mjs'])].sort().map(async path => [path, sha(await readFile(resolve(root,path)))]));
  let runtimeCommit = 'unknown';
  try { runtimeCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
  await writeFile(resolve(staging,'runtime.lock.json'), JSON.stringify({schemaVersion:1,runtimeContractVersion:1,runtimeCommit,runtimeHash:sha(JSON.stringify(inputs)),runtimeSourceHash:sha(JSON.stringify(inputs)),runtimeInputs:inputs,promptSourceHash:resources.sourceHash,promptRevision:resources.revision,dependencies:deps},null,2)+'\n');
  await writeFile(resolve(staging,'package.json'),JSON.stringify({name:'vela-tuning',version:'0.1.0',private:true,type:'module',engines:{node:'>=22'},scripts:{setup:'node setup.mjs',start:'node launch.mjs',verify:'node verify.mjs'},dependencies:deps},null,2)+'\n');
  // Preserve the exact already-reviewed dependency graph; no registry resolution.
  const originalLock = JSON.parse(await readFile(resolve(root,'package-lock.json'),'utf8'));
  const locked = originalLock.packages;
  const selected = {};
  function resolvePackage(name, owner = '') {
    let location = owner;
    while (true) {
      const candidate = (location ? location + '/' : '') + 'node_modules/' + name;
      if (locked[candidate] && !locked[candidate].link) return candidate;
      if (!location) break;
      const at = location.lastIndexOf('/node_modules/');
      location = at >= 0 ? location.slice(0,at) : '';
    }
  }
  function include(name, owner = '', optional = false) {
    const path = resolvePackage(name, owner);
    if (!path) { if (optional) return; throw new Error('Missing locked dependency: '+name); }
    if (selected[path]) return;
    const info = locked[path]; selected[path] = info;
    for (const [dep] of Object.entries({...info.dependencies,...info.optionalDependencies,...info.peerDependencies})) include(dep,path,!!info.optionalDependencies?.[dep] || !!info.peerDependenciesMeta?.[dep]?.optional);
  }
  for (const name of Object.keys(deps)) include(name);
  for (const [name,version] of Object.entries(deps)) if (selected['node_modules/'+name]?.version !== version) throw new Error('Installed/locked version mismatch: '+name);
  const artifactPackage = JSON.parse(await readFile(resolve(staging,'package.json'),'utf8'));
  await writeFile(resolve(staging,'package-lock.json'),JSON.stringify({name:artifactPackage.name,version:artifactPackage.version,lockfileVersion:3,requires:true,packages:{'':{name:artifactPackage.name,version:artifactPackage.version,dependencies:deps,engines:artifactPackage.engines},...selected}},null,2)+'\n');
  await writeFile(resolve(staging,'.gitignore'),'node_modules/\n.vela/\n.env\n');
  await writeFile(resolve(staging,'launch.mjs'),String.raw`import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import './verify.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const local={};
for(const line of (await readFile(new URL('./.env',import.meta.url),'utf8').catch(()=>'' )).split(/\r?\n/)){
 const match=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
 if(match)local[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'');
}
const child=spawn(process.execPath,[fileURLToPath(new URL('./runtime/server.cjs',import.meta.url))],{cwd:root,stdio:'inherit',env:{...local,...process.env,VELA_TUNING_ROOT:root}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1});
`);
  await writeFile(resolve(staging,'verify.mjs'),`import {readFile} from 'node:fs/promises';\nimport {createHash} from 'node:crypto';\nconst checks=JSON.parse(await readFile(new URL('./checksums.json',import.meta.url),'utf8'));\nfor(const [path,hash] of Object.entries(checks)){if(createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex')!==hash)throw Error('Runtime integrity mismatch: '+path);}\n`);
  await writeFile(resolve(staging,'.env.example'),'LLM_GATEWAY_URL=http://127.0.0.1:8088/v1\nLLM_GATEWAY_TOKEN=\n');
  await writeFile(resolve(staging,'setup.mjs'),String.raw`import {mkdir,writeFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import './verify.mjs';
await access(new URL('./prompts/manifest.json',import.meta.url));
await mkdir(new URL('./.vela/',import.meta.url),{recursive:true});
await writeFile(new URL('./.vela/mcp.config.json',import.meta.url),JSON.stringify({mcpServers:{vela:{command:process.execPath,args:[fileURLToPath(new URL('./launch.mjs',import.meta.url))]}}},null,2)+'\n');
console.log('MCP configuration saved to .vela/mcp.config.json');
`);
  // Mutable prompts/reports are intentionally excluded; runtime and initial case data are pinned.
  const immutable=['runtime/server.cjs','runtime/compiler.mjs','runtime.lock.json','package.json','package-lock.json','launch.mjs','verify.mjs','setup.mjs',...['catalog.json','products.json','fixed-results.json','ab-cases.json','hydrogen-regression-cases.json'].map(name=>'cases/'+name)];
  const checks={};for(const path of immutable)checks[path]=sha(await readFile(resolve(staging,path)));
  await writeFile(resolve(staging,'checksums.json'),JSON.stringify(checks,null,2)+'\n');
  await rename(staging,destination);
  console.log(relative(root,destination));
} catch(error) { await rm(staging,{recursive:true,force:true}); throw error; }
