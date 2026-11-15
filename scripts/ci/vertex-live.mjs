// Release-only paid check of candidate code + actual SDK/model; never substitutes another provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateReading } from '../../apps/api/src/generate-reading.ts';
import { defaultBundle } from '../../apps/api/src/prompt-bundle.ts';
import { accessToken, project } from './google.mjs';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {genkit}=require('genkit'), {vertexAI}=require('@genkit-ai/google-genai');
const token=await accessToken();
const ai=genkit({plugins:[vertexAI({projectId:project,location:'global',googleAuth:{authClient:{getAccessToken:async()=>({token})}}})]});
const legacy=JSON.parse(readFileSync(new URL('../../apps/api/playground-fixtures/ab-baseline.json',import.meta.url),'utf8'));
const profiles=[{name:'CI Synthetic',birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',gender:'female',entityType:'person'}];
const evidence=[];
mkdirSync('artifacts',{recursive:true});
const save=()=>writeFileSync('artifacts/vertex-live.json',JSON.stringify(evidence,null,2));
for(const [name,tier,bundle] of [['current','free',defaultBundle('free')],['frozen-legacy','go',legacy]]) {
  assert.equal(bundle.modelName,'vertexai/gemini-4-hydrogen');
  const result=await generateReading(ai,{tier,bundle,profiles,message:'请简要解读性格与职业倾向，给出一条具体建议。',signal:AbortSignal.timeout(120_000)});
  const record={case:name,model:bundle.modelName,characters:result.text.length,rawCharacters:result.rawText.length,usage:result.usage,parameters:result.diagnostics.parameters};
  evidence.push(record);save();
  console.log('Candidate diagnostics',JSON.stringify(record));
  assert(result.text.trim().length>=30,`${name}: missing useful final answer`);
  assert(result.usage?.inputTokens>0,`${name}: missing provider usage`);

  console.log(`PASS candidate Vertex ${name}: ${result.text.length} characters`);
}
save();
