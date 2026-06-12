// End-to-end async test: handshake → list tools → generate_image (job_id)
// → poll get_image_result until the image comes back. Uses a REAL key, so
// it generates (and bills) one image. Proves each tool call stays fast and
// the picture is delivered via polling.
import { spawn } from 'node:child_process';

const KEY = process.env.AURIXEL_API_KEY;
if (!KEY) {
  console.error('Set AURIXEL_API_KEY to a real ck-… key to run this end-to-end test (it generates and bills one image).');
  process.exit(2);
}
const p = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, AURIXEL_API_KEY: KEY },
  stdio: ['pipe', 'pipe', 'pipe'],
});
p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

let buf = '';
const waiters = new Map(); // id -> resolve
p.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

let idc = 0;
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++idc;
    waiters.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1);

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  notify('notifications/initialized');

  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  console.log(`[${since()}s] tools:`, names.join(', '));
  const haveTools = ['generate_image', 'get_image_result', 'list_image_models'].every((n) => names.includes(n));
  console.log('TOOLS OK:', haveTools);

  // 1) start generation — must return FAST with a job_id
  const g0 = Date.now();
  const started = await rpc('tools/call', { name: 'generate_image', arguments: { prompt: 'a single fresh red apple on a white background, product photo' } });
  const startText = started.result?.content?.[0]?.text || '';
  const startMs = Date.now() - g0;
  const jobId = (startText.match(/job_id:\s*([0-9a-f-]+)/i) || [])[1];
  console.log(`[${since()}s] generate_image returned in ${startMs}ms · job_id=${jobId}`);
  console.log('START IS FAST (<5s):', startMs < 5000);

  // 2) poll get_image_result until the image arrives
  let gotImage = false;
  let polls = 0;
  let lastPollMs = 0;
  while (!gotImage && polls < 8) {
    polls++;
    const q0 = Date.now();
    const res = await rpc('tools/call', { name: 'get_image_result', arguments: { job_id: jobId } });
    lastPollMs = Date.now() - q0;
    const parts = res.result?.content || [];
    const txt = parts.find((c) => c.type === 'text')?.text || '';
    const img = parts.find((c) => c.type === 'image');
    if (img) {
      gotImage = true;
      console.log(`[${since()}s] poll #${polls} (${lastPollMs}ms): IMAGE ✓  ${txt}  bytes(b64)=${img.data.length}`);
    } else {
      console.log(`[${since()}s] poll #${polls} (${lastPollMs}ms): ${txt}`);
      console.log('  POLL STAYED UNDER 60s:', lastPollMs < 60000);
    }
  }

  console.log('\n=== RESULT ===');
  console.log('image delivered via polling:', gotImage);
  console.log('total wall-clock:', since() + 's');
  p.kill();
  process.exit(haveTools && jobId && gotImage ? 0 : 1);
} catch (e) {
  console.error('TEST ERROR:', e);
  p.kill();
  process.exit(1);
}
