const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { runCloneJob } = require('./cloner');

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

// Serve generated ZIP archives with friendly download filename
app.get('/downloads/:jobId.zip', (req, res) => {
  const { jobId } = req.params;
  const zipPath = path.join(ZIPS_DIR, `${jobId}.zip`);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).send('ZIP file not found.');
  }
  res.download(zipPath, `${jobId}.zip`);
});

// Active jobs registry for real-time Server-Sent Events (SSE)
const activeJobs = new Map();

function saveToHistory(summary) {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    history.unshift(summary);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 100), null, 2));
  } catch (err) {
    console.error('Failed to save history:', err);
  }
}

// API: Start a new Website Clone Job
app.post('/api/clone', (req, res) => {
  const { url, mode = 'single', maxPages = 1 } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ success: false, error: 'Please provide a valid URL.' });
  }

  let domainSlug = 'website';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    domainSlug = u.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9-]/g, '-');
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format.' });
  }

  const jobId = `${domainSlug}-${Date.now().toString(36)}`;
  const jobState = {
    id: jobId,
    events: [],
    clients: new Set(),
    done: false,
    error: null,
    summary: null,
  };
  activeJobs.set(jobId, jobState);

  const emitProgress = (eventData) => {
    jobState.events.push(eventData);
    const payload = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const clientRes of jobState.clients) {
      try {
        clientRes.write(payload);
      } catch {}
    }
  };

  // Run the cloning job asynchronously
  runCloneJob(
    jobId,
    req.body,
    { sitesDir: SITES_DIR, zipsDir: ZIPS_DIR },
    emitProgress
  )
    .then((summary) => {
      jobState.done = true;
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

  res.json({ success: true, jobId, maxPages: mode === 'single' ? 1 : Math.min(maxPages, 50) });
});

// API: Real-Time SSE Progress Stream for a Clone Job
app.get('/api/clone/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  const jobState = activeJobs.get(jobId);

  if (!jobState) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Replay all events emitted so far
  for (const ev of jobState.events) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  if (jobState.done) {
    return res.end();
  }

  jobState.clients.add(res);
  req.on('close', () => {
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
