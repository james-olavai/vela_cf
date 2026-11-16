import assert from 'node:assert/strict';

// Token stays in the Authorization header; never include request/response bodies in errors.
export function apiClient(baseUrl, token, fetchImpl = fetch) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  assert(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)), 'API requires HTTPS or local emulator');
  assert(!base.username && !base.password && !base.search && !base.hash, 'Invalid API base URL');
  return async (method, path, body) => {
    assert(/^\/v1\//.test(path) && !path.includes('..') && !path.includes('\\'), 'Only relative v1 API paths are allowed');
    const url = new URL(path.slice(1), base);
    assert(url.origin === base.origin && url.pathname.startsWith(`${base.pathname}v1/`), 'API path escaped base');
    const value = typeof token === 'function' ? await token() : token;
    assert(typeof value === 'string' && value.length, 'Firebase ID Token is required');
    const res = await fetchImpl(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${value}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    assert(res.status === 204 || res.headers.get('content-type')?.includes('application/json'), `API ${method} ${path} returned HTTP ${res.status} without JSON; check gateway access and readiness`);
    const data = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: data };
  };
}

// Caller supplies an isolated synthetic account; this never creates administrator credentials.
export async function profileSmoke(call) {
  const input = { name: 'API Synthetic', entityType: 'person', birthDateTime: '1994-06-03T08:20', locationName: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai', gender: 'female', consentedOther: false };
  const created = await call('POST', '/v1/profiles', input);
  assert.equal(created.status, 201, 'User API profile creation failed');
  const id = created.body.id;
  assert.match(id, /^[a-zA-Z0-9_-]+$/);
  try {
    const read = await call('GET', `/v1/profiles/${id}`);
    assert.equal(read.status, 200); assert.equal(read.body.name, input.name);
    const updated = await call('PATCH', `/v1/profiles/${id}`, { name: 'API Updated' });
    assert.equal(updated.status, 200);
    const reloaded = await call('GET', `/v1/profiles/${id}`);
    assert.equal(reloaded.body.name, 'API Updated');
    const usage = await call('GET', '/v1/me/usage');
    assert.equal(usage.status, 200);
    return { profileCrud: true, usageRead: true };
  } finally {
    const deleted = await call('DELETE', `/v1/profiles/${id}`);
    assert.equal(deleted.status, 200, 'Synthetic profile cleanup failed');
    assert.equal(deleted.body.deleted, true);
  }
}

// New Cloud Run services can report deployed before their invoker policy reaches the gateway.
// Probe a protected read without credentials: reaching AUTH_REQUIRED proves both routing and auth.
export async function waitForApiGateway(baseUrl, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 12 } = {}) {
  let last = 'unreachable';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/profiles`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      last = `HTTP ${res.status}`;
      const json = res.headers.get('content-type')?.includes('application/json');
      if (json) {
        const body = await res.json();
        assert(res.status === 401 && body.error?.message === 'AUTH_REQUIRED', 'API gateway did not enforce application authentication');
        return;
      }
      assert([401, 403, 404, 502, 503, 504].includes(res.status), `Unexpected API gateway ${last}`);
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      last = 'network unavailable';
    }
    if (attempt < attempts) await sleep(10_000);
  }
  throw new Error(`API gateway not ready after ${attempts} probes (${last})`);
}
