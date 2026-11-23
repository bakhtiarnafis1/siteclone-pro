// ============================================================================
// SiteClone — public home page
// Downloading requires an account: the forms send visitors to the dashboard's
// Website Downloader (or to the login page first, then back with the URL filled in).
// ============================================================================
lucide.createIcons();

const $ = (id) => document.getElementById(id);
const loggedIn = window.SC && SC.session.isLoggedIn();
const yearEl = $('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// ---------- Header / links for signed-in visitors ----------
if (loggedIn) {
  const user = SC.session.user();
  $('nav-login').classList.add('hidden');
  $('nav-cta').textContent = 'Open dashboard';
  $('nav-cta').href = '/app';
  $('auth-note-text').textContent = `Signed in${user?.name ? ` as ${user.name}` : ''} — opens in your dashboard`;
  document.querySelectorAll('.js-signup').forEach((a) => {
    a.textContent = 'Open dashboard';
    a.href = '/app';
  });
} else {
  document.querySelectorAll('.js-dash-link').forEach((a) => (a.href = `/login?next=${encodeURIComponent(a.getAttribute('href'))}`));
}

// ---------- Mode switch ----------
const MODE_HINTS = {
  single_page: 'Just the page you enter — its links are not followed.',
  full_website: 'Every public page of the site, up to your limit. Pages are counted first.',
  cookie_export: 'Pages behind your own login — you paste your cookie export in the next step.',
};
let mode = 'single_page';
function setMode(next) {
  mode = next;
  document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === next));
  $('mode-hint').textContent = MODE_HINTS[next];
}
document.querySelectorAll('.mode-tab').forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

// "Download a page / website" links in the mode cards pick the mode and jump to the form
document.querySelectorAll('[data-pick]').forEach((a) =>
  a.addEventListener('click', (e) => {
    if (a.getAttribute('href') !== '#clone') return;
    e.preventDefault();
    setMode(a.dataset.pick);
    $('clone').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('target-url').focus({ preventScroll: true }), 500);
  })
);

// ---------- Submit (hero + final CTA): go to the dashboard downloader, login first if needed ----------
document.querySelectorAll('.js-clone-form').forEach((form) =>
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = (form.querySelector('input[name="url"]').value || '').trim();
    const target = `/app#downloader?mode=${encodeURIComponent(mode)}${url ? `&url=${encodeURIComponent(url)}` : ''}`;
    location.href = loggedIn ? target : `/login?next=${encodeURIComponent(target)}`;
  })
);

// ---------- Product preview: fit the 1180px dashboard mock-up to its frame ----------
function fitStages() {
  document.querySelectorAll('[data-stage]').forEach((vp) => {
    const stage = vp.firstElementChild;
    const scale = Math.min(1, vp.clientWidth / 1180);
    stage.style.transform = `scale(${scale})`;
    vp.style.height = `${Math.ceil(stage.offsetHeight * scale)}px`;
  });
}
fitStages();
window.addEventListener('resize', fitStages);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitStages);

// ---------- Demo download animation (demo data only) ----------
(function demoDownload() {
  const roots = [...document.querySelectorAll('[data-demo-root]')];
  if (!roots.length) return;
  const TOTAL = 120;
  const FOUND = 584;
  const paths = [
    '/catalogue/category/books/travel_2/index.html',
    '/catalogue/a-light-in-the-attic_1000/index.html',
    '/catalogue/category/books/mystery_3/index.html',
    '/catalogue/tipping-the-velvet_999/index.html',
    '/catalogue/category/books/poetry_23/index.html',
    '/catalogue/soumission_998/index.html',
    '/catalogue/category/books/history_32/index.html',
    '/catalogue/sharp-objects_997/index.html',
  ];
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const set = (key, val) => roots.forEach((r) => r.querySelectorAll(`[data-demo="${key}"]`).forEach((el) => (el.textContent = val)));
  const RING = 100.5;
  let pct = 24;
  let elapsed = 14;
  function render() {
    const saved = Math.min(TOTAL, Math.round((pct / 78) * TOTAL));
    set('pct', Math.floor(pct));
    set('saved', saved);
    set('found', FOUND);
    set('files', 90 + saved * 3);
    set('elapsed', `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`);
    set('stage', pct < 78 ? `Capturing page ${Math.max(1, saved)} of ${TOTAL}…` : `Processing page ${Math.min(TOTAL, Math.round(((pct - 78) / 18) * TOTAL) + 1)} of ${TOTAL}…`);
    set('log', `Captured ${paths[saved % paths.length]}`);
    roots.forEach((r) => {
      r.querySelectorAll('[data-demo="bar"]').forEach((el) => (el.style.width = `${pct}%`));
      r.querySelectorAll('[data-demo="ring"]').forEach((el) => el.setAttribute('stroke-dashoffset', String(RING * (1 - pct / 100))));
    });
  }
  render();
  if (reduce) return;
  setInterval(() => {
    if (document.hidden) return;
    elapsed += 1;
    pct += pct < 78 ? 2.2 : 1.1;
    if (pct >= 96) {
      // start over quietly
      pct = 22;
      elapsed = 12;
      roots.forEach((r) => r.querySelectorAll('[data-demo="bar"], [data-demo="ring"]').forEach((el) => (el.style.transition = 'none')));
      render();
      requestAnimationFrame(() => requestAnimationFrame(() => roots.forEach((r) => r.querySelectorAll('[data-demo="bar"], [data-demo="ring"]').forEach((el) => (el.style.transition = '')))));
      return;
    }
    render();
  }, 1000);
})();

// ---------- Reveal sections as they scroll into view ----------
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }),
    { rootMargin: '0px 0px -8% 0px' }
  );
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('in'));
}

// ---------- Live server status (also wakes the backend on page load) ----------
async function refreshServerStatus() {
  const text = $('server-status-text');
  const dot = $('server-status-dot');
  try {
    const res = await fetch(SC.apiUrl('/api/health'), { cache: 'no-store' });
    const h = await res.json();
    const slots = h.maxConcurrentJobs || 1;
    const running = h.running || 0;
    const queued = h.queued || 0;
    if (running < slots) {
      text.textContent = 'Server ready';
      dot.className = 'h-1.5 w-1.5 rounded-full bg-emerald-500';
    } else {
      text.textContent = queued ? `Busy · ${queued} in line` : 'Busy · new downloads wait in line';
      dot.className = 'h-1.5 w-1.5 rounded-full bg-amber-400';
    }
  } catch {
    text.textContent = 'Waking up the server…';
    dot.className = 'h-1.5 w-1.5 rounded-full bg-slate-300 animate-pulse';
  }
}
let statusTimer = null;
function startStatus() {
  clearInterval(statusTimer);
  refreshServerStatus();
  statusTimer = setInterval(refreshServerStatus, 20000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(statusTimer);
  else startStatus();
});
startStatus();

// Page limit shown in the pricing card comes from the server
fetch(SC.apiUrl('/api/config'))
  .then((r) => r.json())
  .then((c) => {
    if (c && c.maxPages) document.querySelectorAll('.js-max-pages').forEach((el) => (el.textContent = c.maxPages));
  })
  .catch(() => {});
