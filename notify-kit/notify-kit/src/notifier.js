import { NotifyError, redact, isEmail } from './errors.js';
import { renderTemplate, oneLine, validateLink, validateTemplates, CATEGORIES } from './template.js';
import { createAiProvider, generateCopy } from './ai.js';
import { buildEmail } from './mailer.js';
import { createUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe.js';

const DEFAULT_PREFS = { in_app_enabled: true, email_transactional: true, email_marketing: false };
const PREF_KEYS = Object.keys(DEFAULT_PREFS);
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const USER_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_FAILURES_REPORTED = 100;

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

/**
 * createNotifier({ store, templates, mailer, ai, unsubscribe, appUrl, ... })
 * See README for every option.
 */
export function createNotifier(opts) {
  const {
    store, templates = {}, mailer = null, ai = null, appName = 'Notification', appUrl,
    unsubscribe = null,           // { secret, url }  url = public URL of the router's /unsubscribe route
    getEmail = null,              // async (userId) => email | null  (optional; else users/prefs email)
    listUsers = null,             // async ({after, limit}) => {users:[{id,email?}], next}  for broadcasts
    allowedLinkHosts, logger = {}, maxEmailAttempts = 3, staleClaimMs = 10 * 60_000, concurrency = 5, pageSize = 500,
  } = opts ?? {};
  if (!store) throw new NotifyError('createNotifier needs a store', 500, 'config');
  validateTemplates(templates);
  if (mailer && !appUrl) throw new NotifyError('appUrl is required when email is enabled', 500, 'config');
  if (appUrl) { try { new URL(appUrl); } catch { throw new NotifyError('appUrl is not a valid URL', 500, 'config'); } }
  if (unsubscribe && (!unsubscribe.secret || unsubscribe.secret.length < 32 || !unsubscribe.url)) {
    throw new NotifyError('unsubscribe needs a 32+ char secret and a url', 500, 'config');
  }
  const aiProvider = createAiProvider(ai);
  const pageLister = listUsers ?? ((a) => store.listUsers(a));

  const effective = (row) => {
    const p = { ...DEFAULT_PREFS };
    if (row) for (const k of PREF_KEYS) if (typeof row[k] === 'boolean') p[k] = row[k];
    return { ...p, email: row?.email ?? null };
  };

  async function resolveContent(input) {
    let title, body, link, category, aiAllowed = false;
    if (input.type !== undefined) {
      const tpl = Object.hasOwn(templates, input.type) ? templates[input.type] : undefined;
      if (!tpl) throw new NotifyError(`Unknown notification type: ${String(input.type).slice(0, 64)}`);
      const data = input.data ?? {};
      title = renderTemplate(tpl.title, data);
      body = renderTemplate(tpl.body, data);
      link = tpl.link ? renderTemplate(tpl.link, data, { encode: encodeURIComponent }) : input.link;
      category = tpl.category ?? 'transactional';
      aiAllowed = tpl.ai === true;
    } else {
      ({ title, body, link } = input);
      category = input.category ?? 'transactional';
      if (typeof title !== 'string' || typeof body !== 'string') throw new NotifyError('title and body are required');
    }
    if (!CATEGORIES.includes(category)) throw new NotifyError('Invalid category');
    title = oneLine(title); body = body.trim();
    if (!title || !body) throw new NotifyError('title and body cannot be empty');
    if (title.length > 200 || body.length > 2000) throw new NotifyError('title or body too long');
    link = validateLink(link, { allowedHosts: allowedLinkHosts });
    let copySource = 'template';
    if (aiProvider && aiAllowed) {
      const c = await generateCopy(aiProvider, { title, body }, logger);
      title = c.title; body = c.body; copySource = c.source;
    }
    return { title, body, link, category, copySource, type: input.type ?? null };
  }

  function normalizeRecipients(to) {
    if (to === 'all') return { mode: 'all' };
    const list = typeof to === 'string' ? [to] : to;
    if (!Array.isArray(list) || list.length === 0) throw new NotifyError('`to` must be a user id, a list of ids, or "all"');
    if (list.length > 10_000) throw new NotifyError('Too many recipients; use to: "all" or split the list');
    for (const id of list) if (typeof id !== 'string' || !USER_RE.test(id)) throw new NotifyError('Invalid user id');
    return { mode: typeof to === 'string' ? 'one' : 'list', ids: [...new Set(list)] };
  }

  /**
   * Send a notification.
   *  to: 'user-id' | ['id', ...] | 'all'
   *  type + data  (registered template)   OR   title + body (+ link, category)
   *  idempotencyKey: REQUIRED for 'all' and lists. Re-running with the same key never duplicates;
   *                  it only retries deliveries that previously failed.
   *  channels: ['in_app','email'] (default both; email only if a mailer is configured)
   */
  async function notify(input) {
    if (!input || typeof input !== 'object') throw new NotifyError('notify() needs an object');
    const rcpt = normalizeRecipients(input.to);
    const key = input.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || !KEY_RE.test(key))) throw new NotifyError('Invalid idempotencyKey');
    if (rcpt.mode !== 'one' && !key) throw new NotifyError('idempotencyKey is required for broadcasts and lists');
    const channels = new Set(input.channels ?? ['in_app', 'email']);
    for (const c of channels) if (c !== 'in_app' && c !== 'email') throw new NotifyError(`Unknown channel: ${c}`);

    const content = await resolveContent(input);
    const emailOn = channels.has('email') && Boolean(mailer);
    if (emailOn && content.category === 'marketing' && !unsubscribe) {
      throw new NotifyError('Marketing email requires the `unsubscribe` option', 500, 'config');
    }

    const summary = {
      ok: true, recipients: 0, notificationsCreated: 0, duplicates: 0, copySource: content.copySource,
      email: { sent: 0, failed: 0, skipped: 0, alreadySent: 0 }, failures: [], failuresTruncated: false,
    };
    const addFailure = (userId, stage, err) => {
      summary.ok = false;
      if (summary.failures.length < MAX_FAILURES_REPORTED) summary.failures.push({ userId, stage, error: redact(err?.message) });
      else summary.failuresTruncated = true;
      logger.error?.(`notify failure at ${stage}: ${redact(err?.message)}`);
    };

    let broadcastId = null;
    if (rcpt.mode !== 'one') {
      try {
        const b = await store.recordBroadcast({ idempotency_key: key, type: content.type, category: content.category, title: content.title });
        broadcastId = b?.id ?? null;
      } catch (e) { addFailure(null, 'recordBroadcast', e); }
    }

    async function processBatch(batch) {
      let prefsMap;
      try { prefsMap = await store.getPreferences(batch.map((u) => u.id)); }
      catch (e) { addFailure(null, 'getPreferences', e); return; } // can't judge consent => send nothing for this batch
      summary.recipients += batch.length;
      await mapLimit(batch, concurrency, async (u) => {
        try { await deliverToUser(u, prefsMap.get(u.id)); }
        catch (e) { addFailure(u.id, 'deliver', e); }
      });
    }

    async function deliverToUser(u, prefRow) {
      const prefs = effective(prefRow);
      const wantInApp = channels.has('in_app') && prefs.in_app_enabled;
      let address = null;
      let wantEmail = false;
      if (emailOn) {
        const consent = content.category === 'marketing' ? prefs.email_marketing === true : prefs.email_transactional;
        if (consent) {
          address = u.email ?? (getEmail ? await getEmail(u.id) : null) ?? prefs.email;
          wantEmail = isEmail(address);
        }
        if (!wantEmail) summary.email.skipped++;
      }
      if (!wantInApp && !wantEmail) return;

      const { row, created } = await store.insertNotification({
        user_id: u.id, type: content.type, category: content.category, title: content.title, body: content.body,
        link: content.link, idempotency_key: key ?? null, broadcast_id: broadcastId, hidden: !wantInApp,
      });
      if (created) summary.notificationsCreated++; else summary.duplicates++;
      if (!wantEmail) return;

      const claim = await store.claimDelivery(row.id, 'email', { maxAttempts: maxEmailAttempts, staleMs: staleClaimMs });
      if (!claim) { summary.email.alreadySent++; return; }
      try {
        const unsubscribeUrl = content.category === 'marketing'
          ? `${unsubscribe.url}?token=${createUnsubscribeToken(unsubscribe.secret, { userId: u.id })}` : undefined;
        const mail = buildEmail({ ...content, appName, appUrl, unsubscribeUrl });
        await mailer.send({ to: address, ...mail });
        await store.finishDelivery(claim.id, { status: 'sent' });
        summary.email.sent++;
      } catch (e) {
        summary.email.failed++;
        try { await store.finishDelivery(claim.id, { status: 'failed', error: redact(e?.message) }); } catch { /* claim goes stale and is retried */ }
        addFailure(u.id, 'email', e);
      }
    }

    if (rcpt.mode === 'all') {
      let after;
      for (;;) {
        let page;
        try { page = await pageLister({ after, limit: pageSize }); }
        catch (e) { addFailure(null, 'listUsers', e); break; }
        if (page.users.length) await processBatch(page.users);
        if (!page.next) break;
        after = page.next;
      }
    } else {
      const users = rcpt.ids.map((id) => ({ id }));
      for (let i = 0; i < users.length; i += pageSize) await processBatch(users.slice(i, i + pageSize));
    }
    return summary;
  }

  async function setPreferences(userId, patch) {
    if (!userId || typeof userId !== 'string') throw new NotifyError('userId required');
    const clean = {};
    for (const k of PREF_KEYS) {
      if (patch[k] === undefined) continue;
      if (typeof patch[k] !== 'boolean') throw new NotifyError(`${k} must be true or false`);
      clean[k] = patch[k];
    }
    if (patch.email !== undefined) { // server-side only; the router never forwards this from clients
      if (patch.email !== null && !isEmail(patch.email)) throw new NotifyError('Invalid email');
      clean.email = patch.email;
    }
    if (clean.email_marketing !== undefined) clean.marketing_consent_at = clean.email_marketing ? new Date().toISOString() : null;
    if (!Object.keys(clean).length) throw new NotifyError('No valid preferences supplied');
    return store.setPreferences(userId, clean);
  }

  async function getPreferences(userId) {
    const m = await store.getPreferences([userId]);
    const p = effective(m.get(userId));
    return { in_app_enabled: p.in_app_enabled, email_transactional: p.email_transactional, email_marketing: p.email_marketing };
  }

  async function handleUnsubscribe(token) {
    if (!unsubscribe) throw new NotifyError('Unsubscribe is not configured', 500, 'config');
    const { userId } = verifyUnsubscribeToken(unsubscribe.secret, token);
    await store.setPreferences(userId, { email_marketing: false, marketing_consent_at: null });
    return { userId, category: 'marketing' };
  }

  function checkUnsubscribeToken(token) {
    if (!unsubscribe) throw new NotifyError('Unsubscribe is not configured', 500, 'config');
    return verifyUnsubscribeToken(unsubscribe.secret, token);
  }

  const clampLimit = (n) => Math.min(Math.max(Number.parseInt(n, 10) || 20, 1), 50);

  async function list(userId, { limit, before, unreadOnly } = {}) {
    const lim = clampLimit(limit);
    if (before !== undefined && Number.isNaN(Date.parse(before))) throw new NotifyError('Invalid cursor');
    const rows = await store.listNotifications(userId, { limit: lim, before, unreadOnly: Boolean(unreadOnly) });
    const page = rows.slice(0, lim);
    return {
      notifications: page.map((n) => ({ id: n.id, type: n.type ?? null, category: n.category, title: n.title, body: n.body, link: n.link ?? null, read: Boolean(n.read_at), created_at: n.created_at })),
      unreadCount: await store.unreadCount(userId),
      nextBefore: rows.length > lim ? page[page.length - 1].created_at : null,
    };
  }

  return {
    notify, handleUnsubscribe, checkUnsubscribeToken, setPreferences, getPreferences, list,
    unreadCount: (userId) => store.unreadCount(userId),
    markRead: (userId, id) => store.markRead(userId, id),
    markAllRead: (userId) => store.markAllRead(userId),
    hasTemplate: (t) => Object.hasOwn(templates, t),
    createUnsubscribeUrl: (userId) => {
      if (!unsubscribe) throw new NotifyError('Unsubscribe is not configured', 500, 'config');
      return `${unsubscribe.url}?token=${createUnsubscribeToken(unsubscribe.secret, { userId })}`;
    },
  };
}
