import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dispatchBusinessApi } from '../../apps/api/src/business-api.ts';
import { dispatchTuningApi } from '../../apps/api/src/tuning-api.ts';
import { createHttpApi, verifyApiIdentity } from '../../apps/api/src/http-api.ts';
import { apiClient, profileSmoke } from './api-smoke.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(authHost || '') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw new Error('API tests require local Auth + Firestore emulators; production is forbidden');

test('HTTP API verifies real Firebase tokens and user-owned CRUD, pagination, session projection', async () => {
  const app = initializeApp({ projectId: 'demo-vela-ci' }, 'api-http-test'), db = getFirestore(app), auth = getAuth(app);
  const users = [];
  const handler = createHttpApi({ verifyToken: token => verifyApiIdentity(auth, token), dispatch: input => input.path.startsWith('/v1/tuning/') ? dispatchTuningApi(input) : dispatchBusinessApi(db, input) });
  // Node HTTP transport shim only; authentication, dispatch and persistence are production code.
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let body = '';
    for await (const chunk of req) body += chunk;
    req.path = url.pathname; req.query = Object.fromEntries(url.searchParams); req.body = body ? JSON.parse(body) : undefined;
    req.get = name => req.headers[name.toLowerCase()]; req.is = mime => req.headers['content-type']?.startsWith(mime);
    res.status = code => { res.statusCode = code; return res; }; res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    await handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = async () => {
    const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); const user = await response.json(); users.push(user.localId); return user;
  };
  try {
    const a = await account(), b = await account(), call = apiClient(base, a.idToken), other = apiClient(base, b.idToken);
    assert.equal((await apiClient(base, a.localId)('GET', '/v1/me')).status, 401, 'UID alone must not authenticate');
    assert.equal((await fetch(`${base}/v1/me`)).status, 401);
    assert.equal((await call('PATCH', '/v1/me', { acceptedTerms: true, confirmedAdult: true })).status, 200);
    await profileSmoke(call);
    assert.equal((await call('GET', '/v1/tuning/prompts')).status, 403);
    await auth.setCustomUserClaims(a.localId, { tuningEditor: true });
    const prompts = await call('GET', '/v1/tuning/prompts');
    assert.equal(prompts.status, 200); assert.equal(prompts.body.source, 'compiled-default');
    assert.equal((await call('POST', '/v1/tuning/releases', {})).status, 404);
    await auth.setCustomUserClaims(a.localId, {});
    assert.equal((await call('GET', '/v1/tuning/prompts')).status, 403, 'Current claims must enforce role removal');
    const input = { name: 'Synthetic', birthDateTime: '1994-06-03T08:20', locationName: '上海', latitude: 31, longitude: 121, timezone: 'Asia/Shanghai', gender: 'female' };
    await auth.setCustomUserClaims(a.localId, {stripeRole:'go'}); // Pagination needs two profiles; effective server claims apply even with the original token.
    const first = await call('POST', '/v1/profiles', input), second = await call('POST', '/v1/profiles', input);
    assert.equal(first.status, 201); assert.equal(second.status, 201);
    assert.equal((await other('GET', `/v1/profiles/${first.body.id}`)).status, 404);
    assert.equal((await other('PATCH', `/v1/profiles/${first.body.id}`, { name: 'Stolen' })).status, 404);
    assert.equal((await call('PATCH', `/v1/profiles/${first.body.id}`, { uid: b.localId })).status, 400);
    assert.equal((await call('GET', '/v1/profiles?limit=51')).status, 400);
    const page = await call('GET', '/v1/profiles?limit=1'); assert.equal(page.body.items.length, 1); assert(page.body.nextCursor);
    const next = await call('GET', `/v1/profiles?limit=1&cursor=${page.body.nextCursor}`); assert.equal(next.body.items.length, 1); assert.notEqual(page.body.items[0].id, next.body.items[0].id);
    const session = await call('POST', '/v1/sessions', { mode: 'personal', profileIds: [first.body.id] });
    assert.equal(session.status, 201); assert(!('frozenPrompt' in session.body)); assert(!('frozenTools' in session.body));
    assert.equal((await other('GET', `/v1/sessions/${session.body.id}`)).status, 404);
    assert.equal((await call('GET', `/v1/sessions/${session.body.id}/messages`)).body.items.length, 0);
    assert.equal((await call('POST', '/v1/sessions', { mode: 'personal', profileIds: [first.body.id], uid: b.localId })).status, 400);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const uid of users) { await db.recursiveDelete(db.doc(`users/${uid}`)); await db.doc(`usage/${uid}`).delete(); await auth.deleteUser(uid); }
    await deleteApp(app);
  }
});
