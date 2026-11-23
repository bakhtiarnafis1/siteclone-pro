// ============================================================================
// SiteClone — shared API + session helpers (used by every page)
// ============================================================================
(function () {
  const TOKEN_KEY = 'sc_token';
  const USER_KEY = 'sc_user';

  function apiBase() {
    const configured = (window.SITECLONE_CONFIG?.BACKEND_URL || '').trim().replace(/\/+$/, '');
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

  const session = {
    token: () => safeGet(TOKEN_KEY),
    user: () => {
      try {
        return JSON.parse(safeGet(USER_KEY) || 'null');
      } catch {
        return null;
      }
    },
    save(token, user) {
      if (token) safeSet(TOKEN_KEY, token);
      if (user) safeSet(USER_KEY, JSON.stringify(user));
    },
    clear() {
      safeSet(TOKEN_KEY, null);
      safeSet(USER_KEY, null);
    },
    isLoggedIn: () => Boolean(safeGet(TOKEN_KEY)),
  };

  function loginUrl(next) {
    const n = next || `${location.pathname}${location.search}${location.hash}`;
    return `/login?next=${encodeURIComponent(n)}`;
  }

  // fetch wrapper: JSON in/out, adds the session token, sends signed-out users to the login page
  async function api(path, { method = 'GET', body, auth = true, redirectOn401 = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = session.token();
    if (auth && token) headers.Authorization = `Bearer ${token}`;
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
      session.clear();
      location.href = loginUrl();
      throw new Error('Please log in again.');
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

  window.SC = { api, apiUrl, apiBase, session, loginUrl, escapeHtml, formatBytes };
})();
