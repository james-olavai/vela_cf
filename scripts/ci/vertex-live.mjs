import {verifyBinding} from './bind-artifact.mjs';
// Release-only paid check of candidate code + actual SDK/model; never substitutes another provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateReading } from '../../apps/api/src/generate-reading.ts';
import { defaultBundle } from '../../apps/api/src/prompt-bundle.ts';
import { accessToken, project, environmentConfig } from './google.mjs';
import {execFileSync} from 'node:child_process';
import {validateArtifact} from './artifact.mjs';
import {verifyCandidateEvidence} from './vertex-evidence.mjs';
const manifest=validateArtifact('.release',process.env.CI_COMMIT_SHA);
  verifyBinding('.release',manifest,environmentConfig);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),manifest.sha,'Candidate checkout SHA differs from artifact');
assert.deepEqual(manifest.binding,{environment:environmentConfig.environment,projectId:project,configHash:environmentConfig.configHash},'Candidate environment differs from artifact');
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {genkit}=require('genkit'), {vertexAI}=require('@genkit-ai/google-genai');
const token=await accessToken();
const ai=genkit({plugins:[vertexAI({projectId:project,location:'global',googleAuth:{authClient:{getAccessToken:async()=>({token})}}})]});
const legacy=JSON.parse(readFileSync(new URL('../../apps/api/playground-fixtures/ab-baseline.json',import.meta.url),'utf8'));
const profiles=[{name:'CI Synthetic',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',gender:'female',entityType:'person'}];
const evidence={sha:manifest.sha,codeHash:manifest.codeHash,...manifest.binding,status:'running',cases:[]};
mkdirSync('artifacts',{recursive:true});
const save=()=>writeFileSync('artifacts/vertex-live.json',JSON.stringify(evidence,null,2));
try {
for(const [name,tier,bundle] of [['current','free',defaultBundle('free')],['frozen-legacy','go',legacy]]) {
  assert.equal(bundle.modelName,'vertexai/gemini-4-hydrogen');
  const message=name==='frozen-legacy'?'请分析未来三个月事业运势，先调用 transitEvents（windowMonths=3，startDate=2026-11-01），根据结果简要给一条建议。':'请简要解读性格与职业倾向，给出一条具体建议。';
  const result=await generateReading(ai,{tier,bundle,profiles,message,signal:AbortSignal.timeout(120_000)});
  if(name==='frozen-legacy') assert(result.diagnostics.tools.includes('transitEvents'),'Transit route was not activated');
  const record={case:name,model:bundle.modelName,characters:result.text.length,rawCharacters:result.rawText.length,finishReason:result.diagnostics.finishReason,usage:result.usage,tools:result.diagnostics.calls.map(c=>c.name),parameters:result.diagnostics.parameters};
  evidence.cases.push(record);save();
  console.log('Candidate diagnostics',JSON.stringify(record));
  assert(result.text.trim().length>=30,`${name}: missing useful final answer`);
  assert(result.usage?.inputTokens>0,`${name}: missing provider usage`);
  if(name==='frozen-legacy') assert(result.diagnostics.calls.some(c=>c.name==='transitEvents'),'No real transit tool execution');

  console.log(`PASS candidate Vertex ${name}: ${result.text.length} characters`);
}
evidence.status='verified';verifyCandidateEvidence(evidence,manifest);save();
} catch(error) {evidence.status='failed';save();throw error;}
