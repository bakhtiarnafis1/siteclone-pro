const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { runCloneJob, createZipArchive, MAX_PAGES_LIMIT } = require('./cloner');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Server tuning (environment variables; defaults suit a 2 vCPU / 12GB server)
// ---------------------------------------------------------------------------
const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const MAX_CONCURRENT_JOBS = envInt('MAX_CONCURRENT_JOBS', 1); // Chromium jobs running at the same time
const MAX_JOBS_PER_IP = envInt('MAX_JOBS_PER_IP', 2); // running + queued jobs one visitor may hold
const MAX_QUEUE_LENGTH = envInt('MAX_QUEUE_LENGTH', 15); // waiting jobs before new requests are refused
// Don't start an additional parallel job while container memory use is above this % of its limit
const MEMORY_START_THRESHOLD_PCT = envInt('MEMORY_START_THRESHOLD_PCT', 55);
// Auto-delete clones/ZIPs older than this. OFF unless RETENTION_HOURS is set (docker-compose sets it on the server),
// so running locally never deletes your saved clones.
const RETENTION_HOURS = envInt('RETENTION_HOURS', 0);
const MAX_HISTORY_ITEMS = envInt('MAX_HISTORY_ITEMS', 200);

// Behind Caddy/Cloudflare, read the real visitor IP from X-Forwarded-For
if (process.env.TRUST_PROXY) app.set('trust proxy', true);

// Never let one bad clone crash the whole server
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint (used by Docker healthcheck and the frontend)
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

// Public limits so the frontend can adapt its page slider
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    maxPages: MAX_PAGES_LIMIT,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxJobsPerIp: MAX_JOBS_PER_IP,
  });
});

// Storage directories for cloned sites and zip files
const STORAGE_DIR = path.join(__dirname, 'storage');
const SITES_DIR = path.join(STORAGE_DIR, 'sites');
const ZIPS_DIR = path.join(STORAGE_DIR, 'zips');
const HISTORY_FILE = path.join(STORAGE_DIR, 'history.json');

[STORAGE_DIR, SITES_DIR, ZIPS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
}

// Serve cloned sites for live offline preview inside the browser
app.use('/preview', express.static(SITES_DIR));

// Active jobs registry for real-time Server-Sent Events (SSE) & polling fallback
const activeJobs = new Map();

// ---------------------------------------------------------------------------
// Memory-aware FIFO job queue
// - At most MAX_CONCURRENT_JOBS clones run at once (Chromium is the RAM-hungry part).
// - A 2nd+ parallel job only starts while container memory is below MEMORY_START_THRESHOLD_PCT.
// - Waiting jobs are told their live position (#1, #2, …) every time the line moves.
// ---------------------------------------------------------------------------
let runningCount = 0;
const jobQueue = []; // [{ taskFn, onPosition, lastPos }]

// Container memory usage in % of its limit (cgroup v2 / v1), or null if unknown (e.g. Windows dev machine)
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
// Reclaimable file cache (recently written ZIPs etc.) is subtracted, like `docker stats` does,
// so the number reflects memory that can actually cause an out-of-memory kill.
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
// Re-check periodically in case a job was held back only because memory was high
setInterval(processQueue, 5000).unref();

function enqueueCloneTask(taskFn, onPosition) {
  jobQueue.push({ taskFn, onPosition, lastPos: 0 });
  processQueue();
  notifyQueuePositions();
}

// Per-visitor fairness: count unfinished jobs per IP
const jobsPerIp = new Map();
function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Housekeeping: forget finished jobs from RAM after 1h, delete old clones/ZIPs from disk
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;
function cleanupOldData() {
  const now = Date.now();
  for (const [id, job] of activeJobs) {
    if (job.done && now - (job.finishedAt || job.createdAt) > FINISHED_JOB_TTL_MS) activeJobs.delete(id);
  }

  if (!RETENTION_HOURS) return;
  const cutoff = now - RETENTION_HOURS * 60 * 60 * 1000;
  const isBusy = (id) => {
    const job = activeJobs.get(id);
    return job && !job.done;
  };
  try {
    for (const name of fs.readdirSync(SITES_DIR)) {
      const p = path.join(SITES_DIR, name);
      if (!isBusy(name) && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    }
    for (const name of fs.readdirSync(ZIPS_DIR)) {
      const p = path.join(ZIPS_DIR, name);
      if (!isBusy(name.replace(/\.zip$/, '')) && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    const kept = history.filter((h) => fs.existsSync(path.join(SITES_DIR, h.id)) || fs.existsSync(path.join(ZIPS_DIR, `${h.id}.zip`)));
    if (kept.length !== history.length) fs.writeFileSync(HISTORY_FILE, JSON.stringify(kept, null, 2));
  } catch (err) {
    console.error('[cleanup]', err.message);
  }
}
setInterval(cleanupOldData, 30 * 60 * 1000).unref();
setTimeout(cleanupOldData, 10 * 1000).unref();

function saveToHistory(summary) {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    const filtered = history.filter((item) => item.id !== summary.id);
    filtered.unshift(summary);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(filtered.slice(0, MAX_HISTORY_ITEMS), null, 2));
  } catch (err) {
    console.error('Failed to save history:', err);
  }
}

function findUrlInHistory(jobId) {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    const found = history.find((item) => item.id === jobId);
    return found ? found.url : null;
  } catch {
    return null;
  }
}

