/*!
 * SupportBot widget — vanilla JS, pa varësi, pa sekrete.
 *
 *   <script src="https://APP/widget.js" data-key="wk_..." async></script>
 *
 * Opsionale: data-color="#2563eb"  data-position="left"
 *
 * Siguria: i vetmi identifikues në faqe është widget_key PUBLIK. Biseda mbrohet nga
 * një token i nënshkruar nga serveri (ruhet në localStorage). Çdo tekst vendoset me
 * textContent, kurrë me innerHTML.
 */
(function () {
  'use strict';
  if (window.__supportbotLoaded) return;
  window.__supportbotLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  if (!script) return;
  var KEY = script.getAttribute('data-key') || script.getAttribute('data-tenant');
  if (!KEY) return console.warn('[supportbot] mungon data-key');
  var API = new URL(script.src, location.href).origin + '/api/widget';
  var STORE = 'supportbot:' + KEY;

  var state = {
    token: null, open: false, loaded: false, sending: false, status: null, lastId: 0, timer: null,
    seen: {},
    config: {
      botName: 'Support', welcome: 'Hi! How can I help you?', placeholder: 'Type your message…', send: 'Send',
      errorText: 'Something went wrong. Please try again.', color: script.getAttribute('data-color') || '#2563eb'
    }
  };
  try { state.token = localStorage.getItem(STORE); } catch (e) { /* localStorage i bllokuar: biseda vetëm për këtë faqe */ }

  // ---------- DOM (Shadow DOM: CSS e faqes nuk e prek widget-in dhe anasjelltas) ----------
  // Element me emër të vetin + stile inline !important: rregullat e faqes (p.sh. `div{...}`)
  // nuk e prekin dot kontejnerin, dhe ai nuk zë vend në faqosjen e faqes.
  var host = document.createElement('supportbot-widget');
  host.id = 'supportbot-widget';
  host.style.cssText = 'all:initial!important;position:fixed!important;width:0!important;height:0!important;bottom:0!important;right:0!important;z-index:2147483000!important';
  var root = host.attachShadow({ mode: 'open' });
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right';

  var style = document.createElement('style');
  style.textContent = [
    ':host{--c:#2563eb}',
    '.btn,.panel{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45;color:#111827;text-align:left}',
    '*{box-sizing:border-box}',
    '.btn{position:fixed;bottom:20px;' + side + ':20px;width:56px;height:56px;padding:0;border-radius:50%;border:0;background:var(--c);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:2147483000}',
    '.btn:focus-visible,.send:focus-visible,.x:focus-visible{outline:3px solid #111827;outline-offset:2px}',
    '.panel{position:fixed;bottom:88px;' + side + ':20px;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483001}',
    '.panel.open{display:flex}',
    '.head{background:var(--c);color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;font-weight:600}',
    '.x{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}',
    '.list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}',
    '.m{max-width:84%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.m.user{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}',
    '.m.bot{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}',
    '.m.err{align-self:center;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;font-size:13px}',
    '.typing{align-self:flex-start;color:#6b7280;font-size:13px;padding:2px 6px}',
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}',
    '.in{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font:inherit;resize:none;height:42px;max-height:110px;outline:none;color:#111827;background:#fff}',
    '.in:focus{border-color:var(--c)}',
    '.send{border:0;background:var(--c);color:#fff;border-radius:10px;padding:0 14px;font:inherit;font-weight:600;cursor:pointer}',
    '.send[disabled]{opacity:.55;cursor:default}',
    '@media (max-width:480px){.panel{bottom:0;left:0;right:0;width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0}}'
  ].join('');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var btn = el('button', 'btn');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open chat');
  // SVG konstante (jo të dhëna të përdoruesit).
  btn.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-5.6A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>';

  var panel = el('div', 'panel');
  panel.setAttribute('role', 'dialog');
  var head = el('div', 'head');
  var title = el('span', null, state.config.botName);
  var x = el('button', 'x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close chat');
  head.appendChild(title);
  head.appendChild(x);
  var list = el('div', 'list');
  list.setAttribute('aria-live', 'polite');
  var form = el('form', 'form');
  var input = el('textarea', 'in');
  input.rows = 1;
  input.maxLength = 2000;
  var send = el('button', 'send', state.config.send);
  send.type = 'submit';
  form.appendChild(input);
  form.appendChild(send);
  panel.appendChild(head);
  panel.appendChild(list);
  panel.appendChild(form);
  root.appendChild(style);
  root.appendChild(btn);
  root.appendChild(panel);

  function applyConfig() {
    host.style.setProperty('--c', /^#[0-9a-fA-F]{6}$/.test(state.config.color) ? state.config.color : '#2563eb');
    title.textContent = state.config.botName;
    panel.setAttribute('aria-label', state.config.botName);
    input.placeholder = state.config.placeholder;
    input.setAttribute('aria-label', state.config.placeholder);
    send.textContent = state.config.send;
  }

  function addMessage(role, text, id) {
    if (id) {
      if (state.seen[id]) return;
      state.seen[id] = true;
      if (id > state.lastId) state.lastId = id;
    }
    var cls = role === 'user' ? 'm user' : role === 'err' ? 'm err' : 'm bot';
    var node = el('div', cls, text);
    list.appendChild(node);
    list.scrollTop = list.scrollHeight;
    return node;
  }

  // ---------- Rrjeti ----------
  function api(method, path, body) {
    var headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) { var err = new Error(data.error || 'http_' + res.status); err.status = res.status; err.data = data; throw err; }
          return data;
        });
      });
  }

  function saveToken(token) {
    state.token = token;
    try { localStorage.setItem(STORE, token); } catch (e) { /* injoro */ }
  }

  function load() {
    if (state.loaded) return;
    state.loaded = true;
    api('GET', '/session?key=' + encodeURIComponent(KEY)).then(function (data) {
      for (var k in data.config) if (data.config[k]) state.config[k] = data.config[k];
      if (script.getAttribute('data-color')) state.config.color = script.getAttribute('data-color');
      applyConfig();
      state.status = data.status;
      if (data.messages && data.messages.length) {
        data.messages.forEach(function (m) { addMessage(m.role === 'user' ? 'user' : 'bot', m.content, m.id); });
      } else {
        addMessage('bot', state.config.welcome);
      }
      schedule();
    }).catch(function () {
      state.loaded = false;
      addMessage('err', state.config.errorText);
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return ((Math.random() * 16) | 0).toString(16); });
  }

  function submit() {
    var text = input.value.trim();
    if (!text || state.sending) return;
    state.sending = true;
    send.disabled = true;
    input.value = '';
    addMessage('user', text);
    var typing = el('div', 'typing', '…');
    list.appendChild(typing);
    list.scrollTop = list.scrollHeight;

    api('POST', '/message', { key: KEY, text: text, clientId: uuid() }).then(function (data) {
      if (data.token) saveToken(data.token);
      state.status = data.status;
      if (data.reply) addMessage('bot', data.reply.content, data.reply.id);
    }).catch(function (err) {
      addMessage('err', (err.data && err.data.message) || state.config.errorText);
    }).then(function () {
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      state.sending = false;
      send.disabled = false;
      input.focus();
      schedule();
    });
  }

  // Polling vetëm kur paneli është i hapur dhe ka bisedë: çdo 5 s kur biseda është te
  // njeriu, çdo 20 s përndryshe (që një agjent që ndërhyn vetë të shihet). Pa panel të
  // hapur = zero kërkesa, pra zero kosto për page views.
  function poll() {
    if (!state.open || !state.token || document.hidden || state.sending) return schedule();
    api('GET', '/message?key=' + encodeURIComponent(KEY) + '&after=' + state.lastId).then(function (data) {
      state.status = data.status;
      (data.messages || []).forEach(function (m) { addMessage('bot', m.content, m.id); });
    }).catch(function (err) {
      if (err.status === 401) { state.token = null; try { localStorage.removeItem(STORE); } catch (e) { /* injoro */ } }
    }).then(schedule);
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.open || !state.token) return;
    state.timer = setTimeout(poll, state.status === 'handoff' ? 5000 : 20000);
  }

  function setOpen(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) { load(); schedule(); input.focus(); } else { clearTimeout(state.timer); }
  }

  btn.addEventListener('click', function () { setOpen(!state.open); });
  x.addEventListener('click', function () { setOpen(false); btn.focus(); });
  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setOpen(false); btn.focus(); }
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(); });

  applyConfig();
  function mount() { document.body.appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  window.SupportBot = { open: function () { setOpen(true); }, close: function () { setOpen(false); } };
})();
