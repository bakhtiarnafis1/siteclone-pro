// ============================================================================
// SiteClone — shared API + session helpers (used by every page)
// Sign-in is handled by Supabase Auth (supabase-js, loaded before this file on
// pages that need it). The access token is refreshed automatically and sent to
// our backend as "Authorization: Bearer …".
// ============================================================================
(function () {
  const AUTH_KEY = 'sc_auth'; // where supabase-js keeps the session
  const USER_KEY = 'sc_user'; // cached profile for instant sidebar rendering
  const cfg = window.SITECLONE_CONFIG || {};

  function apiBase() {
    const configured = (cfg.BACKEND_URL || '').trim().replace(/\/+$/, '');
    const h = window.location.hostname;
    if (!configured || h === 'localhost' || h === '127.0.0.1') return '';
    return configured;
  }

  function apiUrl(p) {
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return `${apiBase()}${p.startsWith('/') ? p : `/${p}`}`;
  }

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function safeSet(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  }

  // ---- Supabase client (created on first use)
  let client = null;
  function sb() {
    if (client) return client;
    if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return null;
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return client;
  }

  const friendlyAuthError = (err) => {
    const m = String(err?.message || err || '');
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/banned|disabled/i.test(m)) return 'This account has been disabled. Contact support.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a few minutes and try again.';
    if (/fetch|network/i.test(m)) return 'Could not reach the sign-in service. Check your connection and try again.';
    return m || 'Something went wrong. Please try again.';
  };

  const session = {
    /** fast, synchronous check (used before the page renders) */
    isLoggedIn: () => Boolean(safeGet(AUTH_KEY)),
    user: () => {
      try {
        return JSON.parse(safeGet(USER_KEY) || 'null');
      } catch {
        return null;
      }
    },
    saveUser(user) {
      if (user) safeSet(USER_KEY, JSON.stringify(user));
    },
    /** current access token (refreshed by supabase-js when needed) */
    async token() {
      const c = sb();
      if (!c) return null;
      const { data } = await c.auth.getSession();
      return data?.session?.access_token || null;
    },
    async signIn(email, password) {
      const c = sb();
      if (!c) throw new Error('Sign-in is not available right now. Please reload the page.');
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw new Error(friendlyAuthError(error));
      return data.session;
    },
    async setTokens(access_token, refresh_token) {
      const c = sb();
      if (c && access_token && refresh_token) await c.auth.setSession({ access_token, refresh_token });
    },
    async signOut() {
      const c = sb();
      try {
        if (c) await c.auth.signOut({ scope: 'local' });
      } catch {}
      safeSet(AUTH_KEY, null);
      safeSet(USER_KEY, null);
    },
    clear() {
      safeSet(AUTH_KEY, null);
      safeSet(USER_KEY, null);
    },
  };

  function loginUrl(next) {
    const n = next || `${location.pathname}${location.search}${location.hash}`;
    return `/login?next=${encodeURIComponent(n)}`;
  }

  // fetch wrapper: JSON in/out, adds the access token, sends signed-out users to the login page
  async function api(path, { method = 'GET', body, auth = true, redirectOn401 = true, noApprovalRedirect = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const token = await session.token().catch(() => null);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetch(apiUrl(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      const err = new Error('Could not reach the server. It may be waking up — please try again in a minute.');
      err.network = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && auth && redirectOn401) {
      await session.signOut();
      location.href = loginUrl();
      throw new Error('Please log in again.');
    }
    if (res.status === 403 && (data.code === 'ACCOUNT_PENDING' || data.code === 'ACCOUNT_REJECTED') && !noApprovalRedirect) {
      location.href = '/pending';
      throw new Error(data.error || 'Waiting for approval.');
    }
    if (!res.ok || data.success === false) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      err.code = data.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  const escapeHtml = (s = '') =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function formatBytes(b) {
    if (!b) return '';
    if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
  }

  window.SC = { api, apiUrl, apiBase, session, sb, loginUrl, escapeHtml, formatBytes, friendlyAuthError };
})();
