# Release notes

## 0.1.0 (first release)
Implemented: in-app inbox (unread/read, mark all read), single/list/all-user notifications, templates, SMTP email (nodemailer), optional AI copy with fact guard and template fallback, preferences, marketing opt-in + signed unsubscribe, Supabase store + SQL with RLS, memory store (tests), Express-compatible router, React client + `NotificationBell`, env validation.

Verified in the build environment: syntax check, 58 automated tests (memory store, fake mailer, fake AI, real HTTP server for the router, React server-render).

**Not verified (no network/credentials in the build environment):** real Supabase, real SMTP, real AI API, real Express and Nodemailer installs, a browser. The Supabase store was tested only against a small fake client. Please run the "Smoke test" in the README against your own project before going live.
