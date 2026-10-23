import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { verifyAiCopy, createAiProvider } from '../src/ai.js';

const run = (gen) => setup({ ai: { generate: gen, timeoutMs: 100 } }).notifier
  .notify({ to: 'u1', type: 'ai.copy', data: { orderId: '77' }, channels: ['in_app'] });
const first = async (n) => (await n.list('u1')).notifications[0];

test('good AI rewrite is used', async () => {
  const s = setup({ ai: { generate: async () => ({ title: 'Good news: order 77 is on the way', body: 'Order 77 ships on 12 May.' }) } });
  const r = await s.notifier.notify({ to: 'u1', type: 'ai.copy', data: { orderId: '77' }, channels: ['in_app'] });
  assert.equal(r.copySource, 'ai');
  assert.equal((await first(s.notifier)).title, 'Good news: order 77 is on the way');
});
test('invented number/date/price/URL/email falls back to template', async () => {
  for (const body of ['Order 77 ships on 13 May.', 'Order 77 ships on 12 May. Save 50 now.', 'Order 77 ships 12 May. Visit https://evil.test', 'Order 77 ships 12 May. Mail a@b.com']) {
    const s = setup({ ai: { generate: async () => ({ title: 'Order 77 shipped', body }) } });
    const r = await s.notifier.notify({ to: 'u1', type: 'ai.copy', data: { orderId: '77' }, channels: ['in_app'] });
    assert.equal(r.copySource, 'template', body);
    assert.equal((await first(s.notifier)).body, 'Your order 77 ships on 12 May.');
  }
});
test('AI error, timeout and garbage fall back and still deliver', async () => {
  for (const gen of [async () => { throw new Error('HTTP 500'); }, () => new Promise(() => {}), async () => 'nope', async () => ({ title: 1 })]) {
    const s = setup({ ai: { generate: gen, timeoutMs: 50 } });
    const r = await s.notifier.notify({ to: 'u1', type: 'ai.copy', data: { orderId: '77' }, channels: ['in_app'] });
    assert.equal(r.ok, true); assert.equal(r.copySource, 'template');
  }
});
test('AI is only used for templates that opt in, never for custom content', async () => {
  let calls = 0;
  const s = setup({ ai: { generate: async () => { calls++; return { title: 'x', body: 'y' }; } } });
  await s.notifier.notify({ to: 'u1', type: 'order.shipped', data: { orderId: '1', total: '$5' }, channels: ['in_app'] });
  await s.notifier.notify({ to: 'u1', title: 'T', body: 'B', channels: ['in_app'] });
  assert.equal(calls, 0);
});
test('verifyAiCopy rejects markup and placeholders', () => {
  const src = { title: 'A', body: 'B' };
  assert.throws(() => verifyAiCopy(src, { title: 'A', body: '<b>B</b>' }));
  assert.throws(() => verifyAiCopy(src, { title: 'A', body: '{{x}}' }));
  assert.throws(() => verifyAiCopy(src, { title: 'A', body: 'x'.repeat(2000) }));
});
test('OpenAI-compatible provider: request shape, key in header only, JSON fences parsed', async () => {
  let seen;
  const p = createAiProvider({ apiKey: 'sk-test', model: 'm', fetch: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"title":"T","body":"B"}\n```' } }] }) }; } });
  const out = await p.generate({ title: 'T', body: 'B' });
  assert.deepEqual(out, { title: 'T', body: 'B' });
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.ok(!seen.init.body.includes('sk-test'));
  assert.throws(() => createAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://evil.com' }), /https/);
});
