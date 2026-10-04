// Test i widget-it në Chromium real: faqe "klienti" në një origjinë tjetër nga API.
// Aktivizohet me E2E_BROWSER=1 dhe kërkon Playwright (PLAYWRIGHT_MODULE = rruga e modulit).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

export async function browserTest(opts: { app: string; key: string; agentReply: (text: string) => Promise<void> }): Promise<void> {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

  const HOST_PORT = 54343;
  const host = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kafe Alba</title>
      <style>body{font-family:Georgia,serif;margin:40px} button{font-size:40px!important} div{border:3px solid red}</style></head>
      <body><h1>Kafe Alba</h1><p>Faqja e klientit (WordPress) — widget-i ngarkohet nga një origjinë tjetër.</p>
      <script src="${opts.app}/widget.js" data-key="${opts.key}" async></script></body></html>`);
  });
  await new Promise<void>((r) => host.listen(HOST_PORT, '127.0.0.1', () => r()));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('console', (m: any) => m.type() === 'error' && errors.push(m.text()));
    const requests: string[] = [];
    page.on('request', (r: any) => r.url().includes('/api/') && requests.push(`${r.method()} ${new URL(r.url()).pathname}`));

    await page.goto(`http://127.0.0.1:${HOST_PORT}/`);
    const launcher = page.getByRole('button', { name: 'Open chat' });
    await launcher.waitFor();
    assert.deepEqual(requests, [], 'page view pa hapur chat-in nuk duhet të bëjë asnjë thirrje API');

    await launcher.click();
    await page.getByText('Hi! How can I help you?').waitFor();
    const input = page.getByRole('textbox');
    await input.fill('What are your opening hours?');
    await input.press('Enter');
    await page.getByText(/ANSWER: Opening hours\. Kafe Alba is open Monday to Friday/).waitFor();

    // XSS: teksti i klientit shfaqet si tekst, nuk ekzekutohet.
    await input.fill('<img src=x onerror="window.__xss=1"> delivery');
    await input.press('Enter');
    await page.getByText('<img src=x onerror="window.__xss=1"> delivery').waitFor();
    await page.getByText(/ANSWER: Delivery\./).waitFor();
    assert.equal(await page.evaluate('window.__xss'), undefined);
    assert.equal(await page.locator('#supportbot-widget img').count(), 0);

    // CSS e faqes nuk depërton në Shadow DOM.
    const fontSize = await page.getByRole('button', { name: 'Send' }).evaluate((el: Element) => getComputedStyle(el).fontSize);
    assert.equal(fontSize, '15px');

    // ...dhe kontejneri i widget-it nuk zë vend e nuk merr stile nga faqja (`div{border}`).
    const hostBox = await page.locator('#supportbot-widget').evaluate((el: Element) => {
      const r = el.getBoundingClientRect();
      return [r.width, r.height, getComputedStyle(el).borderTopWidth];
    });
    assert.deepEqual(hostBox, [0, 0, '0px']);

    if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT}/widget-desktop.png` });

    // Rifreskim: biseda rikthehet nga tokeni në localStorage.
    await page.reload();
    await page.getByRole('button', { name: 'Open chat' }).click();
    await page.getByText(/ANSWER: Delivery\./).waitFor();
    assert.equal(await page.getByText('Hi! How can I help you?').count(), 0);

    // Handoff -> përgjigjja e agjentit mbërrin me polling (çdo 5 s).
    await page.getByRole('textbox').fill('I need a human');
    await page.getByRole('textbox').press('Enter');
    await page.getByText('A team member will reply here shortly.').waitFor();
    await opts.agentReply('Hello, Ana from Kafe Alba here.');
    await page.getByText('Hello, Ana from Kafe Alba here.').waitFor({ timeout: 12_000 });

    // Celular: paneli zë gjithë ekranin.
    await page.setViewportSize({ width: 390, height: 780 });
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box && box.width === 390 && box.x === 0, `paneli në celular: ${JSON.stringify(box)}`);
    if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT}/widget-mobile.png` });

    assert.deepEqual(errors, [], `gabime në console: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    host.close();
  }
}
