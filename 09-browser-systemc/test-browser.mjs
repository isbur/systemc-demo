/**
 * Headless Chrome: the live page builds one project and shows AND(1,1)=1.
 * Serves the repo with cross-origin isolation so the pthread wasm can start.
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.map': 'application/json',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) {
      res.writeHead(302, { location: url.pathname.replace(/\/$/, '') + '/index.html' });
      res.end();
      return;
    }
    const body = readFileSync(path);
    res.writeHead(200, {
      'content-type': types[extname(path)] || 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-resource-policy': 'cross-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const page = `http://127.0.0.1:${port}/09-browser-systemc/app/index.html`;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=9222', page,
], { stdio: 'ignore' });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(250);
  try {
    const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    wsUrl = tabs.find((tab) => tab.type === 'page' && tab.url.includes('index.html'))?.webSocketDebuggerUrl;
  } catch { /* chrome still starting */ }
}
if (!wsUrl) {
  chrome.kill();
  server.close();
  throw new Error('chrome did not expose the page');
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
function cdp(method, params, timeoutMs = 20000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('cdp timeout ' + method));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function evaluate(expression, timeoutMs = 20000) {
  const reply = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs + 5000);
  if (reply.result?.exceptionDetails) {
    const details = reply.result.exceptionDetails;
    throw new Error(details.text + ' ' + (details.exception?.description || ''));
  }
  return reply.result?.result?.value;
}

console.log('page', page);
const started = Date.now();
let booted = false;
while (Date.now() - started < 30000) {
  booted = await evaluate('Boolean(window.__sysc)');
  if (booted) break;
  await sleep(200);
}
if (!booted) throw new Error('app did not boot');
console.log('booted in', Date.now() - started, 'ms');

const result = await evaluate(`(async () => {
  const { sim, viz } = window.__sysc;
  const vcc = viz.addElement('VCC', 40, 40);
  const and = viz.addElement('AND', 240, 40);
  const vccView = viz.elementViews.get(vcc.uid);
  const andView = viz.elementViews.get(and.uid);
  viz.graph.addCell(viz._makeLink(vccView.cell, 'y', andView.cell, 'a'));
  viz.graph.addCell(viz._makeLink(vccView.cell, 'y', andView.cell, 'b'));
  const sample = await sim.rebuild();
  return {
    y: and.outputs.y,
    a: and.inputs.a,
    b: and.inputs.b,
    wires: sim.connections.length,
    status: sample && sample.status,
    time: sim.time,
    text: document.getElementById('signals-list')?.textContent || '',
  };
})()`, 240000);
console.log('browser result', JSON.stringify(result), 'after', Date.now() - started, 'ms');
ws.close();
chrome.kill();
server.close();
if (!result || result.y !== 1 || result.a !== 1 || result.wires !== 2) process.exit(1);
console.log('browser test passed');
