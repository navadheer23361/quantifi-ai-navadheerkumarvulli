/* AI Chat Assistant - frontend (vanilla JS, no build step) */
(() => {
  const $ = (s) => document.querySelector(s);
  const els = {
    list: $('#convoList'), search: $('#search'), messages: $('#messages'), input: $('#input'),
    composer: $('#composer'), sendBtn: $('#sendBtn'), title: $('#chatTitle'), newChat: $('#newChat'),
    sidebar: $('#sidebar'), scrim: $('#scrim'), menuBtn: $('#menuBtn'), toast: $('#toast'),
  };

  const TONES = ['professional', 'casual', 'concise'];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const savedTone = store.get('tone');

  const state = {
    convos: [],
    currentId: null,
    messages: [],
    tone: TONES.includes(savedTone) ? savedTone : 'professional',
    streaming: false,
    stop: null, // function that stops the in-flight reply
    filter: '',
  };

  const SUGGESTIONS = [
    'Explain how HTTP caching works',
    'Write a Python function to merge two sorted lists',
    'Give me a 3-day workout plan',
    'Draft a polite follow-up email',
  ];

  /* ---------- helpers ---------- */
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.status === 204 ? null : res.json();
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  // navigator.clipboard only exists in secure contexts (https / localhost); fall back to execCommand.
  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function fmtTime(d) {
    return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function nearBottom() {
    const m = els.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  }
  function scrollToBottom() { els.messages.scrollTop = els.messages.scrollHeight; }

  /* ---------- Markdown + code highlighting (extra feature #1) ---------- */
  // `highlight: false` is used while streaming: re-highlighting (especially highlightAuto)
  // on every animation frame is expensive; the final render highlights once.
  function renderMarkdown(md, { highlight = true } = {}) {
    if (!window.marked || !window.DOMPurify) return `<p>${esc(md).replace(/\n/g, '<br>')}</p>`;
    const html = window.DOMPurify.sanitize(window.marked.parse(md, { gfm: true, breaks: true }));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('pre > code').forEach((code) => {
      const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '';
      if (highlight && window.hljs) {
        try {
          if (lang && window.hljs.getLanguage(lang)) code.innerHTML = window.hljs.highlight(code.textContent, { language: lang }).value;
          else code.innerHTML = window.hljs.highlightAuto(code.textContent).value;
          code.classList.add('hljs');
        } catch { /* leave unhighlighted */ }
      }
      const pre = code.parentElement;
      const wrap = document.createElement('div');
      wrap.className = 'codeblock';
      wrap.innerHTML = `<span class="lang">${esc(lang)}</span><button type="button" class="copy">Copy</button>`;
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
    });
    tpl.content.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    const div = document.createElement('div');
    div.appendChild(tpl.content);
    return div.innerHTML;
  }

  // Event delegation for the per-code-block "Copy" buttons.
  els.messages.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const code = btn.parentElement.querySelector('pre')?.innerText || '';
    btn.textContent = (await copyText(code)) ? 'Copied!' : 'Failed';
    setTimeout(() => (btn.textContent = 'Copy'), 1400);
  });

  /* ---------- Sidebar ---------- */
  async function loadList() {
    state.convos = await api('GET', '/api/conversations');
    renderList();
  }

  function renderList() {
    const q = state.filter.toLowerCase();
    const items = state.convos.filter((c) => c.title.toLowerCase().includes(q));
    els.list.innerHTML = '';
    if (!items.length) {
      els.list.innerHTML = `<li class="empty-list" style="cursor:default">${q ? 'No matches' : 'No conversations yet'}</li>`;
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.className = c._id === state.currentId ? 'active' : '';
      li.innerHTML = `<div class="c-main"><div class="c-title">${esc(c.title)}</div><div class="c-date">${fmtTime(c.updatedAt)}</div></div>
        <div class="c-actions">
          <button class="icon-btn" data-act="rename" title="Rename" aria-label="Rename">✎</button>
          <button class="icon-btn danger" data-act="delete" title="Delete" aria-label="Delete">🗑</button>
        </div>`;
      li.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'rename') return renameConvo(c);
        if (act === 'delete') return deleteConvo(c);
        openConvo(c._id);
      });
      els.list.appendChild(li);
    }
  }

  async function renameConvo(c) {
    const title = prompt('Rename conversation', c.title);
    if (!title || !title.trim()) return;
    try {
      await api('PATCH', `/api/conversations/${c._id}`, { title });
      if (c._id === state.currentId) els.title.textContent = title.trim();
      await loadList();
    } catch (e) { toast(e.message); }
  }

  async function deleteConvo(c) {
    if (state.streaming && c._id === state.currentId) return toast('Stop the reply before deleting this chat.');
    if (!confirm(`Delete "${c.title}"?`)) return;
    try {
      await api('DELETE', `/api/conversations/${c._id}`);
      if (c._id === state.currentId) newChat();
      await loadList();
    } catch (e) { toast(e.message); }
  }

  async function openConvo(id) {
    if (state.streaming) return toast('Wait for the reply to finish (or press Stop).');
    try {
      const c = await api('GET', `/api/conversations/${id}`);
      state.currentId = c._id;
      state.messages = c.messages;
      els.title.textContent = c.title;
      renderMessages();
      renderList();
      closeSidebar();
      scrollToBottom();
    } catch (e) { toast(e.message); }
  }

  function newChat() {
    if (state.streaming) return toast('Wait for the reply to finish (or press Stop).');
    state.currentId = null;
    state.messages = [];
    els.title.textContent = 'AI Chat Assistant';
    renderMessages();
    renderList();
    closeSidebar();
    els.input.focus();
  }

  const closeSidebar = () => { els.sidebar.classList.remove('open'); els.scrim.classList.remove('show'); };
  els.menuBtn.addEventListener('click', () => { els.sidebar.classList.toggle('open'); els.scrim.classList.toggle('show'); });
  els.scrim.addEventListener('click', closeSidebar);
  els.newChat.addEventListener('click', newChat);
  els.search.addEventListener('input', () => { state.filter = els.search.value; renderList(); });

  /* ---------- Message rendering ---------- */
  function messageEl(m, { isLastAssistant = false, canRetry = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role}`;
    const isUser = m.role === 'user';
    wrap.innerHTML = `<div class="avatar">${isUser ? 'You' : 'AI'}</div>
      <div class="bubble-wrap"><div class="bubble"></div><div class="meta"></div></div>`;
    const bubble = wrap.querySelector('.bubble');
    if (isUser) bubble.textContent = m.content; else bubble.innerHTML = renderMarkdown(m.content);

    const meta = wrap.querySelector('.meta');
    meta.innerHTML = `<span>${fmtTime(m.createdAt)}</span>`;
    if (!isUser && m.tone) meta.insertAdjacentHTML('beforeend', `<span class="badge">${m.tone}</span>`);
    if (m.stopped) meta.insertAdjacentHTML('beforeend', '<span>· stopped</span>');
    if (isUser && canRetry) {
      // The reply to this prompt failed or never arrived: answer it again without re-sending it.
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.onclick = regenerate;
      meta.appendChild(retry);
    }
    if (!isUser) {
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.onclick = async () => toast((await copyText(m.content)) ? 'Copied reply' : 'Copy failed');
      meta.appendChild(copy);
      if (isLastAssistant) {
        const re = document.createElement('button');
        re.textContent = 'Regenerate'; // extra feature #2 (with Stop)
        re.onclick = regenerate;
        meta.appendChild(re);
      }
    }
    return wrap;
  }

  function renderMessages() {
    els.messages.innerHTML = '';
    if (!state.messages.length) {
      els.messages.innerHTML = `<div class="empty"><h2>How can I help today?</h2><div>Pick a tone above, then ask anything.</div>
        <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('')}</div></div>`;
      els.messages.querySelectorAll('.chip').forEach((b) => (b.onclick = () => send(b.textContent)));
      return;
    }
    const lastIdx = state.messages.length - 1;
    state.messages.forEach((m, i) => {
      const last = i === lastIdx && !state.streaming;
      els.messages.appendChild(messageEl(m, {
        isLastAssistant: last && m.role === 'assistant',
        canRetry: last && m.role === 'user',
      }));
    });
  }

  /* ---------- Sending + streaming ---------- */
  function setStreaming(on) {
    state.streaming = on;
    els.sendBtn.textContent = on ? 'Stop' : 'Send';
    els.sendBtn.classList.toggle('danger', on);
    els.input.disabled = on;
    if (!on) els.input.focus();
  }

  async function send(text, { regenerate = false, replaced = null } = {}) {
    if (state.streaming) return;
    text = (text || '').trim();
    if (!regenerate && !text) return;

    // Stop must work from the very first moment (even while the conversation is being created).
    const ctrl = new AbortController();
    let stopped = false;
    state.stop = () => { stopped = true; ctrl.abort(); };
    setStreaming(true);

    let convoId = state.currentId;
    try {
      if (!convoId) {
        const c = await api('POST', '/api/conversations');
        convoId = state.currentId = c._id;
        loadList().catch(() => {}); // show the new chat in the sidebar right away
      }
    } catch (e) { state.stop = null; setStreaming(false); return toast(e.message); }
    if (stopped) {
      state.stop = null;
      setStreaming(false);
      if (replaced) { state.messages.push(replaced); renderMessages(); }
      return;
    }

    if (!regenerate) state.messages.push({ role: 'user', content: text, tone: state.tone, createdAt: new Date().toISOString() });
    renderMessages();

    // Live assistant bubble
    const live = messageEl({ role: 'assistant', content: '', tone: state.tone, createdAt: new Date().toISOString() });
    live.querySelector('.meta').innerHTML = '<span>Thinking…</span>';
    const bubble = live.querySelector('.bubble');
    bubble.innerHTML = '<span class="cursor"></span>';
    els.messages.appendChild(live);
    scrollToBottom();

    // Typewriter: network chunks go into `pending`; each animation frame moves a few
    // characters to `shown`, speeding up automatically if we fall behind.
    let shown = '', pending = '', netDone = false, errorText = null, serverMsg = null, serverTitle = null;
    let finished = false, resolveDrain;
    const drained = new Promise((r) => (resolveDrain = r));

    // requestAnimationFrame is paused in background tabs, so fall back to a timer there
    // (and flush everything at once - nobody is watching the animation).
    const schedule = () => (document.hidden ? setTimeout(tick, 100) : requestAnimationFrame(tick));
    const tick = () => {
      if (finished) return;
      if (stopped) return resolveDrain();
      if (pending.length) {
        const n = document.hidden ? pending.length : Math.max(1, Math.ceil(pending.length / 25));
        shown += pending.slice(0, n);
        pending = pending.slice(n);
        const stick = nearBottom();
        bubble.innerHTML = renderMarkdown(shown, { highlight: false }) + '<span class="cursor"></span>';
        if (stick) scrollToBottom();
      }
      if (netDone && !pending.length) return resolveDrain();
      schedule();
    };
    schedule();

    const handle = (block) => {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'delta') pending += ev.text;
        else if (ev.type === 'error') errorText = ev.error;
        else if (ev.type === 'done') { serverMsg = ev.message; serverTitle = ev.title; }
      }
    };

    try {
      const res = await fetch(`/api/conversations/${convoId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, tone: state.tone, regenerate }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
      netDone = true;
      await drained;
    } catch (e) {
      if (e.name !== 'AbortError') errorText = errorText || e.message;
      netDone = true;
      if (!stopped) { shown += pending; pending = ''; }
    }

    finished = true;
    const content = shown + (stopped ? pending : '');
    if (content) {
      state.messages.push(serverMsg && !stopped
        ? serverMsg
        : { role: 'assistant', content, tone: state.tone, stopped, createdAt: new Date().toISOString() });
    } else if (replaced) {
      // Regenerate produced nothing: the server kept the old reply, so show it again.
      state.messages.push(replaced);
    }
    if (serverTitle) els.title.textContent = serverTitle;
    state.stop = null;
    setStreaming(false);
    renderMessages();
    if (errorText) toast(`Error: ${errorText}`);
    scrollToBottom();
    loadList().catch(() => {});
  }

  async function regenerate() {
    if (state.streaming) return;
    const replaced = state.messages.at(-1)?.role === 'assistant' ? state.messages.pop() : null;
    send('', { regenerate: true, replaced });
  }

  /* ---------- Wiring ---------- */
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) return state.stop?.();
    const text = els.input.value;
    if (!text.trim()) return;
    els.input.value = '';
    autosize();
    send(text);
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.composer.requestSubmit(); }
  });
  function autosize() { els.input.style.height = 'auto'; els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px'; }
  els.input.addEventListener('input', autosize);

  // Tone toggle
  const toneBtns = document.querySelectorAll('.tone button');
  function paintTone() { toneBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tone === state.tone))); }
  toneBtns.forEach((b) => b.addEventListener('click', () => {
    state.tone = b.dataset.tone;
    store.set('tone', state.tone);
    paintTone();
    toast(`Tone: ${state.tone}. Applies to your next message.`);
  }));

  paintTone();
  renderMessages();
  loadList().catch((e) => toast(e.message));
})();
