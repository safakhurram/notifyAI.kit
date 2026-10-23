/** Error with an HTTP-ish status. Messages are safe to show to API callers. */
export class NotifyError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.name = 'NotifyError';
    this.status = status;
    this.code = code;
  }
}

const EMAIL_RE = /[^\s@<>"']+@[^\s@<>"']+/g;
/** Remove email addresses and long tokens from error text before it is stored or logged. */
export function redact(message) {
  return String(message ?? 'unknown error')
    .replace(EMAIL_RE, '[email]')
    .replace(/[A-Za-z0-9_\-.]{32,}/g, '[token]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}

export const isEmail = (s) =>
  typeof s === 'string' && s.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s);
