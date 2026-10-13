import type { SupabaseClient } from '@supabase/supabase-js';
import { sha256Hex } from '../crypto.ts';
import { kbConfig } from '../kb/config.ts';
import { recordEmbeddingUsage, replaceChunks, tenantChunkCount } from '../kb/store.ts';
import { chunkText } from '../rag/chunk.ts';
import { admin } from '../supabase/admin.ts';
import type { CrawlerConfig } from './config.ts';
import { crawlerConfig } from './config.ts';
import { discover, fetchRobots, RetryableCrawlError } from './discover.ts';
import { decodeHtml, extractPage, paragraphHash } from './extract.ts';
import { detectLanguage } from './lang.ts';
import { FetchError, safeFetch } from './netguard.ts';
import type { Robots } from './robots.ts';
import { parseRobots } from './robots.ts';
import { DEFAULT_EXCLUDES, inScope, isExcluded, looksLikeHtml, normalizeUrl } from './url.ts';

// ---------------------------------------------------------------------------
// Worker-i i crawl-it. Një "tick" punon brenda një buxheti kohe (p.sh. 45 s në
// një funksion Vercel, ose pa fund në një proces më vete) dhe lë gjendjen në DB:
//
//   pending -> crawling (robots + sitemap -> radha; fetch + nxjerrje teksti)
//           -> indexing (heq boilerplate, chunks, embeddings vetëm për të ndryshuarat)
//           -> ready | failed
//
// Asnjë hap nuk varet nga memoria e procesit: një tick i ndërprerë vazhdon nga tick-u
// tjetër (lease skadon), dhe një URL i dështuar riprovohet me backoff.
// ---------------------------------------------------------------------------

export type CrawlJob = {
  id: string;
  tenant_id: string;
  source_id: string;
  trigger: string;
  status: 'pending' | 'crawling' | 'indexing' | 'ready' | 'failed' | 'cancelled';
  max_pages: number;
  max_depth: number;
  pages_discovered: number;
  pages_processed: number;
  pages_failed: number;
  pages_skipped: number;
  pages_unchanged: number;
  pages_indexed: number;
  pages_deleted: number;
  chunks_embedded: number;
  chunks_reused: number;
  embedding_tokens: number;
  truncated: boolean;
  incomplete: boolean;
  robots_txt: string | null;
  crawl_delay_ms: number;
  boilerplate: string[];
  attempts: number;
  started_at: string | null;
};

type Source = {
  id: string;
  tenant_id: string;
  knowledge_base_id: string;
  root_url: string;
  host: string;
  enabled: boolean;
  exclude_patterns: string[];
  sync_interval_hours: number;
  boilerplate: string[];
};

type Tenant = { id: string; status: string; trial_ends_at: string; max_kb_chunks: number; min_sync_interval_hours: number };

type QueueRow = { id: number; url: string; depth: number; attempts: number; from_sitemap: boolean };

type Extracted = {
  docUrl: string;
  title: string;
  description: string;
  lang: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  etag: string | null;
  lastModified: string | null;
  paragraphs: string[];
};

const COUNTERS = [
  'pages_discovered', 'pages_processed', 'pages_failed', 'pages_skipped', 'pages_unchanged', 'pages_indexed',
  'pages_deleted', 'chunks_embedded', 'chunks_reused', 'embedding_tokens', 'truncated', 'incomplete',
] as const;

const MAX_JOB_ATTEMPTS = 5;
const JOB_MAX_HOURS = 6;
const SOURCE_COLUMNS = 'id, tenant_id, knowledge_base_id, root_url, host, enabled, exclude_patterns, sync_interval_hours, boilerplate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

// Kodet e gabimeve që shfaqen te paneli/plugin-i: kurrë mesazhe të brendshme ose sekrete.
export function publicErrorCode(e: unknown): string {
  if (e instanceof FetchError || e instanceof RetryableCrawlError) return e.code;
  return 'internal_error';
}

class JobContext {
  db: SupabaseClient;
  job: CrawlJob;
  source: Source;
  tenant: Tenant;
  cfg: CrawlerConfig;
  robots: Robots;
  excludes: string[];
  known = new Set<string>();

