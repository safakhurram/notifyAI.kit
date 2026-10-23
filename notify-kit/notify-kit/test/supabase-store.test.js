import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore } from '../src/store-supabase.js';

// NOTE: this is NOT a real Supabase test. It uses a tiny fake client to check that claimDelivery's
// optimistic lock works and that duplicate-key errors are handled. Real integration needs real credentials.
function fakeDb() {
  const tables = { notify_deliveries: [], notify_notifications: [] };
  const builder = (name) => {
    const f = { filters: [], op: null, row: null, patch: null };
    const api = {
      insert(row) { f.op = 'insert'; f.row = row; return api; },
      update(p) { f.op = 'update'; f.patch = p; return api; },
      select() { if (!f.op) f.op = 'select'; return api; },
      eq(k, v) { f.filters.push([k, v]); return api; },
      single() { f.single = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const t = tables[name];
      const match = (r) => f.filters.every(([k, v]) => r[k] === v);
      if (f.op === 'insert') {
        if (name === 'notify_deliveries' && t.some((r) => r.notification_id === f.row.notification_id && r.channel === f.row.channel)) return { error: { code: '23505' } };
        if (name === 'notify_notifications') { const dup = t.find((r) => r.user_id === f.row.user_id && r.idempotency_key === f.row.idempotency_key && f.row.idempotency_key); if (dup) return { error: { code: '23505' } }; }
        const row = { id: `id${t.length + 1}`, ...f.row }; t.push(row); return { data: row, error: null };
      }
      if (f.op === 'update') { const rows = t.filter(match); rows.forEach((r) => Object.assign(r, f.patch)); return { data: rows, error: null }; }
      const rows = t.filter(match);
      return f.single ? { data: rows[0], error: rows[0] ? null : { code: 'PGRST116' } } : { data: rows, error: null };
    }
    return api;
  };
  return { from: builder, tables };
}

test('refuses to run in a browser', async () => {
  globalThis.window = {};
  try { await assert.rejects(createSupabaseStore({ client: {} }), /server/); } finally { delete globalThis.window; }
});
test('requires url and key when no client is given', async () => {
  await assert.rejects(createSupabaseStore({}), /required/);
});
test('claimDelivery: only one of two racing workers wins; sent rows are never re-claimed', async () => {
  const db = fakeDb(); const store = await createSupabaseStore({ client: db });
  const opts = { maxAttempts: 3, staleMs: 600000 };
  const [a, b] = await Promise.all([store.claimDelivery('n1', 'email', opts), store.claimDelivery('n1', 'email', opts)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  await store.finishDelivery((a ?? b).id, { status: 'sent' });
  assert.equal(await store.claimDelivery('n1', 'email', opts), null);
});
test('insertNotification: duplicate key returns existing row with created=false', async () => {
  const db = fakeDb(); const store = await createSupabaseStore({ client: db });
  const rec = { user_id: 'u', idempotency_key: 'k', title: 't' };
  const first = await store.insertNotification(rec); const second = await store.insertNotification(rec);
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(second.row.id, first.row.id);
});
