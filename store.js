/**
 * Data store backed by Supabase Postgres (tables: profiles, downloads, library_items).
 *
 * The server reads from an in-memory copy (fast, synchronous — the same API the rest of the code
 * already uses) and writes every change through to Supabase in small batches:
 *   - insert/update/remove/save() schedule a flush within ~0.4 s
 *   - a background flush every 4 s also persists in-place changes (live download progress)
 * Only rows whose content actually changed are sent.
 *
 * Users are created by Supabase Auth; a database trigger adds their `profiles` row. Profiles the
 * cache hasn't seen yet are loaded on demand (users.fetch) or by users.reload().
 */
const { db } = require('./supabase');

const FLUSH_DELAY_MS = 400;
const FLUSH_INTERVAL_MS = 4000;

// ---------------------------------------------------------------------------- row <-> document mapping
const USER_MAP = {
  toRow: (u) => ({
    id: u.id,
    email: u.email,
    name: u.name || '',
    role: u.role === 'admin' ? 'admin' : 'user',
    monthly_limit: u.monthlyLimit ?? null,
    usage_period_start: u.usage?.periodStart || u.createdAt || new Date().toISOString(),
    usage_used: u.usage?.used || 0,
    disabled: Boolean(u.disabled),
    plan_name: u.planName || 'Free',
    created_at: u.createdAt,
    last_login_at: u.lastLoginAt || null,
    max_pages_limit: u.maxPagesLimit ?? null,
    allowed_modes: Array.isArray(u.allowedModes) && u.allowedModes.length ? u.allowedModes : null,
    max_active_jobs: u.maxActiveJobs ?? null,
    notes: u.notes || null,
    approval_status: u.approvalStatus || 'approved',
    reviewed_at: u.reviewedAt || null,
    review_note: u.reviewNote || null,
    signup_ip: u.signupIp || null,
    signup_user_agent: u.signupUserAgent || null,
  }),
  fromRow: (r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    monthlyLimit: r.monthly_limit,
    usage: { periodStart: r.usage_period_start, used: r.usage_used || 0 },
    disabled: Boolean(r.disabled),
    planName: r.plan_name,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    maxPagesLimit: r.max_pages_limit ?? null,
    allowedModes: r.allowed_modes || null,
    maxActiveJobs: r.max_active_jobs ?? null,
    notes: r.notes || '',
    approvalStatus: r.approval_status || 'approved',
    reviewedAt: r.reviewed_at || null,
    reviewNote: r.review_note || '',
    signupIp: r.signup_ip || null,
    signupUserAgent: r.signup_user_agent || null,
  }),
};

const DOWNLOAD_COLUMNS = [
  'id', 'user_id', 'url', 'domain', 'mode', 'max_pages', 'status', 'pages', 'pages_found', 'assets',
  'zip_size_bytes', 'zip_storage_path', 'error_code', 'error_message', 'login_method',
  'authorized_confirmed_at', 'authorized_ip', 'stop_requested_at', 'stopped_early', 'counted',
  'queue_position', 'progress', 'options', 'library_id', 'created_at', 'finished_at',
];
const LIBRARY_COLUMNS = [
  'id', 'title', 'url', 'domain', 'pages', 'zip_size_bytes', 'source_download_id', 'storage_path', 'created_by', 'created_at',
];
const pick = (cols) => ({
  toRow: (d) => {
    const row = {};
    for (const c of cols) row[c] = d[c] === undefined ? null : d[c];
    if ('stopped_early' in row) row.stopped_early = Boolean(row.stopped_early);
    if ('counted' in row) row.counted = Boolean(row.counted);
    if ('options' in row && !row.options) row.options = {};
    return row;
  },
  fromRow: (r) => ({ ...r }),
});