  constructor(db: SupabaseClient, job: CrawlJob, source: Source, tenant: Tenant, cfg: CrawlerConfig) {
    this.db = db;
    this.job = job;
    this.source = source;
    this.tenant = tenant;
    this.cfg = cfg;
    this.robots = parseRobots(job.robots_txt ?? '', cfg.robotsAgent);
    this.excludes = [...DEFAULT_EXCLUDES, ...source.exclude_patterns];
  }

  async event(level: 'info' | 'warn' | 'error', code: string, message?: string, url?: string): Promise<void> {
    const { error } = await this.db.from('crawl_job_events').insert({
      tenant_id: this.job.tenant_id,
      job_id: this.job.id,
      level,
      code: code.slice(0, 60),
      message: clip(message, 500),
      url: clip(url, 2000),
    });
    if (error) console.error('[crawl] event', error.message);
  }

  async save(extra: Record<string, unknown> = {}): Promise<void> {
    const patch: Record<string, unknown> = { ...extra };
    for (const k of COUNTERS) patch[k] = this.job[k];
    const { error } = await this.db.from('crawl_jobs').update(patch).eq('id', this.job.id).eq('tenant_id', this.job.tenant_id);
    if (error) throw new Error(`save job: ${error.message}`);
  }

  async setSourceStatus(status: string, extra: Record<string, unknown> = {}): Promise<void> {
    const { error } = await this.db
      .from('knowledge_sources')
      .update({ status, last_job_id: this.job.id, ...extra })
      .eq('id', this.source.id)
      .eq('tenant_id', this.job.tenant_id);
    if (error) throw new Error(`source status: ${error.message}`);
  }

  allowed(url: string): boolean {
    return inScope(url, this.source.host) && looksLikeHtml(url) && !isExcluded(url, this.excludes) && this.robots.isAllowed(url);
  }

  fetchOpts(headers?: Record<string, string>) {
    return {
      ...this.cfg.net,
      userAgent: this.cfg.userAgent,
      timeoutMs: this.cfg.timeoutMs,
      maxBytes: this.cfg.maxBytes,
      maxRedirects: this.cfg.maxRedirects,
      headers,
    };
  }

  // Shton URL në radhë pa kaluar max_pages; duplikatat i injoron indeksi unik.
  async enqueue(urls: string[], depth: number, fromSitemap: boolean): Promise<number> {
    const candidates: string[] = [];
    for (const u of urls) {
      if (this.known.has(u) || !this.allowed(u)) continue;
      this.known.add(u);
      candidates.push(u);
    }
    let added = 0;
    let i = 0;
    while (i < candidates.length) {
      const room = this.job.max_pages - this.job.pages_discovered;
      if (room <= 0) {
        // Kontrollo nëse të mbeturat janë vërtet të reja (jo thjesht menuja e përsëritur).
        const rest = candidates.slice(i, i + 50);
        const { data } = await this.db.from('crawl_queue').select('url').eq('job_id', this.job.id).in('url', rest);
        if ((data ?? []).length < rest.length) this.job.truncated = true;
        break;
      }
      const batch = candidates.slice(i, i + Math.min(room, 100));
      i += batch.length;
      const { data, error } = await this.db
        .from('crawl_queue')
        .upsert(
          batch.map((url) => ({ tenant_id: this.job.tenant_id, job_id: this.job.id, url, depth, from_sitemap: fromSitemap })),
          { onConflict: 'job_id,url', ignoreDuplicates: true },
        )
        .select('id');
      if (error) throw new Error(`enqueue: ${error.message}`);
      added += (data ?? []).length;
      this.job.pages_discovered += (data ?? []).length;
    }
    return added;
  }

  async finishRow(row: QueueRow, status: string, fields: Record<string, unknown> = {}): Promise<void> {
    const { error } = await this.db
      .from('crawl_queue')
      .update({ status, updated_at: nowIso(), ...fields })
      .eq('id', row.id)
      .eq('tenant_id', this.job.tenant_id);
    if (error) throw new Error(`queue update: ${error.message}`);
  }

