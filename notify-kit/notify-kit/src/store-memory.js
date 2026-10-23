import { randomUUID } from 'node:crypto';
import { canClaim } from './claim.js';

/** In-memory store: for tests and local experiments only. Data is lost on restart. */
export function createMemoryStore() {
  const prefs = new Map();
  const notifs = new Map();
  const byKey = new Map();
  const deliveries = new Map();
  const broadcasts = new Map();
  const now = () => new Date().toISOString();

  return {
    _dump: () => ({ prefs, notifs, deliveries, broadcasts }),
    async getPreferences(ids) {
      const m = new Map();
      for (const id of ids) if (prefs.has(id)) m.set(id, { ...prefs.get(id) });
      return m;
    },
    async setPreferences(userId, patch) {
      const row = { ...(prefs.get(userId) ?? { user_id: userId }), ...patch, updated_at: now() };
      prefs.set(userId, row);
      return { ...row };
    },
    async insertNotification(rec) {
      if (rec.idempotency_key) {
        const k = `${rec.user_id}\u0000${rec.idempotency_key}`;
        if (byKey.has(k)) return { row: { ...notifs.get(byKey.get(k)) }, created: false };
        const row = { id: randomUUID(), read_at: null, created_at: now(), ...rec };
        notifs.set(row.id, row); byKey.set(k, row.id);
        return { row: { ...row }, created: true };
      }
      const row = { id: randomUUID(), read_at: null, created_at: now(), ...rec };
      notifs.set(row.id, row);
      return { row: { ...row }, created: true };
    },
    async claimDelivery(notificationId, channel, opts) {
      const k = `${notificationId}:${channel}`;
      let row = deliveries.get(k);
      if (!row) {
        row = { id: randomUUID(), notification_id: notificationId, channel, status: 'pending', attempts: 0, claimed_at: null };
        deliveries.set(k, row);
      }
      if (!canClaim(row, opts)) return null;
      row.status = 'sending'; row.attempts += 1; row.claimed_at = now();
      return { ...row };
    },
    async finishDelivery(id, { status, error = null }) {
      for (const r of deliveries.values()) if (r.id === id) {
        r.status = status; r.last_error = error;
        if (status === 'sent') r.sent_at = now();
      }
    },
    async listNotifications(userId, { limit = 20, before, unreadOnly = false } = {}) {
      let rows = [...notifs.values()].filter((n) => n.user_id === userId && !n.hidden);
      if (unreadOnly) rows = rows.filter((n) => !n.read_at);
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      if (before) rows = rows.filter((n) => n.created_at < before);
      return rows.slice(0, limit + 1).map((n) => ({ ...n }));
    },
    async unreadCount(userId) {
      return [...notifs.values()].filter((n) => n.user_id === userId && !n.hidden && !n.read_at).length;
    },
    async markRead(userId, id) {
      const n = notifs.get(id);
      if (!n || n.user_id !== userId) return false;
      if (!n.read_at) n.read_at = now();
      return true;
    },
    async markAllRead(userId) {
      let c = 0;
      for (const n of notifs.values()) if (n.user_id === userId && !n.hidden && !n.read_at) { n.read_at = now(); c++; }
      return c;
    },
    async recordBroadcast(rec) {
      if (!broadcasts.has(rec.idempotency_key)) broadcasts.set(rec.idempotency_key, { id: randomUUID(), ...rec });
      return { ...broadcasts.get(rec.idempotency_key) };
    },
    async listUsers() { return { users: [], next: null }; },
  };
}
