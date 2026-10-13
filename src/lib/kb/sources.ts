import { admin } from '../supabase/admin.ts';
import { ApiError } from '../errors.ts';
import { crawlerConfig } from '../crawl/config.ts';
import { checkTarget, FetchError, safeFetch } from '../crawl/netguard.ts';
import { cleanPatterns, inScope, isExcluded, normalizeUrl, siteHost } from '../crawl/url.ts';

// Operacionet mbi burimet e njohurive. Çdo funksion merr tenantId nga thirrësi
// (përdoruesi i verifikuar ose çelësi API) dhe e përdor në ÇDO query me admin().

export const SOURCE_PUBLIC_COLUMNS =
  'id, type, root_url, host, enabled, status, verified_at, verification_token, max_pages, max_depth, exclude_patterns, sync_interval_hours, next_sync_at, last_synced_at, last_job_id, created_at';
export const JOB_PUBLIC_COLUMNS =
  'id, source_id, trigger, status, max_pages, max_depth, pages_discovered, pages_processed, pages_failed, pages_skipped, pages_unchanged, pages_indexed, pages_deleted, chunks_embedded, chunks_reused, embedding_tokens, truncated, attempts, error, started_at, finished_at, created_at';

export const VERIFICATION_META = 'anesp-site-verification';
export const VERIFICATION_PATH = '/.well-known/anesp-verification.txt';

type SourceRow = {
  id: string;
  tenant_id: string;
  root_url: string;
  host: string;
  enabled: boolean;
  verified_at: string | null;
  verification_token: string;
  max_pages: number;
  max_depth: number;
};

type Settings = { max_pages?: unknown; max_depth?: unknown; exclude_patterns?: unknown; sync_interval_hours?: unknown; enabled?: unknown };

function intIn(v: unknown, min: number, max: number, code: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ApiError(400, code);
  return v;
}

// Validon fushat e konfigurueshme. Kufijtë e planit zbatohen kur krijohet job-i.
function readSettings(body: Settings, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.max_pages !== undefined) out.max_pages = intIn(body.max_pages, 1, 5000, 'invalid_max_pages');
  if (body.max_depth !== undefined) out.max_depth = intIn(body.max_depth, 0, 10, 'invalid_max_depth');
  if (body.sync_interval_hours !== undefined) out.sync_interval_hours = intIn(body.sync_interval_hours, 1, 8760, 'invalid_sync_interval');
  if (body.exclude_patterns !== undefined) {
    const patterns = cleanPatterns(body.exclude_patterns);
    if (!patterns) throw new ApiError(400, 'invalid_exclude_patterns');
    out.exclude_patterns = patterns;
  }
  if (partial && body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'invalid_enabled');
    out.enabled = body.enabled;
  }
  return out;
}

async function loadSource(tenantId: string, sourceId: string): Promise<SourceRow> {
  const { data, error } = await admin()
    .from('knowledge_sources')
    .select('id, tenant_id, root_url, host, enabled, verified_at, verification_token, max_pages, max_depth')
    .eq('id', sourceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`source: ${error.message}`);
  if (!data) throw new ApiError(404, 'source_not_found');
  return data as SourceRow;
}

// Kontrolli SSRF i URL-së që regjistron klienti (i njëjti si gjatë crawl-it).
async function assertPublicUrl(url: string): Promise<void> {
  try {
    await checkTarget(url, crawlerConfig().net);
  } catch (e) {
    if (e instanceof FetchError) {
      throw new ApiError(400, e.code === 'dns_failed' ? 'url_not_resolvable' : 'url_not_allowed');
    }
    throw e;
  }
}

