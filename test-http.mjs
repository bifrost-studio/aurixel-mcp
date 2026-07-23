// End-to-end test of the REMOTE MCP server using the real MCP client transport.
// Usage: KEY=ck-... MCP_URL=http://127.0.0.1:8790/mcp node test-http.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const KEY = process.env.KEY || '';
const endpoint = process.env.MCP_URL || 'http://127.0.0.1:8790/mcp';

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} },
});
const client = new Client({ name: 'aurixel-test', version: '0.0.1' }, { capabilities: {} });

await client.connect(transport);
console.log('✓ connected (initialize handshake ok) — session:', transport.sessionId);

const tools = await client.listTools();
console.log('✓ tools/list:', tools.tools.map((t) => t.name).join(', '));

const models = await client.callTool({ name: 'list_image_models', arguments: {} });
const text = (models.content || []).map((c) => c.text).filter(Boolean).join(' ');
console.log('✓ list_image_models:', text.replace(/\n/g, ' ').slice(0, 200));

if (process.env.GEN === '1') {
  console.log('… generate_image (real, ~60–120s)…');
  const g = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a tiny watercolor fox, minimal' } });
  const jobLine = (g.content || []).map((c) => c.text).join(' ');
  const jobId = (jobLine.match(/job_id:\s*(\S+)/) || [])[1];
  console.log('  started job:', jobId);
  for (let i = 0; i < 8; i++) {
    const r = await client.callTool({ name: 'get_image_result', arguments: { job_id: jobId } });
    const parts = r.content || [];
    const img = parts.find((c) => c.type === 'image');
    if (img) { console.log(`✓ image received: ${img.mimeType}, ${img.data.length} b64 chars`); break; }
    console.log('   poll:', parts.map((c) => c.text).join(' ').slice(0, 80));
  }
}

await client.close();
console.log('✓ closed. ALL GOOD.');
