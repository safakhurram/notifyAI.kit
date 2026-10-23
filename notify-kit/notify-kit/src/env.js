import { NotifyError } from './errors.js';
import { createSupabaseStore } from './store-supabase.js';
import { createMailer } from './mailer.js';
import { createNotifier } from './notifier.js';

const need = (env, k, problems) => { const v = env[k]; if (!v || /^replace-with|^YOUR-/i.test(v)) problems.push(`${k} is missing`); return v; };

/** Read + validate environment variables. Returns plain config or throws one error listing all problems. */
export function readEnvConfig(env = process.env) {
  const problems = [];
  const supabaseUrl = need(env, 'SUPABASE_URL', problems);
  const serviceRoleKey = need(env, 'SUPABASE_SERVICE_ROLE_KEY', problems);
  const secret = need(env, 'NOTIFY_UNSUBSCRIBE_SECRET', problems);
  const appUrl = need(env, 'NOTIFY_APP_URL', problems);
  const unsubUrl = need(env, 'NOTIFY_UNSUBSCRIBE_URL', problems);
  if (supabaseUrl && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(supabaseUrl)) problems.push('SUPABASE_URL must be https');
  if (secret && secret.length < 32) problems.push('NOTIFY_UNSUBSCRIBE_SECRET must be 32+ characters');
  for (const [k, v] of [['NOTIFY_APP_URL', appUrl], ['NOTIFY_UNSUBSCRIBE_URL', unsubUrl]]) {
    if (v) { try { new URL(v); } catch { problems.push(`${k} is not a valid URL`); } }
  }
  const smtpKeys = ['SMTP_HOST', 'SMTP_FROM'];
  const smtpAny = smtpKeys.some((k) => env[k]);
  if (smtpAny) for (const k of smtpKeys) if (!env[k]) problems.push(`${k} is required when email is enabled`);
  if (env.SMTP_USER && !env.SMTP_PASS) problems.push('SMTP_PASS is required when SMTP_USER is set');
  const aiAny = env.AI_API_KEY || env.AI_MODEL;
  if (aiAny && !(env.AI_API_KEY && env.AI_MODEL)) problems.push('AI_API_KEY and AI_MODEL must both be set to enable AI');
  if (problems.length) throw new NotifyError(`Invalid notify-kit configuration:\n - ${problems.join('\n - ')}`, 500, 'config');
  return {
    supabaseUrl, serviceRoleKey, secret, appUrl, unsubUrl,
    smtp: smtpAny ? { host: env.SMTP_HOST, port: env.SMTP_PORT || 587, secure: env.SMTP_SECURE === 'true', user: env.SMTP_USER || undefined, pass: env.SMTP_PASS, from: env.SMTP_FROM } : null,
    ai: aiAny ? { apiKey: env.AI_API_KEY, model: env.AI_MODEL, baseUrl: env.AI_BASE_URL || undefined } : null,
  };
}

/** One-call setup from environment variables. `overrides` is merged into createNotifier options (templates, getEmail...). */
export async function createNotifierFromEnv(overrides = {}, env = process.env) {
  const c = readEnvConfig(env);
  const store = await createSupabaseStore({ url: c.supabaseUrl, serviceRoleKey: c.serviceRoleKey, users: overrides.users });
  const mailer = c.smtp ? await createMailer({ smtp: c.smtp, from: c.smtp.from }) : null;
  const { users: _users, ...rest } = overrides;
  return createNotifier({ store, mailer, ai: c.ai, appUrl: c.appUrl, unsubscribe: { secret: c.secret, url: c.unsubUrl }, ...rest });
}
