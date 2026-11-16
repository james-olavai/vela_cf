import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { apiClient, profileSmoke } from './api-smoke.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const project = 'demo-vela-ci', base = `http://127.0.0.1:5001/${project}/asia-southeast1/businessApi`;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(authHost || '') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '') || process.env.FIRESTORE_DATABASE_ID !== '(default)') throw new Error('Functions API tests require local Auth/Firestore and explicit default database');

test('compiled Functions API enforces bearer identity, CORS and current tuning roles', async () => {
  const app = initializeApp({ projectId: project }, 'api-functions-test'), auth = getAuth(app), db = getFirestore(app);
  let uid;
  try {
    const birth={birthDateTime:'1994-06-03T08:20',latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai'};
    const guest=await fetch(`${base}/v1/charts/natal`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(birth)});
    assert.equal(guest.status,200);assert((await guest.json()).natal.planets.length>0);
    const cities=await fetch(`${base}/v1/locations?query=beijing&source=builtin`);
    assert.equal(cities.status,200);assert((await cities.json()).results.some(city=>city.id==='geonames-1816670'));
    const noToken = await fetch(`${base}/v1/me`);
    assert.equal(noToken.status, 401); assert.equal((await noToken.json()).error.code, 'AUTH_REQUIRED');
    const preflight = origin => fetch(`${base}/v1/profiles`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    const allowed = await preflight('http://localhost:5173');
    assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    // firebase-tools forces enableCors=true in emulated workers; origin rejection is
    // checked below against the actual compiled SDK wrapper with that override disabled.
    const login = async (action, body) => {
      const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200); return response.json();
    };
    const credentials = { email: `api-${Date.now()}@vela.local`, password: 'emulator-only-password', returnSecureToken: true };
    const user = await login('signUp', credentials); uid = user.localId;
    const call = apiClient(base, user.idToken);
    assert.equal((await apiClient(base, uid)('GET', '/v1/me')).status, 401);
    await profileSmoke(call);
    const tokenCapability=await call('GET','/v1/me/api-token-capabilities');assert.equal(tokenCapability.status,200);assert.deepEqual(tokenCapability.body,{canCreate:false,canManage:false});
    const tokenList=await call('GET','/v1/me/api-tokens');assert.equal(tokenList.status,200);assert.deepEqual(tokenList.body.items,[]);
    const tokenCreate=await call('POST','/v1/me/api-tokens',{name:'Hidden feature',scopes:['profiles:read']});assert.equal(tokenCreate.status,403);assert.equal(tokenCreate.body.error.code,'PAT_DISABLED');
    assert.equal((await apiClient(base,'vela_pat_invalid')('GET','/v1/profiles')).status,401);
    assert.equal((await call('DELETE','/v1/me/api-tokens/missing')).status,404);
    const me=await call('PATCH','/v1/me',{acceptedTerms:true,confirmedAdult:true,displayName:'API Synthetic'});assert.equal(me.status,200);
    const profile=await call('POST','/v1/profiles',{...birth,name:'Original profile',locationName:'Shanghai',gender:'female'});assert.equal(profile.status,201);
    const session=await call('POST','/v1/sessions',{mode:'personal',subjects:[{ref:'saved-person',profile_id:profile.body.id}]});assert.equal(session.status,201);
    const frozenBefore=(await db.doc(`users/${uid}/sessions/${session.body.id}`).get()).data().frozenSubjects;
    assert.equal(frozenBefore[0].profile.name,'Original profile');
    assert.equal((await call('PATCH',`/v1/profiles/${profile.body.id}`,{name:'Edited profile'})).status,200);
    assert.deepEqual((await db.doc(`users/${uid}/sessions/${session.body.id}`).get()).data().frozenSubjects,frozenBefore);
    const direct=await call('POST','/v1/sessions',{mode:'personal',subjects:[{ref:'temporary',birth:{datetime:birth.birthDateTime,timezone:birth.timezone,latitude:birth.latitude,longitude:birth.longitude}}]});assert.equal(direct.status,201);
    assert.equal((await call('GET','/v1/profiles')).body.items.length,1,'Direct subjects must not save a profile');
    assert.equal((await call('GET',`/v1/sessions/${direct.body.id}/messages`)).body.items.length,0);
    const shared=await call('POST','/v1/me/share-claims',{shareMethod:'copy'});assert.equal(shared.status,200);assert.equal(shared.body.usage.shareCount,1);
    assert.equal((await call('GET','/v1/me/usage')).body.shareCount,1);
    assert.notEqual((await call('POST','/v1/me/share-claims',{shareMethod:'copy'})).status,200,'Duplicate share must not grant twice');
    const exported=await call('POST','/v1/me/exports',{});assert.equal(exported.status,200);assert.equal(exported.body.sessions.length,2);assert(!exported.body.sessions.some(v=>'frozenPrompt' in v));
    assert.equal((await call('GET','/v1/me/subscription')).status,200);

    assert.equal((await call('GET', '/v1/tuning/prompts')).status, 403);
    await auth.setCustomUserClaims(uid, { tuningEditor: true });
    const elevated = await login('signInWithPassword', credentials);
    assert.equal(JSON.parse(Buffer.from(elevated.idToken.split('.')[1], 'base64url')).tuningEditor, true);
    const editor = apiClient(base, elevated.idToken);
    const prompts = await editor('GET', '/v1/tuning/prompts');
    assert.equal(prompts.status, 200); assert.equal(prompts.body.source, 'compiled-default');
    await auth.setCustomUserClaims(uid, {});
    assert.equal((await editor('GET', '/v1/tuning/prompts')).status, 403, 'Previously privileged token cannot retain revoked tuning permission');
    await auth.updateUser(uid, { disabled: true });
    assert.equal((await call('GET', '/v1/me/usage')).status, 401);
    await auth.updateUser(uid,{disabled:false});
    const deletion=await call('DELETE','/v1/me');assert.equal(deletion.status,200);assert.equal(deletion.body.deleted,true);
    assert.equal((await db.doc(`users/${uid}`).get()).exists,false);

  } finally {
    if (uid) { await db.recursiveDelete(db.doc(`users/${uid}`)); await db.doc(`usage/${uid}`).delete(); await auth.deleteUser(uid).catch(error=>{if(error.code!=='auth/user-not-found')throw error;}); }
    await deleteApp(app);
  }
});


