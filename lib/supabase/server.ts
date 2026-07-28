import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getEnv } from '@/lib/env';

/**
 * Service-role Supabase client. Server-only by construction: importing this
 * module from a Client Component is a build error thanks to `server-only`.
 *
 * The service role bypasses RLS, which is what we want for a trusted ingestion
 * worker and retrieval layer — but it also means this client must never be
 * handed a user-supplied table or column name.
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  const env = getEnv();

  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, ' +
        'or switch VECTOR_STORE to "pinecone".',
    );
  }

  client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });

  return client;
}