  // Shënon dokumentin ekzistues të këtij URL-je si "parë në këtë job", që mos fshihet
  // në fund (p.sh. kur faqja ktheu 304 ose dështoi përkohësisht).
  async touchDocument(url: string): Promise<void> {
    const { error } = await this.db
      .from('documents')
      .update({ last_seen_job_id: this.job.id })
      .eq('source_id', this.source.id)
      .eq('tenant_id', this.job.tenant_id)
      .eq('url', url);
    if (error) throw new Error(`touch document: ${error.message}`);
  }
}

// ----------------------------------------------------------------- CRAWLING

async function seed(ctx: JobContext): Promise<void> {
  const { job, source, cfg } = ctx;
  const origin = new URL(source.root_url).origin;
  const robotsText = await fetchRobots(origin, cfg);
  const found = await discover(source.root_url, source.host, robotsText, job.max_pages * 2, cfg);
  ctx.robots = found.robots;
  job.robots_txt = robotsText;
  job.crawl_delay_ms = Math.min(found.robots.crawlDelayMs ?? 0, cfg.maxDelayMs);

  const root = normalizeUrl(source.root_url)!;
  await ctx.enqueue([root], 0, false);
  await ctx.enqueue(found.sitemapUrls, 0, true);
  if (found.incomplete) job.incomplete = true;
  await ctx.save({ robots_txt: robotsText, crawl_delay_ms: job.crawl_delay_ms });
  await ctx.event(
    found.incomplete ? 'warn' : 'info',
    'seeded',
    `sitemaps=${found.sitemapsRead} sitemap_urls=${found.sitemapUrls.length} queued=${job.pages_discovered}${found.incomplete ? ' sitemap_unavailable' : ''}`,
  );
  if (job.pages_discovered === 0) throw new PermanentJobError('blocked_by_robots');
}

class PermanentJobError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const TRANSIENT: FetchError['code'][] = ['timeout', 'network', 'dns_failed'];

async function retryLater(ctx: JobContext, row: QueueRow, reason: string, waitMs: number, httpStatus: number | null): Promise<void> {
  const attempts = row.attempts + 1;
  if (attempts >= ctx.cfg.maxAttempts) {
    ctx.job.pages_failed++;
    await ctx.touchDocument(row.url);
    await ctx.finishRow(row, 'failed', { attempts, reason, http_status: httpStatus });
    await ctx.event('warn', reason, `failed after ${attempts} attempts`, row.url);
    return;
  }
  await ctx.finishRow(row, 'pending', {
    attempts,
    reason,
    http_status: httpStatus,
    next_attempt_at: new Date(Date.now() + waitMs).toISOString(),
  });
}

