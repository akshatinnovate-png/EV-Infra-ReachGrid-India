/* ReachGrid desktop governance (proposal §13), enforced in the main process:
 * - user accounts with scrypt-hashed passwords and roles (viewer / analyst / admin)
 * - session tokens; the renderer cannot change its own role
 * - permission checks on every protected write (evidence, portfolio, review, scenarios, EV uploads)
 * - append-only, SHA-256 hash-chained audit log on disk, stamped by the main process
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROLES = ["viewer", "analyst", "admin"];
const PERMS = {
  viewer: [],
  analyst: ["run", "save", "export", "evidence", "propose", "ev_upload"],
  admin: ["run", "save", "export", "evidence", "propose", "ev_upload", "approve", "portfolio", "audit_admin", "users", "settings"],
};
// workspace keys that need a permission to write
const PROTECTED = { evidence: "evidence", portfolio: "portfolio", scenarios: "save", ev_upload: "ev_upload", review: "propose" };

function createGovernance(userDir) {
  const f = (n) => path.join(userDir, n);
  const readJSON = (n, d) => { try { return JSON.parse(fs.readFileSync(f(n), "utf8")); } catch { return d; } };
  const writeJSON = (n, v) => { const tmp = f(n) + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, f(n)); };

  let users = readJSON("users.json", null);
  if (!users) { users = { owner: { name: "Owner", role: "admin", hash: null, created: new Date().toISOString() } }; writeJSON("users.json", users); }
  let settings = { teamServer: false, teamPort: 47800, tileUrl: "", requireSignIn: false, apiKey: crypto.randomBytes(18).toString("base64url"), apiWrite: false, apiPort: 0, osrmRouting: true, autoUpdate: true, ...readJSON("settings.json", {}) };
  writeJSON("settings.json", settings);
  let workspace = readJSON("workspace.json", {});
  const sessions = new Map();
  let session = null;   // the desktop window's session

  const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
  const checkPw = (pw, stored) => { if (!stored) return pw === "" || pw == null; const [salt, h] = stored.split(":"); return crypto.timingSafeEqual(Buffer.from(h, "hex"), crypto.scryptSync(pw || "", salt, 32)); };
  const can = (perm) => !!session && PERMS[users[session.user]?.role || "viewer"].includes(perm);

  /* ---------- audit ---------- */
  const auditPath = f("audit.jsonl");
  function auditLines() { try { return fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
  let lastHash = (auditLines().slice(-1)[0] || {}).hash || "0".repeat(64);
  const entryHash = (e) => crypto.createHash("sha256").update(JSON.stringify([e.ts, e.user, e.role, e.action, e.detail, e.prev])).digest("hex");
  function auditAdd(action, detail, actor) {
    const u = actor || (session ? session.user : "system");
    const e = { ts: new Date().toISOString(), user: u, role: actor === "api" ? "api-key" : users[u]?.role || "system", action: String(action).slice(0, 80), detail: String(detail ?? "").slice(0, 400), prev: lastHash };
    e.hash = entryHash(e); lastHash = e.hash;
    fs.appendFileSync(auditPath, JSON.stringify(e) + "\n");
    return e;
  }
  function auditVerify() {
    const list = auditLines(); let prev = "0".repeat(64);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.prev !== prev) return { ok: false, at: i, why: "chain link broken (an entry was removed or reordered)" };
      if (entryHash(e) !== e.hash) return { ok: false, at: i, why: "entry altered" };
      prev = e.hash;
    }
    return { ok: true, n: list.length };
  }

  /* ---------- sessions ---------- */
  function signIn(user, pw) {
    const u = users[user];
    if (!u || !checkPw(pw, u.hash)) { auditAdd("auth.fail", user, "system"); return { ok: false, error: "Wrong user name or password" }; }
    const token = crypto.randomBytes(24).toString("hex");
    session = { user, token, at: Date.now() }; sessions.set(token, session);
    auditAdd("auth.sign_in", user);
    return { ok: true, session: publicSession() };
  }
  function autoSignIn() {
    if (settings.requireSignIn) return { ok: false, needSignIn: true };
    const owner = Object.keys(users).find(k => users[k].role === "admin" && !users[k].hash) || null;
    if (!owner) return { ok: false, needSignIn: true };
    return signIn(owner, "");
  }
  /* ---------- team sessions (LAN clients): separate from the desktop window's own session ---------- */
  const TEAM_TTL = 12 * 3600 * 1000;
  const failures = new Map();   // ip -> [timestamps]
  function teamSignIn(user, pw, ip = "?") {
    const now = Date.now(), recent = (failures.get(ip) || []).filter(t => now - t < 60000);
    if (recent.length >= 5) { auditAdd("auth.team_locked", `${user}@${ip}`, "system"); return { ok: false, status: 429, error: "Too many failed attempts from this address. Wait a minute." }; }
    const u = users[user];
    if (!u || !u.hash || !checkPw(pw, u.hash)) {   // remote accounts must have a password
      recent.push(now); failures.set(ip, recent);
      auditAdd("auth.team_fail", `${user}@${ip}`, "system");
      return { ok: false, status: 401, error: u && !u.hash ? "This account has no password. An Admin must set one before it can join over the network." : "Wrong user name or password" };
    }
    failures.delete(ip);
    const token = crypto.randomBytes(24).toString("hex");
    const s = { user, token, at: now, team: true, ip };
    sessions.set(token, s);
    auditAdd("auth.team_sign_in", `${user}@${ip}`, user);
    return { ok: true, session: pubSession(s) };
  }
  function sessionFor(token) {
    const s = token && sessions.get(token);
    if (!s) return null;
    if (s.team && Date.now() - s.at > TEAM_TTL) { sessions.delete(token); return null; }
    if (!users[s.user]) { sessions.delete(token); return null; }
    return s;
  }
  /** run fn with the session of `token` (synchronous governance functions only) */
  function asSession(token, fn) {
    const s = sessionFor(token);
    if (!s) return { ok: false, status: 401, error: "Not signed in" };
    const prev = session; session = s;
    try { return fn(); } finally { session = prev; }
  }
  function teamSignOut(token) { const s = sessionFor(token); if (s) { auditAdd("auth.team_sign_out", s.user, s.user); sessions.delete(token); } return { ok: true }; }
  function teamSessions() { const out = []; for (const s of sessions.values()) if (s.team && sessionFor(s.token)) out.push({ user: s.user, ip: s.ip, since: new Date(s.at).toISOString() }); return out; }
  const pubSession = (s) => s ? { user: s.user, name: users[s.user].name, role: users[s.user].role, token: s.token, perms: PERMS[users[s.user].role], team: !!s.team } : null;

  function signOut() { if (session) { auditAdd("auth.sign_out", session.user); sessions.delete(session.token); } session = null; return { ok: true }; }
  const publicSession = () => session ? { user: session.user, name: users[session.user].name, role: users[session.user].role, token: session.token, perms: PERMS[users[session.user].role] } : null;

  /* ---------- protected workspace store ---------- */
  function storeGet(key) { return workspace[key] === undefined ? null : workspace[key]; }
  function storeSet(key, value) {
    if (!session) return { ok: false, error: "Not signed in" };
    const need = PROTECTED[key];
    if (need && !can(need)) return { ok: false, error: `Role ${users[session.user].role} may not change ${key}` };
    if (key === "review") {
      // approving or rejecting needs the approve permission, enforced by comparing with the stored state
      const before = workspace.review || {};
      for (const [scen, m] of Object.entries(value || {})) for (const [id, r] of Object.entries(m || {})) {
        const old = (before[scen] || {})[id];
        if ((!old || old.status !== r.status) && ["approved", "rejected"].includes(r.status) && !can("approve")) return { ok: false, error: "Only an Admin can approve or reject sites" };
      }
    }
    if (key === "audit") return { ok: false, error: "The audit log is append-only" };
    workspace[key] = value; writeJSON("workspace.json", workspace);
    return { ok: true };
  }

  /* ---------- users (admin) ---------- */
  function listUsers() { return Object.entries(users).map(([id, u]) => ({ id, name: u.name, role: u.role, hasPassword: !!u.hash, created: u.created })); }
  function saveUser({ id, name, role, password }) {
    if (!can("users")) return { ok: false, error: "Only an Admin can manage users" };
    if (!/^[a-z0-9._-]{2,32}$/i.test(id || "")) return { ok: false, error: "User id: 2–32 letters, digits, . _ -" };
    if (!ROLES.includes(role)) return { ok: false, error: "Role must be viewer, analyst or admin" };
    const existing = users[id];
    if (existing && existing.role === "admin" && role !== "admin" && Object.values(users).filter(u => u.role === "admin").length === 1) return { ok: false, error: "Keep at least one Admin" };
    users[id] = { name: name || id, role, hash: password ? hashPw(password) : existing ? existing.hash : null, created: existing ? existing.created : new Date().toISOString() };
    writeJSON("users.json", users); auditAdd(existing ? "users.update" : "users.create", `${id} (${role})${password ? ", password set" : ""}`);
    return { ok: true };
  }
  function deleteUser(id) {
    if (!can("users")) return { ok: false, error: "Only an Admin can manage users" };
    if (!users[id]) return { ok: false, error: "No such user" };
    if (session && id === session.user) return { ok: false, error: "You cannot delete yourself" };
    if (users[id].role === "admin" && Object.values(users).filter(u => u.role === "admin").length === 1) return { ok: false, error: "Keep at least one Admin" };
    delete users[id]; writeJSON("users.json", users); auditAdd("users.delete", id);
    return { ok: true };
  }
  function changeOwnPassword(oldPw, newPw) {
    if (!session) return { ok: false, error: "Not signed in" };
    const u = users[session.user];
    if (!checkPw(oldPw, u.hash)) return { ok: false, error: "Current password is wrong" };
    u.hash = newPw ? hashPw(newPw) : null; writeJSON("users.json", users); auditAdd("users.password", session.user);
    return { ok: true };
  }
  function updateSettings(patch) {
    if (!can("settings")) return { ok: false, error: "Only an Admin can change settings" };
    const allowed = ["requireSignIn", "apiWrite", "apiPort", "osrmRouting", "autoUpdate", "tileUrl", "teamServer", "teamPort"];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) return { ok: false, error: "Unknown setting " + k };
    if ("tileUrl" in patch && patch.tileUrl) {
      const t = String(patch.tileUrl).trim();
      if (!/^https:\/\/\S+$/.test(t) || !["{z}", "{x}", "{y}"].every(k => t.includes(k))) return { ok: false, error: "Tile URL must start with https:// and contain {z}, {x} and {y}" };
      patch.tileUrl = t;
    }
    if (patch.teamServer && !(patch.requireSignIn ?? settings.requireSignIn)) return { ok: false, error: "Turn on 'require a password' (Users tab) before sharing on the network" };
    if (patch.requireSignIn === false && settings.teamServer) return { ok: false, error: "Stop the team server before turning off sign-in" };
    if ("teamPort" in patch && !(Number.isInteger(+patch.teamPort) && +patch.teamPort >= 1024 && +patch.teamPort <= 65535)) return { ok: false, error: "Team port must be 1024–65535" };
    if (patch.requireSignIn && !Object.values(users).some(u => u.role === "admin" && u.hash)) return { ok: false, error: "Set a password for at least one Admin before requiring sign-in" };
    settings = { ...settings, ...patch }; writeJSON("settings.json", settings); auditAdd("settings.update", JSON.stringify(patch));
    return { ok: true, settings: publicSettings() };
  }
  function regenerateApiKey() { if (!can("settings")) return { ok: false, error: "Only an Admin can rotate the API key" }; settings.apiKey = crypto.randomBytes(18).toString("base64url"); writeJSON("settings.json", settings); auditAdd("settings.api_key_rotated", ""); return { ok: true, apiKey: settings.apiKey }; }
  const publicSettings = () => ({ ...settings, apiKey: can("settings") ? settings.apiKey : "(admin only)" });

  /* ---------- project files ---------- */
  function exportProject() { auditAdd("project.export", ""); return { format: "reachgrid-project-v1", exported: new Date().toISOString(), by: session && session.user, workspace }; }
  function importProject(obj, mode = "merge") {
    if (!can("evidence") || !can("save")) return { ok: false, error: "Your role cannot import projects" };
    if (!obj || obj.format !== "reachgrid-project-v1") return { ok: false, error: "Not a ReachGrid project file" };
    const w = obj.workspace || {};
    for (const k of Object.keys(w)) {
      if (k === "audit") continue;
      if (PROTECTED[k] && !can(PROTECTED[k])) continue;
      if (mode === "merge" && Array.isArray(workspace[k]) && Array.isArray(w[k])) workspace[k] = [...workspace[k], ...w[k]];
      else if (mode === "merge" && workspace[k] && typeof workspace[k] === "object" && typeof w[k] === "object" && !Array.isArray(w[k])) workspace[k] = { ...workspace[k], ...w[k] };
      else workspace[k] = w[k];
    }
    writeJSON("workspace.json", workspace); auditAdd("project.import", `${mode} · ${Object.keys(w).length} keys from ${obj.by || "unknown"}`);
    return { ok: true };
  }

  return {
    ROLES, PERMS, can, signIn, autoSignIn, signOut, session: publicSession, checkToken: (t) => !!sessionFor(t),
    teamSignIn, teamSignOut, asSession, sessionFor, teamSessions, pubSession,
    storeGet, storeSet, auditAdd, auditList: () => auditLines(), auditVerify, listUsers, saveUser, deleteUser, changeOwnPassword,
    settings: () => settings, publicSettings, updateSettings, regenerateApiKey, exportProject, importProject,
  };
}
module.exports = { createGovernance, PERMS, PROTECTED };
