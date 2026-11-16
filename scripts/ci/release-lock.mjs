import assert from 'node:assert/strict';
// Firestore compare-and-set also protects Gitea versions that ignore concurrency.
export async function releaseLock(root,owner,sha,action,{request,now=Date.now}={}) {
  assert(typeof owner==='string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(owner),'Explicit release owner required');
  assert(/^[a-f0-9]{40}$/.test(sha),'Invalid release SHA');
  assert(['acquire','check','release'].includes(action),'Invalid release lock operation');
  const name=`${root}/releaseLocks/pipeline`;let current;
  try{current=await request(name);}catch(error){if(!String(error.message).startsWith('Google API 404:'))throw error;}
  const fields=current?.fields;
  const owns=fields?.owner?.stringValue===owner && fields?.sha?.stringValue===sha;
  if(action==='check'){assert(owns && Number(fields.expiresAtMs.integerValue)>now(),'Release lock lost or expired');return;}
  if(action==='release'){
    assert(owns,'Refusing to release another pipeline lock');
    await request(root+':commit',{method:'POST',body:{writes:[{delete:name.replace('https://firestore.googleapis.com/v1/',''),currentDocument:{updateTime:current.updateTime}}]}});return;
  }
  assert(!current || Number(fields?.expiresAtMs?.integerValue)<=now(),'Another release owns this environment');
  const expiresAtMs=now()+2*60*60_000;
  await request(root+':commit',{method:'POST',body:{writes:[{update:{name:name.replace('https://firestore.googleapis.com/v1/',''),fields:{owner:{stringValue:owner},sha:{stringValue:sha},expiresAtMs:{integerValue:String(expiresAtMs)}}},currentDocument:current?{updateTime:current.updateTime}:{exists:false}}]}});
}
