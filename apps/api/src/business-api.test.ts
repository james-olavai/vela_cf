import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import { dispatchBusinessApi } from './business-api.js';

function database() {
  const store = new Map<string, any>(); let sequence = 0;
  const snap = (path: string) => ({ id: path.split('/').at(-1)!, exists: store.has(path), data: () => store.get(path) });
  const doc = (path: string): any => ({
    id: path.split('/').at(-1), path, collection: (name: string) => collection(`${path}/${name}`), get: async () => snap(path),
    create: async (data: any) => { assert(!store.has(path)); store.set(path, data); },
    set: async (data: any) => store.set(path, data), delete: async () => store.delete(path),
  });
  const collection = (path: string): any => {
    let max = Infinity, cursor = '';
    const query = { doc: (id = `p${++sequence}`) => doc(`${path}/${id}`), orderBy: () => query,
      limit: (n: number) => { max = n; return query; }, startAfter: (id: string) => { cursor = id; return query; },
      get: async () => ({ docs: [...store.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).sort().filter(k => k.split('/').at(-1)! > cursor).slice(0,max).map(snap) }) };
    return query;
  };
  const db = { collection, runTransaction: async (fn: any) => fn({ get: (ref: any) => ref.get(), create: (ref: any, data: any) => {assert(!store.has(ref.path));store.set(ref.path,data);}, delete: (ref:any) => store.delete(ref.path), set: (ref: any, data: any, opts: any) => store.set(ref.path, opts?.merge ? { ...store.get(ref.path), ...data } : data) }) } as unknown as Firestore;
  return { db, store };
}
const auth = { uid: 'alice', token: { email: 'a@example.test', name: 'Alice' } };
const profile = { name: 'Alice', birthDateTime: '1994-06-03T08:20', locationName: 'Shanghai', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' };
const request = (db: Firestore, method: string, path: string, body?: unknown, query?: unknown) => dispatchBusinessApi(db, { auth, method, path, body, query });

test('business API rejects unauthenticated access and identity/privilege injection', async () => {
  const { db, store } = database();
  await assert.rejects(() => dispatchBusinessApi(db, { method: 'GET', path: '/v1/profiles' }), /AUTH_REQUIRED/);
  await assert.rejects(() => request(db, 'POST', '/v1/profiles', { ...profile, uid: 'bob' }));
  await assert.rejects(() => request(db, 'PATCH', '/v1/me', { unlimited: true }));
  await assert.rejects(() => request(db, 'POST', '/v1/sessions', { profileIds: ['../bob'], mode: 'personal' }));
  await assert.rejects(() => request(db, 'GET', '/v1/profiles', undefined, { cursor: '../bob' }));
  assert.equal(store.size, 0);
});

test('profile CRUD preserves omitted fields, rejects extra fields, scopes IDs to verified user', async () => {
  const { db, store } = database();
  const created = await request(db, 'POST', '/v1/profiles', { ...profile, entityType: 'company', gender: 'female' });
  assert.equal(created.status, 201); const id = (created.body as any).id;
  const changed = await request(db, 'PATCH', `/v1/profiles/${id}`, { name: 'New name' });
  assert.equal((changed.body as any).timezone, profile.timezone);
  assert.equal((changed.body as any).gender, 'female');
  assert.equal((changed.body as any).entityType, 'company');
  await assert.rejects(() => request(db, 'PATCH', `/v1/profiles/${id}`, {}));
  await assert.rejects(() => request(db, 'PATCH', `/v1/profiles/${id}`, { createdAt: 'fake' }));
  store.set('users/bob/profiles/secret', { ...profile });
  await assert.rejects(() => request(db, 'GET', '/v1/profiles/secret'), /RESOURCE_NOT_FOUND/);
  await request(db, 'DELETE', '/v1/profiles/secret'); assert(store.has('users/bob/profiles/secret'));
  await request(db, 'DELETE', `/v1/profiles/${id}`); assert(!store.has(`users/alice/profiles/${id}`));
});

test('profile pages bound results and expose a usable continuation without leaking other owners', async () => {
  const { db, store } = database();
  store.set('usage/alice',{overrideTier:'go'});
  for (let n = 0; n < 3; n++) await request(db, 'POST', '/v1/profiles', profile);
  store.set('users/bob/profiles/extra', profile);
  const one = (await request(db, 'GET', '/v1/profiles', undefined, { limit: '2' })).body as any;
  const two = (await request(db, 'GET', '/v1/profiles', undefined, { limit: '2', cursor: one.nextCursor })).body as any;
  assert.equal(one.items.length, 2); assert.equal(two.items.length, 1); assert.equal(two.nextCursor, null);
  assert.equal(new Set([...one.items, ...two.items].map(x => x.id)).size, 3);
  for (const limit of ['0','51','-1','1.5','999999']) await assert.rejects(() => request(db, 'GET', '/v1/profiles', undefined, { limit }));
});

test('me initialization requires explicit consent, trusted identity and preserves first consent', async () => {
  const { db, store } = database();
  await assert.rejects(() => request(db, 'PATCH', '/v1/me', { displayName: 'A' }), /CONSENT_REQUIRED/);
  const first = (await request(db, 'PATCH', '/v1/me', { acceptedTerms: true, confirmedAdult: true })).body as any;
  const second = (await request(db, 'PATCH', '/v1/me', { displayName: 'B' })).body as any;
  assert.equal(second.acceptedTermsAt, first.acceptedTermsAt); assert.equal(second.email, auth.token.email);
  assert.equal(store.get('users/alice').displayName, 'B');
  await assert.rejects(() => request(db, 'PATCH', '/v1/me', { email: 'attacker@example.test' }));
});

test('session responses strip frozen prompt/config and messages require owned session', async () => {
  const { db, store } = database();
  store.set('users/alice/sessions/s1', { mode: 'personal', profileIds: ['p1'], profileId: 'p1', profileName: 'A', title: 'T', createdAt: 'now', updatedAt: 'now', frozenPrompt: 'secret', frozenModel: 'internal', frozenTools: [], activeTurnId: 'hidden', frozenSubjects: [{ref:'self',profileId:'p1',profile:{...profile,gender:'female',entityType:'person',locationRef:{id:'geonames-1796236',version:'1'},countryCode:'CN',locationSource:'builtin'}}] });
  const result = (await request(db, 'GET', '/v1/sessions/s1')).body as any;
  assert(!('frozenPrompt' in result)); assert(!('activeTurnId' in result));
  assert.equal(result.subjects[0].profile.countryCode,'CN'); assert.equal(result.subjects[0].profile.locationSource,'builtin');
  assert.deepEqual(result.subjects[0].profile.locationRef,{id:'geonames-1796236',version:'1'});
  assert.equal(result.subjects[0].profile.name,profile.name);assert(!('frozenSubjects' in result));
  const listed=(await request(db,'GET','/v1/sessions')).body as any;assert.equal(listed.items[0].subjects[0].ref,'self');
  store.set('users/bob/sessions/s2/messages/m1', { role: 'user', parts: [], createdAt: 'now' });
  await assert.rejects(() => request(db, 'GET', '/v1/sessions/s2/messages'), /RESOURCE_NOT_FOUND/);
  assert.deepEqual((await request(db, 'GET', '/v1/sessions/s1/messages')).body, { items: [], nextCursor: null });
});

test('usage resets stale counters but preserves server-controlled unlimited tier override', async () => {
  const { db, store } = database();
  store.set('usage/alice', { periodStart: '2000-01-01T00:00:00Z', used: 99999, bonusMicroUsd: 90000, shareCount: 3, unlimited: true, overrideTier: 'pro', reservations: { private: 'secret' } });
  const usage = (await request(db, 'GET', '/v1/me/usage')).body as any;
  assert.equal(usage.used, 0); assert.equal(usage.bonusMicroUsd, 0); assert.equal(usage.unlimited, true); assert.equal(usage.tier, 'pro');
  assert.equal(usage.budgetMicroUsd, 6500000); assert(!('reservations' in usage));
});

test('real Firestore API pagination uses chronological snapshots and patches preserve defaults', { skip: process.env.VELA_BUSINESS_EMULATOR_TEST !== '1' }, async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^127\.0\.0\.1:\d+$/);
  const { initializeApp, deleteApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'demo-vela-ci' }, 'business-api-test');
  const db = getFirestore(app), root = db.doc('users/alice');
  try {
    const created = (await request(db, 'POST', '/v1/profiles', { ...profile, entityType: 'company', gender: 'female' })).body as any;
    const patched = (await request(db, 'PATCH', `/v1/profiles/${created.id}`, { name: 'Renamed' })).body as any;
    assert.equal(patched.entityType, 'company'); assert.equal(patched.gender, 'female');
    const session = root.collection('sessions').doc('chronological');
    await session.set({ mode: 'personal' });
    for (const [id, time] of [['z','2026-01-01'],['a','2026-01-02'],['b','2026-01-02']]) await session.collection('messages').doc(id).set({ role: 'user', parts: [], createdAt: time });
    const first = (await request(db, 'GET', '/v1/sessions/chronological/messages', undefined, { limit: '2' })).body as any;
    assert.deepEqual(first.items.map((m: any) => m.id), ['z','a']);
    const next = (await request(db, 'GET', '/v1/sessions/chronological/messages', undefined, { limit: '2', cursor: first.nextCursor })).body as any;
    assert.deepEqual(next.items.map((m: any) => m.id), ['b']); assert.equal(next.nextCursor, null);
    await assert.rejects(() => request(db, 'GET', '/v1/sessions/chronological/messages', undefined, { cursor: 'missing' }), /INVALID_CURSOR/);
    const pages = await Promise.all([request(db, 'PATCH', `/v1/profiles/${created.id}`, { name: 'Concurrent' }),request(db, 'PATCH', `/v1/profiles/${created.id}`, { locationName: 'Updated location' })]);
    assert.equal(pages.length, 2);
    const final = (await request(db, 'GET', `/v1/profiles/${created.id}`)).body as any;
    assert.equal(final.name, 'Concurrent'); assert.equal(final.locationName, 'Updated location');
  } finally { await db.recursiveDelete(root); await deleteApp(app); }
});

 test('invalid stored response is a server error rather than a client input error', async () => {
  const { db, store } = database();
  store.set('users/alice/profiles/bad', { name: 'incomplete' });
  await assert.rejects(() => request(db, 'GET', '/v1/profiles/bad'), (error: any) => error.code === 'internal' && error.message === 'INVALID_RESPONSE');
});