async function processUrl(ctx: JobContext, row: QueueRow): Promise<void> {
  const { db, job, source, cfg } = ctx;

  const { data: existing, error: existingError } = await db
    .from('documents')
    .select('etag, last_modified, status')
    .eq('source_id', source.id)
    .eq('tenant_id', job.tenant_id)
    .eq('url', row.url)
    .maybeSingle();
  if (existingError) throw new Error(`existing document: ${existingError.message}`);
  // Kërkesë e kushtëzuar: nëse faqja nuk ka ndryshuar, serveri kthen 304 pa body.
  const conditional: Record<string, string> = {};
  if (existing?.status === 'ready' && existing.etag) conditional['if-none-match'] = existing.etag;
  if (existing?.status === 'ready' && existing.last_modified) conditional['if-modified-since'] = existing.last_modified;

  let res;
  try {
    res = await safeFetch(row.url, ctx.fetchOpts(conditional));
  } catch (e) {
    if (e instanceof FetchError && TRANSIENT.includes(e.code)) {
      return retryLater(ctx, row, e.code, cfg.retryBaseMs * 2 ** row.attempts, null);
    }
    const code = publicErrorCode(e);
    if (!(e instanceof FetchError)) console.error('[crawl] fetch', row.url, e);
    job.pages_failed++;
    await ctx.finishRow(row, 'failed', { reason: code, attempts: row.attempts + 1 });
    await ctx.event('warn', code, undefined, row.url);
    return;
  }

  const status = res.status;
  if (status === 304) {
    job.pages_processed++;
    job.pages_unchanged++;
    await ctx.touchDocument(row.url);
    return ctx.finishRow(row, 'unchanged', { http_status: 304 });
  }
  if (status === 429 || status === 503) {
    const retryAfter = Number(res.headers['retry-after']);
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 600_000) : cfg.retryBaseMs * 2 ** (row.attempts + 1);
    return retryLater(ctx, row, status === 429 ? 'rate_limited_by_site' : 'site_unavailable', wait, status);
  }
  if (status >= 500) return retryLater(ctx, row, `http_${status}`, cfg.retryBaseMs * 2 ** row.attempts, status);
  if (status === 401 || status === 403) {
    // Faqe e mbrojtur: nuk anashkalojmë autentikimin ose paywall-in.
    job.pages_processed++;
    job.pages_skipped++;
    await ctx.event('info', 'access_denied', `http ${status}`, row.url);
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'access_denied' });
  }
  if (status === 404 || status === 410) {
    job.pages_processed++;
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'not_found' });
  }
  if (status < 200 || status >= 300) {
    job.pages_processed++;
    job.pages_failed++;
    await ctx.event('warn', `http_${status}`, undefined, row.url);
    return ctx.finishRow(row, 'failed', { http_status: status, reason: `http_${status}` });
  }

  const finalUrl = normalizeUrl(res.url);
  if (!finalUrl || !inScope(finalUrl, source.host)) {
    job.pages_processed++;
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'redirect_out_of_scope' });
  }
  if (finalUrl !== row.url && !ctx.allowed(finalUrl)) {
    job.pages_processed++;
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'redirect_excluded' });
  }

  const contentType = (res.headers['content-type'] || '').toLowerCase();
  const sniff = res.body.subarray(0, 1024).toString('latin1').toLowerCase();
  const isHtml = /^(text\/html|application\/xhtml\+xml)/.test(contentType) || (!contentType && /<html|<!doctype html/.test(sniff));
  if (!isHtml) {
    job.pages_processed++;
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'not_html' });
  }

  const page = extractPage(decodeHtml(res.body, contentType), finalUrl);
  const xRobots = (res.headers['x-robots-tag'] || '').toLowerCase();
  const noindex = page.noindex || /\b(noindex|none)\b/.test(xRobots);
  const nofollow = page.nofollow || /\b(nofollow|none)\b/.test(xRobots);

  if (!nofollow && row.depth < job.max_depth) await ctx.enqueue(page.links, row.depth + 1, false);

  job.pages_processed++;
  if (noindex) {
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'noindex' });
  }

  // Canonical brenda site-it bashkon variantet e së njëjtës faqe në një dokument.
  const docUrl = page.canonical && page.canonical !== finalUrl && ctx.allowed(page.canonical) ? page.canonical : finalUrl;

  const paragraphs: string[] = [];
  let total = 0;
  for (const p of page.paragraphs) {
    if (total + p.length > cfg.maxPageChars) break;
    paragraphs.push(p);
    total += p.length + 2;
  }
  if (total < 50) {
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { http_status: status, reason: 'empty_content' });
  }

  const extracted: Extracted = {
    docUrl,
    title: page.title,
    description: page.description,
    lang: page.lang,
    publishedAt: page.publishedAt,
    modifiedAt: page.modifiedAt,
    etag: clip(res.headers.etag, 300),
    lastModified: clip(res.headers['last-modified'], 100),
    paragraphs,
  };
  await ctx.finishRow(row, 'fetched', { http_status: status, extracted, para_hashes: paragraphs.map(paragraphHash) });
}

