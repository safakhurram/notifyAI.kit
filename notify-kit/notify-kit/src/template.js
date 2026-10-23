import { NotifyError } from './errors.js';

const VAR = /\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_VALUE = 500;

function lookup(data, path) {
  let cur = data;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Replace {{path.to.value}} with values from `data`.
 * A missing/non-primitive value THROWS: we never guess or leave blanks.
 */
export function renderTemplate(tpl, data = {}, { encode = (s) => s } = {}) {
  if (typeof tpl !== 'string') throw new NotifyError('Template must be a string');
  const out = tpl.replace(VAR, (_m, path) => {
    const v = lookup(data, path);
    const ok = typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new NotifyError(`Missing or invalid template variable: ${path}`);
    const s = String(v).replace(CONTROL, '');
    if (s.length > MAX_VALUE) throw new NotifyError(`Template variable too long: ${path}`);
    return encode(s);
  });
  if (out.includes('{{') || out.includes('}}')) throw new NotifyError('Template contains malformed placeholder');
  return out;
}

export const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Links must be a relative path ("/orders/1") or an https URL (http only for localhost).
 * Rejects javascript:, data:, protocol-relative "//evil.com", credentials in URL, control chars.
 * If `allowedHosts` is set, absolute links must use one of those hosts.
 */
export function validateLink(link, { allowedHosts } = {}) {
  if (link === undefined || link === null || link === '') return null;
  if (typeof link !== 'string' || link.length > 2048) throw new NotifyError('Invalid link');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s\\]/.test(link)) throw new NotifyError('Invalid link');
  if (link.startsWith('/')) {
    if (link.startsWith('//')) throw new NotifyError('Invalid link');
    return link;
  }
  let u;
  try { u = new URL(link); } catch { throw new NotifyError('Invalid link'); }
  if (u.username || u.password) throw new NotifyError('Invalid link');
  const local = LOCAL_HOSTS.has(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new NotifyError('Invalid link');
  if (allowedHosts && !allowedHosts.includes(u.hostname)) throw new NotifyError('Link host not allowed');
  return u.toString();
}

export const CATEGORIES = ['transactional', 'marketing'];

export function validateTemplates(templates = {}) {
  for (const [name, t] of Object.entries(templates)) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) throw new NotifyError(`Invalid template name: ${name}`);
    if (!t || typeof t.title !== 'string' || typeof t.body !== 'string') {
      throw new NotifyError(`Template ${name} needs string title and body`);
    }
    if (t.category !== undefined && !CATEGORIES.includes(t.category)) {
      throw new NotifyError(`Template ${name} has invalid category`);
    }
    if (t.link !== undefined && typeof t.link !== 'string') throw new NotifyError(`Template ${name} link must be a string`);
  }
  return templates;
}
