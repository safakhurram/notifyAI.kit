import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeMailer } from './helpers.js';
import { buildEmail } from '../src/mailer.js';
import { createRouter } from '../src/router.js';

test('failed email is reported as failure, never as success; in-app still delivered', async () => {
  const mailer = fakeMailer({ failFor: new Set(['u1@example.com']) });
  const { notifier, store } = setup({ mailer });
  const r = await notifier.notify({ to: 'u1', title: 'Hello', body: 'World' });
  assert.equal(r.ok, false); assert.equal(r.email.sent, 0); assert.equal(r.email.failed, 1);
  assert.equal(r.failures[0].stage, 'email');
  assert.ok(!JSON.stringify(r).includes('u1@example.com'), 'email address must be redacted');
  assert.equal((await notifier.list('u1')).notifications.length, 1);
  const d = [...store._dump().deliveries.values()][0];
  assert.equal(d.status, 'failed'); assert.ok(!d.last_error.includes('@example.com'));
});
test('partial broadcast failure: others succeed, failures listed, ok=false', async () => {
  const mailer = fakeMailer({ failFor: new Set(['b@example.com']) });
  const { notifier } = setup({ mailer, users: ['a', 'b', 'c'] });
  const r = await notifier.notify({ to: 'all', title: 'T', body: 'B', idempotencyKey: 'x' });
  assert.equal(r.ok, false); assert.equal(r.email.sent, 2); assert.deepEqual(r.failures.map((f) => f.userId), ['b']);
});
test('store failure for one user does not abort the rest', async () => {
  const { notifier, store } = setup({ users: ['a', 'b', 'c'] });
  const orig = store.insertNotification;
  store.insertNotification = async (rec) => { if (rec.user_id === 'b') throw new Error('db down'); return orig(rec); };
  const r = await notifier.notify({ to: 'all', title: 'T', body: 'B', idempotencyKey: 'y' });
  assert.equal(r.ok, false); assert.equal(r.notificationsCreated, 2); assert.equal(r.failures[0].userId, 'b');
});
test('listUsers failure is reported', async () => {
  const { notifier } = setup({ extra: { listUsers: async () => { throw new Error('boom'); } } });
  const r = await notifier.notify({ to: 'all', title: 'T', body: 'B', idempotencyKey: 'z' });
  assert.equal(r.ok, false); assert.equal(r.failures[0].stage, 'listUsers');
});
test('preference lookup failure sends nothing (no consent info = no send)', async () => {
  const { notifier, store, mailer } = setup();
  store.getPreferences = async () => { throw new Error('db'); };
  const r = await notifier.notify({ to: 'u1', title: 'T', body: 'B' });
  assert.equal(r.ok, false); assert.equal(mailer.sent.length, 0);
});
test('no mailer: in-app only, no email errors', async () => {
  const { notifier } = setup({ mailer: null });
  const r = await notifier.notify({ to: 'u1', title: 'T', body: 'B' });
  assert.equal(r.ok, true); assert.equal(r.email.sent, 0);
});
test('in-app disabled: hidden from inbox, email still sent once', async () => {
  const { notifier, mailer } = setup();
  await notifier.setPreferences('u1', { in_app_enabled: false });
  await notifier.notify({ to: 'u1', title: 'T', body: 'B', idempotencyKey: 'h' });
  assert.equal((await notifier.list('u1')).notifications.length, 0);
  assert.equal(mailer.sent.length, 1);
});
test('invalid recipient address is skipped, not sent', async () => {
  const { notifier, mailer } = setup({ extra: { getEmail: async () => 'not-an-email' } });
  const r = await notifier.notify({ to: 'u1', title: 'T', body: 'B' });
  assert.equal(r.email.skipped, 1); assert.equal(mailer.sent.length, 0);
});
test('email content escapes HTML and strips header newlines', () => {
  const m = buildEmail({ title: 'Hi\r\nBcc: x@y.com <b>', body: '<script>alert(1)</script>', link: '/a', category: 'transactional', appUrl: 'https://app.example.com' });
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.ok(!m.html.includes('<script>')); assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(m.text.includes('https://app.example.com/a'));
});
test('marketing email without unsubscribe config is refused loudly', async () => {
  const { notifier } = setup({ extra: { unsubscribe: null } });
  await assert.rejects(notifier.notify({ to: 'u1', type: 'promo.sale' }), /unsubscribe/);
});
test('config validation', async () => {
  const { createNotifier, createMemoryStore } = await import('../src/index.js');
  assert.throws(() => createNotifier({}), /store/);
  assert.throws(() => createNotifier({ store: createMemoryStore(), mailer: {} }), /appUrl/);
  assert.throws(() => createNotifier({ store: createMemoryStore(), unsubscribe: { secret: 'short', url: 'x' } }), /32/);
  assert.throws(() => createNotifier({ store: createMemoryStore(), templates: { a: { title: 1 } } }), /needs string/);
});
test('env validation lists all problems and rejects placeholders', async () => {
  const { readEnvConfig } = await import('../src/index.js');
  assert.throws(() => readEnvConfig({}), /SUPABASE_URL is missing[\s\S]*NOTIFY_UNSUBSCRIBE_SECRET/);
  assert.throws(() => readEnvConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'replace-with-service-role-key', NOTIFY_UNSUBSCRIBE_SECRET: 'x'.repeat(40), NOTIFY_APP_URL: 'https://a.com', NOTIFY_UNSUBSCRIBE_URL: 'https://a.com/u' }), /SERVICE_ROLE_KEY is missing/);
  const ok = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(30), NOTIFY_UNSUBSCRIBE_SECRET: 'x'.repeat(40), NOTIFY_APP_URL: 'https://a.com', NOTIFY_UNSUBSCRIBE_URL: 'https://a.com/u' };
  assert.equal(readEnvConfig(ok).smtp, null);
  assert.throws(() => readEnvConfig({ ...ok, SMTP_HOST: 'h' }), /SMTP_FROM/);
  assert.throws(() => readEnvConfig({ ...ok, AI_API_KEY: 'k' }), /AI_MODEL/);
});
test('router requires authenticate', () => {
  assert.throws(() => createRouter({ notifier: {} }), /authenticate/);
});
