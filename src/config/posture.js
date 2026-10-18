/**
 * How hardened this process is (platform-18). Only 'development' and 'test' relax anything. Staging, preview and an unset
 * NODE_ENV get production posture: a hosted non-production deploy is still reachable and may hold real data.
 */
const RELAXED_ENVIRONMENTS = new Set(['development', 'test']);
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const nodeEnv = () => String(process.env.NODE_ENV || '').trim().toLowerCase();
const isRelaxedEnvironment = () => RELAXED_ENVIRONMENTS.has(nodeEnv());
const isHardenedEnvironment = () => !isRelaxedEnvironment();

/** One definition of the refresh-cookie flags; `clearing` drops maxAge for res.clearCookie. */
const refreshCookieOptions = ({ clearing = false } = {}) => {
  const hardened = isHardenedEnvironment();
  return {
    httpOnly: true,
    sameSite: hardened ? 'none' : 'lax',
    secure: hardened,
    path: '/api/auth',
    ...(clearing ? {} : { maxAge: REFRESH_COOKIE_MAX_AGE_MS }),
  };
};

module.exports = {
  REFRESH_COOKIE_MAX_AGE_MS,
  nodeEnv,
  isRelaxedEnvironment,
  isHardenedEnvironment,
  refreshCookieOptions,
};
