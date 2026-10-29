'use strict';
// Test helpers. All credentials and links here are synthetic.

const { memoryStoreFactory } = require('../scripts/lib/memory-store');
const { setStoreFactoryForTests } = require('../netlify/lib/storage');

const handlers = {
  login: require('../netlify/functions/check-password').handler,
  session: require('../netlify/functions/session').handler,
  getLinks: require('../netlify/functions/get-links').handler,
  manage: require('../netlify/functions/manage-links').handler,
};

const TEST_ENV = Object.freeze({
  SESSION_SECRET: 'synthetic-test-signing-secret-0123456789abcdef',
  PASSWORD_MARKETING: 'synthetic-mk-member',
  PASSWORD_CUSTOMERSERVICE: 'synthetic-cs-member',
  PASSWORD_SEO: 'synthetic-seo-member',
  PASSWORD_DESIGN: 'synthetic-design-member',
  PASSWORD_VIDEO: 'synthetic-video-member',
  PASSWORD_ADMIN: 'synthetic-global-admin',
  PASSWORD_ADMIN_MARKETING: 'synthetic-mk-admin',
  PASSWORD_ADMIN_CUSTOMERSERVICE: 'synthetic-cs-admin',
  PASSWORD_ADMIN_SEO: 'synthetic-seo-admin',
  PASSWORD_ADMIN_DESIGN: 'synthetic-design-admin',
  PASSWORD_ADMIN_VIDEO: 'synthetic-video-admin',
});

const MANAGED_VARS = [
  ...Object.keys(TEST_ENV),
  'SESSION_NOT_BEFORE', 'MAINTENANCE_MODE', 'BLOBS_ACCESS', 'SITE_ID', 'NETLIFY_API_TOKEN', 'LINK_ALLOWED_HOSTS', 'APP_ORIGINS',
];

function resetEnv(overrides = {}) {
  for (const k of MANAGED_VARS) delete process.env[k];
  Object.assign(process.env, TEST_ENV);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function freshStores(options) {
  const factory = memoryStoreFactory(options);
  setStoreFactoryForTests(factory);
  return factory;
}

const HOST = 'onboarding.test';

function event({ method = 'GET', query, body, cookie, ip = '203.0.113.10', csrf = true, headers = {}, rawBody } = {}) {
  const h = { host: HOST, 'x-nf-client-connection-ip': ip };
  if (body !== undefined || rawBody !== undefined) {
    h['content-type'] = 'application/json';
    h.origin = `https://${HOST}`;
    h['sec-fetch-site'] = 'same-origin';
    if (csrf) h['x-sb-onboarding'] = '1';
  }
  if (cookie) h.cookie = cookie;
  Object.assign(h, headers);
  for (const [k, v] of Object.entries(h)) if (v === undefined) delete h[k];
  return {
    httpMethod: method,
    headers: h,
    queryStringParameters: query || {},
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : null,
    isBase64Encoded: false,
  };
}

function setCookieOf(res) {
  const list = (res.multiValueHeaders && res.multiValueHeaders['Set-Cookie']) || [];
  return list[0] || null;
}

function cookiePair(setCookie) {
  return setCookie ? setCookie.split(';')[0] : null;
}

const body = res => JSON.parse(res.body);

// A browser-like client that keeps the session cookie.
class Client {
  constructor(ip = '203.0.113.10') { this.cookie = null; this.ip = ip; }
  absorb(res) {
    const sc = setCookieOf(res);
    if (sc) {
      const pair = cookiePair(sc);
      this.cookie = /Max-Age=0/.test(sc) ? null : pair;
    }
    return res;
  }
  async login(team, password, extra = {}) {
    return this.absorb(await handlers.login(event({ method: 'POST', body: { team, password, ...extra }, cookie: this.cookie, ip: this.ip })));
  }
  async adminLogin(teamName, password) {
    return this.login('admin', password, { teamName });
  }
  async globalLogin(password) {
    return this.login('admin', password, { scope: 'global' });
  }
  async get(team, type) {
    return handlers.getLinks(event({ query: { team, type }, cookie: this.cookie, ip: this.ip }));
  }
  async manage(payload) {
    return this.absorb(await handlers.manage(event({ method: 'POST', body: payload, cookie: this.cookie, ip: this.ip })));
  }
  async sessionInfo() {
    return body(await handlers.session(event({ cookie: this.cookie, ip: this.ip })));
  }
  async sessionAction(action) {
    return this.absorb(await handlers.session(event({ method: 'POST', body: { action }, cookie: this.cookie, ip: this.ip })));
  }
}

async function withNow(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}

function captureConsole() {
  const lines = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

module.exports = { handlers, TEST_ENV, resetEnv, freshStores, event, setCookieOf, cookiePair, body, Client, withNow, captureConsole, HOST };