async function crawlPhase(ctx: JobContext, deadline: number): Promise<void> {
  const { db, job, cfg } = ctx;
  if (job.robots_txt === null) await seed(ctx);
  const delay = Math.min(Math.max(cfg.minDelayMs, job.crawl_delay_ms), cfg.maxDelayMs);

  let first = true;
  outer: while (Date.now() < deadline) {
    const { data: rows, error } = await db.rpc('claim_crawl_urls', { p_job_id: job.id, p_limit: 5 });
    if (error) throw new Error(`claim_crawl_urls: ${error.message}`);
    if (!rows?.length) break;
    for (const row of rows as QueueRow[]) {
      if (Date.now() + delay + cfg.timeoutMs > deadline) break outer;
      // Pauzë mirësjelljeje midis kërkesave te i njëjti server.
      if (!first && delay) await sleep(delay);
      first = false;
      await processUrl(ctx, row);
      await ctx.save();
    }
  }

  const { count: pending, error: pendingError } = await db
    .from('crawl_queue')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('status', 'pending');
  if (pendingError) throw new Error(`pending count: ${pendingError.message}`);
  if ((pending ?? 0) > 0) {
    // Ka URL që presin backoff: rizgjohu kur vjen radha e të parit.
    const { data: next } = await db
      .from('crawl_queue')
      .select('next_attempt_at')
      .eq('job_id', job.id)
      .eq('status', 'pending')
      .order('next_attempt_at')
      .limit(1);
    const at = next?.[0]?.next_attempt_at as string | undefined;
    if (at && new Date(at).getTime() > Date.now()) await ctx.save({ next_run_at: at });
    return;
  }

  // Crawl-i mbaroi: paragrafët që përsëriten në shumicën e faqeve janë menu/footer.
  const { count: fetched } = await db
    .from('crawl_queue')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('status', 'fetched');
  // Me pak faqe të marra (riskanim i cunguar, retry) statistika s'mjafton: përdoret
  // boilerplate-i i crawl-it të fundit të madh, që teksti i faqeve të mos "ndryshojë" kot.
  let boilerplate = ctx.source.boilerplate ?? [];
  const sample = (fetched ?? 0) >= 4;
  if (sample) {
    const minPages = Math.max(3, Math.ceil((fetched ?? 0) * 0.5));
    const { data, error: bpError } = await db.rpc('crawl_boilerplate', { p_job_id: job.id, p_min_pages: minPages });
    if (bpError) throw new Error(`crawl_boilerplate: ${bpError.message}`);
    boilerplate = (data as string[] | null) ?? [];
  }
  job.status = 'indexing';
  job.boilerplate = boilerplate;
  await ctx.save({ status: 'indexing', boilerplate });
  await ctx.setSourceStatus('indexing', sample ? { boilerplate } : {});
  await ctx.event('info', 'crawl_done', `fetched=${fetched ?? 0} boilerplate_paragraphs=${boilerplate.length}`);
}

// ----------------------------------------------------------------- INDEXING

