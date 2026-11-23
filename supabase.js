/**
 * Minimal Supabase client for the backend (no extra dependencies — plain fetch).
 *   - db:      PostgREST (tables in supabase/schema.sql) with the service-role key
 *   - auth:    Supabase Auth (verify a user's access token, admin user management)
 *   - storage: private buckets for ZIP files (so they survive server restarts)
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Render → Environment, or a local .env file).
 * SUPABASE_ANON_KEY is optional on the server (only used for password checks).
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// Load a local .env (development) without adding a dependency
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
})();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const configured = Boolean(SUPABASE_URL && SERVICE_KEY);

class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(url, { method = 'GET', headers = {}, body, key = SERVICE_KEY, bearer, timeoutMs = 20000, raw = false } = {}) {
  if (!configured) throw new SupabaseError('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).', 500);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const init = {
    method,
    headers: { apikey: key, Authorization: `Bearer ${bearer || key}`, ...headers },
    signal: ctrl.signal,
  };
  if (body !== undefined) {
    if (body instanceof Readable) {
      init.body = Readable.toWeb(body);
      init.duplex = 'half';
    } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new SupabaseError(`Supabase request failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`, 0);
  } finally {
    clearTimeout(timer);
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new SupabaseError(String(msg), res.status, data);
  }
  return data;
}

// ---------------------------------------------------------------------------- database
const db = {
  /** select rows: db.select('downloads', 'select=*&order=created_at.desc&limit=1000') */
  async select(table, query = 'select=*') {
    return request(`${SUPABASE_URL}/rest/v1/${table}?${query}`);
  },
  /** insert or update rows by primary key */
  async upsert(table, rows) {
    if (!rows || (Array.isArray(rows) && rows.length === 0)) return [];
    return request(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: rows,
    });
  },
  async update(table, filter, patch) {
    return request(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: patch,
    });
  },
  async remove(table, filter) {
    return request(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  },
  async insert(table, rows) {
    return request(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: rows });
  },
  async rpc(fn, args = {}) {
    return request(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
  },
};

// ---------------------------------------------------------------------------- auth
const authApi = {
  /** The signed-in user behind an access token (null if invalid/expired/revoked) */
  async getUser(accessToken) {
    try {
      return await request(`${SUPABASE_URL}/auth/v1/user`, { key: ANON_KEY || SERVICE_KEY, bearer: accessToken, timeoutMs: 10000 });
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 400) return null;
      throw err;
    }
  },
  /** Email + password check; returns a session ({ access_token, refresh_token, user }) or null */
  async passwordGrant(email, password) {
    try {
      return await request(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        key: ANON_KEY || SERVICE_KEY,
        body: { email, password },
      });
    } catch (err) {
      if (err.status === 400 || err.status === 401) return null;
      throw err;
    }
  },
  admin: {
    createUser({ email, password, name }) {
      return request(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        body: { email, password, email_confirm: true, user_metadata: { name } },
      });
    },
    updateUser(id, attrs) {
      return request(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: 'PUT', body: attrs });
    },
    deleteUser(id) {
      return request(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: 'DELETE' });
    },
    async findByEmail(email) {
      // the admin API has no direct email lookup; profiles mirror auth.users
      const rows = await db.select('profiles', `select=id&email=eq.${encodeURIComponent(email)}`);
      return rows[0] || null;
    },
  },
  /** Sign the user out everywhere (deletes their sessions; open tabs are rejected within ~1 minute) */
  revokeSessions(userId) {
    return db.rpc('revoke_user_sessions', { uid: userId });
  },
};

// ---------------------------------------------------------------------------- storage
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');
const storage = {
  /** Stream a local file into a private bucket */
  async uploadFile(bucket, key, filePath, contentType = 'application/zip') {
    const size = fs.statSync(filePath).size;
    return request(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeKey(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': String(size), 'x-upsert': 'true' },
      body: fs.createReadStream(filePath),
      timeoutMs: 10 * 60 * 1000,
    });
  },
  async copy(bucket, fromKey, toKey) {
    return request(`${SUPABASE_URL}/storage/v1/object/copy`, {
      method: 'POST',
      body: { bucketId: bucket, sourceKey: fromKey, destinationKey: toKey },
    });
  },
  /** Time-limited download link; `downloadName` makes the browser save it under that name */
  async signedUrl(bucket, key, expiresIn = 3600, downloadName) {
    const data = await request(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeKey(key)}`, {
      method: 'POST',
      body: { expiresIn },
    });
    const rel = data.signedURL || data.signedUrl;
    const url = `${SUPABASE_URL}/storage/v1${rel.startsWith('/') ? rel : `/${rel}`}`;
    return downloadName ? `${url}&download=${encodeURIComponent(downloadName)}` : url;
  },
  async remove(bucket, keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (!list.length) return null;
    return request(`${SUPABASE_URL}/storage/v1/object/${bucket}`, { method: 'DELETE', body: { prefixes: list } });
  },
};

module.exports = { configured, SUPABASE_URL, db, auth: authApi, storage, SupabaseError };
