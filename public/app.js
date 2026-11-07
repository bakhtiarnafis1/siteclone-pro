// Render Lucide icons
lucide.createIcons();

// ---------- Backend Base URL Resolution ----------
const DEFAULT_BACKEND_URL = 'https://siteclone-pro-1.onrender.com';
const LOCAL_HISTORY_KEY = 'siteclone_local_history_v1';

function isLocalOrSameHostBackend() {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.onrender.com') || h.endsWith('.hf.space');
}

function getApiBase() {
  if (isLocalOrSameHostBackend()) return '';
  const configured = (window.SITECLONE_CONFIG?.BACKEND_URL || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, '');
  return configured;
}

function apiUrl(routePath) {
  if (!routePath) return '';
  if (/^https?:\/\//i.test(routePath)) return routePath;
  const base = getApiBase();
  const cleanPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${base}${cleanPath}`;
}

function getLocalHistory() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveLocalHistoryItem(summary) {
  if (!summary || !summary.id) return;
  try {
    const list = getLocalHistory().filter((item) => item.id !== summary.id);
    list.unshift(summary);
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(list.slice(0, 50)));
  } catch {}
}

function removeLocalHistoryItem(id) {
  try {
    const list = getLocalHistory().filter((item) => item.id !== id);
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(list));
  } catch {}
}

// ---------- State ----------
const state = {
  mode: 'single', // 'single' | 'full' | 'auth'
  maxPages: 10,
  viewport: 'desktop',
  isCloning: false,
  currentPreviewUrl: null,
  displayedPct: 0,
};

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const modeTabs = document.querySelectorAll('.mode-tab');
const viewportBtns = document.querySelectorAll('.viewport-btn');
const sampleUrlBtns = document.querySelectorAll('.sample-url-btn');

const cloneForm = $('clone-form');
const targetUrlInput = $('target-url');
const submitCloneBtn = $('submit-clone-btn');
const submitBtnText = $('submit-btn-text');
const pageLimitPanel = $('page-limit-panel');
const pageLimitSlider = $('page-limit-slider');
const pageLimitValue = $('page-limit-value');
const cookieAuthPanel = $('cookie-auth-panel');

const liveProgressPanel = $('live-progress-panel');
const progressStatusTitle = $('progress-status-title');
const progressStatusSubtitle = $('progress-status-subtitle');
const statPages = $('stat-pages');
const statAssets = $('stat-assets');
const statPercent = $('stat-percent');
const progressBarFill = $('progress-bar-fill');
const progressLogBox = $('progress-log-box');
const cloneCompleteActions = $('clone-complete-actions');
const completeSummaryText = $('complete-summary-text');
const btnDownloadZip = $('btn-download-zip');
const btnLivePreview = $('btn-live-preview');

const historyListContainer = $('history-list-container');
const navHistoryBadge = $('nav-history-badge');
const refreshHistoryBtn = $('refresh-history-btn');

// ---------- Mode tabs ----------
modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    modeTabs.forEach((t) => t.classList.toggle('is-active', t === tab));

    // Page slider only for multi-page modes; cookies only for login mode
    pageLimitPanel.classList.toggle('hidden', state.mode === 'single');
    cookieAuthPanel.classList.toggle('hidden', state.mode !== 'auth');
  });
});

// ---------- Page slider (1–50) ----------
pageLimitSlider.addEventListener('input', (e) => {
  state.maxPages = parseInt(e.target.value, 10);
  pageLimitValue.textContent = state.maxPages;
});

// ---------- Viewport toggle ----------
viewportBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.viewport = btn.dataset.viewport;
    viewportBtns.forEach((b) => {
      const active = b === btn;
      b.classList.toggle('bg-accent', active);
      b.classList.toggle('text-white', active);
      b.classList.toggle('text-body', !active);
    });
  });
});

// ---------- Sample URL ----------
sampleUrlBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    targetUrlInput.value = btn.dataset.sample;
    targetUrlInput.focus();
  });
});

// ---------- Preview button ----------
btnLivePreview.addEventListener('click', () => {
  if (state.currentPreviewUrl) {
    window.open(state.currentPreviewUrl, '_blank');
  }
});

// ---------- Helpers ----------
function addLog(message, type = 'info') {
  const colors = {
    info: 'text-body',
    step: 'text-accent-soft',
    success: 'text-mint',
    warn: 'text-amber-300',
    error: 'text-rose-400',
  };
  const line = document.createElement('div');
  line.className = colors[type] || colors.info;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  progressLogBox.appendChild(line);
  progressLogBox.scrollTop = progressLogBox.scrollHeight;
}

function setProgress({ pct, pages, assets, title }, maxPages) {
  const safePct = Math.min(100, Math.max(state.displayedPct, Math.round(pct || 0)));
  state.displayedPct = safePct;
  progressBarFill.style.width = `${safePct}%`;
  statPercent.textContent = `${safePct}%`;
  if (typeof pages === 'number') statPages.textContent = `${pages} / ${maxPages}`;
  if (typeof assets === 'number') statAssets.textContent = assets;
  if (title) progressStatusTitle.textContent = title;
}

function setBusy(busy) {
  state.isCloning = busy;
  submitCloneBtn.disabled = busy;
  submitBtnText.textContent = busy ? 'Cloning…' : 'Clone site';
}

function buildDownloadZipHref(jobId, targetUrl, rawZipUrl) {
  const baseZip = rawZipUrl || `/downloads/${jobId}.zip`;
  const hasQuery = baseZip.includes('?');
  const urlParam = targetUrl ? `${hasQuery ? '&' : '?'}url=${encodeURIComponent(targetUrl)}` : '';
  return apiUrl(baseZip.includes('url=') ? baseZip : `${baseZip}${urlParam}`);
}

// ---------- Submit ----------
cloneForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.isCloning) return;

  const url = targetUrlInput.value.trim();
  if (!url) return;

  const payload = {
    url,
    mode: state.mode,
    maxPages: state.mode === 'single' ? 1 : state.maxPages,
    viewport: state.viewport,
    autoScroll: $('opt-autoscroll').checked,
    rewriteLinks: $('opt-rewrite-links').checked,
    saveAssets: $('opt-save-assets').checked,
    sameDomain: $('opt-same-domain').checked,
    cookies: $('cookie-json-input').value.trim(),
  };

  // Reset progress UI
  state.displayedPct = 0;
  setBusy(true);
  liveProgressPanel.classList.remove('hidden');
  cloneCompleteActions.classList.add('hidden');
  progressLogBox.innerHTML = '';
  progressStatusSubtitle.textContent = url;
  setProgress({ pct: 3, pages: 0, assets: 0, title: 'Starting clone engine…' }, payload.maxPages);
  addLog(`Target: ${url} · mode=${payload.mode} · maxPages=${payload.maxPages} · ${payload.viewport}`, 'step');

  try {
    const res = await fetch(apiUrl('/api/clone'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!data.success) {
      setBusy(false);
      addLog(data.error || 'Failed to start', 'error');
      progressStatusTitle.textContent = 'Something went wrong';
      return;
    }

    listenToCloneProgress(data.jobId, payload);
  } catch (err) {
    setBusy(false);
    addLog(`Network error: ${err.message}`, 'error');
    progressStatusTitle.textContent = 'Connection error';
  }
});

// ---------- Resilient Real-Time SSE + Automatic Status Polling Fallback ----------
function listenToCloneProgress(jobId, payload) {
  let finished = false;
  let seenLogs = new Set();
  let source = null;
  let pollInterval = null;
  let smoothInterval = null;
  let lastServerPct = 5;
  let consecutiveErrors = 0;

  function handleEvent(ev) {
    if (!ev || finished) return;

    if (typeof ev.pct === 'number' && ev.pct > lastServerPct) {
      lastServerPct = ev.pct;
    }

    setProgress(
      {
        pct: ev.pct ?? state.displayedPct,
        pages: ev.pages,
        assets: ev.assets,
        title: ev.title,
      },
      payload.maxPages
    );

    if (ev.log && !seenLogs.has(ev.log)) {
      seenLogs.add(ev.log);
      addLog(ev.log, ev.type || 'info');
    }

    if (ev.done) {
      finished = true;
      if (source) {
        try { source.close(); } catch {}
      }
      if (pollInterval) clearInterval(pollInterval);
      if (smoothInterval) clearInterval(smoothInterval);
      setBusy(false);

      if (ev.error) {
        progressStatusTitle.textContent = 'Cloning failed';
        return;
      }

      const summary = ev.summary || {
        id: jobId,
        url: payload.url,
        domain: payload.url,
        pagesCount: ev.pages || 1,
        assetsCount: ev.assets || 0,
        sizeFormatted: 'Ready',
        previewUrl: `/preview/${jobId}/index.html`,
        zipUrl: `/downloads/${jobId}.zip?url=${encodeURIComponent(payload.url)}`,
        createdAt: new Date().toISOString(),
      };

      state.displayedPct = 100;
      progressBarFill.style.width = '100%';
      statPercent.textContent = '100%';
      progressStatusTitle.textContent = 'Done! Your ZIP is ready.';

      const rawPreview = summary.previewUrl || `/preview/${jobId}/index.html`;
      state.currentPreviewUrl = apiUrl(rawPreview);
      btnDownloadZip.href = buildDownloadZipHref(jobId, summary.url || payload.url, summary.zipUrl);
      completeSummaryText.textContent = `Ready! ${summary.pagesCount} page(s), ${summary.assetsCount} files (${summary.sizeFormatted}).`;
      cloneCompleteActions.classList.remove('hidden');

      saveLocalHistoryItem(summary);
      loadHistory();
    }
  }

  // 1. Primary SSE Stream
  try {
    source = new EventSource(apiUrl(`/api/clone/stream/${jobId}`));
    source.onmessage = (event) => {
      try {
        const ev = JSON.parse(event.data);
        consecutiveErrors = 0;
        handleEvent(ev);
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };
    source.onerror = () => {
      // Do NOT abort or freeze the UI when SSE drops! Close EventSource and let HTTP polling finish the job seamlessly.
      try { source.close(); } catch {}
    };
  } catch {}

  // 2. Bounded micro-progress (only advances at most +4% above the real server percentage so it NEVER falsely creeps to 94%!)
  smoothInterval = setInterval(() => {
    if (finished) return;
    const maxAllowedCreep = Math.min(lastServerPct + 4, 92);
    if (state.displayedPct > 2 && state.displayedPct < maxAllowedCreep) {
      setProgress({ pct: state.displayedPct + 1 }, payload.maxPages);
    }
  }, 1500);

  // 3. Companion HTTP Status Polling every 2.0s (guarantees completion even if SSE is dropped by proxy/network)
  pollInterval = setInterval(async () => {
    if (finished) return;
    try {
      const res = await fetch(apiUrl(`/api/clone/status/${jobId}`));
      if (!res.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          handleEvent({
            done: true,
            error: 'Server restarted or connection lost. Please click Clone site again.',
            log: 'Error: Backend container restarted or job expired. Please retry.',
            type: 'error',
          });
        }
        return;
      }
      consecutiveErrors = 0;
      const statusData = await res.json();
      if (!statusData || !statusData.success) return;

      if (Array.isArray(statusData.newEvents)) {
        for (const ev of statusData.newEvents) {
          handleEvent(ev);
        }
      }
      handleEvent({
        pct: statusData.pct,
        pages: statusData.pages,
        assets: statusData.assets,
        title: statusData.title,
        done: statusData.done,
        error: statusData.error,
        summary: statusData.summary,
      });
    } catch {
      consecutiveErrors++;
    }
  }, 2000);
}

// ---------- History ----------
const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadHistory() {
  let serverHistory = [];
  try {
    const res = await fetch(apiUrl('/api/history'));
    const data = await res.json();
    serverHistory = data.history || [];
  } catch (err) {
    console.error('Failed to fetch server history:', err);
  }

  // Merge server history with browser localStorage history so items never vanish when free tier sleeps
  const localHistory = getLocalHistory();
  const mergedMap = new Map();
  for (const item of [...serverHistory, ...localHistory]) {
    if (item && item.id && !mergedMap.has(item.id)) {
      mergedMap.set(item.id, item);
    }
  }
  const history = [...mergedMap.values()].slice(0, 50);
  navHistoryBadge.textContent = history.length;

  if (!history.length) {
    historyListContainer.innerHTML = `
      <div class="card rounded-2xl px-6 py-12 text-center">
        <i data-lucide="inbox" class="mx-auto h-6 w-6 text-dim"></i>
        <p class="mt-3 text-sm font-medium">Nothing here yet</p>
        <p class="mt-1 text-sm text-body">Sites you clone will show up here.</p>
      </div>`;
    lucide.createIcons();
    return;
  }

  historyListContainer.innerHTML = history
    .map((item) => {
      const id = escapeHtml(item.id);
      const previewHref = escapeHtml(apiUrl(`/preview/${item.id}/index.html`));
      const zipHref = escapeHtml(buildDownloadZipHref(item.id, item.url, item.zipUrl));
      return `
      <div class="card flex flex-col gap-4 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">${escapeHtml(item.domain || item.url)}</p>
          <p class="mt-0.5 truncate text-xs text-dim">
            ${item.pagesCount || 1} page(s) · ${item.assetsCount || 0} files · ${escapeHtml(item.sizeFormatted || '')} · ${new Date(item.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <a href="${previewHref}" target="_blank" class="btn-ghost rounded-lg px-3 py-1.5 text-xs">Preview</a>
          <a href="${zipHref}" download class="btn-primary rounded-lg px-3 py-1.5 text-xs font-medium">ZIP</a>
          <button data-delete="${id}" class="btn-ghost rounded-lg p-1.5 text-body hover:text-rose-400" title="Delete">
            <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
          </button>
        </div>
      </div>`;
    })
    .join('');
  lucide.createIcons();
}

historyListContainer.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  const id = btn.dataset.delete;
  removeLocalHistoryItem(id);
  await fetch(apiUrl(`/api/history/${id}`), { method: 'DELETE' }).catch(() => {});
  loadHistory();
});

refreshHistoryBtn.addEventListener('click', loadHistory);

// Silently wake up backend & load history on startup
fetch(apiUrl('/api/health')).catch(() => {});
loadHistory();