// ---------------------------------------------------------------------------- collection
function createCollection(table, mapper, scheduleFlush) {
  let docs = [];
  const snapshots = new Map(); // id -> JSON of the row last known to be in the database
  const pendingDeletes = new Set();

  const col = {
    table,
    all: () => docs,
    find: (pred) => docs.find(pred) || null,
    filter: (pred) => docs.filter(pred),
    insert(doc) {
      docs.unshift(doc);
      pendingDeletes.delete(doc.id);
      scheduleFlush();
      return doc;
    },
    update(id, patch) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) return null;
      Object.assign(doc, typeof patch === 'function' ? patch(doc) || {} : patch);
      scheduleFlush();
      return doc;
    },
    remove(id) {
      const idx = docs.findIndex((d) => d.id === id);
      if (idx === -1) return false;
      docs.splice(idx, 1);
      if (snapshots.has(id)) pendingDeletes.add(id);
      snapshots.delete(id);
      scheduleFlush();
      return true;
    },
    save: () => scheduleFlush(),

    /** Put a row that is already in the database into the cache (no write) */
    adopt(row) {
      const doc = mapper.fromRow(row);
      const existing = docs.find((d) => d.id === doc.id);
      if (existing) {
        // keep local unsaved edits; otherwise take the database version
        const dirty = snapshots.get(doc.id) !== JSON.stringify(mapper.toRow(existing));
        if (!dirty) Object.assign(existing, doc);
        snapshots.set(doc.id, JSON.stringify(mapper.toRow(existing)));
        return existing;
      }
      docs.push(doc);
      snapshots.set(doc.id, JSON.stringify(mapper.toRow(doc)));
      return doc;
    },
    setAll(rows) {
      docs = [];
      snapshots.clear();
      for (const r of rows) col.adopt(r);
    },

    /** Write changed rows / deletions to Supabase */
    async flush() {
      const changed = [];
      const nextSnaps = [];
      for (const d of docs) {
        const row = mapper.toRow(d);
        const json = JSON.stringify(row);
        if (snapshots.get(d.id) !== json) {
          changed.push(row);
          nextSnaps.push([d.id, json]);
        }
      }
      if (changed.length) {
        for (let i = 0; i < changed.length; i += 200) {
          await db.upsert(table, changed.slice(i, i + 200));
        }
        for (const [id, json] of nextSnaps) snapshots.set(id, json);
      }
      if (pendingDeletes.size) {
        const ids = [...pendingDeletes];
        await db.remove(table, `id=in.(${ids.join(',')})`);
        ids.forEach((id) => pendingDeletes.delete(id));
      }
      return changed.length;
    },
  };
  return col;
}

// ---------------------------------------------------------------------------- store
function createStore() {
  let flushTimer = null;
  let flushing = null;
  let again = false;

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushAll().catch(() => {});
    }, FLUSH_DELAY_MS);
  };

  const users = createCollection('profiles', USER_MAP, scheduleFlush);
  const downloads = createCollection('downloads', pick(DOWNLOAD_COLUMNS), scheduleFlush);
  const library = createCollection('library_items', pick(LIBRARY_COLUMNS), scheduleFlush);

  async function flushAll() {
    if (flushing) {
      again = true;
      return flushing;
    }
    flushing = (async () => {
      // parents before children (foreign keys)
      for (const c of [users, downloads, library]) {
        try {
          await c.flush();
        } catch (err) {
          console.error(`[store] could not save ${c.table}:`, err.message);
        }
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
      if (again) {
        again = false;
        scheduleFlush();
      }
    }
  }

  const interval = setInterval(() => flushAll().catch(() => {}), FLUSH_INTERVAL_MS);
  interval.unref();

  async function init() {
    const [p, d, l] = await Promise.all([
      db.select('profiles', 'select=*&order=created_at.desc&limit=10000'),
      db.select('downloads', 'select=*&order=created_at.desc&limit=5000'),
      db.select('library_items', 'select=*&order=created_at.desc&limit=5000'),
    ]);
    await loadSettings().catch((err) => console.error('[store] settings:', err.message));
    users.setAll(p);
    downloads.setAll(d);
    library.setAll(l);
    console.log(`[store] Supabase loaded: ${p.length} users, ${d.length} downloads, ${l.length} library items`);
  }

  /** Load one profile from the database (e.g. someone who just signed up) */
  users.fetch = async (id) => {
    const rows = await db.select('profiles', `select=*&id=eq.${encodeURIComponent(id)}`);
    return rows[0] ? users.adopt(rows[0]) : null;
  };
  /** Refresh every profile (admin user list) */
  users.reload = async () => {
    const rows = await db.select('profiles', 'select=*&order=created_at.desc&limit=10000');
    const ids = new Set(rows.map((r) => r.id));
    for (const r of rows) users.adopt(r);
    // profiles deleted directly in Supabase disappear here too
    for (const u of [...users.all()]) if (!ids.has(u.id)) users.all().splice(users.all().indexOf(u), 1);
    users.all().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  };

  // ---- site-wide settings (app_settings table)
  const settings = { default_monthly_limit: 10, registration_open: true, require_approval: true };
  async function loadSettings() {
    const rows = await db.select('app_settings', 'select=key,value');
    for (const r of rows) settings[r.key] = r.value;
  }
  async function saveSetting(key, value) {
    await db.upsert('app_settings', [{ key, value, updated_at: new Date().toISOString() }]);
    settings[key] = value;
  }

  async function logAdminEvent(adminId, targetUserId, action, details = {}) {
    try {
      await db.insert('admin_events', { admin_id: adminId, target_user_id: targetUserId || null, action, details });
    } catch (err) {
      console.error('[store] admin event:', err.message);
    }
  }

  // Best effort: persist on shutdown (Render sends SIGTERM before a restart)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, async () => {
      const t = setTimeout(() => process.exit(0), 4000);
      await flushAll().catch(() => {});
      clearTimeout(t);
      process.exit(0);
    });
  }

  return { init, users, downloads, library, flushAll, logAdminEvent, settings, saveSetting };
}

module.exports = { createStore };
