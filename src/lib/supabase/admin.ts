import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.ts';

// Klienti me çelësin SECRET (roli service_role) -> ANASHKALON RLS.
// Rregull i hekurt: importohet vetëm nga kodi i serverit, dhe çdo query
// filtron me një tenant_id që vjen nga një burim i besuar (widget_key,
// kanali + sekreti i webhook-ut, ose përdoruesi i verifikuar) — kurrë nga body.
let client: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (!client) {
    client = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}
