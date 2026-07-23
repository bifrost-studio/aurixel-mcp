#!/usr/bin/env node
/**
 * bifrostapi-mcp-http — REMOTE MCP server (Streamable HTTP transport).
 *
 * Unlike server.js (stdio, runs on the USER's machine, key from env), this is a
 * HOSTED, multi-tenant endpoint: one URL, every MCP host (Claude Desktop custom
 * connector, Cursor, Cline, …) connects over Streamable HTTP and authenticates
 * with ITS OWN ck-… key sent as `Authorization: Bearer ck-…` (or x-api-key) on
 * every request. We forward to the BifrostAPI OpenAI-compatible gateway with that
 * key and NEVER store it — the key lives only for the duration of the request /
 * session it arrived on.
 *
 * Transport: Streamable HTTP with per-session state — the transport every modern
 * MCP host speaks. Handshake: POST initialize → server returns an `mcp-session-id`
 * header → subsequent tools/list & tools/call reuse it; GET opens the SSE channel
 * for server→client notifications; DELETE tears the session down.
 *
 * Tools (same surface as the stdio server): generate_image (async job),
 * get_image_result (poll), list_image_models. Long gpt-image-2 renders (60–120s)
 * are decoupled from the tool-call so they never hit the host's ~60s timeout.
 *
 * Bind is 127.0.0.1 — Caddy fronts it with TLS at mcp.<domain> (same pattern as
 * the rest of the cpa stack). Config via env: PORT, BIFROSTAPI_BASE_URL (legacy
 * AURIXEL_BASE_URL still accepted).
 */
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.PORT || 8790);
const BIND = process.env.BIND || '127.0.0.1';
const BASE_URL = (process.env.BIFROSTAPI_BASE_URL || process.env.AURIXEL_BASE_URL || 'https://api.bifrostapi.net').replace(/\/+$/, '');
const DEFAULT_IMAGE_MODEL = process.env.BIFROSTAPI_IMAGE_MODEL || process.env.AURIXEL_IMAGE_MODEL || 'gpt-image-2';

// Hard ceiling on a single upstream generation before we give up on it. Sits just
// ABOVE cpagw's image cap (CPA_IMAGE_TIMEOUT_SEC, default 420s) so we never abort a
// request cpagw would still finish + bill. gpt-image-2 runs ~50-270s (p90 ~170s); the
// old 180s ceiling aborted the slow tail with "This operation was aborted" while the
// image still generated upstream and got charged (paid-for-nothing).
const GEN_TIMEOUT_MS = 430000;
// How long get_image_result waits in-call for a pending job before returning
// "still generating" — must stay comfortably under the host's ~60s tool-call
// timeout so the poll itself never times out.
const POLL_WAIT_MS = 30000;

const keyHash = (k) => createHash('sha256').update(String(k)).digest('hex').slice(0, 16);
const authHeaders = (apiKey) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

// jobId -> { status:'pending'|'done'|'error', model, startedAt, kh, b64?, mime?, error? }
// Module-level so it survives across the stateless-per-request handlers. Each job
// is bound to the ck- key that started it (kh = keyHash) so one tenant can never
// fetch another tenant's image even if it guessed the (random UUID) job id.
const jobs = new Map();

const TOOLS = [
  {
    name: 'generate_image',
    description:
      "Start generating an image from a text prompt using BifrostAPI's image models " +
      '(e.g. gpt-image-2). Returns a job_id immediately (generation runs in the ' +
      'background and typically takes 60–120s). Then call get_image_result with the ' +
      'job_id to fetch the finished image. Use this when the user asks to draw, ' +
      'create, or generate a picture/illustration/logo.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Describe the image. Be specific about subject, style, composition.' },
        model: { type: 'string', description: `Image model id (optional). Default: ${DEFAULT_IMAGE_MODEL}. Call list_image_models for options.` },
        size: { type: 'string', description: 'Optional output size, e.g. "1024x1024".' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_image_result',
    description:
      'Fetch the image for a job_id returned by generate_image. If ready it is ' +
      'returned inline. If still generating, returns a "still generating" message — ' +
      'just call again with the same job_id after a few seconds. Each call is fast ' +
      'and will not time out.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'The job_id returned by generate_image.' } },
      required: ['job_id'],
    },
  },
  {
    name: 'list_image_models',
    description: 'List the image-generation models available on BifrostAPI that you can pass to generate_image.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function generateImage(apiKey, { prompt, model, size }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required.');
  const useModel = model || DEFAULT_IMAGE_MODEL;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), GEN_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE_URL}/v1/images/generations`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model: useModel, prompt, n: 1, ...(size ? { size } : {}) }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Image generation failed (HTTP ${r.status}). ${text.slice(0, 300)}`);
    }
    const json = await r.json();
    const first = json?.data?.[0];
    if (!first) throw new Error('Upstream returned no image.');
    let b64 = first.b64_json || null;
    let mime = 'image/png';
    if (!b64 && first.url) {
      const ir = await fetch(first.url);
      if (!ir.ok) throw new Error(`Could not fetch the generated image URL (HTTP ${ir.status}).`);
      mime = ir.headers.get('content-type') || mime;
      b64 = Buffer.from(await ir.arrayBuffer()).toString('base64');
    }
    if (!b64) throw new Error('No image data in upstream response.');
    return { b64, mime, model: useModel };
  } finally {
    clearTimeout(to);
  }
}

