'use client';

import { createContext, useContext } from 'react';
import type { TenantSettings } from '../types.ts';

export type TenantRow = {
  id: string;
  name: string;
  widget_key: string;
  allowed_origins: string[];
  settings: TenantSettings;
  status: string;
  monthly_ai_reply_limit: number;
  trial_ends_at: string;
};

export type AppState = {
  tenant: TenantRow;
  email: string;
  reloadTenant: () => Promise<void>;
  // Sa biseda presin njeriun — shfaqet te navigimi.
  waiting: number;
  setWaiting: (count: number) => void;
};

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp përdoret vetëm brenda /app');
  return value;
}
