import { getToken } from 'firebase/app-check';
import { auth, appCheck } from './firebase';
import config from '../../../../firebase-applet-config.json';

const baseUrl = import.meta.env.DEV && import.meta.env.VITE_API_BASE_URL || `https://asia-southeast1-${config.projectId}.cloudfunctions.net/businessApi`;
const updates = new EventTarget();
export const invalidateApi = () => updates.dispatchEvent(new Event('change'));
export function apiError(value: any): Error {
  return Object.assign(new Error(value?.message || '请求失败，请稍后重试'), { code: value?.code, requestId: value?.requestId });
}
async function request(uid: string | null, path: string, method: string, body: unknown, signal?: AbortSignal, stream = false, key?: string) {
  const user = auth.currentUser;
  if (uid && (!user || user.uid !== uid)) throw new Error('登录状态已改变，请重新登录后重试');
  const headers: Record<string, string> = { Accept: stream ? 'text/event-stream' : 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
  if (appCheck) headers['X-Firebase-AppCheck'] = (await getToken(appCheck)).token;
  if (auth.currentUser !== user) throw new Error('登录状态已改变，请重新登录后重试');
  const response = await fetch(`${baseUrl}${path}`, { method, headers, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(stream ? 180_000 : 30_000)]) : AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw apiError((await response.json()).error);
  return response;
}
export async function businessApi<T = unknown>(uid: string | null, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(uid, path, method, body, signal);
  const result = response.status === 204 ? undefined : await response.json();
  if (method !== 'GET') invalidateApi();
  return result as T;
}
export async function apiList<T>(uid: string, path: string, signal: AbortSignal): Promise<T[]> {
  const all: T[] = [], seen = new Set<string>(); let cursor: string | null = null;
  do {
    const page: {items:T[];nextCursor:string|null} = await businessApi(uid, `${path}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal);
    all.push(...page.items); cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('分页游标重复');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return all;
}
export function subscribeApi<T>(load: (signal: AbortSignal) => Promise<T>, onData: (value:T)=>boolean|void, onError: (error:unknown)=>void): () => void {
  let stopped=false, timer: ReturnType<typeof setTimeout> | undefined, controller:AbortController | undefined, generation=0, previous='';
  const refresh=()=>{
    clearTimeout(timer); controller?.abort(); const run=++generation;
    if(stopped || document.hidden) return;
    controller=new AbortController();
    void load(controller.signal).then(value=>{
      if(stopped || run!==generation) return;
      const serialized=JSON.stringify(value); if(serialized!==previous && onData(value)!==false)previous=serialized;
    }).catch(error=>{if(!stopped && run===generation && !controller?.signal.aborted){previous='';onError(error);}}).finally(()=>{
      if(!stopped && run===generation)timer=setTimeout(refresh,5000);
    });
  };
  document.addEventListener('visibilitychange',refresh);updates.addEventListener('change',refresh);refresh();
  return ()=>{stopped=true;++generation;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',refresh);updates.removeEventListener('change',refresh);};
}
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try {
    while(true){
      signal.throwIfAborted();const {value,done}=await reader.read();signal.throwIfAborted();
      buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      let end;
      while((end=buffer.search(/\r?\n\r?\n/))>=0){
        const block=buffer.slice(0,end);buffer=buffer.slice(end+(buffer.startsWith('\r\n\r\n',end)?4:2));
        const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
        if(data)yield JSON.parse(data);
      }
      if(done){if(buffer.trim())throw new Error('流式响应不完整');break;}
    }
  }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function* streamApi(uid:string,path:string,body:unknown,signal:AbortSignal,key?:string):AsyncGenerator<any>{
  const response=await request(uid,path,'POST',body,signal,true,key);
  if(!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('流式响应格式有误');
  let completed=false,finished=false;
  try{for await(const event of readSse(response.body,signal)){
    if(event.type==='error')throw apiError(event.error || event);
    if(event.type==='done')completed=true;
    if(event.type==='result'){if(!completed || typeof event.result?.text!=='string' || !event.result.text.trim())throw new Error('生成结果不完整');finished=true;}
    yield event;
  }
  if(!finished)throw new Error('生成中断，请重新加载消息');
  }finally{invalidateApi();}
}