test('compiled onRequest wrapper retains production CORS allowlist without emulator debug override', async () => {
  process.env.FIREBASE_DEBUG_MODE = 'false';
  process.env.GCLOUD_PROJECT = project;
  process.env.OTEL_SDK_DISABLED = 'true';
  process.env.METADATA_SERVER_DETECTION = 'none';
  const { businessApi } = require('../../apps/api/dist/index.cjs');
  assert.deepEqual(businessApi.__endpoint.httpsTrigger.invoker, ['public'], 'Cloud Run must pass Firebase tokens through to application authentication');
  const server = createServer((req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    void businessApi(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const check = origin => fetch(`http://127.0.0.1:${server.address().port}/v1/profiles`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    const allowed = await check(`https://${project}.web.app`);
    assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), `https://${project}.web.app`);
    const denied = await check('https://untrusted.example');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('real HTTP location identity, country recommendation, permissions and frozen sessions',async()=>{
  const app=initializeApp({projectId:project},'catalog-http-test'),db=getFirestore(app),auth=getAuth(app),users=[];
  const signUp=async()=>{const res=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(res.status,200);const user=await res.json();users.push(user.localId);return user;};
  try {
    const a=await signUp(),b=await signUp(),call=apiClient(base,a.idToken),other=apiClient(base,b.idToken);
    const response=await fetch(`${base}/v1/locations/catalog?limit=1`),first=await response.json();assert.equal(response.status,200);assert.equal(first.items.length,1);assert(first.nextCursor);
    assert.equal((await fetch(`${base}/v1/locations/catalog?limit=1`,{headers:{'If-None-Match':response.headers.get('etag')}})).status,304);
    assert.equal((await call('GET',`/v1/locations/catalog?cursor=${first.nextCursor}`)).status,400);
    assert.equal((await call('GET',`/v1/locations/catalog?version=${first.catalogVersion}&cursor=${first.nextCursor}`)).status,200);
    assert.equal((await call('GET','/v1/locations/catalog?version=missing')).status,412);
    const city=(await call('GET','/v1/locations?query=beijing&source=builtin')).body.results.find(c=>c.id==='geonames-1816670');assert(city);
    const input={name:'Country E2E',birthDateTime:'1994-06-03T08:20',locationName:city.displayName,latitude:city.latitude,longitude:city.longitude,timezone:city.timezone,locationRef:{id:city.id,version:city.version}};
    assert.equal((await call('POST','/v1/profiles',{...input,countryCode:'US'})).status,400);
    assert.equal((await call('POST','/v1/profiles',{...input,latitude:0})).status,400);
    const profile=await call('POST','/v1/profiles',input);assert.equal(profile.status,201);assert.equal(profile.body.countryCode,'CN');
    const recPath=`/v1/profiles/${profile.body.id}/country-chart`,rec=await call('GET',recPath);assert.equal(rec.status,200);assert.equal(rec.body.status,'matched');assert.equal(rec.body.basis,'birth_location');
    assert.equal((await other('GET',recPath)).status,404);
    assert.equal((await fetch(base+recPath)).status,401);
    const chart=rec.body.chart,subjects=[{ref:'self',profile_id:profile.body.id},{ref:'country',country_chart:{mode:'auto',source_ref:'self'}}];
    assert.equal((await call('POST','/v1/sessions',{mode:'synastry',subjects})).status,403);
    const countryOnly={subjects:[{ref:'country',country_chart:{id:chart.id,version:chart.version}}]};
    assert.equal((await call('POST','/v1/charts/natal',countryOnly)).status,403);
    assert.equal((await fetch(`${base}/v1/charts/natal`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(countryOnly)})).status,401);
    await db.doc(`usage/${a.localId}`).set({overrideTier:'pro'});
    const wheel=await call('POST','/v1/charts/natal',countryOnly);assert.equal(wheel.status,200);assert(wheel.body.natal.planets.length);
    const session=await call('POST','/v1/sessions',{mode:'synastry',subjects});assert.equal(session.status,201);
    const frozen=session.body.subjects[1];assert.equal(frozen.countryChart.id,chart.id);assert.equal(frozen.countryChart.version,chart.version);assert.equal(frozen.countryChart.sourceRef,'self');assert.equal(frozen.profile.birthDateTime,`${chart.localDate}T${chart.localTime}`);
    assert.equal((await call('GET','/v1/profiles')).body.items.length,1,'System country must not persist a user profile');
    const unchanged=await call('PATCH',`/v1/profiles/${profile.body.id}`,{name:'Renamed'});assert.equal(unchanged.body.countryCode,'CN');
    await call('PATCH',`/v1/profiles/${profile.body.id}`,{latitude:0});assert.equal((await call('GET',recPath)).body.status,'needs_selection');
    const invalid=await call('POST','/v1/sessions',{mode:'synastry',subjects});assert.equal(invalid.status,412);
    assert.equal((await call('GET','/v1/sessions')).body.items.length,1,'Failed auto resolution must not create a partial session');
    await call('DELETE',`/v1/profiles/${profile.body.id}`);
    const after=await call('GET',`/v1/sessions/${session.body.id}`);assert.deepEqual(after.body.subjects[1],frozen);
    assert.equal((await call('GET',`/v1/country-charts/${chart.id}?version=missing`)).status,404);
    await db.doc(`usage/${a.localId}`).set({overrideTier:'free'});
    const denied=await fetch(`${base}/v1/sessions/${session.body.id}/turns`,{method:'POST',headers:{Authorization:`Bearer ${a.idToken}`,'Content-Type':'application/json'},body:JSON.stringify({message:'Country question after downgrade'})});assert.equal(denied.status,200);assert.match(await denied.text(),/ENTITY_CHART_REQUIRES_PRO/);
    assert.equal((await call('GET',`/v1/sessions/${session.body.id}/messages`)).body.items.length,0);
  } finally {for(const uid of users){await db.recursiveDelete(db.doc(`users/${uid}`));await db.doc(`usage/${uid}`).delete();await auth.deleteUser(uid);}await deleteApp(app);}
});
