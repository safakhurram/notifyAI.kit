# notify-kit

A copy-in notification kit for Node.js/Express + React apps, backed by **your own Supabase**. No hosted service: you bring your own Supabase, SMTP and (optionally) AI credentials.

**What you get:** in-app inbox with unread/read · notify one user, a list, or everyone · email via SMTP · optional AI-polished copy with a safe fallback · preferences · opt-in marketing + signed unsubscribe · Row Level Security · Express-compatible router · React `NotificationBell`.

**Not included:** push notifications, SMS, scheduling, realtime sockets (inbox polls every 30 s), a dashboard.

> Status: v0.1.0. Core logic is unit-tested (see [RELEASE_NOTES.md](RELEASE_NOTES.md)). Real Supabase/SMTP/AI were **not** tested by the author. Run the smoke test (step 5) first.

## How it fits together

```
React app  --(Bearer token)-->  YOUR Express server  --(service-role key)-->  Supabase
 (anon key only, no secrets)     notify-kit router + notifier                  notify_* tables
                                       |--> SMTP (email)   |--> AI API (optional)
```
The browser never gets the service-role key. Your server decides who the user is.

## Quick start

Requires Node 20.6+.

### 1. Install
```bash
npm install @supabase/supabase-js nodemailer      # nodemailer only if you want email
# copy the notify-kit folder into your project (e.g. ./notify-kit) or install from your GitHub repo:
# npm install github:YOUR-USER/notify-kit
```
In your React app also: `react` (already there).

### 2. Create the tables
Supabase dashboard → **SQL Editor** → **New query** → paste `supabase/setup.sql` → **Run**.
It only creates `notify_*` tables. It does not touch `public.users`. Safe to re-run.

### 3. Configure
```bash
cp .env.example .env
```
Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API; **server only**), and generate the secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste as NOTIFY_UNSUBSCRIBE_SECRET
```
`NOTIFY_APP_URL` = your site, `NOTIFY_UNSUBSCRIBE_URL` = `https://YOUR-API/notify/unsubscribe` (where you mount the router in step 4).
Never commit `.env` (it is in `.gitignore`).

| Optional feature | Set these |
|---|---|
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| AI copy | `AI_API_KEY`, `AI_MODEL`, optionally `AI_BASE_URL` (any OpenAI-compatible API) |
Leave blank to turn off. Email and AI are off unless fully configured.

### 4. Add to your Express backend
```js
import express from 'express';
import { createNotifierFromEnv, createRouter } from 'notify-kit';

const notifier = await createNotifierFromEnv({
  templates: {
    'order.shipped': { title: 'Order {{orderId}} shipped', body: 'Your order {{orderId}} is on its way.', link: '/orders/{{orderId}}' },
    'promo.sale':    { title: 'Spring sale', body: 'Get 20 percent off until Friday.', category: 'marketing' },
  },
  users: { table: 'users', idColumn: 'id', emailColumn: 'email' },   // YOUR existing table, read-only
});

const app = express();
app.use('/notify', express.json(), createRouter({
  notifier,
  authenticate: async (req) => { /* return { userId } for the logged-in user, or null */ },
  authorizeAdmin: async (req) => { /* return true ONLY for admins; omit to disable broadcast route */ },
}));
```
A complete, working-shaped example (Supabase Auth JWT login) is in `examples/express-server.js`.

### 5. Smoke test with your real credentials
```bash
npm run smoke -- EXISTING-USER-ID            # in-app only
npm run smoke -- EXISTING-USER-ID --email    # also tries SMTP (user needs an email)
```

## Common tasks

**Notify one user (from your server code):**
```js
const r = await notifier.notify({
  to: userId, type: 'order.shipped', data: { orderId: '1042' },
  idempotencyKey: `order-shipped:1042`,      // optional for one user, but recommended
});
if (!r.ok) console.error(r.failures);       // r = { ok, recipients, notificationsCreated, duplicates, email:{sent,failed,skipped,alreadySent}, failures }
```

**Broadcast to everyone (securely):** call from a server job, or via the admin route:
```bash
curl -X POST https://api.example.com/notify/admin/notify \
  -H "Authorization: Bearer ADMIN_USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"all","type":"promo.sale","idempotencyKey":"spring-sale-2026"}'
```
`idempotencyKey` is **required** for broadcasts. If it partly fails (HTTP 207), fix the cause and send the **same request again**: users already done are skipped, only failed emails retry (max 3 attempts each).

**React bell** (`examples/react-app.jsx`):
```jsx
import { createNotifyClient, NotificationBell } from 'notify-kit/react';
const client = createNotifyClient({ baseUrl: 'https://api.example.com/notify',
  getHeaders: async () => ({ Authorization: `Bearer ${await getMyAccessToken()}` }) });
<NotificationBell client={client} onNavigate={(link) => navigate(link)} />
```
Build your own UI with `useNotifications(client)` (`items, unread, markRead, markAllRead, refresh`).

**Read/unread:** `client.markRead(id)`, `client.markAllRead()`; server: `notifier.markRead(userId, id)`, `notifier.unreadCount(userId)`.

**Preferences:** `client.getPreferences()` / `client.setPreferences({ in_app_enabled, email_transactional, email_marketing })`. Marketing email is **off until the user opts in**. Server: `notifier.setPreferences(userId, {...})`; set a fallback address with `{ email }` (server-side only).

**Transactional vs marketing:** set `category` on a template. `transactional` (default): order/account events; sent unless the user disabled `email_transactional`. `marketing`: needs opt-in, gets an unsubscribe link and headers. Use marketing for anything promotional.

**AI copy:** add `ai: true` to a template and set the `AI_*` env vars. The AI only rephrases the already-filled template and is rejected (template used) if it adds any number, URL or email, or fails/times out. Check `result.copySource` (`'ai'` or `'template'`). Not for legal/financial wording; see SECURITY.md limits.

**Email address source (first match):** broadcast list → `getEmail(userId)` option → `notify_preferences.email`. Pass `getEmail` if your emails live elsewhere.

**Other users table?** Pass `users: { table, idColumn, emailColumn }` or your own `listUsers({after, limit}) → { users:[{id,email}], next }`.

## API summary
`createNotifier(opts)` / `createNotifierFromEnv(overrides)` → `notify`, `list`, `unreadCount`, `markRead`, `markAllRead`, `getPreferences`, `setPreferences`, `handleUnsubscribe(token)`, `createUnsubscribeUrl(userId)`.
Router endpoints (under your mount path): `GET /notifications?limit&before&unread=1` · `POST /notifications/:id/read` · `POST /notifications/read-all` · `GET|PUT /preferences` · `GET|POST /unsubscribe?token=` · `POST /admin/notify` (only with `authorizeAdmin`).
Custom stores: implement the same methods as `src/store-memory.js` (e.g. for another database).

## Develop / verify
```bash
npm install
npm run check      # syntax check + all tests
```
Security: see [SECURITY.md](SECURITY.md). License: MIT.

## Publish to GitHub (beginner steps)
1. Create an empty repo on github.com (no README). 
2. In this folder: 
```bash
git init && git add . && git commit -m "notify-kit 0.1.0"
git branch -M main
git remote add origin https://github.com/YOUR-USER/notify-kit.git
git push -u origin main
```
3. Check `git status` shows no `.env` before pushing. If a real key was ever committed, rotate it.
