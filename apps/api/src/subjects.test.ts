import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import { CreateSessionRequestSchema, SubjectsSchema, sessionProfiles } from '@vela-cf/shared';
import { resolveSubjects, validateBirthTime } from './subjects.js';
import { createFrozenSession } from './session.js';
const birth = { datetime: '1994-06-03T08:20', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47 };
const saved = { name: 'Saved A', birthDateTime: birth.datetime, timezone: birth.timezone, latitude: birth.latitude, longitude: birth.longitude, locationName: 'Shanghai', gender: 'female' };
function database() {
  const store = new Map<string, any>([['users/alice/profiles/a', saved], ['users/bob/profiles/b', saved]]);
  let serial = 0;
  const collection = (path: string): any => ({ doc: (id = `s${++serial}`) => ({ id, collection: (name: string) => collection(`${path}/${id}/${name}`), get: async () => ({ exists: store.has(`${path}/${id}`), data: () => store.get(`${path}/${id}`) }), set: async (data: any) => {store.set(`${path}/${id}`,data);} }) });
  return { store, db: { collection } as unknown as Firestore };
}
test('subject schemas require exactly one source, explicit time and unique refs', () => {
  for (const value of [
    [{ref:'a'}], [{ref:'a',profile_id:'p',birth}], [{ref:'a',birth},{ref:'a',profile_id:'p'}],
    [{ref:'a',profile_id:'../bob'}], [{ref:'a',birth:{...birth,datetime:'1994-06-03'}}], [{ref:'a',birth,uid:'bob'}],
  ]) assert.equal(SubjectsSchema.safeParse(value).success,false);
  assert.equal(CreateSessionRequestSchema.safeParse({subjects:[{ref:'a',birth}],profileIds:['a']}).success,false);
  assert.equal(CreateSessionRequestSchema.safeParse({profileIds:['a']}).success,true);
});
test('mixed subjects resolve only owned profiles and normalize direct birth without persisting it', async () => {
  const {db,store}=database();
  const result=await resolveSubjects(db,'alice',[{ref:'self',profile_id:'a'},{ref:'partner',birth}]);
  assert.equal(result[0].profile.name,'Saved A');assert.equal(result[0].profileId,'a');
  assert.equal(result[1].profile.birthDateTime,birth.datetime);assert.equal(result[1].profile.name,'partner');
  assert.equal(store.size,2);
  await assert.rejects(()=>resolveSubjects(db,'',[{ref:'self',profile_id:'a'}]),/AUTH_REQUIRED/);
  assert.equal((await resolveSubjects(db,'',[{ref:'guest',birth}]))[0].ref,'guest');
  await assert.rejects(()=>resolveSubjects(db,'alice',[{ref:'other',profile_id:'b'}]),/PROFILE_NOT_FOUND/);
});
test('birth times reject invalid calendar, zone, DST gap and ambiguous fold', () => {
  for (const [datetime,zone,code] of [
    ['2026-02-30T08:20','UTC','INVALID_BIRTH_DATETIME'], ['2026-11-01T08:20','Unknown/Zone','INVALID_TIMEZONE'],
    ['2026-03-08T02:30','America/New_York','NONEXISTENT_BIRTH_TIME'], ['2026-11-01T01:30','America/New_York','AMBIGUOUS_BIRTH_TIME'],
  ]) assert.throws(()=>validateBirthTime(datetime,zone),new RegExp(code));
  assert.doesNotThrow(()=>validateBirthTime(birth.datetime,birth.timezone));
});
test('sessions freeze resolved profiles and retain legacy profileIds support', async () => {
  const {db,store}=database();
  const mixed=await createFrozenSession(db,{uid:'alice',tier:'go',rawData:{mode:'synastry',subjects:[{ref:'self',profile_id:'a'},{ref:'partner',birth}]}});
  store.set('users/alice/profiles/a',{...saved,name:'Edited later'});
  const snapshot=store.get(`users/alice/sessions/${mixed.sessionId}`).frozenSubjects;
  assert.equal(snapshot[0].profile.name,'Saved A');assert.equal(snapshot[1].ref,'partner');
  const displayed=sessionProfiles({...mixed.session,subjects:snapshot} as any,[]);
  assert.equal(displayed[0].name,'Saved A');assert.equal(displayed[1].id,'partner');
  assert.equal(displayed[1].birthDateTime,birth.datetime);
  const legacy=await createFrozenSession(db,{uid:'alice',tier:'free',rawData:{profileIds:['a']}});
  assert.deepEqual(legacy.session.profileIds,['a']);
  await assert.rejects(()=>createFrozenSession(db,{uid:'alice',tier:'free',rawData:{subjects:[{ref:'company',birth:{...birth,entityType:'company'}}]}}),/ENTITY_CHART_REQUIRES_PRO/);
});
