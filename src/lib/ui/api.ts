'use client';

import { supabase } from '../supabase/browser.ts';

export class ApiCallError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Thirrje te API routes të aplikacionit me tokenin e sesionit aktual.
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiCallError(401, 'unauthorized', 'unauthorized');

  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    const code = payload.error || `http_${res.status}`;
    throw new ApiCallError(res.status, code, payload.message || code);
  }
  return payload as T;
}
