// Browser-safe: contains NO secrets. Talks only to YOUR server's notify router.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';

const isSafeLink = (l) => typeof l === 'string' && (/^\/(?!\/)/.test(l) || /^https:\/\//i.test(l) || /^http:\/\/localhost(:\d+)?\//i.test(l));

/** getHeaders: async () => ({ Authorization: 'Bearer <user token>' }). Your server decides who the user is. */
export function createNotifyClient({ baseUrl, getHeaders = async () => ({}), fetch: f } = {}) {
  if (!baseUrl) throw new Error('baseUrl is required');
  const root = baseUrl.replace(/\/$/, '');
  async function req(path, { method = 'GET', body } = {}) {
    const fetchFn = f ?? globalThis.fetch.bind(globalThis);
    const res = await fetchFn(root + path, {
      method,
      headers: { ...(await getHeaders()), ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }
  return {
    list: ({ limit = 20, before, unread } = {}) =>
      req(`/notifications?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}${unread ? '&unread=1' : ''}`),
    markRead: (id) => req(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    markAllRead: () => req('/notifications/read-all', { method: 'POST' }),
    getPreferences: () => req('/preferences'),
    setPreferences: (p) => req('/preferences', { method: 'PUT', body: p }),
  };
}

export function useNotifications(client, { pollMs = 30000, limit = 20 } = {}) {
  const [state, setState] = useState({ items: [], unread: 0, loading: true, error: null });
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const r = await client.list({ limit });
      if (alive.current) setState({ items: r.notifications, unread: r.unreadCount, loading: false, error: null });
    } catch { if (alive.current) setState((s) => ({ ...s, loading: false, error: 'Could not load notifications' })); }
  }, [client, limit]);
  useEffect(() => {
    alive.current = true; refresh();
    const t = pollMs > 0 ? setInterval(refresh, pollMs) : null;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [refresh, pollMs]);
  const markRead = useCallback(async (id) => { try { await client.markRead(id); } finally { await refresh(); } }, [client, refresh]);
  const markAllRead = useCallback(async () => { try { await client.markAllRead(); } finally { await refresh(); } }, [client, refresh]);
  return { ...state, refresh, markRead, markAllRead };
}

/** <NotificationBell client={client} onNavigate={(link) => navigate(link)} /> */
export function NotificationBell({ client, pollMs, limit, onNavigate, label = 'Notifications' }) {
  const [open, setOpen] = useState(false);
  const { items, unread, loading, error, markRead, markAllRead } = useNotifications(client, { pollMs, limit });
  const click = (n) => {
    if (!n.read) markRead(n.id);
    if (isSafeLink(n.link)) { if (onNavigate) onNavigate(n.link); else if (typeof window !== 'undefined') window.location.assign(n.link); }
  };
  return h('div', { style: { position: 'relative', display: 'inline-block' } },
    h('button', { type: 'button', 'aria-label': `${label}${unread ? `, ${unread} unread` : ''}`, 'aria-expanded': open, onClick: () => setOpen(!open) },
      '\u{1F514}', unread > 0 ? h('span', { 'data-testid': 'unread-badge', style: { marginLeft: 4, fontSize: 12 } }, unread > 99 ? '99+' : String(unread)) : null),
    open ? h('div', { role: 'dialog', 'aria-label': label, style: { position: 'absolute', right: 0, width: 320, maxHeight: 400, overflow: 'auto', background: '#fff', color: '#111', border: '1px solid #ddd', borderRadius: 8, zIndex: 1000 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: 8 } }, h('strong', null, label),
        unread > 0 ? h('button', { type: 'button', onClick: markAllRead }, 'Mark all as read') : null),
      error ? h('p', { role: 'alert', style: { padding: 8 } }, error) : null,
      !loading && !error && items.length === 0 ? h('p', { style: { padding: 8 } }, 'No notifications yet.') : null,
      h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, items.map((n) =>
        h('li', { key: n.id }, h('button', { type: 'button', onClick: () => click(n), style: { all: 'unset', cursor: 'pointer', display: 'block', width: '100%', padding: 8, boxSizing: 'border-box', background: n.read ? 'transparent' : '#eef4ff' } },
          h('div', { style: { fontWeight: n.read ? 400 : 700 } }, n.title), h('div', { style: { fontSize: 13 } }, n.body)))))) : null);
}