async function indexRow(ctx: JobContext, row: QueueRow & { extracted: Extracted }): Promise<void> {
  const { db, job, source, tenant } = ctx;
  const ex = row.extracted;
  const bp = new Set(job.boilerplate);
  const text = ex.paragraphs.filter((p) => !bp.has(paragraphHash(p))).join('\n\n').trim();
  if (text.length < 50) {
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { reason: 'empty_after_cleanup', extracted: null, para_hashes: null });
  }
  const hash = sha256Hex(text);

  const { data: existing, error: existingError } = await db
    .from('documents')
    .select('id, content_hash, status, chunk_count, last_seen_job_id')
    .eq('source_id', source.id)
    .eq('tenant_id', job.tenant_id)
    .eq('url', ex.docUrl)
    .maybeSingle();
  if (existingError) throw new Error(`document: ${existingError.message}`);
  if (existing && existing.last_seen_job_id === job.id && existing.content_hash === hash) {
    // E njëjta faqe arriti nga dy URL (canonical): një dokument mjafton.
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { reason: 'duplicate_url', extracted: null, para_hashes: null });
  }
  const { data: twin } = await db
    .from('documents')
    .select('id')
    .eq('source_id', source.id)
    .eq('tenant_id', job.tenant_id)
    .eq('content_hash', hash)
    .eq('last_seen_job_id', job.id)
    .neq('url', ex.docUrl)
    .limit(1);
  if (twin?.length) {
    job.pages_skipped++;
    return ctx.finishRow(row, 'skipped', { reason: 'duplicate_content', extracted: null, para_hashes: null });
  }

  const title = (ex.title || new URL(ex.docUrl).pathname || ex.docUrl).trim().slice(0, 200) || ex.docUrl.slice(0, 200);
  const meta = {
    title,
    description: clip(ex.description, 500),
    language: detectLanguage(text, ex.lang),
    etag: ex.etag,
    last_modified: ex.lastModified,
    published_at: ex.publishedAt,
    modified_at: ex.modifiedAt,
    last_seen_job_id: job.id,
    updated_at: nowIso(),
  };

  if (existing && existing.content_hash === hash && existing.status === 'ready') {
    const { error } = await db.from('documents').update(meta).eq('id', existing.id).eq('tenant_id', job.tenant_id);
    if (error) throw new Error(`update unchanged: ${error.message}`);
    job.pages_unchanged++;
    return ctx.finishRow(row, 'unchanged', { extracted: null, para_hashes: null });
  }

  const cfg = kbConfig();
  const chunks = chunkText(text, { maxChars: cfg.chunkMaxChars, overlapChars: cfg.chunkOverlapChars });
  const current = await tenantChunkCount(db, job.tenant_id);
  if (current - (existing?.chunk_count ?? 0) + chunks.length > tenant.max_kb_chunks) {
    // Plani u mbush: dokumenti i vjetër (nëse ka) mbetet; job-i shënohet i cunguar
    // që faqet e paparë të mos fshihen gabimisht.
    job.truncated = true;
    job.pages_skipped++;
    if (existing) await ctx.touchDocument(ex.docUrl);
    await ctx.event('warn', 'kb_limit_reached', undefined, ex.docUrl);
    return ctx.finishRow(row, 'skipped', { reason: 'kb_limit_reached', extracted: null, para_hashes: null });
  }

  let documentId = existing?.id as string | undefined;
  if (!documentId) {
    const { data, error } = await db
      .from('documents')
      .insert({
        tenant_id: job.tenant_id,
        knowledge_base_id: source.knowledge_base_id,
        source_id: source.id,
        url: ex.docUrl,
        source_type: 'web',
        status: 'processing',
        content_hash: hash,
        char_count: text.length,
        ...meta,
      })
      .select('id')
      .single();
    if (error) throw new Error(`insert document: ${error.message}`);
    documentId = data.id as string;
  }

  try {
    const stored = await replaceChunks(db, {
      tenantId: job.tenant_id,
      knowledgeBaseId: source.knowledge_base_id,
      documentId,
      chunks,
    });
    const { error } = await db
      .from('documents')
      .update({ ...meta, status: 'ready', content_hash: hash, char_count: text.length, chunk_count: chunks.length, indexed_at: nowIso() })
      .eq('id', documentId)
      .eq('tenant_id', job.tenant_id);
    if (error) throw new Error(`document ready: ${error.message}`);
    await recordEmbeddingUsage(db, job.tenant_id, stored.model, stored.tokens);
    job.pages_indexed++;
    job.chunks_embedded += stored.embedded;
    job.chunks_reused += stored.reused;
    job.embedding_tokens += stored.tokens;
  } catch (e) {
    // Dokument i ri gjysmak nuk duhet të mbetet; një i vjetër mbetet me chunks e veta.
    if (!existing) await db.from('documents').delete().eq('id', documentId).eq('tenant_id', job.tenant_id);
    throw e;
  }
  return ctx.finishRow(row, 'indexed', { extracted: null, para_hashes: null });
}

