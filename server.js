#!/usr/bin/env node
/**
 * aurixel-mcp — an MCP server that exposes Aurixel (joyviz.ai) image
 * generation as a tool, so MCP hosts (Claude Desktop, Cursor, Cline, …)
 * can ask Aurixel to draw pictures.
 *
 * Transport: stdio (the standard for locally-run MCP servers).
 *
 * Config (env):
 *   AURIXEL_API_KEY    required — your ck-… key from app.joyviz.ai/app/keys
 *   AURIXEL_BASE_URL   optional — gateway base (default conduit-api.joyviz.ai)
 *   AURIXEL_IMAGE_MODEL optional — default image model (default gpt-image-2)
 *
 * Tools:
 *   generate_image(prompt, model?, size?)  → returns the image inline
 *   list_image_models()                    → image models you can pass
 *
 * Why the low-level Server API (not the high-level McpServer.tool helper):
 * setRequestHandler + JSON-Schema input has been stable across SDK 1.x,
 * and it keeps our dependency surface to just the SDK (no zod). Tool
 * results use MCP's `image` content type so the host renders the picture.
 *
 * IMPORTANT: stdout is the JSON-RPC channel — never console.log there.
 * All diagnostics go to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = (process.env.AURIXEL_BASE_URL || 'https://conduit-api.joyviz.ai').replace(/\/+$/, '');
const API_KEY = process.env.AURIXEL_API_KEY || '';
const DEFAULT_IMAGE_MODEL = process.env.AURIXEL_IMAGE_MODEL || 'gpt-image-2';

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
}

const TOOLS = [
  {
    name: 'generate_image',
    description:
      "Generate an image from a text prompt using Aurixel's image models " +
      '(e.g. gpt-image-2). Returns the generated image inline. Use this when ' +
      'the user asks to draw, create, or generate a picture/illustration/logo.',
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
    name: 'list_image_models',
    description: 'List the image-generation models available on Aurixel that you can pass to generate_image.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function generateImage({ prompt, model, size }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required.');
  const useModel = model || DEFAULT_IMAGE_MODEL;
  const r = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model: useModel, prompt, n: 1, ...(size ? { size } : {}) }),
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
  { name: 'aurixel', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (!API_KEY) {
      throw new Error('AURIXEL_API_KEY is not set. Add your ck-… key (from app.joyviz.ai/app/keys) to the MCP server env.');
    }
    if (name === 'generate_image') {
      const { b64, mime, model } = await generateImage(args);
      return {
        content: [
          { type: 'text', text: `Generated with ${model}.` },
          { type: 'image', data: b64, mimeType: mime },
        ],
      };
    }
    if (name === 'list_image_models') {
      const list = await listImageModels();
      return { content: [{ type: 'text', text: 'Aurixel image models:\n' + list.map((m) => `- ${m}`).join('\n') }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${(e && e.message) || String(e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[aurixel-mcp] ready · base=${BASE_URL} · key=${API_KEY ? 'set' : 'MISSING'} · model=${DEFAULT_IMAGE_MODEL}`);
