import test from 'node:test';
import assert from 'node:assert/strict';

let React, renderToString, mod;
try {
  React = await import('react'); ({ renderToString } = await import('react-dom/server')); mod = await import('../src/react.js');
} catch { /* react not installed */ }
const skip = !mod && 'react / react-dom not installed (run npm install)';

test('NotificationBell renders and exports exist', { skip }, () => {
  const client = mod.createNotifyClient({ baseUrl: 'http://x', fetch: async () => ({ ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) }) });
  const html = renderToString(React.createElement(mod.NotificationBell, { client }));
  assert.match(html, /aria-label="Notifications"/);
  assert.equal(typeof mod.useNotifications, 'function');
});
test('client sends auth headers, JSON content-type, and never a user id', { skip }, async () => {
  const calls = [];
  const client = mod.createNotifyClient({ baseUrl: 'http://x/notify/', getHeaders: async () => ({ Authorization: 'Bearer t' }),
    fetch: async (u, init) => { calls.push({ u, init }); return { ok: true, json: async () => ({}) }; } });
  await client.list({ limit: 5 }); await client.markRead('abc'); await client.setPreferences({ email_marketing: true });
  assert.equal(calls[0].u, 'http://x/notify/notifications?limit=5');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  assert.equal(calls[1].init.method, 'POST'); assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.ok(!JSON.stringify(calls).includes('userId'));
});
test('client throws on HTTP errors', { skip }, async () => {
  const client = mod.createNotifyClient({ baseUrl: 'http://x', fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(client.list(), /401/);
});
test('react.js has no secrets or server imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/react.js', import.meta.url), 'utf8');
  assert.ok(!/service|supabase|nodemailer|process\.env/i.test(src));
});