async function finalize(ctx: JobContext): Promise<void> {
  const { db, job, source, tenant } = ctx;

  // Faqet që nuk u panë në një crawl të plotë dhe të shëndetshëm janë fshirë/përjashtuar
  // nga site-i. Kur site-i ishte i rënë (shumica e kërkesave dështuan) nuk fshihet asgjë:
  // një dështim i përkohshëm nuk duhet të zbrazë njohuritë e klientit.
  const ok = job.pages_indexed + job.pages_unchanged > 0;
  const unhealthy = job.pages_failed > 0.5 * (job.pages_processed + job.pages_failed);
  if (unhealthy && ok) await ctx.event('warn', 'deletions_skipped', `failed=${job.pages_failed}`);
  if (!job.truncated && !job.incomplete && ok && !unhealthy) {
    const { data: docs, error } = await db
      .from('documents')
      .select('id, last_seen_job_id')
      .eq('source_id', source.id)
      .eq('tenant_id', job.tenant_id);
    if (error) throw new Error(`stale documents: ${error.message}`);
    const stale = (docs ?? []).filter((d) => d.last_seen_job_id !== job.id).map((d) => d.id as string);
    for (let i = 0; i < stale.length; i += 200) {
      const { error: delError } = await db.from('documents').delete().eq('tenant_id', job.tenant_id).in('id', stale.slice(i, i + 200));
      if (delError) throw new Error(`delete stale: ${delError.message}`);
    }
    job.pages_deleted = stale.length;
  }

  const status = ok ? 'ready' : 'failed';
  job.status = status;
  await ctx.save({
    status,
    error: ok ? null : 'no_pages_indexed',
    finished_at: nowIso(),
    lease_until: null,
    locked_by: null,
    boilerplate: [],
  });
  // Radha nuk duhet më; mbahen vetëm URL-të e dështuara (për "riprovo").
  const { error: cleanError } = await db.from('crawl_queue').delete().eq('job_id', job.id).neq('status', 'failed');
  if (cleanError) console.error('[crawl] cleanup', cleanError.message);

  const hours = Math.max(source.sync_interval_hours, tenant.min_sync_interval_hours);
  await ctx.setSourceStatus(status, {
    ...(ok ? { last_synced_at: nowIso() } : {}),
    next_sync_at: new Date(Date.now() + hours * 3600_000).toISOString(),
  });
  await ctx.event(
    ok ? 'info' : 'error',
    ok ? 'finished' : 'no_pages_indexed',
    `indexed=${job.pages_indexed} unchanged=${job.pages_unchanged} deleted=${job.pages_deleted} failed=${job.pages_failed} skipped=${job.pages_skipped}`,
  );
}

async function indexPhase(ctx: JobContext, deadline: number): Promise<void> {
  const { db, job } = ctx;
  while (Date.now() < deadline) {
    const { data: rows, error } = await db
      .from('crawl_queue')
      .select('id, url, depth, attempts, from_sitemap, extracted')
      .eq('job_id', job.id)
      .eq('status', 'fetched')
      .order('id')
      .limit(3);
    if (error) throw new Error(`fetched rows: ${error.message}`);
    if (!rows?.length) return finalize(ctx);
    for (const row of rows as (QueueRow & { extracted: Extracted })[]) {
      if (Date.now() > deadline) return;
      await indexRow(ctx, row);
      await ctx.save();
    }
  }
}

// ----------------------------------------------------------------- JOB LOOP

async function failJob(db: SupabaseClient, job: CrawlJob, code: string, sourceIntervalHours: number | null): Promise<void> {
  await db
    .from('crawl_jobs')
    .update({ status: 'failed', error: code, finished_at: nowIso(), lease_until: null, locked_by: null })
    .eq('id', job.id)
    .eq('tenant_id', job.tenant_id);
  await db
    .from('knowledge_sources')
    .update({
      status: 'failed',
      last_job_id: job.id,
      ...(sourceIntervalHours ? { next_sync_at: new Date(Date.now() + sourceIntervalHours * 3600_000).toISOString() } : {}),
    })
    .eq('id', job.source_id)
    .eq('tenant_id', job.tenant_id);
  await db.from('crawl_job_events').insert({ tenant_id: job.tenant_id, job_id: job.id, level: 'error', code });
}

