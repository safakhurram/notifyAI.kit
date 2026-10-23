// Run: cp .env.example .env  (fill it in)  ->  npm i express @supabase/supabase-js nodemailer  ->  npm run example
// NOTE: written against the public Express / Supabase APIs but NOT executed in the kit's CI (no network there).
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createNotifierFromEnv, createRouter } from '../src/index.js';   // in your app: from 'notify-kit'

const templates = {
  'order.shipped': { title: 'Order {{orderId}} shipped', body: 'Your order {{orderId}} is on its way.', link: '/orders/{{orderId}}', ai: false },
  'promo.sale':    { title: 'Spring sale', body: 'Get 20 percent off until Friday.', category: 'marketing' },
};

// users: tell the kit where your existing table lives (READ-ONLY, used for broadcasts)
const notifier = await createNotifierFromEnv({
  templates,
  users: { table: 'users', idColumn: 'id', emailColumn: 'email' },
  logger: { warn: console.warn, error: console.error },
});

// How do you know who the caller is? Here: Supabase Auth JWT sent as "Authorization: Bearer <token>".
const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function authenticate(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return null;
  const { data, error } = await auth.auth.getUser(token);
  return error || !data?.user ? null : { userId: data.user.id, user: data.user };
}
// Who may broadcast? YOUR rule. Example: a list of admin user ids in an env var.
const ADMINS = new Set((process.env.NOTIFY_ADMIN_USER_IDS ?? '').split(',').filter(Boolean));
async function authorizeAdmin(req) { const u = await authenticate(req); return Boolean(u && ADMINS.has(u.userId)); }

const app = express();
app.use('/notify', express.json({ limit: '50kb' }), createRouter({ notifier, authenticate, authorizeAdmin }));

// Server-side code can notify one user directly (no HTTP, no client input involved):
app.post('/orders/:id/ship', express.json(), async (req, res) => {
  // ...your own auth + business logic here...
  const result = await notifier.notify({ to: 'USER-ID-FROM-YOUR-DB', type: 'order.shipped', data: { orderId: req.params.id }, idempotencyKey: `order-shipped:${req.params.id}` });
  res.status(result.ok ? 200 : 502).json(result);
});

app.listen(3000, () => console.log('http://localhost:3000'));
