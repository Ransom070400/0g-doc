/**
 * Shared chat handler for the "Ask 0G AI" docs widget.
 *
 * Proxies an OpenAI-compatible request to a 0G Compute inference service.
 * Used by both the Vercel serverless function (api/chat.js) and the
 * Docusaurus dev-server middleware (src/plugins/ask-ai-dev-plugin.js), so
 * there is one source of truth.
 *
 * Environment variables:
 *   ASK_AI_SERVICE_URL          — e.g. https://<provider-host>/v1/proxy
 *   ASK_AI_API_KEY              — app-sk-<SECRET> from `0g-compute-cli inference get-secret`
 *   ASK_AI_MODEL                — e.g. GLM-5-FP8, qwen3.6-plus
 *   ASK_AI_MOCK=1               — skip the upstream call and return a canned reply (local smoke-test)
 *   ASK_AI_RPM_PER_IP           — per-IP requests allowed in the window (default 10)
 *   ASK_AI_WINDOW_SECONDS       — sliding-window length in seconds (default 60)
 *   ASK_AI_DAILY_SPEND_CAP_OG   — UTC-day spend ceiling in 0G (default Infinity = no cap)
 *   ASK_AI_PRICE_IN_PER_1M      — input price in 0G per 1M tokens (default 0.8 for qwen3.6-plus)
 *   ASK_AI_PRICE_OUT_PER_1M     — output price in 0G per 1M tokens (default 4.8 for qwen3.6-plus)
 *   ASK_AI_ALLOWED_ORIGINS      — comma-separated allowlist of Origin headers (default: docs.0g.ai + localhost)
 *   ASK_AI_MAX_MESSAGE_CHARS    — per-message char cap (default 4000)
 *   ASK_AI_MAX_PAGE_CONTEXT_CHARS — pageContext char cap (default 8000)
 *
 * NOTE on durability: rate-limit and spend-cap state live in process memory.
 * They reset on serverless cold starts and are not shared across concurrent
 * Vercel function instances. Swap the in-memory Maps for a shared KV store
 * (Upstash Ratelimit + Redis counter, Vercel KV) before going to production.
 * Look for "SWAP POINT" comments below to find the spots to replace.
 */

const fs = require('fs');
const path = require('path');

const RATE_LIMIT_RPM = Number(process.env.ASK_AI_RPM_PER_IP || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.ASK_AI_WINDOW_SECONDS || 60) * 1000;
const DAILY_SPEND_CAP_OG = process.env.ASK_AI_DAILY_SPEND_CAP_OG
  ? Number(process.env.ASK_AI_DAILY_SPEND_CAP_OG)
  : Infinity;
const PRICE_IN_PER_1M = Number(process.env.ASK_AI_PRICE_IN_PER_1M || 0.8);
const PRICE_OUT_PER_1M = Number(process.env.ASK_AI_PRICE_OUT_PER_1M || 4.8);
const MAX_OUTPUT_TOKENS = 512;
const MAX_MESSAGE_CHARS = Number(process.env.ASK_AI_MAX_MESSAGE_CHARS || 4000);
const MAX_PAGE_CONTEXT_CHARS = Number(process.env.ASK_AI_MAX_PAGE_CONTEXT_CHARS || 8000);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://docs.0g.ai',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];
const ALLOWED_ORIGINS = (process.env.ASK_AI_ALLOWED_ORIGINS
  ? process.env.ASK_AI_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS);

// SWAP POINT: replace `ipHits` with @upstash/ratelimit (Redis-backed sliding window).
const ipHits = new Map();
// SWAP POINT: replace `dailySpend` with a single Redis counter keyed by getTodayKey() + INCRBY.
const dailySpend = new Map();

