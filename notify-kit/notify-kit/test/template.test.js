import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, validateLink } from '../src/template.js';
import { setup } from './helpers.js';

test('renders variables, including nested', () => {
  assert.equal(renderTemplate('Hi {{user.name}}, #{{n}}', { user: { name: 'Sam' }, n: 5 }), 'Hi Sam, #5');
});
test('missing variable throws instead of guessing', () => {
  assert.throws(() => renderTemplate('Hi {{name}}', {}), /Missing/);
  assert.throws(() => renderTemplate('Hi {{o}}', { o: { a: 1 } }), /Missing/);
});
test('prototype keys are not readable', () => {
  assert.throws(() => renderTemplate('{{constructor}}', {}), /Missing/);
});
test('malformed placeholder rejected', () => {
  assert.throws(() => renderTemplate('Hi {{ bad name }}', {}), /malformed/);
});
test('link variables are URL-encoded', async () => {
  const { notifier, store } = setup();
  await notifier.notify({ to: 'u1', type: 'order.shipped', data: { orderId: 'a/b?x=1', total: '$5' }, channels: ['in_app'] });
  const [n] = (await notifier.list('u1')).notifications;
  assert.equal(n.link, '/orders/a%2Fb%3Fx%3D1');
});
test('invalid links are rejected', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '//evil.com', 'http://example.com', 'https://u:p@example.com', '/a b', 'ftp://x.com', '\\\\evil', 'https://']) {
    assert.throws(() => validateLink(bad), /Invalid link/, bad);
  }
});
test('valid links accepted; host allow-list enforced', () => {
  assert.equal(validateLink('/orders/1'), '/orders/1');
  assert.equal(validateLink('https://app.example.com/x'), 'https://app.example.com/x');
  assert.equal(validateLink('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.throws(() => validateLink('https://evil.com/x', { allowedHosts: ['app.example.com'] }), /not allowed/);
});
test('custom notify() with a bad link fails before anything is stored', async () => {
  const { notifier } = setup();
  await assert.rejects(notifier.notify({ to: 'u1', title: 't', body: 'b', link: 'javascript:alert(1)' }), /Invalid link/);
  assert.equal((await notifier.list('u1')).notifications.length, 0);
});
test('unknown template type and prototype names rejected', async () => {
  const { notifier } = setup();
  await assert.rejects(notifier.notify({ to: 'u1', type: 'nope' }), /Unknown/);
  await assert.rejects(notifier.notify({ to: 'u1', type: 'constructor' }), /Unknown/);
});
