export type TenantSettings = {
  bot_name?: string;
  welcome_message?: string;
  color?: string;
  language?: string; // 'sq' | 'en' — gjuha e teksteve të sistemit (jo e përgjigjeve të AI)
  extra_instructions?: string;
  // 'strict' (default): vetëm nga KB. 'general': lejon përgjigje të përgjithshme të
  // shënuara qartë si të tilla, kurrë për fakte të biznesit.
  answer_policy?: 'strict' | 'general';
};

export type Tenant = {
  id: string;
  name: string;
  widget_key: string;
  allowed_origins: string[];
  settings: TenantSettings;
  status: 'active' | 'suspended';
  monthly_ai_reply_limit: number;
  trial_ends_at: string;
};

export const TENANT_COLUMNS =
  'id, name, widget_key, allowed_origins, settings, status, monthly_ai_reply_limit, trial_ends_at';

export type Conversation = {
  id: string;
  tenant_id: string;
  channel_id: string;
  channel_type: 'widget' | 'telegram';
  external_user_id: string;
  status: 'open' | 'handoff' | 'closed';
  ai_enabled: boolean;
};

export type Citation = { title: string; url: string };

export type MessageRow = {
  id: number;
  role: 'user' | 'assistant' | 'agent' | 'system';
  content: string;
  created_at: string;
  // Burimet publike (faqe të website-it) mbi të cilat u bazua përgjigjja e AI.
  sources?: Citation[];
};

// Mesazh i ruajtur -> formë për vizitorin: metadata e brendshme (model, trace) nuk del.
export function publicMessage(row: MessageRow & { metadata?: { citations?: Citation[] } | null }): MessageRow {
  const sources = row.metadata?.citations;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    ...(Array.isArray(sources) && sources.length ? { sources } : {}),
  };
}
