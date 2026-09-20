// TRIAGE-X — persistence layer.
//
// This build talks to the browser's own localStorage — no external
// database needed for the demo hospital-queue data (patients, users,
// notifications). The only thing that needs a real backend is the AI
// Case Assistant, which calls this app's own server (server.js).

const LOCAL_KEY = 'triagex_local_store_v1';

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { users: {}, cases: {}, notifications: {}, audit: {} };
}
function saveLocal(data) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch (e) {}
}

class LocalBackend {
  constructor() {
    this.data = loadLocal();
    this.caseSubs = new Set();
    this.notifSubs = new Set();
  }
  _persist() { saveLocal(this.data); }
  _emitCases() {
    const list = Object.values(this.data.cases);
    this.caseSubs.forEach(fn => fn(list));
  }
  _emitNotifs() {
    const list = Object.values(this.data.notifications).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    this.notifSubs.forEach(fn => fn(list));
  }
  async getUsers() { return Object.values(this.data.users); }
  async findUser(email) { return this.data.users[email] || null; }
  async addUser(user) { this.data.users[user.email] = user; this._persist(); return user.email; }
  async seedIfEmpty(users) {
    if (Object.keys(this.data.users).length) return;
    users.forEach(u => { this.data.users[u.email] = u; });
    this._persist();
  }
  subscribeCases(fn) {
    this.caseSubs.add(fn);
    fn(Object.values(this.data.cases));
    return () => this.caseSubs.delete(fn);
  }
  async addCase(caseData) {
    const id = uid('case');
    this.data.cases[id] = { id, ...caseData };
    this._persist();
    this._emitCases();
    return id;
  }
  async updateCase(id, patch) {
    if (!this.data.cases[id]) return;
    this.data.cases[id] = { ...this.data.cases[id], ...patch };
    this._persist();
    this._emitCases();
  }
  async getCase(id) { return this.data.cases[id] || null; }
  subscribeNotifications(fn) {
    this.notifSubs.add(fn);
    fn(Object.values(this.data.notifications).sort((a, b) => (b.time || '').localeCompare(a.time || '')));
    return () => this.notifSubs.delete(fn);
  }
  async addNotification(n) {
    const id = uid('notif');
    this.data.notifications[id] = { id, read: false, ...n };
    this._persist();
    this._emitNotifs();
    return id;
  }
  async markAllRead() {
    Object.values(this.data.notifications).forEach(n => n.read = true);
    this._persist();
    this._emitNotifs();
  }
  async addAudit(entry) {
    const id = uid('audit');
    this.data.audit[id] = { id, ...entry };
    this._persist();
  }
  async clearAll() {
    this.data = { users: {}, cases: {}, notifications: {}, audit: {} };
    this._persist();
    this._emitCases();
    this._emitNotifs();
  }
}

export const store = {
  backend: null,
  mode: 'local',
  async init() {
    this.backend = new LocalBackend();
    this.mode = 'local';
    return this.mode;
  },
  getUsers(...a) { return this.backend.getUsers(...a); },
  findUser(...a) { return this.backend.findUser(...a); },
  addUser(...a) { return this.backend.addUser(...a); },
  seedIfEmpty(...a) { return this.backend.seedIfEmpty(...a); },
  subscribeCases(...a) { return this.backend.subscribeCases(...a); },
  addCase(...a) { return this.backend.addCase(...a); },
  updateCase(...a) { return this.backend.updateCase(...a); },
  getCase(...a) { return this.backend.getCase(...a); },
  subscribeNotifications(...a) { return this.backend.subscribeNotifications(...a); },
  addNotification(...a) { return this.backend.addNotification(...a); },
  markAllRead(...a) { return this.backend.markAllRead(...a); },
  addAudit(...a) { return this.backend.addAudit(...a); },
};

export const DEMO_USERS = [
  { name: 'Nurse Priya Ramesh', email: 'nurse.priya@triagex.demo', password: 'demo1234', role: 'nurse' },
  { name: 'Dr. Arjun Mehta', email: 'dr.arjun@triagex.demo', password: 'demo1234', role: 'doctor' },
  { name: 'Meera Nair (Admin)', email: 'admin.meera@triagex.demo', password: 'demo1234', role: 'admin' },
];
