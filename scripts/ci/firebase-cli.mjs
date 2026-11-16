import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
export function firebaseCliEnvironment(directory,environment=process.env) {
  assert(environment.GOOGLE_APPLICATION_CREDENTIALS,'Firebase CLI requires explicit ADC credentials');
  const env={...environment,XDG_CONFIG_HOME:resolve(directory),GOOGLE_APPLICATION_CREDENTIALS:resolve(environment.GOOGLE_APPLICATION_CREDENTIALS),CLOUDSDK_CONFIG:environment.CLOUDSDK_CONFIG||join(homedir(),'.config','gcloud')};
  delete env.FIREBASE_TOKEN;
  return env;
}
export async function runFirebaseCli(args) {
  const directory=mkdtempSync(join(tmpdir(),'vela-firebase-release-'));
  try {
    const child=spawn('npx',args,{stdio:'inherit',env:firebaseCliEnvironment(directory)});
    const [code]=await once(child,'exit');
    assert.equal(code,0,`Firebase CLI failed: ${args[2]}`);
  } finally {rmSync(directory,{recursive:true,force:true});}
}
