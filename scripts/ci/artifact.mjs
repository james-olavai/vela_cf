import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {hash} from './environments.mjs';
export function artifactHashes(directory) {
  const root=resolve(directory), hashes={};
  const scan=(dir='')=>{for(const entry of readdirSync(resolve(root,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=dir?`${dir}/${entry.name}`:entry.name;
    if(entry.isDirectory())scan(path);else{assert(entry.isFile(),'Release symlinks are forbidden');if(path!=='manifest.json')hashes[path]=hash(readFileSync(resolve(root,path)));}
  }};
  scan();return hashes;
}
export function validateArtifact(directory,sha) {
  const root=resolve(directory),manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
  assert.equal(manifest.sha,sha,'Artifact commit does not match CI commit');
  const actual=artifactHashes(root);
  assert.deepEqual(Object.keys(actual).sort(),Object.keys(manifest.hashes).sort(),'Artifact inventory changed');
  for(const [path,value] of Object.entries(manifest.hashes)){
    assert(resolve(root,path).startsWith(root+sep),'Invalid release path');
    assert.equal(actual[path],value,`Artifact was modified: ${path}`);
  }
  const generated=['web/runtime-config.js','web/version.json',...(manifest.binding?['firebase.json','environment.json',`api/.env.${manifest.binding.projectId}`]:[])];
  const code=Object.fromEntries(Object.entries(actual).filter(([path])=>!generated.includes(path)).sort(([a],[b])=>a.localeCompare(b)));
  assert.deepEqual(manifest.codeHashes,code,'Immutable code inventory changed');
  assert.equal(manifest.codeHash,hash(code),'Immutable code identity changed');
  return manifest;
}
export function codeIdentity(hashes) {
  const code=Object.fromEntries(Object.entries(hashes).filter(([path])=>!['web/runtime-config.js','web/version.json'].includes(path)).sort(([a],[b])=>a.localeCompare(b)));
  return {codeHashes:code,codeHash:hash(code)};
}

// A manifest SHA must identify the exact reviewed source, including newly added files.
export function assertCleanSource(cwd=process.cwd()) {
  const status=execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd,encoding:'utf8'});
  assert.equal(status.trim(),'','Release preparation requires a clean Git worktree; commit reviewed source before building the candidate');
  return execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
}
