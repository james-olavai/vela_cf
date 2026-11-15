import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { reserveQuota, releaseQuota, settleQuota } from './quota.js';
const project = 'demo-vela-ci';
const host = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!host?.startsWith('127.0.0.1:') || !authHost?.startsWith('127.0.0.1:')) throw new Error('Rules tests require local Firestore + Auth emulators; production is forbidden');
const root = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const app = initializeApp({ projectId: project }, 'rules-tests');
const db = getFirestore(app);
async function account() {
  const res = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200); return res.json() as Promise<{ localId: string; idToken: string }>;
}
const fields = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([k,v]) => [k, typeof v === 'string' ? { stringValue:v } : typeof v === 'boolean' ? { booleanValue:v } : { integerValue:String(v) }]));
async function request(token: string, path: string, data?: Record<string, unknown>) {
  return fetch(`${root}/${path}`, { method: data ? 'PATCH' : 'GET', headers: { ...(token?{Authorization:`Bearer ${token}`} : {}), 'Content-Type':'application/json' }, ...(data ? { body:JSON.stringify({fields:fields(data)}) } : {}) });
}
test('Real Rules engine enforces ownership, immutable quota privileges, sharing dates, and server-only messages', async () => {
  const a = await account(), b = await account();
  const uid = a.localId;
  try {
    const profile = { name:'Synthetic',birthDateTime:'1994-06-03T08:20',locationName:'上海',latitude:31,longitude:121,timezone:'Asia/Shanghai',gender:'female' };
    assert.equal((await request(a.idToken, `users/${uid}/profiles/p`, profile)).status,200);
    assert.equal((await request(b.idToken, `users/${uid}/profiles/p`)).status,403);
    assert.equal((await request('', `users/${uid}/profiles/p`)).status,403);
    const now = new Date(), today = now.toISOString().slice(0,10), period = today.slice(0,7)+'-01T00:00:00Z';
    const bonus = { periodStart:period,used:0,bonusMicroUsd:30000,shareCount:1,lastShareDate:today };
    assert.equal((await request(a.idToken, `usage/${uid}`, { ...bonus,lastShareDate:'2099-01-01' })).status,403);
    assert.equal((await request(a.idToken, `usage/${uid}`, bonus)).status,200);
    assert.equal((await request(a.idToken, `usage/${uid}`, { ...bonus,unlimited:true,overrideTier:'pro' })).status,403);
    assert.equal((await request(a.idToken, `usage/${uid}`, { ...bonus,used:-1 })).status,403);
    assert.equal((await request(a.idToken, `usage/${uid}`, { ...bonus,shareCount:2,bonusMicroUsd:60000 })).status,403);
    await db.doc(`users/${uid}/sessions/s`).set({mode:'personal'});
    await db.doc(`users/${uid}/sessions/s/messages/m`).set({role:'assistant'});
    await db.doc(`users/${uid}/sessions/s/private/prompt`).set({test:true});
    assert.equal((await request(a.idToken, `users/${uid}/sessions/s/messages/m`)).status,200);
    assert.equal((await request(b.idToken, `users/${uid}/sessions/s/messages/m`)).status,403);
    assert.equal((await request(a.idToken, `users/${uid}/sessions/s/messages/m`, {role:'assistant'})).status,403);
    assert.equal((await request(a.idToken, `users/${uid}/sessions/s/private/prompt`)).status,403);
    assert.equal((await request(a.idToken, `users/${uid}/sessions/new`, {mode:'personal'})).status,403);
    assert.equal((await request(a.idToken, 'locations_cache/private')).status,403);
  } finally { await db.recursiveDelete(db.doc(`users/${uid}`)); await db.doc(`usage/${uid}`).delete(); }
});
test('Real Firestore transactions reserve atomically and retain unlimited overrides across rollover', async () => {
  const uid='quota_real', periodStart='2026-11-01T00:00:00Z', now=new Date('2026-11-15T10:00:00Z');
  try {
    await db.doc(`usage/${uid}`).set({periodStart,used:0});
    const results=await Promise.allSettled(Array.from({length:5},(_,i)=>reserveQuota(db,{uid,tier:'free',periodStart,unlimited:false,requestId:`r${i}`,now})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
    assert.equal(results.filter(r=>r.status==='rejected').length,2);
    for(let i=0;i<5;i++) await releaseQuota(db,{uid,requestId:`r${i}`,now});
    await db.doc(`usage/${uid}`).set({periodStart,used:999999999,unlimited:true,overrideTier:'pro'});
    const next='2026-12-01T00:00:00Z';
    await reserveQuota(db,{uid,tier:'pro',periodStart:next,unlimited:true,requestId:'unlimited',now});
    await settleQuota(db,{uid,periodStart:next,requestId:'unlimited',costMicroUsd:30000,now});
    const data=(await db.doc(`usage/${uid}`).get()).data();
    assert.equal(data?.unlimited,true); assert.equal(data?.overrideTier,'pro'); assert.equal(data?.used,30000);
  } finally { await db.doc(`usage/${uid}`).delete(); await deleteApp(app); }
});
