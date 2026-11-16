import { apiError, businessApi, invalidateApi, streamApi } from './apiClient';
type Pending = {id:string;fingerprint:string};
type Turn = {id:string;status:'running'|'completed'|'failed'|'cancelled';result?:any;error?:string};
const memory = new Map<string,Pending>();
const storageKey=(uid:string,session:string)=>`vela:turn:${uid}:${session}`;
function pending(uid:string,session:string,value?:Pending):Pending|undefined {
  const key=storageKey(uid,session);
  try {
    if(value){localStorage.setItem(key,JSON.stringify(value));memory.set(key,value);return value;}
    const stored=JSON.parse(localStorage.getItem(key)||'null')||memory.get(key);
    if(stored && typeof stored.id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(stored.id) && typeof stored.fingerprint==='string' && /^[a-f0-9]{64}$/.test(stored.fingerprint))return stored;
    localStorage.removeItem(key);memory.delete(key);return;
  }catch{if(value)memory.set(key,value);return memory.get(key);}
}
function clearPending(uid:string,session:string,id:string){
  const key=storageKey(uid,session);
  try{if(JSON.parse(localStorage.getItem(key)||'null')?.id===id)localStorage.removeItem(key);}catch{/* Storage may be unavailable; clear only this in-memory turn. */}
  if(memory.get(key)?.id===id)memory.delete(key);
}
const path=(session:string,id:string)=>`/v1/sessions/${encodeURIComponent(session)}/turns/${encodeURIComponent(id)}`;
export async function pendingTurn(uid:string,session:string,signal:AbortSignal):Promise<Turn|null>{
  const entry=pending(uid,session);if(!entry)return null;
  try {const turn=await businessApi<Turn>(uid,path(session,entry.id),'GET',undefined,signal);if(turn.status!=='running')clearPending(uid,session,entry.id);return turn;}
  catch(error){if((error as any).code==='TURN_NOT_FOUND'){clearPending(uid,session,entry.id);return null;}throw error;}
}
function pause(signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1000);signal.addEventListener('abort',abort,{once:true});
});}
async function awaitTurn(uid:string,session:string,id:string,signal:AbortSignal):Promise<Turn>{
  const limit=AbortSignal.any([signal,AbortSignal.timeout(250_000)]);
  while(true){const turn=await businessApi<Turn>(uid,path(session,id),'GET',undefined,limit);if(turn.status!=='running')return turn;await pause(limit);}
}
async function cancelPending(uid:string,session:string,id:string){
  try{await businessApi(uid,`${path(session,id)}/cancel`,'POST',{},AbortSignal.timeout(5000));clearPending(uid,session,id);}
  catch{/* Retain reference for status recovery when the network returns. */}
}
export async function* streamTurn(uid:string,session:string,body:unknown,signal:AbortSignal):AsyncGenerator<any>{
  signal.throwIfAborted();
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))))).map(b=>b.toString(16).padStart(2,'0')).join('');
  let entry=pending(uid,session),recover=false;
  if(entry){
    const state=await businessApi<Turn>(uid,path(session,entry.id),'GET',undefined,signal).catch(async error=>{if(signal.aborted)await cancelPending(uid,session,entry!.id);if((error as any).code==='TURN_NOT_FOUND')return null;throw error;});
    if(state?.status==='running' && entry.fingerprint!==fingerprint)throw new Error('上一条请求仍在处理中，请等待结果后再发送');
    recover=entry.fingerprint===fingerprint && !!state && ['running','completed'].includes(state.status);
  }
  if(!recover)entry={id:crypto.randomUUID(),fingerprint};
  const turnId=entry!.id;pending(uid,session,entry!);
  try{
    if(!recover){
      try {for await(const event of streamApi(uid,`/v1/sessions/${encodeURIComponent(session)}/turns`,body,signal,turnId))yield event;clearPending(uid,session,turnId);return;}
      catch(error){if(signal.aborted)throw error;/* An uncertain transport result is resolved by a read, never by another generation. */
        const state=await businessApi<Turn>(uid,path(session,turnId),'GET',undefined,signal).catch(recoveryError=>{if((recoveryError as any).code==='TURN_NOT_FOUND'){clearPending(uid,session,turnId);throw error;}throw recoveryError;});
        if(state.status==='failed'||state.status==='cancelled'){clearPending(uid,session,turnId);throw error;}
      }
    }
    const turn=await awaitTurn(uid,session,turnId,signal);
    if(turn.status!=='completed'){clearPending(uid,session,turnId);throw apiError({code:turn.error,message:turn.error});}
    if(typeof turn.result?.text!=='string'||!turn.result.text.trim())throw new Error('恢复的生成结果不完整');
    clearPending(uid,session,turnId);
    yield {type:'done',suggestions:turn.result.suggestions};yield {type:'result',result:turn.result};
  }finally{
    if(signal.aborted)await cancelPending(uid,session,turnId);
    invalidateApi();
  }
}
