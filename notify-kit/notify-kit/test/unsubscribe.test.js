import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnsubscribeToken, verifyUnsubscribeToken } from '../src/unsubscribe.js';
import { SECRET, setup } from './helpers.js';

test('round trip', () => {
  const t = createUnsubscribeToken(SECRET, { userId: 'u1' });
  assert.deepEqual(verifyUnsubscribeToken(SECRET, t), { userId: 'u1', category: 'marketing' });
});
test('tampered payload, tampered signature, wrong secret, junk all rejected', () => {
  const t = createUnsubscribeToken(SECRET, { userId: 'u1' });
  const [p, s] = t.split('.');
  const evil = Buffer.from(JSON.stringify({ v: 1, u: 'victim', c: 'marketing' })).toString('base64url');
  for (const bad of [`${evil}.${s}`, `${p}.${s.slice(0, -2)}AA`, `${p}.`, 'junk', '', 'a.b.c', `${p}.${s}.x`]) {
    assert.throws(() => verifyUnsubscribeToken(SECRET, bad), /Invalid/, bad);
  }
  assert.throws(() => verifyUnsubscribeToken('b'.repeat(40), t), /Invalid/);
  assert.throws(() => verifyUnsubscribeToken(undefined, t), /at least 32/);
  assert.throws(() => createUnsubscribeToken('short', { userId: 'u' }), /at least 32/);
});
test('non-marketing category in a signed token is rejected', async () => {
  const { createHmac } = await import('node:crypto');
  const p = Buffer.from(JSON.stringify({ v: 1, u: 'u1', c: 'transactional' })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(p).digest().toString('base64url');
  assert.throws(() => verifyUnsubscribeToken(SECRET, `${p}.${sig}`), /Invalid/);
});
test('handleUnsubscribe turns marketing off and marketing email stops', async () => {
  const { notifier, mailer } = setup();
  await notifier.setPreferences('u1', { email_marketing: true });
  let r = await notifier.notify({ to: 'u1', type: 'promo.sale', idempotencyKey: 'promo-1' });
  assert.equal(r.email.sent, 1);
  const link = mailer.sent[0].text.match(/Unsubscribe: (\S+)/)[1];
  assert.match(mailer.sent[0].headers['List-Unsubscribe'], /^<https:\/\/api\.example\.com/);
  await notifier.handleUnsubscribe(new URL(link).searchParams.get('token'));
  assert.equal((await notifier.getPreferences('u1')).email_marketing, false);
  r = await notifier.notify({ to: 'u1', type: 'promo.sale', idempotencyKey: 'promo-2' });
  assert.equal(r.email.sent, 0);
  assert.equal(mailer.sent.length, 1);
});
test('marketing is opt-in; transactional ignores marketing opt-out and has no unsubscribe footer', async () => {
  const { notifier, mailer } = setup();
  let r = await notifier.notify({ to: 'u2', type: 'promo.sale', idempotencyKey: 'p1' });
  assert.equal(r.email.sent, 0); assert.equal(r.email.skipped, 1);
  r = await notifier.notify({ to: 'u2', type: 'order.shipped', data: { orderId: '9', total: '$5' } });
  assert.equal(r.email.sent, 1);
  assert.ok(!/Unsubscribe/.test(mailer.sent[0].text));
});
