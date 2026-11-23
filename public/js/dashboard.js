// ============================================================================
// SiteClone — signed-in dashboard (single page app, hash routes)
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
    route: 'dashboard',
    pollTimer: null,
    historyFilter: 'all',
    historySearch: '',
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
    },
  };

  const isAdmin = () => state.user?.role === 'admin';
  const ACTIVE = ['queued', 'running', 'processing'];
  const isActive = (d) => ACTIVE.includes(d.status);
  const icons = () => window.lucide && window.lucide.createIcons();
  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

  // --------------------------------------------------------------------------
  // Toasts
  // --------------------------------------------------------------------------
  function toast(message, type = 'info') {
    const colors = {
      info: 'border-white/10 text-white',
      success: 'border-mint/30 text-mint',
      error: 'border-rose-500/40 text-rose-300',
    };
    const el = document.createElement('div');
    el.className = `toast pointer-events-auto max-w-sm rounded-xl border bg-ink-900 px-4 py-3 text-sm shadow-2xl ${colors[type] || colors.info}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
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
      $('#credits-text').textContent = a.unlimited ? 'Unlimited' : `${a.remaining} / ${a.limit}`;
      $('#credits-plan').textContent = a.unlimited ? `${a.plan} account` : `${a.plan} plan · resets ${fmtDay(a.resetsAt)}`;
    }
    $$('.nav-link').forEach((l) => l.classList.toggle('is-active', l.dataset.route === state.route));
  }

  $('#user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#user-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('#user-menu').classList.add('hidden'));
  $('#logout-btn').addEventListener('click', () => {
    session.clear();
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
  // Data
  // --------------------------------------------------------------------------
  async function loadDownloads() {
    const data = await api('/api/website-downloads');
    state.downloads = data.downloads || [];
    state.allowance = data.allowance || state.allowance;
    state.downloadsLoaded = true;
    updateSidebar();
    ensurePolling();
  }

  function ensurePolling() {
    const anyActive = state.downloads.some(isActive);
    if (anyActive && !state.pollTimer) {
      state.pollTimer = setInterval(pollDownloads, 2500);
    } else if (!anyActive && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollDownloads() {
    try {
      const before = state.downloads.filter(isActive).length;
      await loadDownloads();
      const after = state.downloads.filter(isActive).length;
      if (after < before) {
        const justDone = state.downloads.find((d) => d.status === 'completed' && Date.now() - new Date(d.finished_at).getTime() < 6000);
        if (justDone) toast(`Your ZIP of ${justDone.domain} is ready.`, 'success');
      }
      refreshLists();
    } catch {}
  }

  // Re-render only the download lists (keeps form inputs untouched)
  function refreshLists() {
    const recent = $('#recent-list');
    if (recent) recent.innerHTML = downloadListHtml(state.downloads.slice(0, 5), { empty: 'downloader' });
    const dash = $('#dash-recent');
    if (dash) dash.innerHTML = downloadListHtml(state.downloads.slice(0, 5), { compact: true, empty: 'dashboard' });
    const hist = $('#history-list');
    if (hist) renderHistoryList();
    const stats = $('#dash-stats');
    if (stats) stats.innerHTML = dashStatsHtml();
    const banner = $('#allowance-banner');
    if (banner) banner.innerHTML = allowanceBannerHtml();
    icons();
  }

  // --------------------------------------------------------------------------
  // Download list item
  // --------------------------------------------------------------------------
  const STATUS = {
    queued: { label: 'Starting', icon: 'clock', cls: 'text-body bg-white/[0.06]' },
    running: { label: 'Downloading', icon: 'loader-2', cls: 'text-accent-soft bg-accent/15', spin: true },
    processing: { label: 'Saving ZIP', icon: 'loader-2', cls: 'text-accent-soft bg-accent/15', spin: true },
    completed: { label: 'Ready', icon: 'check-circle-2', cls: 'text-mint bg-mint/10' },
    failed: { label: 'Failed', icon: 'alert-circle', cls: 'text-rose-300 bg-rose-500/10' },
  };

  const ERROR_HINTS = {
    LOGIN_FAILED: 'Sign in to the website again in your browser, export fresh cookies with Cookie-Editor (Export → JSON) and try again.',
    INVALID_INPUT: 'Check the website address, or paste the cookie export again (Cookie-Editor → Export → JSON).',
    ROBOTS_DISALLOWED: 'If you are allowed to copy this website, tick “Ignore robots.txt” under More options and try again.',
    SERVER_RESTART: 'Start the download again — it was not counted.',
  };

  function metaLine(d) {
    return [
      fmtDate(d.created_at),
      d.mode === 'single_page' ? 'single page' : `up to ${d.max_pages} pages`,
      d.status === 'completed' && d.pages != null ? `${d.pages} page${d.pages === 1 ? '' : 's'}` : null,
      d.status === 'completed' && d.assets != null ? `${d.assets} asset${d.assets === 1 ? '' : 's'}` : null,
      d.zip_size_bytes ? formatBytes(d.zip_size_bytes) : null,
      d.stopped_early ? 'stopped early' : null,
      d.options?.stripScripts ? 'no JavaScript' : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function downloadItemHtml(d, { compact = false } = {}) {
    const st = STATUS[d.status] || STATUS.queued;
    const label = d.status === 'queued' && d.queue_position ? `Waiting · #${d.queue_position} in line` : st.label;
    const active = isActive(d);
    const pct = Math.max(2, Math.min(100, d.progress?.pct || 0));
    const lastLog = (d.logs || []).slice(-1)[0];

    const actions = [];
    if (d.status === 'running') {
      actions.push(
        `<button data-action="stop" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium" ${d.stop_requested_at ? 'disabled' : ''}>
          <i data-lucide="square" class="h-3.5 w-3.5"></i>${d.stop_requested_at ? 'Stopping…' : 'Stop &amp; download'}</button>`
      );
    }
    if (d.status === 'completed' && d.zip_available) {
      actions.push(
        `<button data-action="zip" data-id="${d.id}" class="btn-primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"><i data-lucide="download" class="h-3.5 w-3.5"></i>Download ZIP</button>`,
        `<button data-action="preview" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"><i data-lucide="eye" class="h-3.5 w-3.5"></i>Preview</button>`
      );
      if (isAdmin() && !d.library_id) {
        actions.push(
          `<button data-action="publish" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium" title="Make this ZIP available to every user in the Website Library"><i data-lucide="library" class="h-3.5 w-3.5"></i>Add to library</button>`
        );
      }
    }
    if (d.status === 'completed' && !d.zip_available) {
      actions.push(`<span class="text-xs text-dim">ZIP expired on the server</span>`);
    }
    if (d.status === 'failed') {
      actions.push(
        `<button data-action="retry" data-id="${d.id}" class="btn-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"><i data-lucide="rotate-ccw" class="h-3.5 w-3.5"></i>Try again</button>`
      );
    }
    actions.push(
      `<button data-action="delete" data-id="${d.id}" class="flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-rose-500/10 hover:text-rose-300" aria-label="${active ? 'Cancel download' : 'Delete download'}" title="${active ? 'Cancel' : 'Delete'}">
        <i data-lucide="${active ? 'x' : 'trash-2'}" class="h-4 w-4"></i></button>`
    );

    return `
      <li class="card rounded-2xl p-4 sm:p-5">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="badge ${st.cls}"><i data-lucide="${st.icon}" class="h-3.5 w-3.5 ${st.spin ? 'spin' : ''}"></i>${esc(label)}</span>
              <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" class="min-w-0 truncate text-sm font-semibold hover:underline">${esc(d.url)}</a>
              ${d.login_method ? `<span class="badge bg-white/[0.05] text-body"><i data-lucide="lock" class="h-3 w-3"></i>Signed in with cookies</span>` : ''}
              ${d.library_id ? `<span class="badge bg-accent/10 text-accent-soft"><i data-lucide="library" class="h-3 w-3"></i>In library</span>` : ''}
            </div>
            <p class="mt-1.5 text-xs text-dim">${esc(metaLine(d))}</p>
            ${
              active
                ? `<div class="mt-3">
                    <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"><div class="h-full rounded-full bg-gradient-to-r from-accent to-accent-soft transition-all duration-500" style="width:${pct}%"></div></div>
                    <p class="mt-1.5 truncate text-xs text-body">${esc(d.progress?.title || 'Working…')}${
                      d.pages ? ` · ${d.pages}${d.mode === 'single_page' ? '' : ` of ${d.max_pages}`} page${d.pages === 1 ? '' : 's'}` : ''
                    }</p>
                    ${!compact && lastLog ? `<p class="mt-0.5 truncate font-mono text-[11px] text-dim">${esc(lastLog.text)}</p>` : ''}
                  </div>`
                : ''
            }
            ${
              d.status === 'failed'
                ? `<p class="mt-2 text-xs text-rose-300">${esc(d.error_message || 'The download failed.')}</p>
                   ${ERROR_HINTS[d.error_code] && !String(d.error_message || '').includes('try again') ? `<p class="mt-0.5 text-xs text-dim">${esc(ERROR_HINTS[d.error_code])}</p>` : ''}
                   <p class="mt-0.5 text-[11px] text-dim">A download that fails is not counted.</p>`
                : ''
            }
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">${actions.join('')}</div>
        </div>
      </li>`;
  }

  function downloadListHtml(list, { compact = false, empty = 'downloader' } = {}) {
    if (!state.downloadsLoaded) {
      return `<li class="card animate-pulse rounded-2xl p-5"><div class="h-3 w-1/2 rounded bg-white/[0.06]"></div><div class="mt-3 h-3 w-1/3 rounded bg-white/[0.04]"></div></li>`;
    }
    if (!list.length) {
      return `<li class="card rounded-2xl px-6 py-10 text-center">
        <i data-lucide="inbox" class="mx-auto h-6 w-6 text-dim"></i>
        <p class="mt-3 text-sm font-medium">No downloads yet</p>
        <p class="mt-1 text-sm text-body">${
          empty === 'dashboard' ? 'Start your first download from the Website Downloader.' : 'Enter a website address above to download your first site.'
        }</p>
        ${empty === 'dashboard' ? `<a href="#downloader" class="btn-primary mt-4 inline-flex rounded-lg px-4 py-2 text-sm font-medium">New download</a>` : ''}
      </li>`;
    }
    return list.map((d) => downloadItemHtml(d, { compact })).join('');
  }

  // Actions on any download list (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !view.contains(btn)) return;
    const id = btn.dataset.id;
    const d = state.downloads.find((x) => x.id === id);
    const action = btn.dataset.action;

    try {
      if (action === 'stop') {
        if (!confirm('Stop this download now and get a ZIP of the pages saved so far?\n\nNo more pages will be downloaded. It counts as one download.')) return;
        btn.disabled = true;
        const data = await api(`/api/website-downloads/${id}/stop`, { method: 'POST' });
        Object.assign(d, data.download);
        refreshLists();
      } else if (action === 'delete') {
        const msg = d && isActive(d) ? 'Cancel this download?' : d?.status === 'completed' ? 'Delete this download and its ZIP file?' : 'Remove this download?';
        if (!confirm(msg)) return;
        btn.disabled = true;
        await api(`/api/website-downloads/${id}`, { method: 'DELETE' });
        state.downloads = state.downloads.filter((x) => x.id !== id);
        await loadDownloads().catch(() => {});
        refreshLists();
      } else if (action === 'zip') {
        btn.disabled = true;
        const data = await api(`/api/website-downloads/${id}/link`, { method: 'POST', body: { kind: 'zip' } });
        location.href = apiUrl(data.url);
        setTimeout(() => (btn.disabled = false), 2000);
      } else if (action === 'preview') {
        const win = window.open('about:blank', '_blank');
        const data = await api(`/api/website-downloads/${id}/link`, { method: 'POST', body: { kind: 'preview' } });
        if (win) win.location.href = apiUrl(data.url);
        else location.href = apiUrl(data.url);
      } else if (action === 'publish') {
        const title = prompt('Title for the Website Library:', d?.domain || '');
        if (title === null) return;
        btn.disabled = true;
        await api('/api/library', { method: 'POST', body: { downloadId: id, title } });
        toast('Added to the Website Library.', 'success');
        await loadDownloads();
        refreshLists();
      } else if (action === 'retry') {
        Object.assign(state.form, {
          mode: d.mode,
          url: d.url,
          maxPages: d.max_pages > 1 ? d.max_pages : state.form.maxPages,
          stripScripts: Boolean(d.options?.stripScripts),
          ignoreRobots: d.error_code === 'ROBOTS_DISALLOWED' ? state.form.ignoreRobots : Boolean(d.options?.ignoreRobots),
        });
        location.hash = '#downloader';
        if (d.mode === 'cookie_export') toast('Paste a fresh cookie export to try again.');
      }
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'error');
    }
  });

  // --------------------------------------------------------------------------
  // Allowance banner & stats
  // --------------------------------------------------------------------------
  function allowanceBannerHtml() {
    const a = state.allowance;
    if (!a) return '';
    if (a.unlimited) {
      return `<i data-lucide="infinity" class="h-4 w-4 text-mint"></i><span><span class="text-white">${esc(a.plan)}</span> · unlimited downloads</span>`;
    }
    return `<i data-lucide="gauge" class="h-4 w-4 ${a.remaining > 0 ? 'text-accent-soft' : 'text-rose-300'}"></i>
      <span><span class="text-white">${esc(a.plan)} plan · ${a.remaining} of ${a.limit} downloads left</span>
      <span class="block text-xs text-dim">Resets ${fmtDay(a.resetsAt)}. A download that fails is not counted.</span></span>`;
  }

  function dashStatsHtml() {
    const done = state.downloads.filter((d) => d.status === 'completed').length;
    const ready = state.downloads.filter((d) => d.status === 'completed' && d.zip_available).length;
    const a = state.allowance;
    const cards = [
      { icon: 'cloud-download', label: 'Websites downloaded', value: done },
      { icon: 'file-archive', label: 'ZIP files ready', value: ready },
      { icon: 'coins', label: 'Downloads left', value: !a ? '—' : a.unlimited ? '∞' : a.remaining },
    ];
    return cards
      .map(
        (c) => `<div class="card rounded-2xl p-5">
          <div class="flex items-center gap-2 text-sm text-body"><i data-lucide="${c.icon}" class="h-4 w-4 text-accent-soft"></i>${c.label}</div>
          <p class="mt-2 text-3xl font-semibold tracking-tight">${c.value}</p>
        </div>`
      )
      .join('');
  }

  const pageHeader = (icon, title, subtitle, extra = '') => `
    <div class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="flex items-center gap-2.5 text-2xl font-semibold tracking-tight sm:text-3xl"><i data-lucide="${icon}" class="h-6 w-6 text-accent-soft"></i>${title}</h1>
        <p class="mt-2 max-w-2xl text-sm text-body">${subtitle}</p>
      </div>
      ${extra}
    </div>`;

  // --------------------------------------------------------------------------
  // Views
  // --------------------------------------------------------------------------
  function renderDashboard() {
    const first = (state.user?.name || '').split(' ')[0] || 'there';
    view.innerHTML = `
      ${pageHeader('layout-dashboard', `Welcome back, ${esc(first)}`, 'Download any website as a ZIP of HTML files, ready to open offline.')}
      <div id="dash-stats" class="grid gap-4 sm:grid-cols-3">${dashStatsHtml()}</div>

      <section class="mt-10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Recent downloads</h2>
          <div class="flex items-center gap-3">
            <a href="#history" class="text-sm text-body hover:text-white">View all</a>
            <a href="#downloader" class="btn-primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium"><i data-lucide="plus" class="h-4 w-4"></i>New</a>
          </div>
        </div>
        <ul id="dash-recent" class="space-y-3">${downloadListHtml(state.downloads.slice(0, 5), { compact: true, empty: 'dashboard' })}</ul>
      </section>

      <section class="mt-10">
        <h2 class="mb-4 text-lg font-semibold">Quick actions</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          ${[
            ['#downloader', 'cloud-download', 'Website Downloader', 'Download a single page, a whole website, or your own signed-in pages.'],
            ['#library', 'library', 'Website Library', 'Websites we have already downloaded — free for every user.'],
            ['#history', 'history', 'History', 'Download your previous ZIP files again.'],
            ['#settings', 'settings', 'Settings', 'Manage your profile, password and plan.'],
          ]
            .map(
              ([href, icon, title, text]) => `<a href="${href}" class="card group flex items-start gap-4 rounded-2xl p-5 transition hover:border-accent/40">
                <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15"><i data-lucide="${icon}" class="h-5 w-5 text-accent-soft"></i></span>
                <span><span class="block font-medium">${title}</span><span class="mt-1 block text-sm text-body">${text}</span></span>
              </a>`
            )
            .join('')}
        </div>
      </section>`;
  }

  // ---------- Website Downloader ----------
  const MODES = [
    { id: 'single_page', icon: 'file', title: 'Single Page', text: 'Just the page you enter — its links are not followed.' },
    { id: 'full_website', icon: 'globe', title: 'Full Frontend Website', text: 'Every public page of the site — what anyone sees without logging in.' },
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
    $('#dl-reason').textContent = reason && !state.form.submitting ? reason : '';
    $('#dl-submit-text').textContent = state.form.submitting ? 'Starting…' : 'Download website';
  }

  function cookiePanelHtml() {
    const f = state.form;
    const cErr = cookieCheck();
    const lErr = lsCheck();
    return `
      <div class="space-y-5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 sm:p-5">
        <div>
          <p class="flex items-center gap-2 text-sm font-medium"><i data-lucide="lightbulb" class="h-4 w-4 text-amber-300"></i>Sign in with your own session</p>
          <ol class="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-body">
            <li>Open the website — an account that is yours, or that you are authorised to access — and sign in as usual.</li>
            <li>Install the free <a class="text-accent-soft underline" href="https://cookie-editor.com" target="_blank" rel="noopener">Cookie-Editor</a> browser extension.</li>
            <li>On that website, click the Cookie-Editor icon in the toolbar, then <span class="font-semibold text-white">Export</span> → <span class="font-semibold text-white">JSON</span> (not “Header String” or “Netscape”). It is copied for you.</li>
            <li>Paste everything it copied below — from the first <code class="inline">[</code> to the last <code class="inline">]</code>.</li>
          </ol>
        </div>

        <div>
          <label for="dl-cookies" class="mb-1.5 block text-sm font-medium">Cookie export (JSON)</label>
          <textarea id="dl-cookies" rows="5" class="field" placeholder='[{"domain": ".example.com", "name": "session", "value": "…", …}]'>${esc(f.cookies)}</textarea>
          <p id="dl-cookies-err" class="mt-1.5 text-xs text-amber-300 ${cErr ? '' : 'hidden'}">${esc(cErr || '')}</p>
          <details class="mt-2">
            <summary class="text-xs font-medium text-body hover:text-white">What the JSON export looks like</summary>
            <p class="mt-2 text-xs leading-relaxed text-dim">A list in square brackets, with one entry per cookie. Each entry has the website’s <code class="inline">domain</code>, a <code class="inline">name</code> and a <code class="inline">value</code>, plus fields like <code class="inline">path</code>, <code class="inline">secure</code> and <code class="inline">expirationDate</code>.</p>
          </details>
        </div>

        <details ${f.localStorage ? 'open' : ''} class="rounded-xl border border-white/[0.06] p-3">
          <summary class="flex items-center justify-between text-sm font-medium">
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

        <label class="flex items-start gap-2.5 rounded-xl border border-white/[0.06] p-3 text-sm">
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

    const pageOpts = state.config.pageOptions || [10, 25, 50, 100];
    if (f.maxPages !== 'custom' && !pageOpts.includes(f.maxPages)) f.maxPages = pageOpts[0];

    view.innerHTML = `
      ${pageHeader('cloud-download', 'Website Downloader', 'Enter a website address and get a ZIP of its pages as HTML files, with the CSS, JavaScript, fonts and images, ready to open offline.')}

      <div id="allowance-banner" class="card mb-6 flex items-start gap-3 rounded-2xl px-5 py-4 text-sm text-body">${allowanceBannerHtml()}</div>

      <form id="dl-form" class="clone-card space-y-6 rounded-2xl p-5 sm:p-6" novalidate>
        <fieldset>
          <legend class="mb-3 text-sm font-medium">What kind of website is it?</legend>
          <div class="grid gap-3 md:grid-cols-3">
            ${MODES.map(
              (m) => `<label class="mode-card ${f.mode === m.id ? 'is-active' : ''} flex flex-col gap-2 rounded-xl p-4">
                <span class="flex items-center gap-2">
                  <input type="radio" name="mode" value="${m.id}" class="h-4 w-4" ${f.mode === m.id ? 'checked' : ''} />
                  <i data-lucide="${m.icon}" class="h-4 w-4 text-accent-soft"></i>
                  <span class="text-sm font-semibold">${m.title}</span>
                </span>
                <span class="text-xs leading-relaxed text-body">${m.text}</span>
              </label>`
            ).join('')}
          </div>
        </fieldset>

        <div>
          <label for="dl-url" class="mb-1.5 block text-sm font-medium">${f.mode === 'single_page' ? 'Page URL' : 'Website URL'}</label>
          <div class="relative">
            <i data-lucide="link" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dim"></i>
            <input id="dl-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com" value="${esc(f.url)}" class="field pl-10" />
          </div>
          ${f.mode === 'single_page' ? `<p class="mt-1.5 text-xs text-dim">Only this one page is saved. Links to other pages of the site are not followed.</p>` : ''}
          ${f.mode === 'cookie_export' ? `<p class="mt-1.5 text-xs text-dim">The first signed-in page to save, e.g. https://app.example.com/dashboard</p>` : ''}
        </div>

        ${
          f.mode !== 'single_page'
            ? `<div class="grid gap-5 md:grid-cols-2">
                <div>
                  <label for="dl-pages" class="mb-1.5 block text-sm font-medium">Maximum pages</label>
                  <select id="dl-pages" class="field">
                    ${pageOpts.map((n) => `<option value="${n}" ${f.maxPages === n ? 'selected' : ''}>${n} pages</option>`).join('')}
                    ${isAdmin() ? `<option value="custom" ${f.maxPages === 'custom' ? 'selected' : ''}>Custom number…</option>` : ''}
                  </select>
                  ${
                    f.maxPages === 'custom'
                      ? `<input id="dl-custom-pages" type="number" min="1" max="${state.config.maxPages}" placeholder="Number of pages" value="${esc(f.customPages)}" class="field mt-2" />
                         <p class="mt-1.5 text-xs text-dim">Admin only. 1–${state.config.maxPages} pages. If time runs out, the pages saved so far are still zipped.</p>`
                      : ''
                  }
                </div>
                <div>
                  <label for="dl-extra" class="mb-1.5 block text-sm font-medium">Extra pages to include <span class="font-normal text-dim">(optional)</span></label>
                  <textarea id="dl-extra" rows="3" class="field" placeholder="/dashboard/settings&#10;/dashboard/billing&#10;https://app.example.com/projects/123">${esc(f.extraUrls)}</textarea>
                  <p class="mt-1.5 text-xs text-dim">One page per line — full addresses or paths. For screens the crawl can’t reach through links, such as pages opened by buttons. Up to 50.</p>
                </div>
              </div>`
            : ''
        }

        ${f.mode === 'cookie_export' ? cookiePanelHtml() : ''}

        <details class="rounded-xl border border-white/[0.06] p-4" ${f.stripScripts || f.ignoreRobots || f.viewport === 'mobile' ? 'open' : ''}>
          <summary class="flex items-center justify-between text-sm font-medium"><span class="flex items-center gap-2"><i data-lucide="sliders-horizontal" class="h-4 w-4 text-dim"></i>More options</span><i data-lucide="chevron-down" class="chev h-4 w-4 text-dim"></i></summary>
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
            <p>Usually a few minutes; larger sites take longer. You can leave this page — the ZIP will be waiting in History.</p>
          </div>
        </div>
        <p class="flex gap-2 border-t border-white/[0.06] pt-4 text-xs leading-relaxed text-dim"><i data-lucide="info" class="mt-0.5 h-3.5 w-3.5 shrink-0"></i>Saved pages are snapshots: on sites built with React, Vue, Next.js and similar, they look right but buttons, filters and search do not work offline.</p>
      </form>

      <section class="mt-10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Recent downloads</h2>
          <a href="#history" class="flex items-center gap-1 text-sm text-body hover:text-white">View all history<i data-lucide="arrow-right" class="h-4 w-4"></i></a>
        </div>
        <ul id="recent-list" class="space-y-3">${downloadListHtml(state.downloads.slice(0, 5))}</ul>
      </section>`;

    bindDownloaderForm();
    updateSubmitState();
  }

  function bindDownloaderForm() {
    const f = state.form;
    const form = $('#dl-form');

    $$('input[name="mode"]', form).forEach((r) =>
      r.addEventListener('change', () => {
        f.mode = r.value;
        renderDownloader();
        icons();
      })
    );
    $('#dl-url').addEventListener('input', (e) => {
      f.url = e.target.value;
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
          setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
        } catch {
          toast('Select the command and copy it manually.', 'error');
        }
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
        // Session data is used once — clear it from the form
        Object.assign(f, { url: '', cookies: '', localStorage: '', authorized: false, extraUrls: '' });
        f.submitting = false;
        toast('Download started. You can leave this page — it keeps running.', 'success');
        updateSidebar();
        renderDownloader();
        icons();
        ensurePolling();
      } catch (err) {
        f.submitting = false;
        updateSubmitState();
        if (err.data?.allowance) {
          state.allowance = err.data.allowance;
          updateSidebar();
        }
        toast(err.message, 'error');
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
        `<a href="#downloader" class="btn-primary flex items-center gap-1.5 self-start rounded-lg px-4 py-2 text-sm font-medium sm:self-auto"><i data-lucide="plus" class="h-4 w-4"></i>New download</a>`
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
    if (countEl) countEl.textContent = state.downloadsLoaded ? `${list.length} of ${state.downloads.length} downloads` : '';
    const el = $('#history-list');
    if (!el) return;
    el.innerHTML =
      state.downloadsLoaded && !list.length && state.downloads.length
        ? `<li class="card rounded-2xl px-6 py-10 text-center text-sm text-body">No downloads match this filter.</li>`
        : downloadListHtml(list);
  }

  // ---------- Library ----------
  async function renderLibrary() {
    view.innerHTML = `
      ${pageHeader('library', 'Website Library', 'Websites we have already downloaded for you. Download any of them as a ZIP — it doesn’t use up your plan’s downloads.')}
      <div class="relative mb-6 sm:w-80">
        <i data-lucide="search" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dim"></i>
        <input id="lib-search" type="search" placeholder="Search websites" class="field pl-10" />
      </div>
      <div id="lib-grid" class="grid gap-4 sm:grid-cols-2"><div class="card animate-pulse rounded-2xl p-6"><div class="h-3 w-1/2 rounded bg-white/[0.06]"></div></div></div>
      ${isAdmin() ? `<p class="mt-6 text-xs text-dim">Admin: add a finished download to the library from its <a href="#history" class="underline">History</a> entry (“Add to library”).</p>` : ''}`;
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
                <p class="font-medium">${esc(i.title)}</p>
                <a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer" class="mt-1 flex items-center gap-1 truncate text-sm text-accent-soft hover:underline">${esc(i.domain)}<i data-lucide="external-link" class="h-3.5 w-3.5"></i></a>
                <p class="mt-2 text-xs text-dim">${i.pages === 1 ? 'Single page' : `${i.pages ?? '?'} pages`} · ${formatBytes(i.zip_size_bytes)}</p>
                <div class="mt-4 flex items-center gap-2">
                  ${
                    i.available
                      ? `<button data-lib-zip="${i.id}" class="btn-primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"><i data-lucide="download" class="h-3.5 w-3.5"></i>Download ZIP</button>`
                      : `<span class="text-xs text-dim">Not available right now</span>`
                  }
                  ${isAdmin() ? `<button data-lib-del="${i.id}" class="btn-danger ml-auto rounded-lg px-3 py-1.5 text-xs font-medium">Remove</button>` : ''}
                </div>
              </div>`
            )
            .join('')
        : `<div class="card col-span-full rounded-2xl px-6 py-10 text-center">
            <i data-lucide="library" class="mx-auto h-6 w-6 text-dim"></i>
            <p class="mt-3 text-sm font-medium">${items.length ? 'No websites match your search' : 'The library is empty'}</p>
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
          const data = await api(`/api/library/${zip.dataset.libZip}/link`, { method: 'POST' });
          location.href = apiUrl(data.url);
        } else if (del) {
          if (!confirm('Remove this website from the library? Its ZIP file is deleted.')) return;
          await api(`/api/library/${del.dataset.libDel}`, { method: 'DELETE' });
          items = items.filter((i) => i.id !== del.dataset.libDel);
          draw();
          loadDownloads().catch(() => {});
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ---------- Tutorial ----------
  function renderTutorial() {
    const step = (n, title, body) => `<li class="flex gap-4">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-xs text-accent-soft">${n}</span>
      <div><p class="font-medium">${title}</p><p class="mt-1 text-sm leading-relaxed text-body">${body}</p></div></li>`;
    view.innerHTML = `
      ${pageHeader('graduation-cap', 'Tutorial', 'Learn how to use SiteClone step by step.')}
      <div class="space-y-6">
        <section class="card rounded-2xl p-6">
          <h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="file" class="h-5 w-5 text-accent-soft"></i>Download a single page</h2>
          <ol class="mt-5 space-y-5">
            ${step(1, 'Open the Website Downloader', 'Choose <span class="text-white">Single Page</span>.')}
            ${step(2, 'Paste the page address', 'For example https://example.com/pricing. Only this page is saved — links are not followed.')}
            ${step(3, 'Download the ZIP', 'When the status turns <span class="text-mint">Ready</span>, click Download ZIP. Unzip it and open <code class="inline">index.html</code> in your browser.')}
          </ol>
        </section>
        <section class="card rounded-2xl p-6">
          <h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="globe" class="h-5 w-5 text-accent-soft"></i>Download a whole website</h2>
          <ol class="mt-5 space-y-5">
            ${step(1, 'Choose Full Frontend Website', 'Enter the home page address and how many pages to save at most.')}
            ${step(2, 'Add pages the crawl can’t find (optional)', 'Pages that are only reachable through buttons or forms can be listed under <span class="text-white">Extra pages</span>, one per line.')}
            ${step(3, 'Stop early if you like', 'While it runs, <span class="text-white">Stop &amp; download</span> zips the pages saved so far. It counts as one download.')}
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
            <li>ZIP files are kept on the server for a limited time. Download them soon after they are ready.</li>
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
              <div><label class="mb-1.5 block text-sm font-medium" for="set-name">Full name</label><input id="set-name" class="field" value="${esc(u.name || '')}" maxlength="80" /></div>
              <div><label class="mb-1.5 block text-sm font-medium" for="set-email">Email</label><input id="set-email" class="field" value="${esc(u.email || '')}" disabled />
                <p class="mt-1.5 text-xs text-dim">To change your email address, contact the admin.</p></div>
            </div>
            <button class="btn-primary mt-5 rounded-lg px-4 py-2 text-sm font-medium">Save changes</button>
          </form>

          <form id="pw-form" class="card rounded-2xl p-6">
            <h2 class="text-lg font-semibold">Password</h2>
            <p class="mt-1 text-sm text-body">Choose a new password for signing in. Other devices are signed out.</p>
            <div class="mt-5 grid gap-4 sm:grid-cols-3">
              <div><label class="mb-1.5 block text-sm font-medium" for="pw-current">Current password</label><input id="pw-current" type="password" autocomplete="current-password" class="field" /></div>
              <div><label class="mb-1.5 block text-sm font-medium" for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password" class="field" /></div>
              <div><label class="mb-1.5 block text-sm font-medium" for="pw-repeat">Repeat new password</label><input id="pw-repeat" type="password" autocomplete="new-password" class="field" /></div>
            </div>
            <button class="btn-primary mt-5 rounded-lg px-4 py-2 text-sm font-medium">Change password</button>
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
          session.save(null, data.user);
          updateSidebar();
          toast('Profile saved.', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      $('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const cur = $('#pw-current').value;
        const nw = $('#pw-new').value;
        if (nw !== $('#pw-repeat').value) return toast('The new passwords do not match.', 'error');
        if (nw.length < 8) return toast('Use at least 8 characters.', 'error');
        try {
          const data = await api('/api/me/password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
          session.save(data.token);
          e.target.reset();
          toast('Password changed.', 'success');
        } catch (err) {
          toast(err.message, 'error');
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
                  <div><p class="text-xs text-dim">Plan</p><p class="mt-1 text-xl font-semibold">${esc(a.plan)}</p></div>
                  <div><p class="text-xs text-dim">Downloads left</p><p class="mt-1 text-xl font-semibold">${a.remaining} <span class="text-sm font-normal text-dim">of ${a.limit}</span></p></div>
                  <div><p class="text-xs text-dim">Resets</p><p class="mt-1 text-xl font-semibold">${fmtDay(a.resetsAt)}</p></div>
                </div>
                <div class="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div class="h-full rounded-full bg-accent" style="width:${a.limit ? Math.min(100, (a.used / a.limit) * 100) : 0}%"></div></div>
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
  async function renderAdmin() {
    if (!isAdmin()) {
      location.hash = '#dashboard';
      return;
    }
    view.innerHTML = `
      ${pageHeader('shield-check', 'Admin panel', 'Users, download limits and everything downloaded on this server.')}
      <div id="admin-stats" class="grid gap-4 sm:grid-cols-3 lg:grid-cols-6"></div>
      <section class="mt-10">
        <h2 class="mb-4 text-lg font-semibold">Users</h2>
        <div class="card overflow-x-auto rounded-2xl"><table class="w-full min-w-[760px] text-left text-sm">
          <thead class="border-b border-white/[0.06] text-xs uppercase tracking-wider text-dim">
            <tr><th class="px-4 py-3 font-medium">User</th><th class="px-4 py-3 font-medium">Role</th><th class="px-4 py-3 font-medium">Used / limit</th><th class="px-4 py-3 font-medium">Monthly limit</th><th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3 font-medium"></th></tr>
          </thead>
          <tbody id="admin-users"><tr><td class="px-4 py-6 text-body" colspan="6">Loading…</td></tr></tbody>
        </table></div>
        <p class="mt-2 text-xs text-dim">Leave the monthly limit empty for unlimited downloads.</p>
      </section>
      <section class="mt-10">
        <h2 class="mb-4 text-lg font-semibold">All downloads</h2>
        <div class="card overflow-x-auto rounded-2xl"><table class="w-full min-w-[760px] text-left text-sm">
          <thead class="border-b border-white/[0.06] text-xs uppercase tracking-wider text-dim">
            <tr><th class="px-4 py-3 font-medium">Website</th><th class="px-4 py-3 font-medium">User</th><th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3 font-medium">Result</th><th class="px-4 py-3 font-medium">Date</th></tr>
          </thead>
          <tbody id="admin-downloads"><tr><td class="px-4 py-6 text-body" colspan="5">Loading…</td></tr></tbody>
        </table></div>
      </section>`;
    icons();

    const loadAll = async () => {
      const [ov, us, dl] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/downloads')]);
      const s = ov.stats;
      const srv = ov.server;
      $('#admin-stats').innerHTML = [
        ['users', 'Users', s.users],
        ['cloud-download', 'Downloads', s.downloads],
        ['check-circle-2', 'Completed', s.completed],
        ['alert-circle', 'Failed', s.failed],
        ['loader-2', 'Running / waiting', `${srv.running} / ${srv.queued}`],
        ['cpu', 'Server memory', srv.memoryPct == null ? '—' : `${srv.memoryPct}%`],
      ]
        .map(
          ([ic, l, v]) => `<div class="card rounded-2xl p-4"><p class="flex items-center gap-1.5 text-xs text-body"><i data-lucide="${ic}" class="h-3.5 w-3.5 text-accent-soft"></i>${l}</p><p class="mt-1.5 text-xl font-semibold">${v}</p></div>`
        )
        .join('');

      $('#admin-users').innerHTML = us.users
        .map(
          (u) => `<tr class="border-b border-white/[0.04] last:border-0" data-user="${u.id}">
            <td class="px-4 py-3"><p class="font-medium">${esc(u.name)}</p><p class="text-xs text-dim">${esc(u.email)}</p></td>
            <td class="px-4 py-3"><select data-u-role class="field w-28 py-1.5 text-xs" ${u.id === state.user.id ? 'disabled' : ''}>
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
            <td class="px-4 py-3 font-mono text-xs">${u.allowance.used} / ${u.allowance.unlimited ? '∞' : u.allowance.limit}<span class="block text-dim">${u.downloads} total</span></td>
            <td class="px-4 py-3"><div class="flex items-center gap-1.5"><input data-u-limit type="number" min="0" class="field w-20 py-1.5 text-xs" value="${u.role === 'admin' ? '' : u.monthlyLimit ?? ''}" placeholder="∞" ${u.role === 'admin' ? 'disabled' : ''} />
              <button data-u-save class="btn-ghost rounded-lg px-2 py-1.5 text-xs" ${u.role === 'admin' ? 'disabled' : ''}>Save</button></div></td>
            <td class="px-4 py-3">${u.disabled ? '<span class="badge bg-rose-500/10 text-rose-300">Disabled</span>' : '<span class="badge bg-mint/10 text-mint">Active</span>'}</td>
            <td class="px-4 py-3"><div class="flex justify-end gap-1.5">
              <button data-u-reset-usage class="btn-ghost rounded-lg px-2 py-1.5 text-xs" title="Give back all downloads for this period">Reset usage</button>
              <button data-u-reset-pw class="btn-ghost rounded-lg px-2 py-1.5 text-xs">New password</button>
              ${u.id === state.user.id ? '' : `<button data-u-toggle class="${u.disabled ? 'btn-ghost' : 'btn-danger'} rounded-lg px-2 py-1.5 text-xs">${u.disabled ? 'Enable' : 'Disable'}</button>`}
            </div></td>
          </tr>`
        )
        .join('');

      $('#admin-downloads').innerHTML = dl.downloads.length
        ? dl.downloads
            .slice(0, 100)
            .map((d) => {
              const st = STATUS[d.status] || STATUS.queued;
              return `<tr class="border-b border-white/[0.04] last:border-0">
                <td class="max-w-[260px] truncate px-4 py-3"><a href="${esc(d.url)}" target="_blank" rel="noopener" class="hover:underline">${esc(d.url)}</a>${d.login_method ? ' <i data-lucide="lock" class="inline h-3 w-3 text-dim"></i>' : ''}</td>
                <td class="px-4 py-3 text-xs text-body">${esc(d.user_email)}</td>
                <td class="px-4 py-3"><span class="badge ${st.cls}">${st.label}</span></td>
                <td class="px-4 py-3 text-xs text-body">${d.status === 'completed' ? `${d.pages} page${d.pages === 1 ? '' : 's'} · ${formatBytes(d.zip_size_bytes)}` : d.status === 'failed' ? esc(d.error_code || '') : ''}</td>
                <td class="px-4 py-3 text-xs text-dim">${fmtDate(d.created_at)}</td>
              </tr>`;
            })
            .join('')
        : `<tr><td class="px-4 py-6 text-body" colspan="5">No downloads yet.</td></tr>`;
      icons();
    };

    try {
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }

    $('#admin-users').addEventListener('click', async (e) => {
      const row = e.target.closest('[data-user]');
      if (!row) return;
      const id = row.dataset.user;
      try {
        if (e.target.closest('[data-u-save]')) {
          const v = row.querySelector('[data-u-limit]').value.trim();
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { monthlyLimit: v === '' ? null : parseInt(v, 10) } });
          toast('Limit saved.', 'success');
          await loadAll();
        } else if (e.target.closest('[data-u-reset-usage]')) {
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { resetUsage: true } });
          toast('Usage reset.', 'success');
          await loadAll();
        } else if (e.target.closest('[data-u-toggle]')) {
          const disable = e.target.closest('[data-u-toggle]').textContent.trim() === 'Disable';
          if (disable && !confirm('Disable this user? They are signed out immediately.')) return;
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { disabled: disable } });
          await loadAll();
        } else if (e.target.closest('[data-u-reset-pw]')) {
          if (!confirm('Set a new temporary password for this user? Their current password stops working.')) return;
          const data = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
          prompt('Temporary password — copy it and send it to the user privately:', data.temporaryPassword);
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $('#admin-users').addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-u-role]');
      if (!sel) return;
      const id = sel.closest('[data-user]').dataset.user;
      try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: sel.value } });
        toast('Role updated.', 'success');
        await loadAll();
      } catch (err) {
        toast(err.message, 'error');
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
      const [me, cfg] = await Promise.all([
        api('/api/auth/me'),
        api('/api/config', { auth: false }).catch(() => null),
      ]);
      state.user = me.user;
      state.allowance = me.allowance;
      session.save(null, me.user);
      if (cfg) state.config = { ...state.config, ...cfg };
    } catch (err) {
      view.innerHTML = `<div class="card rounded-2xl p-6"><p class="font-medium">Could not load your account</p><p class="mt-1 text-sm text-body">${esc(err.message)}</p>
        <button onclick="location.reload()" class="btn-primary mt-4 rounded-lg px-4 py-2 text-sm font-medium">Try again</button></div>`;
      return;
    }
    route();
    try {
      await loadDownloads();
      refreshLists();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  boot();
})();