test('profile limit uses server tier override and unlimited does not grant extra storage', async () => {
  const {db,store}=database();
  store.set('usage/alice',{overrideTier:'free',unlimited:true});
  const paidIdentity={...auth,token:{...auth.token,stripeRole:'pro'}};
  const create=()=>dispatchBusinessApi(db,{method:'POST',path:'/v1/profiles',body:profile,auth:paidIdentity});
  await create();
  await assert.rejects(create,(error:any)=>error.code==='resource-exhausted'&&error.message==='PROFILE_LIMIT_REACHED');
  store.set('usage/alice',{overrideTier:'go'});
  await create();
  assert.equal([...store.keys()].filter(path=>path.startsWith('users/alice/profiles/')).length,2);
});

test('real Firestore profile cap serializes concurrency, handles downgrade and restores capacity after deletion', {skip:process.env.VELA_BUSINESS_EMULATOR_TEST!=='1'}, async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST??'',/^127\.0\.0\.1:\d+$/);
  const {initializeApp,deleteApp}=await import('firebase-admin/app');
  const {getFirestore}=await import('firebase-admin/firestore');
  const app=initializeApp({projectId:'demo-vela-ci'},'profile-cap-test'), db=getFirestore(app);
  const uid=`profile-cap-${Date.now()}`, root=db.doc(`users/${uid}`), usage=db.doc(`usage/${uid}`);
  const identity={uid,token:{stripeRole:'pro'}};
  const call=(method:string,path:string,body?:unknown)=>dispatchBusinessApi(db,{auth:identity,method,path,body});
  const create=()=>call('POST','/v1/profiles',profile);
  const count=async()=> (await root.collection('profiles').get()).size;
  try{
    await usage.set({overrideTier:'free',unlimited:true});
    const attempts=await Promise.allSettled(Array.from({length:8},()=>create()));
    assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
    assert(attempts.filter(result=>result.status==='rejected').every(result=>(result as PromiseRejectedResult).reason.message==='PROFILE_LIMIT_REACHED'));
    assert.equal(await count(),1);
    await usage.set({overrideTier:'go'});
    for(let i=0;i<4;i++)await create();
    assert.equal(await count(),5);await assert.rejects(create,/PROFILE_LIMIT_REACHED/);
    await usage.set({overrideTier:'free'});
    await assert.rejects(create,/PROFILE_LIMIT_REACHED/);assert.equal(await count(),5);
    const docs=(await root.collection('profiles').get()).docs;
    await call('PATCH',`/v1/profiles/${docs[0].id}`,{name:'Still editable after downgrade'});
    for(const doc of docs.slice(1))await call('DELETE',`/v1/profiles/${doc.id}`);
    assert.equal(await count(),1);await assert.rejects(create,/PROFILE_LIMIT_REACHED/);
    await call('DELETE',`/v1/profiles/${docs[0].id}`);
    const restored=await create();assert.equal(restored.status,201);assert.equal(await count(),1);
    const id=(restored.body as any).id;
    const racing=await Promise.allSettled([call('DELETE',`/v1/profiles/${id}`),create(),create()]);
    assert.equal(racing[0].status,'fulfilled');assert((await count())<=1);
    if((await count())===0)await create();
    assert.equal(await count(),1);await assert.rejects(create,/PROFILE_LIMIT_REACHED/);
  }finally{await db.recursiveDelete(root);await usage.delete();await deleteApp(app);}
});
