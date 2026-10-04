import { envOr } from './env.ts';
import { postJson } from './http.ts';

type TgResponse<T> = { ok: boolean; result: T; description?: string };

export async function tg<T = unknown>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const base = envOr('TELEGRAM_API_BASE', 'https://api.telegram.org');
  const res = await postJson<TgResponse<T>>(`${base}/bot${token}/${method}`, body, {
    service: 'telegram',
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`telegram ${method}: ${res.description ?? 'gabim'}`);
  return res.result;
}

// Telegram pranon deri në 4096 karaktere për mesazh. Tekst i thjeshtë (pa parse_mode)
// që përgjigjja e AI të mos prishet nga karaktere si _ * [ .
export async function sendText(token: string, chatId: string, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 4000) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) });
  }
}
