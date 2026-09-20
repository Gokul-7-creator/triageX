import {
  t, label, getLang, setLang, SYMPTOMS, SEVERITIES, HISTORY_ITEMS,
  PRIORITY_LABELS, STATUS_LABELS, findByCode,
} from './i18n.js';
import {
  runTriageEngine, flagVital, VITAL_RANGES, MODEL_VERSION, weightTableRows, evaluateEngine,
} from './triage.js';
import { store, DEMO_USERS } from './store.js';

/* =====================================================================
   Small helpers
   ===================================================================== */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString(getLang() === 'ta' ? 'ta-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(getLang() === 'ta' ? 'ta-IN' : 'en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function minutesSince(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
function priorityBadgeClass(p) {
  return p === 'CRITICAL' ? 'badge-critical' : p === 'URGENT' ? 'badge-urgent' : 'badge-normal';
}
function priorityRank(p) { return { CRITICAL: 0, URGENT: 1, NORMAL: 2 }[p] ?? 3; }
const VITAL_LABELS = { temperature: 'Temperature', heartRate: 'Heart Rate', systolicBp: 'Systolic BP', diastolicBp: 'Diastolic BP', spo2: 'SpO₂', respiratoryRate: 'Resp. Rate' };
const SEVERITY_ABBR = { mild: 'Mi', moderate: 'Mo', severe: 'Se' };
function uidLocal() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* =====================================================================
   Session ("demo JWT" — a base64 claims blob, NOT cryptographically
   signed. The production design issues a real signed JWT from a FastAPI
   /api/auth/login endpoint; this stands in for it in a page that has no
   server to sign anything with.)
   ===================================================================== */
const SESSION_KEY = 'triagex_session';
function makeDemoToken(user) {
  const payload = { sub: user.email, role: user.role, name: user.name, iat: Date.now() };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}
function setSession(user) { localStorage.setItem(SESSION_KEY, makeDemoToken(user)); }
function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(escape(atob(raw))));
  } catch (e) { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

/* =====================================================================
   App state
   ===================================================================== */
const state = {
  session: getSession(),
  cases: [],
  casesInitialized: false,
  prevCases: {},
  notifications: [],
  storeMode: 'local',
  sidebarOpen: false,
};

/* =====================================================================
   Toasts
   ===================================================================== */
function toast(message, opts = {}) {
  const { type = 'info', emoji = 'ℹ️', duration = 3400 } = opts;
  const root = document.getElementById('toastRoot');
  while (root.children.length >= 3) root.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-emoji">${emoji}</span><span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, duration);
}

/* =====================================================================
   Modal
   ===================================================================== */
function openModal({ title, body, confirmText, cancelText, danger, onConfirm }) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal-box" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(title)}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn btn-secondary btn-sm" id="modalCancel">${esc(cancelText || 'Cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" id="modalConfirm">${esc(confirmText || 'Confirm')}</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') close(); });
  document.getElementById('modalCancel').addEventListener('click', close);
  document.getElementById('modalConfirm').addEventListener('click', () => { close(); onConfirm && onConfirm(); });
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

/* =====================================================================
   Router
   ===================================================================== */
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'landing', param: parts[1] };
}
function navigate(path) { location.hash = path; }
const ROUTE_ROLES = {
  dashboard: ['doctor', 'admin'],
  checkin: ['nurse', 'admin'],
  analytics: ['doctor', 'admin', 'nurse'],
  admin: ['admin'],
  patient: ['doctor', 'admin'],
  queue: ['nurse', 'doctor', 'admin'],
};
const CASES_DEPENDENT_ROUTES = new Set(['dashboard', 'patient', 'analytics', 'admin', 'queue']);

function render() {
  const root = document.getElementById('app');
  const route = currentRoute();
  const allowedRoles = ROUTE_ROLES[route.name];
  if (allowedRoles) {
    if (!state.session) { sessionStorage.setItem('triagex_next', location.hash || '#/dashboard'); navigate('#/login'); return; }
    if (!allowedRoles.includes(state.session.role)) {
      root.innerHTML = shellWrap(accessDeniedHtml(), route.name);
      return;
    }
  }
  if (route.name === 'login' && state.session) { navigate(homeRouteFor(state.session.role)); return; }

  switch (route.name) {
    case 'login': root.innerHTML = loginView(); wireLoginView(); break;
    case 'checkin': root.innerHTML = shellWrap('<div id="checkinRoot"></div>', 'checkin'); wireShellChrome(); resetCheckinState(); renderCheckinStep(); break;
    case 'dashboard': root.innerHTML = shellWrap(dashboardShellHtml(), 'dashboard'); wireDashboardView(); break;
    case 'patient': root.innerHTML = shellWrap(patientDetailsView(route.param), 'dashboard'); wirePatientDetailsView(route.param); break;
    case 'analytics': root.innerHTML = shellWrap('<div id="analyticsRoot"></div>', 'analytics'); renderAnalytics(); break;
    case 'admin': root.innerHTML = shellWrap('<div id="adminRoot"></div>', 'admin'); renderAdmin(); break;
    case 'queue': root.innerHTML = shellWrap(queueStatusView(), 'queue'); wireShellChrome(); break;
    default: root.innerHTML = landingView(); wireLandingView();
  }
  window.scrollTo(0, 0);
}
function homeRouteFor(role) {
  if (role === 'nurse') return '#/checkin';
  return '#/dashboard';
}
window.addEventListener('hashchange', render);

/* =====================================================================
   Live data subscriptions
   ===================================================================== */
function onCasesSnapshot(list) {
  list = list.slice().sort((a, b) => (a.arrivalTime || '').localeCompare(b.arrivalTime || ''));
  if (state.casesInitialized) {
    const prevMap = state.prevCases;
    list.forEach(c => {
      const prev = prevMap[c.id];
      const priority = c.triage && c.triage.priority;
      if (!prev && priority === 'CRITICAL') {
        fireCriticalAlert(c);
      } else if (prev && prev.triage && priority && prev.triage.priority !== priority && priorityRank(priority) < priorityRank(prev.triage.priority)) {
        notify('🟠', `Priority increased: ${c.patientCode} — ${prev.triage.priority} → ${priority}`, c.id);
        if (priority === 'CRITICAL') fireCriticalAlert(c, true);
      }
    });
  }
  const map = {};
  list.forEach(c => { map[c.id] = c; });
  state.prevCases = map;
  state.cases = list;
  state.casesInitialized = true;

  const route = currentRoute();
  if (route.name === 'dashboard') updateDashboardLive();
  else if (route.name === 'analytics') renderAnalytics();
  else if (route.name === 'admin') renderAdmin();
  else if (route.name === 'queue') { const r = document.getElementById('app'); if (r) { r.innerHTML = shellWrap(queueStatusView(), 'queue'); wireShellChrome(); } }
  else if (route.name === 'patient' && route.param) wirePatientDetailsRefresh(route.param);
}
function fireCriticalAlert(c, isEscalation) {
  if (!state.bulkLoading) {
    toast(`🚨 ${isEscalation ? 'Priority escalated to CRITICAL' : 'New critical patient'}: ${c.patientCode} (${c.name})`, { type: 'error', emoji: '🚨', duration: 5000 });
  }
  notify('🔴', `New critical patient: ${c.patientCode} — ${c.name}`, c.id);
  state.pendingCriticalBanner = c;
}
function notify(emoji, message, caseId) {
  store.addNotification({ type: emoji, message, caseId: caseId || null, time: new Date().toISOString() });
}
function onNotifSnapshot(list) {
  state.notifications = list;
  const badge = document.getElementById('notifBadgeCount');
  const unread = list.filter(n => !n.read).length;
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.hidden = unread === 0;
  }
  const panel = document.getElementById('notifPanelBody');
  if (panel) panel.innerHTML = notifListHtml(list);
}

/* =====================================================================
   Bootstrap
   ===================================================================== */
async function boot() {
  state.storeMode = await store.init();
  await store.seedIfEmpty(DEMO_USERS.map(u => ({ name: u.name, email: u.email, passwordDemo: u.password, role: u.role, createdAt: new Date().toISOString() })));
  store.subscribeCases(onCasesSnapshot);
  store.subscribeNotifications(onNotifSnapshot);
  render();
  document.getElementById('bootScreen')?.remove();
}
boot();

/* =====================================================================
   Shared shell (sidebar + topbar)
   ===================================================================== */
function brandMark(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 46 46" fill="none" aria-hidden="true"><path d="M4 23h9l4-14 8 28 4-14h13" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function navIcon(name) {
  const icons = {
    dashboard: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg>',
    checkin: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/></svg>',
    analytics: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 20V10M12 20V4M20 20v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    admin: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20c1.4-3.7 4.2-5.6 7.5-5.6s6.1 1.9 7.5 5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    queue: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };
  return icons[name] || '';
}
function shellWrap(innerHtml, activeRoute) {
  const s = state.session;
  const role = s?.role;
  const links = [];
  if (role === 'doctor' || role === 'admin') links.push({ r: 'dashboard', label: t('nav_dashboard'), icon: 'dashboard' });
  if (role === 'nurse' || role === 'admin') links.push({ r: 'checkin', label: t('nav_checkin'), icon: 'checkin' });
  if (role === 'nurse') links.push({ r: 'queue', label: 'Queue Status', icon: 'queue' });
  if (role === 'doctor' || role === 'admin' || role === 'nurse') links.push({ r: 'analytics', label: t('nav_analytics'), icon: 'analytics' });
  if (role === 'admin') links.push({ r: 'admin', label: t('nav_admin'), icon: 'admin' });

  const unread = state.notifications.filter(n => !n.read).length;
  return `
  <div class="shell">
    <aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" id="sidebarEl">
      <div class="sidebar-brand"><span class="brand-mark">${brandMark(20)}</span><span style="font-family:var(--font-display);font-weight:800;font-size:16px;">TRIAGE-X</span></div>
      <nav class="sidebar-nav">
        ${links.map(l => `<a class="nav-link ${activeRoute === l.r ? 'active' : ''}" href="#/${l.r}"><span class="nav-icon">${navIcon(l.icon)}</span>${esc(l.label)}</a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="sidebar-user">
          <div class="avatar">${esc(initials(s?.name))}</div>
          <div><div class="sidebar-user-name">${esc(s?.name || '')}</div><div class="sidebar-user-role">${esc(s?.role || '')}</div></div>
        </div>
        <button class="btn btn-ghost btn-sm btn-block" id="logoutBtn">Log out</button>
      </div>
    </aside>
    <div>
      <header class="topbar">
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="icon-btn" id="sidebarToggleBtn" style="display:none;" aria-label="Menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <div>
            <div class="topbar-title">${topbarTitle(activeRoute)}</div>
            <div class="topbar-sub">${storeModeNote()}</div>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="lang-toggle">
            <button data-lang="en" class="${getLang() === 'en' ? 'active' : ''}">EN</button>
            <button data-lang="ta" class="${getLang() === 'ta' ? 'active' : ''}">TA</button>
          </div>
          <div style="position:relative;">
            <button class="icon-btn" id="notifBellBtn" aria-label="Notifications">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 19a2.5 2.5 0 005 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              <span class="notif-badge" id="notifBadgeCount" ${unread === 0 ? 'hidden' : ''}>${unread}</span>
            </button>
            <div id="notifPanelWrap"></div>
          </div>
        </div>
      </header>
      <main class="main">${innerHtml}</main>
    </div>
  </div>`;
}
function storeModeNote() {
  return state.storeMode === 'db'
    ? 'Live sync active — shared across every open dashboard'
    : 'Local-only demo mode — this view is not receiving multi-viewer live sync';
}
function topbarTitle(route) {
  const titles = { dashboard: t('nav_dashboard'), checkin: t('nav_checkin'), analytics: t('nav_analytics'), admin: t('nav_admin'), queue: 'Queue Status', patient: 'Patient Details' };
  return esc(titles[route] || 'TRIAGE-X');
}
function wireShellChrome() {
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    clearSession(); state.session = null; navigate('#/');
  });
  document.querySelectorAll('.lang-toggle button').forEach(b => {
    b.addEventListener('click', () => { setLang(b.dataset.lang); location.reload(); });
  });
  document.getElementById('sidebarToggleBtn')?.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    document.getElementById('sidebarEl')?.classList.toggle('open', state.sidebarOpen);
  });
  const bell = document.getElementById('notifBellBtn');
  bell?.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = document.getElementById('notifPanelWrap');
    if (wrap.innerHTML) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = notifPanelHtml();
    document.getElementById('notifMarkReadBtn')?.addEventListener('click', async () => {
      const ids = state.notifications.filter(n => !n.read).map(n => n.id);
      await store.markAllRead(ids);
    });
  });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('notifPanelWrap');
    if (wrap && wrap.innerHTML && !wrap.contains(e.target) && e.target.id !== 'notifBellBtn') wrap.innerHTML = '';
  }, { once: false });
}
function notifPanelHtml() {
  return `<div class="notif-panel"><div class="notif-panel-head"><span>Notifications</span><button class="btn btn-ghost btn-sm" id="notifMarkReadBtn">Mark all read</button></div><div id="notifPanelBody">${notifListHtml(state.notifications)}</div></div>`;
}
function notifListHtml(list) {
  if (!list.length) return `<div class="notif-empty">No notifications yet.</div>`;
  return list.slice(0, 30).map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}">
      <span class="notif-emoji">${n.type || 'ℹ️'}</span>
      <div><div class="notif-text">${esc(n.message)}</div><div class="notif-time">${fmtDateTime(n.time)}</div></div>
    </div>`).join('');
}
function accessDeniedHtml() {
  return `<div class="empty-state"><div class="empty-state-icon">🔒</div><div class="empty-state-title">Not authorized for this role</div><div class="empty-state-body">Your signed-in role (${esc(state.session?.role)}) doesn't have access to this page.</div></div>`;
}