// Vercel/Cloudflare set x-real-ip server-side. Prefer it because clients can
// freely supply x-forwarded-for. As a fallback, take the rightmost entry of
// x-forwarded-for (the trusted proxy's hop), since the platform appends the
// real client IP after any user-supplied values.
function getClientIp(req) {
  const xri = req.headers && req.headers['x-real-ip'];
  if (typeof xri === 'string' && xri.length > 0) return xri.trim();
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function getOrigin(req) {
  const o = req.headers && req.headers.origin;
  return typeof o === 'string' ? o : '';
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

function setCorsHeaders(res, origin) {
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function rateLimitCheck(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let hits = (ipHits.get(ip) || []).filter((t) => t > cutoff);
  if (hits.length >= RATE_LIMIT_RPM) {
    ipHits.set(ip, hits);
    return { ok: false, retryAfterMs: hits[0] + RATE_LIMIT_WINDOW_MS - now };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) ipHits.delete(k);
      else ipHits.set(k, fresh);
    }
  }
  return { ok: true };
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getTodaysSpend() {
  return dailySpend.get(getTodayKey()) || 0;
}

function estimateRequestCostOg(payloadMessages) {
  const chars = payloadMessages.reduce((sum, m) => sum + (m.content || '').length, 0);
  const inputTokens = chars / 4;
  return (inputTokens / 1e6) * PRICE_IN_PER_1M + (MAX_OUTPUT_TOKENS / 1e6) * PRICE_OUT_PER_1M;
}

function recordSpend(og) {
  const key = getTodayKey();
  dailySpend.set(key, (dailySpend.get(key) || 0) + og);
  if (dailySpend.size > 30) {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const k of dailySpend.keys()) {
      if (k < cutoff) dailySpend.delete(k);
    }
  }
}

const SYSTEM_PROMPT = [
  'You are the 0G Labs documentation assistant.',
  '0G is a modular AI L1 with a chain, decentralized storage, data availability, and a compute network for verifiable AI inference.',
  'Answer questions grounded in the provided page context when available. If the page context does not contain the answer, say so and point the user to the most relevant page from the docs index.',
  'When referencing another docs page, output a markdown link using the exact path from the docs index, e.g. [Inference](/developer-hub/building-on-0g/compute-network/inference). Never invent paths — if no index entry fits, say so.',
  'Be concise. Prefer short paragraphs and code blocks over prose. Never invent contract addresses, RPC URLs, or model names — if unsure, say so.',
].join(' ');

const DOCS_ROOT = path.resolve(__dirname, '..', '..', 'docs');
let docsIndexCache = null;

function extractFrontmatterField(frontmatter, field) {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const match = frontmatter.match(re);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function buildDocsIndex() {
  if (docsIndexCache) return docsIndexCache;
  const entries = [];

  function walk(dir, urlPrefix) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, `${urlPrefix}/${item.name}`);
      } else if (item.isFile() && /\.mdx?$/.test(item.name)) {
        const slug = item.name.replace(/\.mdx?$/, '');
        const urlPath = `${urlPrefix}/${slug}`;
        let title = slug;
        let description = '';
        try {
          const content = fs.readFileSync(full, 'utf8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            title = extractFrontmatterField(fmMatch[1], 'title') || title;
            description = extractFrontmatterField(fmMatch[1], 'description') || '';
          }
          if (title === slug) {
            const h1Match = content.match(/^#\s+(.+)$/m);
            if (h1Match) title = h1Match[1].trim();
          }
        } catch {}
        entries.push({ path: urlPath, title, description });
      }
    }
  }

  walk(DOCS_ROOT, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  docsIndexCache = entries;
  return entries;
}

