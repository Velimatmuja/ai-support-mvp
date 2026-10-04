'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../lib/supabase/browser.ts';
import { useStrings } from '../../lib/ui/strings.ts';

export default function SignupPage() {
  const { t } = useStrings();
  const router = useRouter();
  const [business, setBusiness] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    // business_name shkon te user_metadata: përdoret vetëm si emër fillestar i tenant-it
    // (trigger-i në DB), kurrë për autorizim.
    const { data, error: signUpError } = await supabase().auth.signUp({
      email: email.trim(),
      password,
      options: { data: { business_name: business.trim() }, emailRedirectTo: `${window.location.origin}/login` },
    });
    setBusy(false);
    if (signUpError) {
      setError(`${t('signupFailed')} ${signUpError.message}`);
      return;
    }
    if (data.session) router.replace('/app/knowledge');
    else setSentTo(email.trim());
  }

  if (sentTo) {
    return (
      <main className="auth">
        <div className="brandmark">{t('appName')}</div>
        <h1>{t('signupTitle')}</h1>
        <p className="notice ok" role="status">
          {t('confirmEmail')} <strong>{sentTo}</strong>.
        </p>
        <p className="links">
          <Link href="/login">{t('backToLogin')}</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth">
      <div className="brandmark">{t('appName')}</div>
      <h1>{t('signupTitle')}</h1>
      <p className="muted">{t('signupLead')}</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="business">{t('businessName')}</label>
        <input id="business" type="text" autoComplete="organization" required maxLength={120} value={business} onChange={(e) => setBusiness(e.target.value)} />
        <label htmlFor="email">{t('email')}</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">{t('password')}</label>
        <input id="password" type="password" autoComplete="new-password" required minLength={10} aria-describedby="password-hint" value={password} onChange={(e) => setPassword(e.target.value)} />
        <p id="password-hint" className="muted small">{t('passwordHint')}</p>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button className="btn" type="submit" disabled={busy}>{t('createAccount')}</button>
      </form>
      <p className="links">
        {t('haveAccount')} <Link href="/login">{t('signIn')}</Link>
        <br />
        <Link href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}