async function advanceJob(db: SupabaseClient, job: CrawlJob, deadline: number, cfg: CrawlerConfig): Promise<void> {
  const { data: source, error: sourceError } = await db
    .from('knowledge_sources')
    .select(SOURCE_COLUMNS)
    .eq('id', job.source_id)
    .eq('tenant_id', job.tenant_id)
    .maybeSingle();
  if (sourceError) throw new Error(`source: ${sourceError.message}`);
  if (!source || !(source as Source).enabled) {
    await db
      .from('crawl_jobs')
      .update({ status: 'cancelled', finished_at: nowIso(), lease_until: null, locked_by: null, error: 'source_disabled' })
      .eq('id', job.id)
      .eq('tenant_id', job.tenant_id);
    return;
  }
  const { data: tenant, error: tenantError } = await db
    .from('tenants')
    .select('id, status, trial_ends_at, max_kb_chunks, min_sync_interval_hours')
    .eq('id', job.tenant_id)
    .single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  const t = tenant as Tenant;
  if (t.status !== 'active' || new Date(t.trial_ends_at).getTime() < Date.now()) {
    return failJob(db, job, 'plan_inactive', null);
  }
  if (job.started_at && Date.now() - new Date(job.started_at).getTime() > JOB_MAX_HOURS * 3600_000) {
    return failJob(db, job, 'job_timeout', (source as Source).sync_interval_hours);
  }

  const ctx = new JobContext(db, job, source as Source, t, cfg);
  if (job.status === 'crawling') {
    await ctx.setSourceStatus('crawling');
    await crawlPhase(ctx, deadline);
  }
  if (job.status === 'indexing' && Date.now() < deadline) await indexPhase(ctx, deadline);
}

export type TickResult = { jobs: number; enqueued: number; errors: number };

// Një "tick" i worker-it: planifikon riskanimet që u ka ardhur koha dhe përparon
// job-et brenda buxhetit. Mund të ekzekutohet paralelisht nga disa procese.
export async function runCrawlTick(opts: { workerId: string; budgetMs: number }): Promise<TickResult> {
  const db = admin();
  const cfg = crawlerConfig();
  const deadline = Date.now() + opts.budgetMs;
  const result: TickResult = { jobs: 0, enqueued: 0, errors: 0 };

  const { data: enqueued, error: enqueueError } = await db.rpc('enqueue_due_syncs', { p_limit: 20 });
  if (enqueueError) console.error('[crawl] enqueue_due_syncs', enqueueError.message);
  else result.enqueued = (enqueued as number) ?? 0;

  while (Date.now() < deadline - 2_000) {
    const { data, error } = await db.rpc('claim_crawl_job', {
      p_worker: opts.workerId,
      p_lease_seconds: Math.ceil(opts.budgetMs / 1000) + 60,
    });
    if (error) throw new Error(`claim_crawl_job: ${error.message}`);
    const job = data as CrawlJob | null;
    if (!job || !job.id) break;
    result.jobs++;

    try {
      await advanceJob(db, job, deadline, cfg);
      // Liro lease-in që një tick tjetër (ose ky) ta vazhdojë menjëherë.
      await db
        .from('crawl_jobs')
        .update({ lease_until: null, locked_by: null })
        .eq('id', job.id)
        .eq('tenant_id', job.tenant_id)
        .eq('locked_by', opts.workerId);
    } catch (e) {
      result.errors++;
      const code = e instanceof PermanentJobError ? e.code : publicErrorCode(e);
      if (code === 'internal_error') console.error('[crawl] job dështoi', job.id, e);
      const attempts = job.attempts + 1;
      if (e instanceof PermanentJobError || attempts >= MAX_JOB_ATTEMPTS || (e instanceof FetchError && !TRANSIENT.includes(e.code))) {
        const { data: s } = await db.from('knowledge_sources').select('sync_interval_hours').eq('id', job.source_id).maybeSingle();
        await failJob(db, job, code, (s?.sync_interval_hours as number | undefined) ?? 24);
      } else {
        // Backoff eksponencial: 2, 4, 8, 16 minuta.
        await db
          .from('crawl_jobs')
          .update({
            attempts,
            error: code,
            next_run_at: new Date(Date.now() + 2 ** attempts * 60_000).toISOString(),
            lease_until: null,
            locked_by: null,
          })
          .eq('id', job.id)
          .eq('tenant_id', job.tenant_id);
        await db.from('crawl_job_events').insert({ tenant_id: job.tenant_id, job_id: job.id, level: 'warn', code, message: `attempt ${attempts}` });
      }
    }
  }
  return result;
}
