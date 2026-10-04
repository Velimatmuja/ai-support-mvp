'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { supabase } from '../../lib/supabase/browser.ts';
import { AppContext } from '../../lib/ui/app-context.ts';
import type { TenantRow } from '../../lib/ui/app-context.ts';
import { useStrings } from '../../lib/ui/strings.ts';

const TENANT_COLUMNS = 'id, name, widget_key, allowed_origins, settings, status, monthly_ai_reply_limit, trial_ends_at';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { t } = useStrings();
  const router = useRouter();
  const pathname = usePathname();
  const [tenant, setTenant] = useState<TenantRow | null>(null);
  const [email, setEmail] = useState('');
  const [waiting, setWaiting] = useState(0);
  const [failed, setFailed] = useState(false);

  // RLS kthen vetëm tenant-in e përdoruesit të loguar: nuk ka nevojë (dhe as mundësi)
  // të zgjidhet tenant-i nga klienti.
  const reloadTenant = useCallback(async () => {
    const { data, error } = await supabase().from('tenants').select(TENANT_COLUMNS).maybeSingle();
    if (error || !data) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setTenant(data as TenantRow);
  }, []);

  const reloadWaiting = useCallback(async () => {
    const { count } = await supabase()
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'handoff');
    setWaiting(count ?? 0);
  }, []);

  useEffect(() => {
    const client = supabase();
    let active = true;
    client.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) {
        router.replace('/login');
        return;
      }
      setEmail(data.session.user.email ?? '');
      void reloadTenant();
      void reloadWaiting();
    });
    const { data: listener } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') router.replace('/login');
    });
    const timer = window.setInterval(() => {
      if (!document.hidden) void reloadWaiting();
    }, 30_000);
    return () => {
      active = false;
      listener.subscription.unsubscribe();
      window.clearInterval(timer);
    };
  }, [router, reloadTenant, reloadWaiting]);

  if (failed) {
    return (
      <main className="auth">
        <p className="notice error" role="alert">{t('genericError')}</p>
        <button className="btn quiet" type="button" onClick={() => void supabase().auth.signOut()}>{t('signOut')}</button>
      </main>
    );
  }
  if (!tenant) {
    return (
      <main className="auth">
        <p className="muted" role="status">{t('loading')}</p>
      </main>
    );
  }

  const links = [
    { href: '/app/inbox', label: t('navInbox'), count: waiting },
    { href: '/app/knowledge', label: t('navKnowledge'), count: 0 },
    { href: '/app/settings', label: t('navSettings'), count: 0 },
  ];

  return (
    <AppContext.Provider value={{ tenant, email, reloadTenant, waiting, setWaiting }}>
      <div className="shell">
        <header className="topbar">
          <span className="business">{tenant.name}</span>
          <span className="muted small">{t('appName')}</span>
        </header>
        <nav className="nav" aria-label={t('appName')}>
          {links.map((link) => (
            <Link key={link.href} href={link.href} aria-current={pathname.startsWith(link.href) ? 'page' : undefined}>
              {link.label}
              {link.count > 0 ? <span className="count">{link.count}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="content">{children}</div>
      </div>
    </AppContext.Provider>
  );
}
