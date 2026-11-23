// ============================================================================
// SiteClone — signed-in dashboard (single page app, hash routes)
// - No pop-up toasts: every message appears next to what it is about
//   (inside the download's own card, or under the button that was pressed).
// - Download cards are patched in place between polls, so the progress bar
//   animates smoothly instead of being redrawn.
// ============================================================================
(function () {
  const { api, apiUrl, session, escapeHtml: esc, formatBytes } = window.SC;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $('#view');

  const state = {
    user: session.user(),
    allowance: null,
    config: { pageOptions: [10, 25, 50, 100], maxPages: 100, periodDays: 30 },
    downloads: [],
    downloadsLoaded: false,
    adminDownloads: [],
    route: 'dashboard',
    pollTimer: null,
    adminTimer: null,
    historyFilter: 'all',
    historySearch: '',
    notes: {}, // downloadId -> { text, type, t }
    anim: {}, // downloadId -> { shown, target, cap, active }
    form: {
      mode: 'single_page',
      url: '',
      maxPages: 10,
      customPages: '',
      extraUrls: '',
      cookies: '',
      localStorage: '',
      authorized: false,
      stripScripts: false,
      ignoreRobots: false,
      viewport: 'desktop',
      autoScroll: true,
      submitting: false,
      error: '',
    },
  };

  const isAdmin = () => state.user?.role === 'admin';
  const ACTIVE = ['queued', 'running', 'processing'];
  const isActive = (d) => ACTIVE.includes(d.status);
  const icons = () => window.lucide && window.lucide.createIcons();
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const fmtDuration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  // --------------------------------------------------------------------------
  // Inline messages (instead of pop-ups)
  // --------------------------------------------------------------------------
  function note(id, text, type = 'info') {
    state.notes[id] = { text, type, t: Date.now() };
    refreshLists();
  }
  function clearNote(id) {
    delete state.notes[id];
  }
  /** Short message next to a button/form; fades after a few seconds */
  function flash(el, text, type = 'ok', ms = 4000) {
    if (!el) return;
    el.textContent = text;
    el.className = `inline-msg ${type}`;
    el.style.opacity = '1';
    clearTimeout(el._t);
    if (ms) el._t = setTimeout(() => (el.style.opacity = '0'), ms);
  }
  /** Two-step button: first click arms it ("Click again to confirm"), second click within 4 s confirms */
  function armed(btn, confirmLabel) {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      return true;
    }
    btn.dataset.armed = '1';
    btn.dataset.orig = btn.innerHTML;
    btn.classList.add('is-confirm');
    btn.innerHTML = `<i data-lucide="alert-triangle" class="h-3.5 w-3.5"></i>${confirmLabel}`;
    icons();
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      if (!btn.isConnected) return;
      btn.dataset.armed = '';
      btn.classList.remove('is-confirm');
      btn.innerHTML = btn.dataset.orig;
      icons();
    }, 4000);
    return false;
  }

  // --------------------------------------------------------------------------
  // Sidebar, user menu
  // --------------------------------------------------------------------------
  function updateSidebar() {
    const u = state.user;
    if (u) {
      $('#user-name').textContent = u.name || u.email;
      $('#user-email').textContent = u.email;
      $('#user-avatar').textContent = (u.name || u.email || '?').trim().charAt(0).toUpperCase();
      $('#nav-admin').classList.toggle('hidden', u.role !== 'admin');
    }
    const a = state.allowance;
    if (a) {
      $('#credits-text').innerHTML = a.unlimited
        ? 'Unlimited'
        : `${a.remaining}<span class="text-sm font-normal text-dim"> / ${a.limit}</span>`;
      $('#credits-plan').textContent = a.unlimited ? `${a.plan} account` : `${a.plan} plan · resets ${fmtDay(a.resetsAt)}`;
      $('#credits-bar').style.width = a.unlimited ? '100%' : `${a.limit ? Math.max(0, Math.min(100, (a.remaining / a.limit) * 100)) : 0}%`;
    }
    $('#nav-live').classList.toggle('hidden', !state.downloads.some(isActive));
    $$('.nav-link').forEach((l) => l.classList.toggle('is-active', l.dataset.route === state.route));
  }

  $('#user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#user-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('#user-menu').classList.add('hidden'));
  $('#logout-btn').addEventListener('click', async () => {
    await session.signOut();
    location.href = '/login';
  });

  const sidebar = $('#sidebar');
  const backdrop = $('#sidebar-backdrop');
  function closeSidebar() {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  }
  $('#menu-btn').addEventListener('click', () => {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  });
  backdrop.addEventListener('click', closeSidebar);

  // --------------------------------------------------------------------------
  // Data & polling
  // --------------------------------------------------------------------------
  async function loadDownloads() {
    const prev = new Map(state.downloads.map((d) => [d.id, d.status]));
    const data = await api('/api/website-downloads');
    state.downloads = data.downloads || [];
    state.allowance = data.allowance || state.allowance;
    state.downloadsLoaded = true;
    // status changes become a message inside that download's card
    for (const d of state.downloads) {
      const before = prev.get(d.id);
      if (!before || before === d.status) continue;
      if (d.status === 'completed') {
        note(
          d.id,
          d.stopped_early
            ? `Stopped early — your ZIP with ${plural(d.pages || 0, 'page')} is ready.`
            : `Done — your ZIP is ready${d.zip_size_bytes ? ` (${formatBytes(d.zip_size_bytes)})` : ''}. Click Download ZIP.`,
          'ok'
        );
      } else if (d.status === 'running' && before === 'queued') {
        note(d.id, 'Your turn — the download has started.', 'info');
      } else if (d.status === 'processing') {
        note(d.id, 'All pages are captured. Packing the ZIP…', 'info');
      } else if (d.status === 'failed') {
        clearNote(d.id);
      }
    }
    updateSidebar();
    ensurePolling();
  }

  function ensurePolling() {
    const anyActive = state.downloads.some(isActive);
    if (anyActive && !state.pollTimer) {
      state.pollTimer = setInterval(pollDownloads, 2000);
    } else if (!anyActive && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollDownloads() {
    try {
      await loadDownloads();
      refreshLists();
    } catch {}
  }

  // Re-render only the download lists (keeps form inputs untouched)
  function refreshLists() {
    patchList($('#recent-list'), state.downloads.slice(0, 5), { empty: 'downloader' });
    patchList($('#dash-recent'), state.downloads.slice(0, 5), { empty: 'dashboard', compact: true });
    if ($('#history-list')) renderHistoryList();
    if ($('#admin-live')) patchList($('#admin-live'), state.adminDownloads.filter(isActive), { empty: 'admin', admin: true });
    const stats = $('#dash-stats');
    if (stats) stats.innerHTML = dashStatsHtml();
    const banner = $('#allowance-banner');
    if (banner) banner.innerHTML = allowanceBannerHtml();
    updateSidebar();
    icons();
  }

  // --------------------------------------------------------------------------
  // Download card
  // --------------------------------------------------------------------------
  const STATUS = {
    queued: { label: 'Waiting', icon: 'clock', cls: 'text-body bg-white/[0.06]' },
    running: { label: 'Downloading', icon: 'loader-2', cls: 'text-accent-soft bg-accent/15', spin: true },
    processing: { label: 'Packing ZIP', icon: 'package', cls: 'text-accent-soft bg-accent/15' },
    completed: { label: 'Ready', icon: 'check-circle-2', cls: 'text-mint bg-mint/10' },
    failed: { label: 'Failed', icon: 'alert-circle', cls: 'text-rose-300 bg-rose-500/10' },
  };
  const MODE_LABEL = { single_page: 'Single page', full_website: 'Full website', cookie_export: 'Backend HTML UI' };
  const ERROR_HINTS = {
    LOGIN_FAILED: 'Sign in to the website again in your browser, export fresh cookies with Cookie-Editor (Export → JSON) and try again.',
    INVALID_INPUT: 'Check the website address, or paste the cookie export again (Cookie-Editor → Export → JSON).',
    ROBOTS_DISALLOWED: 'If you are allowed to copy this website, tick “Ignore robots.txt” under More options and try again.',
    SERVER_RESTART: 'Start the download again — it was not counted.',
  };
  const STEPS = ['Queued', 'Crawling pages', 'Packing ZIP', 'Ready'];
  const stepIndex = (d) => ({ queued: 0, running: 1, processing: 2, completed: 4 }[d.status] ?? 1);

  // Text shown next to the big percentage
  function stageText(d) {
    if (d.status === 'queued') return d.queue_position ? `Waiting in line — you are #${d.queue_position}` : 'Starting…';
    if (d.stop_requested_at && d.status === 'running') return 'Stopping — packing the pages saved so far…';
    return d.progress?.title || 'Working…';
  }
  const savedText = (d) => (d.mode === 'single_page' ? `${d.pages || 0}<small> / 1</small>` : `${d.pages || 0}<small> / ${d.max_pages}</small>`);
  const foundText = (d) => (d.pages_found ? `${d.pages_found.toLocaleString()}` : '<small>counting…</small>');
  const elapsedOf = (d) => fmtDuration((d.finished_at ? new Date(d.finished_at) : new Date()) - new Date(d.created_at));
  const lastLogOf = (d) => (d.logs || []).slice(-1)[0]?.text || '';

  // Things that change the card's layout/buttons; anything else is patched in place
  const sigOf = (d, opts) =>
    [d.status, d.zip_available, d.preview_available, d.library_id, Boolean(d.stop_requested_at), d.error_code, state.notes[d.id]?.t || 0, opts.compact, opts.admin].join('|');

  const RING_C = 2 * Math.PI * 16; // circumference of the progress ring
  const ringHtml = (d) => {
    const pct = Math.floor(state.anim[d.id]?.shown ?? d.progress?.pct ?? 0);
    return `<span class="pring ${d.status === 'queued' ? 'is-waiting' : ''}" data-f="ring" title="${esc(stageText(d))}">
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="16" class="pring-track" />
        <circle cx="20" cy="20" r="16" class="pring-value" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - pct / 100)}" />
      </svg>
      <span class="pring-icon"><i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i></span>
    </span>`;
  };

  function actionsHtml(d, { admin = false } = {}) {
    const a = [];
    if (isActive(d)) a.push(ringHtml(d));
    if (d.status === 'queued') {
      a.push(`<button data-action="stop" data-id="${d.id}" class="btn-stop flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"><i data-lucide="circle-stop" class="h-3.5 w-3.5"></i>Stop</button>`);
    } else if (d.status === 'running') {
      a.push(
        `<button data-action="stop" data-id="${d.id}" class="btn-stop flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold" ${d.stop_requested_at ? 'disabled' : ''}>
          <i data-lucide="${d.stop_requested_at ? 'loader-2' : 'circle-stop'}" class="h-3.5 w-3.5 ${d.stop_requested_at ? 'spin' : ''}"></i>${d.stop_requested_at ? 'Stopping…' : 'Stop &amp; download'}</button>`
      );
    } else if (d.status === 'processing') {
      a.push(`<button class="btn-stop flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold" disabled title="All pages are saved — the ZIP is seconds away"><i data-lucide="loader-2" class="spin h-3.5 w-3.5"></i>Finishing…</button>`);
    }
    if (d.status === 'completed' && d.zip_available) {
      a.push(`<button data-action="zip" data-id="${d.id}" class="btn-primary flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold"><i data-lucide="download" class="h-3.5 w-3.5"></i>Download ZIP</button>`);
      if (d.preview_available) {
        a.push(`<button data-action="preview" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"><i data-lucide="eye" class="h-3.5 w-3.5"></i>Preview</button>`);
      }
      if (isAdmin() && !d.library_id && !admin) {
        a.push(`<button data-action="publish" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium" title="Make this ZIP available to every user in the Website Library"><i data-lucide="library" class="h-3.5 w-3.5"></i>Add to library</button>`);
      }
    }
    if (d.status === 'completed' && !d.zip_available) a.push(`<span class="text-xs text-dim">ZIP expired — download again</span>`);
    if (d.status === 'failed' && !admin) {
      a.push(`<button data-action="retry" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"><i data-lucide="rotate-ccw" class="h-3.5 w-3.5"></i>Try again</button>`);
    }
    if (!admin) {
      const active = isActive(d);
      a.push(
        `<button data-action="delete" data-id="${d.id}" class="btn-ghost flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-dim hover:text-rose-300" aria-label="${active ? 'Cancel download' : 'Delete download'}" title="${active ? 'Cancel (not counted)' : 'Delete'}">
          <i data-lucide="${active ? 'x' : 'trash-2'}" class="h-4 w-4"></i></button>`
      );
    }
    return a.join('');
  }

  function noteHtml(d) {
    const n = state.notes[d.id];
    if (!n) return '';
    const icon = { ok: 'check-circle-2', info: 'info', warn: 'alert-triangle', bad: 'alert-circle' }[n.type] || 'info';
    return `<div class="notice ${n.type} mt-3"><i data-lucide="${icon}" class="mt-0.5 h-3.5 w-3.5 shrink-0"></i><span class="flex-1">${esc(n.text)}</span>
      <button data-action="dismiss" data-id="${d.id}" class="-mr-1 opacity-60 hover:opacity-100" aria-label="Dismiss"><i data-lucide="x" class="h-3.5 w-3.5"></i></button></div>`;
  }

  function cardHtml(d, opts = {}) {
    const { compact = false, admin = false } = opts;
    const st = STATUS[d.status] || STATUS.queued;
    const active = isActive(d);
    const label = d.status === 'queued' && d.queue_position ? `Waiting · #${d.queue_position}` : st.label;
    const sIdx = stepIndex(d);
    const head = `
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge ${st.cls}">${active && d.status !== 'queued' ? '<i data-lucide="refresh-cw" class="spin h-3 w-3"></i>' : `<i data-lucide="${st.icon}" class="h-3.5 w-3.5"></i>`}${esc(label)}</span>
            <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" class="min-w-0 max-w-full truncate text-[14px] font-semibold hover:underline">${esc(d.url)}</a>
            ${d.login_method ? `<span class="badge bg-white/[0.05] text-body"><i data-lucide="lock" class="h-3 w-3"></i>Signed in</span>` : ''}
            ${d.library_id ? `<span class="badge bg-accent/10 text-accent-soft"><i data-lucide="library" class="h-3 w-3"></i>In library</span>` : ''}
          </div>
          <p class="mt-1.5 text-xs text-dim">${esc(
            [
              admin && d.user_email ? d.user_email : null,
              `${fmtDate(d.created_at)}`,
              MODE_LABEL[d.mode],
              d.mode === 'single_page' ? null : `up to ${d.max_pages} pages`,
              d.options?.stripScripts ? 'no JavaScript' : null,
            ]
              .filter(Boolean)
              .join(' · ')
          )}</p>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">${actionsHtml(d, opts)}</div>
      </div>`;

    if (active) {
      const pct = Math.floor(state.anim[d.id]?.shown ?? d.progress?.pct ?? 0);
      return `
        <li class="dl-card is-live rounded-2xl p-4 sm:p-5" data-dl-id="${d.id}">
          ${head}
          <div class="mt-4 flex items-end justify-between gap-4">
            <p class="font-display text-[28px] font-semibold leading-none tabular-nums"><span data-f="pct">${pct}</span><span class="text-base text-dim">%</span></p>
            <p class="min-w-0 truncate text-right text-[12.5px] text-body" data-f="stage">${esc(stageText(d))}</p>
          </div>
          <div class="pbar mt-3 ${d.status === 'queued' ? 'is-waiting' : ''}" data-f="bar"><div class="pbar-fill" style="width:${d.status === 'queued' ? 100 : pct}%"></div></div>
          ${
            compact
              ? ''
              : `<div class="steps mt-4">${STEPS.map(
                  (s, i) => `<div class="step ${i < sIdx ? 'is-done' : i === sIdx ? 'is-now' : ''}"><span class="tick"></span>${s}</div>`
                ).join('')}</div>`
          }
          <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="stat"><p class="stat-k"><i data-lucide="radar" class="h-3 w-3"></i>Pages found</p><p class="stat-v" data-f="found">${foundText(d)}</p></div>
            <div class="stat"><p class="stat-k"><i data-lucide="file-check-2" class="h-3 w-3"></i>Pages saved</p><p class="stat-v" data-f="saved">${savedText(d)}</p></div>
            <div class="stat"><p class="stat-k"><i data-lucide="boxes" class="h-3 w-3"></i>Files</p><p class="stat-v" data-f="assets">${d.assets ?? 0}</p></div>
            <div class="stat"><p class="stat-k"><i data-lucide="timer" class="h-3 w-3"></i>Elapsed</p><p class="stat-v" data-f="elapsed" data-since="${esc(d.created_at)}">${elapsedOf(d)}</p></div>
          </div>
          ${compact ? '' : `<p class="mt-3 truncate rounded-lg bg-black/25 px-3 py-2 font-mono text-[11px] text-dim" data-f="log">${esc(lastLogOf(d) || 'Waiting for the engine…')}</p>`}
          ${noteHtml(d)}
        </li>`;
    }

    // Finished (completed / failed)
    const found = d.pages_found && d.mode !== 'single_page' && d.pages_found > (d.pages || 0);
    return `
      <li class="dl-card ${d.status === 'completed' ? 'is-done' : ''} rounded-2xl p-4 sm:p-5" data-dl-id="${d.id}">
        ${head}
        ${
          d.status === 'completed'
            ? `<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-body">
                <span class="flex items-center gap-1.5"><i data-lucide="file-check-2" class="h-3.5 w-3.5 text-mint"></i>${plural(d.pages || 0, 'page')} saved</span>
                ${d.pages_found ? `<span class="flex items-center gap-1.5"><i data-lucide="radar" class="h-3.5 w-3.5 text-dim"></i>${d.pages_found.toLocaleString()} found on the site</span>` : ''}
                ${d.assets != null ? `<span class="flex items-center gap-1.5"><i data-lucide="boxes" class="h-3.5 w-3.5 text-dim"></i>${plural(d.assets, 'file')}</span>` : ''}
                ${d.zip_size_bytes ? `<span class="flex items-center gap-1.5"><i data-lucide="file-archive" class="h-3.5 w-3.5 text-dim"></i>${formatBytes(d.zip_size_bytes)}</span>` : ''}
                ${d.finished_at ? `<span class="flex items-center gap-1.5"><i data-lucide="timer" class="h-3.5 w-3.5 text-dim"></i>${elapsedOf(d)}</span>` : ''}
                ${d.zip_available && d.zip_expires_at ? `<span class="flex items-center gap-1.5" title="ZIP files are deleted automatically after 24 hours"><i data-lucide="hourglass" class="h-3.5 w-3.5 text-dim"></i>Available until ${esc(fmtDate(d.zip_expires_at))}</span>` : ''}
                ${d.stopped_early ? `<span class="badge bg-amber-300/10 text-amber-200">Stopped early</span>` : ''}
              </div>
              ${!compact && found ? `<p class="mt-2 text-xs text-dim">This website has more pages than your limit. Choose a higher “Maximum pages” to save more.</p>` : ''}`
            : `<p class="mt-3 text-[13px] text-rose-300">${esc(d.error_message || 'The download failed.')}</p>
               ${ERROR_HINTS[d.error_code] && !String(d.error_message || '').includes('try again') ? `<p class="mt-1 text-xs text-dim">${esc(ERROR_HINTS[d.error_code])}</p>` : ''}
               ${d.error_code !== 'STOPPED' ? `<p class="mt-1 text-[11px] text-dim">A download that fails is not counted.</p>` : ''}`
        }
        ${noteHtml(d)}
      </li>`;
  }

  function emptyHtml(empty) {
    if (empty === 'admin') return `<li class="card rounded-2xl px-6 py-8 text-center text-sm text-body">Nothing is downloading right now.</li>`;
    return `<li class="card rounded-2xl px-6 py-12 text-center">
      <span class="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.04]"><i data-lucide="inbox" class="h-5 w-5 text-dim"></i></span>
      <p class="mt-4 text-sm font-semibold">No downloads yet</p>
      <p class="mt-1 text-sm text-body">${empty === 'dashboard' ? 'Start your first download from the Website Downloader.' : 'Enter a website address above to download your first site.'}</p>
      ${empty === 'dashboard' ? `<a href="#downloader" class="btn-primary mt-5 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold"><i data-lucide="plus" class="h-4 w-4"></i>New download</a>` : ''}
    </li>`;
  }

  /** Keyed update: unchanged cards keep their DOM (smooth bar), only live values are patched */
  function patchList(ul, list, opts = {}) {
    if (!ul) return;
    if (!state.downloadsLoaded && !opts.admin) {
      ul.innerHTML = `<li class="card animate-pulse rounded-2xl p-5"><div class="h-3 w-1/2 rounded bg-white/[0.06]"></div><div class="mt-3 h-3 w-1/3 rounded bg-white/[0.04]"></div></li>`;
      return;
    }
    if (!list.length) {
      ul.innerHTML = emptyHtml(opts.empty);
      return;
    }
    const existing = new Map($$(':scope > li[data-dl-id]', ul).map((li) => [li.dataset.dlId, li]));
    [...ul.children].forEach((c) => !c.dataset.dlId && c.remove());
    const wanted = new Set(list.map((d) => d.id));
    for (const [id, li] of existing) if (!wanted.has(id)) li.remove();

    let prev = null;
    for (const d of list) {
      syncAnim(d);
      const sig = sigOf(d, opts);
      let li = existing.get(d.id);
      if (li && li.dataset.sig === sig) {
        patchLive(li, d);
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = cardHtml(d, opts).trim();
        const fresh = tmp.firstElementChild;
        fresh.dataset.sig = sig;
        if (li) li.replaceWith(fresh);
        li = fresh;
      }
      const expectedPos = prev ? prev.nextElementSibling : ul.firstElementChild;
      if (expectedPos !== li) ul.insertBefore(li, expectedPos);
      prev = li;
    }
  }

  function patchLive(li, d) {
    const set = (f, html) => {
      const el = li.querySelector(`[data-f="${f}"]`);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    set('stage', esc(stageText(d)));
    set('found', foundText(d));
    set('saved', savedText(d));
    set('assets', String(d.assets ?? 0));
    set('log', esc(lastLogOf(d) || 'Waiting for the engine…'));
    const steps = li.querySelectorAll('.step');
    const sIdx = stepIndex(d);
    steps.forEach((s, i) => {
      s.classList.toggle('is-done', i < sIdx);
      s.classList.toggle('is-now', i === sIdx);
    });
  }

  // Smooth progress: jump to each new server value with an eased transition, then creep
  // slowly toward the next milestone so the bar never looks frozen.
  function syncAnim(d) {
    const a = state.anim[d.id] || (state.anim[d.id] = { shown: d.progress?.pct || 0 });
    const target = d.status === 'completed' ? 100 : Math.max(0, Math.min(100, d.progress?.pct || 0));
    a.target = Math.max(a.target || 0, target);
    a.active = isActive(d);
    a.waiting = d.status === 'queued';
    a.cap =
      d.status === 'processing'
        ? Math.min(a.target + (a.target < 93 ? 3 : 1.5), 99.6)
        : d.status === 'running'
        ? Math.min(a.target + 2.5, 97.5) // the server sends a fresh time-based estimate about every second
        : a.target;
  }
  setInterval(() => {
    for (const [id, a] of Object.entries(state.anim)) {
      if (a.shown < a.target) a.shown = Math.min(a.target, a.shown + 2); // catch up at most ~8 % per second
      else if (a.active && !a.waiting && a.shown < a.cap) a.shown += Math.max(0.04, (a.cap - a.shown) * 0.02);
      $$(`li[data-dl-id="${id}"]`).forEach((li) => {
        const bar = li.querySelector('[data-f="bar"]');
        if (!bar) return;
        bar.classList.toggle('is-waiting', Boolean(a.waiting));
        const fill = bar.firstElementChild;
        const w = a.waiting ? 100 : a.shown;
        if (fill && fill.style.width !== `${w.toFixed(2)}%`) fill.style.width = `${w.toFixed(2)}%`;
        const ringVal = li.querySelector('[data-f="ring"] .pring-value');
        if (ringVal) ringVal.setAttribute('stroke-dashoffset', String(RING_C * (1 - (a.waiting ? 0 : a.shown) / 100)));
        const pctEl = li.querySelector('[data-f="pct"]');
        const p = String(Math.floor(a.waiting ? 0 : a.shown));
        if (pctEl && pctEl.textContent !== p) pctEl.textContent = p;
      });
    }
    // live elapsed clocks
    $$('[data-f="elapsed"][data-since]').forEach((el) => {
      const t = fmtDuration(Date.now() - new Date(el.dataset.since));
      if (el.textContent !== t) el.textContent = t;
    });
  }, 250);

  // Actions on any download card (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !view.contains(btn)) return;
    const id = btn.dataset.id;
    const d = state.downloads.find((x) => x.id === id) || state.adminDownloads.find((x) => x.id === id);
    const action = btn.dataset.action;

    try {
      if (action === 'dismiss') {
        clearNote(id);
        refreshLists();
      } else if (action === 'stop') {
        const label = d?.status === 'queued' ? 'Confirm stop' : 'Stop now?';
        if (!armed(btn, label)) return;
        btn.disabled = true;
        const data = await api(`/api/website-downloads/${id}/stop`, { method: 'POST' });
        if (d) Object.assign(d, data.download);
        note(
          id,
          data.download.status === 'failed'
            ? 'Stopped — it was taken out of the line and not counted.'
            : 'Stopping — no more pages will be downloaded. Your ZIP with the pages saved so far will be ready in a moment.',
          'warn'
        );
        await loadDownloads().catch(() => {});
        if (state.route === 'admin') await loadAdminDownloads().catch(() => {});
        refreshLists();
      } else if (action === 'delete') {
        const active = d && isActive(d);
        if (!armed(btn, active ? 'Cancel?' : 'Delete?')) return;
        btn.disabled = true;
        await api(`/api/website-downloads/${id}`, { method: 'DELETE' });
        state.downloads = state.downloads.filter((x) => x.id !== id);
        delete state.anim[id];
        clearNote(id);
        await loadDownloads().catch(() => {});
        refreshLists();
      } else if (action === 'zip') {
        btn.disabled = true;
        const data = await api(`/api/website-downloads/${id}/link`, { method: 'POST', body: { kind: 'zip' } });
        location.href = apiUrl(data.url);
        setTimeout(() => (btn.disabled = false), 2000);
      } else if (action === 'preview') {
        const win = window.open('about:blank', '_blank');
        try {
          const data = await api(`/api/website-downloads/${id}/link`, { method: 'POST', body: { kind: 'preview' } });
          if (win) win.location.href = apiUrl(data.url);
          else location.href = apiUrl(data.url);
        } catch (err) {
          if (win) win.close();
          throw err;
        }
      } else if (action === 'publish') {
        btn.disabled = true;
        await api('/api/library', { method: 'POST', body: { downloadId: id, title: d?.domain || '' } });
        note(id, 'Added to the Website Library — every user can now download it for free.', 'ok');
        await loadDownloads();
        refreshLists();
      } else if (action === 'retry') {
        Object.assign(state.form, {
          mode: d.mode,
          url: d.url,
          maxPages: d.max_pages > 1 ? d.max_pages : state.form.maxPages,
          stripScripts: Boolean(d.options?.stripScripts),
          ignoreRobots: d.error_code === 'ROBOTS_DISALLOWED' ? state.form.ignoreRobots : Boolean(d.options?.ignoreRobots),
          error: d.mode === 'cookie_export' ? 'Paste a fresh cookie export to try again.' : '',
        });
        location.hash = '#downloader';
      }
    } catch (err) {
      btn.disabled = false;
      if (id) note(id, err.message, 'bad');
    }
  });

  // --------------------------------------------------------------------------
  // Allowance banner & stats
  // --------------------------------------------------------------------------
  function allowanceBannerHtml() {
    const a = state.allowance;
    if (!a) return '';
    if (a.unlimited) {
      return `<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mint/10"><i data-lucide="infinity" class="h-4 w-4 text-mint"></i></span>
        <span><span class="font-semibold text-white">${esc(a.plan)} · unlimited downloads</span><span class="block text-xs text-dim">A download that fails is never counted.</span></span>`;
    }
    const pct = a.limit ? Math.round((a.remaining / a.limit) * 100) : 0;
    return `<span class="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style="background: conic-gradient(#5fd6d7 ${pct * 3.6}deg, rgba(255,255,255,.08) 0)"><span class="absolute inset-[3px] rounded-full bg-ink-900"></span></span>
      <span class="flex-1"><span class="font-semibold text-white">${esc(a.plan)} plan · ${a.remaining} of ${a.limit} downloads left</span>
      <span class="block text-xs text-dim">Resets ${fmtDay(a.resetsAt)}. A download that fails is not counted.</span></span>
      ${a.remaining <= 0 ? '<a href="#settings" class="btn-ghost rounded-lg px-3 py-1.5 text-xs font-semibold">Plan details</a>' : ''}`;
  }

  function dashStatsHtml() {
    const done = state.downloads.filter((d) => d.status === 'completed');
    const pages = done.reduce((n, d) => n + (d.pages || 0), 0);
    const a = state.allowance;
    const cards = [
      { icon: 'cloud-download', label: 'Websites downloaded', value: done.length },
      { icon: 'file-check-2', label: 'Pages saved', value: pages.toLocaleString() },
      { icon: 'loader-2', label: 'In progress', value: state.downloads.filter(isActive).length },
      { icon: 'coins', label: 'Downloads left', value: !a ? '—' : a.unlimited ? '∞' : a.remaining },
    ];
    return cards
      .map(
        (c) => `<div class="card rounded-2xl p-5">
          <div class="flex items-center gap-2 text-[13px] text-body"><i data-lucide="${c.icon}" class="h-4 w-4 text-accent-soft"></i>${c.label}</div>
          <p class="mt-2 font-display text-3xl font-semibold tracking-tight">${c.value}</p>
        </div>`
      )
      .join('');
  }

  const pageHeader = (icon, title, subtitle, extra = '') => `
    <div class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="flex items-center gap-3 text-[26px] font-semibold sm:text-3xl"><span class="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15"><i data-lucide="${icon}" class="h-[18px] w-[18px] text-accent-soft"></i></span>${title}</h1>
        <p class="mt-2.5 max-w-2xl text-[14px] text-body">${subtitle}</p>
      </div>
      ${extra}
    </div>`;

  // --------------------------------------------------------------------------
  // Views
  // --------------------------------------------------------------------------
  function renderDashboard() {
    const first = (state.user?.name || '').split(' ')[0] || 'there';
    view.innerHTML = `
      ${pageHeader('layout-dashboard', `Welcome back, ${esc(first)}`, 'Download any website as a ZIP of HTML files, ready to open offline.',
        `<a href="#downloader" class="btn-primary flex items-center gap-1.5 self-start rounded-lg px-4 py-2 text-sm font-semibold sm:self-auto"><i data-lucide="plus" class="h-4 w-4"></i>New download</a>`)}
      <div id="dash-stats" class="grid grid-cols-2 gap-4 lg:grid-cols-4">${dashStatsHtml()}</div>

      <section class="mt-10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Recent downloads</h2>
          <a href="#history" class="flex items-center gap-1 text-sm text-body hover:text-white">View all<i data-lucide="arrow-right" class="h-4 w-4"></i></a>
        </div>
        <ul id="dash-recent" class="space-y-3"></ul>
      </section>

      <section class="mt-10">
        <h2 class="mb-4 text-lg font-semibold">Quick actions</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          ${[
            ['#downloader', 'cloud-download', 'Website Downloader', 'Download a single page, a whole website, or your own signed-in pages.'],
            ['#library', 'library', 'Website Library', 'Websites already downloaded — free for every user.'],
            ['#history', 'history', 'History', 'Download your previous ZIP files again.'],
            ['#tutorial', 'graduation-cap', 'Tutorial', 'Learn the three download modes step by step.'],
          ]
            .map(
              ([href, icon, title, text]) => `<a href="${href}" class="card group flex items-start gap-4 rounded-2xl p-5 transition hover:border-white/[0.14]">
                <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15"><i data-lucide="${icon}" class="h-5 w-5 text-accent-soft"></i></span>
                <span class="flex-1"><span class="block font-semibold">${title}</span><span class="mt-1 block text-sm text-body">${text}</span></span>
                <i data-lucide="arrow-up-right" class="h-4 w-4 text-dim transition group-hover:text-white"></i>
              </a>`
            )
            .join('')}
        </div>
      </section>`;
    patchList($('#dash-recent'), state.downloads.slice(0, 5), { empty: 'dashboard', compact: true });
  }

  // ---------- Website Downloader ----------
  const MODES = [
    { id: 'single_page', icon: 'file', title: 'Single Page', text: 'Just the page you enter — its links are not followed.' },
    { id: 'full_website', icon: 'globe', title: 'Full Frontend Website', text: 'Every public page of the site, up to your limit — what anyone sees without logging in.' },
    {
      id: 'cookie_export',
      icon: 'shield-check',
      title: 'Backend HTML UI',
      text: 'Pages you only see after logging in to an account that is yours or that you may access: dashboards, admin panels, members’ areas. Uses your cookie export.',
    },
  ];

  const LS_COMMAND = 'copy(JSON.stringify(localStorage))';

  function cookieCheck() {
    const v = state.form.cookies.trim();
    if (!v) return null;
    if (!v.startsWith('[')) return 'This does not look like the JSON export. It should start with [ — in Cookie-Editor choose Export → JSON and paste again.';
    try {
      const arr = JSON.parse(v);
      if (!Array.isArray(arr) || !arr.length) return 'The export is empty. Make sure you are signed in on that website, then export again.';
      if (!arr.every((c) => c && c.name !== undefined && c.value !== undefined)) return 'Each cookie needs a name and a value. Copy the export again.';
    } catch {
      return 'The export is incomplete. Copy everything Cookie-Editor exported — from the first [ to the last ].';
    }
    return null;
  }

  function lsCheck() {
    const v = state.form.localStorage.trim();
    if (!v) return null;
    if (!v.startsWith('{')) {
      return v.startsWith('"')
        ? 'This is the value of one entry, without its name. Use the command above instead — it copies every entry with its name.'
        : 'This should start with { — run the command above in the website’s console and paste the result.';
    }
    try {
      JSON.parse(v);
    } catch {
      return 'This is not complete. Run the command again and paste everything it copied.';
    }
    return null;
  }

  function effectivePages() {
    const f = state.form;
    if (f.mode === 'single_page') return 1;
    if (f.maxPages === 'custom') return parseInt(f.customPages, 10) || 0;
    return f.maxPages;
  }

  function disabledReason() {
    const f = state.form;
    const a = state.allowance;
    if (a && !a.unlimited && a.remaining <= 0) return 'No downloads left on your plan this period.';
    if (!f.url.trim()) return f.mode === 'single_page' ? 'Enter a page address to start.' : 'Enter a website address to start.';
    if (f.mode !== 'single_page') {
      const n = effectivePages();
      if (!n || n < 1 || n > state.config.maxPages) return `Enter a number of pages from 1 to ${state.config.maxPages.toLocaleString()}.`;
    }
    if (f.mode === 'cookie_export') {
      if (!f.cookies.trim()) return 'Paste the cookie export to start.';
      if (cookieCheck()) return 'Fix the cookie export to start.';
      if (lsCheck()) return 'Fix the local storage data or leave it empty.';
      if (!f.authorized) return 'Confirm the account is yours to start.';
    }
    if (f.submitting) return 'Starting…';
    return null;
  }

  function updateSubmitState() {
    const reason = disabledReason();
    const btn = $('#dl-submit');
    if (!btn) return;
    btn.disabled = Boolean(reason);
    const reasonEl = $('#dl-reason');
    if (state.form.error) {
      reasonEl.textContent = state.form.error;
      reasonEl.className = 'text-rose-300';
    } else {
      reasonEl.textContent = reason && !state.form.submitting ? reason : '';
      reasonEl.className = 'text-amber-300/90';
    }
    $('#dl-submit-text').textContent = state.form.submitting ? 'Starting…' : 'Download website';
  }

  function cookiePanelHtml() {
    const f = state.form;
    const cErr = cookieCheck();
    const lErr = lsCheck();
    return `
      <div class="subtle space-y-5 rounded-2xl p-4 sm:p-5">
        <div>
          <p class="flex items-center gap-2 text-sm font-semibold"><i data-lucide="lightbulb" class="h-4 w-4 text-amber-300"></i>Sign in with your own session</p>
          <ol class="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-body">
            <li>Open the website — an account that is yours, or that you are authorised to access — and sign in as usual.</li>
            <li>Install the free <a class="text-accent-soft underline" href="https://cookie-editor.com" target="_blank" rel="noopener">Cookie-Editor</a> browser extension.</li>
            <li>On that website, click the Cookie-Editor icon in the toolbar, then <span class="font-semibold text-white">Export</span> → <span class="font-semibold text-white">JSON</span> (not “Header String” or “Netscape”). It is copied for you.</li>
            <li>Paste everything it copied below — from the first <code class="inline">[</code> to the last <code class="inline">]</code>.</li>
          </ol>
        </div>

        <div>
          <label for="dl-cookies" class="mb-1.5 block text-sm font-semibold">Cookie export (JSON)</label>
          <textarea id="dl-cookies" rows="5" class="field" placeholder='[{"domain": ".example.com", "name": "session", "value": "…", …}]'>${esc(f.cookies)}</textarea>
          <p id="dl-cookies-err" class="mt-1.5 text-xs text-amber-300 ${cErr ? '' : 'hidden'}">${esc(cErr || '')}</p>
          <details class="mt-2">
            <summary class="text-xs font-medium text-body hover:text-white">What the JSON export looks like</summary>
            <p class="mt-2 text-xs leading-relaxed text-dim">A list in square brackets, with one entry per cookie. Each entry has the website’s <code class="inline">domain</code>, a <code class="inline">name</code> and a <code class="inline">value</code>, plus fields like <code class="inline">path</code>, <code class="inline">secure</code> and <code class="inline">expirationDate</code>.</p>
          </details>
        </div>

        <details ${f.localStorage ? 'open' : ''} class="rounded-xl border border-white/[0.07] p-3">
          <summary class="flex items-center justify-between text-sm font-semibold">
            <span>Also paste local storage <span class="font-normal text-dim">(optional — for sites like Supabase or Firebase apps)</span></span>
            <i data-lucide="chevron-down" class="chev h-4 w-4 text-dim"></i>
          </summary>
          <p class="mt-3 text-xs leading-relaxed text-body">Websites keep your login in two places: cookies and <span class="text-white">local storage</span>. If the saved pages still show the login screen, paste both.</p>
          <ol class="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-body">
            <li>On the same website, still signed in, press <span class="font-semibold text-white">F12</span> (or right-click → Inspect) and open the <span class="font-semibold text-white">Console</span> tab.</li>
            <li>
              Paste this command and press Enter — it copies every entry with its name:
              <span class="mt-1.5 flex items-center gap-2">
                <code class="inline flex-1 truncate py-1.5">${LS_COMMAND}</code>
                <button type="button" id="copy-ls-cmd" class="btn-ghost shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium">Copy</button>
              </span>
              <span class="mt-1 block text-dim">If the console says pasting is blocked, type <code class="inline">allow pasting</code>, press Enter, and paste again.</span>
            </li>
            <li>Paste the result below — it starts with <code class="inline">{</code>.</li>
          </ol>
          <textarea id="dl-ls" rows="4" class="field mt-3" placeholder='{"sb-…-auth-token": "…"}'>${esc(f.localStorage)}</textarea>
          <p id="dl-ls-err" class="mt-1.5 text-xs text-amber-300 ${lErr ? '' : 'hidden'}">${esc(lErr || '')}</p>
          <p class="mt-1.5 text-xs text-dim">Used together with the cookies, once, and never saved.</p>
        </details>

        <label class="flex items-start gap-2.5 rounded-xl border border-white/[0.07] p-3 text-sm">
          <input id="dl-authorized" type="checkbox" class="mt-0.5 h-4 w-4" ${f.authorized ? 'checked' : ''} />
          <span>I confirm this account is <span class="font-semibold">mine</span>, or that I am <span class="font-semibold">authorised to access it</span>.
          <span class="mt-0.5 block text-xs text-dim">Your confirmation is recorded with this download.</span></span>
        </label>

        <p class="flex gap-2 text-xs leading-relaxed text-dim"><i data-lucide="shield" class="mt-0.5 h-3.5 w-3.5 shrink-0"></i>Your cookies and local storage are used once for this download and never saved in your account. The ZIP will contain the private pages you can see when signed in, so keep it to yourself. Some sites sign your own browser out when the same login is used somewhere else.</p>
      </div>`;
  }

  function renderDownloader() {
    const f = state.form;
    // Values handed over from the home page (#downloader?mode=…&url=…) are used once, then removed from the address
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.toString()) {
      if (params.get('url')) f.url = params.get('url');
      if (params.get('mode') && MODES.some((m) => m.id === params.get('mode'))) f.mode = params.get('mode');
      history.replaceState(null, '', `${location.pathname}${location.search}#downloader`);
    }

    const lim = state.user?.limits || {};
    const allowedModes = lim.modes || MODES.map((m) => m.id);
    if (!allowedModes.includes(f.mode)) f.mode = allowedModes[0];
    const pageOpts = (isAdmin() ? state.config.pageOptions : lim.pageOptions || state.config.pageOptions) || [10, 25, 50, 100];
    if (f.maxPages !== 'custom' && !pageOpts.includes(f.maxPages)) f.maxPages = pageOpts[0];

    view.innerHTML = `
      ${pageHeader('cloud-download', 'Website Downloader', 'Enter a website address and get a ZIP of its pages as HTML files, with the CSS, JavaScript, fonts and images, ready to open offline.')}

      <div id="allowance-banner" class="card mb-6 flex items-center gap-3.5 rounded-2xl px-5 py-4 text-sm text-body">${allowanceBannerHtml()}</div>

      <form id="dl-form" class="clone-card space-y-6 rounded-2xl p-5 sm:p-6" novalidate>
        <fieldset>
          <legend class="mb-3 text-sm font-semibold">What kind of website is it?</legend>
          <div class="grid gap-3 md:grid-cols-3">
            ${MODES.map(
              (m) => `<label class="mode-card ${f.mode === m.id ? 'is-active' : ''} ${allowedModes.includes(m.id) ? '' : 'pointer-events-none opacity-45'} flex flex-col gap-2 rounded-xl p-4" ${allowedModes.includes(m.id) ? '' : 'title="Not enabled on your account"'}>
                <span class="flex items-center gap-2">
                  <input type="radio" name="mode" value="${m.id}" class="sr-only" ${f.mode === m.id ? 'checked' : ''} ${allowedModes.includes(m.id) ? '' : 'disabled'} />
                  ${allowedModes.includes(m.id) ? '' : '<i data-lucide="lock" class="h-3.5 w-3.5 text-dim"></i>'}
                  <i data-lucide="${m.icon}" class="h-[18px] w-[18px] ${f.mode === m.id ? 'text-accent-soft' : 'text-body'}"></i>
                  <span class="text-sm font-semibold">${m.title}</span>
                  ${f.mode === m.id ? '<i data-lucide="check-circle-2" class="ml-auto h-4 w-4 text-accent-soft"></i>' : ''}
                </span>
                <span class="text-xs leading-relaxed text-body">${m.text}</span>
              </label>`
            ).join('')}
          </div>
        </fieldset>

        <div class="grid gap-5 ${f.mode !== 'single_page' ? 'md:grid-cols-[1fr_200px]' : ''}">
          <div>
            <label for="dl-url" class="mb-1.5 block text-sm font-semibold">${f.mode === 'single_page' ? 'Page URL' : 'Website URL'}</label>
            <div class="relative">
              <i data-lucide="link-2" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dim"></i>
              <input id="dl-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com" value="${esc(f.url)}" class="field pl-10" />
            </div>
            ${f.mode === 'single_page' ? `<p class="mt-1.5 text-xs text-dim">Only this one page is saved. The engine still tells you how many pages the site has.</p>` : ''}
            ${f.mode === 'cookie_export' ? `<p class="mt-1.5 text-xs text-dim">The first signed-in page to save, e.g. https://app.example.com/dashboard</p>` : ''}
            ${f.mode === 'full_website' ? `<p class="mt-1.5 text-xs text-dim">The engine reads the sitemap and follows links to count every page, then saves up to your limit.</p>` : ''}
          </div>
          ${
            f.mode !== 'single_page'
              ? `<div>
                  <label for="dl-pages" class="mb-1.5 block text-sm font-semibold">Maximum pages</label>
                  <select id="dl-pages" class="field">
                    ${pageOpts.map((n) => `<option value="${n}" ${f.maxPages === n ? 'selected' : ''}>${n} pages</option>`).join('')}
                    ${isAdmin() ? `<option value="custom" ${f.maxPages === 'custom' ? 'selected' : ''}>Custom number…</option>` : ''}
                  </select>
                  ${
                    f.maxPages === 'custom'
                      ? `<input id="dl-custom-pages" type="number" min="1" max="${state.config.maxPages}" placeholder="Number of pages" value="${esc(f.customPages)}" class="field mt-2" />
                         <p class="mt-1.5 text-xs text-dim">Admin only · 1–${state.config.maxPages}.</p>`
                      : ''
                  }
                </div>`
              : ''
          }
        </div>

        ${
          f.mode !== 'single_page'
            ? `<div>
                <label for="dl-extra" class="mb-1.5 block text-sm font-semibold">Extra pages to include <span class="font-normal text-dim">(optional)</span></label>
                <textarea id="dl-extra" rows="3" class="field" placeholder="/dashboard/settings&#10;/dashboard/billing&#10;https://app.example.com/projects/123">${esc(f.extraUrls)}</textarea>
                <p class="mt-1.5 text-xs text-dim">One page per line — full addresses or paths like /dashboard/settings. For screens the crawl can’t reach through links, such as pages opened by buttons. Up to 50.</p>
              </div>`
            : ''
        }

        ${f.mode === 'cookie_export' ? cookiePanelHtml() : ''}

        <details class="rounded-xl border border-white/[0.07] p-4" ${f.stripScripts || f.ignoreRobots || f.viewport === 'mobile' ? 'open' : ''}>
          <summary class="flex items-center justify-between text-sm font-semibold"><span class="flex items-center gap-2"><i data-lucide="sliders-horizontal" class="h-4 w-4 text-dim"></i>More options</span><i data-lucide="chevron-down" class="chev h-4 w-4 text-dim"></i></summary>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <label class="flex items-start gap-2.5 text-sm">
              <input id="dl-strip" type="checkbox" class="mt-0.5 h-4 w-4" ${f.stripScripts ? 'checked' : ''} />
              <span>Remove all JavaScript from the saved pages<span class="mt-0.5 block text-xs text-dim">A smaller, fully static copy. Try this if saved pages open blank.</span></span>
            </label>
            <label class="flex items-start gap-2.5 text-sm">
              <input id="dl-robots" type="checkbox" class="mt-0.5 h-4 w-4" ${f.ignoreRobots ? 'checked' : ''} />
              <span>Ignore the website’s robots.txt<span class="mt-0.5 block text-xs text-dim">Some sites ask not to be copied automatically. Tick this only for a website you are allowed to copy.</span></span>
            </label>
            <label class="flex items-start gap-2.5 text-sm">
              <input id="dl-scroll" type="checkbox" class="mt-0.5 h-4 w-4" ${f.autoScroll ? 'checked' : ''} />
              <span>Scroll pages to load lazy images<span class="mt-0.5 block text-xs text-dim">Recommended. Untick for a faster download.</span></span>
            </label>
            <div class="text-sm">
              <span class="mb-1.5 block">Screen size</span>
              <div class="inline-flex rounded-lg border border-white/10 bg-ink-950 p-0.5 text-xs">
                <button type="button" data-viewport="desktop" class="tab rounded-md px-3 py-1.5 ${f.viewport === 'desktop' ? 'is-active' : ''}">Desktop</button>
                <button type="button" data-viewport="mobile" class="tab rounded-md px-3 py-1.5 ${f.viewport === 'mobile' ? 'is-active' : ''}">Mobile</button>
              </div>
            </div>
          </div>
        </details>

        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button id="dl-submit" type="submit" class="btn-primary flex h-11 items-center justify-center gap-2 rounded-xl px-6 text-sm font-semibold">
            <i data-lucide="download" class="h-4 w-4"></i><span id="dl-submit-text">Download website</span>
          </button>
          <div class="text-xs text-dim">
            <p id="dl-reason" class="text-amber-300/90"></p>
            <p>Usually a few minutes; larger sites take longer. You can stop at any time and keep the pages saved so far.</p>
          </div>
        </div>
        <p class="flex gap-2 border-t border-white/[0.06] pt-4 text-xs leading-relaxed text-dim"><i data-lucide="info" class="mt-0.5 h-3.5 w-3.5 shrink-0"></i>Saved pages are snapshots: on sites built with React, Vue, Next.js and similar, they look right but buttons, filters and search do not work offline.</p>
      </form>

      <section class="mt-10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Recent downloads</h2>
          <a href="#history" class="flex items-center gap-1 text-sm text-body hover:text-white">View all history<i data-lucide="arrow-right" class="h-4 w-4"></i></a>
        </div>
        <ul id="recent-list" class="space-y-3"></ul>
      </section>`;

    patchList($('#recent-list'), state.downloads.slice(0, 5), { empty: 'downloader' });
    bindDownloaderForm();
    updateSubmitState();
  }

  function bindDownloaderForm() {
    const f = state.form;
    const form = $('#dl-form');
    const clearErr = () => {
      if (f.error) {
        f.error = '';
        updateSubmitState();
      }
    };

    $$('input[name="mode"]', form).forEach((r) =>
      r.addEventListener('change', () => {
        f.mode = r.value;
        f.error = '';
        renderDownloader();
        icons();
      })
    );
    $('#dl-url').addEventListener('input', (e) => {
      f.url = e.target.value;
      clearErr();
      updateSubmitState();
    });
    const pages = $('#dl-pages');
    if (pages) {
      pages.addEventListener('change', () => {
        f.maxPages = pages.value === 'custom' ? 'custom' : parseInt(pages.value, 10);
        renderDownloader();
        icons();
      });
    }
    const custom = $('#dl-custom-pages');
    if (custom) custom.addEventListener('input', (e) => ((f.customPages = e.target.value), updateSubmitState()));
    const extra = $('#dl-extra');
    if (extra) extra.addEventListener('input', (e) => (f.extraUrls = e.target.value));

    const cookies = $('#dl-cookies');
    if (cookies) {
      cookies.addEventListener('input', (e) => {
        f.cookies = e.target.value;
        const err = cookieCheck();
        const el = $('#dl-cookies-err');
        el.textContent = err || '';
        el.classList.toggle('hidden', !err);
        clearErr();
        updateSubmitState();
      });
    }
    const ls = $('#dl-ls');
    if (ls) {
      ls.addEventListener('input', (e) => {
        f.localStorage = e.target.value;
        const err = lsCheck();
        const el = $('#dl-ls-err');
        el.textContent = err || '';
        el.classList.toggle('hidden', !err);
        updateSubmitState();
      });
    }
    const copyBtn = $('#copy-ls-cmd');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(LS_COMMAND);
          copyBtn.textContent = 'Copied';
        } catch {
          copyBtn.textContent = 'Select & copy';
        }
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1800);
      });
    }
    const authorized = $('#dl-authorized');
    if (authorized) authorized.addEventListener('change', (e) => ((f.authorized = e.target.checked), updateSubmitState()));
    $('#dl-strip').addEventListener('change', (e) => (f.stripScripts = e.target.checked));
    $('#dl-robots').addEventListener('change', (e) => (f.ignoreRobots = e.target.checked));
    $('#dl-scroll').addEventListener('change', (e) => (f.autoScroll = e.target.checked));
    $$('[data-viewport]', form).forEach((b) =>
      b.addEventListener('click', () => {
        f.viewport = b.dataset.viewport;
        $$('[data-viewport]', form).forEach((x) => x.classList.toggle('is-active', x === b));
      })
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (disabledReason()) return updateSubmitState();
      f.submitting = true;
      f.error = '';
      updateSubmitState();
      try {
        const body = {
          mode: f.mode,
          url: f.url.trim(),
          maxPages: effectivePages(),
          viewport: f.viewport,
          autoScroll: f.autoScroll,
          stripScripts: f.stripScripts,
          ignoreRobots: f.ignoreRobots,
          ...(f.mode !== 'single_page' && f.extraUrls.trim() ? { extraUrls: f.extraUrls } : {}),
          ...(f.mode === 'cookie_export'
            ? { sessionCookies: f.cookies.trim(), localStorageData: f.localStorage.trim(), authorized: f.authorized }
            : {}),
        };
        const data = await api('/api/website-downloads', { method: 'POST', body });
        state.downloads.unshift(data.download);
        state.allowance = data.allowance || state.allowance;
        state.notes[data.download.id] = {
          text:
            data.download.queue_position > 1
              ? `Started — another download is running, so yours is #${data.download.queue_position} in line and starts automatically.`
              : 'Started. You can leave this page — it keeps running and the ZIP waits in History.',
          type: 'info',
          t: Date.now(),
        };
        // Session data is used once — clear it from the form
        Object.assign(f, { url: '', cookies: '', localStorage: '', authorized: false, extraUrls: '' });
        f.submitting = false;
        renderDownloader();
        icons();
        ensurePolling();
        updateSidebar();
        $('#recent-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        f.submitting = false;
        f.error = err.message;
        if (err.data?.allowance) state.allowance = err.data.allowance;
        updateSidebar();
        updateSubmitState();
      }
    });
  }

  // ---------- History ----------
  function renderHistory() {
    view.innerHTML = `
      ${pageHeader(
        'history',
        'History',
        'Every website you have downloaded. Download a ZIP again whenever you need it.',
        `<a href="#downloader" class="btn-primary flex items-center gap-1.5 self-start rounded-lg px-4 py-2 text-sm font-semibold sm:self-auto"><i data-lucide="plus" class="h-4 w-4"></i>New download</a>`
      )}
      <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="relative sm:w-80">
          <i data-lucide="search" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dim"></i>
          <input id="hist-search" type="search" placeholder="Search by website address" value="${esc(state.historySearch)}" class="field pl-10" />
        </div>
        <div class="inline-flex self-start rounded-xl border border-white/[0.07] bg-ink-900 p-1 text-sm">
          ${[
            ['all', 'All'],
            ['ready', 'Ready'],
            ['active', 'In progress'],
            ['failed', 'Failed'],
          ]
            .map(([k, l]) => `<button type="button" data-filter="${k}" class="tab rounded-lg px-3 py-1.5 ${state.historyFilter === k ? 'is-active' : ''}">${l}</button>`)
            .join('')}
        </div>
      </div>
      <p id="hist-count" class="mb-3 text-xs text-dim"></p>
      <ul id="history-list" class="space-y-3"></ul>`;

    $('#hist-search').addEventListener('input', (e) => {
      state.historySearch = e.target.value;
      renderHistoryList();
      icons();
    });
    $$('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        state.historyFilter = b.dataset.filter;
        $$('[data-filter]').forEach((x) => x.classList.toggle('is-active', x === b));
        renderHistoryList();
        icons();
      })
    );
    renderHistoryList();
  }

  function renderHistoryList() {
    const q = state.historySearch.trim().toLowerCase();
    const filter = state.historyFilter;
    const list = state.downloads.filter((d) => {
      if (q && !d.url.toLowerCase().includes(q)) return false;
      if (filter === 'ready') return d.status === 'completed';
      if (filter === 'active') return isActive(d);
      if (filter === 'failed') return d.status === 'failed';
      return true;
    });
    const countEl = $('#hist-count');
    if (countEl) countEl.textContent = state.downloadsLoaded ? `${list.length} of ${plural(state.downloads.length, 'download')}` : '';
    const el = $('#history-list');
    if (!el) return;
    if (state.downloadsLoaded && !list.length && state.downloads.length) {
      el.innerHTML = `<li class="card rounded-2xl px-6 py-10 text-center text-sm text-body">No downloads match this filter.</li>`;
    } else {
      patchList(el, list, { empty: 'downloader' });
    }
  }

  // ---------- Library ----------
  async function renderLibrary() {
    view.innerHTML = `
      ${pageHeader('library', 'Website Library', 'Websites already downloaded for you. Download any of them as a ZIP — it doesn’t use up your plan’s downloads.')}
      <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="relative sm:w-80">
          <i data-lucide="search" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dim"></i>
          <input id="lib-search" type="search" placeholder="Search websites" class="field pl-10" />
        </div>
        <p id="lib-msg" class="inline-msg"></p>
      </div>
      <div id="lib-grid" class="grid gap-4 sm:grid-cols-2"><div class="card animate-pulse rounded-2xl p-6"><div class="h-3 w-1/2 rounded bg-white/[0.06]"></div></div></div>
      ${isAdmin() ? `<p class="mt-6 text-xs text-dim">Admin: add a finished download to the library from its <a href="#history" class="underline">History</a> card (“Add to library”).</p>` : ''}`;
    icons();

    let items = [];
    const draw = () => {
      const q = ($('#lib-search')?.value || '').trim().toLowerCase();
      const list = items.filter((i) => !q || `${i.title} ${i.url}`.toLowerCase().includes(q));
      const grid = $('#lib-grid');
      if (!grid) return;
      grid.innerHTML = list.length
        ? list
            .map(
              (i) => `<div class="card flex flex-col rounded-2xl p-5">
                <div class="flex items-start gap-3">
                  <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(i.domain)}&sz=64" alt="" class="h-9 w-9 shrink-0 rounded-lg bg-white/[0.05] p-1.5" loading="lazy" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-semibold">${esc(i.title)}</p>
                    <a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer" class="mt-0.5 flex items-center gap-1 truncate text-sm text-accent-soft hover:underline">${esc(i.domain)}<i data-lucide="external-link" class="h-3.5 w-3.5"></i></a>
                  </div>
                </div>
                <p class="mt-3 text-xs text-dim">${i.pages === 1 ? 'Single page' : `${i.pages ?? '?'} pages`} · ${formatBytes(i.zip_size_bytes)} · added ${fmtDay(i.created_at)}</p>
                <div class="mt-4 flex items-center gap-2">
                  ${
                    i.available
                      ? `<button data-lib-zip="${i.id}" class="btn-primary flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold"><i data-lucide="download" class="h-3.5 w-3.5"></i>Download ZIP</button>`
                      : `<span class="text-xs text-dim">Not available right now</span>`
                  }
                  ${isAdmin() ? `<button data-lib-del="${i.id}" class="btn-danger ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium">Remove</button>` : ''}
                </div>
              </div>`
            )
            .join('')
        : `<div class="card col-span-full rounded-2xl px-6 py-12 text-center">
            <span class="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.04]"><i data-lucide="library" class="h-5 w-5 text-dim"></i></span>
            <p class="mt-4 text-sm font-semibold">${items.length ? 'No websites match your search' : 'The library is empty'}</p>
            <p class="mt-1 text-sm text-body">${items.length ? 'Try another word.' : 'Websites added by the admin will appear here.'}</p>
          </div>`;
      icons();
    };

    try {
      items = (await api('/api/library')).items || [];
      draw();
    } catch (err) {
      $('#lib-grid').innerHTML = `<p class="text-sm text-rose-300">${esc(err.message)}</p>`;
    }
    $('#lib-search')?.addEventListener('input', draw);
    $('#lib-grid')?.addEventListener('click', async (e) => {
      const zip = e.target.closest('[data-lib-zip]');
      const del = e.target.closest('[data-lib-del]');
      try {
        if (zip) {
          zip.disabled = true;
          const data = await api(`/api/library/${zip.dataset.libZip}/link`, { method: 'POST' });
          location.href = apiUrl(data.url);
          setTimeout(() => (zip.disabled = false), 2000);
        } else if (del) {
          if (!armed(del, 'Remove?')) return;
          await api(`/api/library/${del.dataset.libDel}`, { method: 'DELETE' });
          items = items.filter((i) => i.id !== del.dataset.libDel);
          draw();
          flash($('#lib-msg'), 'Removed from the library.');
          loadDownloads().catch(() => {});
        }
      } catch (err) {
        flash($('#lib-msg'), err.message, 'bad', 7000);
        if (zip) zip.disabled = false;
      }
    });
  }

  // ---------- Tutorial ----------
  function renderTutorial() {
    const step = (n, title, body) => `<li class="flex gap-4">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-xs text-accent-soft">${n}</span>
      <div><p class="font-semibold">${title}</p><p class="mt-1 text-sm leading-relaxed text-body">${body}</p></div></li>`;
    view.innerHTML = `
      ${pageHeader('graduation-cap', 'Tutorial', 'Learn how to use SiteClone step by step.')}
      <div class="space-y-6">
        <section class="card rounded-2xl p-6">
          <h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="file" class="h-5 w-5 text-accent-soft"></i>Download a single page</h2>
          <ol class="mt-5 space-y-5">
            ${step(1, 'Open the Website Downloader', 'Choose <span class="text-white">Single Page</span>.')}
            ${step(2, 'Paste the page address', 'For example https://example.com/pricing. Only this page is saved — the engine still shows how many pages the site has.')}
            ${step(3, 'Download the ZIP', 'When the card turns <span class="text-mint">Ready</span>, click Download ZIP. Unzip it and open <code class="inline">index.html</code> in your browser.')}
          </ol>
        </section>
        <section class="card rounded-2xl p-6">
          <h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="globe" class="h-5 w-5 text-accent-soft"></i>Download a whole website</h2>
          <ol class="mt-5 space-y-5">
            ${step(1, 'Choose Full Frontend Website', 'Enter the home page address and how many pages to save at most.')}
            ${step(2, 'Watch the progress', 'The card shows <span class="text-white">Pages found</span> (every page the engine discovered from the sitemap and links) and <span class="text-white">Pages saved</span> (up to your limit).')}
            ${step(3, 'Stop whenever you like', '<span class="text-white">Stop &amp; download</span> zips the pages saved so far. Stopping while it waits in line takes it out and does not count.')}
          </ol>
        </section>
        <section class="card rounded-2xl p-6">
          <h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="shield-check" class="h-5 w-5 text-accent-soft"></i>Download pages behind your own login (Backend HTML UI)</h2>
          <ol class="mt-5 space-y-5">
            ${step(1, 'Sign in on the website', 'Use an account that is yours, or that you are authorised to access.')}
            ${step(2, 'Export your cookies', 'Install the free Cookie-Editor extension, click it on that website and choose Export → JSON.')}
            ${step(3, 'Paste and confirm', 'Choose Backend HTML UI, paste the export, tick the confirmation and start. If the result shows the login page, also paste your local storage (instructions are in the form).')}
          </ol>
          <p class="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs leading-relaxed text-amber-100/80">Only download accounts and websites you own or are allowed to copy. Your cookies are used once and never stored.</p>
        </section>
        <section class="card rounded-2xl p-6">
          <h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="help-circle" class="h-5 w-5 text-accent-soft"></i>Good to know</h2>
          <ul class="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-body">
            <li>Downloads run one at a time on the server. If others are downloading, yours waits in line and starts automatically — you can leave the page.</li>
            <li>A download that fails is not counted against your plan.</li>
            <li>ZIP files are kept for a limited time. Download them soon after they are ready.</li>
            <li>Saved pages are snapshots. On React, Vue or Next.js sites they look right, but buttons, filters and search do not work offline.</li>
            <li>If saved pages open blank, try again with <span class="text-white">Remove all JavaScript</span> under More options.</li>
          </ul>
        </section>
      </div>`;
  }

  // ---------- Settings ----------
  function renderSettings(tab = 'general') {
    const u = state.user || {};
    const a = state.allowance;
    view.innerHTML = `
      ${pageHeader('settings', 'Settings', 'Manage your profile, password and plan.')}
      <div class="mb-6 inline-flex rounded-xl border border-white/[0.07] bg-ink-900 p-1 text-sm">
        ${[
          ['general', 'settings', 'General'],
          ['plan', 'gauge', 'Plan'],
          ['support', 'life-buoy', 'Support'],
        ]
          .map(([k, ic, l]) => `<button type="button" data-tab="${k}" class="tab flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${tab === k ? 'is-active' : ''}"><i data-lucide="${ic}" class="h-4 w-4"></i>${l}</button>`)
          .join('')}
      </div>
      <div id="settings-body"></div>`;

    const body = $('#settings-body');
    if (tab === 'general') {
      body.innerHTML = `
        <div class="space-y-6">
          <form id="profile-form" class="card rounded-2xl p-6">
            <h2 class="text-lg font-semibold">Profile</h2>
            <p class="mt-1 text-sm text-body">Your name and email.</p>
            <div class="mt-5 grid gap-4 sm:grid-cols-2">
              <div><label class="mb-1.5 block text-sm font-semibold" for="set-name">Full name</label><input id="set-name" class="field" value="${esc(u.name || '')}" maxlength="80" /></div>
              <div><label class="mb-1.5 block text-sm font-semibold" for="set-email">Email</label><input id="set-email" class="field" value="${esc(u.email || '')}" disabled />
                <p class="mt-1.5 text-xs text-dim">To change your email address, contact the admin.</p></div>
            </div>
            <div class="mt-5 flex items-center gap-3"><button class="btn-primary rounded-lg px-4 py-2 text-sm font-semibold">Save changes</button><span id="profile-msg" class="inline-msg"></span></div>
          </form>

          <form id="pw-form" class="card rounded-2xl p-6">
            <h2 class="text-lg font-semibold">Password</h2>
            <p class="mt-1 text-sm text-body">Choose a new password for signing in. Other devices are signed out.</p>
            <div class="mt-5 grid gap-4 sm:grid-cols-3">
              <div><label class="mb-1.5 block text-sm font-semibold" for="pw-current">Current password</label><input id="pw-current" type="password" autocomplete="current-password" class="field" /></div>
              <div><label class="mb-1.5 block text-sm font-semibold" for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password" class="field" /></div>
              <div><label class="mb-1.5 block text-sm font-semibold" for="pw-repeat">Repeat new password</label><input id="pw-repeat" type="password" autocomplete="new-password" class="field" /></div>
            </div>
            <div class="mt-5 flex items-center gap-3"><button class="btn-primary rounded-lg px-4 py-2 text-sm font-semibold">Change password</button><span id="pw-msg" class="inline-msg"></span></div>
          </form>

          <div class="card rounded-2xl p-6">
            <h2 class="text-lg font-semibold">Delete account</h2>
            <p class="mt-1 text-sm text-body">To delete your account and everything in it — your download history and ZIP files — ask the site admin from ${esc(u.email || 'your account email')}.</p>
          </div>
        </div>`;

      $('#profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const data = await api('/api/me', { method: 'PATCH', body: { name: $('#set-name').value } });
          state.user = data.user;
          session.saveUser(data.user);
          updateSidebar();
          flash($('#profile-msg'), 'Saved.');
        } catch (err) {
          flash($('#profile-msg'), err.message, 'bad', 7000);
        }
      });
      $('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('#pw-msg');
        const cur = $('#pw-current').value;
        const nw = $('#pw-new').value;
        if (nw !== $('#pw-repeat').value) return flash(msg, 'The new passwords do not match.', 'bad', 7000);
        if (nw.length < 8) return flash(msg, 'Use at least 8 characters.', 'bad', 7000);
        try {
          const data = await api('/api/me/password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
          if (data.session) await session.setTokens(data.session.access_token, data.session.refresh_token);
          e.target.reset();
          flash(msg, 'Password changed. Other devices were signed out.', 'ok', 6000);
        } catch (err) {
          flash(msg, err.message, 'bad', 7000);
        }
      });
    } else if (tab === 'plan') {
      body.innerHTML = `
        <div class="card rounded-2xl p-6">
          <h2 class="text-lg font-semibold">Your plan</h2>
          ${
            !a
              ? '<p class="mt-3 text-sm text-body">Loading…</p>'
              : a.unlimited
              ? `<p class="mt-3 text-sm text-body"><span class="text-white">${esc(a.plan)}</span> — unlimited downloads.</p>`
              : `<div class="mt-5 grid gap-4 sm:grid-cols-3">
                  <div><p class="text-xs text-dim">Plan</p><p class="mt-1 font-display text-xl font-semibold">${esc(a.plan)}</p></div>
                  <div><p class="text-xs text-dim">Downloads left</p><p class="mt-1 font-display text-xl font-semibold">${a.remaining} <span class="text-sm font-normal text-dim">of ${a.limit}</span></p></div>
                  <div><p class="text-xs text-dim">Resets</p><p class="mt-1 font-display text-xl font-semibold">${fmtDay(a.resetsAt)}</p></div>
                </div>
                <div class="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div class="h-full rounded-full bg-accent-soft" style="width:${a.limit ? Math.min(100, (a.used / a.limit) * 100) : 0}%"></div></div>
                <ul class="mt-5 list-disc space-y-1.5 pl-5 text-sm text-body">
                  <li>Each website counts once — a single page or a whole site.</li>
                  <li>Failed or cancelled downloads are given back.</li>
                  <li>Websites in the Library are free to download.</li>
                  <li>Need more downloads? Ask the admin to raise your limit.</li>
                </ul>`
          }
        </div>`;
    } else {
      body.innerHTML = `
        <div class="card rounded-2xl p-6">
          <h2 class="text-lg font-semibold">Support</h2>
          <p class="mt-2 text-sm leading-relaxed text-body">Something not working? Check the <a href="#tutorial" class="text-accent-soft underline">Tutorial</a> first. For account changes — a new email, a higher download limit, a forgotten password or deleting your account — contact the site admin.</p>
          <ul class="mt-4 list-disc space-y-1.5 pl-5 text-sm text-body">
            <li>When reporting a failed download, include the website address and the error shown in History.</li>
            <li>Never send your cookie export or passwords to anyone.</li>
          </ul>
        </div>`;
    }

    $$('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        renderSettings(b.dataset.tab);
        icons();
      })
    );
    icons();
  }

  // ---------- Admin ----------
  async function loadAdminDownloads() {
    const dl = await api('/api/admin/downloads');
    state.adminDownloads = dl.downloads || [];
    return state.adminDownloads;
  }

  const MODE_SHORT = { single_page: 'Single page', full_website: 'Full website', cookie_export: 'Backend HTML UI' };

  function userEditorHtml(u) {
    const modes = u.allowedModes || Object.keys(MODE_SHORT);
    const isAdm = u.role === 'admin';
    const self = u.id === state.user.id;
    return `<tr class="bg-white/[0.02]" data-editor="${u.id}"><td colspan="6" class="px-4 pb-5 pt-2">
      <div class="rounded-2xl border border-white/[0.08] bg-ink-950/60 p-5">
        <div class="grid gap-4 md:grid-cols-3">
          <div><label class="mb-1.5 block text-xs font-semibold text-body">Full name</label><input data-e="name" class="field py-2" value="${esc(u.name)}" maxlength="80" /></div>
          <div><label class="mb-1.5 block text-xs font-semibold text-body">Plan name</label><input data-e="planName" class="field py-2" value="${esc(u.planName || 'Free')}" maxlength="40" ${isAdm ? 'disabled' : ''} /></div>
          <div><label class="mb-1.5 block text-xs font-semibold text-body">Role</label><select data-e="role" class="field py-2" ${self ? 'disabled' : ''}>
            <option value="user" ${!isAdm ? 'selected' : ''}>User</option><option value="admin" ${isAdm ? 'selected' : ''}>Admin (no limits)</option></select></div>
          <div><label class="mb-1.5 block text-xs font-semibold text-body">Downloads per ${state.config.periodDays || 30} days</label><input data-e="monthlyLimit" type="number" min="0" class="field py-2" value="${isAdm ? '' : u.monthlyLimit ?? ''}" placeholder="Unlimited" ${isAdm ? 'disabled' : ''} />
            <p class="mt-1 text-[11px] text-dim">Empty = unlimited. Used now: ${u.allowance.used}.</p></div>
          <div><label class="mb-1.5 block text-xs font-semibold text-body">Max pages per download</label><input data-e="maxPagesLimit" type="number" min="1" max="${state.config.maxPages}" class="field py-2" value="${isAdm ? '' : u.maxPagesLimit ?? ''}" placeholder="Site max (${state.config.maxPages})" ${isAdm ? 'disabled' : ''} />
            <p class="mt-1 text-[11px] text-dim">Empty = server maximum.</p></div>
          <div><label class="mb-1.5 block text-xs font-semibold text-body">Downloads at the same time</label><input data-e="maxActiveJobs" type="number" min="1" max="10" class="field py-2" value="${isAdm ? '' : u.maxActiveJobs ?? ''}" placeholder="Default (${state.config.maxJobsPerUser || 2})" ${isAdm ? 'disabled' : ''} />
            <p class="mt-1 text-[11px] text-dim">Running + waiting in line.</p></div>
        </div>
        <div class="mt-4">
          <p class="mb-2 text-xs font-semibold text-body">Allowed download types</p>
          <div class="flex flex-wrap gap-2">${Object.entries(MODE_SHORT)
            .map(
              ([k, l]) => `<label class="subtle flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${isAdm ? 'opacity-60' : ''}"><input type="checkbox" data-e-mode="${k}" class="h-4 w-4" ${isAdm || modes.includes(k) ? 'checked' : ''} ${isAdm ? 'disabled' : ''} />${l}</label>`
            )
            .join('')}</div>
        </div>
        <div class="mt-4"><label class="mb-1.5 block text-xs font-semibold text-body">Admin notes <span class="font-normal text-dim">(only admins see this)</span></label><textarea data-e="notes" rows="2" class="field" style="font-family:Inter,sans-serif">${esc(u.notes || '')}</textarea></div>
        <div class="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          <button data-u-save class="btn-primary rounded-lg px-4 py-2 text-xs font-semibold">Save changes</button>
          <button data-u-reset-usage class="btn-ghost rounded-lg px-3 py-2 text-xs" title="Give back all downloads for this period">Reset usage</button>
          <button data-u-reset-pw class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs"><i data-lucide="key-round" class="h-3.5 w-3.5"></i>New password</button>
          <button data-u-view class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs"><i data-lucide="list" class="h-3.5 w-3.5"></i>View downloads (${u.downloads})</button>
          <span class="flex-1"></span>
          ${self ? '' : `<button data-u-toggle class="${u.disabled ? 'btn-ghost' : 'btn-danger'} rounded-lg px-3 py-2 text-xs" data-disabled="${u.disabled ? '1' : ''}">${u.disabled ? 'Enable account' : 'Disable account'}</button>`}
          ${self ? '' : `<button data-u-delete class="btn-danger flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i>Delete account</button>`}
        </div>
        <p class="mt-2 text-[11px] text-dim">Created ${fmtDate(u.createdAt)} · ${u.lastLoginAt ? `last sign-in ${fmtDate(u.lastLoginAt)}` : 'never signed in'} · ${(u.pagesSaved || 0).toLocaleString()} pages saved in total</p>
      </div></td></tr>`;
  }

  async function renderAdmin() {
    if (!isAdmin()) {
      location.hash = '#dashboard';
      return;
    }
    view.innerHTML = `
      ${pageHeader('shield-check', 'Admin panel', 'Users, download limits and everything downloaded on this server. Data is stored in Supabase.',
        `<div class="flex items-center gap-2 self-start text-xs text-dim sm:self-auto"><span class="live-dot"></span>Live · updates automatically</div>`)}
      <div id="admin-stats" class="grid grid-cols-2 gap-3 sm:grid-cols-4"></div>

      <section class="mt-10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Live activity</h2>
          <span id="admin-server" class="text-xs text-dim"></span>
        </div>
        <ul id="admin-live" class="space-y-3"></ul>
      </section>

      <section class="mt-10">
        <h2 class="mb-4 text-lg font-semibold">Site settings</h2>
        <form id="admin-settings" class="card grid gap-5 rounded-2xl p-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div><label class="mb-1.5 block text-xs font-semibold text-body" for="set-default-limit">Downloads for new users (per ${state.config.periodDays || 30} days)</label>
            <input id="set-default-limit" type="number" min="0" class="field py-2" placeholder="Unlimited" /></div>
          <label class="flex items-center gap-3 text-sm md:pb-2"><input id="set-registration" type="checkbox" class="h-4 w-4" /><span>Anyone can create an account<span class="block text-xs text-dim">Untick to allow only accounts you create here.</span></span></label>
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn-primary rounded-lg px-4 py-2 text-xs font-semibold">Save settings</button>
            <button type="button" id="apply-default" class="btn-ghost rounded-lg px-3 py-2 text-xs" title="Set every normal user's limit to the default">Apply to all users</button>
          </div>
          <p id="settings-msg" class="inline-msg md:col-span-3"></p>
        </form>
      </section>

      <section class="mt-10">
        <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="text-lg font-semibold">Users <span id="admin-user-count" class="text-sm font-normal text-dim"></span></h2>
          <div class="flex flex-wrap items-center gap-2">
            <span id="admin-msg" class="inline-msg"></span>
            <div class="relative w-56"><i data-lucide="search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dim"></i><input id="admin-user-search" type="search" placeholder="Search name or email" class="field py-2 pl-9 text-sm" /></div>
            <button id="new-user-btn" class="btn-primary flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold"><i data-lucide="user-plus" class="h-4 w-4"></i>Create user</button>
          </div>
        </div>
        <form id="new-user-form" class="card mb-4 hidden rounded-2xl p-5">
          <p class="text-sm font-semibold">Create a new account</p>
          <p class="mt-1 text-xs text-dim">The account is ready to sign in right away. Leave the password empty to generate a strong one.</p>
          <div class="mt-4 grid gap-4 md:grid-cols-5">
            <div><label class="mb-1.5 block text-xs font-semibold text-body">Full name</label><input name="name" class="field py-2" maxlength="80" /></div>
            <div><label class="mb-1.5 block text-xs font-semibold text-body">Email</label><input name="email" type="email" required class="field py-2" /></div>
            <div><label class="mb-1.5 block text-xs font-semibold text-body">Password</label><input name="password" type="text" class="field py-2" placeholder="Generate" autocomplete="off" /></div>
            <div><label class="mb-1.5 block text-xs font-semibold text-body">Role</label><select name="role" class="field py-2"><option value="user">User</option><option value="admin">Admin</option></select></div>
            <div><label class="mb-1.5 block text-xs font-semibold text-body">Downloads / ${state.config.periodDays || 30} days</label><input name="monthlyLimit" type="number" min="0" class="field py-2" placeholder="Default" /></div>
          </div>
          <div class="mt-4 flex items-center gap-2"><button class="btn-primary rounded-lg px-4 py-2 text-xs font-semibold">Create account</button><button type="button" id="new-user-cancel" class="btn-ghost rounded-lg px-3 py-2 text-xs">Cancel</button><span id="new-user-msg" class="inline-msg"></span></div>
        </form>
        <div id="admin-secret" class="mb-3 hidden"></div>
        <div class="card overflow-x-auto rounded-2xl"><table class="w-full min-w-[860px] text-left text-sm">
          <thead class="border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-dim">
            <tr><th class="px-4 py-3 font-medium">User</th><th class="px-4 py-3 font-medium">Plan</th><th class="px-4 py-3 font-medium">Used this period</th><th class="px-4 py-3 font-medium">Limits</th><th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3 text-right font-medium"></th></tr>
          </thead>
          <tbody id="admin-users"><tr><td class="px-4 py-6 text-body" colspan="6">Loading…</td></tr></tbody>
        </table></div>
        <p class="mt-2 text-xs text-dim">Click <span class="text-white">Manage</span> to change a user's limits, allowed download types, role or password. Buttons that remove access ask you to click twice.</p>
      </section>

      <section class="mt-10">
        <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="text-lg font-semibold">All downloads</h2>
          <div class="flex flex-wrap items-center gap-2">
            <select id="dl-filter-user" class="field w-56 py-2 text-xs"><option value="">Every user</option></select>
            <select id="dl-filter-status" class="field w-40 py-2 text-xs"><option value="">Any status</option><option value="active">In progress</option><option value="completed">Ready</option><option value="failed">Failed</option></select>
          </div>
        </div>
        <div class="card overflow-x-auto rounded-2xl"><table class="w-full min-w-[900px] text-left text-sm">
          <thead class="border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-dim">
            <tr><th class="px-4 py-3 font-medium">Website</th><th class="px-4 py-3 font-medium">User</th><th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3 font-medium">Pages saved / found</th><th class="px-4 py-3 font-medium">Size</th><th class="px-4 py-3 font-medium">Date</th><th class="px-4 py-3"></th></tr>
          </thead>
          <tbody id="admin-downloads"><tr><td class="px-4 py-6 text-body" colspan="7">Loading…</td></tr></tbody>
        </table></div>
      </section>`;
    icons();

    let users = [];
    let openEditor = null;
    const msg = $('#admin-msg');

    const limitsSummary = (u) => {
      if (u.role === 'admin') return '<span class="text-dim">No limits</span>';
      const parts = [
        `${u.maxPagesLimit || state.config.maxPages} pages max`,
        `${u.maxActiveJobs || state.config.maxJobsPerUser || 2} at once`,
        u.allowedModes ? u.allowedModes.map((m) => MODE_SHORT[m]).join(', ') : 'all types',
      ];
      return `<span class="text-xs text-body">${parts.map(esc).join(' · ')}</span>`;
    };

    const drawUsers = () => {
      const q = ($('#admin-user-search')?.value || '').trim().toLowerCase();
      const list = users.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q));
      $('#admin-user-count').textContent = `· ${users.length}`;
      $('#admin-users').innerHTML = list.length
        ? list
            .map((u) => {
              const self = u.id === state.user.id;
              const usedPct = u.allowance.unlimited || !u.allowance.limit ? 0 : Math.min(100, (u.allowance.used / u.allowance.limit) * 100);
              const row = `<tr class="table-row border-b border-white/[0.04]" data-user="${u.id}">
                <td class="px-4 py-3"><div class="flex items-center gap-3"><span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${u.role === 'admin' ? 'bg-amber-300/15 text-amber-200' : 'bg-accent/20 text-accent-soft'} text-xs font-semibold">${esc((u.name || u.email).charAt(0).toUpperCase())}</span>
                  <div class="min-w-0"><p class="truncate font-medium">${esc(u.name)}${self ? ' <span class="text-xs text-dim">(you)</span>' : ''}</p><p class="truncate text-xs text-dim">${esc(u.email)}</p></div></div></td>
                <td class="px-4 py-3"><span class="badge ${u.role === 'admin' ? 'bg-amber-300/10 text-amber-200' : 'bg-white/[0.06] text-body'}">${u.role === 'admin' ? 'Admin' : esc(u.planName || 'Free')}</span></td>
                <td class="px-4 py-3"><p class="font-mono text-xs">${u.allowance.used} / ${u.allowance.unlimited ? '∞' : u.allowance.limit}</p>
                  <div class="mt-1.5 h-1 w-24 overflow-hidden rounded-full bg-white/[0.07]"><div class="h-full rounded-full ${usedPct >= 100 ? 'bg-rose-400' : 'bg-accent-soft'}" style="width:${usedPct}%"></div></div>
                  <p class="mt-1 text-[11px] text-dim">${plural(u.downloads, 'download')}${u.activeDownloads ? ` · <span class="text-accent-soft">${u.activeDownloads} running</span>` : ''}</p></td>
                <td class="max-w-[220px] px-4 py-3">${limitsSummary(u)}</td>
                <td class="px-4 py-3">${u.disabled ? '<span class="badge bg-rose-500/10 text-rose-300">Disabled</span>' : '<span class="badge bg-mint/10 text-mint">Active</span>'}
                  <p class="mt-1 text-[11px] text-dim">${u.lastLoginAt ? `Seen ${fmtDay(u.lastLoginAt)}` : 'Never signed in'}</p></td>
                <td class="px-4 py-3 text-right"><button data-u-manage class="btn-ghost inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium">${openEditor === u.id ? 'Close' : 'Manage'}<i data-lucide="${openEditor === u.id ? 'chevron-up' : 'chevron-down'}" class="h-3.5 w-3.5"></i></button></td>
              </tr>`;
              return row + (openEditor === u.id ? userEditorHtml(u) : '');
            })
            .join('')
        : `<tr><td class="px-4 py-6 text-body" colspan="6">No users match.</td></tr>`;
      // user filter for the downloads table
      const sel = $('#dl-filter-user');
      const cur = sel.value;
      sel.innerHTML = `<option value="">Every user</option>${users.map((u) => `<option value="${esc(u.email)}">${esc(u.email)}</option>`).join('')}`;
      sel.value = cur;
      icons();
    };

    const drawDownloads = () => {
      const fu = $('#dl-filter-user')?.value || '';
      const fs = $('#dl-filter-status')?.value || '';
      const list = state.adminDownloads.filter(
        (d) => (!fu || d.user_email === fu) && (!fs || (fs === 'active' ? isActive(d) : d.status === fs))
      );
      $('#admin-downloads').innerHTML = list.length
        ? list
            .slice(0, 200)
            .map((d) => {
              const st = STATUS[d.status] || STATUS.queued;
              return `<tr class="table-row border-b border-white/[0.04] last:border-0" data-admin-dl="${d.id}">
                <td class="max-w-[260px] px-4 py-3"><a href="${esc(d.url)}" target="_blank" rel="noopener" class="block truncate hover:underline">${esc(d.url)}</a><span class="text-[11px] text-dim">${MODE_LABEL[d.mode] || ''}${d.login_method ? ' · signed in' : ''}</span></td>
                <td class="max-w-[180px] truncate px-4 py-3 text-xs text-body">${esc(d.user_email)}</td>
                <td class="px-4 py-3"><span class="badge ${st.cls}">${st.label}${isActive(d) && d.progress?.pct ? ` · ${d.progress.pct}%` : ''}</span>${d.status === 'failed' ? `<p class="mt-1 text-[11px] text-dim">${esc(d.error_code || '')}</p>` : ''}</td>
                <td class="px-4 py-3 font-mono text-xs text-body">${d.pages ?? 0} / ${d.pages_found ?? '—'}</td>
                <td class="px-4 py-3 text-xs text-body">${formatBytes(d.zip_size_bytes) || '—'}</td>
                <td class="px-4 py-3 text-xs text-dim">${fmtDate(d.created_at)}</td>
                <td class="whitespace-nowrap px-4 py-3 text-right">
                  ${d.status === 'completed' && d.zip_available ? `<button data-action="zip" data-id="${d.id}" class="btn-ghost rounded-lg px-2.5 py-1.5 text-xs" title="Download this ZIP"><i data-lucide="download" class="h-3.5 w-3.5"></i></button>` : ''}
                  <button data-admin-del="${d.id}" class="btn-ghost rounded-lg px-2.5 py-1.5 text-xs text-dim hover:text-rose-300" title="${isActive(d) ? 'Cancel this download' : 'Delete this download'}"><i data-lucide="${isActive(d) ? 'x' : 'trash-2'}" class="h-3.5 w-3.5"></i></button>
                </td>
              </tr>`;
            })
            .join('')
        : `<tr><td class="px-4 py-6 text-body" colspan="7">No downloads match.</td></tr>`;
      icons();
    };

    const loadAll = async () => {
      const [ov, us, st] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/settings'), loadAdminDownloads()]);
      if (state.route !== 'admin') return;
      const s = ov.stats;
      const srv = ov.server;
      $('#admin-stats').innerHTML = [
        ['users', 'Users', s.users],
        ['cloud-download', 'Downloads', s.downloads],
        ['calendar-clock', 'Last 24 hours', s.last24h],
        ['file-check-2', 'Pages saved', (s.pagesSaved || 0).toLocaleString()],
        ['check-circle-2', 'Completed', s.completed],
        ['alert-circle', 'Failed', s.failed],
        ['activity', 'Running / waiting', `${srv.running} / ${srv.queued}`],
        ['cpu', 'Server memory', srv.memoryPct == null ? '—' : `${srv.memoryPct}%`],
      ]
        .map(
          ([ic, l, v]) => `<div class="card rounded-2xl p-4"><p class="flex items-center gap-1.5 text-xs text-body"><i data-lucide="${ic}" class="h-3.5 w-3.5 text-accent-soft"></i>${l}</p><p class="mt-1.5 font-display text-2xl font-semibold">${v}</p></div>`
        )
        .join('');
      $('#admin-server').textContent = `${srv.database} database · ${srv.maxConcurrentJobs} download slot${srv.maxConcurrentJobs === 1 ? '' : 's'}`;
      const set = st.settings;
      if (document.activeElement !== $('#set-default-limit')) $('#set-default-limit').value = set.defaultMonthlyLimit ?? '';
      $('#set-registration').checked = set.registrationOpen;
      $('#set-registration').disabled = set.registrationLockedByServer;
      users = us.users;
      drawUsers();
      drawDownloads();
      patchList($('#admin-live'), state.adminDownloads.filter(isActive), { empty: 'admin', admin: true });
      icons();
    };

    try {
      await loadAll();
    } catch (err) {
      flash(msg, err.message, 'bad', 0);
    }

    // live refresh while the admin page is open (fast while something is running)
    clearTimeout(state.adminTimer);
    const tick = async () => {
      if (state.route !== 'admin') return;
      try {
        await loadAdminDownloads();
        patchList($('#admin-live'), state.adminDownloads.filter(isActive), { empty: 'admin', admin: true });
        drawDownloads();
        icons();
      } catch {}
      state.adminTimer = setTimeout(tick, state.adminDownloads.some(isActive) ? 2000 : 10000);
    };
    state.adminTimer = setTimeout(tick, 2000);

    const showSecret = (email, password, text) => {
      const box = $('#admin-secret');
      box.innerHTML = `<div class="notice info"><i data-lucide="key-round" class="mt-0.5 h-4 w-4 shrink-0"></i>
        <div class="flex-1"><p>${text} <span class="font-semibold">${esc(email)}</span> — send it to them privately.</p>
        <div class="mt-2 flex items-center gap-2"><code class="inline select-all px-2 py-1 text-[13px]">${esc(password)}</code><button type="button" id="copy-temp" class="btn-ghost rounded-lg px-2.5 py-1 text-xs">Copy</button></div></div>
        <button type="button" id="close-temp" class="opacity-60 hover:opacity-100" aria-label="Close"><i data-lucide="x" class="h-4 w-4"></i></button></div>`;
      box.classList.remove('hidden');
      icons();
      $('#copy-temp').onclick = async () => {
        try {
          await navigator.clipboard.writeText(password);
          $('#copy-temp').textContent = 'Copied';
        } catch {}
      };
      $('#close-temp').onclick = () => box.classList.add('hidden');
    };

    // ---- site settings
    $('#admin-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const v = $('#set-default-limit').value.trim();
        await api('/api/admin/settings', { method: 'PATCH', body: { defaultMonthlyLimit: v === '' ? null : parseInt(v, 10), registrationOpen: $('#set-registration').checked } });
        flash($('#settings-msg'), 'Settings saved. New accounts get this limit.');
      } catch (err) {
        flash($('#settings-msg'), err.message, 'bad', 8000);
      }
    });
    $('#apply-default').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!armed(btn, 'Apply to everyone?')) return;
      try {
        const v = $('#set-default-limit').value.trim();
        await api('/api/admin/settings', { method: 'PATCH', body: { defaultMonthlyLimit: v === '' ? null : parseInt(v, 10), applyDefaultToAll: true } });
        flash($('#settings-msg'), 'Every normal user now has the default limit.');
        await loadAll();
      } catch (err) {
        flash($('#settings-msg'), err.message, 'bad', 8000);
      }
    });

    // ---- create user
    const nuf = $('#new-user-form');
    $('#new-user-btn').addEventListener('click', () => {
      nuf.classList.toggle('hidden');
      if (!nuf.classList.contains('hidden')) nuf.querySelector('[name="name"]').focus();
    });
    $('#new-user-cancel').addEventListener('click', () => nuf.classList.add('hidden'));
    nuf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(nuf);
      const lim = String(f.get('monthlyLimit') || '').trim();
      try {
        const data = await api('/api/admin/users', {
          method: 'POST',
          body: { name: f.get('name'), email: f.get('email'), password: f.get('password'), role: f.get('role'), monthlyLimit: lim === '' ? undefined : parseInt(lim, 10) },
        });
        nuf.reset();
        nuf.classList.add('hidden');
        showSecret(data.user.email, data.password, 'Account created. Password for');
        flash(msg, `${data.user.email} was created.`);
        await loadAll();
      } catch (err) {
        flash($('#new-user-msg'), err.message, 'bad', 8000);
      }
    });

    $('#admin-user-search').addEventListener('input', drawUsers);
    $('#dl-filter-user').addEventListener('change', drawDownloads);
    $('#dl-filter-status').addEventListener('change', drawDownloads);

    // ---- delete / cancel any download
    $('#admin-downloads').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-admin-del]');
      if (!btn) return;
      if (!armed(btn, '')) return;
      try {
        await api(`/api/website-downloads/${btn.dataset.adminDel}`, { method: 'DELETE' });
        flash(msg, 'Download removed.');
        await loadAll();
        loadDownloads().catch(() => {});
      } catch (err) {
        flash(msg, err.message, 'bad', 8000);
      }
    });

    // ---- manage users
    $('#admin-users').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      const holder = e.target.closest('[data-user], [data-editor]');
      if (!btn || !holder) return;
      const id = holder.dataset.user || holder.dataset.editor;
      const u = users.find((x) => x.id === id);
      const ed = $(`[data-editor="${id}"]`);
      try {
        if (btn.matches('[data-u-manage]')) {
          openEditor = openEditor === id ? null : id;
          drawUsers();
        } else if (btn.matches('[data-u-save]')) {
          const val = (k) => ed.querySelector(`[data-e="${k}"]`).value.trim();
          const num = (k) => (val(k) === '' ? null : parseInt(val(k), 10));
          const modes = $$('[data-e-mode]', ed).filter((c) => c.checked).map((c) => c.dataset.eMode);
          const body = { name: val('name'), notes: ed.querySelector('[data-e="notes"]').value, role: val('role') };
          if (val('role') !== 'admin') {
            Object.assign(body, {
              planName: val('planName'),
              monthlyLimit: num('monthlyLimit'),
              maxPagesLimit: num('maxPagesLimit'),
              maxActiveJobs: num('maxActiveJobs'),
              allowedModes: modes.length === 3 ? null : modes,
            });
          }
          btn.disabled = true;
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body });
          flash(msg, `Saved ${u.email}.`);
          await loadAll();
        } else if (btn.matches('[data-u-reset-usage]')) {
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { resetUsage: true } });
          flash(msg, `Usage reset for ${u.email}.`);
          await loadAll();
        } else if (btn.matches('[data-u-view]')) {
          $('#dl-filter-user').value = u.email;
          drawDownloads();
          $('#admin-downloads').scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (btn.matches('[data-u-toggle]')) {
          const disable = !btn.dataset.disabled;
          if (disable && !armed(btn, 'Disable?')) return;
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { disabled: disable } });
          flash(msg, disable ? `${u.email} is disabled and signed out.` : `${u.email} can sign in again.`);
          await loadAll();
        } else if (btn.matches('[data-u-delete]')) {
          if (!armed(btn, 'Delete for good?')) return;
          btn.disabled = true;
          await api(`/api/admin/users/${id}`, { method: 'DELETE' });
          openEditor = null;
          flash(msg, `${u.email} was deleted.`);
          await loadAll();
        } else if (btn.matches('[data-u-reset-pw]')) {
          if (!armed(btn, 'Set new password?')) return;
          const data = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
          showSecret(u.email, data.temporaryPassword, 'New password (they were signed out everywhere) for');
        }
      } catch (err) {
        flash(msg, err.message, 'bad', 8000);
        btn.disabled = false;
      }
    });
  }

  // --------------------------------------------------------------------------
  // Router
  // --------------------------------------------------------------------------
  const ROUTES = {
    dashboard: renderDashboard,
    downloader: renderDownloader,
    library: renderLibrary,
    history: renderHistory,
    tutorial: renderTutorial,
    settings: () => renderSettings('general'),
    admin: renderAdmin,
  };

  function route() {
    const name = (location.hash.replace(/^#/, '').split('?')[0] || 'dashboard').toLowerCase();
    state.route = ROUTES[name] ? name : 'dashboard';
    closeSidebar();
    updateSidebar();
    const result = ROUTES[state.route]();
    icons();
    if (result && typeof result.then === 'function') result.then(icons);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  async function boot() {
    updateSidebar();
    try {
      const [me, cfg] = await Promise.all([api('/api/auth/me'), api('/api/config', { auth: false }).catch(() => null)]);
      state.user = me.user;
      state.allowance = me.allowance;
      session.saveUser(me.user);
      if (cfg) state.config = { ...state.config, ...cfg };
    } catch (err) {
      view.innerHTML = `<div class="card rounded-2xl p-6"><p class="font-semibold">Could not load your account</p><p class="mt-1 text-sm text-body">${esc(err.message)}</p>
        <button onclick="location.reload()" class="btn-primary mt-4 rounded-lg px-4 py-2 text-sm font-semibold">Try again</button></div>`;
      return;
    }
    route();
    try {
      await loadDownloads();
      refreshLists();
    } catch (err) {
      const box = $('#recent-list') || $('#dash-recent') || $('#history-list');
      if (box) box.innerHTML = `<li class="notice bad">${esc(err.message)}</li>`;
    }
  }

  boot();
})();