/* =====================================================================
   LANDING
   ===================================================================== */
function landingView() {
  const exampleQueue = [
    { pos: 1, id: 'P104', priority: 'CRITICAL', score: 92 },
    { pos: 2, id: 'P109', priority: 'CRITICAL', score: 89 },
    { pos: 3, id: 'P102', priority: 'URGENT', score: 76 },
    { pos: 4, id: 'P108', priority: 'URGENT', score: 61 },
    { pos: 5, id: 'P103', priority: 'NORMAL', score: 42 },
  ];
  const flow = ['Symptoms + Vitals + History', 'AI-Assisted Triage', 'Priority Assessment', 'Smart Hospital Queue', 'Clinical Review'];
  const features = [
    { icon: '🧭', title: 'Explainable, not a black box', body: 'Every priority ships with the ranked factors that produced it — vitals, symptoms and history, in plain language a clinician can check.' },
    { icon: '📡', title: 'Live smart queue', body: 'Arrivals, reassessments and status changes reorder the queue automatically for every open dashboard — no manual refresh.' },
    { icon: '🩺', title: 'Human review, always', body: 'TRIAGE-X ranks urgency for review — it never outputs a diagnosis and never replaces a qualified clinician\'s judgment.' },
  ];
  return `
  <div class="landing">
    <div class="landing-nav">
      <div class="brand"><span class="brand-mark">${brandMark()}</span>TRIAGE-X</div>
      <div style="display:flex;gap:10px;">
        <a href="#/login" class="btn btn-secondary btn-sm">Sign in</a>
      </div>
    </div>
    <div class="landing-hero">
      <div>
        <div class="hero-eyebrow">AI-assisted clinical decision support</div>
        <h1 class="hero-title">Emergency triage that <span class="accent-word">explains itself</span>, in real time.</h1>
        <p class="hero-sub">${esc(t('tagline'))} TRIAGE-X ranks incoming patients by symptoms, vitals and history, then keeps the hospital queue in sync as reassessments come in.</p>
        <div class="hero-actions">
          <a href="#/checkin" class="btn btn-primary">${esc(t('cta_checkin'))}</a>
          <a href="#/dashboard" class="btn btn-secondary">${esc(t('cta_dashboard'))}</a>
        </div>
        <div class="hero-note">Sign-in required (nurse / doctor / admin) — demo credentials are on the login screen so you can explore every role immediately.</div>
      </div>
      <div class="hero-panel">
        <div class="hero-panel-head">
          <span class="hero-panel-title">Live Emergency Queue</span>
          <span class="live-pill"><span class="live-dot"></span>Example</span>
        </div>
        ${exampleQueue.map(q => `
          <div class="mini-queue-row">
            <span class="mini-queue-pos">#${q.pos}</span>
            <span><span class="mini-queue-name mono">${q.id}</span></span>
            <span class="badge ${priorityBadgeClass(q.priority)}"><span class="badge-dot"></span>${PRIORITY_LABELS[q.priority].icon} ${PRIORITY_LABELS[q.priority][getLang()]}</span>
            <span class="mono" style="font-weight:700;">${q.score}</span>
          </div>`).join('')}
      </div>
    </div>

    <div class="flow-section">
      <h2 class="flow-title">How a case moves through TRIAGE-X</h2>
      <p class="flow-sub">One continuous path from the check-in desk to a clinician's decision — the queue reorders itself at every step.</p>
      <div class="flow-steps">
        ${flow.map((f, i) => `${i > 0 ? '<div class="flow-arrow">→</div>' : ''}<div class="flow-step"><div class="flow-step-num">STEP ${i + 1}</div><div class="flow-step-label">${esc(f)}</div></div>`).join('')}
      </div>
    </div>

    <div class="feature-grid">
      ${features.map(f => `<div class="feature-card"><div class="feature-icon">${f.icon}</div><div class="feature-title">${esc(f.title)}</div><div class="feature-body">${esc(f.body)}</div></div>`).join('')}
    </div>

    <div class="disclaimer-band">
      <span style="font-size:18px;">⚕️</span>
      <div><strong>Decision support, not diagnosis.</strong> TRIAGE-X is an AI-assisted triage prototype that estimates priority for clinical review — it does not diagnose disease, and every result requires assessment by a qualified healthcare professional before action is taken.</div>
    </div>

    <div class="landing-footer">
      <span>TRIAGE-X — hackathon prototype · not for real clinical use</span>
      <span>Built as a published Artifact · see Admin → About for architecture notes</span>
    </div>
  </div>`;
}
function wireLandingView() {}

/* =====================================================================
   LOGIN
   ===================================================================== */
function loginView() {
  return `
  <div class="auth-shell">
    <div class="auth-card">
      <a href="#/" class="auth-back">← Back to TRIAGE-X</a>
      <div class="auth-mark"><span class="brand-mark" style="color:var(--accent);">${brandMark(24)}</span><span style="font-family:var(--font-display);font-weight:800;font-size:17px;">TRIAGE-X</span></div>
      <div class="auth-title">Sign in to your workspace</div>
      <div class="auth-sub">Role-based access for nurses, doctors and administrators.</div>
      <svg class="ecg-line" viewBox="0 0 300 34" preserveAspectRatio="none" aria-hidden="true"><path d="M0 17 H70 L82 4 L94 30 L106 17 H140 L150 8 L160 26 L170 17 H300" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      <div id="loginError"></div>
      <form id="loginForm">
        <div class="field"><label for="loginEmail">Email</label><input id="loginEmail" type="email" required placeholder="you@triagex.demo" autocomplete="username"></div>
        <div class="field"><label for="loginPassword">Password</label><input id="loginPassword" type="password" required placeholder="••••••••" autocomplete="current-password"></div>
        <div class="field">
          <label>Role</label>
          <div class="role-toggle" id="roleToggle">
            <div class="role-opt active" data-role="nurse">Nurse</div>
            <div class="role-opt" data-role="doctor">Doctor</div>
            <div class="role-opt" data-role="admin">Admin</div>
          </div>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Log in</button>
      </form>
      <div class="auth-demo-box">
        <strong style="color:var(--text-primary);">Demo accounts</strong> — click a row to autofill.
        <table>
          ${DEMO_USERS.map(u => `<tr class="demo-row" data-email="${esc(u.email)}" data-role="${u.role}" data-pass="${esc(u.password)}" style="cursor:pointer;"><td>${esc(u.role)}</td><td>${esc(u.email)}</td><td>${esc(u.password)}</td></tr>`).join('')}
        </table>
      </div>
    </div>
  </div>`;
}
function wireLoginView() {
  const roleToggle = document.getElementById('roleToggle');
  let selectedRole = 'nurse';
  roleToggle.addEventListener('click', (e) => {
    const opt = e.target.closest('.role-opt'); if (!opt) return;
    roleToggle.querySelectorAll('.role-opt').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    selectedRole = opt.dataset.role;
  });
  document.querySelectorAll('.demo-row').forEach(row => {
    row.addEventListener('click', () => {
      document.getElementById('loginEmail').value = row.dataset.email;
      document.getElementById('loginPassword').value = row.dataset.pass;
      roleToggle.querySelectorAll('.role-opt').forEach(o => o.classList.toggle('active', o.dataset.role === row.dataset.role));
      selectedRole = row.dataset.role;
    });
  });
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errBox = document.getElementById('loginError');
    errBox.innerHTML = '';
    const user = await store.findUser(email);
    if (!user || user.passwordDemo !== password || user.role !== selectedRole) {
      errBox.innerHTML = `<div class="auth-error">Invalid email, password or role for this account.</div>`;
      return;
    }
    setSession(user);
    state.session = getSession();
    toast(`Welcome back, ${user.name.split(' ')[0]}.`, { type: 'success', emoji: '👋' });
    const next = sessionStorage.getItem('triagex_next');
    sessionStorage.removeItem('triagex_next');
    navigate(next || homeRouteFor(user.role));
  });
}

/* =====================================================================
   CHECK-IN (multi-step)
   ===================================================================== */