function startJob(apiKey, args) {
  const jobId = randomUUID();
  const useModel = args.model || DEFAULT_IMAGE_MODEL;
  jobs.set(jobId, { status: 'pending', model: useModel, startedAt: Date.now(), kh: keyHash(apiKey) });
  generateImage(apiKey, args)
    .then(({ b64, mime, model }) => {
      const j = jobs.get(jobId);
      if (!j) return;
      Object.assign(j, { status: 'done', b64, mime, model });
    })
    .catch((e) => {
      const j = jobs.get(jobId);
      if (!j) return;
      Object.assign(j, { status: 'error', error: (e && e.message) || String(e) });
    });
  return { jobId, useModel };
}

const elapsedSec = (j) => Math.round((Date.now() - j.startedAt) / 1000);

async function waitForJob(jobId, sliceMs) {
  const j = jobs.get(jobId);
  if (!j) return null;
  const deadline = Date.now() + sliceMs;
  while (j.status === 'pending' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  return j;
}

async function listImageModels() {
  // /public/models is unauthenticated and carries modality info.
  const r = await fetch(`${BASE_URL}/public/models`);
  if (!r.ok) throw new Error(`Could not list models (HTTP ${r.status}).`);
  const json = await r.json();
  const items = json?.items || json?.data || [];
  const out = items
    .filter((m) => {
      const mod = m.modalities;
      const outputs = Array.isArray(mod) ? mod : (mod && mod.output) || [];
      return Array.isArray(outputs) && outputs.includes('image');
    })
    .map((m) => m.model_id || m.id)
    .filter(Boolean);
  return out.length ? out : [DEFAULT_IMAGE_MODEL];
}

// Build an MCP server whose tool handlers are bound to one tenant's ck- key.
function createMcpServer(apiKey) {
  const server = new Server({ name: 'bifrostapi', version: '0.3.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      if (name === 'generate_image') {
        if (!apiKey) throw new Error('Missing API key. Send Authorization: Bearer ck-… when connecting.');
        if (!args.prompt || !String(args.prompt).trim()) throw new Error('prompt is required.');
        const { jobId, useModel } = startJob(apiKey, args);
        return {
          content: [{
            type: 'text',
            text:
              `Image generation started.\njob_id: ${jobId}\nmodel: ${useModel}\n\n` +
              `This model typically takes 60–120s. Call get_image_result with this job_id ` +
              `to fetch the image. If it says "still generating", just call again with the ` +
              `same job_id — each call is fast and won't time out.`,
          }],
        };
      }
      if (name === 'get_image_result') {
        const jobId = args.job_id || args.jobId;
        if (!jobId) throw new Error('job_id is required.');
        const j = await waitForJob(String(jobId), POLL_WAIT_MS);
        // Bind result to the key that started the job (unguessable UUID + tenant check).
        if (!j || j.kh !== keyHash(apiKey)) {
          throw new Error(`Unknown job_id: ${jobId}. Start a new generation with generate_image.`);
        }
        if (j.status === 'pending') {
          return { content: [{ type: 'text', text: `Still generating (${elapsedSec(j)}s elapsed). Call get_image_result again with job_id ${jobId} in a few seconds.` }] };
        }
        if (j.status === 'error') {
          const msg = j.error;
          jobs.delete(String(jobId));
          return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
        }
        const { b64, mime, model } = j;
        const secs = elapsedSec(j);
        jobs.delete(String(jobId));
        return {
          content: [
            { type: 'text', text: `Generated with ${model} (${secs}s).` },
            { type: 'image', data: b64, mimeType: mime },
          ],
        };
      }
      if (name === 'list_image_models') {
        const list = await listImageModels();
        return { content: [{ type: 'text', text: 'BifrostAPI image models:\n' + list.map((m) => `- ${m}`).join('\n') }] };
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e && e.message) || String(e)}` }], isError: true };
    }
  });

  return server;
}

function extractKey(req) {
  const auth = req.headers['authorization'] || '';
  if (/^bearer /i.test(auth)) return auth.slice(7).trim();
  const x = req.headers['x-api-key'];
  if (x) return String(x).trim();
  return '';
}

const rpcErr = (code, message, id = null) => ({ jsonrpc: '2.0', error: { code, message }, id });

const app = express();
app.use(express.json({ limit: '8mb' }));

// sessionId -> transport. Single-process in-memory store (MVP; one box behind Caddy).
const transports = {};

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      // No session yet — must be an `initialize` request, and must carry a key.
      if (!isInitializeRequest(req.body)) {
        return res.status(400).json(rpcErr(-32000, 'No valid session — send an initialize request first.', req.body?.id ?? null));
      }
      const apiKey = extractKey(req);
      if (!apiKey) {
        return res.status(401).json(rpcErr(-32001, 'Missing API key. Send "Authorization: Bearer ck-…" (get one at www.bifrostapi.net/app/keys).', req.body?.id ?? null));
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports[sid] = transport; },
      });
      transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
      const server = createMcpServer(apiKey);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json(rpcErr(-32603, 'Internal error'));
  }
});

// SSE stream (server→client notifications) + session teardown reuse the transport.
const sessionRequest = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) return res.status(400).send('Invalid or missing mcp-session-id.');
  await transport.handleRequest(req, res);
};
app.get('/mcp', sessionRequest);
app.delete('/mcp', sessionRequest);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Housekeeping: drop stale finished jobs and fail jobs stuck pending past the ceiling.
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    const age = now - j.startedAt;
    if ((j.status === 'done' || j.status === 'error') && age > 600000) jobs.delete(id);
    else if (j.status === 'pending' && age > GEN_TIMEOUT_MS + 30000) { j.status = 'error'; j.error = 'Generation timed out.'; }
  }
}, 60000).unref?.();

app.listen(PORT, BIND, () => {
  console.error(`[bifrostapi-mcp-http] listening on ${BIND}:${PORT} → ${BASE_URL}`);
});
