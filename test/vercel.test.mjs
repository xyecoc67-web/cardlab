import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVercelApp, routeHandler } from '../server/vercel.mjs';

const origin = 'https://cardlab.example';
const env = { STRIPE_TEST_SECRET_KEY: 'sk_test_localFixtureNotAnActualKey' };
const requestId = '11111111-2222-4333-8444-555555555555';
const id = 'cs_test_vercelFixture123';
const request = (path, { cookie, method = 'GET', body, headers = {} } = {}) => new Request(origin + path, {
  method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
async function cookieFor(app) {
  const response = await app.fetch(request('/api/stripe/config'));
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
const checkout = () => Response.json({ id, livemode: false, url: 'https://checkout.stripe.com/c/pay/' + id });

test('Vercel config stays unconfigured with missing/live credentials and never leaks a key', async () => {
  let calls = 0;
  for (const value of ['', 'sk_live_forbidden', 'rk_live_forbidden']) {
    const app = createVercelApp({ STRIPE_TEST_SECRET_KEY: value }, async () => { calls++; });
    const response = await app.fetch(request('/api/stripe/config', { headers: { 'oai-authenticated-user-id': 'spoofed' } }));
    const body = await response.json();
    assert.equal(body.configured, false);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal((await app.fetch(request('/api/stripe/checkout', { method: 'POST', body: { requestId } }))).status, 503);
  }
  const response = await createVercelApp(env).fetch(request('/api/stripe/config'));
  const raw = await response.text();
  assert.equal(raw.includes(env.STRIPE_TEST_SECRET_KEY), false);
  assert.deepEqual(JSON.parse(raw), { configured: true, mode: 'test', amount: 100, currency: 'usd', requiresSignIn: false });
  const cookie = response.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=86400']) assert.ok(cookie.includes(flag));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 0);
});

test('a signed browser cookie is required; caller-supplied identity never authorizes a session', async () => {
  let calls = 0;
  const app = createVercelApp(env, async () => { calls++; return checkout(); });
  for (const cookie of [undefined, 'cardlab_session=forged']) {
    const response = await app.fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId }, headers: { 'oai-authenticated-user-id': 'spoofed' } }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'browser_session_required');
  }
  assert.equal(calls, 0);
  const cookie = await cookieFor(app);
  assert.equal((await app.fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId } }))).status, 200);
  assert.equal(calls, 1);
  assert.equal((await app.fetch(request('/api/stripe/config', { cookie }))).headers.has('set-cookie'), false);
});

test('browser ownership survives cold starts and prevents another browser from reading the payment', async () => {
  let owner;
  const fakeStripe = async (url, options) => {
    if (options.method === 'POST') {
      const body = new URLSearchParams(options.body);
      owner = body.get('metadata[cardlab_owner]');
      assert.equal(body.get('success_url'), origin + '/?stripe_session={CHECKOUT_SESSION_ID}');
      return checkout();
    }
    return Response.json({ id, livemode: false, mode: 'payment', amount_total: 100, currency: 'usd', payment_status: 'paid', status: 'complete', metadata: { cardlab_owner: owner, purpose: 'cardlab_test' }, payment_intent: { livemode: false, status: 'succeeded', payment_method: { card: { brand: 'visa', last4: '4242' } } } });
  };
  const first = createVercelApp(env, fakeStripe);
  const cookie = await cookieFor(first);
  const identity = cookie.split('=')[1].split('.')[0];
  assert.equal((await first.fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId }, headers: { 'oai-authenticated-user-id': 'forged' } }))).status, 200);
  assert.equal(owner, createHash('sha256').update('vercel:' + identity).digest('hex'));
  const cold = createVercelApp(env, fakeStripe);
  const verified = await cold.fetch(request('/api/stripe/session?id=' + id, { cookie }));
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).result, 'paid');
  const otherCookie = await cookieFor(cold);
  assert.notEqual(otherCookie, cookie);
  assert.equal((await cold.fetch(request('/api/stripe/session?id=' + id, { cookie: otherCookie, headers: { 'oai-authenticated-user-id': 'vercel:' + identity } }))).status, 403);
});

test('modified, expired, duplicate and key-rotated cookies cannot be used', async () => {
  const now = Date.UTC(2026, 9, 19);
  const cookie = await cookieFor(createVercelApp(env, async () => checkout(), () => now));
  const modified = cookie.replace(/cardlab_session=./, 'cardlab_session=z');
  for (const bad of [modified, cookie + '; ' + cookie]) {
    const app = createVercelApp(env, async () => checkout(), () => now);
    assert.equal((await app.fetch(request('/api/stripe/checkout', { cookie: bad, method: 'POST', body: { requestId } }))).status, 401);
  }
  for (const app of [createVercelApp(env, async () => checkout(), () => now + 86401000), createVercelApp({ STRIPE_TEST_SECRET_KEY: 'sk_test_anotherLocalFixture' }, async () => checkout(), () => now)]) {
    assert.equal((await app.fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId } }))).status, 401);
  }
});

test('Vercel adaptation preserves same-origin and no-raw-card restrictions', async () => {
  let calls = 0;
  const app = createVercelApp(env, async () => { calls++; return checkout(); });
  const cookie = await cookieFor(app);
  assert.equal((await app.fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId }, headers: { origin: 'https://other.example' } }))).status, 403);
  assert.equal((await app.fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId, pan: '4242424242424242' } }))).status, 400);
  assert.equal((await app.fetch(request('/api/stripe/session?id=cs_live_forbidden', { cookie }))).status, 400);
  assert.equal(calls, 0);
});

test('function entries use the Web Request/Response contract and preserve POST request bodies', async () => {
  for (const name of ['config', 'checkout', 'session']) {
    const entry = await import('../api/stripe/' + name + '.mjs');
    assert.equal(typeof entry.default.fetch, 'function');
  }
  let captured;
  const app = createVercelApp(env, async (url, options) => { captured = new URLSearchParams(options.body); return checkout(); });
  const response = await routeHandler('config', app).fetch(new Request(origin + '/api/stripe/config'));
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const post = await routeHandler('checkout', app).fetch(request('/api/stripe/checkout', { cookie, method: 'POST', body: { requestId } }));
  assert.equal(post.status, 200);
  assert.equal(captured.get('line_items[0][price_data][unit_amount]'), '100');
  assert.equal((await post.json()).sessionId, id);
});
