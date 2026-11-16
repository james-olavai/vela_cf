// Builds a standalone, precompiled Functions package with the dependency versions tested by CI.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { config } from './google.mjs';
const out=resolve('.release');rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const pkg=read('apps/api/package.json'), lock=read('package-lock.json');
const require=createRequire(resolve('apps/api/package.json'));
for(const name of Object.keys(pkg.dependencies)) {
  const dir=require.resolve.paths(name).map(base=>resolve(base,name)).find(base=>existsSync(resolve(base,'package.json')));
  assert(dir,`Cannot resolve package ${name}`);
  pkg.dependencies[name]=read(resolve(dir,'package.json')).version;
}
delete pkg.devDependencies;delete pkg.scripts;
mkdirSync(resolve(out,'api/dist'),{recursive:true});
cpSync('apps/api/dist/index.cjs',resolve(out,'api/dist/index.cjs'));
writeFileSync(resolve(out,'api/package.json'),JSON.stringify(pkg,null,2));
const packages={'':pkg};
for(const [path,entry] of Object.entries(lock.packages)) if(path.startsWith('node_modules/')&&!entry.link) packages[path]=entry;
for(const [path,entry] of Object.entries(lock.packages)) if(path.startsWith('apps/api/node_modules/')&&!entry.link) packages[path.slice('apps/api/'.length)]=entry;
writeFileSync(resolve(out,'api/package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages},null,2));
execFileSync('npm',['prune','--package-lock-only','--omit=dev','--ignore-scripts','--prefix',resolve(out,'api')],{stdio:'inherit'});
const known=new Set(Object.values(lock.packages).filter(x=>x.version).map(x=>`${x.version}|${x.integrity||''}`));
for(const [path,entry] of Object.entries(read(resolve(out,'api/package-lock.json')).packages)) if(path) assert(known.has(`${entry.version}|${entry.integrity||''}`),`Release resolved an untested dependency: ${path}@${entry.version}`);
cpSync('apps/web/dist',resolve(out,'web'),{recursive:true});
cpSync('docs/openapi.json',resolve(out,'openapi.json'));
cpSync('firestore.rules',resolve(out,'firestore.rules'));
const fb=read('firebase.json');
writeFileSync(resolve(out,'firebase.json'),JSON.stringify({functions:[{source:'api',codebase:'default',runtime:'nodejs22'}],hosting:{...fb.hosting,public:'web'},firestore:{database:config.firestoreDatabaseId,rules:'firestore.rules'}},null,2));
const functionInventory=read('scripts/ci/functions.json');
const declared=[...readFileSync('apps/api/src/index.ts','utf8').matchAll(/export const (\w+) = (?:onCall|onCallGenkit|onRequest)\(/g)].map(m=>m[1]).sort();
assert.deepEqual([...functionInventory.existing,...functionInventory.introduced].sort(),declared,'Function inventory does not match source exports');
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const rollbackCapabilities=['profile-location-metadata'], requiredRollbackCapabilities=[];
writeFileSync(resolve(out,'web/version.json'),JSON.stringify({sha,rollbackCapabilities}));
const hashes={};
function hashFiles(dir='') {
  for(const entry of readdirSync(resolve(out,dir),{withFileTypes:true})) {
    const path=dir?`${dir}/${entry.name}`:entry.name;
    if(entry.isDirectory()) hashFiles(path);
    else { assert(entry.isFile(),`Unexpected release file: ${path}`); hashes[path]=createHash('sha256').update(readFileSync(resolve(out,path))).digest('hex'); }
  }
}
hashFiles();
writeFileSync(resolve(out,'manifest.json'),JSON.stringify({sha,rollbackCapabilities,requiredRollbackCapabilities,node:process.version,functionInventory,openApiHash:hashes['openapi.json'],runtimeDependencies:pkg.dependencies,hashes},null,2));
execFileSync('tar',['-czf','release.tar.gz','-C',out,'.']);
console.log(`Prepared immutable release ${sha}`);
