import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeMailer } from './helpers.js';

const send = (n, extra = {}) => n.notify({ to: 'u1', type: 'order.shipped', data: { orderId: '1', total: '$5' }, ...extra });

test('same idempotency key twice: one notification, one email', async () => {
  const { notifier, mailer } = setup();
  const a = await send(notifier, { idempotencyKey: 'order-1' });
  const b = await send(notifier, { idempotencyKey: 'order-1' });
  assert.equal(a.notificationsCreated, 1); assert.equal(b.notificationsCreated, 0); assert.equal(b.duplicates, 1);
  assert.equal(b.email.alreadySent, 1);
  assert.equal(mailer.sent.length, 1);
  assert.equal((await notifier.list('u1')).notifications.length, 1);
});
test('concurrent calls with the same key send one email', async () => {
  const { notifier, mailer } = setup();
  await Promise.all(Array.from({ length: 10 }, () => send(notifier, { idempotencyKey: 'race' })));
  assert.equal(mailer.sent.length, 1);
  assert.equal((await notifier.list('u1')).notifications.length, 1);
});
test('no key means separate notifications', async () => {
  const { notifier } = setup();
  await send(notifier); await send(notifier);
  assert.equal((await notifier.list('u1')).notifications.length, 2);
});
test('broadcasts and lists require a key; bad keys rejected', async () => {
  const { notifier } = setup({ users: ['a'] });
  await assert.rejects(notifier.notify({ to: 'all', type: 'order.shipped', data: { orderId: '1', total: '1' } }), /idempotencyKey/);
  await assert.rejects(notifier.notify({ to: ['a', 'b'], title: 't', body: 'b' }), /idempotencyKey/);
  await assert.rejects(send(notifier, { idempotencyKey: 'bad key!' }), /Invalid idempotencyKey/);
});
test('retry after a failure resends only the failed delivery, never duplicates', async () => {
  const mailer = fakeMailer({ failFor: new Set(['u2@example.com']) });
  const { notifier } = setup({ mailer, users: ['u1', 'u2', 'u3'] });
  const input = { to: 'all', type: 'order.shipped', data: { orderId: '1', total: '$5' }, idempotencyKey: 'bc-1' };
  const first = await notifier.notify(input);
  assert.equal(first.ok, false);
  assert.equal(first.email.sent, 2); assert.equal(first.email.failed, 1);
  mailer.failFor.clear();
  const second = await notifier.notify(input);
  assert.equal(second.ok, true);
  assert.equal(second.email.sent, 1); assert.equal(second.email.alreadySent, 2);
  assert.equal(mailer.sent.length, 3);
  assert.equal(new Set(mailer.sent.map((m) => m.to)).size, 3);
});
test('retries stop after maxEmailAttempts', async () => {
  const mailer = fakeMailer({ failFor: new Set(['u1@example.com']) });
  const { notifier } = setup({ mailer, extra: { maxEmailAttempts: 2 } });
  const run = () => send(notifier, { idempotencyKey: 'k' });
  await run(); await run();
  const third = await run();
  assert.equal(third.email.failed, 0); assert.equal(third.email.alreadySent, 1);
});
test('broadcast pages through all users', async () => {
  const users = Array.from({ length: 12 }, (_, i) => `user${i}`);
  const { notifier, mailer } = setup({ users, extra: { pageSize: 5 } });
  const r = await notifier.notify({ to: 'all', title: 'Hi', body: 'Maintenance tonight', idempotencyKey: 'm1' });
  assert.equal(r.recipients, 12); assert.equal(mailer.sent.length, 12); assert.equal(r.ok, true);
});
