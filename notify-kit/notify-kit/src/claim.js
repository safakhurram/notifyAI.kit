/** Shared rule: may this delivery row be (re)attempted right now? */
export function canClaim(row, { maxAttempts, staleMs, now = Date.now() }) {
  if (!row) return false;
  if (row.status === 'sent' || row.status === 'skipped') return false;
  if (row.attempts >= maxAttempts) return false;
  if (row.status === 'sending') {
    const t = row.claimed_at ? new Date(row.claimed_at).getTime() : 0;
    return now - t > staleMs; // another worker crashed mid-send
  }
  return true; // pending or failed
}
