'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../../lib/supabase/browser.ts';
import { ApiCallError, apiPost } from '../../../lib/ui/api.ts';
import { useStrings } from '../../../lib/ui/strings.ts';
import type { StringKey } from '../../../lib/ui/strings.ts';

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

export default function KnowledgePage() {
  const { t, locale } = useStrings();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase()
      .from('documents')
      .select('id, title, status, chunk_count, char_count, created_at')
      .order('created_at', { ascending: false });
    if (loadError) setError(t('genericError'));
    else setDocuments((data ?? []) as DocumentRow[]);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

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
      const key = e instanceof ApiCallError ? ERRORS[e.code] : undefined;
      setError(key ? t(key) : t('genericError'));
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
        <h2>{t('addDocument')}</h2>
        <form onSubmit={add}>
          <label htmlFor="doc-title">{t('docTitle')}</label>
          <input id="doc-title" type="text" required maxLength={200} placeholder={t('docTitlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="doc-content">{t('docContent')}</label>
          <textarea id="doc-content" required rows={10} maxLength={200000} placeholder={t('docContentPlaceholder')} value={content} onChange={(e) => setContent(e.target.value)} />
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? t('adding') : t('addToKnowledge')}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t('documents')}</h2>
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