// Serve generated ZIP archives with self-healing fallback if container restarted or slept
app.get('/downloads/:jobId.zip', async (req, res) => {
  const { jobId } = req.params;
  const zipPath = path.join(ZIPS_DIR, `${jobId}.zip`);
  const siteDir = path.join(SITES_DIR, jobId);

  try {
    // 1. If ZIP file exists on disk, serve it immediately
    if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) {
      return res.download(zipPath, `${jobId}.zip`);
    }

    // 2. If site folder exists on disk but ZIP was missing, re-archive it on the fly
    if (fs.existsSync(siteDir) && fs.existsSync(path.join(siteDir, 'index.html'))) {
      await createZipArchive(siteDir, zipPath);
      if (fs.existsSync(zipPath)) {
        return res.download(zipPath, `${jobId}.zip`);
      }
    }

    // 3. If Render free container restarted/redeployed and wiped ephemeral disk, re-clone on the fly using ?url=
    const fallbackUrl = req.query.url || activeJobs.get(jobId)?.targetUrl || findUrlInHistory(jobId);
    if (fallbackUrl) {
      await new Promise((resolve, reject) => {
        enqueueCloneTask(
          () =>
            runCloneJob(
              jobId,
              { url: fallbackUrl, mode: 'single', maxPages: 1 },
              { sitesDir: SITES_DIR, zipsDir: ZIPS_DIR },
              () => {}
            ).then(resolve, reject),
          () => {}
        );
      });
      if (fs.existsSync(zipPath)) {
        return res.download(zipPath, `${jobId}.zip`);
      }
    }

    return res
      .status(404)
      .send('ZIP file expired after server restart. Please click "Clone site" again to generate a fresh ZIP.');
  } catch (err) {
    return res.status(500).send(`Failed to prepare ZIP download: ${err.message}`);
  }
});

// API: Start a new Website Clone Job
app.post('/api/clone', (req, res) => {
  const { url, mode = 'single', maxPages = 1 } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ success: false, error: 'Please provide a valid URL.' });
  }

  let normalizedUrl = '';
  let domainSlug = 'website';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    normalizedUrl = u.toString();
    domainSlug = u.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9-]/g, '-');
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format.' });
  }

  if (jobQueue.length >= MAX_QUEUE_LENGTH) {
    return res.status(503).json({
      success: false,
      error: `The server is busy right now (${jobQueue.length} clones waiting). Please try again in a few minutes.`,
    });
  }

  const clientIp = getClientIp(req);
  const ipJobs = jobsPerIp.get(clientIp) || 0;
  if (ipJobs >= MAX_JOBS_PER_IP) {
    return res.status(429).json({
      success: false,
      error: `You already have ${ipJobs} clone(s) running or queued. Please wait for one to finish.`,
    });
  }

  const jobId = `${domainSlug}-${Date.now().toString(36)}`;
  const effectiveMaxPages =
    mode === 'single' ? 1 : Math.min(Math.max(parseInt(maxPages, 10) || 1, 1), MAX_PAGES_LIMIT);

  jobsPerIp.set(clientIp, ipJobs + 1);
  const releaseIpSlot = () => {
    const n = (jobsPerIp.get(clientIp) || 1) - 1;
    if (n <= 0) jobsPerIp.delete(clientIp);
    else jobsPerIp.set(clientIp, n);
  };

  const jobState = {
    id: jobId,
    targetUrl: normalizedUrl,
    maxPages: effectiveMaxPages,
    pct: 2,
    pages: 0,
    assets: 0,
    title: 'Starting…',
    events: [],
    clients: new Set(),
    done: false,
    error: null,
    summary: null,
    createdAt: Date.now(),
  };
  activeJobs.set(jobId, jobState);

  const emitProgress = (eventData) => {
    if (typeof eventData.pct === 'number') jobState.pct = eventData.pct;
    if (typeof eventData.pages === 'number') jobState.pages = eventData.pages;
    if (typeof eventData.assets === 'number') jobState.assets = eventData.assets;
    if (eventData.title) jobState.title = eventData.title;

    jobState.events.push(eventData);
    const payload = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const clientRes of jobState.clients) {
      try {
        clientRes.write(payload);
      } catch {}
    }
  };

  enqueueCloneTask(
    () => {
      if (jobState.queuePosition) {
        jobState.queuePosition = 0;
        emitProgress({
          pct: 5,
          queued: false,
          queuePosition: 0,
          title: "It's your turn — starting clone…",
          log: 'A slot is free now. Your clone has started.',
          type: 'success',
        });
      }
      return runCloneJob(
        jobId,
        { ...req.body, maxPages: effectiveMaxPages },
        { sitesDir: SITES_DIR, zipsDir: ZIPS_DIR },
        emitProgress
      )
        .then((summary) => {
          releaseIpSlot();
          jobState.done = true;
          jobState.finishedAt = Date.now();
          jobState.pct = 100;
          jobState.summary = summary;
          saveToHistory(summary);
          for (const clientRes of jobState.clients) {
            try {
              clientRes.end();
            } catch {}
          }
          jobState.clients.clear();
        })
        .catch((err) => {
          releaseIpSlot();
          jobState.done = true;
          jobState.finishedAt = Date.now();
          jobState.pct = 100;
          jobState.error = err.message || 'Cloning failed';
          emitProgress({
            pct: 100,
            pages: 0,
            assets: 0,
            title: 'Cloning failed',
            log: `Error: ${jobState.error}`,
            type: 'error',
            error: jobState.error,
            done: true,
          });
          for (const clientRes of jobState.clients) {
            try {
              clientRes.end();
            } catch {}
          }
          jobState.clients.clear();
        });
    },
    (queuePos) => {
      jobState.queuePosition = queuePos;
      emitProgress({
        pct: 4,
        pages: 0,
        assets: 0,
        queued: true,
        queuePosition: queuePos,
        title: `Waiting in line — you are #${queuePos}`,
        log: `Server is busy with ${runningCount} clone(s). You are #${queuePos} in line; your clone starts automatically.`,
        type: 'info',
      });
    }
  );

  res.json({ success: true, jobId, maxPages: effectiveMaxPages });
});

