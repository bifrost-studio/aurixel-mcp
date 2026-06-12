// Quick stdio harness: spawn the server, do the MCP handshake, list tools.
import { spawn } from 'node:child_process';

const p = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, AURIXEL_API_KEY: 'ck-test' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
p.stdout.on('data', (d) => (out += d.toString()));
p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

setTimeout(() => {
  p.kill();
  console.log('=== STDOUT ===\n' + out);
  const ok = out.includes('generate_image') && out.includes('get_image_result') && out.includes('list_image_models');
  console.log('\nTOOLS REGISTERED OK:', ok);
  process.exit(ok ? 0 : 1);
}, 2000);
