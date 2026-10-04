import { randomBytes } from 'node:crypto';

// Langfuse = vëzhgim (traces, prompts, latency, kosto orientuese). JO faturim:
// kuotat lexohen vetëm nga usage_events në Supabase. Nëse Langfuse bie ose humb
// një trace, asnjë tenant nuk faturohet gabim dhe asnjë mesazh nuk bllokohet.
//
// Dërgohet me OTLP/HTTP JSON direkt me fetch (pa SDK). API e vjetër
// /api/public/ingestion mbyllet në Langfuse Cloud më 2026-11-16, prandaj nuk përdoret.
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

type Attr = { key: string; value: { stringValue: string } | { arrayValue: { values: { stringValue: string }[] } } };

const str = (key: string, value: unknown): Attr => ({
  key,
  value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) },
});

const nanos = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;

export type ReplyTrace = {
  traceId: string;
  tenantId: string;
  conversationId: string;
  channel: string;
  model: string;
  system: string;
  messages: unknown;
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: Date;
  endedAt: Date;
  metadata: Record<string, string | number | boolean>;
  error?: string;
};

export async function traceReply(trace: ReplyTrace): Promise<void> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return; // Langfuse është opsional: pa çelësa, pa trace.

  const base = process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com';
  const rootSpanId = randomBytes(8).toString('hex');
  const common = {
    traceId: trace.traceId,
    kind: 1,
    startTimeUnixNano: nanos(trace.startedAt),
    endTimeUnixNano: nanos(trace.endedAt),
    status: trace.error ? { code: 2, message: trace.error } : {},
  };

  const body = {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'supportbot')] },
        scopeSpans: [
          {
            scope: { name: 'supportbot' },
            spans: [
              {
                ...common,
                spanId: rootSpanId,
                name: 'support-reply',
                attributes: [
                  str('langfuse.trace.name', 'support-reply'),
                  // userId = tenant: Langfuse i grupon koston dhe gabimet për tenant.
                  str('langfuse.user.id', trace.tenantId),
                  str('langfuse.session.id', trace.conversationId),
                  {
                    key: 'langfuse.trace.tags',
                    value: { arrayValue: { values: [{ stringValue: `channel:${trace.channel}` }] } },
                  } satisfies Attr,
                  ...Object.entries(trace.metadata).map(([k, v]) => str(`langfuse.trace.metadata.${k}`, String(v))),
                ],
              },
              {
                ...common,
                spanId: randomBytes(8).toString('hex'),
                parentSpanId: rootSpanId,
                name: 'claude-reply',
                attributes: [
                  str('langfuse.observation.type', 'generation'),
                  str('langfuse.observation.model.name', trace.model),
                  str('langfuse.observation.input', { system: trace.system, messages: trace.messages }),
                  str('langfuse.observation.output', trace.output),
                  str('langfuse.observation.usage_details', { input: trace.inputTokens, output: trace.outputTokens }),
                  str('langfuse.observation.cost_details', { total: trace.costUsd }),
                  ...(trace.error ? [str('langfuse.observation.level', 'ERROR')] : []),
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const res = await fetch(`${base}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) throw new Error(`langfuse ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
