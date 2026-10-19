import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/app.mjs';
import { createVercelApp } from '../server/vercel.mjs';

const names = ['index.html', 'styles.css', 'app.mjs', 'core.mjs', 'networks.mjs', 'icon.svg', 'stripe-client.mjs'];
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', mjs: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
const assets = {};
for (const name of names) assets['/' + name] = { body: await readFile(new URL('../public/' + name, import.meta.url), 'utf8'), type: types[name.split('.').at(-1)] };
const staticApp = createApp(assets), api = createVercelApp(), port = 4180;
createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, init);
    const response = await (new URL(request.url).pathname.startsWith('/api/') ? api.fetch(request) : staticApp.fetch(request));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Request failed.');
  }
}).listen(port, '127.0.0.1', () => console.log(`Cardlab Vercel preview: http://127.0.0.1:${port}`));