let ck = null;
function resetCheckinState() {
  ck = {
    step: 'info',
    info: { patientId: '', name: '', age: '', gender: 'female', phone: '', emergency: '' },
    symptoms: {}, // code -> severity
    symptomNotes: '',
    vitals: { temperature: '', heartRate: '', systolicBp: '', diastolicBp: '', spo2: '', respiratoryRate: '' },
    history: new Set(),
    historyNotes: '',
  };
}
const CK_STEPS = ['info', 'symptoms', 'vitals', 'history', 'review'];
function renderCheckinStep() {
  const root = document.getElementById('checkinRoot');
  if (!root) return;
  if (ck.step === 'result') { root.innerHTML = checkinResultHtml(ck.resultData, ck.resultCase); wireCheckinResult(); return; }
  root.innerHTML = `
    <div class="step-tabs">
      ${CK_STEPS.map((s, i) => `<div class="step-tab ${ck.step === s ? 'current' : CK_STEPS.indexOf(ck.step) > i ? 'done' : ''}">${i + 1}. ${stepTitle(s)}</div>`).join('')}
    </div>
    <div class="card card-pad">${stepBodyHtml(ck.step)}</div>
  `;
  wireCheckinStepInteractions();
}
function stepTitle(s) {
  return { info: 'Patient Info', symptoms: 'Symptoms', vitals: 'Vitals', history: 'History', review: 'Review' }[s];
}
function stepBodyHtml(step) {
  if (step === 'info') return infoStepHtml();
  if (step === 'symptoms') return symptomsStepHtml();
  if (step === 'vitals') return vitalsStepHtml();
  if (step === 'history') return historyStepHtml();
  return reviewStepHtml();
}
function stepNavHtml(showBack) {
  return `<div style="display:flex;justify-content:space-between;margin-top:22px;">
    ${showBack ? `<button class="btn btn-secondary" id="ckBack">Back</button>` : '<span></span>'}
    <button class="btn btn-primary" id="ckNext">${ck.step === 'review' ? 'Run AI Triage →' : 'Next'}</button>
  </div>`;
}
function infoStepHtml() {
  const i = ck.info;
  return `
    <div class="section-title" style="margin-bottom:14px;">Patient Information</div>
    <div class="form-grid">
      <div class="field"><label for="fPatientId">Patient ID / MRN <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label><input id="fPatientId" value="${esc(i.patientId)}" placeholder="Hospital record no."></div>
      <div class="field"><label for="fName">Full name *</label><input id="fName" value="${esc(i.name)}" placeholder="e.g. Karthik Subramaniam" required></div>
      <div class="field"><label for="fAge">Age *</label><input id="fAge" type="number" min="0" max="120" value="${esc(i.age)}" required></div>
      <div class="field"><label for="fGender">Gender *</label><select id="fGender"><option value="female" ${i.gender === 'female' ? 'selected' : ''}>Female</option><option value="male" ${i.gender === 'male' ? 'selected' : ''}>Male</option><option value="other" ${i.gender === 'other' ? 'selected' : ''}>Other</option></select></div>
      <div class="field"><label for="fPhone">Phone number</label><input id="fPhone" value="${esc(i.phone)}" placeholder="10-digit mobile"></div>
      <div class="field"><label for="fEmergency">Emergency contact</label><input id="fEmergency" value="${esc(i.emergency)}" placeholder="Name & phone"></div>
    </div>
    ${stepNavHtml(false)}`;
}
function symptomsStepHtml() {
  return `
    <div class="section-title" style="margin-bottom:4px;">Symptoms</div>
    <div class="section-note" style="margin-bottom:14px;">Select every symptom reported, then set its severity. Multiple symptoms are allowed.</div>
    <div class="symptom-grid" id="symptomGrid">
      ${SYMPTOMS.map(s => {
        const sev = ck.symptoms[s.code];
        return `<div class="symptom-card ${sev ? 'selected' : ''}" data-code="${s.code}">
          <div class="symptom-card-top"><span class="symptom-icon">${s.icon}</span><span class="symptom-check">${sev ? '✓' : ''}</span></div>
          <div class="symptom-label">${esc(label(s))}</div>
          <div class="severity-row" ${sev ? '' : 'hidden'}>
            ${SEVERITIES.map(sv => `<div class="severity-btn sev-${sv.code} ${sev === sv.code ? 'active' : ''}" data-sev="${sv.code}">${esc(label(sv))}</div>`).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="field" style="margin-top:16px;"><label for="fSymptomNotes">Additional description (optional)</label><textarea id="fSymptomNotes" rows="3" placeholder="Free-text notes from the patient or family...">${esc(ck.symptomNotes)}</textarea></div>
    ${stepNavHtml(true)}`;
}
function vitalsStepHtml() {
  const fields = [
    ['temperature', 'Temperature', '°C'], ['heartRate', 'Heart Rate', 'bpm'],
    ['systolicBp', 'Systolic BP', 'mmHg'], ['diastolicBp', 'Diastolic BP', 'mmHg'],
    ['spo2', 'SpO₂', '%'], ['respiratoryRate', 'Respiratory Rate', 'br/min'],
  ];
  return `
    <div class="section-title" style="margin-bottom:4px;">Vitals</div>
    <div class="section-note" style="margin-bottom:14px;">Abnormal readings are flagged visually for review — this is not a diagnosis.</div>
    <div class="vitals-grid" id="vitalsGrid">
      ${fields.map(([key, lbl, unit]) => {
        const flag = flagVital(key, ck.vitals[key]);
        return `<div class="vital-field ${flag === 'abnormal' ? 'flag-abnormal' : flag === 'critical' ? 'flag-critical' : ''}" data-vital="${key}">
          <label>${lbl} <span class="vital-unit">${unit}</span></label>
          <input type="number" step="${VITAL_RANGES[key].step}" id="v_${key}" value="${esc(ck.vitals[key])}" placeholder="—">
          <div class="vflag" style="margin-top:6px;">${flag ? `<span class="vital-flag ${flag}" style="margin-left:0;">${flag === 'critical' ? 'Critical' : flag === 'abnormal' ? 'Abnormal' : 'Normal'}</span>` : ''}</div>
        </div>`;
      }).join('')}
    </div>
    ${stepNavHtml(true)}`;
}
function historyStepHtml() {
  return `
    <div class="section-title" style="margin-bottom:4px;">Medical History</div>
    <div class="section-note" style="margin-bottom:14px;">Select all relevant conditions.</div>
    <div class="history-grid" id="historyGrid">
      ${HISTORY_ITEMS.map(h => `<div class="check-row ${ck.history.has(h.code) ? 'selected' : ''}" data-code="${h.code}"><span class="check-box">${ck.history.has(h.code) ? '✓' : ''}</span>${esc(label(h))}</div>`).join('')}
    </div>
    <div class="field" style="margin-top:16px;"><label for="fHistoryNotes">Additional history (optional)</label><textarea id="fHistoryNotes" rows="3" placeholder="Medications, allergies, or other relevant history...">${esc(ck.historyNotes)}</textarea></div>
    ${stepNavHtml(true)}`;
}
function reviewStepHtml() {
  const i = ck.info;
  const symList = Object.entries(ck.symptoms);
  return `
    <div class="section-title" style="margin-bottom:14px;">Review before running AI triage</div>
    <div class="kv-grid" style="margin-bottom:18px;">
      <div><div class="kv-label">Name</div><div class="kv-value">${esc(i.name) || '—'}</div></div>
      <div><div class="kv-label">Age / Gender</div><div class="kv-value">${esc(i.age) || '—'} · ${esc(i.gender)}</div></div>
      <div><div class="kv-label">Phone</div><div class="kv-value">${esc(i.phone) || '—'}</div></div>
      <div><div class="kv-label">Emergency contact</div><div class="kv-value">${esc(i.emergency) || '—'}</div></div>
    </div>
    <div class="kv-label" style="margin-bottom:8px;">Symptoms</div>
    <div class="tag-row" style="margin-bottom:18px;">
      ${symList.length ? symList.map(([code, sev]) => `<span class="badge badge-neutral">${esc(label(findByCode(SYMPTOMS, code)))} · <span class="severity-tag severity-${sev}" style="margin-left:4px;">${esc(label(findByCode(SEVERITIES, sev)))}</span></span>`).join('') : '<span class="section-note">None selected</span>'}
    </div>
    <div class="kv-label" style="margin-bottom:8px;">Vitals</div>
    <div class="kv-grid" style="margin-bottom:18px;">
      ${Object.entries(ck.vitals).filter(([, v]) => v !== '').map(([k, v]) => `<div><div class="kv-label">${k}</div><div class="kv-value mono">${esc(v)} ${VITAL_RANGES[k].unit}</div></div>`).join('') || '<div class="section-note">No vitals recorded</div>'}
    </div>
    <div class="kv-label" style="margin-bottom:8px;">History</div>
    <div class="tag-row" style="margin-bottom:6px;">
      ${ck.history.size ? [...ck.history].map(c => `<span class="badge badge-neutral">${esc(label(findByCode(HISTORY_ITEMS, c)))}</span>`).join('') : '<span class="section-note">None recorded</span>'}
    </div>
    <div class="banner" style="margin-top:18px;"><span>⚕️</span><div>Running AI triage generates a <strong>prototype</strong> priority and risk score for clinical review — it does not diagnose a condition.</div></div>
    ${stepNavHtml(true)}`;
}
function wireCheckinStepInteractions() {
  document.getElementById('ckBack')?.addEventListener('click', () => {
    const idx = CK_STEPS.indexOf(ck.step);
    if (idx > 0) { ck.step = CK_STEPS[idx - 1]; renderCheckinStep(); }
  });
  document.getElementById('ckNext')?.addEventListener('click', () => onCheckinNext());

  const grid = document.getElementById('symptomGrid');
  grid?.addEventListener('click', (e) => {
    const sevBtn = e.target.closest('.severity-btn');
    const card = e.target.closest('.symptom-card');
    if (!card) return;
    const code = card.dataset.code;
    if (sevBtn) {
      ck.symptoms[code] = sevBtn.dataset.sev;
      card.querySelectorAll('.severity-btn').forEach(b => b.classList.toggle('active', b === sevBtn));
      return;
    }
    if (ck.symptoms[code]) { delete ck.symptoms[code]; card.classList.remove('selected'); card.querySelector('.symptom-check').textContent = ''; card.querySelector('.severity-row').hidden = true; }
    else { ck.symptoms[code] = 'moderate'; card.classList.add('selected'); card.querySelector('.symptom-check').textContent = '✓'; const row = card.querySelector('.severity-row'); row.hidden = false; row.querySelectorAll('.severity-btn').forEach(b => b.classList.toggle('active', b.dataset.sev === 'moderate')); }
  });

  const vgrid = document.getElementById('vitalsGrid');
  vgrid?.addEventListener('input', (e) => {
    const input = e.target.closest('input'); if (!input) return;
    const field = input.closest('.vital-field');
    const key = field.dataset.vital;
    ck.vitals[key] = input.value;
    const flag = flagVital(key, input.value);
    field.classList.remove('flag-abnormal', 'flag-critical');
    if (flag === 'abnormal') field.classList.add('flag-abnormal');
    if (flag === 'critical') field.classList.add('flag-critical');
    field.querySelector('.vflag').innerHTML = flag ? `<span class="vital-flag ${flag}" style="margin-left:0;">${flag === 'critical' ? 'Critical' : flag === 'abnormal' ? 'Abnormal' : 'Normal'}</span>` : '';
  });

  const hgrid = document.getElementById('historyGrid');
  hgrid?.addEventListener('click', (e) => {
    const row = e.target.closest('.check-row'); if (!row) return;
    const code = row.dataset.code;
    if (code === 'none') {
      if (ck.history.has('none')) ck.history.clear(); else { ck.history.clear(); ck.history.add('none'); }
    } else {
      ck.history.delete('none');
      if (ck.history.has(code)) ck.history.delete(code); else ck.history.add(code);
    }
    hgrid.querySelectorAll('.check-row').forEach(r => {
      const sel = ck.history.has(r.dataset.code);
      r.classList.toggle('selected', sel);
      r.querySelector('.check-box').textContent = sel ? '✓' : '';
    });
  });
}
function onCheckinNext() {
  if (ck.step === 'info') {
    ck.info.patientId = document.getElementById('fPatientId').value.trim();
    ck.info.name = document.getElementById('fName').value.trim();
    ck.info.age = document.getElementById('fAge').value;
    ck.info.gender = document.getElementById('fGender').value;
    ck.info.phone = document.getElementById('fPhone').value.trim();
    ck.info.emergency = document.getElementById('fEmergency').value.trim();
    if (!ck.info.name || ck.info.age === '') { toast('Name and age are required.', { type: 'error', emoji: '⚠️' }); return; }
    ck.step = 'symptoms'; renderCheckinStep(); return;
  }
  if (ck.step === 'symptoms') {
    ck.symptomNotes = document.getElementById('fSymptomNotes').value.trim();
    ck.step = 'vitals'; renderCheckinStep(); return;
  }
  if (ck.step === 'vitals') { ck.step = 'history'; renderCheckinStep(); return; }
  if (ck.step === 'history') {
    ck.historyNotes = document.getElementById('fHistoryNotes').value.trim();
    ck.step = 'review'; renderCheckinStep(); return;
  }
  if (ck.step === 'review') { submitCheckin(); }
}
async function submitCheckin() {
  const btn = document.getElementById('ckNext');
  if (btn) { btn.disabled = true; btn.textContent = 'Running AI triage…'; }
  try {
    const engineInput = {
      age: Number(ck.info.age), gender: ck.info.gender,
      symptoms: Object.entries(ck.symptoms).map(([code, severity]) => ({ code, severity })),
      history: [...ck.history],
      vitals: ck.vitals,
    };
    const result = runTriageEngine(engineInput);
    const now = new Date().toISOString();
    const patientCode = 'P' + (101 + state.cases.length);
    const caseDoc = {
      patientCode, patientId: ck.info.patientId || null,
      name: ck.info.name, age: Number(ck.info.age), gender: ck.info.gender,
      phone: ck.info.phone, emergencyContact: ck.info.emergency,
      symptoms: Object.entries(ck.symptoms).map(([code, severity]) => ({ code, severity })),
      symptomNotes: ck.symptomNotes,
      vitals: Object.fromEntries(Object.entries(ck.vitals).map(([k, v]) => [k, v === '' ? null : Number(v)])),
      history: [...ck.history], historyNotes: ck.historyNotes,
      triage: result,
      status: 'waiting', arrivalTime: now, lastUpdated: now,
      timeline: [
        { time: now, event: 'Patient registered' },
        { time: now, event: 'Vitals recorded' },
        { time: now, event: `AI triage completed — ${result.priority} (${result.riskScore}/100)` },
        { time: now, event: 'Added to hospital queue' },
      ],
      reassessments: [],
      createdBy: state.session?.email || 'unknown',
    };
    const id = await store.addCase(caseDoc);
    await store.addAudit({ userEmail: state.session?.email, action: 'CHECK_IN', caseId: id, timestamp: now });
    if (result.priority === 'CRITICAL') notify('🔴', `New critical patient: ${patientCode} — ${ck.info.name}`, id);
    ck.step = 'result'; ck.resultData = result; ck.resultCase = { id, patientCode, name: ck.info.name };
    renderCheckinStep();
  } catch (err) {
    toast('Could not complete check-in: ' + err.message, { type: 'error', emoji: '⚠️' });
    if (btn) { btn.disabled = false; btn.textContent = 'Run AI Triage →'; }
  }
}
function checkinResultHtml(result, c) {
  const cls = result.priority.toLowerCase();
  const pl = PRIORITY_LABELS[result.priority];
  const barColor = result.priority === 'CRITICAL' ? 'var(--status-critical)' : result.priority === 'URGENT' ? 'var(--status-warning)' : 'var(--status-good)';
  const maxW = result.factors.length ? result.factors[0].weight : 1;
  return `
    <div class="section-head"><div class="section-title">Triage Result</div><span class="model-badge">Model: ${esc(MODEL_VERSION)}</span></div>
    <div class="result-hero ${cls}">
      <div class="result-priority-icon">${pl.icon}</div>
      <div>
        <div class="result-priority-label">${esc(pl[getLang()])}</div>
        <div class="result-patient-id">${esc(c.patientCode)} · ${esc(c.name)}</div>
      </div>
      <div class="result-score">
        <div class="result-score-value">${result.riskScore}<span style="font-size:16px;color:var(--text-muted);">/100</span></div>
        <div class="result-score-label">Prototype risk score</div>
      </div>
    </div>
    <div class="section-head"><div class="section-title" style="font-size:14.5px;">Key Contributing Factors</div></div>
    <div class="factor-list">
      ${result.factors.length ? result.factors.map(f => `
        <div class="factor-row">
          <span class="factor-label">${esc(f.label)}</span>
          <span class="factor-bar-track"><span class="factor-bar-fill" style="width:${Math.round(f.weight / maxW * 100)}%;background:${barColor};"></span></span>
          <span class="factor-weight">+${f.weight}</span>
        </div>`).join('') : `<div class="section-note">No elevated factors detected from the submitted data.</div>`}
    </div>
    <div class="banner" style="margin-top:18px;"><span>⚕️</span><div>This result is decision support and requires assessment by qualified healthcare professionals. Factors above describe what raised triage priority — TRIAGE-X does not generate a disease diagnosis.</div></div>
    <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;">
      <button class="btn btn-primary" id="resAnother">Check in another patient</button>
      <a class="btn btn-secondary" href="#/${state.session.role === 'nurse' ? 'queue' : 'dashboard'}">View queue</a>
    </div>`;
}
function wireCheckinResult() {
  document.getElementById('resAnother')?.addEventListener('click', () => { resetCheckinState(); renderCheckinStep(); });
}

/* =====================================================================
   DOCTOR DASHBOARD
   ===================================================================== */
let dashFilters = { search: '', status: 'active', priority: 'all', sort: 'priority' };
function dashboardShellHtml() {
  return `
    <div id="criticalBannerWrap"></div>
    <div class="stat-grid" id="statGrid"></div>
    <div class="section-head">
      <div class="section-title">Live Emergency Queue</div>
      <span class="live-pill"><span class="live-dot"></span>LIVE</span>
    </div>
    <div class="toolbar">
      <div class="search-input">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="dashSearch" placeholder="Search by patient ID or name…" value="${esc(dashFilters.search)}">
      </div>
      <select class="sort-select" id="dashSort">
        <option value="priority" ${dashFilters.sort === 'priority' ? 'selected' : ''}>Sort: Priority</option>
        <option value="score" ${dashFilters.sort === 'score' ? 'selected' : ''}>Sort: Risk score</option>
        <option value="arrival" ${dashFilters.sort === 'arrival' ? 'selected' : ''}>Sort: Arrival time</option>
        <option value="waiting" ${dashFilters.sort === 'waiting' ? 'selected' : ''}>Sort: Waiting time</option>
      </select>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${['active', 'critical', 'urgent', 'normal', 'in_consultation', 'completed', 'all'].map(f => `<div class="filter-chip ${dashFilters.status === f ? 'active' : ''}" data-status="${f}">${filterLabel(f)}</div>`).join('')}
      </div>
    </div>
    <div id="dashQueueBody"></div>
    <div class="card card-pad" style="margin-top:26px;">
      <div class="section-title" style="font-size:14.5px;margin-bottom:10px;">Demo Tools</div>
      <div class="section-note" style="margin-bottom:12px;">For judges / reviewers: populate the queue instantly, then watch it reorder live.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" id="loadDemoBtn">Load demo patients (A–D)</button>
        <button class="btn btn-danger btn-sm" id="simEmergencyBtn">🚨 Simulate new emergency</button>
      </div>
    </div>`;
}
function filterLabel(f) {
  return { active: 'Active queue', critical: 'Critical', urgent: 'Urgent', normal: 'Normal', in_consultation: 'In consultation', completed: 'Completed', all: 'All' }[f];
}
function computeStats(list) {
  const active = list.filter(c => c.status !== 'completed');
  return {
    total: list.length,
    critical: active.filter(c => c.triage?.priority === 'CRITICAL').length,
    urgent: active.filter(c => c.triage?.priority === 'URGENT').length,
    normal: active.filter(c => c.triage?.priority === 'NORMAL').length,
    waiting: active.filter(c => c.status === 'waiting' || c.status === 'reassessment_required').length,
    inTreatment: active.filter(c => c.status === 'in_consultation' || c.status === 'emergency').length,
    completed: list.filter(c => c.status === 'completed').length,
  };
}
function statGridHtml(stats) {
  const tiles = [
    ['Total patients', stats.total, ''], ['Critical', stats.critical, 'critical'], ['Urgent', stats.urgent, 'warning'],
    ['Normal', stats.normal, 'good'], ['Waiting', stats.waiting, ''], ['In treatment', stats.inTreatment, ''], ['Completed', stats.completed, 'good'],
  ];
  return tiles.map(([l, v, cls]) => `<div class="stat-tile ${cls}"><div class="stat-tile-label">${l}</div><div class="stat-tile-value">${v}</div></div>`).join('');
}
function filteredSortedQueue() {
  let list = state.cases;
  if (dashFilters.status === 'active') list = list.filter(c => c.status !== 'completed');
  else if (dashFilters.status === 'critical') list = list.filter(c => c.status !== 'completed' && c.triage?.priority === 'CRITICAL');
  else if (dashFilters.status === 'urgent') list = list.filter(c => c.status !== 'completed' && c.triage?.priority === 'URGENT');
  else if (dashFilters.status === 'normal') list = list.filter(c => c.status !== 'completed' && c.triage?.priority === 'NORMAL');
  else if (dashFilters.status === 'in_consultation') list = list.filter(c => c.status === 'in_consultation');
  else if (dashFilters.status === 'completed') list = list.filter(c => c.status === 'completed');
  if (dashFilters.search.trim()) {
    const q = dashFilters.search.trim().toLowerCase();
    list = list.filter(c => (c.patientCode || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q));
  }
  const sorted = [...list].sort((a, b) => {
    if (dashFilters.sort === 'score') return (b.triage?.riskScore || 0) - (a.triage?.riskScore || 0);
    if (dashFilters.sort === 'arrival') return (a.arrivalTime || '').localeCompare(b.arrivalTime || '');
    if (dashFilters.sort === 'waiting') return minutesSince(b.arrivalTime) - minutesSince(a.arrivalTime);
    const pr = priorityRank(a.triage?.priority) - priorityRank(b.triage?.priority);
    if (pr) return pr;
    const sr = (b.triage?.riskScore || 0) - (a.triage?.riskScore || 0);
    if (sr) return sr;
    return (a.arrivalTime || '').localeCompare(b.arrivalTime || '');
  });
  return sorted;
}
function queueTableHtml(list) {
  if (!list.length) {
    return `<div class="table-wrap"><div class="empty-state"><div class="empty-state-icon">🗂️</div><div class="empty-state-title">No patients match this view</div><div class="empty-state-body">Try a different filter, or load demo patients below.</div></div></div>`;
  }
  return `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>#</th><th>Patient</th><th>Age</th><th>Priority</th><th>Risk</th><th>Arrival</th><th>Waiting</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>
      ${list.map((c, idx) => `
        <tr data-id="${c.id}">
          <td class="row-pos">#${idx + 1}</td>
          <td><div class="row-name">${esc(c.name)}</div><div class="row-id">${esc(c.patientCode)}</div></td>
          <td>${c.age ?? '—'}</td>
          <td><span class="badge ${priorityBadgeClass(c.triage?.priority)}"><span class="badge-dot"></span>${c.triage?.priority || '—'}</span></td>
          <td class="mono" style="font-weight:700;">${c.triage?.riskScore ?? '—'}</td>
          <td class="mono">${fmtTime(c.arrivalTime)}</td>
          <td class="mono">${minutesSince(c.arrivalTime)}m</td>
          <td><span class="status-pill">${STATUS_LABELS[c.status]?.[getLang()] || c.status}</span></td>
          <td class="row-actions" data-stop>${rowActionButtons(c)}</td>
        </tr>`).join('')}
    </tbody>
  </table></div>`;
}
function rowActionButtons(c) {
  const btns = [];
  if (c.status === 'waiting' || c.status === 'reassessment_required') btns.push(`<button class="btn btn-secondary btn-sm" data-act="seen">Mark Seen</button>`);
  if (c.status === 'waiting' || c.status === 'called' || c.status === 'reassessment_required') btns.push(`<button class="btn btn-primary btn-sm" data-act="consult">Start Consult</button>`);
  if (c.status !== 'completed' && c.status !== 'emergency') btns.push(`<button class="btn btn-danger btn-sm" data-act="emergency">Emergency</button>`);
  if (c.status !== 'completed') btns.push(`<button class="btn btn-secondary btn-sm" data-act="reassess">Reassess</button>`);
  if (c.status === 'in_consultation' || c.status === 'emergency') btns.push(`<button class="btn btn-secondary btn-sm" data-act="complete">Complete</button>`);
  return btns.join('');
}
function criticalBannerHtml() {
  const c = state.pendingCriticalBanner;
  if (!c) return '';
  return `<div class="critical-alert">
    <div class="critical-alert-icon">🚨</div>
    <div style="flex:1;">
      <div class="critical-alert-title">CRITICAL PATIENT</div>
      <div class="critical-alert-body">Patient ${esc(c.patientCode)} (${esc(c.name)}) — Priority: CRITICAL, Risk score: ${c.triage?.riskScore}. Immediate clinical assessment required.</div>
      <div class="critical-alert-foot">This is decision support, not a diagnosis — please confirm with direct clinical assessment.</div>
    </div>
    <button class="icon-btn" id="dismissBannerBtn" aria-label="Dismiss">✕</button>
  </div>`;
}
function updateDashboardLive() {
  const statEl = document.getElementById('statGrid');
  if (statEl) statEl.innerHTML = statGridHtml(computeStats(state.cases));
  const bodyEl = document.getElementById('dashQueueBody');
  if (bodyEl) { bodyEl.innerHTML = queueTableHtml(filteredSortedQueue()); wireQueueRows(); }
  const bannerWrap = document.getElementById('criticalBannerWrap');
  if (bannerWrap) { bannerWrap.innerHTML = criticalBannerHtml(); document.getElementById('dismissBannerBtn')?.addEventListener('click', () => { state.pendingCriticalBanner = null; bannerWrap.innerHTML = ''; }); }
}
function wireQueueRows() {
  document.querySelectorAll('#dashQueueBody tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return;
      navigate(`#/patient/${row.dataset.id}`);
    });
  });
  document.querySelectorAll('#dashQueueBody [data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.closest('tr').dataset.id;
      handleQueueAction(btn.dataset.act, id);
    });
  });
}
function wireDashboardView() {
  wireShellChrome();
  updateDashboardLive();
  document.getElementById('dashSearch').addEventListener('input', (e) => { dashFilters.search = e.target.value; updateDashboardLive(); });
  document.getElementById('dashSort').addEventListener('change', (e) => { dashFilters.sort = e.target.value; updateDashboardLive(); });
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => { dashFilters.status = chip.dataset.status; document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c === chip)); updateDashboardLive(); });
  });
  document.getElementById('loadDemoBtn').addEventListener('click', loadDemoPatients);
  document.getElementById('simEmergencyBtn').addEventListener('click', simulateNewEmergency);
}
async function handleQueueAction(act, id) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return;
  const now = new Date().toISOString();
  const timelineAdd = (event) => [...(c.timeline || []), { time: now, event }];
  if (act === 'seen') {
    await store.updateCase(id, { status: 'called', lastUpdated: now, timeline: timelineAdd('Marked as seen by doctor') });
    toast(`${c.patientCode} marked as seen.`, { type: 'success', emoji: '👁️' });
  } else if (act === 'consult') {
    await store.updateCase(id, { status: 'in_consultation', lastUpdated: now, timeline: timelineAdd('Consultation started') });
    toast(`Consultation started for ${c.patientCode}.`, { type: 'success', emoji: '🩺' });
  } else if (act === 'emergency') {
    openModal({
      title: 'Move to Emergency?', danger: true, confirmText: 'Move to Emergency',
      body: `This flags <strong>${esc(c.patientCode)} — ${esc(c.name)}</strong> for immediate emergency handling and notifies the care team.`,
      onConfirm: async () => {
        await store.updateCase(id, { status: 'emergency', lastUpdated: now, timeline: timelineAdd('Moved to Emergency') });
        notify('🔴', `${c.patientCode} moved to Emergency`, id);
        toast(`${c.patientCode} moved to Emergency.`, { type: 'error', emoji: '🚨' });
      },
    });
  } else if (act === 'reassess') {
    if (currentRoute().name === 'dashboard') { await store.updateCase(id, { status: 'reassessment_required', lastUpdated: now, timeline: timelineAdd('Reassessment requested') }); notify('🔄', `${c.patientCode} requires reassessment`, id); toast('Reassessment requested — open the patient to enter updated readings.', { emoji: '🔄' }); }
    navigate(`#/patient/${id}?reassess=1`);
  } else if (act === 'complete') {
    openModal({
      title: 'Complete this case?', confirmText: 'Complete Case',
      body: `Mark <strong>${esc(c.patientCode)} — ${esc(c.name)}</strong> as completed and remove from the active queue.`,
      onConfirm: async () => {
        await store.updateCase(id, { status: 'completed', completedAt: now, lastUpdated: now, timeline: timelineAdd('Case completed') });
        notify('✅', `${c.patientCode} case completed`, id);
        toast(`${c.patientCode} completed.`, { type: 'success', emoji: '✅' });
      },
    });
  }
  await store.addAudit({ userEmail: state.session?.email, action: `QUEUE_${act.toUpperCase()}`, caseId: id, timestamp: now });
}

