'use strict';
// Input validation for stored links and goals.

const LIMITS = Object.freeze({
  name: 300,
  url: 2048,
  goalYear: 30,
  goalValue: 100,
  goalLabel: 100,
  goalRows: 36,
  linksPerList: 500,
});

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

class ValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function allowedHostList(env = process.env) {
  return String(env.LINK_ALLOWED_HOSTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(host, list) {
  if (!list.length) return true;
  return list.some(entry => (entry.startsWith('.') ? host.endsWith(entry) : host === entry || host.endsWith('.' + entry)));
}

// Link destination policy:
//   * https:// only (rejects javascript:, data:, vbscript:, file:, http:, …)
//   * no embedded credentials, no non-default port
//   * a public DNS host name (no IP literals, localhost or internal suffixes)
//   * optionally restricted further by LINK_ALLOWED_HOSTS (comma-separated)
// The server never fetches these URLs.
function checkLinkUrl(raw, env = process.env) {
  if (typeof raw !== 'string') return { ok: false, reason: 'url_required' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'url_required' };
  if (s.length > LIMITS.url) return { ok: false, reason: 'url_too_long' };
  if (CONTROL_CHARS.test(s) || /\s/.test(s)) return { ok: false, reason: 'url_invalid' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: 'url_invalid' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'url_https_only' };
  if (u.username || u.password) return { ok: false, reason: 'url_credentials' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'url_port' };
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^[0-9.]+$/.test(host) || host === 'localhost' ||
      /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    return { ok: false, reason: 'url_host' };
  }
  if (!hostAllowed(host, allowedHostList(env))) return { ok: false, reason: 'url_host_not_allowed' };
  return { ok: true, url: u.toString() };
}

function cleanText(value, max, code) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(code);
  const s = value.trim();
  if (s.length > max || CONTROL_CHARS.test(s)) throw new ValidationError(code);
  return s;
}

function validateLinkInput(link, env = process.env) {
  if (!link || typeof link !== 'object' || Array.isArray(link)) throw new ValidationError('link_required');
  const urlCheck = checkLinkUrl(link.url, env);
  if (!urlCheck.ok) throw new ValidationError(urlCheck.reason);
  let name = cleanText(link.name, LIMITS.name, 'name_invalid');
  if (!name) name = urlCheck.url.slice(0, LIMITS.name);
  return { name, url: urlCheck.url };
}

function validateRecordId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('id_invalid');
  return id;
}

function validateKpiYear(year) {
  const s = typeof year === 'number' ? String(year) : year;
  if (typeof s !== 'string' || !/^\d{4}$/.test(s)) throw new ValidationError('year_invalid');
  const n = Number(s);
  if (n < 2000 || n > 2100) throw new ValidationError('year_invalid');
  return s;
}

// New goal year labels: "2026", "FY2026", "2026 H1", …
function validateGoalYearLabel(value) {
  const s = cleanText(value, LIMITS.goalYear, 'goal_year_invalid');
  if (!s || RESERVED_KEYS.has(s) || !/^[\p{L}\p{N}][\p{L}\p{N} _.\-/]*$/u.test(s)) throw new ValidationError('goal_year_invalid');
  return s;
}

function validateGoalRows(rows, labelField) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows) || rows.length > LIMITS.goalRows) throw new ValidationError('goal_rows_invalid');
  return rows.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ValidationError('goal_rows_invalid');
    if (labelField === 'month') {
      return { month: cleanText(r.month, LIMITS.goalLabel, 'goal_value_invalid'), goal: cleanText(r.goal, LIMITS.goalValue, 'goal_value_invalid') };
    }
    return {
      [labelField]: cleanText(r[labelField], LIMITS.goalLabel, 'goal_value_invalid'),
      yearGoal: cleanText(r.yearGoal, LIMITS.goalValue, 'goal_value_invalid'),
      quarterGoal: cleanText(r.quarterGoal, LIMITS.goalValue, 'goal_value_invalid'),
      monthlyGoal: cleanText(r.monthlyGoal, LIMITS.goalValue, 'goal_value_invalid'),
    };
  });
}

function validateGoalsEntry(body) {
  return {
    yearGoal: cleanText(body.yearGoal, LIMITS.goalValue, 'goal_value_invalid'),
    quarterGoal: cleanText(body.quarterGoal, LIMITS.goalValue, 'goal_value_invalid'),
    monthlyGoals: validateGoalRows(body.monthlyGoals, 'month'),
    brandGoals: validateGoalRows(body.brandGoals, 'brand'),
    channelGoals: validateGoalRows(body.channelGoals, 'channel'),
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

module.exports = {
  LIMITS,
  RESERVED_KEYS,
  ValidationError,
  checkLinkUrl,
  validateLinkInput,
  validateRecordId,
  validateKpiYear,
  validateGoalYearLabel,
  validateGoalsEntry,
  isPlainObject,
};