// API: Poll Job Status (Fallback & companion to SSE so progress bar NEVER gets stuck if SSE drops)
app.get('/api/clone/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const jobState = activeJobs.get(jobId);

  if (!jobState) {
    // Check if it already finished and is in history.json
    try {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
      const past = history.find((h) => h.id === jobId);
      if (past) {
        return res.json({
          success: true,
          id: jobId,
          pct: 100,
          pages: past.pagesCount || 1,
          assets: past.assetsCount || 0,
          title: 'Done! Your ZIP is ready.',
          done: true,
          error: null,
          summary: past,
          eventsCount: 0,
          recentEvents: [],
        });
      }
    } catch {}
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  const fromIdx = Math.max(0, parseInt(req.query.from, 10) || 0);
  res.json({
    success: true,
    id: jobState.id,
    pct: jobState.pct,
    pages: jobState.pages,
    assets: jobState.assets,
    title: jobState.title,
    done: jobState.done,
    error: jobState.error,
    summary: jobState.summary,
    eventsCount: jobState.events.length,
    newEvents: jobState.events.slice(fromIdx),
    queued: Boolean(jobState.queuePosition),
    queuePosition: jobState.queuePosition || 0,
  });
});

// API: Real-Time SSE Progress Stream for a Clone Job (with 5s keep-alive heartbeat)
app.get('/api/clone/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  const jobState = activeJobs.get(jobId);

  if (!jobState) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Replay all events emitted so far
  for (const ev of jobState.events) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  if (jobState.done) {
    return res.end();
  }

  jobState.clients.add(res);

  // Send SSE comment heartbeat every 5s so Render/Cloudflare proxies never drop the stream
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {}
  }, 5000);

  req.on('close', () => {
    clearInterval(heartbeat);
    jobState.clients.delete(res);
  });
});

// API: Get Download History
app.get('/api/history', (req, res) => {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    res.json({ success: true, history });
  } catch (err) {
    res.json({ success: true, history: [] });
  }
});

// API: Delete a History Item
app.delete('/api/history/:id', (req, res) => {
  try {
    const { id } = req.params;
    let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    history = history.filter((item) => item.id !== id);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

    const siteFolder = path.join(SITES_DIR, id);
    const zipFile = path.join(ZIPS_DIR, `${id}.zip`);
    if (fs.existsSync(siteFolder)) fs.rmSync(siteFolder, { recursive: true, force: true });
    if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(
    `\n🚀 SiteClone Pro server running at http://localhost:${PORT} ` +
      `(maxPages=${MAX_PAGES_LIMIT}, concurrentJobs=${MAX_CONCURRENT_JOBS}, perIp=${MAX_JOBS_PER_IP}, ` +
      `retention=${RETENTION_HOURS ? `${RETENTION_HOURS}h` : 'off'})\n`
  );
});
// Large clones can take a long time; don't let Node cut long-lived requests (SSE, ZIP rebuilds)
server.requestTimeout = 0;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 61 * 1000;
