// E2E i plugin-it WordPress me PHP të vërtetë: tests/wp/stubs.php imiton API-të e WordPress
// që përdor plugin-i; faqja publike shërbehet nga `php -S`, veprimet admin nga CLI.
// Rrjedha: lidhje me email/fjalëkalim -> regjistrim i site-it -> verifikim automatik me
// meta tag -> crawl në sfond -> statusi/faqet në admin -> FAQ manuale -> shkëputje.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Ctx = {
  APP: string;
  A: { id: string; widget_key: string };
  db: (path: string, init?: RequestInit) => Promise<any>;
  call: (method: string, path: string, opts?: { body?: unknown; token?: string; headers?: Record<string, string> }) => Promise<{ status: number; data: any }>;
  step: (name: string, fn: () => Promise<void>) => Promise<void>;
  WP_PORT: number;
};

export default async function wordpress(ctx: Ctx): Promise<void> {
  const { db, call, step } = ctx;
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
  } catch {
    await step('WordPress plugin (u anashkalua: mungon php në PATH)', async () => undefined);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'sb-wp-'));
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ options: { supportbot_app_url: ctx.APP } }));
  const env = { ...process.env, SB_WP_STATE: state, SB_WP_HOME: 'http://wp.test' };
  const server = spawn('php', ['-S', `127.0.0.1:${ctx.WP_PORT}`, 'tests/wp/site.php'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${ctx.WP_PORT}/robots.txt`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const options = () => JSON.parse(readFileSync(state, 'utf8')).options as Record<string, string>;
  // Asinkron: serveri i aplikacionit jeton në këtë proces dhe duhet t'i përgjigjet PHP-së.
  const php = async (args: string[], role?: string) =>
    (await promisify(execFile)('php', ['tests/wp/admin.php', ...args], { env: { ...env, ...(role ? { SB_WP_ROLE: role } : {}) }, encoding: 'utf8', timeout: 60_000 })).stdout;
  const post = async (action: string, body: Record<string, unknown> = {}) => JSON.parse(await php(['post', action, JSON.stringify(body)]));
  const render = (tab: string) => php(['render', tab]);
  const tick = () => call('POST', '/api/cron/crawl', { token: process.env.CRON_SECRET });

  try {
    await step('WP plugin: nonce dhe të drejtat e administratorit kërkohen për çdo veprim', async () => {
      const noNonce = JSON.parse(await php(['post', 'supportbot_connect', JSON.stringify({ _wpnonce: 'x', email: 'a@test.local', password: 'test-password' })]));
      assert.match(noNonce.error, /nonce_failed/);
      const sub = JSON.parse(await php(['post', 'supportbot_connect', JSON.stringify({ email: 'a@test.local', password: 'test-password' })], 'subscriber'));
      assert.match(sub.error, /wp_die:403/);
      assert.equal(options().supportbot_api_key, undefined);
    });

    await step('WP plugin: lidhja me llogarinë ruan çelësin (jo fjalëkalimin) dhe widget_key; çelësi s\'del në HTML', async () => {
      const bad = await post('supportbot_connect', { email: 'a@test.local', password: 'gabim' });
      assert.equal(bad.notice.type, 'error');
      assert.equal(bad.notice.message, 'Email or password is not correct.');
      const ok = await post('supportbot_connect', { email: 'a@test.local', password: 'test-password' });
      assert.equal(ok.notice.type, 'success', JSON.stringify(ok));
      const o = options();
      assert.match(o.supportbot_api_key!, /^ak_[a-f0-9]{64}$/);
      assert.equal(o.supportbot_widget_key, ctx.A.widget_key);
      assert.ok(!readFileSync(state, 'utf8').includes('test-password'), 'fjalëkalimi nuk ruhet');
      for (const tab of ['connection', 'knowledge', 'faq']) {
        assert.ok(!(await render(tab)).includes(o.supportbot_api_key!), `çelësi API u shfaq në tab-in ${tab}`);
      }
      const front = await (await fetch(`http://127.0.0.1:${ctx.WP_PORT}/`)).text();
      assert.ok(front.includes(`data-key="${ctx.A.widget_key}"`), 'widget-i futet në faqe');
      assert.ok(!front.includes('ak_'), 'asnjë sekret në faqen publike');
    });

    let sourceId = '';
    await step('WP plugin: regjistrimi i site-it -> meta tag automatik -> verifikim -> crawl në sfond -> "Ready"', async () => {
      const r = await post('supportbot_register_site', { site_url: 'http://wp.test/', max_pages: 20, max_depth: 2, exclude_patterns: '/cart/\n' });
      assert.equal(r.notice.type, 'success', JSON.stringify(r));
      sourceId = options().supportbot_source_id!;
      assert.match(options().supportbot_verification_token!, /^anesp-[a-f0-9]{32}$/);
      const front = await (await fetch(`http://127.0.0.1:${ctx.WP_PORT}/`)).text();
      assert.ok(front.includes(`<meta name="anesp-site-verification" content="${options().supportbot_verification_token}">`));
      const wellKnown = await (await fetch(`http://127.0.0.1:${ctx.WP_PORT}/.well-known/anesp-verification.txt`)).text();
      assert.equal(wellKnown, options().supportbot_verification_token);
      const [src] = await db(`/knowledge_sources?select=verified_at,tenant_id,exclude_patterns&id=eq.${sourceId}`);
      assert.ok(src.verified_at, 'verifikimi duhej të kalonte');
      assert.equal(src.tenant_id, ctx.A.id);
      assert.deepEqual(src.exclude_patterns, ['/cart/']);

      assert.match(await render('knowledge'), /Pending|Crawling|Indexing/);
      for (let i = 0; i < 20; i++) {
        await tick();
        const [s] = await db(`/knowledge_sources?select=status&id=eq.${sourceId}`);
        if (s.status === 'ready' || s.status === 'failed') break;
      }
      const page = await render('knowledge');
      assert.ok(page.includes('>Ready<'), page.slice(0, 500));
      assert.ok(page.includes('http://wp.test/shipping/'), 'faqet e indeksuara shfaqen');
      assert.ok(page.includes('Rescan now'));
      const docs = await db(`/documents?select=url&source_id=eq.${sourceId}&order=url`);
      assert.deepEqual(docs.map((d: any) => d.url), ['http://wp.test/', 'http://wp.test/shipping/']);
    });

    await step('WP plugin: chatbot-i përgjigjet nga faqet e WordPress-it me referencë', async () => {
      const r = await call('POST', '/api/widget/message', { body: { key: ctx.A.widget_key, text: 'How fast are ceramic orders shipped across Albania?' } });
      assert.match(r.data.reply.content, /shipped in recycled cardboard within three working days/);
      assert.deepEqual(r.data.reply.sources, [{ title: 'Shipping', url: 'http://wp.test/shipping/' }]);
    });

    await step('WP plugin: rescan, përjashtim, çaktivizim faqeje dhe FAQ manuale', async () => {
      assert.equal((await post('supportbot_source_action', { do: 'sync' })).notice.type, 'success');
      for (let i = 0; i < 20; i++) {
        await tick();
        const [s] = await db(`/knowledge_sources?select=status&id=eq.${sourceId}`);
        if (s.status === 'ready') break;
      }
      const saved = await post('supportbot_source_action', { do: 'settings', exclude_patterns: '/shipping/', max_pages: 20, max_depth: 2, sync_interval_hours: 48 });
      assert.match(saved.notice.message, /1 excluded pages were removed/);
      assert.deepEqual((await db(`/documents?select=url&source_id=eq.${sourceId}`)).map((d: any) => d.url), ['http://wp.test/']);
      const home = (await db(`/documents?select=id&source_id=eq.${sourceId}`))[0];
      assert.equal((await post('supportbot_document', { document_id: home.id, do: 'disable' })).notice.type, 'success');
      assert.equal((await db(`/documents?select=enabled&id=eq.${home.id}`))[0].enabled, false);

      const faq = await post('supportbot_faq_add', { title: 'Gift wrapping', content: 'Q: Do you offer gift wrapping? A: Yes, gift wrapping with a handwritten card costs 300 lek.' });
      assert.equal(faq.notice.type, 'success', JSON.stringify(faq));
      assert.ok((await render('faq')).includes('Gift wrapping'));
      const dup = await post('supportbot_faq_add', { title: 'Gift wrapping', content: 'Q: Do you offer gift wrapping? A: Yes, gift wrapping with a handwritten card costs 300 lek.' });
      assert.equal(dup.notice.message, 'This exact text is already in your knowledge.');
    });

    await step('WP plugin: fshirja e burimit dhe shkëputja revokojnë aksesin', async () => {
      assert.equal((await post('supportbot_source_action', { do: 'delete' })).notice.type, 'success');
      assert.equal((await db(`/documents?select=id&source_id=eq.${sourceId}`)).length, 0);
      const key = options().supportbot_api_key!;
      assert.equal((await post('supportbot_disconnect')).notice.type, 'success');
      assert.equal(options().supportbot_api_key, undefined);
      assert.equal((await call('GET', '/api/kb/sources', { token: key })).status, 401, 'çelësi u revokua në server');
    });
  } finally {
    server.kill();
  }
}