export async function createSource(tenantId: string, body: Settings & { url?: unknown }) {
  if (typeof body.url !== 'string' || body.url.length > 2000) throw new ApiError(400, 'invalid_url');
  const raw = /^https?:\/\//i.test(body.url.trim()) ? body.url.trim() : `https://${body.url.trim()}`;
  const url = normalizeUrl(raw);
  if (!url) throw new ApiError(400, 'invalid_url');
  await assertPublicUrl(url);
  const settings = readSettings(body, false);

  const db = admin();
  const { data: tenant, error: tenantError } = await db.from('tenants').select('max_sources').eq('id', tenantId).single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  const { count, error: countError } = await db
    .from('knowledge_sources')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (countError) throw new Error(`count sources: ${countError.message}`);
  if ((count ?? 0) >= tenant.max_sources) throw new ApiError(409, 'source_limit_reached');

  const { data: kb, error: kbError } = await db
    .from('knowledge_bases')
    .select('id')
    .eq('tenant_id', tenantId)
    .order('created_at')
    .limit(1)
    .single();
  if (kbError) throw new Error(`knowledge base: ${kbError.message}`);

  const { data, error } = await db
    .from('knowledge_sources')
    .insert({
      tenant_id: tenantId,
      knowledge_base_id: kb.id,
      root_url: url,
      host: siteHost(new URL(url).hostname),
      ...settings,
    })
    .select(SOURCE_PUBLIC_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'source_exists');
    throw new Error(`insert source: ${error.message}`);
  }

  // Kur verifikimi i pronësisë është i çaktivizuar (vetëm instalime private),
  // skanimi fillestar nis menjëherë.
  if (!crawlerConfig().requireVerification) {
    await db.from('knowledge_sources').update({ verified_at: new Date().toISOString() }).eq('id', data.id).eq('tenant_id', tenantId);
    const job = await startSync(tenantId, data.id, 'initial');
    return { source: { ...data, verified_at: new Date().toISOString(), status: 'pending' }, job, verification: null };
  }
  return { source: data, job: null, verification: verificationInstructions(data.root_url, data.verification_token) };
}

export function verificationInstructions(rootUrl: string, token: string) {
  return {
    token,
    meta_tag: `<meta name="${VERIFICATION_META}" content="${token}">`,
    file_url: new URL(VERIFICATION_PATH, rootUrl).toString(),
    file_content: token,
  };
}

// Pronësia e site-it: meta tag në faqen kryesore ose skedar në /.well-known/.
// Pa këtë, kushdo mund të ndërtonte një "bot" me përmbajtjen e biznesit të dikujt tjetër.
export async function verifySource(tenantId: string, sourceId: string) {
  const source = await loadSource(tenantId, sourceId);
  if (source.verified_at) return { verified: true, job: null };

  const cfg = crawlerConfig();
  const opts = { ...cfg.net, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes, maxRedirects: cfg.maxRedirects };
  const token = source.verification_token;
  let verified = false;
  try {
    const page = await safeFetch(source.root_url, opts);
    if (page.status === 200 && inScope(page.url, source.host)) {
      const html = page.body.toString('utf8');
      const metaRe = /<meta\b[^>]*>/gi;
      let m: RegExpExecArray | null;
      while (!verified && (m = metaRe.exec(html))) {
        const tag = m[0];
        if (new RegExp(`name\\s*=\\s*["']?${VERIFICATION_META}["'\\s>]`, 'i').test(tag) && tag.includes(token)) verified = true;
      }
    }
    if (!verified) {
      const file = await safeFetch(new URL(VERIFICATION_PATH, source.root_url).toString(), { ...opts, maxBytes: 10_000 });
      verified = file.status === 200 && inScope(file.url, source.host) && file.body.toString('utf8').trim() === token;
    }
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    throw new ApiError(422, 'site_unreachable');
  }
  if (!verified) throw new ApiError(422, 'verification_failed');

  const { error } = await admin()
    .from('knowledge_sources')
    .update({ verified_at: new Date().toISOString() })
    .eq('id', source.id)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`verify: ${error.message}`);
  const job = await startSync(tenantId, source.id, 'initial');
  return { verified: true, job };
}