function formatDocsIndex(entries) {
  return entries
    .map((e) => (e.description ? `- ${e.path} — ${e.title}: ${e.description}` : `- ${e.path} — ${e.title}`))
    .join('\n');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function buildMessages({ messages, pageContext }) {
  const safeMessages = Array.isArray(messages)
    ? messages
        .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    : [];

  const trimmedContext = pageContext ? String(pageContext).slice(0, MAX_PAGE_CONTEXT_CHARS) : '';
  const contextBlock = trimmedContext
    ? `The user is currently reading this docs page. Use it as the primary source of truth when answering.\n\n----\n${trimmedContext}\n----`
    : 'No page context was provided.';

  const indexBlock = `Docs index (use these exact paths when linking to other pages — never invent paths):\n${formatDocsIndex(buildDocsIndex())}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: indexBlock },
    { role: 'system', content: contextBlock },
    ...safeMessages,
  ];
}

async function handleChat(req, res) {
  const origin = getOrigin(req);
  setCorsHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (!isAllowedOrigin(origin)) {
    console.warn(`[ask-ai] rejected request from origin=${origin || '<none>'} ip=${getClientIp(req)}`);
    sendJson(res, 403, { error: 'Origin not allowed.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  const ip = getClientIp(req);
  const rl = rateLimitCheck(ip);
  if (!rl.ok) {
    const retryAfterSec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
    res.setHeader('Retry-After', retryAfterSec.toString());
    console.warn(`[ask-ai] rate-limited ip=${ip} retryAfter=${retryAfterSec}s`);
    sendJson(res, 429, {
      error: `Too many requests. Try again in ${retryAfterSec}s.`,
    });
    return;
  }

  const payloadMessages = buildMessages(body);
  const requestCostOg = estimateRequestCostOg(payloadMessages);
  const spendBefore = getTodaysSpend();
  if (spendBefore + requestCostOg > DAILY_SPEND_CAP_OG) {
    console.warn(`[ask-ai] daily spend cap hit cap=${DAILY_SPEND_CAP_OG}OG spentToday=${spendBefore.toFixed(4)}OG`);
    sendJson(res, 429, {
      error: `Daily spend cap reached (${DAILY_SPEND_CAP_OG} 0G). Try again tomorrow.`,
      spentToday: Number(spendBefore.toFixed(4)),
    });
    return;
  }

  if (process.env.ASK_AI_MOCK === '1') {
    const lastUser = [...(body.messages || [])].reverse().find((m) => m && m.role === 'user');
    const reply = [
      'Mock mode is on (ASK_AI_MOCK=1), so I am not calling 0G Compute.',
      lastUser ? `You asked: "${String(lastUser.content).slice(0, 200)}"` : '',
      'Set ASK_AI_SERVICE_URL, ASK_AI_API_KEY, and ASK_AI_MODEL to enable real answers.',
    ]
      .filter(Boolean)
      .join('\n\n');
    sendJson(res, 200, { reply, model: 'mock', mock: true });
    return;
  }

  const serviceUrl = process.env.ASK_AI_SERVICE_URL;
  const apiKey = process.env.ASK_AI_API_KEY;
  const model = process.env.ASK_AI_MODEL;
  if (!serviceUrl || !model) {
    sendJson(res, 503, {
      error:
        'Ask-AI is not configured. Set ASK_AI_SERVICE_URL and ASK_AI_MODEL (and ASK_AI_API_KEY unless using the local 0G proxy), or run with ASK_AI_MOCK=1.',
    });
    return;
  }

  const upstream = `${serviceUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  recordSpend(requestCostOg);
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: payloadMessages,
        temperature: 0.2,
        max_tokens: 512,
        stream: true,
      }),
    });
  } catch (err) {
    sendJson(res, 502, { error: `Upstream request failed: ${err.message}` });
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const text = await upstreamRes.text().catch(() => '');
    sendJson(res, upstreamRes.status || 502, {
      error: `Upstream error (${upstreamRes.status})`,
      detail: text.slice(0, 600),
    });
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const teeChatId =
    upstreamRes.headers.get('zg-res-key') ||
    upstreamRes.headers.get('ZG-Res-Key') ||
    null;
  if (teeChatId) {
    res.write(`event: 0g-meta\ndata: ${JSON.stringify({ chatId: teeChatId, teeRouted: true })}\n\n`);
  }

  try {
    for await (const chunk of upstreamRes.body) {
      res.write(chunk);
    }
  } catch (err) {
    res.write(`\ndata: {"error":"stream interrupted: ${String(err.message).replace(/"/g, "'")}"}\n\n`);
  } finally {
    res.end();
  }
}

module.exports = { handleChat };
