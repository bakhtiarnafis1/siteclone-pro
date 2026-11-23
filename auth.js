/**
 * Accounts & sign-in — Supabase Auth.
 * - Browsers sign in with Supabase (email + password) and send the access token as
 *   "Authorization: Bearer <token>". The backend checks it with Supabase (cached ~60 s) and
 *   loads the user's `profiles` row (role, allowance, disabled flag).
 * - Short-lived "file" tokens (HMAC) let <a href> downloads / previews work without exposing the session.
 * - The demo admin (admin@siteclone.app) lives in Supabase Auth; its password is never in this repo.
 */
const crypto = require('crypto');
const sb = require('./supabase');

const FILE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_CACHE_MS = 60 * 1000;
const SEED_ADMIN_EMAIL = 'admin@siteclone.app';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(input) {
  return Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function createAuth({ store }) {
  // Stable signing secret for file links: AUTH_SECRET, else derived from the service key
  const secret =
    process.env.AUTH_SECRET ||
    crypto.createHash('sha256').update(`siteclone-file-links:${process.env.SUPABASE_SERVICE_ROLE_KEY || crypto.randomBytes(32).toString('hex')}`).digest('hex');

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
    return `${body}.${sig}`;
  }
  function verify(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
    const a = Buffer.from(sig || '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(fromB64url(body));
      if (!payload.exp || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function fileTokenFor(user, scope, resourceId) {
    return sign({ t: 'file', uid: user.id, s: scope, r: resourceId, exp: Date.now() + FILE_TOKEN_TTL_MS });
  }
  function userFromFileToken(token, scope, resourceId) {
    const p = verify(token);
    if (!p || p.t !== 'file' || p.s !== scope || p.r !== resourceId) return null;
    const user = store.users.find((u) => u.id === p.uid);
    if (!user || user.disabled) return null;
    return user;
  }

  // ---- Supabase access tokens (cached so every poll doesn't hit Supabase)
  const tokenCache = new Map(); // sha256(token) -> { uid, email, until }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.until < now) tokenCache.delete(k);
  }, 5 * 60 * 1000).unref();

  async function userFromAccessToken(token) {
    if (!token) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    let hit = tokenCache.get(key);
    if (!hit || hit.until < Date.now()) {
      const authUser = await sb.auth.getUser(token);
      if (!authUser || !authUser.id) {
        tokenCache.delete(key);
        return null;
      }
      hit = { uid: authUser.id, email: authUser.email, until: Date.now() + TOKEN_CACHE_MS };
      tokenCache.set(key, hit);
    }
    let user = store.users.find((u) => u.id === hit.uid);
    if (!user) user = await store.users.fetch(hit.uid); // e.g. just signed up
    if (!user || user.disabled) return null;
    return user;
  }
  const forgetUserTokens = (uid) => {
    for (const [k, v] of tokenCache) if (v.uid === uid) tokenCache.delete(k);
  };

  function bearerFrom(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  }

  // Express middleware
  function requireAuth(req, res, next) {
    userFromAccessToken(bearerFrom(req))
      .then((user) => {
        if (!user) return res.status(401).json({ success: false, error: 'Please log in to continue.', code: 'AUTH_REQUIRED' });
        req.user = user;
        req.accessToken = bearerFrom(req);
        next();
      })
      .catch((err) => {
        console.error('[auth]', err.message);
        res.status(503).json({ success: false, error: 'Sign-in service is not reachable right now. Please try again in a moment.' });
      });
  }
  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Admins only.' });
      next();
    });
  }

  /** Make sure the seeded admin account has the admin role (and create it if ADMIN_PASSWORD is set) */
  async function ensureSeedAdmin() {
    const email = (process.env.ADMIN_EMAIL || SEED_ADMIN_EMAIL).trim().toLowerCase();
    let admin = store.users.find((u) => u.email === email);
    if (!admin && process.env.ADMIN_PASSWORD) {
      try {
        const created = await sb.auth.admin.createUser({ email, password: process.env.ADMIN_PASSWORD, name: 'Admin' });
        admin = await store.users.fetch(created.id);
      } catch (err) {
        console.error('[auth] could not create the admin account:', err.message);
      }
    }
    if (admin && (admin.role !== 'admin' || admin.monthlyLimit !== null)) {
      store.users.update(admin.id, { role: 'admin', monthlyLimit: null, planName: 'Admin' });
    }
    if (admin) console.log(`[auth] Admin account ready: ${email}`);
  }

  return { fileTokenFor, userFromFileToken, userFromAccessToken, forgetUserTokens, requireAuth, requireAdmin, ensureSeedAdmin };
}

function defaultMonthlyLimit() {
  const v = parseInt(process.env.DEFAULT_MONTHLY_DOWNLOADS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

module.exports = { createAuth, defaultMonthlyLimit };
