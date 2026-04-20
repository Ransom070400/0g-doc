/**
 * Shared chat handler for the "Ask 0G AI" docs widget.
 *
 * Proxies an OpenAI-compatible request to a 0G Compute inference service.
 * Used by both the Vercel serverless function (api/chat.js) and the
 * Docusaurus dev-server middleware (src/plugins/ask-ai-dev-plugin.js), so
 * there is one source of truth.
 *
 * Environment variables:
 *   ASK_AI_SERVICE_URL  — e.g. https://<provider-host>/v1/proxy
 *   ASK_AI_API_KEY      — app-sk-<SECRET> from `0g-compute-cli inference get-secret`
 *   ASK_AI_MODEL        — e.g. GLM-5-FP8, gpt-oss-120b
 *   ASK_AI_MOCK=1       — skip the upstream call and return a canned reply (local smoke-test)
 */

const SYSTEM_PROMPT = [
  'You are the 0G Labs documentation assistant.',
  '0G is a modular AI L1 with a chain, decentralized storage, data availability, and a compute network for verifiable AI inference.',
  'Answer questions grounded in the provided page context when available. If the page context does not contain the answer, say so and suggest where the user might look in the docs.',
  'Be concise. Prefer short paragraphs and code blocks over prose. Never invent contract addresses, RPC URLs, or model names — if unsure, say so.',
].join(' ');

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
    : [];

  const contextBlock = pageContext
    ? `The user is currently reading this docs page. Use it as the primary source of truth when answering.\n\n----\n${String(pageContext).slice(0, 4000)}\n----`
    : 'No page context was provided.';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextBlock },
    ...safeMessages,
  ];
}

async function handleChat(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  const payloadMessages = buildMessages(body);

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