/* =====================================================================
   Demo mode
   ===================================================================== */
const DEMO_TEMPLATES = [
  { name: 'Aarav Krishnan (Demo A)', age: 29, gender: 'male', symptoms: [{ code: 'cough', severity: 'mild' }], vitals: { temperature: 37.0, heartRate: 78, systolicBp: 118, diastolicBp: 76, spo2: 98, respiratoryRate: 16 }, history: [] },
  { name: 'Divya Shankar (Demo B)', age: 47, gender: 'female', symptoms: [{ code: 'abdominal_pain', severity: 'moderate' }, { code: 'vomiting', severity: 'moderate' }], vitals: { temperature: 38.2, heartRate: 108, systolicBp: 135, diastolicBp: 88, spo2: 95, respiratoryRate: 22 }, history: ['diabetes'] },
  { name: 'Suresh Iyer (Demo C)', age: 66, gender: 'male', symptoms: [{ code: 'chest_pain', severity: 'severe' }, { code: 'breathing_difficulty', severity: 'severe' }], vitals: { temperature: 37.4, heartRate: 128, systolicBp: 88, diastolicBp: 58, spo2: 89, respiratoryRate: 27 }, history: ['cardiac', 'hypertension'] },
  { name: 'Meenakshi Pillai (Demo D)', age: 72, gender: 'female', symptoms: [{ code: 'unconsciousness', severity: 'severe' }, { code: 'seizure', severity: 'severe' }], vitals: { temperature: 39.6, heartRate: 138, systolicBp: 78, diastolicBp: 50, spo2: 84, respiratoryRate: 32 }, history: ['prev_hospitalization'] },
];
async function loadDemoPatients() {
  toast('Loading demo patients…', { emoji: '⏳' });
  state.bulkLoading = true;
  for (const tpl of DEMO_TEMPLATES) {
    await createCaseFromTemplate(tpl);
  }
  state.bulkLoading = false;
  toast('Demo patients A–D added to the queue.', { type: 'success', emoji: '✅' });
}
async function simulateNewEmergency() {
  const pool = [
    { symptoms: [{ code: 'chest_pain', severity: 'severe' }, { code: 'dizziness', severity: 'severe' }], vitals: { temperature: 37.8, heartRate: 142, systolicBp: 82, diastolicBp: 54, spo2: 87, respiratoryRate: 30 }, history: ['cardiac'] },
    { symptoms: [{ code: 'breathing_difficulty', severity: 'severe' }, { code: 'bleeding', severity: 'severe' }], vitals: { temperature: 38.9, heartRate: 134, systolicBp: 79, diastolicBp: 49, spo2: 85, respiratoryRate: 33 }, history: ['asthma'] },
    { symptoms: [{ code: 'unconsciousness', severity: 'severe' }], vitals: { temperature: 40.1, heartRate: 150, systolicBp: 76, diastolicBp: 46, spo2: 83, respiratoryRate: 8 }, history: [] },
  ];
  const tpl = pool[Math.floor(Math.random() * pool.length)];
  const names = ['Rahul Verma', 'Fathima Beevi', 'Gowtham Raj', 'Lakshmi Narayan', 'Imran Sheikh'];
  const name = names[Math.floor(Math.random() * names.length)] + ' (Simulated)';
  await createCaseFromTemplate({ name, age: 20 + Math.floor(Math.random() * 60), gender: Math.random() < 0.5 ? 'male' : 'female', ...tpl });
  toast('🚨 New emergency simulated — watch the queue reorder.', { type: 'error', emoji: '🚨' });
}
async function createCaseFromTemplate(tpl) {
  const result = runTriageEngine({ age: tpl.age, gender: tpl.gender, symptoms: tpl.symptoms, history: tpl.history, vitals: tpl.vitals });
  const now = new Date().toISOString();
  const patientCode = 'P' + (101 + state.cases.length + demoCounterBump());
  const caseDoc = {
    patientCode, patientId: null, name: tpl.name, age: tpl.age, gender: tpl.gender, phone: '', emergencyContact: '',
    symptoms: tpl.symptoms, symptomNotes: '', vitals: tpl.vitals, history: tpl.history, historyNotes: '',
    triage: result, status: 'waiting', arrivalTime: now, lastUpdated: now,
    timeline: [
      { time: now, event: 'Patient registered (demo)' },
      { time: now, event: 'Vitals recorded' },
      { time: now, event: `AI triage completed — ${result.priority} (${result.riskScore}/100)` },
      { time: now, event: 'Added to hospital queue' },
    ],
    reassessments: [], createdBy: state.session?.email || 'demo',
  };
  const id = await store.addCase(caseDoc);
  if (result.priority === 'CRITICAL') notify('🔴', `New critical patient: ${patientCode} — ${tpl.name}`, id);
  return id;
}
let _demoBump = 0;
function demoCounterBump() { return _demoBump++; }

