import { NotifyError, isEmail } from './errors.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Build subject/text/html (+ headers). Marketing mail gets an unsubscribe footer and List-Unsubscribe headers. */
export function buildEmail({ title, body, link, category, appName = 'Notification', appUrl, unsubscribeUrl }) {
  let abs = null;
  if (link) abs = link.startsWith('/') ? new URL(link, appUrl).toString() : link;
  const marketing = category === 'marketing';
  const subject = String(title).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const text = [body, abs ? `\nOpen: ${abs}` : '',
    marketing && unsubscribeUrl ? `\n\n--\nYou get this because you opted in to updates from ${appName}.\nUnsubscribe: ${unsubscribeUrl}` : '',
  ].join('');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
    `<h2>${esc(title)}</h2><p style="white-space:pre-wrap">${esc(body)}</p>` +
    (abs ? `<p><a href="${esc(abs)}">Open</a></p>` : '') +
    (marketing && unsubscribeUrl
      ? `<hr><p style="font-size:12px;color:#666">You get this because you opted in to updates from ${esc(appName)}. <a href="${esc(unsubscribeUrl)}">Unsubscribe</a></p>` : '') +
    `</div>`;
  const headers = marketing && unsubscribeUrl
    ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
  return { subject, text, html, headers };
}

/**
 * SMTP mailer. Pass `transport` (anything with sendMail) in tests, or `smtp` config for nodemailer.
 * send() THROWS on failure: the notifier records that as a failed delivery. Nothing is swallowed.
 */
export async function createMailer({ smtp, from, transport } = {}) {
  if (!from) throw new NotifyError('Mailer needs a "from" address', 500, 'config');
  let t = transport;
  if (!t) {
    if (!smtp?.host) throw new NotifyError('SMTP host is required', 500, 'config');
    const nodemailer = (await import('nodemailer')).default;
    t = nodemailer.createTransport({
      host: smtp.host, port: Number(smtp.port ?? 587), secure: Boolean(smtp.secure),
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }
  return {
    async send({ to, subject, text, html, headers }) {
      if (!isEmail(to)) throw new Error('invalid recipient address');
      await t.sendMail({ from, to, subject, text, html, headers });
    },
  };
}
