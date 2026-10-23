// Real-credentials smoke test. Usage: node --env-file=.env scripts/smoke.mjs <existing-user-id> [--email]
import { createNotifierFromEnv } from '../src/index.js';
const userId = process.argv[2];
if (!userId) { console.error('Usage: node --env-file=.env scripts/smoke.mjs <user-id> [--email]'); process.exit(1); }
const notifier = await createNotifierFromEnv({ templates: { 'smoke.test': { title: 'notify-kit works', body: 'This is a test notification.' } } });
const channels = process.argv.includes('--email') ? ['in_app', 'email'] : ['in_app'];
const r = await notifier.notify({ to: userId, type: 'smoke.test', channels, idempotencyKey: `smoke-${Date.now()}` });
console.log(JSON.stringify(r, null, 2));
const inbox = await notifier.list(userId, { limit: 3 });
console.log('Unread:', inbox.unreadCount, '| latest:', inbox.notifications[0]?.title);
process.exit(r.ok ? 0 : 1);