/* =====================================================================
   QUEUE STATUS (nurse read-only)
   ===================================================================== */
function queueStatusView() {
  const list = filteredSortedQueueForNurse();
  return `
    <div class="stat-grid">${statGridHtml(computeStats(state.cases))}</div>
    <div class="section-head"><div class="section-title">Live Emergency Queue</div><span class="live-pill"><span class="live-dot"></span>LIVE</span></div>
    ${queueTableHtml(list).replace(/<th>Action<\/th>|<td class="row-actions"[^>]*>.*?<\/td>/gs, '')}
  `;
}
function filteredSortedQueueForNurse() {
  return [...state.cases].filter(c => c.status !== 'completed').sort((a, b) => {
    const pr = priorityRank(a.triage?.priority) - priorityRank(b.triage?.priority);
    if (pr) return pr;
    return (b.triage?.riskScore || 0) - (a.triage?.riskScore || 0);
  });
}

/* =====================================================================
   AI CASE ASSISTANT — real OpenAI LLM + RAG, via this app's own backend
   (/api/ai/explain, /api/ai/ask). The browser never sees the OpenAI key;
   this only talks to our same-origin server, which does the retrieval
   (embeddings + cosine similarity over a small reference-notes corpus)
   and the chat completion, and streams the answer back.
   ===================================================================== */
const AI_DISCLAIMER = 'AI output is decision support only, grounded in a small illustrative reference-notes corpus — not an approved clinical protocol, and not a diagnosis.';
const aiState = {
  serverStatus: undefined, // undefined = not checked, 'ready' | 'unavailable'
  checking: null,
  chats: {}, // per-case: { turns: [{role,content}], busy: bool, explainHtml: string }
};

async function ensureAiServerChecked() {
  if (aiState.serverStatus !== undefined) return aiState.serverStatus;
  if (aiState.checking) return aiState.checking;
  aiState.checking = (async () => {
    try {
      const resp = await fetch('/api/health');
      const json = await resp.json();
      aiState.serverStatus = json.aiReady ? 'ready' : 'unavailable';
    } catch (e) {
      aiState.serverStatus = 'unavailable';
    }
    return aiState.serverStatus;
  })();
  return aiState.checking;
}

function chatStateFor(id) {
  if (!aiState.chats[id]) aiState.chats[id] = { turns: [], busy: false, explainHtml: '' };
  return aiState.chats[id];
}

/** POSTs to one of our AI routes and reads the "data: {json}\n\n" stream,
 * dispatching each frame to the matching callback. Used for both
 * /api/ai/explain and /api/ai/ask. */
async function streamAiRoute(url, body, { onSources, onDelta, onError, onDone }) {
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    onError('Could not reach the server. Check your connection and try again.');
    return;
  }
  if (!resp.ok) {
    let message = 'Could not get an answer right now.';
    try { const j = await resp.json(); message = j.message || message; } catch (e) {}
    onError(message);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      const line = frame.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (payload.type === 'sources') onSources(payload.chunks || []);
      else if (payload.type === 'delta') onDelta(payload.text || '');
      else if (payload.type === 'error') onError(payload.message || 'Something went wrong.');
      else if (payload.type === 'done') onDone();
    }
  }
}

