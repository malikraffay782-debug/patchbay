(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const KEY = 'patchbay.v1';
  const PW_KEY = 'patchbay.pw';
  const MAX_STORED_RESULT = 24000;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const trunc = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return u; } };

  // ---------- state ----------
  const DEFAULTS = () => ({
    servers: [], chats: [], activeId: null,
    settings: { model: '', maxTokens: 4096, temperature: '', system: '', theme: 'auto' },
  });

  function loadState() {
    const s = DEFAULTS();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.servers)) {
          s.servers = raw.servers
            .filter((x) => x && x.name && x.url)
            .map((x) => ({ id: x.id || uid(), name: x.name, url: x.url, token: x.token || '', enabled: x.enabled !== false }));
        }
        if (Array.isArray(raw.chats)) s.chats = raw.chats.filter((c) => c && c.id && Array.isArray(c.messages));
        s.activeId = raw.activeId || null;
        Object.assign(s.settings, raw.settings || {});
      }
    } catch (_) { /* corrupt storage: start fresh */ }
    return s;
  }

  let state = loadState();
  let cfg = { models: [], defaultModel: '', authRequired: false, hasKey: true };
  let busy = false;
  let busyChatId = null;
  let ctrl = null;
  let password = sessionStorage.getItem(PW_KEY) || '';
  let authResolve = null;
  let toastTimer = null;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (_) { toast('Browser storage is full. Export or delete old chats.'); }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (__) { toast('Copy failed'); }
      ta.remove();
    }
  }

  // ---------- markdown (escape first, then add a small safe subset) ----------
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001'; });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
  }

  function md(src) {
    src = String(src).replace(/[\u0000\u0001]/g, '').replace(/\r\n?/g, '\n');
    const blocks = [];
    src = src.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang, code: code.replace(/\n$/, '') });
      return '\n\u0000' + (blocks.length - 1) + '\u0000\n';
    });

    const lines = src.split('\n');
    const reUl = /^\s*[-*+]\s+/;
    const reOl = /^\s*\d+[.)]\s+/;
    const reHr = /^\s*(-{3,}|\*{3,})\s*$/;
    const reSep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    const special = (l) => /^\s*(#{1,4}\s|>|\u0000\d+\u0000$)/.test(l) || reUl.test(l) || reOl.test(l) || reHr.test(l);
    const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    let out = '';
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (!l.trim()) { i += 1; continue; }

      if ((m = l.match(/^\u0000(\d+)\u0000$/))) {
        const b = blocks[Number(m[1])];
        out += `<div class="code"><div class="ch"><span>${esc(b.lang || 'text')}</span><button type="button" class="mini" data-act="copycode">Copy</button></div><pre><code>${esc(b.code)}</code></pre></div>`;
        i += 1; continue;
      }
      if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
        const n = m[1].length + 1;
        out += `<h${n}>${inline(esc(m[2]))}</h${n}>`;
        i += 1; continue;
      }
      if (reHr.test(l)) { out += '<hr>'; i += 1; continue; }
      if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        out += `<blockquote>${q.map((x) => inline(esc(x))).join('<br>')}</blockquote>`;
        continue;
      }
      if (reUl.test(l)) {
        const it = [];
        while (i < lines.length && reUl.test(lines[i])) { it.push(lines[i].replace(reUl, '')); i += 1; }
        out += '<ul>' + it.map((x) => `<li>${inline(esc(x))}</li>`).join('') + '</ul>';
        continue;
      }
      if (reOl.test(l)) {
        const it = [];
        while (i < lines.length && reOl.test(lines[i])) { it.push(lines[i].replace(reOl, '')); i += 1; }
        out += '<ol>' + it.map((x) => `<li>${inline(esc(x))}</li>`).join('') + '</ol>';
        continue;
      }
      if (l.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && reSep.test(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i += 1; }
        out += '<table><thead><tr>' + head.map((c) => `<th>${inline(esc(c))}</th>`).join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(esc(c))}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>';
        continue;
      }
      const p = [l];
      i += 1;
      while (i < lines.length && lines[i].trim() && !special(lines[i])) { p.push(lines[i]); i += 1; }
      out += `<p>${p.map((x) => inline(esc(x))).join('<br>')}</p>`;
    }
    return out;
  }

  // ---------- chats ----------
  const activeChat = () => state.chats.find((c) => c.id === state.activeId) || null;

  function newChat() {
    const c = { id: uid(), title: 'New chat', messages: [], updated: Date.now() };
    state.chats.unshift(c);
    state.activeId = c.id;
    return c;
  }

  function ensureChat() {
    return activeChat() || state.chats[0] || newChat();
  }

  function selectChat(id) {
    state.activeId = id;
    save(); renderAll(); closeSidebar();
  }

  /**
   * Build history for the API.
   * CRITICAL FIX: preserve full content blocks (mcp_tool_use / mcp_tool_result)
   * so multi-turn tool context is not lost.
   */
  function buildHistory(chat) {
    const out = [];
    for (const m of chat.messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.text });
      } else if (m.role === 'assistant') {
        // Prefer structured blocks when available (multi-turn tool context)
        if (Array.isArray(m.blocks) && m.blocks.length) {
          const blocks = m.blocks.filter((b) =>
            b && ['text', 'mcp_tool_use', 'mcp_tool_result'].includes(b.type)
          );
          if (blocks.length) {
            out.push({ role: 'assistant', content: blocks });
            continue;
          }
        }
        // Fallback to text
        const txt = (m.text && m.text.trim()) ? m.text : '(no text: only tool calls)';
        out.push({ role: 'assistant', content: txt });
      }
    }
    // Keep recent context, always start with a user message
    const last = out.slice(-50);
    while (last.length && last[0].role !== 'user') last.shift();
    return last;
  }

  function resultText(r) {
    const c = r.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((x) => {
        if (!x) return '';
        if (x.type === 'text') return x.text || '';
        if (x.type === 'image') return '[image]';
        return `[${x.type || 'block'}]`;
      }).filter(Boolean).join('\n');
    }
    return c == null ? '' : JSON.stringify(c, null, 2);
  }

  /**
   * Prepare blocks for localStorage + UI display.
   * Never invent fake inputs. Prefer dropping oversized data over corrupting
   * the structure that will later be sent back to the API.
   */
  function slimBlocks(blocks) {
    return (blocks || []).filter((b) => b && ['text', 'mcp_tool_use', 'mcp_tool_result'].includes(b.type)).map((b) => {
      if (b.type === 'mcp_tool_result') {
        // Keep original shape when possible; only truncate long text content
        let content = b.content;
        if (typeof content === 'string' && content.length > MAX_STORED_RESULT) {
          content = content.slice(0, MAX_STORED_RESULT) + `\n… (${content.length - MAX_STORED_RESULT} more characters)`;
        } else if (Array.isArray(content)) {
          // Flatten to a single text string for storage size; API accepts string
          const joined = resultText(b);
          content = joined.length > MAX_STORED_RESULT
            ? joined.slice(0, MAX_STORED_RESULT) + `\n… (${joined.length - MAX_STORED_RESULT} more characters)`
            : joined;
        }
        return {
          type: b.type,
          tool_use_id: b.tool_use_id,
          is_error: Boolean(b.is_error),
          content,
        };
      }
      if (b.type === 'mcp_tool_use') {
        // Keep full input. If it is enormous we still keep it for correctness;
        // localStorage pressure is handled by chat count / wipe, not by lying to the model.
        return {
          type: b.type,
          id: b.id,
          name: b.name,
          server_name: b.server_name,
          input: b.input == null ? {} : b.input,
        };
      }
      // text
      return b;
    });
  }

  async function send(text) {
    if (busy) return;
    const chat = ensureChat();
    if (text != null) {
      chat.messages.push({ role: 'user', text, ts: Date.now() });
      if (!chat.title || chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').slice(0, 48);
    }
    const history = buildHistory(chat);
    if (!history.length || history[history.length - 1].role !== 'user') { renderAll(); return; }

    chat.updated = Date.now();
    busy = true; busyChatId = chat.id; ctrl = new AbortController();
    save(); renderAll(); updateSendBtn();

    const s = state.settings;
    const servers = state.servers.filter((x) => x.enabled).map((x) => ({ name: x.name, url: x.url, token: x.token || '' }));
    let needPw = false;

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': encodeURIComponent(password) },
        body: JSON.stringify({
          model: s.model || cfg.defaultModel,
          maxTokens: s.maxTokens,
          temperature: s.temperature,
          system: s.system,
          servers,
          messages: history,
        }),
        signal: ctrl.signal,
      });
      let data = {};
      try { data = await r.json(); } catch (_) { /* non-JSON body */ }

      if (r.status === 401) {
        chat.messages.push({ role: 'error', text: 'The app password is missing or wrong.' });
        needPw = true;
      } else if (!r.ok || data.error) {
        chat.messages.push({ role: 'error', text: data.error || `Request failed (HTTP ${r.status}).` });
      } else {
        const blocks = slimBlocks(data.content);
        const text2 = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
        chat.messages.push({
          role: 'assistant',
          text: text2,
          blocks,
          model: data.model,
          stop: data.stop_reason,
          usage: data.usage || null,
          servers: servers.map((x) => x.name),
          ts: Date.now(),
        });
      }
    } catch (e) {
      chat.messages.push({ role: 'error', text: e.name === 'AbortError' ? 'Stopped.' : `Network error: ${e.message}` });
    } finally {
      busy = false; busyChatId = null; ctrl = null;
      chat.updated = Date.now();
      save(); renderAll(); updateSendBtn();
    }
    if (needPw) {
      password = ''; sessionStorage.removeItem(PW_KEY);
      askPassword('Enter the app password to continue.');
    }
  }

  // ---------- rendering ----------
  function toolHtml(b, r) {
    const bad = Boolean(r && r.is_error);
    const status = !r ? 'no result' : bad ? 'error' : 'done';
    const input = JSON.stringify(b.input == null ? {} : b.input, null, 2);
    return `<details class="tool${bad ? ' bad' : ''}" open>
      <summary>
        <span class="srv-name">${esc(b.server_name || 'mcp')}</span>
        <span class="tn">${esc(b.name || 'tool')}</span>
        <span class="st">${status}</span>
      </summary>
      <div class="tb">
        <div class="lbl">Input</div>
        <pre>${esc(trunc(input, 8000))}</pre>
        ${r ? `<div class="lbl">Result</div><pre>${esc(trunc(resultText(r), MAX_STORED_RESULT))}</pre>` : ''}
      </div>
    </details>`;
  }

  function listingHtml(b) {
    const tools = Array.isArray(b.tools) ? b.tools : [];
    const names = tools.map((t) => t.name || '?').slice(0, 30);
    return `<div class="listing">
      <div class="lbl">Tools discovered on <strong>${esc(b.mcp_server_name || 'server')}</strong></div>
      <div class="tool-names">${names.length ? names.map((n) => `<code>${esc(n)}</code>`).join(' ') : '<span class="dim">none listed</span>'}</div>
    </div>`;
  }

  function blocksHtml(m) {
    const results = {};
    for (const b of m.blocks || []) if (b.type === 'mcp_tool_result') results[b.tool_use_id] = b;
    let out = '';
    for (const b of m.blocks || []) {
      if (b.type === 'text' && b.text) out += `<div class="md">${md(b.text)}</div>`;
      else if (b.type === 'mcp_tool_use') out += toolHtml(b, results[b.id]);
      else if (b.type === 'mcp_tool_listing') out += listingHtml(b);
    }
    return out || '<div class="md dim">No text in the reply.</div>';
  }

  function msgHtml(m, i, isLast) {
    if (m.role === 'user') return `<article class="msg user"><div class="body">${esc(m.text)}</div></article>`;
    if (m.role === 'error') {
      return `<article class="msg err" role="alert"><div class="body">${esc(m.text)}</div>`
        + (isLast ? '<div class="acts"><button class="mini" data-act="retry" type="button">Try again</button></div>' : '') + '</article>';
    }
    const u = m.usage;
    const notes = [];
    if (m.model) notes.push(esc(m.model));
    if (u) notes.push(`${u.input_tokens || 0} in`, `${u.output_tokens || 0} out`);
    if (m.stop === 'max_tokens') notes.push('cut off: raise max output tokens');
    if (m.stop === 'refusal') notes.push('declined by the model');
    if (m.stop === 'pause_turn') notes.push('incomplete (max continuations reached)');
    return `<article class="msg bot"><div class="body">${blocksHtml(m)}</div><div class="meta">`
      + notes.map((n) => `<span>${n}</span>`).join('')
      + `<button class="mini" data-act="copy" data-i="${i}" type="button">Copy</button>`
      + (isLast ? '<button class="mini" data-act="regen" type="button">Regenerate</button>' : '')
      + '</div></article>';
  }

  function renderLog() {
    const log = $('#log');
    const chat = activeChat();
    let html = '';
    if (!chat || (!chat.messages.length && !(busy && busyChatId === (chat && chat.id)))) {
      const on = state.servers.filter((s) => s.enabled).length;
      html = on
        ? `<div class="empty">
            <div class="empty-icon" aria-hidden="true"></div>
            <h2>${on} server${on > 1 ? 's' : ''} patched in</h2>
            <p>Ask for something that needs their tools. Every tool call appears inline with its input and result.</p>
          </div>`
        : `<div class="empty">
            <div class="empty-icon" aria-hidden="true"></div>
            <h2>Connect a server, then ask</h2>
            <p>Patchbay lets Claude use tools from several remote MCP servers in one chat. Add a server URL to begin.</p>
            <button class="btn primary" type="button" data-act="addserver">Add MCP server</button>
          </div>`;
    } else {
      const n = chat.messages.length;
      html = chat.messages.map((m, i) => msgHtml(m, i, i === n - 1)).join('');
      if (busy && busyChatId === chat.id) {
        html += '<article class="msg bot"><div class="body dim"><span class="dots"><i></i><i></i><i></i></span>Working… tool calls can take a while</div></article>';
      }
    }
    log.innerHTML = html;
    // smooth scroll only when user is near bottom
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function renderChats() {
    const list = [...state.chats].sort((a, b) => b.updated - a.updated);
    $('#chatList').innerHTML = list.map((c) => `<li class="chat-item${c.id === state.activeId ? ' active' : ''}">`
      + `<button class="pick" type="button" data-act="pick" data-id="${c.id}" title="${esc(c.title)}">${esc(c.title)}</button>`
      + `<span class="ia"><button class="mini" type="button" data-act="rename" data-id="${c.id}">Rename</button>`
      + `<button class="mini" type="button" data-act="delchat" data-id="${c.id}">Delete</button></span></li>`).join('');
  }

  function renderServers() {
    const on = state.servers.filter((s) => s.enabled).length;
    $('#srvCount').textContent = state.servers.length ? `${on}/${state.servers.length}` : '';
    $('#serverList').innerHTML = state.servers.length ? state.servers.map((s) => `<li class="srv${s.enabled ? ' on' : ''}">`
      + `<label class="sw"><input type="checkbox" data-act="toggle" data-id="${s.id}"${s.enabled ? ' checked' : ''} aria-label="Use ${esc(s.name)} in chats"><span class="port"></span></label>`
      + `<div class="si"><strong>${esc(s.name)}</strong><span class="host">${esc(hostOf(s.url))}${s.token ? ' · token' : ''}</span></div>`
      + `<div class="ia"><button class="mini" type="button" data-act="edit" data-id="${s.id}">Edit</button>`
      + `<button class="mini" type="button" data-act="delsrv" data-id="${s.id}">Remove</button></div></li>`).join('')
      : '<li class="hint">No servers yet. Add one to get started.</li>';
  }

  function renderHeader() {
    const chat = activeChat();
    $('#title').textContent = chat ? chat.title : 'New chat';
    const on = state.servers.filter((s) => s.enabled);
    $('#chips').innerHTML = on.length
      ? on.slice(0, 3).map((s) => `<span class="chip">${esc(s.name)}</span>`).join('') + (on.length > 3 ? `<span class="chip">+${on.length - 3}</span>` : '')
      : '<button class="chip add" type="button" data-act="gotoservers">No servers on</button>';
    const banner = $('#banner');
    banner.hidden = cfg.hasKey;
    if (!cfg.hasKey) banner.textContent = 'The server has no ANTHROPIC_API_KEY. Add it to .env and restart.';
  }

  function applyTheme() { document.documentElement.dataset.theme = state.settings.theme || 'auto'; }
  function updateSendBtn() {
    const b = $('#sendBtn');
    b.textContent = busy ? 'Stop' : 'Send';
    b.classList.toggle('danger', busy);
    b.setAttribute('aria-label', busy ? 'Stop generation' : 'Send message');
  }
  function renderAll() { renderChats(); renderServers(); renderHeader(); renderLog(); applyTheme(); }

  // ---------- sidebar ----------
  function setTab(name) {
    for (const t of ['chats', 'servers']) {
      $('#tab-' + t).hidden = t !== name;
      $('#tabBtn' + t[0].toUpperCase() + t.slice(1)).setAttribute('aria-selected', String(t === name));
    }
  }
  function openSidebar() { $('#side').classList.add('open'); $('#scrim').classList.add('open'); }
  function closeSidebar() { $('#side').classList.remove('open'); $('#scrim').classList.remove('open'); }

  // ---------- servers ----------
  const cleanName = (n) => n.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

  function openServerDlg(id) {
    const s = id ? state.servers.find((x) => x.id === id) : null;
    $('#serverDlgTitle').textContent = s ? 'Edit MCP server' : 'Add MCP server';
    $('#sId').value = s ? s.id : '';
    $('#sName').value = s ? s.name : '';
    $('#sUrl').value = s ? s.url : '';
    $('#sToken').value = s ? s.token : '';
    $('#sToken').type = 'password'; $('#showTok').textContent = 'Show';
    $('#sErr').textContent = '';
    $('#serverDlg').showModal();
    $('#sName').focus();
  }

  function parseServer(name, url, token, selfId) {
    const n = cleanName(name);
    if (!n) throw new Error('Enter a name using letters, numbers, - or _.');
    if (state.servers.some((x) => x.name === n && x.id !== selfId)) throw new Error(`A server named "${n}" already exists.`);
    let u;
    try { u = new URL(url.trim()); } catch (_) { throw new Error('Enter a full URL, for example https://example.com/mcp.'); }
    if (u.protocol !== 'https:') throw new Error('The URL must start with https://. Anthropic’s API only connects over https.');
    return { name: n, url: u.toString(), token: (token || '').trim() };
  }

  function exportServers() {
    const data = { patchbay: 1, servers: state.servers.map((s) => ({ name: s.name, url: s.url, enabled: s.enabled })) };
    download('patchbay-servers.json', JSON.stringify(data, null, 2), 'application/json');
    toast('Exported without tokens');
  }

  async function importServers(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.servers;
      if (!Array.isArray(list)) throw new Error('No "servers" list in this file.');
      let added = 0;
      for (const it of list) {
        try {
          const p = parseServer(String(it.name || ''), String(it.url || ''), '', null);
          state.servers.push({ id: uid(), ...p, enabled: it.enabled !== false });
          added += 1;
        } catch (_) { /* skip invalid or duplicate entries */ }
      }
      save(); renderAll();
      toast(added ? `Imported ${added} server${added > 1 ? 's' : ''}` : 'Nothing new to import');
    } catch (e) { toast('Import failed: ' + e.message); }
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportChat() {
    const chat = activeChat();
    if (!chat || !chat.messages.length) { toast('Nothing to export yet'); return; }
    let out = `# ${chat.title}\n\n`;
    for (const m of chat.messages) {
      if (m.role === 'user') out += `**You**\n\n${m.text}\n\n`;
      else if (m.role === 'assistant') {
        out += '**Claude**\n\n';
        for (const b of m.blocks || []) {
          if (b.type === 'text') out += `${b.text}\n\n`;
          else if (b.type === 'mcp_tool_use') out += `> Tool call: ${b.server_name || 'mcp'} / ${b.name}\n\n\`\`\`json\n${JSON.stringify(b.input, null, 2)}\n\`\`\`\n\n`;
          else if (b.type === 'mcp_tool_result') out += `> Result (${b.is_error ? 'error' : 'ok'})\n\n\`\`\`\n${resultText(b)}\n\`\`\`\n\n`;
        }
      }
    }
    download(`${cleanName(chat.title) || 'chat'}.md`, out, 'text/markdown');
  }

  // ---------- password ----------
  function askPassword(msg) {
    return new Promise((resolve) => {
      authResolve = resolve;
      $('#authErr').textContent = msg || '';
      $('#pw').value = '';
      const dlg = $('#authDlg');
      if (!dlg.open) dlg.showModal();
      $('#pw').focus();
    });
  }

  async function checkPassword(pw) {
    try {
      const r = await fetch('/api/check', { method: 'POST', headers: { 'x-app-password': encodeURIComponent(pw) } });
      return r.ok;
    } catch (_) { return false; }
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) c.closest('dialog').close();
  });

  $('#menu').addEventListener('click', openSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('#newChat').addEventListener('click', () => {
    const cur = activeChat();
    if (!cur || cur.messages.length) newChat();
    save(); renderAll(); closeSidebar(); $('#input').focus();
  });
  $('#addServer').addEventListener('click', () => openServerDlg());
  $('#expServers').addEventListener('click', exportServers);
  $('#impServers').addEventListener('click', () => $('#impFile').click());
  $('#impFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importServers(f); e.target.value = ''; });
  $('#exportChat').addEventListener('click', exportChat);
  $('#chips').addEventListener('click', (e) => { if (e.target.closest('[data-act="gotoservers"]')) { setTab('servers'); openSidebar(); } });

  $('#chatList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'pick') selectChat(id);
    else if (b.dataset.act === 'rename') {
      const c = state.chats.find((x) => x.id === id);
      const t = c && prompt('Rename chat', c.title);
      if (t && t.trim()) { c.title = t.trim().slice(0, 80); save(); renderAll(); }
    } else if (b.dataset.act === 'delchat') {
      if (!confirm('Delete this chat?')) return;
      if (busy && busyChatId === id && ctrl) ctrl.abort();
      state.chats = state.chats.filter((x) => x.id !== id);
      if (state.activeId === id) state.activeId = state.chats[0] ? state.chats[0].id : null;
      ensureChat(); save(); renderAll();
    }
  });

  $('#serverList').addEventListener('change', (e) => {
    const t = e.target.closest('[data-act="toggle"]');
    if (!t) return;
    const s = state.servers.find((x) => x.id === t.dataset.id);
    if (s) { s.enabled = t.checked; save(); renderServers(); renderHeader(); }
  });
  $('#serverList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'edit') openServerDlg(b.dataset.id);
    else if (b.dataset.act === 'delsrv') {
      const s = state.servers.find((x) => x.id === b.dataset.id);
      if (s && confirm(`Remove "${s.name}"?`)) { state.servers = state.servers.filter((x) => x !== s); save(); renderAll(); }
    }
  });

  $('#serverForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#sId').value;
    try {
      const p = parseServer($('#sName').value, $('#sUrl').value, $('#sToken').value, id || null);
      if (id) Object.assign(state.servers.find((x) => x.id === id), p);
      else state.servers.push({ id: uid(), ...p, enabled: true });
      save(); renderAll();
      $('#serverDlg').close();
      toast(id ? 'Server updated' : 'Server added and turned on');
    } catch (err) { $('#sErr').textContent = err.message; }
  });
  $('#showTok').addEventListener('click', () => {
    const t = $('#sToken');
    t.type = t.type === 'password' ? 'text' : 'password';
    $('#showTok').textContent = t.type === 'password' ? 'Show' : 'Hide';
  });

  $('#log').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const chat = activeChat();
    if (b.dataset.act === 'copycode') copyText(b.closest('.code').querySelector('code').textContent);
    else if (b.dataset.act === 'copy' && chat) {
      const m = chat.messages[Number(b.dataset.i)];
      if (!m) return;
      // Copy full useful content (text + tool summary)
      let txt = m.text || '';
      if (m.blocks && m.blocks.length) {
        const tools = m.blocks.filter((x) => x.type === 'mcp_tool_use');
        if (tools.length) {
          txt += '\n\n--- Tools ---\n' + tools.map((t) => `${t.server_name}/${t.name}`).join(', ');
        }
      }
      copyText(txt.trim() || '(empty)');
    }
    else if ((b.dataset.act === 'regen' || b.dataset.act === 'retry') && chat && !busy) {
      while (chat.messages.length && chat.messages[chat.messages.length - 1].role !== 'user') chat.messages.pop();
      send(null);
    } else if (b.dataset.act === 'addserver') openServerDlg();
  });

  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { if (ctrl) ctrl.abort(); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; autosize();
    send(text);
  });

  // settings
  $('#openSettings').addEventListener('click', () => {
    const s = state.settings;
    $('#setModel').value = s.model || '';
    $('#setModel').placeholder = cfg.defaultModel ? `Server default: ${cfg.defaultModel}` : 'Server default';
    $('#setMax').value = s.maxTokens;
    $('#setTemp').value = s.temperature;
    $('#setSys').value = s.system;
    $('#setTheme').value = s.theme || 'auto';
    $('#settingsDlg').showModal();
  });
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const max = parseInt($('#setMax').value, 10);
    const temp = $('#setTemp').value.trim();
    state.settings = {
      model: $('#setModel').value.trim(),
      maxTokens: Number.isFinite(max) ? Math.min(Math.max(max, 1), 128000) : 4096,
      temperature: temp === '' ? '' : Math.min(Math.max(Number(temp) || 0, 0), 1),
      system: $('#setSys').value,
      theme: $('#setTheme').value,
    };
    save(); applyTheme(); $('#settingsDlg').close(); toast('Settings saved');
  });
  $('#wipe').addEventListener('click', () => {
    if (!confirm('Delete all chats, servers, tokens and settings stored in this browser?')) return;
    if (ctrl) ctrl.abort();
    localStorage.removeItem(KEY);
    state = loadState(); newChat(); save();
    $('#settingsDlg').close(); renderAll(); toast('Local data deleted');
  });

  // password dialog
  $('#authDlg').addEventListener('cancel', (e) => e.preventDefault());
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = $('#pw').value;
    if (await checkPassword(val)) {
      password = val; sessionStorage.setItem(PW_KEY, val);
      $('#authDlg').close();
      if (authResolve) authResolve(true);
    } else { $('#authErr').textContent = 'Wrong password.'; }
  });

  // ---------- start ----------
  async function init() {
    try {
      const r = await fetch('/api/config');
      cfg = Object.assign(cfg, await r.json());
    } catch (_) { toast('Cannot reach the server.'); }
    $('#modelList').innerHTML = (cfg.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
    ensureChat();
    save(); renderAll(); updateSendBtn();
    if (cfg.authRequired && !(password && await checkPassword(password))) await askPassword();
    // focus input on desktop
    if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => $('#input').focus(), 100);
  }
  init();
})();
