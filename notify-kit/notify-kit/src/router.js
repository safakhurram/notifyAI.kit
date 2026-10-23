import { NotifyError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * createRouter({ notifier, authenticate, authorizeAdmin?, allowCustomContent? }) -> (req, res, next) handler.
 * Works with Express (`app.use('/notify', express.json(), router)`) or plain node:http.
 *
 *  authenticate(req)   REQUIRED. Return { userId } for the logged-in user (or null). The user id ALWAYS
 *                      comes from here, never from the request body/query.
 *  authorizeAdmin(req) OPTIONAL. Return true only for admins. If omitted, the broadcast route is NOT mounted.
 *  allowCustomContent  default false: admin routes may only use registered templates.
 */
export function createRouter({ notifier, authenticate, authorizeAdmin, allowCustomContent = false }) {
  if (!notifier) throw new Error('createRouter needs a notifier');
  if (typeof authenticate !== 'function') throw new Error('createRouter needs an authenticate(req) function');

  const send = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  };
  const page = (res, status, html) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", 'Referrer-Policy': 'no-referrer',
    });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:480px;margin:10vh auto;padding:0 16px">${html}</body>`);
  };

  async function user(req) {
    let u = null;
    try { u = await authenticate(req); } catch { u = null; }
    if (!u || typeof u.userId !== 'string' || !u.userId) throw new NotifyError('Not authenticated', 401, 'unauthenticated');
    return u.userId;
  }
  const needJson = (req) => {
    if (!String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new NotifyError('Content-Type must be application/json', 415, 'unsupported_media_type');
    }
    if (req.body === undefined) throw new NotifyError('Request body missing. Mount express.json() before this router.', 400);
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new NotifyError('JSON object expected');
    return req.body;
  };

  return async function notifyRouter(req, res, next) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    try {
      // ---------- public: unsubscribe (signed token is the credential) ----------
      if (path === '/unsubscribe' && (m === 'GET' || m === 'POST')) {
        const token = url.searchParams.get('token') ?? '';
        if (m === 'GET') { // GET must not change anything: email scanners pre-fetch links.
          try { notifier.checkUnsubscribeToken(token); }
          catch { return page(res, 400, '<h2>Invalid link</h2><p>This unsubscribe link is invalid or incomplete.</p>'); }
          return page(res, 200, `<h2>Unsubscribe from marketing emails?</h2><form method="POST" action="?token=${encodeURIComponent(token)}"><button type="submit" style="padding:10px 16px">Yes, unsubscribe me</button></form>`);
        }
        try { await notifier.handleUnsubscribe(token); }
        catch (e) {
          if (e instanceof NotifyError && e.code === 'bad_token') return page(res, 400, '<h2>Invalid link</h2><p>This unsubscribe link is invalid.</p>');
          throw e;
        }
        return page(res, 200, '<h2>You are unsubscribed</h2><p>You will no longer receive marketing emails.</p>');
      }

      // ---------- signed-in user routes ----------
      if (path === '/notifications' && m === 'GET') {
        const userId = await user(req);
        const q = url.searchParams;
        return send(res, 200, await notifier.list(userId, { limit: q.get('limit'), before: q.get('before') ?? undefined, unreadOnly: q.get('unread') === '1' }));
      }
      if (path === '/notifications/read-all' && m === 'POST') {
        const userId = await user(req); needJson(req);
        return send(res, 200, { updated: await notifier.markAllRead(userId), unreadCount: await notifier.unreadCount(userId) });
      }
      const mm = path.match(/^\/notifications\/([^/]+)\/read$/);
      if (mm && m === 'POST') {
        const userId = await user(req); needJson(req);
        if (!UUID.test(mm[1])) throw new NotifyError('Invalid id');
        if (!(await notifier.markRead(userId, mm[1]))) throw new NotifyError('Not found', 404, 'not_found');
        return send(res, 200, { ok: true, unreadCount: await notifier.unreadCount(userId) });
      }
      if (path === '/preferences' && m === 'GET') return send(res, 200, await notifier.getPreferences(await user(req)));
      if (path === '/preferences' && m === 'PUT') {
        const userId = await user(req); const body = needJson(req);
        const patch = {};
        for (const k of ['in_app_enabled', 'email_transactional', 'email_marketing']) if (body[k] !== undefined) patch[k] = body[k];
        await notifier.setPreferences(userId, patch); // email address is NOT accepted from clients
        return send(res, 200, await notifier.getPreferences(userId));
      }

      // ---------- admin: send / broadcast (only mounted if authorizeAdmin is provided) ----------
      if (path === '/admin/notify' && m === 'POST' && typeof authorizeAdmin === 'function') {
        let ok = false;
        await user(req);
        try { ok = (await authorizeAdmin(req)) === true; } catch { ok = false; }
        if (!ok) throw new NotifyError('Forbidden', 403, 'forbidden');
        const b = needJson(req);
        const input = { to: b.to, idempotencyKey: b.idempotencyKey, channels: b.channels };
        if (b.type !== undefined) {
          if (typeof b.type !== 'string' || !notifier.hasTemplate(b.type)) throw new NotifyError('Unknown notification type');
          if (b.data !== undefined && (b.data === null || typeof b.data !== 'object' || Array.isArray(b.data))) throw new NotifyError('data must be an object');
          input.type = b.type; input.data = b.data ?? {};
        } else if (allowCustomContent) {
          Object.assign(input, { title: b.title, body: b.body, link: b.link, category: b.category });
        } else {
          throw new NotifyError('Only registered notification types are allowed');
        }
        const r = await notifier.notify(input);
        return send(res, r.ok ? 200 : 207, r);
      }

      if (typeof next === 'function') return next();
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof NotifyError && e.status < 500) return send(res, e.status, { error: e.message, code: e.code });
      return send(res, 500, { error: 'Internal error' }); // never leak internals
    }
  };
}
