'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../lib/supabase/browser.ts';
import { useStrings } from '../../lib/ui/strings.ts';

// Dy gjendje: pa sesion -> kërko linkun me email; me sesion (ardhur nga linku i
// rivendosjes ose i loguar) -> vendos fjalëkalimin e ri.
export default function ResetPage() {
  const { t } = useStrings();
  const [hasSession, setHasSession] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const client = supabase();
    client.auth.getSession().then(({ data }) => setHasSession(Boolean(data.session)));
    const { data } = client.auth.onAuthStateChange((_event, session) => setHasSession(Boolean(session)));
    return () => data.subscription.unsubscribe();
  }, []);

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: resetError } = await supabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset`,
    });
    setBusy(false);
    if (resetError) setError(t('genericError'));
    else setMessage(t('resetSent'));
  }

  async function setNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: updateError } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (updateError) setError(updateError.message);
    else setMessage(t('passwordUpdated'));
  }

  return (
    <main className="auth">
      <div className="brandmark">{t('appName')}</div>
      <h1>{t('resetTitle')}</h1>
      {hasSession ? (
        <form onSubmit={setNewPassword}>
          <label htmlFor="password">{t('newPassword')}</label>
          <input id="password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="muted small">{t('passwordHint')}</p>
          <button className="btn" type="submit" disabled={busy}>{t('setPassword')}</button>
        </form>
      ) : (
        <form onSubmit={sendLink}>
          <label htmlFor="email">{t('email')}</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" type="submit" disabled={busy}>{t('resetSend')}</button>
        </form>
      )}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {message ? <p className="notice ok" role="status">{message}</p> : null}
      <p className="links">
        <Link href={hasSession ? '/app/inbox' : '/login'}>{hasSession ? t('navInbox') : t('backToLogin')}</Link>
      </p>
    </main>
  );
}
