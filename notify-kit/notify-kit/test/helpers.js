import { createNotifier, createMemoryStore } from '../src/index.js';

export const SECRET = 'a'.repeat(40);
export const templates = {
  'order.shipped': { title: 'Order {{orderId}} shipped', body: 'Your order {{orderId}} is on its way. Total: {{total}}.', link: '/orders/{{orderId}}' },
  'promo.sale': { title: 'Spring sale', body: 'Get 20 percent off until Friday.', category: 'marketing', ai: true },
  'ai.copy': { title: 'Order {{orderId}} shipped', body: 'Your order {{orderId}} ships on 12 May.', ai: true },
};

export function fakeMailer({ failFor = new Set() } = {}) {
  const sent = [];
  return { sent, failFor, async send(m) {
    if (failFor.has(m.to)) throw new Error(`SMTP refused ${m.to}`);
    sent.push(m);
  } };
}

export function setup({ mailer = fakeMailer(), users = [], ai, extra = {} } = {}) {
  const store = createMemoryStore();
  const notifier = createNotifier({
    store, templates, mailer, ai, appUrl: 'https://app.example.com', appName: 'Demo',
    unsubscribe: { secret: SECRET, url: 'https://api.example.com/notify/unsubscribe' },
    getEmail: async (id) => `${id}@example.com`,
    listUsers: async ({ after, limit }) => {
      const start = after ? users.indexOf(after) + 1 : 0;
      const slice = users.slice(start, start + limit);
      return { users: slice.map((id) => ({ id })), next: start + limit < users.length ? slice[slice.length - 1] : null };
    },
    ...extra,
  });
  return { store, notifier, mailer };
}
