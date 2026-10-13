'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../../lib/supabase/browser.ts';
import { ApiCallError, apiPost, apiRequest } from '../../../lib/ui/api.ts';
import { useStrings } from '../../../lib/ui/strings.ts';
import type { StringKey, Translate } from '../../../lib/ui/strings.ts';
import { ACTIVE, JOB_SELECT, SOURCE_ERRORS, SOURCE_SELECT, STATUS_KEY, verificationFor } from '../../../lib/ui/website.ts';
import type { EventRow, JobRow, SourceRow, WebPageRow } from '../../../lib/ui/website.ts';

type DocumentRow = { id: string; title: string; status: string; chunk_count: number; char_count: number; created_at: string };

const ERRORS: Record<string, StringKey> = {
  duplicate_document: 'errDuplicate',
  content_too_short: 'errTooShort',
  title_required: 'errTooShort',
  content_too_long: 'errTooLong',
  payload_too_large: 'errTooLong',
  kb_limit_reached: 'errKbLimit',
  rate_limited: 'errRateLimited',
};

function errorText(t: Translate, e: unknown): string {
  const code = e instanceof ApiCallError ? e.code : '';
  const key = SOURCE_ERRORS[code] ?? ERRORS[code];
  return key ? t(key) : t('genericError');
}

// Një website: statusi i skanimit, verifikimi, veprimet, përjashtimet, faqet dhe problemet.
function WebsiteSource({ source, t, locale, reload }: { source: SourceRow; t: Translate; locale: string; reload: () => Promise<void> }) {
  const [job, setJob] = useState<JobRow | null>(null);
  const [pages, setPages] = useState<WebPageRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [excludes, setExcludes] = useState(source.exclude_patterns.join('\n'));
  const [interval, setIntervalHours] = useState(source.sync_interval_hours);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const loadDetail = useCallback(async () => {
    const client = supabase();
    const [jobRes, pagesRes, eventsRes] = await Promise.all([
      source.last_job_id ? client.from('crawl_jobs').select(JOB_SELECT).eq('id', source.last_job_id).maybeSingle() : Promise.resolve({ data: null }),
      client.from('documents').select('id, title, url, enabled, chunk_count').eq('source_id', source.id).order('url').limit(300),
      source.last_job_id
        ? client.from('crawl_job_events').select('id, level, code, message, url').eq('job_id', source.last_job_id).in('level', ['warn', 'error']).order('id', { ascending: false }).limit(50)
        : Promise.resolve({ data: [] }),
    ]);
    setJob((jobRes.data ?? null) as JobRow | null);
    setPages((pagesRes.data ?? []) as WebPageRow[]);
    setEvents((eventsRes.data ?? []) as EventRow[]);
  }, [source.id, source.last_job_id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, source.status]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      await run();
      await reload();
    } catch (e) {
      setNotice({ ok: false, text: errorText(t, e) });
    }
    setBusy(false);
  }

  const base = `/api/kb/sources/${source.id}`;
  const active = ACTIVE.includes(source.status);
  const verification = source.verified_at ? null : verificationFor(source);
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  return (
    <div className="source">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="name">{source.root_url}</div>
          <div className="muted small">
            <span className={`badge ${source.status}`}>{t(STATUS_KEY[source.status])}</span>{' '}
            {source.enabled ? null : <span className="badge off">{t('sourceDisabled')}</span>} {pages.length} {t('pagesInKb')}
          </div>
        </div>
      </div>

      {verification ? (
        <div className="notice wait">
          <strong>{t('verifyTitle')}</strong>
          <p className="small">{t('verifyLead')}</p>
          <code className="snippet">{verification.meta}</code>
          <p className="small">
            {t('verifyFile')} <code>{verification.fileUrl}</code>: <code>{source.verification_token}</code>
          </p>
          <button className="btn" type="button" disabled={busy} onClick={() => void act(() => apiRequest('POST', `${base}/verify`))}>
            {busy ? t('verifying') : t('verifyButton')}
          </button>
        </div>
      ) : null}

      {job ? (
        <dl className="stats">
          <div><dt>{t('countDiscovered')}</dt><dd>{job.pages_discovered}</dd></div>
          <div><dt>{t('countNew')}</dt><dd>{job.pages_indexed}</dd></div>
          <div><dt>{t('countUnchanged')}</dt><dd>{job.pages_unchanged}</dd></div>
          <div><dt>{t('countFailed')}</dt><dd>{job.pages_failed}</dd></div>
          <div><dt>{t('countSkipped')}</dt><dd>{job.pages_skipped}</dd></div>
        </dl>
      ) : null}
      {job?.truncated ? <p className="muted small">{t('truncatedNote')}</p> : null}
      {job?.incomplete ? <p className="muted small">{t('incompleteNote')}</p> : null}
      <p className="muted small">
        {t('lastScan')}: {date(source.last_synced_at)} · {t('nextScan')}: {date(source.next_sync_at)}
      </p>

      {notice ? <p className={notice.ok ? 'notice ok' : 'notice error'} role="alert">{notice.text}</p> : null}
      <div className="row">
        {source.verified_at && !active ? (
          <button className="btn" type="button" disabled={busy || !source.enabled} onClick={() => void act(() => apiRequest('POST', `${base}/sync`))}>{t('rescan')}</button>
        ) : null}
        {!active && (source.status === 'failed' || (job?.pages_failed ?? 0) > 0) ? (
          <button className="btn quiet" type="button" disabled={busy} onClick={() => void act(() => apiRequest('POST', `${base}/retry`))}>{t('retryFailed')}</button>
        ) : null}
        <button className="btn quiet" type="button" disabled={busy} onClick={() => void act(() => apiRequest('PATCH', base, { enabled: !source.enabled }))}>
          {source.enabled ? t('disableSource') : t('enableSource')}
        </button>
        <button
          className="btn danger"
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('confirmDeleteSource'))) void act(() => apiRequest('DELETE', base));
          }}
        >
          {t('deleteSource')}
        </button>
      </div>

      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const patterns = excludes.split('\n').map((l) => l.trim()).filter(Boolean);
          void act(() => apiRequest('PATCH', base, { exclude_patterns: patterns, sync_interval_hours: interval }));
        }}
      >
        <label htmlFor={`ex-${source.id}`}>{t('excludeTitle')}</label>
        <textarea id={`ex-${source.id}`} rows={3} aria-describedby={`ex-hint-${source.id}`} placeholder="/blog/tag/" value={excludes} onChange={(e) => setExcludes(e.target.value)} />
        <p id={`ex-hint-${source.id}`} className="muted small">{t('excludeHint')}</p>
        <label htmlFor={`int-${source.id}`}>{t('scanEvery')}</label>
        <input id={`int-${source.id}`} type="number" min={1} max={8760} value={interval} onChange={(e) => setIntervalHours(Number(e.target.value) || 1)} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn quiet" type="submit" disabled={busy}>{t('saveScan')}</button>
        </div>
      </form>

      {events.length ? (
        <details>
          <summary>{t('problemsTitle')} ({events.length})</summary>
          <ul className="small">
            {events.map((e) => (
              <li key={e.id}><code>{e.code}</code> {e.url ?? ''} {e.message ?? ''}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {pages.length ? (
        <details>
          <summary>{t('pagesTitle')} ({pages.length})</summary>
          {pages.map((p) => (
            <div key={p.id} className="doc">
              <div>
                <div className="name">{p.title}</div>
                <a className="muted small" href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a>
                {p.enabled ? null : <span className="badge off">{t('pageOff')}</span>}
              </div>
              <button type="button" className="btn quiet" disabled={busy} onClick={() => void act(() => apiRequest('PATCH', `/api/kb/documents/${p.id}`, { enabled: !p.enabled }).then(loadDetail))}>
                {p.enabled ? t('skipPage') : t('usePage')}
              </button>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

export default function KnowledgePage() {
  const { t, locale } = useStrings();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [siteUrl, setSiteUrl] = useState('');
  const [siteError, setSiteError] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const client = supabase();
    const [docs, srcs] = await Promise.all([
      // Dokumentet manuale; faqet e website-it shfaqen te burimi i vet.
      client.from('documents').select('id, title, status, chunk_count, char_count, created_at').is('source_id', null).order('created_at', { ascending: false }),
      client.from('knowledge_sources').select(SOURCE_SELECT).order('created_at'),
    ]);
    if (docs.error || srcs.error) setError(t('genericError'));
    setDocuments((docs.data ?? []) as DocumentRow[]);
    setSources((srcs.data ?? []) as SourceRow[]);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Rifreskim ndërsa një skanim është aktiv (crawl-i punon në sfond).
  const scanning = (sources ?? []).some((s) => ACTIVE.includes(s.status));
  useEffect(() => {
    if (!scanning) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [scanning, load]);

  async function addSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setSiteError('');
    try {
      await apiPost('/api/kb/sources', { url: siteUrl.trim() });
      setSiteUrl('');
      await load();
    } catch (e) {
      setSiteError(errorText(t, e));
    }
    setBusy(false);
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      // Ndarja në pjesë dhe embeddings bëhen në server; tenant-i merret nga sesioni.
      await apiPost('/api/kb/ingest', { title, content });
      setTitle('');
      setContent('');
      await load();
    } catch (e) {
      setError(errorText(t, e));
    }
    setBusy(false);
  }

  async function remove(doc: DocumentRow) {
    if (!window.confirm(`${t('confirmDelete')}\n\n${doc.title}`)) return;
    // RLS lejon fshirjen vetëm të dokumenteve të tenant-it tim; pjesët fshihen me cascade.
    const { error: deleteError } = await supabase().from('documents').delete().eq('id', doc.id);
    if (deleteError) setError(t('genericError'));
    await load();
  }

  return (
    <main className="page">
      <h1>{t('navKnowledge')}</h1>
      <p className="muted">{t('knowledgeLead')}</p>

      <section className="section">
        <h2>{t('websiteTitle')}</h2>
        {sources === null ? <p className="muted" role="status">{t('loading')}</p> : null}
        {(sources ?? []).map((s) => (
          <WebsiteSource key={`${s.id}:${s.last_job_id}:${s.status}`} source={s} t={t} locale={locale} reload={load} />
        ))}
        {sources && sources.length === 0 ? <p className="muted">{t('websiteLead')}</p> : null}
        <form onSubmit={addSite}>
          <label htmlFor="site-url">{t('websiteUrl')}</label>
          <input id="site-url" type="text" inputMode="url" required maxLength={2000} placeholder="https://myshop.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
          {siteError ? <p className="notice error" role="alert">{siteError}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{t('websiteAdd')}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t('manualTitle')}</h2>
        <p className="muted">{t('manualLead')}</p>
        <form onSubmit={add}>
          <label htmlFor="doc-title">{t('docTitle')}</label>
          <input id="doc-title" type="text" required maxLength={200} placeholder={t('docTitlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="doc-content">{t('docContent')}</label>
          <textarea id="doc-content" required rows={8} maxLength={200000} placeholder={t('docContentPlaceholder')} value={content} onChange={(e) => setContent(e.target.value)} />
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? t('adding') : t('addToKnowledge')}</button>
          </div>
        </form>

        <h3>{t('documents')}</h3>
        {documents === null ? <p className="muted" role="status">{t('loading')}</p> : null}
        {documents && documents.length === 0 ? <p className="muted">{t('noDocuments')}</p> : null}
        {(documents ?? []).map((doc) => (
          <div key={doc.id} className="doc">
            <div>
              <div className="name">{doc.title}</div>
              <div className="muted small">
                {doc.chunk_count} {t('parts')}, {new Date(doc.created_at).toLocaleDateString(locale)}
              </div>
            </div>
            <button type="button" className="btn danger" onClick={() => void remove(doc)}>{t('deleteDoc')}</button>
          </div>
        ))}
      </section>
    </main>
  );
}
