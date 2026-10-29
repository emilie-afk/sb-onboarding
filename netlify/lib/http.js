'use strict';
// HTTP helpers shared by all functions: private JSON responses, bounded body
// parsing, CSRF checks, cookie parsing and client address lookup.

const MAX_BODY_BYTES = 32 * 1024;
const CSRF_HEADER = 'x-sb-onboarding';

const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
});

function json(statusCode, body, extra = {}) {
  const { cookies, headers } = extra;
  const res = {
    statusCode,
    headers: { ...BASE_HEADERS, ...(headers || {}) },
    body: JSON.stringify(body),
  };
  if (cookies && cookies.length) res.multiValueHeaders = { 'Set-Cookie': cookies };
  return res;
}

function lowerHeaders(event) {
  const out = {};
  for (const [k, v] of Object.entries((event && event.headers) || {})) out[k.toLowerCase()] = v;
  return out;
}

class HttpError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Parses a JSON object body; rejects oversized, non-JSON or non-object bodies.
function readJsonBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_body');
  return parsed;
}

// CSRF protection for cookie-authenticated writes (and login/logout):
//  * a custom header that cross-site forms cannot send and cross-site fetch
//    cannot send without a CORS preflight (which these functions never approve);
//  * a JSON content type;
//  * when the browser reports it, a same-origin Origin / Sec-Fetch-Site.
// The session cookie is also SameSite=Strict.
function checkCsrf(event, env = process.env) {
  const h = lowerHeaders(event);
  if (h[CSRF_HEADER] !== '1') return false;
  const ct = String(h['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) return false;
  const site = h['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = h.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return false; }
    const allowed = String(env.APP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length) {
      if (!allowed.includes(o.origin)) return false;
    } else {
      const host = h['x-forwarded-host'] || h.host;
      if (!host || o.host !== host) return false;
    }
  }
  return true;
}

function parseCookies(event) {
  const h = lowerHeaders(event);
  const out = {};
  const header = h.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

// Netlify sets x-nf-client-connection-ip itself; it is not client-controlled.
function clientAddress(event) {
  const h = lowerHeaders(event);
  return String(h['x-nf-client-connection-ip'] || h['client-ip'] || 'unknown').slice(0, 64);
}

function errorResponse(err, context) {
  if (err instanceof HttpError) return json(err.statusCode, { success: false, error: err.code });
  if (err && err.name === 'MaintenanceError') return json(503, { success: false, error: 'maintenance' }, { headers: { 'Retry-After': '600' } });
  if (err && err.name === 'ConfigError') {
    // Never include values; the name of the problem is enough for the logs.
    console.error(`${context}: configuration error: ${err.message}`);
    return json(503, { success: false, error: 'not_configured' });
  }
  console.error(`${context}: ${err && err.name ? err.name : 'Error'}: ${err && err.message ? String(err.message).slice(0, 200) : ''}`);
  return json(500, { success: false, error: 'server_error' });
}

module.exports = {
  MAX_BODY_BYTES,
  CSRF_HEADER,
  HttpError,
  json,
  lowerHeaders,
  readJsonBody,
  checkCsrf,
  parseCookies,
  clientAddress,
  errorResponse,
};
