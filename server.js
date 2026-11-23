const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { runCloneJob, MAX_PAGES_LIMIT } = require('./cloner');
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
const REGISTRATION_OPEN = process.env.ALLOW_REGISTRATION !== 'false';
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

const store = createStore(STORAGE_DIR);
const auth = createAuth({ store, storageDir: STORAGE_DIR });
auth.ensureSeedAdmin();

// Downloads that were in progress when the server stopped can't be resumed
for (const d of store.downloads.all()) {
  if (['queued', 'running', 'processing'].includes(d.status)) {
    Object.assign(d, {
      status: 'failed',
      error_code: 'SERVER_RESTART',
      error_message: 'The server restarted while this download was running. Please start it again — it was not counted.',
      finished_at: new Date().toISOString(),
    });
    refundDownload(d);
  }
}
store.downloads.save();

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: '5mb' }));
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

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    disabled: Boolean(user.disabled),
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
app.post('/api/auth/register', (req, res) => {
  if (!REGISTRATION_OPEN) return res.status(403).json({ success: false, error: 'Sign-ups are closed right now.' });
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
  const user = auth.createUser({ email: normalized, name, password });
  store.users.update(user.id, { lastLoginAt: new Date().toISOString() });
  res.json({ success: true, token: auth.sessionTokenFor(user), user: publicUser(user), allowance: allowanceFor(user) });
});

app.post('/api/auth/login', (req, res) => {
  if (!rateLimit(`login:${ipOf(req)}`, 20, 15 * 60 * 1000)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }
  const { email = '', password = '' } = req.body || {};
  const user = store.users.find((u) => u.email === String(email).trim().toLowerCase());
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ success: false, error: 'Wrong email or password.' });
  }
  if (user.disabled) return res.status(403).json({ success: false, error: 'This account has been disabled. Contact support.' });
  store.users.update(user.id, { lastLoginAt: new Date().toISOString() });
  res.json({ success: true, token: auth.sessionTokenFor(user), user: publicUser(user), allowance: allowanceFor(user) });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user), allowance: allowanceFor(req.user) });
});

app.patch('/api/me', auth.requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ success: false, error: 'Please enter your name.' });
  const user = store.users.update(req.user.id, { name });
  res.json({ success: true, user: publicUser(user) });
});

