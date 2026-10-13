'use client';

import type { StringKey } from './strings.ts';

// Tipet dhe ndihmësit e seksionit "Website" të panelit. Leximet bëhen me RLS
// (vetëm kolonat e lejuara nga grant-et); shkrimet kalojnë nga /api/kb/sources.
export type SourceRow = {
  id: string;
  root_url: string;
  enabled: boolean;
  status: 'pending' | 'crawling' | 'indexing' | 'ready' | 'failed';
  verified_at: string | null;
  verification_token: string;
  max_pages: number;
  max_depth: number;
  exclude_patterns: string[];
  sync_interval_hours: number;
  last_synced_at: string | null;
  next_sync_at: string | null;
  last_job_id: string | null;
};

export type JobRow = {
  id: string;
  status: string;
  pages_discovered: number;
  pages_indexed: number;
  pages_unchanged: number;
  pages_failed: number;
  pages_skipped: number;
  truncated: boolean;
  incomplete: boolean;
  error: string | null;
  finished_at: string | null;
};

export type WebPageRow = { id: string; title: string; url: string; enabled: boolean; chunk_count: number };
export type EventRow = { id: number; level: string; code: string; message: string | null; url: string | null };

export const SOURCE_SELECT =
  'id, root_url, enabled, status, verified_at, verification_token, max_pages, max_depth, exclude_patterns, sync_interval_hours, last_synced_at, next_sync_at, last_job_id';
export const JOB_SELECT = 'id, status, pages_discovered, pages_indexed, pages_unchanged, pages_failed, pages_skipped, truncated, incomplete, error, finished_at';

export const ACTIVE = ['pending', 'crawling', 'indexing'];

export const STATUS_KEY: Record<SourceRow['status'], StringKey> = {
  pending: 'statusPending',
  crawling: 'statusCrawling',
  indexing: 'statusIndexing',
  ready: 'statusReady',
  failed: 'statusFailed',
};

export const SOURCE_ERRORS: Record<string, StringKey> = {
  invalid_url: 'errUrlNotAllowed',
  url_not_allowed: 'errUrlNotAllowed',
  url_not_resolvable: 'errUnreachable',
  site_unreachable: 'errUnreachable',
  verification_failed: 'errVerification',
  source_exists: 'errSourceExists',
  source_limit_reached: 'errSourceLimit',
  job_active: 'errJobActive',
  nothing_to_retry: 'errNothingToRetry',
  plan_inactive: 'errPlanInactive',
  rate_limited: 'errRateLimited',
};

export function verificationFor(source: SourceRow): { meta: string; fileUrl: string } {
  return {
    meta: `<meta name="anesp-site-verification" content="${source.verification_token}">`,
    fileUrl: new URL('/.well-known/anesp-verification.txt', source.root_url).toString(),
  };
}
