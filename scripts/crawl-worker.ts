// Worker i dedikuar i crawl-it: proces Node që punon pa limitin 60 s të Vercel.
// Përdorim (VPS, Railway, Fly, Render, ose edhe Termux për prova):
//   node --env-file=.env.local scripts/crawl-worker.ts
// Kërkon: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, VOYAGE_API_KEY.
// Disa worker-a mund të punojnë njëkohësisht: lease-i në DB i ndan job-et.
import { hostname } from 'node:os';
import { runCrawlTick } from '../src/lib/crawl/worker.ts';

const BUDGET_MS = Number(process.env.CRAWLER_WORKER_BUDGET_MS || 120_000);
const IDLE_MS = Number(process.env.CRAWLER_WORKER_IDLE_MS || 15_000);
const workerId = `${hostname()}-${process.pid}`;

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Mbaron tick-un aktual; lease-i i një tick-u të ndërprerë skadon vetë.
    console.log(`[worker] ${signal}: ndalon pas tick-ut aktual`);
    stopping = true;
  });
}

console.log(`[worker] ${workerId} nisi (buxhet ${BUDGET_MS} ms, pritje ${IDLE_MS} ms)`);
while (!stopping) {
  let worked = false;
  try {
    const r = await runCrawlTick({ workerId, budgetMs: BUDGET_MS });
    worked = r.jobs > 0;
    if (r.jobs || r.enqueued || r.errors) console.log(`[worker] jobs=${r.jobs} enqueued=${r.enqueued} errors=${r.errors}`);
  } catch (e) {
    console.error('[worker] tick dështoi', e);
  }
  if (!worked && !stopping) await new Promise((r) => setTimeout(r, IDLE_MS));
}
process.exit(0);