// Nis një crawl. Idempotent: nëse ka job aktiv, kthehet ai (indeksi unik në DB).
export async function startSync(tenantId: string, sourceId: string, trigger: 'initial' | 'manual' | 'scheduled') {
  const source = await loadSource(tenantId, sourceId);
  if (!source.verified_at) throw new ApiError(409, 'source_not_verified');
  if (!source.enabled) throw new ApiError(409, 'source_disabled');

  const db = admin();
  const { data: tenant, error: tenantError } = await db
    .from('tenants')
    .select('max_crawl_pages, status, trial_ends_at')
    .eq('id', tenantId)
    .single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  if (tenant.status !== 'active' || new Date(tenant.trial_ends_at).getTime() < Date.now()) throw new ApiError(402, 'plan_inactive');

  const { data, error } = await db
    .from('crawl_jobs')
    .insert({
      tenant_id: tenantId,
      source_id: source.id,
      trigger,
      max_pages: Math.min(source.max_pages, tenant.max_crawl_pages),
      max_depth: source.max_depth,
    })
    .select(JOB_PUBLIC_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') return { ...(await activeJob(tenantId, source.id)), already_running: true };
    throw new Error(`insert job: ${error.message}`);
  }
  await db.from('knowledge_sources').update({ status: 'pending', last_job_id: data.id }).eq('id', source.id).eq('tenant_id', tenantId);
  return data;
}

async function activeJob(tenantId: string, sourceId: string) {
  const { data, error } = await admin()
    .from('crawl_jobs')
    .select(JOB_PUBLIC_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('source_id', sourceId)
    .in('status', ['pending', 'crawling', 'indexing'])
    .maybeSingle();
  if (error) throw new Error(`active job: ${error.message}`);
  return data ?? {};
}

// Rifillon job-in e fundit: URL-të e dështuara kthehen në radhë; një job i dështuar
// vazhdon nga faza ku mbeti (robots/seed, crawl ose indeksim).
export async function retrySource(tenantId: string, sourceId: string) {
  const source = await loadSource(tenantId, sourceId);
  const db = admin();
  const { data: job, error } = await db
    .from('crawl_jobs')
    .select('id, status, robots_txt')
    .eq('tenant_id', tenantId)
    .eq('source_id', source.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`last job: ${error.message}`);
  if (!job) throw new ApiError(409, 'nothing_to_retry');
  if (['pending', 'crawling', 'indexing'].includes(job.status)) throw new ApiError(409, 'job_active');

  const { data: failedRows, error: resetError } = await db
    .from('crawl_queue')
    .update({ status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString(), reason: null })
    .eq('job_id', job.id)
    .eq('tenant_id', tenantId)
    .eq('status', 'failed')
    .select('id');
  if (resetError) throw new Error(`reset queue: ${resetError.message}`);

  if (job.status !== 'failed' && !(failedRows ?? []).length) throw new ApiError(409, 'nothing_to_retry');

  const { count: fetched } = await db
    .from('crawl_queue')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('status', 'fetched');
  const phase = (failedRows ?? []).length || job.robots_txt === null ? 'crawling' : (fetched ?? 0) > 0 ? 'indexing' : 'crawling';

  const { data: updated, error: updateError } = await db
    .from('crawl_jobs')
    .update({ status: phase, attempts: 0, error: null, finished_at: null, next_run_at: new Date().toISOString(), lease_until: null, locked_by: null })
    .eq('id', job.id)
    .eq('tenant_id', tenantId)
    .select(JOB_PUBLIC_COLUMNS)
    .single();
  if (updateError) {
    if (updateError.code === '23505') throw new ApiError(409, 'job_active');
    throw new Error(`retry job: ${updateError.message}`);
  }
  await db.from('knowledge_sources').update({ status: phase, last_job_id: job.id }).eq('id', source.id).eq('tenant_id', tenantId);
  await db.from('crawl_job_events').insert({ tenant_id: tenantId, job_id: job.id, level: 'info', code: 'retry', message: `requeued=${(failedRows ?? []).length}` });
  return updated;
}

export async function updateSource(tenantId: string, sourceId: string, body: Settings) {
  await loadSource(tenantId, sourceId);
  const patch = readSettings(body, true);
  if (!Object.keys(patch).length) throw new ApiError(400, 'nothing_to_update');
  const db = admin();
  const { data, error } = await db
    .from('knowledge_sources')
    .update(patch)
    .eq('id', sourceId)
    .eq('tenant_id', tenantId)
    .select(SOURCE_PUBLIC_COLUMNS)
    .single();
  if (error) throw new Error(`update source: ${error.message}`);

  // Përjashtimet e reja vlejnë menjëherë: faqet që përputhen hiqen nga KB tani,
  // jo vetëm në riskanimin e radhës.
  let removed = 0;
  if (patch.exclude_patterns) {
    const { data: docs, error: docsError } = await db
      .from('documents')
      .select('id, url')
      .eq('tenant_id', tenantId)
      .eq('source_id', sourceId);
    if (docsError) throw new Error(`documents: ${docsError.message}`);
    const ids = (docs ?? []).filter((d) => isExcluded(d.url as string, patch.exclude_patterns as string[])).map((d) => d.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error: delError } = await db.from('documents').delete().eq('tenant_id', tenantId).in('id', ids.slice(i, i + 200));
      if (delError) throw new Error(`delete excluded: ${delError.message}`);
    }
    removed = ids.length;
  }
  return { source: data, removed_documents: removed };
}