function aiAssistantCardHtml(c) {
  const chat = chatStateFor(c.id);
  return `
    <div class="card card-pad" id="aiAssistantCard" data-id="${c.id}">
      <div class="section-head" style="margin:0 0 8px;">
        <div class="kv-label" style="margin:0;">AI Case Assistant</div>
        <span class="model-badge" title="Real OpenAI API call from this app's own server, grounded with retrieval over a small reference-notes corpus">OpenAI · RAG</span>
      </div>
      <div class="section-note" style="margin-bottom:12px;">${esc(AI_DISCLAIMER)}</div>
      <button class="btn btn-secondary btn-block" id="aiExplainBtn" style="margin-bottom:10px;">✨ Explain this case</button>
      <div id="aiExplainOutput">${chat.explainHtml || ''}</div>
      <div class="kv-label" style="margin:16px 0 8px;">Ask a question about this case</div>
      <div id="aiChatTranscript" class="ai-chat-transcript">${chat.turns.map(aiBubbleHtml).join('')}</div>
      <div class="ai-chat-input-row">
        <input type="text" id="aiChatInput" placeholder="e.g. Why was this flagged urgent instead of critical?" ${chat.busy ? 'disabled' : ''}>
        <button class="btn btn-primary" id="aiChatSendBtn" ${chat.busy ? 'disabled' : ''}>Ask</button>
      </div>
    </div>
    <div class="card card-pad" id="aiUnavailableCard" hidden>
      <div class="kv-label" style="margin:0 0 8px;">AI Case Assistant</div>
      <div class="section-note">Not available right now — the server couldn't reach OpenAI (check that OPENAI_API_KEY is set in .env and the server was restarted). The rest of TRIAGE-X works normally without it.</div>
    </div>`;
}
function aiBubbleHtml(turn) {
  const who = turn.role === 'user' ? 'You' : 'AI Assistant';
  return `<div class="ai-bubble ai-bubble-${turn.role}"><div class="ai-bubble-who">${who}</div><div class="ai-bubble-text">${esc(turn.content)}</div></div>`;
}
function aiSourcesHtml(chunks) {
  if (!chunks || !chunks.length) return '';
  return `<div class="ai-sources">${chunks.map(ch => `<span class="ai-source-chip" title="${esc(ch.text)}">${esc(ch.title)}</span>`).join('')}</div>`;
}

function wireAiAssistant(id) {
  const card = document.getElementById('aiAssistantCard');
  const fallback = document.getElementById('aiUnavailableCard');
  if (!card) return;
  ensureAiServerChecked().then((status) => {
    if (status === 'unavailable') { card.hidden = true; if (fallback) fallback.hidden = false; }
  });

  const explainBtn = document.getElementById('aiExplainBtn');
  explainBtn?.addEventListener('click', async () => {
    const c = state.cases.find(x => x.id === id);
    if (!c) return;
    const out = document.getElementById('aiExplainOutput');
    const chat = chatStateFor(id);
    explainBtn.disabled = true;
    out.innerHTML = `<div class="ai-thinking">Thinking…</div>`;
    let answer = '';
    let sourcesHtml = '';
    await streamAiRoute('/api/ai/explain', { case: c }, {
      onSources: (chunks) => { sourcesHtml = aiSourcesHtml(chunks); },
      onDelta: (text) => { answer += text; out.innerHTML = `<div class="ai-answer">${esc(answer)}</div>`; },
      onError: (message) => {
        if (/OPENAI_API_KEY|not ready|unavailable/i.test(message)) { card.hidden = true; if (fallback) fallback.hidden = false; return; }
        out.innerHTML = `<div class="ai-error">${esc(message)}</div>`;
      },
      onDone: () => {
        chat.explainHtml = `<div class="ai-answer">${esc(answer)}</div>${sourcesHtml}`;
        out.innerHTML = chat.explainHtml;
      },
    });
    explainBtn.disabled = false;
  });

  const input = document.getElementById('aiChatInput');
  const sendBtn = document.getElementById('aiChatSendBtn');
  const send = async () => {
    const c = state.cases.find(x => x.id === id);
    if (!c || !input || !input.value.trim()) return;
    const question = input.value.trim();
    const chat = chatStateFor(id);
    chat.busy = true;
    input.value = '';
    input.disabled = true; sendBtn.disabled = true;
    chat.turns.push({ role: 'user', content: question });
    const transcript = document.getElementById('aiChatTranscript');
    transcript.innerHTML = chat.turns.map(aiBubbleHtml).join('') + `<div class="ai-bubble ai-bubble-assistant"><div class="ai-bubble-who">AI Assistant</div><div class="ai-bubble-text ai-thinking" id="aiChatPending">Thinking…</div></div>`;
    transcript.scrollTop = transcript.scrollHeight;
    const priorTurns = chat.turns.slice(0, -1).slice(-6);
    let answer = '';
    await streamAiRoute('/api/ai/ask', { case: c, question, history: priorTurns }, {
      onSources: () => {},
      onDelta: (text) => {
        answer += text;
        const pending = document.getElementById('aiChatPending');
        if (pending) { pending.textContent = answer; pending.classList.remove('ai-thinking'); }
      },
      onError: (message) => {
        if (/OPENAI_API_KEY|not ready|unavailable/i.test(message)) { card.hidden = true; if (fallback) fallback.hidden = false; }
        chat.turns.push({ role: 'assistant', content: answer || message || 'Sorry — I could not answer that just now.' });
      },
      onDone: () => {
        if (answer) chat.turns.push({ role: 'assistant', content: answer });
      },
    });
    chat.busy = false;
    const t2 = document.getElementById('aiChatTranscript');
    if (t2) { t2.innerHTML = chat.turns.map(aiBubbleHtml).join(''); t2.scrollTop = t2.scrollHeight; }
    const input2 = document.getElementById('aiChatInput'); const send2 = document.getElementById('aiChatSendBtn');
    if (input2) input2.disabled = false; if (send2) send2.disabled = false;
  };
  sendBtn?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

/* =====================================================================
   PATIENT DETAILS
   ===================================================================== */
function patientDetailsView(id) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Patient not found</div><div class="empty-state-body">This case may have been removed, or hasn't synced yet.</div></div>`;
  const wantsReassess = location.hash.includes('reassess=1');
  return `<div id="patientRoot" data-id="${id}">${patientDetailsInner(c, wantsReassess)}</div>`;
}
function patientDetailsInner(c, forceReassessOpen) {
  const maxW = c.triage?.factors?.length ? c.triage.factors[0].weight : 1;
  return `
    <div style="margin-bottom:14px;"><a href="#/dashboard" class="auth-back" style="margin-bottom:0;">← Back to queue</a></div>
    <div class="section-head">
      <div><div class="section-title">${esc(c.name)} <span class="mono" style="color:var(--text-muted);font-size:13px;">${esc(c.patientCode)}</span></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <span class="badge ${priorityBadgeClass(c.triage?.priority)}"><span class="badge-dot"></span>${c.triage?.priority}</span>
        <span class="status-pill">${STATUS_LABELS[c.status]?.[getLang()] || c.status}</span>
      </div>
    </div>
    <div class="two-col">
      <div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="kv-label" style="margin-bottom:10px;">Patient Profile</div>
          <div class="kv-grid">
            <div><div class="kv-label">Age / Gender</div><div class="kv-value">${c.age} · ${esc(c.gender)}</div></div>
            <div><div class="kv-label">Patient ID</div><div class="kv-value mono">${esc(c.patientId || c.patientCode)}</div></div>
            <div><div class="kv-label">Phone</div><div class="kv-value">${esc(c.phone) || '—'}</div></div>
            <div><div class="kv-label">Emergency contact</div><div class="kv-value">${esc(c.emergencyContact) || '—'}</div></div>
          </div>
        </div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="kv-label" style="margin-bottom:10px;">Symptoms</div>
          <div class="tag-row" style="margin-bottom:8px;">
            ${(c.symptoms || []).length ? c.symptoms.map(s => `<span class="badge badge-neutral">${esc(label(findByCode(SYMPTOMS, s.code)) || s.code)} <span class="severity-tag severity-${s.severity}" style="margin-left:4px;">${esc(s.severity)}</span></span>`).join('') : '<span class="section-note">None recorded</span>'}
          </div>
          ${c.symptomNotes ? `<div class="section-note">"${esc(c.symptomNotes)}"</div>` : ''}
        </div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="kv-label" style="margin-bottom:10px;">Vitals</div>
          <div class="kv-grid">
            ${Object.entries(c.vitals || {}).filter(([, v]) => v != null).map(([k, v]) => { const flag = flagVital(k, v); return `<div><div class="kv-label">${k}</div><div class="kv-value mono">${v} ${VITAL_RANGES[k]?.unit || ''}${flag ? `<span class="vital-flag ${flag}">${flag}</span>` : ''}</div></div>`; }).join('') || '<div class="section-note">No vitals recorded</div>'}
          </div>
        </div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="kv-label" style="margin-bottom:10px;">History</div>
          <div class="tag-row" style="margin-bottom:8px;">${(c.history || []).length ? c.history.map(h => `<span class="badge badge-neutral">${esc(label(findByCode(HISTORY_ITEMS, h)) || h)}</span>`).join('') : '<span class="section-note">None recorded</span>'}</div>
          ${c.historyNotes ? `<div class="section-note">"${esc(c.historyNotes)}"</div>` : ''}
        </div>
        <div class="card card-pad">
          <div class="section-head" style="margin:0 0 10px;"><div class="kv-label" style="margin:0;">AI Triage</div><span class="model-badge">${esc(c.triage?.modelVersion || MODEL_VERSION)}</span></div>
          <div style="display:flex;gap:24px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
            <span class="badge ${priorityBadgeClass(c.triage?.priority)}" style="font-size:13px;padding:6px 14px;"><span class="badge-dot"></span>${c.triage?.priority}</span>
            <span class="mono" style="font-size:22px;font-weight:700;">${c.triage?.riskScore}<span style="font-size:13px;color:var(--text-muted);">/100</span></span>
            <span class="section-note">Computed ${fmtDateTime(c.arrivalTime)}</span>
          </div>
          <div class="factor-list">
            ${(c.triage?.factors || []).map(f => `<div class="factor-row"><span class="factor-label">${esc(f.label)}</span><span class="factor-bar-track"><span class="factor-bar-fill" style="width:${Math.round(f.weight / maxW * 100)}%;background:var(--accent);"></span></span><span class="factor-weight">+${f.weight}</span></div>`).join('')}
          </div>
        </div>
      </div>
      <div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="kv-label" style="margin-bottom:10px;">Timeline</div>
          <div class="timeline">
            ${(c.timeline || []).map(ev => `<div class="timeline-item"><div class="timeline-time">${fmtTime(ev.time)}</div><div class="timeline-label">${esc(ev.event)}</div></div>`).join('')}
          </div>
        </div>
        <div class="card card-pad" id="reassessCard">
          ${reassessBlockHtml(c, forceReassessOpen)}
        </div>
        ${aiAssistantCardHtml(c)}
      </div>
    </div>`;
}
function reassessBlockHtml(c, open) {
  if (!open) {
    return `<div class="kv-label" style="margin-bottom:10px;">Reassessment</div>
      <div class="section-note" style="margin-bottom:12px;">Enter updated vitals & symptoms to re-run the AI triage engine on this patient.</div>
      <button class="btn btn-primary btn-block" id="openReassessBtn" ${c.status === 'completed' ? 'disabled' : ''}>Reassess Patient</button>
      ${(c.reassessments || []).length ? `<div style="margin-top:16px;"><div class="kv-label" style="margin-bottom:8px;">History</div>${c.reassessments.map(r => `<div class="section-note" style="margin-bottom:6px;">${fmtDateTime(r.time)} — ${esc(r.previousPriority)} (${r.previousScore}) → <strong>${esc(r.newPriority)} (${r.newScore})</strong></div>`).join('')}</div>` : ''}`;
  }
  const v = c.vitals || {};
  const symMap = {}; (c.symptoms || []).forEach(s => symMap[s.code] = s.severity);
  return `
    <div class="kv-label" style="margin-bottom:10px;">Reassess Patient</div>
    <div class="vitals-grid" id="reassessVitals" style="grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px;">
      ${Object.keys(VITAL_RANGES).map(k => `<div class="vital-field" data-vital="${k}"><label>${VITAL_LABELS[k]} <span class="vital-unit">${VITAL_RANGES[k].unit}</span></label><input type="number" step="${VITAL_RANGES[k].step}" id="rv_${k}" value="${v[k] ?? ''}"></div>`).join('')}
    </div>
    <div class="kv-label" style="margin-bottom:8px;">Symptoms</div>
    <div class="symptom-grid" id="reassessSymptoms" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));margin-bottom:14px;">
      ${SYMPTOMS.map(s => { const sev = symMap[s.code]; return `<div class="symptom-card ${sev ? 'selected' : ''}" data-code="${s.code}" style="padding:9px;"><div class="symptom-card-top"><span class="symptom-icon">${s.icon}</span><span class="symptom-check">${sev ? '✓' : ''}</span></div><div class="symptom-label" style="font-size:11.5px;">${esc(label(s))}</div><div class="severity-row" ${sev ? '' : 'hidden'}>${SEVERITIES.map(sv => `<div class="severity-btn sev-${sv.code} ${sev === sv.code ? 'active' : ''}" data-sev="${sv.code}" style="font-size:9.5px;" title="${esc(label(sv))}">${SEVERITY_ABBR[sv.code]}</div>`).join('')}</div></div>`; }).join('')}
    </div>
    <div class="field"><label for="reassessReason">Reason for reassessment</label><textarea id="reassessReason" rows="2" placeholder="e.g. condition deteriorated, updated vitals after 15 minutes"></textarea></div>
    <div style="display:flex;gap:10px;margin-top:12px;">
      <button class="btn btn-secondary" id="cancelReassessBtn">Cancel</button>
      <button class="btn btn-primary" id="submitReassessBtn">Run AI Triage Again</button>
    </div>`;
}
function wirePatientDetailsView(id) {
  wireShellChrome();
  wirePatientDetailsInteractions(id);
}
function wirePatientDetailsRefresh(id) {
  const root = document.getElementById('patientRoot');
  if (!root) return;
  const c = state.cases.find(x => x.id === id);
  if (!c) return;
  const wasOpen = !!document.getElementById('reassessVitals');
  const draftQuestion = document.getElementById('aiChatInput')?.value || '';
  root.innerHTML = patientDetailsInner(c, wasOpen);
  wirePatientDetailsInteractions(id);
  if (draftQuestion) { const el = document.getElementById('aiChatInput'); if (el) el.value = draftQuestion; }
}
function wirePatientDetailsInteractions(id) {
  document.getElementById('openReassessBtn')?.addEventListener('click', () => {
    const c = state.cases.find(x => x.id === id);
    document.getElementById('reassessCard').innerHTML = reassessBlockHtml(c, true);
    wireReassessForm(id);
  });
  wireReassessForm(id);
  wireAiAssistant(id);
}
function wireReassessForm(id) {
  document.getElementById('cancelReassessBtn')?.addEventListener('click', () => {
    const c = state.cases.find(x => x.id === id);
    document.getElementById('reassessCard').innerHTML = reassessBlockHtml(c, false);
    wirePatientDetailsInteractions(id);
  });
  const symGrid = document.getElementById('reassessSymptoms');
  const localSym = {};
  (state.cases.find(x => x.id === id)?.symptoms || []).forEach(s => localSym[s.code] = s.severity);
  symGrid?.addEventListener('click', (e) => {
    const sevBtn = e.target.closest('.severity-btn'); const card = e.target.closest('.symptom-card'); if (!card) return;
    const code = card.dataset.code;
    if (sevBtn) { localSym[code] = sevBtn.dataset.sev; card.querySelectorAll('.severity-btn').forEach(b => b.classList.toggle('active', b === sevBtn)); return; }
    if (localSym[code]) { delete localSym[code]; card.classList.remove('selected'); card.querySelector('.symptom-check').textContent = ''; card.querySelector('.severity-row').hidden = true; }
    else { localSym[code] = 'moderate'; card.classList.add('selected'); card.querySelector('.symptom-check').textContent = '✓'; const row = card.querySelector('.severity-row'); row.hidden = false; row.querySelectorAll('.severity-btn').forEach(b => b.classList.toggle('active', b.dataset.sev === 'moderate')); }
  });
  document.getElementById('submitReassessBtn')?.addEventListener('click', async () => {
    const c = state.cases.find(x => x.id === id);
    const vitals = {};
    Object.keys(VITAL_RANGES).forEach(k => { const el = document.getElementById('rv_' + k); vitals[k] = el.value === '' ? null : Number(el.value); });
    const engineInput = { age: c.age, gender: c.gender, symptoms: Object.entries(localSym).map(([code, severity]) => ({ code, severity })), history: c.history || [], vitals };
    const result = runTriageEngine(engineInput);
    const now = new Date().toISOString();
    const prevPriority = c.triage?.priority; const prevScore = c.triage?.riskScore;
    const reason = document.getElementById('reassessReason').value.trim();
    const changed = prevPriority !== result.priority;
    const patch = {
      vitals, symptoms: Object.entries(localSym).map(([code, severity]) => ({ code, severity })),
      triage: result, status: 'waiting', lastUpdated: now,
      timeline: [...(c.timeline || []), { time: now, event: `Reassessment: ${prevPriority} (${prevScore}) → ${result.priority} (${result.riskScore})${reason ? ' — ' + reason : ''}` }],
      reassessments: [...(c.reassessments || []), { time: now, previousPriority: prevPriority, newPriority: result.priority, previousScore: prevScore, newScore: result.riskScore, reason }],
    };
    await store.updateCase(id, patch);
    await store.addAudit({ userEmail: state.session?.email, action: 'REASSESSMENT', caseId: id, timestamp: now });
    if (changed) {
      toast(`Priority changed: ${prevPriority} → ${result.priority}`, { type: result.priority === 'CRITICAL' ? 'error' : 'success', emoji: '🔄' });
      notify('🔄', `${c.patientCode} reassessed: ${prevPriority} → ${result.priority}`, id);
    } else {
      toast('Reassessment complete — priority unchanged.', { emoji: '🔄' });
    }
  });
}

