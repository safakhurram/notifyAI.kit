import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../src/router.js';
import { setup } from './helpers.js';

// tiny stand-in for express.json(): parses JSON body into req.body
function serve(router) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { if (raw && /json/.test(req.headers['content-type'] ?? '')) req.body = JSON.parse(raw); } catch { req.body = null; } router(req, res); });
  });
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const authenticate = (req) => {
  const t = req.headers.authorization;
  return t === 'Bearer alice' ? { userId: 'alice' } : t === 'Bearer bob' ? { userId: 'bob' } : t === 'Bearer admin' ? { userId: 'admin' } : null;
};
const call = (base, path, { method = 'GET', token, body, headers = {} } = {}) =>
  fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });

async function env(opts = {}) {
  const s = setup({ users: ['alice', 'bob'], ...opts.setup });
  const router = createRouter({ notifier: s.notifier, authenticate, authorizeAdmin: (req) => req.headers.authorization === 'Bearer admin', ...opts.router });
  return { ...s, ...(await serve(router)) };
}
const shipped = { type: 'order.shipped', data: { orderId: '1', total: '$5' } };

test('user routes require authentication', async () => {
  const { server, base } = await env();
  for (const [p, m] of [['/notifications', 'GET'], ['/preferences', 'GET'], ['/notifications/read-all', 'POST']]) {
    assert.equal((await call(base, p, { method: m, body: m === 'POST' ? {} : undefined })).status, 401, p);
  }
  server.close();
});
test('user id comes from auth, never from query/body: bob cannot read or mark alice\'s notifications', async () => {
  const { server, base, notifier } = await env();
  await notifier.notify({ to: 'alice', ...shipped, channels: ['in_app'] });
  const id = (await notifier.list('alice')).notifications[0].id;
  const bobList = await (await call(base, '/notifications?userId=alice', { token: 'bob' })).json();
  assert.equal(bobList.notifications.length, 0);
  assert.equal((await call(base, `/notifications/${id}/read`, { method: 'POST', token: 'bob', body: { userId: 'alice' } })).status, 404);
  assert.equal((await notifier.list('alice')).unreadCount, 1);
  const ok = await call(base, `/notifications/${id}/read`, { method: 'POST', token: 'alice', body: {} });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).unreadCount, 0);
  server.close();
});
test('mark all read, bad id, JSON content-type enforced (CSRF guard)', async () => {
  const { server, base, notifier } = await env();
  await notifier.notify({ to: 'alice', ...shipped, channels: ['in_app'] });
  assert.equal((await call(base, '/notifications/nope/read', { method: 'POST', token: 'alice', body: {} })).status, 400);
  const form = await fetch(base + '/notifications/read-all', { method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
  assert.equal(form.status, 415);
  assert.equal((await (await call(base, '/notifications/read-all', { method: 'POST', token: 'alice', body: {} })).json()).unreadCount, 0);
  server.close();
});
test('preferences: only boolean flags, email cannot be set by client', async () => {
  const { server, base, store } = await env();
  let r = await call(base, '/preferences', { method: 'PUT', token: 'alice', body: { email_marketing: true, email: 'evil@x.com' } });
  assert.equal(r.status, 200); assert.equal((await r.json()).email_marketing, true);
  assert.equal(store._dump().prefs.get('alice').email, undefined);
  assert.ok(store._dump().prefs.get('alice').marketing_consent_at);
  assert.equal((await call(base, '/preferences', { method: 'PUT', token: 'alice', body: { email_marketing: 'yes' } })).status, 400);
  assert.equal((await call(base, '/preferences', { method: 'PUT', token: 'alice', body: { email: 'x@y.com' } })).status, 400);
  server.close();
});
test('broadcast route: 401 anonymous, 403 normal user, success for admin', async () => {
  const { server, base, mailer } = await env();
  const body = { to: 'all', ...shipped, idempotencyKey: 'b1' };
  assert.equal((await call(base, '/admin/notify', { method: 'POST', body })).status, 401);
  assert.equal((await call(base, '/admin/notify', { method: 'POST', token: 'alice', body })).status, 403);
  const r = await call(base, '/admin/notify', { method: 'POST', token: 'admin', body });
  assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.recipients, 2); assert.equal(mailer.sent.length, 2);
  server.close();
});
test('broadcast route is not mounted without authorizeAdmin', async () => {
  const { server, base } = await env({ router: { authorizeAdmin: undefined } });
  assert.equal((await call(base, '/admin/notify', { method: 'POST', token: 'admin', body: { to: 'all', ...shipped, idempotencyKey: 'k' } })).status, 404);
  server.close();
});
test('admin cannot send arbitrary content unless allowCustomContent; bad input rejected', async () => {
  const { server, base } = await env();
  const post = (body) => call(base, '/admin/notify', { method: 'POST', token: 'admin', body });
  assert.equal((await post({ to: 'all', title: 'x', body: 'y', idempotencyKey: 'k' })).status, 400);
  assert.equal((await post({ to: 'all', type: 'nope', idempotencyKey: 'k' })).status, 400);
  assert.equal((await post({ to: 'all', ...shipped })).status, 400); // missing idempotencyKey
  assert.equal((await post({ to: 'all', type: 'order.shipped', data: { orderId: '1' }, idempotencyKey: 'k' })).status, 400); // missing var
  assert.equal((await post({ to: { $ne: 1 }, ...shipped, idempotencyKey: 'k' })).status, 400);
  server.close();
  const e2 = await env({ router: { allowCustomContent: true } });
  const ok = await call(e2.base, '/admin/notify', { method: 'POST', token: 'admin', body: { to: 'alice', title: 'Hi', body: 'There', link: '/x' } });
  assert.equal(ok.status, 200);
  const bad = await call(e2.base, '/admin/notify', { method: 'POST', token: 'admin', body: { to: 'alice', title: 'Hi', body: 'There', link: 'javascript:alert(1)' } });
  assert.equal(bad.status, 400);
  e2.server.close();
});
test('partial broadcast failure returns 207 with failures', async () => {
  const { fakeMailer } = await import('./helpers.js');
  const { server, base } = await env({ setup: { mailer: fakeMailer({ failFor: new Set(['bob@example.com']) }) } });
  const r = await call(base, '/admin/notify', { method: 'POST', token: 'admin', body: { to: 'all', ...shipped, idempotencyKey: 'p1' } });
  assert.equal(r.status, 207); const j = await r.json(); assert.equal(j.ok, false); assert.equal(j.failures.length, 1);
  server.close();
});
test('unsubscribe: GET does NOT change anything, POST does, bad token 400', async () => {
  const { server, base, notifier } = await env();
  await notifier.setPreferences('alice', { email_marketing: true });
  const token = new URL(notifier.createUnsubscribeUrl('alice')).searchParams.get('token');
  const g = await call(base, `/unsubscribe?token=${token}`);
  assert.equal(g.status, 200); assert.match(await g.text(), /<form/);
  assert.equal((await notifier.getPreferences('alice')).email_marketing, true);
  assert.equal((await call(base, `/unsubscribe?token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 200);
  assert.equal((await notifier.getPreferences('alice')).email_marketing, false);
  assert.equal((await call(base, '/unsubscribe?token=garbage')).status, 400);
  assert.equal((await call(base, '/unsubscribe?token=garbage', { method: 'POST' })).status, 400);
  server.close();
});
test('errors never leak internals', async () => {
  const { server, base, store } = await env();
  store.listNotifications = async () => { throw new Error('secret db password xyz'); };
  const r = await call(base, '/notifications', { token: 'alice' });
  assert.equal(r.status, 500); assert.ok(!(await r.text()).includes('secret'));
  server.close();
});
