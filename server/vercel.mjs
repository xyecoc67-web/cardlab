import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createApp } from './app.mjs';

const COOKIE = 'cardlab_session';
const TTL = 86400;
const ROUTES = new Set(['/api/stripe/config', '/api/stripe/checkout', '/api/stripe/session']);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (value, status) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

function signature(payload, key) {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function readIdentity(cookieHeader, key, now) {
  const matches = (cookieHeader ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  if (token.length > 160) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expires, mac] = parts;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || !/^\d{10}$/.test(expires) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  if (Number(expires) <= now || Number(expires) > now + TTL) return null;
  const actual = Buffer.from(mac, 'base64url');
  const expected = Buffer.from(signature(`${id}.${expires}`, key), 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : null;
}

// Vercel has no Sites identity. Bind test sessions to an HTTP-only signed cookie.
// The signing key stays server-side and is derived separately from the Stripe credential.
export function createVercelApp(env = process.env, stripeFetch = globalThis.fetch, clock = Date.now) {
  const app = createApp({}, stripeFetch);
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (!ROUTES.has(url.pathname)) return json({ error: 'Not found.' }, 404);
      const headers = new Headers(request.headers);
      headers.delete('oai-authenticated-user-id');
      const stripeKey = String(env.STRIPE_TEST_SECRET_KEY ?? '').trim();
      let cookie = null;
      if (/^(sk|rk)_test_[A-Za-z0-9_]{8,}$/.test(stripeKey)) {
        const key = createHash('sha256').update('Cardlab Vercel session signing v1\0').update(stripeKey).digest();
        const now = Math.floor(clock() / 1000);
        let identity = readIdentity(request.headers.get('cookie'), key, now);
        if (!identity) {
          if (url.pathname !== '/api/stripe/config' || request.method !== 'GET') {
            return json({ error: 'Reload the page and click Stripe test to start a browser session.', code: 'browser_session_required' }, 401);
          }
          identity = randomUUID();
          const payload = `${identity}.${now + TTL}`;
          cookie = `${COOKIE}=${payload}.${signature(payload, key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}${url.protocol === 'https:' ? '; Secure' : ''}`;
        }
        headers.set('oai-authenticated-user-id', `vercel:${identity}`);
      }
      const response = await app.fetch(new Request(request, { headers }), env);
      if (!cookie) return response;
      const responseHeaders = new Headers(response.headers);
      responseHeaders.append('set-cookie', cookie);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    }
  };
}

const app = createVercelApp();
export function routeHandler(action, handler = app) {
  return {
    fetch(request) {
      const url = new URL(request.url);
      url.pathname = '/api/stripe/' + action;
      return handler.fetch(new Request(url, request));
    }
  };
}
