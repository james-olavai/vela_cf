import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
export const TurnResultSchema=z.object({text:z.string().trim().min(1),suggestions:z.array(z.string()),uiBlocks:z.array(z.unknown())});
export const TurnSchema = z.object({id:z.string(),status:z.enum(['running','completed','failed','cancelled']),createdAt:z.string(),expiresAt:z.number(),result:TurnResultSchema.optional(),error:z.string().optional()});
export const turnRoutes = [
  {method:'GET',path:'/v1/sessions/{id}/turns/{turnId}',operationId:'getTurn',status:200,response:TurnSchema},
  {method:'POST',path:'/v1/sessions/{id}/turns/{turnId}/cancel',operationId:'cancelTurn',status:200,body:z.object({}).strict(),response:TurnSchema},
];
export const turnRef = (db:Firestore,uid:string,session:string,id:string) => db.doc(`users/${uid}/sessions/${session}/turns/${id}`);
export async function beginTurn(db:Firestore,uid:string,session:string,id:string,input:unknown) {
  const ref=turnRef(db,uid,session,id),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.runTransaction(async tx=>{
    const parent=await tx.get(ref.parent.parent!),snap=await tx.get(ref);
    if(!parent.exists)throw new HttpsError('not-found','SESSION_NOT_FOUND');
    if(snap.exists){const data=snap.data()!;if(data.hash!==hash)throw new HttpsError('already-exists','IDEMPOTENCY_CONFLICT');if(data.status==='running'&&data.expiresAt<=Date.now()){Object.assign(data,{status:'failed',error:'TURN_INTERRUPTED'});tx.update(ref,{status:data.status,error:data.error});}return data;}
    tx.create(ref,{id,hash,status:'running',createdAt:new Date().toISOString(),expiresAt:Date.now()+240_000});
    return null;
  });
}
export async function failTurn(db:Firestore,uid:string,session:string,id:string,error:string) {
  const ref=turnRef(db,uid,session,id);
  await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.data()?.status==='running')tx.update(ref,{status:error==='TURN_CANCELLED'?'cancelled':'failed',error});});
}
export async function dispatchTurnApi(db:Firestore,input:{method:string;path:string;body:unknown;auth:{uid:string}}) {
  const match=/^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/turns\/([A-Za-z0-9_-]{1,128})(\/cancel)?$/.exec(input.path);
  if(!match || !((input.method==='GET'&&!match[3])||(input.method==='POST'&&match[3])))throw new HttpsError('not-found','ROUTE_NOT_FOUND');
  if(match[3])z.object({}).strict().parse(input.body);
  const ref=turnRef(db,input.auth.uid,match[1],match[2]);
  return db.runTransaction(async tx=>{
    const parent=await tx.get(ref.parent.parent!),snap=await tx.get(ref);if(!parent.exists || !snap.exists)throw new HttpsError('not-found','TURN_NOT_FOUND');
    const data=snap.data()!;
    if(data.status==='running'&&(match[3]||data.expiresAt<=Date.now())){
      Object.assign(data,{status:match[3]?'cancelled':'failed',error:match[3]?'TURN_CANCELLED':'TURN_INTERRUPTED'});tx.update(ref,{status:data.status,error:data.error});
    }
    return {status:200,body:TurnSchema.parse(data)};
  });
}
