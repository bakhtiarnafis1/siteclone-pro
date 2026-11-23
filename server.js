const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { runCloneJob, MAX_PAGES_LIMIT } = require('./cloner');
const sb = require('./supabase'); // loads .env locally
const r2 = require('./r2'); // Cloudflare R2 — where every ZIP is stored
const { createStore } = require('./store');
const { createAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Server tuning (environment variables; Dockerfile defaults suit Render Free 512 MB)
// ---------------------------------------------------------------------------
const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const MAX_CONCURRENT_JOBS = envInt('MAX_CONCURRENT_JOBS', 1); // Chromium jobs running at the same time
const MAX_JOBS_PER_USER = envInt('MAX_JOBS_PER_USER', envInt('MAX_JOBS_PER_IP', 2)); // running + queued per account
const MAX_QUEUE_LENGTH = envInt('MAX_QUEUE_LENGTH', 15); // waiting jobs before new requests are refused
// Don't start an additional parallel job while container memory use is above this % of its limit
const MEMORY_START_THRESHOLD_PCT = envInt('MEMORY_START_THRESHOLD_PCT', 55);
// Auto-delete download ZIPs older than this. OFF unless RETENTION_HOURS is set (Dockerfile sets it for Render).
const RETENTION_HOURS = envInt('RETENTION_HOURS', 0);
const PERIOD_DAYS = 30; // download allowance resets every 30 days
// Sign-ups: ALLOW_REGISTRATION=false closes them for good; otherwise the admin panel decides
const registrationOpen = () => process.env.ALLOW_REGISTRATION !== 'false' && store.settings.registration_open !== false;
const defaultMonthlyLimit = () => {
  const v = store.settings.default_monthly_limit;
  return v === null ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 10;
};
const ALL_MODES = ['single_page', 'full_website', 'cookie_export'];
const PAGE_OPTIONS = [10, 25, 50, 100, 200, 300].filter((n) => n <= MAX_PAGES_LIMIT);
if (!PAGE_OPTIONS.includes(MAX_PAGES_LIMIT)) PAGE_OPTIONS.push(MAX_PAGES_LIMIT);

// Behind Render/Caddy/Cloudflare, read the real visitor IP from X-Forwarded-For
if (process.env.TRUST_PROXY) app.set('trust proxy', true);

// Never let one bad clone crash the whole server
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// ---------------------------------------------------------------------------
// Storage, database & auth
// ---------------------------------------------------------------------------
const STORAGE_DIR = path.join(__dirname, 'storage');
const SITES_DIR = path.join(STORAGE_DIR, 'sites');
const ZIPS_DIR = path.join(STORAGE_DIR, 'zips');
const LIBRARY_DIR = path.join(STORAGE_DIR, 'library');
[STORAGE_DIR, SITES_DIR, ZIPS_DIR, LIBRARY_DIR].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

// Users, downloads & library live in Supabase (see supabase/schema.sql); ZIPs are copied to Supabase Storage
const ZIP_BUCKET = 'zips'; // Supabase Storage bucket (only used when R2 is not configured)
const STORAGE_MAX_BYTES = 50 * 1024 * 1024; // Supabase Free: 50 MB per file
// User ZIPs live in R2 for ZIP_RETENTION_HOURS (a bucket lifecycle rule deletes them); library ZIPs are kept
const ZIP_RETENTION_HOURS = envInt('ZIP_RETENTION_HOURS', 24);
const R2_PREFIX = 'r2:';
const isR2 = (p) => typeof p === 'string' && p.startsWith(R2_PREFIX);
const store = createStore();
const auth = createAuth({ store });
let dbReady = false;

async function bootDatabase() {
  if (!sb.configured) {
    console.error('[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — accounts and downloads are unavailable.');
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await store.init();
      break;
    } catch (err) {
      console.error(`[db] could not load data from Supabase (attempt ${attempt}):`, err.message);
      await new Promise((r) => setTimeout(r, Math.min(30000, attempt * 3000)));
    }
  }
  await auth.ensureSeedAdmin();
  // Downloads that were in progress when the server stopped can't be resumed
  for (const d of store.downloads.all()) {
    if (['queued', 'running', 'processing'].includes(d.status)) {
      Object.assign(d, {
        status: 'failed',
        error_code: 'SERVER_RESTART',
        error_message: 'The server restarted while this download was running. Please start it again — it was not counted.',
        finished_at: new Date().toISOString(),
        queue_position: null,
      });
      refundDownload(d);
    }
  }
  store.downloads.save();
  dbReady = true;
}

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: '5mb' }));
app.use('/api', (req, res, next) => {
  if (dbReady || req.path === '/health' || req.path === '/config') return next();
  res.status(503).json({ success: false, error: 'The server is starting up — please try again in a few seconds.', code: 'STARTING' });
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

// Simple in-memory rate limit for sign-in / sign-up (per IP)
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count++;
  rateBuckets.set(key, bucket);
  return bucket.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Users & allowance
// ---------------------------------------------------------------------------
function rollAllowancePeriod(user) {
  const start = new Date(user.usage?.periodStart || user.createdAt || Date.now()).getTime();
  if (Date.now() - start >= PERIOD_DAYS * 86400000) {
    store.users.update(user.id, { usage: { periodStart: new Date().toISOString(), used: 0 } });
  }
}

function allowanceFor(user) {
  rollAllowancePeriod(user);
  const used = user.usage?.used || 0;
  const limit = user.role === 'admin' ? null : user.monthlyLimit ?? null;
  const start = new Date(user.usage?.periodStart || user.createdAt).getTime();
  return {
    plan: user.role === 'admin' ? 'Admin' : user.planName || 'Free',
    unlimited: limit === null,
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: new Date(start + PERIOD_DAYS * 86400000).toISOString(),
  };
}

/** What this user may download (admins are never limited) */
function limitsFor(user) {
  const admin = user.role === 'admin';
  const maxPages = admin ? MAX_PAGES_LIMIT : Math.min(MAX_PAGES_LIMIT, user.maxPagesLimit || MAX_PAGES_LIMIT);
  const modes = admin || !Array.isArray(user.allowedModes) || !user.allowedModes.length ? ALL_MODES : user.allowedModes.filter((m) => ALL_MODES.includes(m));
  return {
    maxPages,
    pageOptions: PAGE_OPTIONS.filter((n) => n <= maxPages).concat(PAGE_OPTIONS.some((n) => n === maxPages) || admin ? [] : [maxPages]).sort((a, b) => a - b),
    modes,
    maxActiveJobs: admin ? null : user.maxActiveJobs || MAX_JOBS_PER_USER,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    disabled: Boolean(user.disabled),
    planName: user.role === 'admin' ? 'Admin' : user.planName || 'Free',
    limits: limitsFor(user),
  };
}

function refundDownload(download) {
  if (!download || !download.counted) return;
  const user = store.users.find((u) => u.id === download.user_id);
  if (user && user.usage) {
    store.users.update(user.id, { usage: { ...user.usage, used: Math.max(0, (user.usage.used || 0) - 1) } });
  }
  download.counted = false;
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  if (!registrationOpen()) return res.status(403).json({ success: false, error: 'Sign-ups are closed right now.' });
  if (!rateLimit(`reg:${ipOf(req)}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ success: false, error: 'Too many sign-ups from this network. Try again later.' });
  }
  const { name = '', email = '', password = '', agree } = req.body || {};
  if (!String(name).trim()) return res.status(400).json({ success: false, error: 'Please enter your name.' });
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
  if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Use at least 8 characters for your password.' });
  if (!agree) return res.status(400).json({ success: false, error: 'Please accept the Terms and Privacy Policy.' });
  const normalized = String(email).trim().toLowerCase();
  if (store.users.find((u) => u.email === normalized)) {
    return res.status(409).json({ success: false, error: 'An account with this email already exists. Log in instead.' });
  }
  try {
    // Created already confirmed (no email step); a database trigger adds the profile row
    const created = await sb.auth.admin.createUser({ email: normalized, password: String(password), name: String(name).trim().slice(0, 80) });
    const user = (await store.users.fetch(created.id)) || null;
    if (user && user.monthlyLimit !== defaultMonthlyLimit()) store.users.update(user.id, { monthlyLimit: defaultMonthlyLimit() });
    res.json({ success: true });
  } catch (err) {
    if (err.status === 422 || /already/i.test(err.message)) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists. Log in instead.' });
    }
    console.error('[register]', err.message);
    res.status(400).json({ success: false, error: err.message || 'Could not create the account.' });
  }
});

// Called by the browser right after it signs in with Supabase (records the login time)
app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  if (req.query.login === '1') store.users.update(req.user.id, { lastLoginAt: new Date().toISOString() });
  res.json({ success: true, user: publicUser(req.user), allowance: allowanceFor(req.user) });
});

app.patch('/api/me', auth.requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ success: false, error: 'Please enter your name.' });
  const user = store.users.update(req.user.id, { name });
  res.json({ success: true, user: publicUser(user) });
});

// Change password: checks the current one, signs out every other device, returns a fresh session
app.post('/api/me/password', auth.requireAuth, async (req, res) => {
  const { currentPassword = '', newPassword = '' } = req.body || {};
  if (String(newPassword).length < 8) return res.status(400).json({ success: false, error: 'Use at least 8 characters.' });
  if (!rateLimit(`pw:${req.user.id}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Please wait 15 minutes.' });
  }
  try {
    const check = await sb.auth.passwordGrant(req.user.email, String(currentPassword));
    if (!check) return res.status(400).json({ success: false, error: 'Your current password is not correct.' });
    await sb.auth.admin.updateUser(req.user.id, { password: String(newPassword) });
    await sb.auth.revokeSessions(req.user.id);
    auth.forgetUserTokens(req.user.id);
    const session = await sb.auth.passwordGrant(req.user.email, String(newPassword));
    res.json({ success: true, session: session ? { access_token: session.access_token, refresh_token: session.refresh_token } : null });
  } catch (err) {
    console.error('[password]', err.message);
    res.status(400).json({ success: false, error: err.message || 'Could not change the password.' });
  }
});

// ---------------------------------------------------------------------------
// Memory-aware FIFO job queue
// - At most MAX_CONCURRENT_JOBS clones run at once (Chromium is the RAM-hungry part).
// - A 2nd+ parallel job only starts while container memory is below MEMORY_START_THRESHOLD_PCT.
// - Waiting downloads are told their live position (#1, #2, …) every time the line moves.
// ---------------------------------------------------------------------------
let runningCount = 0;
const jobQueue = []; // [{ id, taskFn, onPosition, lastPos }]
const activeJobs = new Map(); // downloadId -> { control, logs }

function readNumberFile(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
// Reclaimable file cache (recently written ZIPs etc.) is subtracted, like `docker stats` does
function readInactiveFileBytes(statPath) {
  try {
    const m = fs.readFileSync(statPath, 'utf8').match(/^(?:total_)?inactive_file (\d+)$/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
function memoryUsagePct() {
  let used = readNumberFile('/sys/fs/cgroup/memory.current');
  let limit = readNumberFile('/sys/fs/cgroup/memory.max');
  let statPath = '/sys/fs/cgroup/memory.stat';
  if (used === null || limit === null) {
    used = readNumberFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    limit = readNumberFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    statPath = '/sys/fs/cgroup/memory/memory.stat';
  }
  if (used === null || limit === null || limit <= 0 || limit > 1e15) return null;
  const real = Math.max(0, used - readInactiveFileBytes(statPath));
  return Math.round((real / limit) * 100);
}

function canStartAnotherJob() {
  if (runningCount >= MAX_CONCURRENT_JOBS) return false;
  if (runningCount === 0) return true; // always let at least one job run
  const mem = memoryUsagePct();
  return mem === null || mem < MEMORY_START_THRESHOLD_PCT;
}

function notifyQueuePositions() {
  jobQueue.forEach((entry, idx) => {
    const pos = idx + 1;
    if (entry.lastPos !== pos) {
      entry.lastPos = pos;
      try {
        entry.onPosition?.(pos);
      } catch {}
    }
  });
}

function processQueue() {
  let started = false;
  while (jobQueue.length > 0 && canStartAnotherJob()) {
    const entry = jobQueue.shift();
    runningCount++;
    started = true;
    Promise.resolve()
      .then(entry.taskFn)
      .catch((err) => console.error('[clone task]', err))
      .finally(() => {
        runningCount--;
        processQueue();
      });
  }
  if (started) notifyQueuePositions();
}
setInterval(processQueue, 5000).unref();

function enqueueJob(id, taskFn, onPosition) {
  jobQueue.push({ id, taskFn, onPosition, lastPos: 0 });
  processQueue();
  notifyQueuePositions();
}

function removeFromQueue(id) {
  const idx = jobQueue.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  jobQueue.splice(idx, 1);
  notifyQueuePositions();
  return true;
}

// ---------------------------------------------------------------------------
// Website downloads
// ---------------------------------------------------------------------------
const MODES = {
  single_page: 'single',
  full_website: 'full',
  cookie_export: 'auth',
};

const ACTIVE = ['queued', 'running', 'processing'];
const isActive = (d) => ACTIVE.includes(d.status);
const zipPathOf = (id) => path.join(ZIPS_DIR, `${id}.zip`);
const siteDirOf = (id) => path.join(SITES_DIR, id);

function publicDownload(d) {
  const job = activeJobs.get(d.id);
  return {
    id: d.id,
    url: d.url,
    domain: d.domain,
    mode: d.mode,
    max_pages: d.max_pages,
    status: d.status,
    pages: d.pages ?? null,
    pages_found: d.pages_found ?? null,
    assets: d.assets ?? null,
    zip_size_bytes: d.zip_size_bytes ?? null,
    error_code: d.error_code || null,
    error_message: d.error_message || null,
    login_method: d.login_method || null,
    stop_requested_at: d.stop_requested_at || null,
    stopped_early: Boolean(d.stopped_early),
    created_at: d.created_at,
    finished_at: d.finished_at || null,
    queue_position: d.status === 'queued' ? d.queue_position || null : null,
    progress: d.progress || null,
    options: d.options || {},
    zip_available: d.status === 'completed' && (storedZipValid(d) || fs.existsSync(zipPathOf(d.id))),
    zip_expires_at:
      d.zip_storage_path && isR2(d.zip_storage_path) && d.finished_at
        ? new Date(new Date(d.finished_at).getTime() + ZIP_RETENTION_HOURS * 3600000).toISOString()
        : null,
    preview_available: d.status === 'completed' && fs.existsSync(path.join(siteDirOf(d.id), 'index.html')),
    library_id: d.library_id || null,
    logs: job ? job.logs.slice(-6) : [],
  };
}

function ownDownload(req, res) {
  const d = store.downloads.find((x) => x.id === req.params.id);
  if (!d || (d.user_id !== req.user.id && req.user.role !== 'admin')) {
    res.status(404).json({ success: false, error: 'Download not found.' });
    return null;
  }
  return d;
}

function cleanupFiles(id, { keepZip = false } = {}) {
  try {
    fs.rmSync(siteDirOf(id), { recursive: true, force: true });
  } catch {}
  if (!keepZip) {
    try {
      fs.rmSync(zipPathOf(id), { force: true });
    } catch {}
  }
}

// ---- ZIP storage: Cloudflare R2 (preferred) or Supabase Storage (fallback, up to 50 MB)
function storedZipValid(d) {
  if (!d.zip_storage_path) return false;
  if (!isR2(d.zip_storage_path) || !d.finished_at) return true;
  return Date.now() - new Date(d.finished_at).getTime() < ZIP_RETENTION_HOURS * 3600000; // R2 deletes it after this
}
async function storedLink(p, name, expiresIn = 3600) {
  if (isR2(p)) return r2.signedUrl(p.slice(R2_PREFIX.length), expiresIn, name);
  return sb.storage.signedUrl(ZIP_BUCKET, p, expiresIn, name);
}
function removeStored(p) {
  if (!p) return;
  if (isR2(p)) r2.remove(p.slice(R2_PREFIX.length)).catch(() => {});
  else sb.storage.remove(ZIP_BUCKET, p).catch(() => {});
}
function removeStoredZip(d) {
  if (d) removeStored(d.zip_storage_path);
}
/** Upload a finished ZIP. With R2 the local copy is deleted afterwards, so Render's disk stays empty. */
async function storeZip(rec, onProgress) {
  const zipPath = zipPathOf(rec.id);
  if (r2.configured) {
    const key = `zips/${rec.user_id}/${rec.id}.zip`;
    await r2.uploadFile(key, zipPath, 'application/zip', onProgress);
    try {
      fs.rmSync(zipPath, { force: true });
    } catch {}
    return R2_PREFIX + key;
  }
  if (sb.configured && fs.statSync(zipPath).size <= STORAGE_MAX_BYTES) {
    const key = `${rec.user_id}/${rec.id}.zip`;
    await sb.storage.uploadFile(ZIP_BUCKET, key, zipPath);
    return key;
  }
  return null; // stays on the server disk only
}
const zipNameOf = (d) => `${d.domain}-${(d.finished_at || d.created_at || '').slice(0, 10)}.zip`;

app.get('/api/website-downloads', auth.requireAuth, (req, res) => {
  const downloads = store.downloads.filter((d) => d.user_id === req.user.id).map(publicDownload);
  res.json({ success: true, downloads, allowance: allowanceFor(req.user) });
});

app.get('/api/website-downloads/:id', auth.requireAuth, (req, res) => {
  const d = ownDownload(req, res);
  if (!d) return;
  res.json({ success: true, download: publicDownload(d) });
});

app.post('/api/website-downloads', auth.requireAuth, (req, res) => {
  const user = req.user;
  const body = req.body || {};
  const mode = String(body.mode || 'single_page');
  if (!MODES[mode]) return res.status(400).json({ success: false, error: 'Choose what kind of website it is.', code: 'INVALID_INPUT' });
  if (!limitsFor(user).modes.includes(mode)) {
    return res.status(403).json({ success: false, error: 'This download type is not enabled on your account. Contact the admin.', code: 'MODE_NOT_ALLOWED' });
  }

  // URL
  let targetUrl;
  try {
    const raw = String(body.url || '').trim();
    if (!raw) throw new Error('empty');
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?)/i.test(u.hostname) || u.hostname.endsWith('.local')) {
      return res.status(400).json({ success: false, error: 'Private and local network addresses cannot be downloaded.', code: 'INVALID_INPUT' });
    }
    targetUrl = u.toString();
  } catch {
    return res.status(400).json({ success: false, error: 'Enter a valid website address, e.g. https://example.com', code: 'INVALID_INPUT' });
  }

  // Pages
  let maxPages = 1;
  if (mode !== 'single_page') {
    maxPages = parseInt(body.maxPages, 10) || 10;
    const lim = limitsFor(user);
    const allowedMax = lim.maxPages;
    if (user.role !== 'admin' && !lim.pageOptions.includes(maxPages)) {
      return res.status(400).json({ success: false, error: `Choose one of: ${lim.pageOptions.join(', ')} pages.`, code: 'INVALID_INPUT' });
    }
    if (maxPages < 1 || maxPages > allowedMax) {
      return res.status(400).json({ success: false, error: `Enter a number of pages from 1 to ${allowedMax}.`, code: 'INVALID_INPUT' });
    }
  }

  // Backend HTML UI (signed-in pages)
  let sessionCookies = '';
  let localStorageData = '';
  if (mode === 'cookie_export') {
    sessionCookies = String(body.sessionCookies || '').trim();
    localStorageData = String(body.localStorageData || '').trim();
    if (!sessionCookies) return res.status(400).json({ success: false, error: 'Paste the cookie export to start.', code: 'INVALID_INPUT' });
    if (!sessionCookies.startsWith('[')) {
      return res.status(400).json({
        success: false,
        error: 'This does not look like the JSON export. In Cookie-Editor choose Export → JSON and paste again.',
        code: 'INVALID_INPUT',
      });
    }
    try {
      if (!Array.isArray(JSON.parse(sessionCookies))) throw new Error('x');
    } catch {
      return res.status(400).json({ success: false, error: 'The cookie export is not valid JSON. Copy it again from Cookie-Editor (Export → JSON).', code: 'INVALID_INPUT' });
    }
    if (localStorageData && !localStorageData.startsWith('{')) {
      return res.status(400).json({ success: false, error: 'The local storage data should start with {. Use the copy command shown in the form.', code: 'INVALID_INPUT' });
    }
    if (body.authorized !== true) {
      return res.status(400).json({ success: false, error: 'Confirm the account is yours (or that you are authorised to access it) to start.', code: 'INVALID_INPUT' });
    }
  }

  // Allowance & fairness
  const allowance = allowanceFor(user);
  if (!allowance.unlimited && allowance.remaining <= 0) {
    return res.status(402).json({ success: false, error: 'No downloads left on your plan this period.', code: 'NO_ALLOWANCE', allowance });
  }
  const mine = store.downloads.filter((d) => d.user_id === user.id && isActive(d)).length;
  const maxActive = limitsFor(user).maxActiveJobs;
  if (maxActive && mine >= maxActive) {
    return res.status(429).json({ success: false, error: `You already have ${mine} download(s) running. Please wait for one to finish.` });
  }
  if (jobQueue.length >= MAX_QUEUE_LENGTH) {
    return res.status(503).json({ success: false, error: `The server is busy right now (${jobQueue.length} downloads waiting). Please try again in a few minutes.` });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const download = store.downloads.insert({
    id,
    user_id: user.id,
    url: targetUrl,
    domain: new URL(targetUrl).hostname,
    mode,
    max_pages: maxPages,
    status: 'queued',
    pages: null,
    assets: null,
    zip_size_bytes: null,
    error_code: null,
    error_message: null,
    login_method: mode === 'cookie_export' ? 'cookies' : null,
    authorized_confirmed_at: mode === 'cookie_export' ? now : null,
    authorized_ip: mode === 'cookie_export' ? ipOf(req) : null,
    stop_requested_at: null,
    created_at: now,
    finished_at: null,
    counted: true,
    progress: { pct: 2, title: 'Starting…' },
    options: {
      stripScripts: Boolean(body.stripScripts),
      ignoreRobots: Boolean(body.ignoreRobots),
      extraUrls: mode !== 'single_page' ? String(body.extraUrls || '').split(/\r?\n/).filter((l) => l.trim()).length : 0,
      localStorage: Boolean(localStorageData),
    },
  });
  if (!allowance.unlimited) {
    store.users.update(user.id, { usage: { ...user.usage, used: (user.usage?.used || 0) + 1 } });
  }

  const control = { stopRequested: false, cancelled: false };
  const job = { control, logs: [] };
  activeJobs.set(id, job);

  const emitProgress = (ev) => {
    if (ev.log) {
      job.logs.push({ t: Date.now(), type: ev.type || 'info', text: String(ev.log).slice(0, 300) });
      if (job.logs.length > 40) job.logs.shift();
    }
    const patch = {};
    if (typeof ev.pages === 'number') patch.pages = ev.pages;
    if (typeof ev.assets === 'number') patch.assets = ev.assets;
    if (typeof ev.found === 'number' && ev.found > 0) patch.pages_found = ev.found;
    if (typeof ev.pct === 'number' || ev.title) {
      patch.progress = { pct: typeof ev.pct === 'number' ? ev.pct : download.progress?.pct || 0, title: ev.title || download.progress?.title || '' };
    }
    const d = store.downloads.find((x) => x.id === id);
    if (!d) return;
    if (d.status === 'running' && ((ev.pct || 0) >= 78 || /Processing|Rewriting|Creating ZIP|packaging/i.test(ev.title || ''))) {
      patch.status = 'processing';
    }
    Object.assign(d, patch); // in-memory only while running; persisted at the end
  };

  const runTask = async () => {
    const d = store.downloads.find((x) => x.id === id);
    if (!d || control.cancelled) return;
    Object.assign(d, { status: 'running', queue_position: null, progress: { pct: 5, title: 'Downloading the website…' } });
    store.downloads.save();
    try {
      const summary = await runCloneJob(
        id,
        {
          url: targetUrl,
          mode: MODES[mode],
          maxPages,
          viewport: body.viewport === 'mobile' ? 'mobile' : 'desktop',
          autoScroll: body.autoScroll !== false,
          rewriteLinks: true,
          saveAssets: true,
          sameDomain: true,
          cookies: sessionCookies,
          localStorageData,
          extraUrls: mode !== 'single_page' ? String(body.extraUrls || '') : '',
          stripScripts: Boolean(body.stripScripts),
          ignoreRobots: Boolean(body.ignoreRobots),
          control,
        },
        { sitesDir: SITES_DIR, zipsDir: ZIPS_DIR },
        emitProgress
      );
      // The unzipped copy is only needed for previews; the ZIP is what users download
      let rec = store.downloads.find((x) => x.id === id);
      let storedPath = null;
      if (rec) {
        // Save the ZIP to cloud storage before showing it as ready (98% -> 100%)
        try {
          emitProgress({
            pct: 98,
            title: 'Saving the ZIP to cloud storage…',
            log: `Uploading ${(summary.sizeBytes / 1048576).toFixed(1)} MB to ${r2.configured ? 'Cloudflare R2' : 'storage'}`,
          });
          storedPath = await storeZip(rec, (sent, total) => {
            const now = Date.now();
            if (now - (job.lastUploadEmit || 0) < 400 && sent < total) return;
            job.lastUploadEmit = now;
            const frac = sent / Math.max(1, total);
            emitProgress({ pct: Math.round((98 + 1.9 * frac) * 10) / 10, title: `Saving the ZIP to cloud storage… ${Math.round(frac * 100)}%` });
          });
        } catch (err) {
          console.error('[storage] ZIP upload failed:', err.message); // the local copy still works until the server restarts
        }
        rec = store.downloads.find((x) => x.id === id);
      }
      if (rec) {
        Object.assign(rec, {
          zip_storage_path: storedPath,
          status: 'completed',
          pages: summary.pagesCount,
          assets: summary.assetsCount,
          zip_size_bytes: summary.sizeBytes,
          stopped_early: Boolean(summary.stoppedEarly),
          finished_at: new Date().toISOString(),
          progress: { pct: 100, title: 'Ready' },
        });
        store.downloads.save();
      } else {
        cleanupFiles(id); // deleted while finishing
        removeStored(storedPath);
      }
    } catch (err) {
      const rec = store.downloads.find((x) => x.id === id);
      cleanupFiles(id);
      if (rec && err.code !== 'CANCELLED') {
        Object.assign(rec, {
          status: 'failed',
          error_code: err.code || 'FAILED',
          error_message: err.message || 'The download failed.',
          finished_at: new Date().toISOString(),
        });
        refundDownload(rec);
        store.downloads.save();
      }
    } finally {
      setTimeout(() => activeJobs.delete(id), 60 * 1000);
    }
  };

  enqueueJob(id, runTask, (pos) => {
    const d = store.downloads.find((x) => x.id === id);
    if (d && d.status === 'queued') {
      d.queue_position = pos;
      d.progress = { pct: 3, title: `Waiting in line — you are #${pos}` };
    }
  });

  res.json({ success: true, download: publicDownload(download), allowance: allowanceFor(store.users.find((u) => u.id === user.id)) });
});

// "Stop & download": finish now with the pages saved so far (counts as one download)
app.post('/api/website-downloads/:id/stop', auth.requireAuth, (req, res) => {
  const d = ownDownload(req, res);
  if (!d) return;
  if (!isActive(d)) return res.status(400).json({ success: false, error: 'This download is not running.' });
  const job = activeJobs.get(d.id);
  // Still waiting in line: nothing is saved yet, so stopping simply takes it out of the line (not counted)
  if (d.status === 'queued' || !job) {
    if (job) job.control.cancelled = true;
    removeFromQueue(d.id);
    activeJobs.delete(d.id);
    refundDownload(d);
    store.downloads.update(d.id, {
      status: 'failed',
      error_code: 'STOPPED',
      error_message: 'Stopped before it started — it was not counted.',
      finished_at: new Date().toISOString(),
      queue_position: null,
      stop_requested_at: new Date().toISOString(),
    });
    return res.json({ success: true, download: publicDownload(d) });
  }
  // Already packaging: the ZIP is seconds away, nothing to stop
  if (d.status === 'processing') return res.json({ success: true, download: publicDownload(d), note: 'finishing' });
  job.control.stopRequested = true;
  store.downloads.update(d.id, { stop_requested_at: d.stop_requested_at || new Date().toISOString() });
  res.json({ success: true, download: publicDownload(d) });
});

// Cancel (if running) or delete (if finished)
app.delete('/api/website-downloads/:id', auth.requireAuth, (req, res) => {
  const d = ownDownload(req, res);
  if (!d) return;
  if (isActive(d)) {
    const job = activeJobs.get(d.id);
    if (job) job.control.cancelled = true;
    const wasWaiting = removeFromQueue(d.id);
    refundDownload(d);
    if (wasWaiting) {
      activeJobs.delete(d.id);
      cleanupFiles(d.id);
    }
  } else {
    cleanupFiles(d.id);
  }
  removeStoredZip(d);
  store.downloads.remove(d.id);
  res.json({ success: true });
});

// Short-lived link for the ZIP or the live preview (so <a href> works without exposing the session token)
app.post('/api/website-downloads/:id/link', auth.requireAuth, async (req, res) => {
  const d = ownDownload(req, res);
  if (!d) return;
  if (d.status !== 'completed') return res.status(400).json({ success: false, error: 'This download is not ready yet.' });
  const kind = req.body?.kind === 'preview' ? 'preview' : 'zip';
  if (kind === 'zip' && !fs.existsSync(zipPathOf(d.id))) {
    if (!storedZipValid(d)) {
      return res.status(410).json({ success: false, error: `ZIP files are kept for ${ZIP_RETENTION_HOURS} hours. This one has expired — please download the website again.` });
    }
    try {
      return res.json({ success: true, url: await storedLink(d.zip_storage_path, zipNameOf(d)) });
    } catch (err) {
      return res.status(410).json({ success: false, error: 'This ZIP is no longer available. Please download the website again.' });
    }
  }
  if (kind === 'preview' && !fs.existsSync(path.join(siteDirOf(d.id), 'index.html'))) {
    return res.status(410).json({ success: false, error: 'The preview has expired on the server. Download the ZIP instead.' });
  }
  const t = auth.fileTokenFor(req.user, kind, d.id);
  const url = kind === 'zip' ? `/api/website-downloads/${d.id}/download?t=${t}` : `/preview-auth/${d.id}?t=${t}`;
  res.json({ success: true, url });
});

app.get('/api/website-downloads/:id/download', (req, res) => {
  const user = auth.userFromFileToken(req.query.t, 'zip', req.params.id);
  if (!user) return res.status(401).send('This download link has expired. Go back to your History and click Download ZIP again.');
  const d = store.downloads.find((x) => x.id === req.params.id);
  if (!d || (d.user_id !== user.id && user.role !== 'admin')) return res.status(404).send('Download not found.');
  const zipPath = zipPathOf(d.id);
  if (!fs.existsSync(zipPath)) {
    if (storedZipValid(d)) {
      return storedLink(d.zip_storage_path, zipNameOf(d), 600)
        .then((u) => res.redirect(u))
        .catch(() => res.status(410).send('This ZIP is no longer available. Please download the website again.'));
    }
    return res.status(410).send('This ZIP has expired on the server. Please download the website again.');
  }
  res.download(zipPath, zipNameOf(d));
});

// Previews: a signed, path-scoped cookie lets the cloned page load its own CSS/JS/images
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

app.get('/preview-auth/:id', (req, res) => {
  const user = auth.userFromFileToken(req.query.t, 'preview', req.params.id);
  if (!user) return res.status(401).send('This preview link has expired. Open it again from your History.');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `sc_pv=${encodeURIComponent(req.query.t)}; Path=/preview/${req.params.id}/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? '; Secure' : ''}`
  );
  res.redirect(`/preview/${req.params.id}/index.html`);
});

app.use('/preview/:id', (req, res, next) => {
  const user = auth.userFromFileToken(readCookie(req, 'sc_pv'), 'preview', req.params.id);
  if (!user) return res.status(401).send('Please open this preview from your History.');
  express.static(siteDirOf(req.params.id))(req, res, next);
});

// ---------------------------------------------------------------------------
// Website Library — sites already downloaded by an admin, free for every signed-in user.
// ZIPs are kept in Supabase Storage (zips/library/<id>.zip) so they survive restarts.
// ---------------------------------------------------------------------------
const libraryZipOf = (id) => path.join(LIBRARY_DIR, `${id}.zip`);

function publicLibraryItem(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    domain: item.domain,
    pages: item.pages,
    zip_size_bytes: item.zip_size_bytes,
    created_at: item.created_at,
    available: Boolean(item.storage_path) || fs.existsSync(libraryZipOf(item.id)),
  };
}

app.get('/api/library', auth.requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const items = store.library
    .all()
    .filter((i) => !q || `${i.title} ${i.url}`.toLowerCase().includes(q))
    .map(publicLibraryItem);
  res.json({ success: true, items });
});

app.post('/api/library', auth.requireAdmin, async (req, res) => {
  const d = store.downloads.find((x) => x.id === req.body?.downloadId);
  const hasLocal = Boolean(d) && fs.existsSync(zipPathOf(d.id));
  if (!d || d.status !== 'completed' || (!hasLocal && !storedZipValid(d))) {
    return res.status(400).json({ success: false, error: 'Pick a finished download whose ZIP is still available.' });
  }
  const id = crypto.randomUUID();
  const key = `library/${id}.zip`;
  let storagePath = null;
  try {
    if (r2.configured) {
      // library copies sit outside zips/, so the 24-hour rule never deletes them
      if (isR2(d.zip_storage_path)) await r2.copy(d.zip_storage_path.slice(R2_PREFIX.length), key);
      else await r2.uploadFile(key, zipPathOf(d.id));
      storagePath = R2_PREFIX + key;
    } else {
      if (d.zip_storage_path) await sb.storage.copy(ZIP_BUCKET, d.zip_storage_path, key);
      else if (fs.statSync(zipPathOf(d.id)).size <= STORAGE_MAX_BYTES) await sb.storage.uploadFile(ZIP_BUCKET, key, zipPathOf(d.id));
      else throw new Error('too large');
      storagePath = key;
    }
  } catch (err) {
    console.error('[library] copy failed:', err.message);
    // Too big for Storage (50 MB) or Storage unavailable: keep a local copy (lost when the server restarts)
    if (!hasLocal) return res.status(500).json({ success: false, error: 'Could not copy the ZIP to the library. Please try again.' });
    fs.copyFileSync(zipPathOf(d.id), libraryZipOf(id));
  }
  const item = store.library.insert({
    id,
    title: String(req.body?.title || d.domain).trim().slice(0, 120) || d.domain,
    url: d.url,
    domain: d.domain,
    pages: d.pages,
    zip_size_bytes: d.zip_size_bytes,
    source_download_id: d.id,
    storage_path: storagePath,
    created_by: req.user.id,
    created_at: new Date().toISOString(),
  });
  store.downloads.update(d.id, { library_id: id });
  store.logAdminEvent(req.user.id, null, 'library.add', { library_id: id, url: d.url });
  res.json({ success: true, item: publicLibraryItem(item) });
});

app.delete('/api/library/:id', auth.requireAdmin, (req, res) => {
  const item = store.library.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  try {
    fs.rmSync(libraryZipOf(item.id), { force: true });
  } catch {}
  removeStored(item.storage_path);
  for (const d of store.downloads.filter((x) => x.library_id === item.id)) d.library_id = null;
  store.downloads.save();
  store.library.remove(item.id);
  store.logAdminEvent(req.user.id, null, 'library.remove', { library_id: item.id, url: item.url });
  res.json({ success: true });
});

app.post('/api/library/:id/link', auth.requireAuth, async (req, res) => {
  const item = store.library.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  if (item.storage_path) {
    try {
      return res.json({ success: true, url: await storedLink(item.storage_path, `${item.domain}.zip`) });
    } catch {}
  }
  if (!fs.existsSync(libraryZipOf(item.id))) return res.status(410).json({ success: false, error: 'This ZIP is no longer on the server.' });
  res.json({ success: true, url: `/api/library/${item.id}/download?t=${auth.fileTokenFor(req.user, 'library', item.id)}` });
});

app.get('/api/library/:id/download', (req, res) => {
  const user = auth.userFromFileToken(req.query.t, 'library', req.params.id);
  if (!user) return res.status(401).send('This download link has expired. Go back to the Library and try again.');
  const item = store.library.find((i) => i.id === req.params.id);
  if (!item || !fs.existsSync(libraryZipOf(item.id))) return res.status(404).send('Not found.');
  res.download(libraryZipOf(item.id), `${item.domain}.zip`);
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
app.get('/api/admin/overview', auth.requireAdmin, (req, res) => {
  const all = store.downloads.all();
  const dayAgo = Date.now() - 86400000;
  res.json({
    success: true,
    stats: {
      users: store.users.all().length,
      downloads: all.length,
      completed: all.filter((d) => d.status === 'completed').length,
      failed: all.filter((d) => d.status === 'failed').length,
      active: all.filter(isActive).length,
      library: store.library.all().length,
      last24h: all.filter((d) => new Date(d.created_at).getTime() > dayAgo).length,
      pagesSaved: all.reduce((n, d) => n + (d.status === 'completed' ? d.pages || 0 : 0), 0),
    },
    server: { running: runningCount, queued: jobQueue.length, maxConcurrentJobs: MAX_CONCURRENT_JOBS, memoryPct: memoryUsagePct(), database: 'Supabase' },
  });
});

function adminUserView(u) {
  return {
    ...publicUser(u),
    allowance: allowanceFor(u),
    monthlyLimit: u.monthlyLimit ?? null,
    planName: u.planName || 'Free',
    maxPagesLimit: u.maxPagesLimit ?? null,
    allowedModes: u.allowedModes || null,
    maxActiveJobs: u.maxActiveJobs ?? null,
    notes: u.notes || '',
    downloads: store.downloads.filter((d) => d.user_id === u.id).length,
    activeDownloads: store.downloads.filter((d) => d.user_id === u.id && isActive(d)).length,
    pagesSaved: store.downloads.all().reduce((n, d) => n + (d.user_id === u.id && d.status === 'completed' ? d.pages || 0 : 0), 0),
  };
}

const randomPassword = () => `${crypto.randomBytes(6).toString('base64url')}-${crypto.randomBytes(4).toString('hex')}`;

// Create an account from the admin panel (ready to sign in, no email step)
app.post('/api/admin/users', auth.requireAdmin, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80) || email.split('@')[0];
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  const password = String(b.password || '') || randomPassword();
  if (password.length < 8) return res.status(400).json({ success: false, error: 'The password needs at least 8 characters (or leave it empty to generate one).' });
  if (store.users.find((u) => u.email === email)) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
  try {
    const created = await sb.auth.admin.createUser({ email, password, name });
    const user = await store.users.fetch(created.id);
    const role = b.role === 'admin' ? 'admin' : 'user';
    const limit = b.monthlyLimit === null || b.monthlyLimit === '' || b.monthlyLimit === undefined ? defaultMonthlyLimit() : Math.max(0, parseInt(b.monthlyLimit, 10) || 0);
    store.users.update(user.id, { role, monthlyLimit: role === 'admin' ? null : limit, planName: String(b.planName || 'Free').slice(0, 40) });
    store.logAdminEvent(req.user.id, user.id, 'user.create', { email, role });
    res.json({ success: true, user: adminUserView(user), password, generated: !b.password });
  } catch (err) {
    if (err.status === 422 || /already/i.test(err.message)) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    res.status(400).json({ success: false, error: err.message || 'Could not create the account.' });
  }
});

// Site-wide settings
app.get('/api/admin/settings', auth.requireAdmin, (req, res) => {
  res.json({
    success: true,
    settings: {
      defaultMonthlyLimit: defaultMonthlyLimit(),
      registrationOpen: registrationOpen(),
      registrationLockedByServer: process.env.ALLOW_REGISTRATION === 'false',
      maxPages: MAX_PAGES_LIMIT,
      maxJobsPerUser: MAX_JOBS_PER_USER,
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      periodDays: PERIOD_DAYS,
    },
  });
});
app.patch('/api/admin/settings', auth.requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    if ('defaultMonthlyLimit' in b) {
      const v = b.defaultMonthlyLimit === null || b.defaultMonthlyLimit === '' ? null : Math.max(0, parseInt(b.defaultMonthlyLimit, 10) || 0);
      await store.saveSetting('default_monthly_limit', v);
    }
    if ('registrationOpen' in b) await store.saveSetting('registration_open', Boolean(b.registrationOpen));
    if (b.applyDefaultToAll) {
      // give every normal user the default limit (admins stay unlimited)
      for (const u of store.users.all()) if (u.role !== 'admin') store.users.update(u.id, { monthlyLimit: defaultMonthlyLimit() });
    }
    store.logAdminEvent(req.user.id, null, 'settings.update', b);
    res.json({ success: true, settings: { defaultMonthlyLimit: defaultMonthlyLimit(), registrationOpen: registrationOpen() } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/users', auth.requireAdmin, async (req, res) => {
  try {
    await store.users.reload(); // include people who signed up moments ago
  } catch (err) {
    console.error('[admin] reload users:', err.message);
  }
  res.json({ success: true, users: store.users.all().map(adminUserView) });
});

app.patch('/api/admin/users/:id', auth.requireAdmin, async (req, res) => {
  const user = store.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  const patch = {};
  const body = req.body || {};
  if (body.role === 'admin' || body.role === 'user') {
    if (user.id === req.user.id && body.role !== 'admin') {
      return res.status(400).json({ success: false, error: 'You cannot remove your own admin role.' });
    }
    patch.role = body.role;
  }
  if ('monthlyLimit' in body) {
    const v = body.monthlyLimit;
    patch.monthlyLimit = v === null || v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
  }
  if ('disabled' in body) {
    if (user.id === req.user.id && body.disabled) return res.status(400).json({ success: false, error: 'You cannot disable yourself.' });
    patch.disabled = Boolean(body.disabled);
    try {
      // a banned Supabase user cannot sign in; existing sessions are removed
      await sb.auth.admin.updateUser(user.id, { ban_duration: patch.disabled ? '876000h' : 'none' });
      if (patch.disabled) await sb.auth.revokeSessions(user.id);
    } catch (err) {
      return res.status(500).json({ success: false, error: `Could not update sign-in access: ${err.message}` });
    }
    auth.forgetUserTokens(user.id);
  }
  if (body.resetUsage) patch.usage = { periodStart: new Date().toISOString(), used: 0 };
  if (typeof body.planName === 'string') patch.planName = body.planName.trim().slice(0, 40) || 'Free';
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (typeof body.notes === 'string') patch.notes = body.notes.slice(0, 500);
  if ('maxPagesLimit' in body) {
    const v = body.maxPagesLimit;
    patch.maxPagesLimit = v === null || v === '' ? null : Math.min(MAX_PAGES_LIMIT, Math.max(1, parseInt(v, 10) || 1));
  }
  if ('maxActiveJobs' in body) {
    const v = body.maxActiveJobs;
    patch.maxActiveJobs = v === null || v === '' ? null : Math.min(10, Math.max(1, parseInt(v, 10) || 1));
  }
  if ('allowedModes' in body) {
    const list = Array.isArray(body.allowedModes) ? body.allowedModes.filter((m) => ALL_MODES.includes(m)) : [];
    if (body.allowedModes !== null && !list.length) return res.status(400).json({ success: false, error: 'Allow at least one download type.' });
    patch.allowedModes = body.allowedModes === null || list.length === ALL_MODES.length ? null : list;
  }
  const updated = store.users.update(user.id, patch);
  store.logAdminEvent(req.user.id, user.id, 'user.update', patch);
  res.json({ success: true, user: adminUserView(updated) });
});

// Set a temporary password for a user (Supabase's free email service only reaches project members)
app.post('/api/admin/users/:id/reset-password', auth.requireAdmin, async (req, res) => {
  const user = store.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  const temp = randomPassword();
  try {
    await sb.auth.admin.updateUser(user.id, { password: temp });
    await sb.auth.revokeSessions(user.id);
    auth.forgetUserTokens(user.id);
  } catch (err) {
    return res.status(500).json({ success: false, error: `Could not set the password: ${err.message}` });
  }
  store.logAdminEvent(req.user.id, user.id, 'user.reset_password');
  res.json({ success: true, temporaryPassword: temp });
});

// Delete an account and everything it owns
app.delete('/api/admin/users/:id', auth.requireAdmin, async (req, res) => {
  const user = store.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ success: false, error: 'You cannot delete your own account.' });
  for (const d of store.downloads.filter((x) => x.user_id === user.id)) {
    const job = activeJobs.get(d.id);
    if (job) job.control.cancelled = true;
    removeFromQueue(d.id);
    cleanupFiles(d.id);
    removeStoredZip(d);
    store.downloads.remove(d.id);
  }
  try {
    await store.flushAll();
    await sb.auth.admin.deleteUser(user.id); // cascades to the profile row in the database
  } catch (err) {
    return res.status(500).json({ success: false, error: `Could not delete the account: ${err.message}` });
  }
  auth.forgetUserTokens(user.id);
  const idx = store.users.all().indexOf(user);
  if (idx !== -1) store.users.all().splice(idx, 1);
  store.logAdminEvent(req.user.id, null, 'user.delete', { email: user.email });
  res.json({ success: true });
});

app.get('/api/admin/downloads', auth.requireAdmin, (req, res) => {
  const emails = new Map(store.users.all().map((u) => [u.id, u.email]));
  const downloads = store.downloads
    .all()
    .slice(0, 300)
    .map((d) => ({ ...publicDownload(d), user_email: emails.get(d.user_id) || '—' }));
  res.json({ success: true, downloads });
});

// ---------------------------------------------------------------------------
// Health & config
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'siteclone-pro-backend',
    database: dbReady ? 'ready' : sb.configured ? 'starting' : 'not configured',
    status: 'online',
    running: runningCount,
    queued: jobQueue.length,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    memoryPct: memoryUsagePct(),
    nodeHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    nodeRssMB: Math.round(process.memoryUsage().rss / 1048576),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    maxPages: MAX_PAGES_LIMIT,
    pageOptions: PAGE_OPTIONS,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxJobsPerUser: MAX_JOBS_PER_USER,
    registrationOpen: registrationOpen(),
    periodDays: PERIOD_DAYS,
  });
});

