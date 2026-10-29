'use strict';
// Shared configuration for the onboarding functions.
// Supported teams and content types come from the existing site (index.html TEAMS
// object and tab list). Adding a team means adding it here, in index.html and in
// the Netlify environment variables (PASSWORD_<TEAM>, PASSWORD_ADMIN_<TEAM>).

const TEAMS = Object.freeze(['marketing', 'customerservice', 'seo', 'design', 'video']);

// Per-team content stored as `${team}_${type}` in the `team-links` Blobs store.
const TEAM_TYPES = Object.freeze(['tasks', 'eos', 'kpi', 'handover', 'tools']);

// Shared content stored as `global_${type}`.
//   goals    – year-keyed revenue goals (existing key `global_goals`)
//   handbook – flat list of handbook links (moved out of index.html)
const GLOBAL_TYPES = Object.freeze(['goals', 'handbook']);

const LINK_STORE = 'team-links';
const SECURITY_STORE = 'onboarding-security';

// Session lifetimes (seconds).
const MEMBER_TTL = 12 * 60 * 60; // team member access
const ADMIN_TTL = 2 * 60 * 60;   // team admin / global admin access

const MIN_SECRET_LENGTH = 32;

class MaintenanceError extends Error {
  constructor() {
    super('maintenance mode');
    this.name = 'MaintenanceError';
  }
}

// MAINTENANCE_MODE=1 closes every function (503) without touching stored data.
// Use it instead of rolling back to a deploy whose get-links had no authentication.
function assertNotMaintenance(env = process.env) {
  if (env.MAINTENANCE_MODE === '1' || env.MAINTENANCE_MODE === 'true') throw new MaintenanceError();
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isTeam(value) {
  return typeof value === 'string' && TEAMS.includes(value);
}

function memberEnvName(team) {
  if (!isTeam(team)) throw new Error('unsupported team');
  return 'PASSWORD_' + team.toUpperCase();
}

function teamAdminEnvName(team) {
  if (!isTeam(team)) throw new Error('unsupported team');
  return 'PASSWORD_ADMIN_' + team.toUpperCase();
}

const GLOBAL_ADMIN_ENV = 'PASSWORD_ADMIN';

// Returns the session security configuration, or throws ConfigError so callers
// deny access when required configuration is missing or invalid.
function getSecurityConfig(env = process.env) {
  assertNotMaintenance(env);
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError('SESSION_SECRET missing or too short');
  }
  // A signing secret must not double as a password.
  const passwordVars = [GLOBAL_ADMIN_ENV, ...TEAMS.flatMap(t => [memberEnvName(t), teamAdminEnvName(t)])];
  if (passwordVars.some(name => env[name] && env[name] === secret)) {
    throw new ConfigError('SESSION_SECRET must differ from every password');
  }
  let notBefore = 0;
  if (env.SESSION_NOT_BEFORE !== undefined && env.SESSION_NOT_BEFORE !== '') {
    const ms = Date.parse(env.SESSION_NOT_BEFORE);
    // An unparsable value must not silently disable invalidation: deny everything.
    if (!Number.isFinite(ms)) throw new ConfigError('SESSION_NOT_BEFORE is not a valid date');
    notBefore = Math.floor(ms / 1000);
  }
  return { secret, notBefore };
}

module.exports = {
  TEAMS,
  TEAM_TYPES,
  GLOBAL_TYPES,
  LINK_STORE,
  SECURITY_STORE,
  MEMBER_TTL,
  ADMIN_TTL,
  GLOBAL_ADMIN_ENV,
  ConfigError,
  MaintenanceError,
  assertNotMaintenance,
  isTeam,
  memberEnvName,
  teamAdminEnvName,
  getSecurityConfig,
};
