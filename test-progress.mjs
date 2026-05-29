// Verify progress notifications fire during a tool call (uses a bad key so
// the gateway 401s fast — no real image generated/billed; the t=0 heartbeat
// still proves the progress wiring).
import { spawn } from 'node:child_process';
const p = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, AURIXEL_API_KEY: 'ck-fake-invalid' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
p.stdout.on('data', (d) => (out += d.toString()));
p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'x' }, _meta: { progressToken: 'p1' } } });
setTimeout(() => {
  p.kill();
  const sawProgress = out.includes('"notifications/progress"') && out.includes('"progressToken":"p1"');
  const sawResult = /"id":2/.test(out);
  console.log('=== STDOUT ===\n' + out);
  console.log('\nPROGRESS NOTIFICATION SENT:', sawProgress);
  console.log('TOOL RESULT RETURNED:', sawResult);
  process.exit(sawProgress && sawResult ? 0 : 1);
}, 4000);
