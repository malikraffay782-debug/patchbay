'use strict';
/**
 * Patchbay: a small web client that lets Claude use tools from several
 * remote MCP servers in one chat. This file is the backend: it keeps the
 * API key private and forwards chat requests to the Anthropic Messages API
 * using the MCP connector (the API itself talks to the MCP servers).
 *
 * Fixed & hardened (2026):
 * - Proper multi-turn history with mcp_tool_use / mcp_tool_result blocks
 * - Updated real model names
 * - Stronger validation + clearer errors
 * - Supports both string and content-block array messages
 */
try { require('dotenv').config(); } catch (_) { /* optional in some envs */ }
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

const PORT = Number(env('PORT', 3000));
const HOST = env('HOST', '127.0.0.1');
const API_KEY = env('ANTHROPIC_API_KEY', '');
const API_URL = env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
const MCP_BETA = env('MCP_BETA', 'mcp-client-2025-11-20');
const APP_PASSWORD = env('APP_PASSWORD', '');
// Current model IDs (Oct 2026) — Claude 5.5 generation
const MODELS = env('MODELS', 'claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DEFAULT_MODEL = env('DEFAULT_MODEL', MODELS[0] || 'claude-sonnet-5-5');
const RATE_PER_MIN = Number(env('RATE_LIMIT_PER_MIN', 20));
const TIMEOUT_MS = Number(env('REQUEST_TIMEOUT_MS', 180000));
const MAX_CONTINUATIONS = 6; // a bit more headroom for long tool chains

const app = express();
app.disable('x-powered-by');
if (env('TRUST_PROXY', '') === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- auth (optional shared password) ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const given = safeDecode(req.get('x-app-password') || '');
  if (crypto.timingSafeEqual(sha(given), sha(APP_PASSWORD))) return next();
  return res.status(401).json({ error: 'Wrong or missing app password.' });
}

// ---------- tiny in-memory rate limiter ----------
const hits = new Map();
function rateLimit(req, res, next) {
  if (!RATE_PER_MIN) return next();
  const now = Date.now();
  const key = req.ip || 'unknown';
  let h = hits.get(key);
  if (!h || h.reset < now) h = { count: 0, reset: now + 60000 };
  h.count += 1;
  hits.set(key, h);
  if (h.count > RATE_PER_MIN) {
    res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
    return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  }
  return next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60000).unref();

// ---------- validation ----------
function isValidContentBlock(b) {
  if (!b || typeof b !== 'object') return false;
  const t = b.type;
  if (t === 'text') return typeof b.text === 'string';
  if (t === 'mcp_tool_use') {
    return typeof b.id === 'string' && typeof b.name === 'string' &&
      typeof b.server_name === 'string' && b.input != null;
  }
  if (t === 'mcp_tool_result') {
    return typeof b.tool_use_id === 'string';
  }
  // Only known MCP-related blocks. Reject everything else (document, image, etc.)
  return false;
}

function normalizeContent(c) {
  if (typeof c === 'string') {
    const t = c.trim();
    if (!t) throw new Error('Messages cannot be empty.');
    if (t.length > 200000) throw new Error('A message is too long.');
    return t;
  }
  if (Array.isArray(c)) {
    if (c.length === 0) throw new Error('Messages cannot be empty.');
    if (c.length > 200) throw new Error('Too many content blocks in one message.');
    const out = [];
    for (const b of c) {
      if (!isValidContentBlock(b)) throw new Error('Invalid content block in message.');
      // shallow copy + light size guard
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 200000) {
        throw new Error('A text block is too long.');
      }
      out.push(b);
    }
    return out;
  }
  throw new Error('Message content must be a string or an array of blocks.');
}

