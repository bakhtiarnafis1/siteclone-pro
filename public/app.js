// ============================================================================
// SiteClone — public home page
// Downloading requires an account: the form sends visitors to the dashboard's
// Website Downloader (or to the login page first, then back with the URL filled in).
// ============================================================================
lucide.createIcons();

const $ = (id) => document.getElementById(id);
const loggedIn = window.SC && SC.session.isLoggedIn();

// ---------- Header / CTA for signed-in visitors ----------
if (loggedIn) {
  const user = SC.session.user();
  $('nav-login').classList.add('hidden');
  $('nav-cta').textContent = 'Dashboard';
  $('nav-cta').href = '/app';
  $('auth-note-text').textContent = `Signed in${user?.name ? ` as ${user.name}` : ''} — your download opens in the dashboard.`;
  $('nav-cta').insertAdjacentHTML('afterbegin', '<i data-lucide="layout-dashboard" class="h-4 w-4"></i>');
  lucide.createIcons();
} else {
  document.querySelectorAll('.js-dash-link').forEach((a) => (a.href = '/login?next=%2Fapp'));
}

// ---------- Mode tabs ----------
const MODE_HINTS = {
  single_page: 'Just the page you enter — its links are not followed.',
  full_website: 'Every public page of the site — what anyone sees without logging in.',
  cookie_export: 'Pages behind your own login: dashboards, admin panels, members’ areas. Uses your cookie export.',
};
let mode = 'single_page';
document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $('mode-hint').textContent = MODE_HINTS[mode];
  });
});

// ---------- Submit: go to the dashboard downloader (login first if needed) ----------
$('clone-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('target-url').value.trim();
  const target = `/app#downloader?mode=${encodeURIComponent(mode)}${url ? `&url=${encodeURIComponent(url)}` : ''}`;
  location.href = loggedIn ? target : `/login?next=${encodeURIComponent(target)}`;
});

document.querySelectorAll('.sample-url-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('target-url').value = btn.dataset.sample;
    $('target-url').focus();
  });
});

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
      text.textContent = `Server ready · ${running}/${slots} download slot(s) in use`;
      dot.className = 'h-1.5 w-1.5 rounded-full bg-emerald-500';
    } else {
      text.textContent = queued
        ? `Server busy · ${queued} waiting — new downloads wait in line`
        : `Server busy · ${running}/${slots} slot(s) in use — new downloads wait in line`;
      dot.className = 'h-1.5 w-1.5 rounded-full bg-amber-400';
    }
  } catch {
    text.textContent = 'Waking up the server… (first visit can take up to a minute)';
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
