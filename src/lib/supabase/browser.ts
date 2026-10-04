'use client';

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Klienti i panelit në browser: çelësi PUBLISHABLE + sesioni i përdoruesit.
// Çfarë sheh dhe ndryshon ky klient e vendos RLS në databazë, jo ky kod.
let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    );
  }
  return client;
}