// ---------------------------------------------------------------------------
// Housekeeping: delete old ZIPs/previews from disk (records stay, marked as expired)
// ---------------------------------------------------------------------------
function cleanupOldFiles() {
  if (!RETENTION_HOURS) return;
  const cutoff = Date.now() - RETENTION_HOURS * 3600000;
  for (const dir of [SITES_DIR, ZIPS_DIR]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const name of names) {
      const id = name.replace(/\.zip$/, '');
      if (activeJobs.has(id)) continue;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
  // Copies in Supabase Storage expire too (library copies are kept)
  if (!dbReady) return;
  // R2 deletes its own copies with the bucket lifecycle rule; the records are just marked as expired
  const zipCutoff = Date.now() - ZIP_RETENTION_HOURS * 3600000;
  for (const d of store.downloads.filter((x) => x.zip_storage_path && x.finished_at && new Date(x.finished_at).getTime() < zipCutoff)) {
    if (!isR2(d.zip_storage_path)) removeStored(d.zip_storage_path);
    store.downloads.update(d.id, { zip_storage_path: null });
  }
}
setInterval(cleanupOldFiles, 30 * 60 * 1000).unref();
setTimeout(cleanupOldFiles, 15 * 1000).unref();

// Old URLs from the previous version
app.get(['/history', '/dashboard'], (req, res) => res.redirect('/app.html'));

const server = app.listen(PORT, () => {
  console.log(
    `\n🚀 SiteClone Pro server running at http://localhost:${PORT} ` +
      `(maxPages=${MAX_PAGES_LIMIT}, concurrentJobs=${MAX_CONCURRENT_JOBS}, perUser=${MAX_JOBS_PER_USER}, ` +
      `retention=${RETENTION_HOURS ? `${RETENTION_HOURS}h` : 'off'}, registration=${process.env.ALLOW_REGISTRATION === 'false' ? 'closed' : 'admin-controlled'})\n`
  );
  bootDatabase().catch((err) => console.error("[db] boot failed:", err));
});
// Large clones can take a long time; don't let Node cut long-lived requests (ZIP downloads)
server.requestTimeout = 0;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 61 * 1000;
