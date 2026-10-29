#!/usr/bin/env node
'use strict';
// Local development / test server. Serves index.html and runs the real Netlify
// function handlers against an in-memory (or --data-dir file-backed) Blobs
// stand-in. It never connects to production storage.
//
// Usage:
//   SESSION_SECRET=… PASSWORD_MARKETING=… node scripts/dev-server.js [--port 8888] [--data-dir ./private/dev-data]
// Use only synthetic passwords and fictional links locally.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { memoryStoreFactory } = require('./lib/memory-store');
const { setStoreFactoryForTests } = require('../netlify/lib/storage');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = ['check-password', 'session', 'get-links', 'manage-links'];

function tomlHeaders() {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const out = {};
  const block = toml.split('[headers.values]')[1] || '';
  for (const line of block.split('\n')) {
    const m = line.match(/^\s+([A-Za-z-]+)\s*=\s*"(.*)"\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function createServer({ factory } = {}) {
  const storeFactory = factory || memoryStoreFactory();
  setStoreFactoryForTests(storeFactory);
  const handlers = Object.fromEntries(FUNCTIONS.map(n => [n, require(`../netlify/functions/${n}.js`).handler]));
  const staticHeaders = tomlHeaders();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const fnMatch = url.pathname.match(/^\/\.netlify\/functions\/([a-z-]+)$/);
    if (fnMatch) {
      const handler = handlers[fnMatch[1]];
      if (!handler) { res.writeHead(404); return res.end(); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = { ...req.headers, 'x-nf-client-connection-ip': req.headers['x-test-client-ip'] || req.socket.remoteAddress };
      const event = {
        httpMethod: req.method,
        path: url.pathname,
        headers,
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: Buffer.concat(chunks).toString('utf8'),
        isBase64Encoded: false,
      };
      let result;
      try {
        result = await handler(event);
      } catch (err) {
        console.error('handler crashed', err);
        result = { statusCode: 500, body: '' };
      }
      const outHeaders = { ...(result.headers || {}) };
      if (result.multiValueHeaders && result.multiValueHeaders['Set-Cookie']) outHeaders['Set-Cookie'] = result.multiValueHeaders['Set-Cookie'];
      res.writeHead(result.statusCode, outHeaders);
      return res.end(result.body || '');
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (['index.html', 'succulents-box-logo-icon.png'].includes(file)) {
      res.writeHead(200, { ...staticHeaders, 'Content-Type': file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, file)));
    }
    res.writeHead(404, staticHeaders);
    res.end('Not found');
  });
  server.storeFactory = storeFactory;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 8888;
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : null;
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const server = createServer({ factory: memoryStoreFactory(dataDir ? { dir: dataDir } : {}) });
  server.listen(port, '127.0.0.1', () => console.log(`Dev server: http://localhost:${port}/ (local test storage only)`));
}
