# Security notes

## Rules this kit enforces
- **Service-role key is server-only.** `createSupabaseStore` refuses to run when `window` exists. `src/react.js` contains no Supabase/SMTP code (a test checks this).
- **User identity comes only from your `authenticate(req)`.** Query/body `userId` is ignored on every user route.
- **Broadcast route is off by default.** It exists only if you pass `authorizeAdmin`, and it returns 403 unless that returns exactly `true`. Admins may only use registered templates unless you set `allowCustomContent`.
- **POST routes require `Content-Type: application/json`**, which blocks plain cross-site form posts (CSRF). If you authenticate with cookies, also add your own CSRF protection; bearer tokens are preferred.
- **Input validation:** template variables must exist (no blanks/guessing), links must be relative or https (http only for localhost), no `javascript:`/`data:`/`//host`/credentials, optional host allow-list, id/key formats, size limits.
- **Idempotency:** `UNIQUE(user_id, idempotency_key)` in the database + optimistic-lock delivery claims. Same key = no duplicate notification and no duplicate email. Failed emails are retried (up to `maxEmailAttempts`) only when you call `notify()` again with the same key.
- **Failures are never hidden:** the result has `ok:false`, per-user `failures`, and counts. HTTP returns 207 on partial failure.
- **Logs and stored errors are redacted** (emails and long tokens removed). The kit never logs message bodies, keys, or tokens.
- **Marketing vs transactional:** marketing email is **opt-in** (`email_marketing` defaults to false), is skipped without consent, always carries an unsubscribe link and `List-Unsubscribe` / one-click headers, and is refused entirely if unsubscribe isn't configured. Transactional email ignores the marketing flag. Unsubscribe links are HMAC-SHA256 signed, checked in constant time. GET shows a confirmation page and changes nothing (email scanners pre-fetch links); POST performs the change.
- **AI can't invent facts:** AI only rewrites already-rendered text of templates with `ai: true`. Output is rejected (template used instead) if it adds any number, date-like value, URL or email not in the source, contains markup/placeholders, is too long, or times out. Custom (non-template) content never goes to AI.
- **Database:** only `notify_*` tables are created; `public.users` is never modified. RLS is on; browser roles have no access except optional read-own and mark-own-read.

## Known limits (please read)
- At-least-once email: if your server crashes after SMTP accepted a message but before the database was updated, a retry could send it again. Stale claims are retried after 10 minutes.
- The AI fact check covers numbers, URLs and emails. It cannot catch an invented *word-only* claim ("free shipping"). For high-risk content leave `ai` off.
- No built-in rate limiting. Put `express-rate-limit` (or your gateway) in front of the router, especially `/unsubscribe`.
- The inbox is polled (default 30 s), not realtime.
- Rotating `NOTIFY_UNSUBSCRIBE_SECRET` invalidates all previously emailed unsubscribe links.
- Large broadcasts run inside your request. For tens of thousands of users run `notify({to:'all'})` from a background job, not an HTTP request.

## Reporting a vulnerability
Open a private security advisory on the GitHub repository.
