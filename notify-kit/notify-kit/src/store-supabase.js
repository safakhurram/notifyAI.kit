import { canClaim } from './claim.js';

const COLS = 'id,type,category,title,body,link,read_at,created_at';

function fail(error, what) {
  // Keep details out of the message (may include data); code is enough to debug.
  const e = new Error(`Supabase ${what} failed${error?.code ? ` (${error.code})` : ''}`);
  e.cause = error;
  throw e;
}

/**
 * Supabase store. SERVER ONLY: it needs the service-role key, which bypasses Row Level Security.
 * Pass an existing `client`, or `url` + `serviceRoleKey`.
 * `users` tells broadcasts where to read recipients (read-only): { table, idColumn, emailColumn }.
 */
export async function createSupabaseStore({ client, url, serviceRoleKey, users = { table: 'users', idColumn: 'id', emailColumn: 'email' } }) {
  if (typeof window !== 'undefined') {
    throw new Error('notify-kit store must run on the server. Never use the service-role key in a browser.');
  }
  let db = client;
  if (!db) {
    if (!url || !serviceRoleKey) throw new Error('Supabase url and serviceRoleKey are required');
    const { createClient } = await import('@supabase/supabase-js');
    db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  const now = () => new Date().toISOString();

  return {
    async getPreferences(ids) {
      const m = new Map();
      if (!ids.length) return m;
      const { data, error } = await db.from('notify_preferences').select('*').in('user_id', ids);
      if (error) fail(error, 'getPreferences');
      for (const r of data) m.set(r.user_id, r);
      return m;
    },
    async setPreferences(userId, patch) {
      const { data, error } = await db.from('notify_preferences')
        .upsert({ user_id: userId, ...patch, updated_at: now() }, { onConflict: 'user_id' }).select().single();
      if (error) fail(error, 'setPreferences');
      return data;
    },
    async insertNotification(rec) {
      const { data, error } = await db.from('notify_notifications').insert(rec).select().single();
      if (!error) return { row: data, created: true };
      if (error.code === '23505' && rec.idempotency_key) {
        const r = await db.from('notify_notifications').select('*')
          .eq('user_id', rec.user_id).eq('idempotency_key', rec.idempotency_key).single();
        if (r.error) fail(r.error, 'insertNotification(lookup)');
        return { row: r.data, created: false };
      }
      return fail(error, 'insertNotification');
    },
    async claimDelivery(notificationId, channel, opts) {
      const ins = await db.from('notify_deliveries')
        .insert({ notification_id: notificationId, channel, status: 'pending', attempts: 0 });
      if (ins.error && ins.error.code !== '23505') fail(ins.error, 'claimDelivery(insert)');
      const sel = await db.from('notify_deliveries').select('*')
        .eq('notification_id', notificationId).eq('channel', channel).single();
      if (sel.error) fail(sel.error, 'claimDelivery(select)');
      const row = sel.data;
      if (!canClaim(row, opts)) return null;
      // Optimistic lock: only one worker can flip this exact (status, attempts) pair.
      const upd = await db.from('notify_deliveries')
        .update({ status: 'sending', attempts: row.attempts + 1, claimed_at: now() })
        .eq('id', row.id).eq('status', row.status).eq('attempts', row.attempts).select();
      if (upd.error) fail(upd.error, 'claimDelivery(update)');
      return upd.data?.length === 1 ? upd.data[0] : null;
    },
    async finishDelivery(id, { status, error = null }) {
      const patch = { status, last_error: error, ...(status === 'sent' ? { sent_at: now() } : {}) };
      const { error: e } = await db.from('notify_deliveries').update(patch).eq('id', id);
      if (e) fail(e, 'finishDelivery');
    },
    async listNotifications(userId, { limit = 20, before, unreadOnly = false } = {}) {
      let q = db.from('notify_notifications').select(COLS).eq('user_id', userId).eq('hidden', false)
        .order('created_at', { ascending: false }).limit(limit + 1);
      if (before) q = q.lt('created_at', before);
      if (unreadOnly) q = q.is('read_at', null);
      const { data, error } = await q;
      if (error) fail(error, 'listNotifications');
      return data;
    },
    async unreadCount(userId) {
      const { count, error } = await db.from('notify_notifications').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('hidden', false).is('read_at', null);
      if (error) fail(error, 'unreadCount');
      return count ?? 0;
    },
    async markRead(userId, id) {
      const { data, error } = await db.from('notify_notifications').update({ read_at: now() })
        .eq('id', id).eq('user_id', userId).is('read_at', null).select('id');
      if (error) fail(error, 'markRead');
      if (data.length) return true;
      const ex = await db.from('notify_notifications').select('id').eq('id', id).eq('user_id', userId);
      if (ex.error) fail(ex.error, 'markRead(lookup)');
      return ex.data.length === 1;
    },
    async markAllRead(userId) {
      const { data, error } = await db.from('notify_notifications').update({ read_at: now() })
        .eq('user_id', userId).eq('hidden', false).is('read_at', null).select('id');
      if (error) fail(error, 'markAllRead');
      return data.length;
    },
    async recordBroadcast(rec) {
      const { data, error } = await db.from('notify_broadcasts')
        .upsert(rec, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select();
      if (error) fail(error, 'recordBroadcast');
      return data?.[0] ?? rec;
    },
    /** Read-only page of users, ordered by id. `after` is the last id of the previous page. */
    async listUsers({ after, limit = 500 } = {}) {
      const cols = users.emailColumn ? `${users.idColumn},${users.emailColumn}` : users.idColumn;
      let q = db.from(users.table).select(cols).order(users.idColumn, { ascending: true }).limit(limit);
      if (after) q = q.gt(users.idColumn, after);
      const { data, error } = await q;
      if (error) fail(error, 'listUsers');
      const list = data.map((r) => ({ id: String(r[users.idColumn]), email: users.emailColumn ? r[users.emailColumn] ?? null : null }));
      return { users: list, next: list.length === limit ? list[list.length - 1].id : null };
    },
  };
}
