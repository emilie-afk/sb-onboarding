'use strict';
// Durable security state in the `onboarding-security` Blobs store:
//   revoked/<sid>          – sessions ended by logout / admin lock (kept until expiry)
//   rl/<scope>/<addrHash>  – failed login attempts per client address and scope
//   rl/<scope>/_all        – failed login attempts per scope from all addresses
// Nothing here relies on function process memory. If the store cannot be read or
// updated, callers fail closed (login refused, session treated as invalid).

const crypto = require('crypto');
const { SECURITY_STORE } = require('./config');
const { openStore, readVersioned, writeIfVersion } = require('./storage');

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_ADDRESS = 10;
const MAX_FAILURES_PER_SCOPE = 50;
const MAX_WRITE_ATTEMPTS = 4;

const now = () => Math.floor(Date.now() / 1000);

class SecurityStore {
  constructor(event, env = process.env) {
    this.store = openStore(SECURITY_STORE, event, env);
    this.env = env;
  }

  // ── Revocation ──
  async isRevoked(sid) {
    const data = await this.store.get(`revoked/${sid}`, { type: 'json' });
    return !!data;
  }

  async revoke(sid, exp) {
    await this.store.setJSON(`revoked/${sid}`, { exp: Number(exp) || now() + 86400 });
  }

  // ── Login attempt limits ──
  addressKey(scope, address, secret) {
    const h = crypto.createHmac('sha256', secret).update('sbonb-addr\0' + address).digest('base64url').slice(0, 32);
    return `rl/${scope}/${h}`;
  }

  async recentFailures(key) {
    const { data } = await readVersioned(this.store, key);
    const t = now();
    const list = data && Array.isArray(data.f) ? data.f.filter(x => Number.isInteger(x) && x > t - WINDOW_SECONDS) : [];
    return list;
  }

  // Returns seconds to wait if the scope/address is currently limited, else 0.
  async retryAfter(scope, address, secret) {
    const [mine, all] = await Promise.all([
      this.recentFailures(this.addressKey(scope, address, secret)),
      this.recentFailures(`rl/${scope}/_all`),
    ]);
    const t = now();
    const wait = (list, max) => (list.length >= max ? Math.max(1, list[list.length - max] + WINDOW_SECONDS - t) : 0);
    return Math.max(wait(mine, MAX_FAILURES_PER_ADDRESS), wait(all, MAX_FAILURES_PER_SCOPE));
  }

  async appendFailure(key, cap) {
    for (let i = 0; i < MAX_WRITE_ATTEMPTS; i++) {
      const { data, version } = await readVersioned(this.store, key);
      const t = now();
      const list = data && Array.isArray(data.f) ? data.f.filter(x => Number.isInteger(x) && x > t - WINDOW_SECONDS) : [];
      list.push(t);
      const res = await writeIfVersion(this.store, key, { f: list.slice(-cap) }, version);
      if (res.ok) return;
    }
    throw new Error('could not record failed login');
  }

  async recordFailure(scope, address, secret) {
    await this.appendFailure(this.addressKey(scope, address, secret), MAX_FAILURES_PER_ADDRESS * 2);
    await this.appendFailure(`rl/${scope}/_all`, MAX_FAILURES_PER_SCOPE * 2);
  }

  // A successful login clears this address's failures for that scope only.
  async clearAddress(scope, address, secret) {
    await this.store.delete(this.addressKey(scope, address, secret));
  }
}

module.exports = {
  SecurityStore,
  WINDOW_SECONDS,
  MAX_FAILURES_PER_ADDRESS,
  MAX_FAILURES_PER_SCOPE,
};