/* =====================================================================
   ANALYTICS
   ===================================================================== */
function renderAnalytics() {
  const root = document.getElementById('analyticsRoot');
  if (!root) return;
  wireShellChrome();
  const list = state.cases;
  const stats = analyticsStats(list);
  root.innerHTML = `
    <div class="banner"><span>📊</span><div>Figures below are computed live from this session's demo/queue data (not real hospital records) — use <strong>Load demo patients</strong> on the dashboard for a fuller picture.</div></div>
    <div class="stat-grid" style="grid-template-columns:repeat(6,1fr);">
      <div class="stat-tile"><div class="stat-tile-label">Patients today</div><div class="stat-tile-value">${stats.total}</div></div>
      <div class="stat-tile critical"><div class="stat-tile-label">Critical</div><div class="stat-tile-value">${stats.critical}</div></div>
      <div class="stat-tile warning"><div class="stat-tile-label">Urgent</div><div class="stat-tile-value">${stats.urgent}</div></div>
      <div class="stat-tile good"><div class="stat-tile-label">Normal</div><div class="stat-tile-value">${stats.normal}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">Avg. waiting time</div><div class="stat-tile-value">${stats.avgWait}m</div></div>
      <div class="stat-tile good"><div class="stat-tile-label">Completed</div><div class="stat-tile-value">${stats.completed}</div></div>
    </div>
    <div class="analytics-grid" style="margin-top:18px;">
      <div class="chart-card">${chartVolumeByHour(list)}</div>
      <div class="chart-card">${chartPriorityDistribution(list)}</div>
      <div class="chart-card">${chartWaitingByPriority(list)}</div>
      <div class="chart-card">${chartCompletedVsWaiting(list)}</div>
    </div>`;
  wireAllChartTooltips(root);
}
function analyticsStats(list) {
  const active = list.filter(c => c.status !== 'completed');
  const waits = active.map(c => minutesSince(c.arrivalTime));
  return {
    total: list.length,
    critical: active.filter(c => c.triage?.priority === 'CRITICAL').length,
    urgent: active.filter(c => c.triage?.priority === 'URGENT').length,
    normal: active.filter(c => c.triage?.priority === 'NORMAL').length,
    completed: list.filter(c => c.status === 'completed').length,
    avgWait: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
  };
}

/* ---- lightweight SVG chart helpers (see dataviz skill: thin marks,
   rounded bar ends, hairline gridlines, direct labels, hover tooltip) --- */
