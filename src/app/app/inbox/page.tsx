'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../../../lib/supabase/browser.ts';
import { apiPost } from '../../../lib/ui/api.ts';
import { useApp } from '../../../lib/ui/app-context.ts';
import { useStrings } from '../../../lib/ui/strings.ts';
import type { StringKey, Translate } from '../../../lib/ui/strings.ts';

type ConversationRow = {
  id: string;
  channel_type: 'widget' | 'telegram';
  status: 'open' | 'handoff' | 'closed';
  ai_enabled: boolean;
  contact_name: string | null;
  external_user_id: string;
  handoff_reason: string | null;
  last_message_at: string;
  messages: { content: string; role: string }[];
};

type MessageRow = { id: number; role: 'user' | 'assistant' | 'agent' | 'system'; content: string; created_at: string };

const REASONS: Record<string, StringKey> = {
  ai_requested: 'reasonAi',
  quota: 'reasonQuota',
  trial_ended: 'reasonTrial',
  agent_took_over: 'reasonAgent',
};

function customerName(c: ConversationRow, t: Translate): string {
  if (c.contact_name) return c.contact_name;
  if (c.channel_type === 'telegram') return t('telegramUser');
  return `${t('visitor')} ${c.external_user_id.slice(0, 4)}`;
}

function when(iso: string, locale: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

export default function InboxPage() {
  const { t, locale } = useStrings();
  const { setWaiting } = useApp();
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const selectedRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    const { data, error } = await supabase()
      .from('conversations')
      .select('id, channel_type, status, ai_enabled, contact_name, external_user_id, handoff_reason, last_message_at, messages(content, role)')
      .order('last_message_at', { ascending: false })
      .order('id', { referencedTable: 'messages', ascending: false })
      .limit(1, { referencedTable: 'messages' })
      .limit(100);
    if (error) {
      setNotice(t('genericError'));
      return;
    }
    const rows = (data ?? []) as ConversationRow[];
    setConversations(rows);
    setWaiting(rows.filter((c) => c.status === 'handoff').length);
  }, [setWaiting, t]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const { data, error } = await supabase()
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('id', { ascending: false })
      .limit(200);
    if (error || selectedRef.current !== conversationId) return;
    setMessages(((data ?? []) as MessageRow[]).reverse());
  }, []);

  const refresh = useCallback(async () => {
    await loadConversations();
    if (selectedRef.current) await loadMessages(selectedRef.current);
  }, [loadConversations, loadMessages]);

  useEffect(() => {
    void refresh();
    // Realtime për përditësim të menjëhershëm (RLS zbatohet mbi ngjarjet) + një rifreskim
    // çdo 15 s si rrjetë sigurie kur lidhja websocket bie, gjë e zakonshme në celular.
    const client = supabase();
    const channel = client
      .channel('inbox')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => void refresh())
      .subscribe();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, selectedId]);

  function open(conversationId: string | null) {
    selectedRef.current = conversationId;
    setSelectedId(conversationId);
    setMessages([]);
    setDraft('');
    setNotice('');
    if (conversationId) void loadMessages(conversationId);
  }

  async function setState(patch: { status: ConversationRow['status']; ai_enabled: boolean }) {
    if (!selectedId) return;
    setBusy(true);
    // Lejohet nga RLS vetëm për bisedat e tenant-it tim dhe vetëm këto dy kolona.
    const { error } = await supabase().from('conversations').update(patch).eq('id', selectedId);
    setBusy(false);
    setNotice(error ? t('genericError') : '');
    await refresh();
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedId) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await apiPost<{ delivered: boolean }>(`/api/conversations/${selectedId}/reply`, { text });
      setDraft('');
      if (!result.delivered) setNotice(t('notDelivered'));
    } catch {
      setNotice(t('genericError'));
    }
    setBusy(false);
    await refresh();
  }

  if (conversations === null) {
    return <p className="empty" role="status">{t('loading')}</p>;
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const groups: { key: ConversationRow['status']; title: string }[] = [
    { key: 'handoff', title: t('needsYou') },
    { key: 'open', title: t('withAssistant') },
    { key: 'closed', title: t('closed') },
  ];

  return (
    <div className={selected ? 'inbox has-thread' : 'inbox'}>
      <section className="list" aria-label={t('navInbox')}>
        {conversations.length === 0 ? <p className="empty">{t('inboxEmpty')}</p> : null}
        {groups.map((group) => {
          const rows = conversations.filter((c) => c.status === group.key);
          if (rows.length === 0) return null;
          return (
            <div key={group.key}>
              <h2 className={group.key === 'handoff' ? 'group-title wait' : 'group-title'}>
                {group.title} ({rows.length})
              </h2>
              {rows.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={c.status === 'handoff' ? 'conv wait' : 'conv'}
                  aria-current={c.id === selectedId ? 'true' : undefined}
                  onClick={() => open(c.id)}
                >
                  <span className="who">
                    <span>{customerName(c, t)}</span>
                    <span className="when">{when(c.last_message_at, locale)}</span>
                  </span>
                  <span className="preview">{c.messages[0]?.content ?? ''}</span>
                </button>
              ))}
            </div>
          );
        })}
      </section>

      <section className="thread" aria-label={selected ? customerName(selected, t) : undefined}>
        {!selected ? (
          <p className="empty">{t('pickConversation')}</p>
        ) : (
          <>
            <div className="thread-head">
              <button type="button" className="btn quiet back" onClick={() => open(null)}>{t('back')}</button>
              <div className="title">
                <div className="name">{customerName(selected, t)}</div>
                <div className="muted small">{selected.channel_type === 'telegram' ? t('channelTelegram') : t('channelWidget')}</div>
              </div>
              {selected.status === 'closed' ? (
                <button type="button" className="btn quiet" disabled={busy} onClick={() => void setState({ status: 'open', ai_enabled: true })}>{t('reopen')}</button>
              ) : (
                <button type="button" className="btn quiet" disabled={busy} onClick={() => void setState({ status: 'closed', ai_enabled: true })}>{t('closeConversation')}</button>
              )}
            </div>
            {/* Kush e ka bisedën tani — dhe butoni për t'ia kaluar tjetrit. */}
            {selected.status === 'handoff' ? (
              <div className="thread-status wait" role="status">
                <span>
                  {t('needsYou')}
                  {selected.handoff_reason && REASONS[selected.handoff_reason] ? `: ${t(REASONS[selected.handoff_reason] as StringKey)}` : ''}
                </span>
                <button type="button" className="btn quiet" disabled={busy} onClick={() => void setState({ status: 'open', ai_enabled: true })}>{t('returnToAi')}</button>
              </div>
            ) : null}
            {selected.status === 'open' ? (
              <div className="thread-status" role="status">
                <span>{t('withAssistant')}</span>
                <button type="button" className="btn quiet" disabled={busy} onClick={() => void setState({ status: 'handoff', ai_enabled: false })}>{t('takeOver')}</button>
              </div>
            ) : null}
            <div className="msgs">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === 'assistant' ? <span className="by">{t('roleAssistant')}</span> : null}
                  {m.role === 'agent' ? <span className="by">{t('roleAgent')}</span> : null}
                  {m.content}
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <form className="composer" onSubmit={sendReply}>
              {notice ? <p className="notice error" role="alert">{notice}</p> : null}
              <div className="line">
                <textarea
                  aria-label={t('replyPlaceholder')}
                  placeholder={t('replyPlaceholder')}
                  maxLength={4000}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button type="submit" className="btn" disabled={busy || !draft.trim()}>{t('sendReply')}</button>
              </div>
              {selected.status !== 'handoff' ? <p className="muted small" style={{ margin: '8px 0 0' }}>{t('replyNote')}</p> : null}
            </form>
          </>
        )}
      </section>
    </div>
  );
}