function validate(b) {
  if (!b || typeof b !== 'object') throw new Error('Invalid request body.');

  const model = String(b.model || DEFAULT_MODEL).trim();
  if (!/^[\w.:\-/]{1,100}$/.test(model)) throw new Error('Invalid model name.');
  if (MODELS.length && !MODELS.includes(model)) {
    throw new Error(`Model "${model}" is not allowed. Allowed: ${MODELS.join(', ')}`);
  }

  let maxTokens = parseInt(b.maxTokens, 10);
  if (!Number.isFinite(maxTokens)) maxTokens = 4096;
  // Claude 5.5 models support up to 128k output tokens
  maxTokens = Math.min(Math.max(maxTokens, 1), 128000);

  let temperature = null;
  if (b.temperature !== '' && b.temperature != null) {
    const t = Number(b.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error('Temperature must be between 0 and 1.');
    temperature = t;
  }

  const system = typeof b.system === 'string' ? b.system.trim().slice(0, 20000) : '';

  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 100) {
    throw new Error('messages must be an array of 1 to 100 items.');
  }

  const messages = b.messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new Error('Bad message role.');
    const content = normalizeContent(m.content);
    return { role: m.role, content };
  });
  if (messages[0].role !== 'user') throw new Error('The first message must be from the user.');

  const rawServers = Array.isArray(b.servers) ? b.servers : [];
  if (rawServers.length > 10) throw new Error('Up to 10 MCP servers per request.');
  const seen = new Set();
  const servers = rawServers.map((s) => {
    const name = String((s && s.name) || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error(`Server name "${name}" is invalid. Use letters, numbers, - and _ only.`);
    }
    if (seen.has(name)) throw new Error(`Duplicate server name "${name}".`);
    seen.add(name);
    let u;
    try { u = new URL(String(s.url)); } catch (_) { throw new Error(`Server "${name}" has an invalid URL.`); }
    if (u.protocol !== 'https:') throw new Error(`Server "${name}" must use an https:// URL.`);
    const token = typeof s.token === 'string' ? s.token.trim().slice(0, 4096) : '';
    return { name, url: u.toString(), token };
  });

  return { model, maxTokens, temperature, system, messages, servers };
}

// ---------- Anthropic call ----------
async function callAnthropic(body, signal) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (body.mcp_servers) headers['anthropic-beta'] = MCP_BETA;

  const r = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* leave null */ }

  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `Anthropic API error (HTTP ${r.status}).`;
    const err = new Error(r.status === 401 || r.status === 403 ? `Anthropic rejected the API key: ${msg}` : msg);
    err.status = r.status;
    throw err;
  }
  if (!data) throw new Error('Anthropic API returned a response that is not JSON.');
  return data;
}

// ---------- routes ----------
app.get('/api/config', (req, res) => {
  res.json({
    models: MODELS,
    defaultModel: DEFAULT_MODEL,
    authRequired: Boolean(APP_PASSWORD),
    hasKey: Boolean(API_KEY),
  });
});

app.post('/api/check', rateLimit, requireAuth, (req, res) => res.json({ ok: true }));

app.post('/api/chat', requireAuth, rateLimit, async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server. Add it to .env and restart.' });
  }

  let p;
  try { p = validate(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

  const base = { model: p.model, max_tokens: p.maxTokens };
  if (p.system) base.system = p.system;
  if (p.temperature !== null) base.temperature = p.temperature;
  if (p.servers.length) {
    base.mcp_servers = p.servers.map((s) => {
      const o = { type: 'url', url: s.url, name: s.name };
      if (s.token) o.authorization_token = s.token;
      return o;
    });
    base.tools = p.servers.map((s) => ({ type: 'mcp_toolset', mcp_server_name: s.name }));
  }

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

  try {
    let msgs = p.messages;
    const content = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let stop = null;
    let model = p.model;

    for (let i = 0; i <= MAX_CONTINUATIONS; i += 1) {
      const data = await callAnthropic({ ...base, messages: msgs }, ctrl.signal);
      content.push(...(data.content || []));
      usage.input_tokens += (data.usage && data.usage.input_tokens) || 0;
      usage.output_tokens += (data.usage && data.usage.output_tokens) || 0;
      stop = data.stop_reason;
      model = data.model || model;
      if (stop === 'pause_turn') {
        // Keep full structured content so the next turn has correct tool context
        msgs = [...msgs, { role: 'assistant', content: data.content }];
        continue;
      }
      break;
    }

    return res.json({ content, stop_reason: stop, usage, model });
  } catch (e) {
    if (res.writableEnded || res.destroyed) return undefined;
    if (e.name === 'AbortError') {
      if (timedOut) return res.status(504).json({ error: `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s. A tool may be slow or an MCP server may be unreachable.` });
      return undefined; // client left
    }
    const code = [400, 413, 429].includes(e.status) ? e.status : 502;
    return res.status(code).json({ error: e.message || 'Unexpected error.' });
  } finally {
    clearTimeout(timer);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 400 ? 'Malformed JSON body.' : 'Server error.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Patchbay running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!API_KEY) console.warn('! ANTHROPIC_API_KEY is missing. Copy .env.example to .env and set it.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !APP_PASSWORD) {
    console.warn('! The server is reachable from the network and APP_PASSWORD is not set. Anyone can spend your API credits.');
  }
});
