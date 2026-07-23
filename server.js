#!/usr/bin/env node
/**
 * bifrostapi-mcp — an MCP server that exposes BifrostAPI (bifrostapi.net) image
 * generation as a tool, so MCP hosts (Claude Desktop, Cursor, Cline, …)
 * can ask BifrostAPI to draw pictures.
 *
 * Transport: stdio (the standard for locally-run MCP servers).
 *
 * Config (env):
 *   BIFROSTAPI_API_KEY    required — your ck-… key from www.bifrostapi.net/app/keys
 *   BIFROSTAPI_BASE_URL   optional — gateway base (default api.bifrostapi.net)
 *   BIFROSTAPI_IMAGE_MODEL optional — default image model (default gpt-image-2)
 *   (legacy AURIXEL_* env names are still accepted as a fallback)
 *
 * Tools:
 *   generate_image(prompt, model?, size?)  → starts a job, returns a job_id
 *   get_image_result(job_id)               → fetches the image when ready
 *   list_image_models()                    → image models you can pass
 *
 * Why async (job_id + poll) instead of returning the image inline?
 * gpt-image-2 takes 60–120s, but MCP hosts cancel any single tool call at
 * a fixed ~60s timeout (DEFAULT_REQUEST_TIMEOUT_MSEC) that progress
 * notifications do NOT reliably reset. So we decouple the long generation
 * from the tool-call duration: generate_image returns instantly with a
 * job_id, the fetch runs in the background, and get_image_result returns
 * the picture once it's ready. Each tool call stays well under the host's
 * timeout, so generations never get cut off (and billed) mid-flight.
 *
 * Why the low-level Server API (not the high-level McpServer.tool helper):
 * setRequestHandler + JSON-Schema input has been stable across SDK 1.x,
 * and it keeps our dependency surface to just the SDK (no zod). Tool
 * results use MCP's `image` content type so the host renders the picture.
 *
 * IMPORTANT: stdout is the JSON-RPC channel — never console.log there.
 * All diagnostics go to stderr.
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = (process.env.BIFROSTAPI_BASE_URL || process.env.AURIXEL_BASE_URL || 'https://api.bifrostapi.net').replace(/\/+$/, '');
const API_KEY = process.env.BIFROSTAPI_API_KEY || process.env.AURIXEL_API_KEY || '';
const DEFAULT_IMAGE_MODEL = process.env.BIFROSTAPI_IMAGE_MODEL || process.env.AURIXEL_IMAGE_MODEL || 'gpt-image-2';

// Hard ceiling on a single upstream generation before we give up on it. Sits just
// ABOVE cpagw's image cap (CPA_IMAGE_TIMEOUT_SEC, default 420s) so we never abort a
// request cpagw would still finish + bill. gpt-image-2 runs ~50-270s (p90 ~170s); the
// old 180s ceiling aborted the slow tail with "This operation was aborted" while the
// image still generated upstream and got charged (paid-for-nothing).
const GEN_TIMEOUT_MS = 430000;
// How long get_image_result waits in-call for a pending job before
// returning "still generating". Must stay comfortably under the host's
// ~60s tool-call timeout so the poll itself never times out. Picking 30s
// means a 90s generation is fetched in ~3 polls instead of dozens.
const POLL_WAIT_MS = 30000;

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
}

const TOOLS = [
  {
    name: 'generate_image',
    description:
      "Start generating an image from a text prompt using BifrostAPI's image " +
      'models (e.g. gpt-image-2). Returns a job_id immediately (generation ' +
      'runs in the background and typically takes 60–120s). Then call ' +
      'get_image_result with the job_id to fetch the finished image. Use ' +
      'this when the user asks to draw, create, or generate a ' +
      'picture/illustration/logo.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Describe the image to generate. Be specific about subject, style, composition.' },
        model: { type: 'string', description: `Image model id (optional). Default: ${DEFAULT_IMAGE_MODEL}. Call list_image_models for options.` },
        size: { type: 'string', description: 'Optional output size, e.g. "1024x1024".' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_image_result',
    description:
      'Fetch the image for a job_id returned by generate_image. If the ' +
      'image is ready it is returned inline. If it is still generating, ' +
      'this returns a "still generating" message — just call ' +
      'get_image_result again with the same job_id after a few seconds. ' +
      'Each call is fast and will not time out.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by generate_image.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'list_image_models',
    description: 'List the image-generation models available on BifrostAPI that you can pass to generate_image.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// jobId -> { status: 'pending'|'done'|'error', model, startedAt, b64?, mime?, error? }
const jobs = new Map();

async function generateImage({ prompt, model, size }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required.');
  const useModel = model || DEFAULT_IMAGE_MODEL;
  // Abort a genuinely-stuck upstream request instead of leaking a job that
  // stays 'pending' forever.
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), GEN_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE_URL}/v1/images/generations`, {
      method: 'POST',
      headers: authHeaders(),
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

// Kick off a generation in the background and return its job_id immediately.
function startJob(args) {
  const jobId = randomUUID();
  const useModel = args.model || DEFAULT_IMAGE_MODEL;
  jobs.set(jobId, { status: 'pending', model: useModel, startedAt: Date.now() });
  generateImage(args)
    .then(({ b64, mime, model }) => {
      const j = jobs.get(jobId);
      if (!j) return;
      j.status = 'done';
      j.b64 = b64;
      j.mime = mime;
      j.model = model;
    })
    .catch((e) => {
      const j = jobs.get(jobId);
      if (!j) return;
      j.status = 'error';
      j.error = (e && e.message) || String(e);
    });
  return { jobId, useModel };
}

const elapsedSec = (j) => Math.round((Date.now() - j.startedAt) / 1000);

// Wait (in-call) up to sliceMs for a pending job to settle, polling cheaply.
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
  const items = json?.items || [];
  const out = items
    .filter((m) => {
      const mod = m.modalities;
      const outputs = Array.isArray(mod) ? mod : (mod && mod.output) || [];
      return Array.isArray(outputs) && outputs.includes('image');
    })
    .map((m) => m.model_id)
    .filter(Boolean);
  return out.length ? out : [DEFAULT_IMAGE_MODEL];
}

const server = new Server(
  { name: 'bifrostapi', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (!API_KEY) {
      throw new Error('BIFROSTAPI_API_KEY is not set. Add your ck-… key (from www.bifrostapi.net/app/keys) to the MCP server env.');
    }
    if (name === 'generate_image') {
      if (!args.prompt || !String(args.prompt).trim()) throw new Error('prompt is required.');
      const { jobId, useModel } = startJob(args);
      return {
        content: [
          {
            type: 'text',
            text:
              `Image generation started.\njob_id: ${jobId}\nmodel: ${useModel}\n\n` +
              `This model typically takes 60–120s. Call get_image_result with this ` +
              `job_id to fetch the image. If it says "still generating", just call ` +
              `get_image_result again with the same job_id — each call is fast and ` +
              `won't time out.`,
          },
        ],
      };
    }
    if (name === 'get_image_result') {
      const jobId = args.job_id || args.jobId;
      if (!jobId) throw new Error('job_id is required.');
      const j = await waitForJob(String(jobId), POLL_WAIT_MS);
      if (!j) throw new Error(`Unknown job_id: ${jobId}. Start a new generation with generate_image.`);
      if (j.status === 'pending') {
        return {
          content: [
            {
              type: 'text',
              text: `Still generating (${elapsedSec(j)}s elapsed). Call get_image_result again with job_id ${jobId} in a few seconds.`,
            },
          ],
        };
      }
      if (j.status === 'error') {
        const msg = j.error;
        jobs.delete(String(jobId));
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
      // done
      const { b64, mime, model } = j;
      const secs = elapsedSec(j);
      jobs.delete(String(jobId)); // one-shot fetch; free the image from memory
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

// Light housekeeping: free finished jobs that were never fetched, and fail
// any job stuck pending past the upstream ceiling. unref() so this timer
// never keeps the process alive on its own.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    const age = now - j.startedAt;
    if ((j.status === 'done' || j.status === 'error') && age > 600000) jobs.delete(id);
    else if (j.status === 'pending' && age > GEN_TIMEOUT_MS + 30000) {
      j.status = 'error';
      j.error = 'Generation timed out.';
    }
  }
}, 60000);
sweeper.unref?.();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[bifrostapi-mcp] ready · base=${BASE_URL} · key=${API_KEY ? 'set' : 'MISSING'} · model=${DEFAULT_IMAGE_MODEL}`);
