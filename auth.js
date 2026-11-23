/**
 * Accounts & sign-in.
 * - Passwords: scrypt with a random salt per user (never stored in plain text).
 * - Sessions: stateless signed tokens (HMAC-SHA256), sent as "Authorization: Bearer <token>".
 *   Changing the password bumps `tokenVersion`, which signs out every other device.
 * - Short-lived "file" tokens let <a href> downloads / previews work without exposing the session token.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FILE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Demo admin account (created on every boot if missing).
// Only the scrypt HASH of the password is in the code, so the public repository does not reveal it.
// Override with ADMIN_EMAIL / ADMIN_PASSWORD environment variables.
// ---------------------------------------------------------------------------
const SEED_ADMIN_EMAIL = 'admin@siteclone.app';
const SEED_ADMIN_NAME = 'Admin';
const SEED_ADMIN_PASSWORD_HASH = 'scrypt$592a3662057832ded8a31b1cb570901d$f3cbc18f5d7654ade998f667e38e5ad73362f0696e75106257a28a9f04fe3185007c02a68a41a7190b718c4ec3eedb4158ade163d767ce5b2a33be1271a2ab68';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(input) {
  return Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function createAuth({ store, storageDir }) {
  // Signing secret: AUTH_SECRET env, else a random one persisted next to the database
  let secret = process.env.AUTH_SECRET;
  if (!secret) {
    const secretFile = path.join(storageDir, 'db', 'auth-secret.key');
    try {
      secret = fs.readFileSync(secretFile, 'utf8').trim();
    } catch {}
    if (!secret) {
      secret = crypto.randomBytes(48).toString('hex');
      try {
        fs.mkdirSync(path.dirname(secretFile), { recursive: true });
        fs.writeFileSync(secretFile, secret, { mode: 0o600 });
      } catch {}
    }
  }

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

  function sessionTokenFor(user) {
    return sign({ t: 'session', uid: user.id, v: user.tokenVersion || 0, exp: Date.now() + SESSION_TTL_MS });
  }

  // Scoped token for one file (ZIP download / preview) of one user
  function fileTokenFor(user, scope, resourceId) {
    return sign({ t: 'file', uid: user.id, s: scope, r: resourceId, exp: Date.now() + FILE_TOKEN_TTL_MS });
  }

  function userFromSessionToken(token) {
    const p = verify(token);
    if (!p || p.t !== 'session') return null;
    const user = store.users.find((u) => u.id === p.uid);
    if (!user || user.disabled || (user.tokenVersion || 0) !== p.v) return null;
    return user;
  }

  function userFromFileToken(token, scope, resourceId) {
    const p = verify(token);
    if (!p || p.t !== 'file' || p.s !== scope || p.r !== resourceId) return null;
    const user = store.users.find((u) => u.id === p.uid);
    if (!user || user.disabled) return null;
    return user;
  }

  function bearerFrom(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    return null;
  }

  // Express middleware
  function requireAuth(req, res, next) {
    const user = userFromSessionToken(bearerFrom(req) || req.query.token);
    if (!user) return res.status(401).json({ success: false, error: 'Please log in to continue.', code: 'AUTH_REQUIRED' });
    req.user = user;
    next();
  }

  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Admins only.' });
      next();
    });
  }

  function createUser({ email, name, password, role = 'user', passwordHash }) {
    const now = new Date().toISOString();
    return store.users.insert({
      id: crypto.randomUUID(),
      email: String(email).trim().toLowerCase(),
      name: String(name || '').trim().slice(0, 80) || String(email).split('@')[0],
      passwordHash: passwordHash || hashPassword(password),
      role,
      monthlyLimit: role === 'admin' ? null : defaultMonthlyLimit(),
      usage: { periodStart: now, used: 0 },
      disabled: false,
      tokenVersion: 0,
      createdAt: now,
      lastLoginAt: null,
    });
  }

  function ensureSeedAdmin() {
    const email = (process.env.ADMIN_EMAIL || SEED_ADMIN_EMAIL).trim().toLowerCase();
    const existing = store.users.find((u) => u.email === email);
    const envPassword = process.env.ADMIN_PASSWORD;
    if (!existing) {
      createUser({
        email,
        name: SEED_ADMIN_NAME,
        role: 'admin',
        ...(envPassword ? { password: envPassword } : { passwordHash: SEED_ADMIN_PASSWORD_HASH }),
      });
      console.log(`[auth] Admin account ready: ${email}`);
    } else if (existing.role !== 'admin') {
      store.users.update(existing.id, { role: 'admin', monthlyLimit: null });
    }
  }

  return {
    hashPassword,
    verifyPassword,
    sessionTokenFor,
    fileTokenFor,
    userFromSessionToken,
    userFromFileToken,
    requireAuth,
    requireAdmin,
    createUser,
    ensureSeedAdmin,
  };
}

function defaultMonthlyLimit() {
  const v = parseInt(process.env.DEFAULT_MONTHLY_DOWNLOADS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

module.exports = { createAuth, hashPassword, verifyPassword, defaultMonthlyLimit };
