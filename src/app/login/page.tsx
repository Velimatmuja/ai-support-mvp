'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../lib/supabase/browser.ts';
import { useStrings } from '../../lib/ui/strings.ts';

export default function LoginPage() {
  const { t } = useStrings();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session) router.replace('/app/inbox');
      });
  }, [router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: signInError } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (signInError) {
      setError(signInError.status === 400 ? t('badCredentials') : t('genericError'));
      return;
    }
    router.replace('/app/inbox');
  }

  return (
    <main className="auth">
      <div className="brandmark">{t('appName')}</div>
      <h1>{t('loginTitle')}</h1>
      <p className="muted">{t('loginLead')}</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">{t('email')}</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">{t('password')}</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button className="btn" type="submit" disabled={busy}>{t('signIn')}</button>
      </form>
      <p className="links">
        {t('noAccount')} <Link href="/signup">{t('createAccount')}</Link>
        <br />
        <Link href="/reset">{t('forgot')}</Link>
      </p>
    </main>
  );
}
