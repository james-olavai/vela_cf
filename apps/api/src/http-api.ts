import { ChatBody } from './chat-http.js';
import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Request, Response } from 'express';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';

export async function verifyApiIdentity(auth: Auth, raw: string): Promise<DecodedIdToken> {
  const decoded = await auth.verifyIdToken(raw, true);
  const user = await auth.getUser(decoded.uid);
  return {...decoded, stripeRole:['go','pro'].includes(user.customClaims?.stripeRole) ? user.customClaims!.stripeRole : 'free', tuningEditor:user.customClaims?.tuningEditor === true, tuningPublisher:user.customClaims?.tuningPublisher === true};
}
type Dependencies = {
  verifyToken: (token: string) => Promise<DecodedIdToken>;
  stream?: (body: unknown, auth: {uid:string;token:DecodedIdToken;turnId?:string}, emit:(event:unknown)=>void, signal:AbortSignal) => Promise<unknown>;
  publicRoute?: (method:string,path:string)=>boolean;
  verifyAppCheck?: (token: string) => Promise<unknown>;
  dispatch: (input: { method: string; path: string; query: Record<string, unknown>; body: unknown; auth: { uid: string; token: DecodedIdToken } }) => Promise<{ status: number; body?: unknown }>;
};
const statuses: Record<string, number> = { 'invalid-argument':400, unauthenticated:401, 'permission-denied':403, 'not-found':404, 'already-exists':409, aborted:409, 'failed-precondition':412, 'resource-exhausted':429, unavailable:503, 'deadline-exceeded':504 };
export function createHttpApi(deps: Dependencies) {
  return async (req: Request, res: Response): Promise<void> => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
      const guest = !req.headers.authorization && deps.publicRoute?.(req.method,req.path);
      if (!match && !guest) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
      let token: DecodedIdToken;
      try { token = guest ? {uid:''} as DecodedIdToken : await deps.verifyToken(match![1]); }
      catch { throw new HttpsError('unauthenticated', 'INVALID_TOKEN'); }
      if (deps.verifyAppCheck) {
        const appToken = req.get('X-Firebase-AppCheck');
        if (!appToken) throw new HttpsError('unauthenticated', 'APP_CHECK_REQUIRED');
        try { await deps.verifyAppCheck(appToken); }
        catch { throw new HttpsError('unauthenticated', 'INVALID_APP_CHECK'); }
      }
      if (['POST','PATCH','PUT'].includes(req.method) && !req.is('application/json')) throw new HttpsError('invalid-argument', 'JSON_REQUIRED');
      const chat = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/turns$/.exec(req.path);
      if(req.method === 'POST' && chat && deps.stream) {
        const key=req.get('Idempotency-Key') || randomUUID();
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new HttpsError('invalid-argument','INVALID_IDEMPOTENCY_KEY');
        const body={...ChatBody.parse(req.body),sessionId:chat[1]};
        const controller=new AbortController();
        const close=()=>{if(!res.writableEnded)controller.abort();};
        res.on('close',close);
        const emit=(event:unknown)=>{if(!res.destroyed) { if(!res.headersSent){res.setHeader('Content-Type','text/event-stream');res.setHeader('X-Accel-Buffering','no');} res.write(`data: ${JSON.stringify(event)}\n\n`); }};
        try {const result=await deps.stream(body,{uid:token.uid,token,turnId:key},emit,controller.signal);emit({type:'result',result});res.end();}
        finally {res.removeListener('close',close);}
        return;
      }
      const result = await deps.dispatch({method:req.method,path:req.path,query:req.query,body:req.body,auth:{uid:token.uid,token}});
      if (req.method === 'GET' && result.status === 200 && /^\/v1\/(locations\/catalog|country-charts(?:\/[A-Za-z0-9_-]+)?)$/.test(req.path)) {
        const etag = `"${createHash('sha256').update(JSON.stringify(result.body)).digest('hex')}"`;
        res.setHeader('ETag', etag); res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Request-Id');
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        if (String(req.get('If-None-Match') || '').split(',').some(tag => tag.trim().replace(/^W\//,'') === etag || tag.trim() === '*')) {res.status(304).end();return;}
      }
      if (result.status === 204) res.status(204).end();
      else res.status(result.status).json(result.body);
    } catch (error) {
      const known = error instanceof HttpsError;
      const status = error instanceof ZodError ? 400 : known ? statuses[error.code] || 500 : 500;
      const code = error instanceof ZodError ? 'INVALID_REQUEST' : known && error.code === 'resource-exhausted' ? (['QUOTA_EXCEEDED','PROFILE_LIMIT_REACHED','MONTHLY_SHARE_LIMIT_REACHED'].includes(error.message) ? error.message : 'MODEL_BUSY') : known && (status < 500 || error.message === 'LOCATION_PROVIDER_UNAVAILABLE') && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : 'INTERNAL_ERROR';
      if (status >= 500) console.error('Business API failed', {requestId,code:known ? error.code : 'internal'});
      const result={error:{code,message:code,requestId,retryable:(status===429 && !['QUOTA_EXCEEDED','PROFILE_LIMIT_REACHED','MONTHLY_SHARE_LIMIT_REACHED'].includes(code)) || status===503 || status===504}};
      if(res.headersSent) {if(!res.destroyed)res.end(`data: ${JSON.stringify({type:'error',...result})}\n\n`);}
      else res.status(status).json(result);
    }
  };
}
