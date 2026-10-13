import { admin } from '../supabase/admin.ts';
import { ApiError, isUuid } from '../errors.ts';

// Dokumentet e KB për plugin-in/panelin: faqe të indeksuara dhe FAQ manuale.
const DOC_COLUMNS =
  'id, title, url, source_id, source_type, status, enabled, language, description, chunk_count, char_count, published_at, modified_at, indexed_at, created_at';

export async function listDocuments(tenantId: string, query: URLSearchParams) {
  const limit = Math.min(Math.max(Number(query.get('limit') || 50) || 50, 1), 200);
  const offset = Math.max(Number(query.get('offset') || 0) || 0, 0);
  let q = admin()
    .from('documents')
    .select(DOC_COLUMNS, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  const source = query.get('source_id');
  if (source === 'manual') q = q.is('source_id', null);
  else if (source) {
    if (!isUuid(source)) throw new ApiError(400, 'invalid_source_id');
    q = q.eq('source_id', source);
  }
  const { data, count, error } = await q;
  if (error) throw new Error(`documents: ${error.message}`);
  return { documents: data ?? [], total: count ?? 0, limit, offset };
}

export async function updateDocument(tenantId: string, id: string, body: Record<string, unknown>) {
  if (!isUuid(id)) throw new ApiError(404, 'document_not_found');
  if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'invalid_enabled');
  const { data, error } = await admin()
    .from('documents')
    .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select(DOC_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`update document: ${error.message}`);
  if (!data) throw new ApiError(404, 'document_not_found');
  return data;
}

export async function deleteDocument(tenantId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new ApiError(404, 'document_not_found');
  const { data, error } = await admin().from('documents').delete().eq('id', id).eq('tenant_id', tenantId).select('id');
  if (error) throw new Error(`delete document: ${error.message}`);
  if (!data?.length) throw new ApiError(404, 'document_not_found');
}
