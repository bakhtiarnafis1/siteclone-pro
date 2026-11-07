const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { runCloneJob, createZipArchive } = require('./cloner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint (also used by Vercel frontend to wake up Render free tier)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'siteclone-pro-backend',
    status: 'online',
    timestamp: new Date().toISOString(),
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

// Concurrency Queue (max 1 active Chromium instance at a time to prevent 512MB RAM OOM on Render Free Tier)
let runningCount = 0;
const jobQueue = [];

function processQueue() {
  if (runningCount >= 1 || jobQueue.length === 0) return;
  const nextTask = jobQueue.shift();
  if (!nextTask) return;
  runningCount++;
  nextTask().finally(() => {
    runningCount--;
    processQueue();
  });
}

function enqueueCloneTask(taskFn, onQueuedPosition) {
  if (runningCount >= 1) {
    onQueuedPosition(jobQueue.length + 1);
  }
  jobQueue.push(taskFn);
  processQueue();
}

function saveToHistory(summary) {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    const filtered = history.filter((item) => item.id !== summary.id);
    filtered.unshift(summary);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(filtered.slice(0, 100), null, 2));
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

  const jobId = `${domainSlug}-${Date.now().toString(36)}`;
  const effectiveMaxPages = mode === 'single' ? 1 : Math.min(Math.max(parseInt(maxPages, 10) || 1, 1), 50);

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
    () =>
      runCloneJob(
        jobId,
        req.body,
        { sitesDir: SITES_DIR, zipsDir: ZIPS_DIR },
        emitProgress
      )
        .then((summary) => {
          jobState.done = true;
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
          jobState.done = true;
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
        }),
    (queuePos) => {
      emitProgress({
        pct: 4,
        pages: 0,
        assets: 0,
        title: `Queued (#${queuePos} in line) — starting shortly…`,
        log: `Another clone is currently finishing. Your job is #${queuePos} in queue and will start automatically.`,
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

app.listen(PORT, () => {
  console.log(`\n🚀 SiteClone Pro MVP Server running at http://localhost:${PORT}\n`);
});
