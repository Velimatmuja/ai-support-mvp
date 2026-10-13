'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../../lib/supabase/browser.ts';
import { ApiCallError, apiPost, apiRequest } from '../../../lib/ui/api.ts';
import { useApp } from '../../../lib/ui/app-context.ts';
import { useStrings } from '../../../lib/ui/strings.ts';

type ChannelRow = { id: string; display_name: string | null; status: string };
type KeyRow = { id: string; name: string; prefix: string; last_used_at: string | null; revoked_at: string | null };

export default function SettingsPage() {
  const { t, locale } = useStrings();
  const { tenant, email, reloadTenant } = useApp();
  const settings = tenant.settings;

  const [appUrl, setAppUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const [name, setName] = useState(tenant.name);
  const [botName, setBotName] = useState(settings.bot_name ?? '');
  const [welcome, setWelcome] = useState(settings.welcome_message ?? '');
  const [color, setColor] = useState(settings.color ?? '#2563eb');
  const [language, setLanguage] = useState(settings.language === 'sq' ? 'sq' : 'en');
  const [tone, setTone] = useState(settings.extra_instructions ?? '');
  const [answerPolicy, setAnswerPolicy] = useState(settings.answer_policy === 'general' ? 'general' : 'strict');
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [botNotice, setBotNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [origins, setOrigins] = useState(tenant.allowed_origins.join('\n'));
  const [originsNotice, setOriginsNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [bots, setBots] = useState<ChannelRow[]>([]);
  const [botToken, setBotToken] = useState('');
  const [telegramNotice, setTelegramNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [used, setUsed] = useState<number | null>(null);

  const loadSide = useCallback(async () => {
    const client = supabase();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [channels, usage, apiKeys] = await Promise.all([
      client.from('channels').select('id, display_name, status').eq('type', 'telegram').order('created_at'),
      // I njëjti numërim që përdor serveri për kuotën (usage_events, muaji kalendarik UTC).
      client.from('usage_events').select('id', { count: 'exact', head: true }).eq('event_type', 'ai_reply').gte('created_at', monthStart),
      // RLS + grant-et e kolonave: emri dhe prefiksi, kurrë hash-i i çelësit.
      client.from('api_keys').select('id, name, prefix, last_used_at, revoked_at').order('created_at', { ascending: false }),
    ]);
    setBots((channels.data ?? []) as ChannelRow[]);
    setKeys((apiKeys.data ?? []) as KeyRow[]);
    setUsed(usage.count ?? 0);
  }, []);

  useEffect(() => {
    setAppUrl(window.location.origin);
    void loadSide();
  }, [loadSide]);

  const snippet = `<script src="${appUrl}/widget.js" data-key="${tenant.widget_key}" async></script>`;

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function saveBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    // Databaza lejon përditësimin vetëm të name / settings / allowed_origins:
    // plani, kuota dhe data e provës nuk ndryshohen dot nga paneli.
    const { error } = await supabase()
      .from('tenants')
      .update({
        name: name.trim(),
        settings: {
          ...settings,
          bot_name: botName.trim(),
          welcome_message: welcome.trim(),
          color,
          language,
          extra_instructions: tone.trim(),
          answer_policy: answerPolicy,
        },
      })
      .eq('id', tenant.id);
    setBusy(false);
    setBotNotice(error ? { ok: false, text: t('genericError') } : { ok: true, text: t('saved') });
    if (!error) await reloadTenant();
  }

  async function saveOrigins(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const list: string[] = [];
    for (const line of origins.split('\n').map((l) => l.trim()).filter(Boolean)) {
      try {
        const url = new URL(line.includes('://') ? line : `https://${line}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
        if (!list.includes(url.origin)) list.push(url.origin);
      } catch {
        setOriginsNotice({ ok: false, text: `${t('originInvalid')} ${line}` });
        return;
      }
    }
    setBusy(true);
    const { error } = await supabase().from('tenants').update({ allowed_origins: list }).eq('id', tenant.id);
    setBusy(false);
    setOriginsNotice(error ? { ok: false, text: t('genericError') } : { ok: true, text: t('saved') });
    if (!error) {
      setOrigins(list.join('\n'));
      await reloadTenant();
    }
  }

  async function connectTelegram(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setTelegramNotice(null);
    try {
      await apiPost<{ bot: string }>('/api/channels/telegram', { botToken: botToken.trim() });
      setBotToken('');
      await loadSide(); // bot-i i lidhur shfaqet te lista më sipër
    } catch (e) {
      const code = e instanceof ApiCallError ? e.code : '';
      const text =
        code === 'bot_already_connected' ? t('errBotTaken')
        : code === 'invalid_bot_token' || code === 'bot_token_rejected' ? t('errBotToken')
        : code === 'rate_limited' ? t('errRateLimited')
        : t('genericError');
      setTelegramNotice({ ok: false, text });
    }
    setBusy(false);
  }

  const limit = tenant.monthly_ai_reply_limit;
  const trialEnd = new Date(tenant.trial_ends_at);
  const trialOver = trialEnd.getTime() < Date.now();
  const percent = used === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));

  return (
    <main className="page">
      <h1>{t('navSettings')}</h1>

      <section className="section">
        <h2>{t('usageTitle')}</h2>
        <p>
          <strong>{used === null ? '…' : used}</strong> {t('usageOf')} <strong>{limit}</strong>
        </p>
        <div className={percent >= 100 ? 'meter full' : 'meter'} role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used ?? 0} aria-label={t('usageTitle')}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {trialOver ? (
          <p className="notice wait">{t('trialEnded')}</p>
        ) : (
          <p className="muted small">{t('trialUntil')} {trialEnd.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
        )}
      </section>

      <section className="section">
        <h2>{t('widgetTitle')}</h2>
        <p className="muted">{t('widgetLead')}</p>
        {/* Adresa e aplikacionit njihet vetëm në browser: kodi shfaqet kur është i plotë. */}
        {appUrl ? <code className="snippet" data-testid="snippet">{snippet}</code> : null}
        <div className="row">
          <button type="button" className="btn quiet" onClick={() => void copySnippet()}>{copied ? t('copied') : t('copy')}</button>
          <a className="btn quiet" href={`/demo.html?key=${tenant.widget_key}`} target="_blank" rel="noreferrer">{t('tryDemo')}</a>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          {t('widgetKey')}: <code>{tenant.widget_key}</code>
        </p>
      </section>

      <section className="section">
        <h2>{t('originsTitle')}</h2>
        <p className="muted">{t('originsLead')}</p>
        <form onSubmit={saveOrigins}>
          <textarea aria-label={t('originsTitle')} rows={3} placeholder="https://myshop.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
          {originsNotice ? <p className={originsNotice.ok ? 'notice ok' : 'notice error'} role="status">{originsNotice.text}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{t('save')}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t('botTitle')}</h2>
        <form onSubmit={saveBot}>
          <label htmlFor="business">{t('businessName')}</label>
          <input id="business" type="text" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="bot-name">{t('botName')}</label>
          <input id="bot-name" type="text" maxLength={60} value={botName} onChange={(e) => setBotName(e.target.value)} />
          <label htmlFor="welcome">{t('welcome')}</label>
          <input id="welcome" type="text" maxLength={300} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
          <label htmlFor="color">{t('color')}</label>
          <input id="color" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          <label htmlFor="language">{t('language')}</label>
          <select id="language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="sq">Shqip</option>
          </select>
          <label htmlFor="tone">{t('tone')}</label>
          <textarea id="tone" rows={3} maxLength={1000} aria-describedby="tone-hint" value={tone} onChange={(e) => setTone(e.target.value)} />
          <p id="tone-hint" className="muted small">{t('toneHint')}</p>
          <label htmlFor="answer-policy">{t('answerPolicy')}</label>
          <select id="answer-policy" value={answerPolicy} onChange={(e) => setAnswerPolicy(e.target.value === 'general' ? 'general' : 'strict')}>
            <option value="strict">{t('answerStrict')}</option>
            <option value="general">{t('answerGeneral')}</option>
          </select>
          {botNotice ? <p className={botNotice.ok ? 'notice ok' : 'notice error'} role="status">{botNotice.text}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{t('save')}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t('telegramTitle')}</h2>
        {bots.map((bot) => (
          <p key={bot.id} className="notice ok">
            {t('connected')}: <strong>{bot.display_name}</strong>
          </p>
        ))}
        <p className="muted">{t('telegramLead')}</p>
        <form onSubmit={connectTelegram}>
          <label htmlFor="bot-token">{t('botToken')}</label>
          <input id="bot-token" type="password" autoComplete="off" required placeholder="123456789:AA…" value={botToken} onChange={(e) => setBotToken(e.target.value)} />
          {telegramNotice ? <p className={telegramNotice.ok ? 'notice ok' : 'notice error'} role="status">{telegramNotice.text}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy}>{t('connect')}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t('keysTitle')}</h2>
        <p className="muted">{t('keysLead')}</p>
        {keys.length === 0 ? <p className="muted small">{t('keysEmpty')}</p> : null}
        {keys.map((key) => (
          <div key={key.id} className="doc">
            <div>
              <div className="name">{key.name}</div>
              <div className="muted small">
                <code>{key.prefix}…</code> · {t('lastUsed')}: {key.last_used_at ? new Date(key.last_used_at).toLocaleString(locale) : t('never')}
              </div>
            </div>
            {key.revoked_at ? (
              <span className="muted small">{t('revokedOn')}</span>
            ) : (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() =>
                  void apiRequest('DELETE', `/api/keys/${key.id}`)
                    .catch(() => undefined)
                    .then(loadSide)
                }
              >
                {t('revoke')}
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="section">
        <h2>{t('account')}</h2>
        <p className="muted">{email}</p>
        <button type="button" className="btn quiet" onClick={() => void supabase().auth.signOut()}>{t('signOut')}</button>
      </section>
    </main>
  );
}
