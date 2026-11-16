import assert from 'node:assert/strict';
export function verifyCandidateEvidence(evidence, manifest) {
  assert.equal(evidence?.status,'verified','Candidate Vertex verification did not pass');
  for(const [key,value] of Object.entries({sha:manifest.sha,codeHash:manifest.codeHash,...manifest.binding}))assert.equal(evidence[key],value,`Candidate Vertex ${key} mismatch`);
  assert.deepEqual(evidence.cases?.map(item=>item.case),['current','frozen-legacy'],'Candidate cases missing or duplicated');
  for(const item of evidence.cases)assert(item.characters>=30 && item.usage?.inputTokens>0 && item.model==='vertexai/gemini-4-hydrogen','Invalid candidate response evidence');
  assert(evidence.cases[1].tools?.includes('transitEvents'),'Candidate legacy transit tool did not execute');
}
