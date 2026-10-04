import { admin } from './supabase/admin.ts';
import { ApiError } from './errors.ts';
import { TENANT_COLUMNS } from './types.ts';
import type { Tenant } from './types.ts';

// Zgjidh tenant-in nga widget_key publik dhe zbaton listën e origjinave.
export async function tenantForWidget(req: Request, key: unknown): Promise<Tenant> {
  if (typeof key !== 'string' || !/^wk_[a-f0-9]{32}$/.test(key)) throw new ApiError(400, 'invalid_key');

  const { data, error } = await admin().from('tenants').select(TENANT_COLUMNS).eq('widget_key', key).maybeSingle();
  if (error) throw new Error(`tenants: ${error.message}`);
  if (!data) throw new ApiError(404, 'unknown_widget');
  const tenant = data as Tenant;

  // Origin vendoset nga shfletuesi dhe nuk falsifikohet dot nga JavaScript i një faqeje
  // tjetër. Kjo ndalon që widget-i (dhe kuota) e një tenant-i të përdoret në faqe të huaja.
  // Kundër skripteve jashtë shfletuesit mbrojnë rate limits + kuota mujore.
  if (tenant.allowed_origins.length > 0) {
    const origin = requestOrigin(req);
    if (!origin || !tenant.allowed_origins.includes(origin)) throw new ApiError(403, 'origin_not_allowed');
  }
  return tenant;
}

// Shfletuesi dërgon Origin në çdo kërkesë cross-origin. Për GET në të njëjtën origjinë
// (p.sh. /demo.html në domenin e aplikacionit) Origin mungon, ndaj përdoret Referer.
function requestOrigin(req: Request): string | null {
  const origin = req.headers.get('origin');
  if (origin) return origin;
  try {
    return new URL(req.headers.get('referer') || '').origin;
  } catch {
    return null;
  }
}

export function bearer(req: Request): string | null {
  const header = req.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
