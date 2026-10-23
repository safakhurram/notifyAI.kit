// In your React app (Vite/CRA/Next client component). Needs: npm i react (kit is copied in or installed)
import { createNotifyClient, NotificationBell } from 'notify-kit/react';
import { supabase } from './supabaseClient'; // your browser client, created with the ANON key only

const client = createNotifyClient({
  baseUrl: 'https://api.example.com/notify',        // where your backend mounted the router
  getHeaders: async () => {
    const { data } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${data.session?.access_token}` };
  },
});

export function Header() {
  return <NotificationBell client={client} onNavigate={(link) => (window.location.href = link)} />;
}

// Preferences screen:
//   const prefs = await client.getPreferences();                // { in_app_enabled, email_transactional, email_marketing }
//   await client.setPreferences({ email_marketing: true });     // explicit opt-in
