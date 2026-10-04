export type TenantSettings = {
  bot_name?: string;
  welcome_message?: string;
  color?: string;
  language?: string; // 'sq' | 'en' — gjuha e teksteve të sistemit (jo e përgjigjeve të AI)
  extra_instructions?: string;
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

export type MessageRow = {
  id: number;
  role: 'user' | 'assistant' | 'agent' | 'system';
  content: string;
  created_at: string;
};
