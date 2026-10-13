import { safeEqual } from '../../../../lib/crypto.ts';
import { envOr } from '../../../../lib/env.ts';
import { errorResponse, json } from '../../../../lib/errors.ts';
import { runCrawlTick } from '../../../../lib/crawl/worker.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET|POST /api/cron/crawl   Authorization: Bearer <CRON_SECRET>
// Një "tick" i worker-it brenda buxhetit të funksionit (default 45 s nga 60).
// E thërret Vercel Cron, pg_cron + pg_net në Supabase, ose çdo planifikues tjetër.
// Për site-e të mëdha përdor worker-in e dedikuar: node scripts/crawl-worker.ts
async function tick(req: Request): Promise<Response> {
  try {
    const secret = process.env.CRON_SECRET || '';
    const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    // Pa CRON_SECRET të konfiguruar, rruga është e mbyllur (jo e hapur).
    if (secret.length < 16 || !safeEqual(given, secret)) return json({ error: 'unauthorized' }, 401);
    const budgetMs = Math.min(Math.max(Number(envOr('CRAWLER_TICK_BUDGET_MS', '45000')) || 45_000, 5_000), 55_000);
    const result = await runCrawlTick({ workerId: `cron-${crypto.randomUUID().slice(0, 8)}`, budgetMs });
    return json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = tick;
export const POST = tick;