app.post('/api/me/password', auth.requireAuth, (req, res) => {
  const { currentPassword = '', newPassword = '' } = req.body || {};
  if (!auth.verifyPassword(currentPassword, req.user.passwordHash)) {
    return res.status(400).json({ success: false, error: 'Your current password is not correct.' });
  }
  if (String(newPassword).length < 8) return res.status(400).json({ success: false, error: 'Use at least 8 characters.' });
  const user = store.users.update(req.user.id, {
    passwordHash: auth.hashPassword(newPassword),
    tokenVersion: (req.user.tokenVersion || 0) + 1, // signs out other devices
  });
  res.json({ success: true, token: auth.sessionTokenFor(user) });
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
    zip_available: d.status === 'completed' && fs.existsSync(zipPathOf(d.id)),
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
    const allowedMax = MAX_PAGES_LIMIT;
    if (user.role !== 'admin' && !PAGE_OPTIONS.includes(maxPages)) {
      return res.status(400).json({ success: false, error: `Choose one of: ${PAGE_OPTIONS.join(', ')} pages.`, code: 'INVALID_INPUT' });
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
  if (mine >= MAX_JOBS_PER_USER && user.role !== 'admin') {
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
      const rec = store.downloads.find((x) => x.id === id);
      if (rec) {
        Object.assign(rec, {
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
  if (d.status === 'queued' || !job) {
    return res.status(400).json({ success: false, error: 'This download has not started yet — cancel it instead.' });
  }
  if (d.status === 'processing') {
    return res.status(400).json({ success: false, error: 'All pages are already saved — the ZIP is being created now.' });
  }
  job.control.stopRequested = true;
  d.stop_requested_at = new Date().toISOString();
  store.downloads.save();
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
  store.downloads.remove(d.id);
  res.json({ success: true });
});

// Short-lived link for the ZIP or the live preview (so <a href> works without exposing the session token)
app.post('/api/website-downloads/:id/link', auth.requireAuth, (req, res) => {
  const d = ownDownload(req, res);
  if (!d) return;
  if (d.status !== 'completed') return res.status(400).json({ success: false, error: 'This download is not ready yet.' });
  const kind = req.body?.kind === 'preview' ? 'preview' : 'zip';
  if (kind === 'zip' && !fs.existsSync(zipPathOf(d.id))) {
    return res.status(410).json({ success: false, error: 'This ZIP has expired on the server. Please download the website again.' });
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
  if (!fs.existsSync(zipPath)) return res.status(410).send('This ZIP has expired on the server. Please download the website again.');
  const date = (d.finished_at || d.created_at || '').slice(0, 10);
  res.download(zipPath, `${d.domain}-${date}.zip`);
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
// Website Library — sites already downloaded by an admin, free for every signed-in user
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
    available: fs.existsSync(libraryZipOf(item.id)),
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

app.post('/api/library', auth.requireAdmin, (req, res) => {
  const d = store.downloads.find((x) => x.id === req.body?.downloadId);
  if (!d || d.status !== 'completed' || !fs.existsSync(zipPathOf(d.id))) {
    return res.status(400).json({ success: false, error: 'Pick a finished download whose ZIP is still on the server.' });
  }
  const id = crypto.randomUUID();
  fs.copyFileSync(zipPathOf(d.id), libraryZipOf(id));
  const item = store.library.insert({
    id,
    title: String(req.body?.title || d.domain).trim().slice(0, 120) || d.domain,
    url: d.url,
    domain: d.domain,
    pages: d.pages,
    zip_size_bytes: d.zip_size_bytes,
    source_download_id: d.id,
    created_at: new Date().toISOString(),
  });
  d.library_id = id;
  store.downloads.save();
  res.json({ success: true, item: publicLibraryItem(item) });
});

app.delete('/api/library/:id', auth.requireAdmin, (req, res) => {
  const item = store.library.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  try {
    fs.rmSync(libraryZipOf(item.id), { force: true });
  } catch {}
  for (const d of store.downloads.filter((x) => x.library_id === item.id)) d.library_id = null;
  store.downloads.save();
  store.library.remove(item.id);
  res.json({ success: true });
});

app.post('/api/library/:id/link', auth.requireAuth, (req, res) => {
  const item = store.library.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
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
  res.json({
    success: true,
    stats: {
      users: store.users.all().length,
      downloads: all.length,
      completed: all.filter((d) => d.status === 'completed').length,
      failed: all.filter((d) => d.status === 'failed').length,
      active: all.filter(isActive).length,
      library: store.library.all().length,
    },
    server: { running: runningCount, queued: jobQueue.length, maxConcurrentJobs: MAX_CONCURRENT_JOBS, memoryPct: memoryUsagePct() },
  });
});

app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
  const users = store.users.all().map((u) => ({
    ...publicUser(u),
    allowance: allowanceFor(u),
    monthlyLimit: u.monthlyLimit ?? null,
    downloads: store.downloads.filter((d) => d.user_id === u.id).length,
  }));
  res.json({ success: true, users });
});

app.patch('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
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
    if (patch.disabled) patch.tokenVersion = (user.tokenVersion || 0) + 1; // sign out now
  }
  if (body.resetUsage) patch.usage = { periodStart: new Date().toISOString(), used: 0 };
  if (typeof body.planName === 'string') patch.planName = body.planName.trim().slice(0, 40) || 'Free';
  const updated = store.users.update(user.id, patch);
  res.json({ success: true, user: { ...publicUser(updated), allowance: allowanceFor(updated), monthlyLimit: updated.monthlyLimit ?? null } });
});

// Set a temporary password for a user (email sending is not available on the free host)
app.post('/api/admin/users/:id/reset-password', auth.requireAdmin, (req, res) => {
  const user = store.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  const temp = `${crypto.randomBytes(6).toString('base64url')}-${crypto.randomBytes(4).toString('hex')}`;
  store.users.update(user.id, { passwordHash: auth.hashPassword(temp), tokenVersion: (user.tokenVersion || 0) + 1 });
  res.json({ success: true, temporaryPassword: temp });
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
    registrationOpen: REGISTRATION_OPEN,
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
}
setInterval(cleanupOldFiles, 30 * 60 * 1000).unref();
setTimeout(cleanupOldFiles, 15 * 1000).unref();

// Old URLs from the previous version
app.get(['/history', '/dashboard'], (req, res) => res.redirect('/app.html'));

const server = app.listen(PORT, () => {
  console.log(
    `\n🚀 SiteClone Pro server running at http://localhost:${PORT} ` +
      `(maxPages=${MAX_PAGES_LIMIT}, concurrentJobs=${MAX_CONCURRENT_JOBS}, perUser=${MAX_JOBS_PER_USER}, ` +
      `retention=${RETENTION_HOURS ? `${RETENTION_HOURS}h` : 'off'}, registration=${REGISTRATION_OPEN ? 'open' : 'closed'})\n`
  );
});
// Large clones can take a long time; don't let Node cut long-lived requests (ZIP downloads)
server.requestTimeout = 0;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 61 * 1000;