const CHART_W = 520, CHART_H = 230, PAD = { t: 10, r: 14, b: 30, l: 34 };
function chartShell(title, legendHtml, svgInner, viewW = CHART_W, viewH = CHART_H) {
  return `<div class="chart-head"><span class="chart-title">${esc(title)}</span>${legendHtml ? `<span class="chart-legend">${legendHtml}</span>` : ''}</div>
    <svg viewBox="0 0 ${viewW} ${viewH}" style="width:100%;height:auto;display:block;" role="img" aria-label="${esc(title)}">${svgInner}</svg>`;
}
function legendItem(color, text) { return `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${color};"></span>${esc(text)}</span>`; }
function axisLine(x1, y1, x2, y2) { return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--baseline,#c3c2b7)" stroke-width="1"/>`; }

function chartVolumeByHour(list) {
  const byHour = {};
  list.forEach(c => { if (!c.arrivalTime) return; const h = new Date(c.arrivalTime).getHours(); byHour[h] = (byHour[h] || 0) + 1; });
  let hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  if (!hours.length) hours = [9, 10, 11, 12, 13, 14];
  else { const min = Math.max(0, hours[0] - 1), max = Math.min(23, hours[hours.length - 1] + 1); hours = []; for (let h = min; h <= max; h++) hours.push(h); }
  const values = hours.map(h => byHour[h] || 0);
  const max = Math.max(1, ...values);
  const innerW = CHART_W - PAD.l - PAD.r, innerH = CHART_H - PAD.t - PAD.b;
  const bw = innerW / hours.length;
  const bars = hours.map((h, i) => {
    const v = values[i]; const bh = (v / max) * innerH; const x = PAD.l + i * bw + bw * 0.18; const bwv = bw * 0.64;
    const y = PAD.t + innerH - bh;
    return `<rect class="chart-bar" data-tip="${h}:00 — ${v} patient${v === 1 ? '' : 's'}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bwv.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="3" fill="var(--series-blue)"/>
      ${v > 0 ? `<text x="${(x + bwv / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="var(--text-muted)" font-family="var(--font-mono)">${v}</text>` : ''}
      <text x="${(x + bwv / 2).toFixed(1)}" y="${CHART_H - PAD.b + 14}" text-anchor="middle" font-size="9.5" fill="var(--text-muted)">${h}h</text>`;
  }).join('');
  const grid = [0, 0.5, 1].map(f => `<line x1="${PAD.l}" y1="${(PAD.t + innerH * (1 - f)).toFixed(1)}" x2="${CHART_W - PAD.r}" y2="${(PAD.t + innerH * (1 - f)).toFixed(1)}" stroke="var(--gridline,#e1e0d9)" stroke-width="1"/>`).join('');
  return chartShell('Patient volume by hour', legendItem('var(--series-blue)', 'Check-ins'), grid + bars + axisLine(PAD.l, PAD.t + innerH, CHART_W - PAD.r, PAD.t + innerH));
}
function chartPriorityDistribution(list) {
  const active = list.filter(c => c.status !== 'completed' || true);
  const counts = { CRITICAL: 0, URGENT: 0, NORMAL: 0 };
  active.forEach(c => { if (c.triage?.priority) counts[c.triage.priority]++; });
  const total = Math.max(1, counts.CRITICAL + counts.URGENT + counts.NORMAL);
  const rows = [
    ['CRITICAL', counts.CRITICAL, 'var(--status-critical)'],
    ['URGENT', counts.URGENT, 'var(--status-warning)'],
    ['NORMAL', counts.NORMAL, 'var(--status-good)'],
  ];
  const innerW = CHART_W - PAD.l - 60, rowH = 46, chartHeight = rows.length * rowH + 20;
  const max = Math.max(1, ...rows.map(r => r[1]));
  const bars = rows.map((r, i) => {
    const [label_, v, color] = r;
    const w = (v / max) * innerW;
    const y = 14 + i * rowH;
    return `<text x="0" y="${y + 14}" font-size="11" font-weight="700" fill="var(--text-secondary)">${label_}</text>
      <rect data-tip="${label_}: ${v} (${Math.round(v / total * 100)}%)" x="80" y="${y}" width="${Math.max(2, w).toFixed(1)}" height="22" rx="4" fill="${color}"/>
      <text x="${86 + w}" y="${y + 15}" font-size="11" font-family="var(--font-mono)" fill="var(--text-primary)">${v}</text>`;
  }).join('');
  return chartShell('Priority distribution (active + completed)', '', `<g transform="translate(14,4)">${bars}</g>`, CHART_W, chartHeight + 20);
}
function chartWaitingByPriority(list) {
  const groups = { CRITICAL: [], URGENT: [], NORMAL: [] };
  list.filter(c => c.status !== 'completed').forEach(c => { if (c.triage?.priority) groups[c.triage.priority].push(minutesSince(c.arrivalTime)); });
  const rows = ['CRITICAL', 'URGENT', 'NORMAL'].map(p => {
    const arr = groups[p]; const avg = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const color = p === 'CRITICAL' ? 'var(--status-critical)' : p === 'URGENT' ? 'var(--status-warning)' : 'var(--status-good)';
    return [p, avg, color, arr.length];
  });
  const innerW = CHART_W - PAD.l - 60, rowH = 46, chartHeight = rows.length * rowH + 20;
  const max = Math.max(1, ...rows.map(r => r[1]));
  const bars = rows.map((r, i) => {
    const [p, avg, color, n] = r;
    const w = (avg / max) * innerW; const y = 14 + i * rowH;
    return `<text x="0" y="${y + 14}" font-size="11" font-weight="700" fill="var(--text-secondary)">${p}</text>
      <rect data-tip="${p}: avg ${avg}m waiting (n=${n})" x="80" y="${y}" width="${Math.max(2, w).toFixed(1)}" height="22" rx="4" fill="${color}"/>
      <text x="${86 + w}" y="${y + 15}" font-size="11" font-family="var(--font-mono)" fill="var(--text-primary)">${avg}m</text>`;
  }).join('');
  return chartShell('Average waiting time by priority', '', `<g transform="translate(14,4)">${bars}</g>`, CHART_W, chartHeight + 20);
}
function chartCompletedVsWaiting(list) {
  const byHour = {};
  list.forEach(c => {
    const t = c.status === 'completed' ? c.completedAt : c.arrivalTime;
    if (!t) return; const h = new Date(t).getHours();
    byHour[h] = byHour[h] || { waiting: 0, completed: 0 };
    if (c.status === 'completed') byHour[h].completed++; else byHour[h].waiting++;
  });
  let hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  if (!hours.length) hours = [9, 10, 11, 12];
  const innerW = CHART_W - PAD.l - PAD.r, innerH = CHART_H - PAD.t - PAD.b;
  const max = Math.max(1, ...hours.map(h => (byHour[h]?.waiting || 0) + (byHour[h]?.completed || 0)));
  const bw = innerW / hours.length;
  const bars = hours.map((h, i) => {
    const d = byHour[h] || { waiting: 0, completed: 0 };
    const x = PAD.l + i * bw + bw * 0.22; const bwv = bw * 0.56;
    const hWait = (d.waiting / max) * innerH, hComp = (d.completed / max) * innerH;
    const yWaitTop = PAD.t + innerH - hWait;
    const yCompTop = yWaitTop - hComp;
    return `<rect data-tip="${h}:00 — Waiting: ${d.waiting}" x="${x.toFixed(1)}" y="${yWaitTop.toFixed(1)}" width="${bwv.toFixed(1)}" height="${Math.max(0, hWait).toFixed(1)}" fill="var(--series-blue)"/>
      <rect data-tip="${h}:00 — Completed: ${d.completed}" x="${x.toFixed(1)}" y="${yCompTop.toFixed(1)}" width="${bwv.toFixed(1)}" height="${Math.max(0, hComp).toFixed(1)}" rx="2" fill="var(--series-aqua)"/>
      <text x="${(x + bwv / 2).toFixed(1)}" y="${CHART_H - PAD.b + 14}" text-anchor="middle" font-size="9.5" fill="var(--text-muted)">${h}h</text>`;
  }).join('');
  const grid = [0, 0.5, 1].map(f => `<line x1="${PAD.l}" y1="${(PAD.t + innerH * (1 - f)).toFixed(1)}" x2="${CHART_W - PAD.r}" y2="${(PAD.t + innerH * (1 - f)).toFixed(1)}" stroke="var(--gridline,#e1e0d9)" stroke-width="1"/>`).join('');
  return chartShell('Completed vs. waiting by hour', legendItem('var(--series-blue)', 'Waiting') + legendItem('var(--series-aqua)', 'Completed'), grid + bars + axisLine(PAD.l, PAD.t + innerH, CHART_W - PAD.r, PAD.t + innerH));
}
function wireAllChartTooltips(root) {
  let tip = document.getElementById('chartTooltipShared');
  if (!tip) { tip = document.createElement('div'); tip.id = 'chartTooltipShared'; tip.className = 'chart-tooltip'; tip.style.opacity = '0'; document.body.appendChild(tip); }
  root.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mousemove', (e) => {
      tip.textContent = el.dataset.tip;
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
      tip.style.opacity = '1';
    });
    el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });
}

/* =====================================================================
   ADMIN
   ===================================================================== */
let lastEval = null;
async function renderAdmin() {
  const root = document.getElementById('adminRoot');
  if (!root) return;
  wireShellChrome();
  const users = await store.getUsers();
  const stats = analyticsStats(state.cases);
  if (!lastEval) lastEval = evaluateEngine(300);
  root.innerHTML = `
    <div class="section-head"><div class="section-title">Hospital Statistics</div></div>
    <div class="stat-grid">${statGridHtml(computeStats(state.cases))}</div>

    <div class="section-head"><div class="section-title">All Patients</div><span class="section-note">${state.cases.length} total</span></div>
    ${queueTableHtml([...state.cases].sort((a, b) => (b.arrivalTime || '').localeCompare(a.arrivalTime || ''))).replace(/data-act="[^"]*"/g, 'disabled data-act')}

    <div class="section-head"><div class="section-title">Doctors</div></div>
    <div class="table-wrap"><table class="data-table" style="min-width:0;">
      <thead><tr><th>Name</th><th>Email</th><th>Active cases</th></tr></thead>
      <tbody>${users.filter(u => u.role === 'doctor').map(u => `<tr><td class="row-name">${esc(u.name)}</td><td class="mono row-id">${esc(u.email)}</td><td>${state.cases.filter(c => c.status === 'in_consultation').length}</td></tr>`).join('') || '<tr><td colspan="3" class="section-note" style="padding:16px;">No doctor accounts yet.</td></tr>'}</tbody>
    </table></div>

    <div class="section-head"><div class="section-title">Manage Users</div></div>
    <div class="card card-pad" style="margin-bottom:8px;">
      <div class="form-grid cols-2" style="margin-bottom:10px;">
        <div class="field"><label for="newUserName">Name</label><input id="newUserName" placeholder="Full name"></div>
        <div class="field"><label for="newUserEmail">Email</label><input id="newUserEmail" type="email" placeholder="name@triagex.demo"></div>
        <div class="field"><label for="newUserPass">Demo password</label><input id="newUserPass" placeholder="min 6 characters"></div>
        <div class="field"><label for="newUserRole">Role</label><select id="newUserRole"><option value="nurse">Nurse</option><option value="doctor">Doctor</option><option value="admin">Admin</option></select></div>
      </div>
      <button class="btn btn-primary btn-sm" id="addUserBtn">Add user</button>
    </div>
    <div class="table-wrap" style="margin-bottom:26px;"><table class="data-table" style="min-width:0;">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
      <tbody>${users.map(u => `<tr><td class="row-name">${esc(u.name)}</td><td class="mono row-id">${esc(u.email)}</td><td><span class="badge badge-accent">${esc(u.role)}</span></td></tr>`).join('')}</tbody>
    </table></div>

    <div class="section-head"><div class="section-title">Model Evaluation — Synthetic Benchmark</div><button class="btn btn-secondary btn-sm" id="rerunEvalBtn">Re-run</button></div>
    <div class="banner warn"><span>⚠️</span><div><strong>Not a real clinical evaluation.</strong> TRIAGE-X's production design runs <span class="model-badge">ml/train.py → model.pkl</span> (a Random Forest trained on historical triage data) served by <span class="model-badge">backend/app/services/triage_engine.py</span>. A published Artifact page can't run that Python pipeline, so the numbers below are computed live, in this browser, by checking the JS heuristic engine (see triage.js) against a freshly generated <strong>synthetic</strong> dataset — real code, real metrics, but not real patients or real clinical outcomes.</div></div>
    ${modelEvalHtml(lastEval)}

    <div class="section-head"><div class="section-title">How the engine scores (explainability)</div></div>
    <div class="table-wrap"><table class="weight-table">
      <thead><tr><th>Symptom</th><th>Mild</th><th>Moderate</th><th>Severe</th></tr></thead>
      <tbody>${weightTableRows().map(r => `<tr><td>${esc(r.factor)}</td><td class="mono">+${r.mild}</td><td class="mono">+${r.moderate}</td><td class="mono">+${r.severe}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="section-note" style="margin:8px 0 26px;">Vitals, history and age add further weighted points (see triage.js) up to a 0–100 cap. Score ≥75 → Critical, 40–74 → Urgent, &lt;40 → Normal.</div>

    <div class="section-head"><div class="section-title">About this build</div></div>
    <div class="card card-pad" style="margin-bottom:30px;">
      <p style="font-size:13.3px;color:var(--text-secondary);line-height:1.6;margin-bottom:10px;">TRIAGE-X was specified as a full multi-service stack (React/TypeScript frontend, FastAPI + PostgreSQL backend, a trained scikit-learn model, FastAPI WebSockets). This build is a <strong>published Artifact</strong> — a single hosted page — which cannot run a Python server, host PostgreSQL, or keep a WebSocket connection open. Every module was adapted to run entirely client-side while staying <em>functionally real</em>: live shared persistence via the Artifact platform's document database (replacing PostgreSQL), a transparent JS rule engine (replacing the trained model), and live query snapshots (replacing WebSocket push). Nothing on this page is hardcoded demo data pretending to be dynamic — the queue, triage results and analytics are all computed from what you enter.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <a class="btn btn-secondary btn-sm" href="README.md" target="_blank" rel="noopener">Read full README</a>
        <a class="btn btn-secondary btn-sm" href=".env.example" target="_blank" rel="noopener">View .env.example</a>
      </div>
    </div>`;
  wireQueueRows();
  document.getElementById('addUserBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newUserName').value.trim();
    const email = document.getElementById('newUserEmail').value.trim();
    const pass = document.getElementById('newUserPass').value;
    const role = document.getElementById('newUserRole').value;
    if (!name || !email || pass.length < 6) { toast('Fill name, a valid email and a 6+ character password.', { type: 'error', emoji: '⚠️' }); return; }
    await store.addUser({ name, email, passwordDemo: pass, role, createdAt: new Date().toISOString() });
    toast(`${name} added as ${role}.`, { type: 'success', emoji: '✅' });
    renderAdmin();
  });
  document.getElementById('rerunEvalBtn')?.addEventListener('click', () => { lastEval = evaluateEngine(300); renderAdmin(); });
}
function modelEvalHtml(ev) {
  const pct = (x) => (x * 100).toFixed(1) + '%';
  return `
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px;">
      <div class="stat-tile"><div class="stat-tile-label">Accuracy</div><div class="stat-tile-value">${pct(ev.accuracy)}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">Macro precision</div><div class="stat-tile-value">${pct(ev.macroPrecision)}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">Macro recall</div><div class="stat-tile-value">${pct(ev.macroRecall)}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">Macro F1</div><div class="stat-tile-value">${pct(ev.macroF1)}</div></div>
    </div>
    <div class="section-note" style="margin-bottom:8px;">Confusion matrix (rows = synthetic ground truth, columns = engine prediction, n=${ev.n})</div>
    <div class="table-wrap" style="margin-bottom:22px;"><table class="weight-table">
      <thead><tr><th></th>${ev.labels.map(l => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${ev.labels.map(r => `<tr><td style="font-weight:700;">${r}</td>${ev.labels.map(c => `<td class="mono" style="${r === c ? 'color:var(--status-good);font-weight:700;' : ''}">${ev.matrix[r][c]}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

/* =====================================================================
   Global delegated: close open notif panel on route change
   ===================================================================== */
window.addEventListener('hashchange', () => { const w = document.getElementById('notifPanelWrap'); if (w) w.innerHTML = ''; });
