import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotifyError } from './errors.js';

const b64 = (b) => Buffer.from(b).toString('base64url');

function checkSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new NotifyError('NOTIFY_UNSUBSCRIBE_SECRET must be at least 32 characters', 500, 'config');
  }
}

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest();

/** Create a signed token for "stop marketing email" links. No expiry: unsubscribe links must keep working. */
export function createUnsubscribeToken(secret, { userId, category = 'marketing' }) {
  checkSecret(secret);
  if (!userId || typeof userId !== 'string') throw new NotifyError('userId required');
  const payload = b64(JSON.stringify({ v: 1, u: userId, c: category }));
  return `${payload}.${b64(sign(secret, payload))}`;
}

/** Returns { userId, category } or throws NotifyError. Constant-time signature check. */
export function verifyUnsubscribeToken(secret, token) {
  checkSecret(secret);
  const bad = () => new NotifyError('Invalid or tampered unsubscribe link', 400, 'bad_token');
  if (typeof token !== 'string' || token.length > 2000) throw bad();
  const parts = token.split('.');
  if (parts.length !== 2) throw bad();
  const [payload, sig] = parts;
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { throw bad(); }
  const expected = sign(secret, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (data?.v !== 1 || typeof data.u !== 'string' || data.c !== 'marketing') throw bad();
  return { userId: data.u, category: data.c };
}
