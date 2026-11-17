/* Team client: when the workspace is loaded from a colleague's ReachGrid team server (not this computer's own
 * app server), this provides the RGDesktop interface the workspace uses, backed by the server's /team endpoints.
 * Roles, the protected workspace store and the audit log stay on the server; files and PDFs are saved locally
 * (through the desktop app's RGLocal bridge when present, else the browser). */
(function () {
  "use strict";
  if (window.RGDesktop) return;                                    // this computer's own app server: preload provides it
  const remote = /[?&]team=1\b/.test(location.search) || window.RGLocal;
  if (!remote) return;                                             // plain web page: no desktop features
  const LOCAL = window.RGLocal || null;
  const KEY = "rg_team_session";
  let sess = null; try { sess = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { sess = null; }
  const tok = () => (sess && sess.token) || "";
  function xhr(method, url, body) {                                // synchronous, for the workspace's sync store API
    const r = new XMLHttpRequest(); r.open(method, url, false);
    r.setRequestHeader("X-Session-Token", tok()); if (body !== undefined) r.setRequestHeader("Content-Type", "application/json");
    r.send(body === undefined ? null : JSON.stringify(body));
    let j = null; try { j = JSON.parse(r.responseText); } catch { j = null; }
    if (r.status === 401) { sess = null; sessionStorage.removeItem(KEY); }
    return { status: r.status, json: j };
  }
  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { "X-Session-Token": tok(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (r.status === 401 && url !== "/team/sign-in") { sess = null; sessionStorage.removeItem(KEY); }
    return j || { ok: false, error: "HTTP " + r.status };
  }
  const managed = async () => ({ ok: false, error: "Managed on the team server computer" });
  function browserSave(name, content, opts = {}) {
    const blob = opts.base64 ? new Blob([Uint8Array.from(atob(content), c => c.charCodeAt(0))]) : new Blob([content]);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    return { ok: true, path: name };
  }
  const info = (() => { const r = xhr("GET", "/team/info"); return r.json || {}; })();
  window.RGDesktop = {
    team: { server: location.origin, name: info.server || location.host, leave: () => (LOCAL ? LOCAL.leaveTeam() : (location.href = "about:blank")) },
    storeGet: (k) => { const r = xhr("GET", "/team/store?key=" + encodeURIComponent(k)); return r.json ? r.json.value : null; },
    storeSet: (k, v) => { const r = xhr("PUT", "/team/store?key=" + encodeURIComponent(k), { value: v }); return r.json || { ok: false, error: "HTTP " + r.status }; },
    session: () => sess,
    auditList: () => { const r = xhr("GET", "/team/audit"); return Array.isArray(r.json) ? r.json : []; },
    info: () => ({ version: info.version, build: info.build, team: true, server: info.server, packaged: true, port: location.port }),
    signIn: async (u, p) => { const r = await call("POST", "/team/sign-in", { user: u, password: p }); if (r.ok) { sess = r.session; sessionStorage.setItem(KEY, JSON.stringify(sess)); } return r; },
    autoSignIn: async () => { if (!tok()) return { ok: false, needSignIn: true }; const r = await call("GET", "/team/session"); if (r && r.user) { sess = r; return { ok: true, session: r }; } return { ok: false, needSignIn: true }; },
    signOut: async () => { await call("POST", "/team/sign-out"); sess = null; sessionStorage.removeItem(KEY); return { ok: true }; },
    auditAdd: (a, d) => call("POST", "/team/audit", { action: a, detail: d }),
    auditVerify: () => call("GET", "/team/audit/verify"),
    users: () => call("GET", "/team/users"),
    saveUser: (u) => call("POST", "/team/users", u),
    deleteUser: (id) => call("DELETE", "/team/users?id=" + encodeURIComponent(id)),
    changePassword: (o, n) => call("POST", "/team/password", { old: o, new: n }),
    settings: async () => ({ ...(await call("GET", "/team/settings")), apiUrl: location.origin + "/api/v1" }),
    updateSettings: managed, rotateApiKey: managed,
    saveFile: (name, content, opts) => (LOCAL ? LOCAL.saveFile(name, content, opts) : Promise.resolve(browserSave(name, content, opts))),
    openFile: (accept) => (LOCAL ? LOCAL.openFile(accept) : Promise.resolve({ ok: false, error: "use the browser's file picker" })),
    pdfReport: (name) => (LOCAL ? LOCAL.pdfReport(name) : (window.print(), Promise.resolve({ ok: false }))),
    pdfHtml: (html, name) => (LOCAL ? LOCAL.pdfHtml(html, name) : Promise.resolve(browserSave(name.replace(/\.pdf$/, ".html"), html))),
    saveProject: async () => { const r = await call("GET", "/team/project"); if (r.ok === false) return r; return window.RGDesktop.saveFile(`reachgrid-team-${new Date().toISOString().slice(0, 10)}.reachgrid`, JSON.stringify(r, null, 1)); },
    openProject: managed, checkData: managed, applyData: managed, revertData: managed, refreshGrid: managed, rebuildData: managed,
    prefetchTiles: managed, cancelTiles: async () => ({ ok: true }), tileCache: async () => ({ bytes: 0, files: 0 }), clearTiles: managed,
    secretSet: (k, v) => (LOCAL ? LOCAL.secretSet(k, v) : Promise.resolve({ ok: false })), secretGet: (k) => (LOCAL ? LOCAL.secretGet(k) : Promise.resolve(null)),
    notify: async (t, b) => { try { new Notification(t, { body: b }); } catch { } return { ok: true }; },
    openDoc: async (page) => { window.open(page + (page.includes("?") ? "&" : "?") + "desktop=1&team=1", "_blank"); return { ok: true }; },
    openExternal: (url) => (LOCAL ? LOCAL.openExternal(url) : Promise.resolve(window.open(url, "_blank"))),
    openUserData: managed, checkAppUpdate: () => (LOCAL ? LOCAL.checkAppUpdate() : managed()),
    teamStatus: managed, teamStart: managed, teamStop: managed,
    joinTeam: (url) => (LOCAL ? LOCAL.joinTeam(url) : managed()), leaveTeam: () => (LOCAL ? LOCAL.leaveTeam() : managed()),
    on: () => {},
  };
})();
