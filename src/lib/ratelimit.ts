import { admin } from './supabase/admin.ts';
import { ApiError } from './errors.ts';

// Rate limit në Postgres (funksioni check_rate_limit): pa Redis, pa shërbim shtesë.
// Mjafton për pilotin; kur trafiku rritet zëvendësohet me Upstash pa prekur thirrësit.
export async function allow(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin().rpc('check_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(`check_rate_limit: ${error.message}`);
  return data === true;
}

export async function enforce(bucket: string, limit: number, windowSeconds: number): Promise<void> {
  if (!(await allow(bucket, limit, windowSeconds))) {
    throw new ApiError(429, 'rate_limited', 'Shumë kërkesa. Provo sërish pas pak.');
  }
}