// Fshin burimin dhe GJITHÇKA të lidhur (dokumente, chunks, job-e, radhë, ngjarje) me cascade.
export async function deleteSource(tenantId: string, sourceId: string): Promise<void> {
  await loadSource(tenantId, sourceId);
  const { error } = await admin().from('knowledge_sources').delete().eq('id', sourceId).eq('tenant_id', tenantId);
  if (error) throw new Error(`delete source: ${error.message}`);
}

export async function listSources(tenantId: string) {
  const db = admin();
  const { data: sources, error } = await db
    .from('knowledge_sources')
    .select(SOURCE_PUBLIC_COLUMNS)
    .eq('tenant_id', tenantId)
    .order('created_at');
  if (error) throw new Error(`sources: ${error.message}`);
  const jobIds = (sources ?? []).map((s) => s.last_job_id).filter(Boolean) as string[];
  const { data: jobs, error: jobsError } = jobIds.length
    ? await db.from('crawl_jobs').select(JOB_PUBLIC_COLUMNS).eq('tenant_id', tenantId).in('id', jobIds)
    : { data: [], error: null };
  if (jobsError) throw new Error(`jobs: ${jobsError.message}`);
  const byId = new Map((jobs ?? []).map((j) => [j.id, j]));

  const out = [];
  for (const s of sources ?? []) {
    const { count } = await db
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('source_id', s.id)
      .eq('status', 'ready');
    out.push({
      ...s,
      documents: count ?? 0,
      last_job: s.last_job_id ? byId.get(s.last_job_id) ?? null : null,
      verification: s.verified_at ? null : verificationInstructions(s.root_url, s.verification_token),
    });
  }
  return out;
}

export async function sourceJobs(tenantId: string, sourceId: string) {
  await loadSource(tenantId, sourceId);
  const db = admin();
  const { data: jobs, error } = await db
    .from('crawl_jobs')
    .select(JOB_PUBLIC_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('source_id', sourceId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`jobs: ${error.message}`);
  const latest = jobs?.[0];
  let events: unknown[] = [];
  let failed: unknown[] = [];
  if (latest) {
    const { data: ev, error: evError } = await db
      .from('crawl_job_events')
      .select('id, level, code, message, url, created_at')
      .eq('tenant_id', tenantId)
      .eq('job_id', latest.id)
      .order('id', { ascending: false })
      .limit(100);
    if (evError) throw new Error(`events: ${evError.message}`);
    events = ev ?? [];
    const { data: fq, error: fqError } = await db
      .from('crawl_queue')
      .select('url, http_status, reason, attempts, updated_at')
      .eq('tenant_id', tenantId)
      .eq('job_id', latest.id)
      .eq('status', 'failed')
      .limit(200);
    if (fqError) throw new Error(`failed urls: ${fqError.message}`);
    failed = fq ?? [];
  }
  return { jobs: jobs ?? [], events, failed_urls: failed };
}
