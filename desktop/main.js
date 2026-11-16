/* ReachGrid India — desktop application (Electron main process). */
"use strict";
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Notification, safeStorage, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { createServer } = require("./server");
const { createGovernance } = require("./governance");

const SMOKE = process.argv.find(a => a.startsWith("--smoke-test"));
const SMOKE_OUT = SMOKE && SMOKE.includes("=") ? SMOKE.split("=")[1] : null;
const APP_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(__dirname, "..");
const ICON = path.join(__dirname, "build", "icon.png");

if (process.env.REACHGRID_USER_DIR) app.setPath("userData", process.env.REACHGRID_USER_DIR);
if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); }

let gov, srv, port, mainWin = null;
const docWins = new Map();
const logFile = () => path.join(app.getPath("userData"), "reachgrid.log");
const log = (m) => { try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${m}\n`); } catch { } };

function appURL(page = "app.html", query = "app=1&desktop=1") { return `http://127.0.0.1:${port}/${page}${query ? "?" + query : ""}`; }

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 920, minWidth: 980, minHeight: 640, show: false, backgroundColor: "#eceae6",
    title: "ReachGrid India", icon: ICON, autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wireWindow(mainWin);
  mainWin.once("ready-to-show", () => { if (!SMOKE) { mainWin.maximize(); mainWin.show(); } });
  mainWin.on("closed", () => { mainWin = null; });
  mainWin.loadURL(appURL());
  return mainWin;
}
function openDoc(page, title) {
  if (docWins.has(page) && !docWins.get(page).isDestroyed()) { docWins.get(page).focus(); return; }
  const w = new BrowserWindow({ width: 1100, height: 860, title: `${title} · ReachGrid India`, icon: ICON, backgroundColor: "#ffffff", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  wireWindow(w); w.loadURL(appURL(page, "desktop=1")); docWins.set(page, w);
}
/** keep every window inside the app: local pages open as app windows, the web opens in the system browser */
function wireWindow(w) {
  const local = (url) => url.startsWith(`http://127.0.0.1:${port}/`);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (local(url)) { const page = new URL(url).pathname.replace(/^\//, "") || "app.html"; openDoc(page, page.replace(".html", "")); return { action: "deny" }; }
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (local(url)) {
      const u = new URL(url);
      if (w === mainWin && u.pathname !== "/" && u.pathname !== "/app.html") { e.preventDefault(); openDoc(u.pathname.slice(1), u.pathname.slice(1).replace(".html", "")); }
      return;
    }
    e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
  });
}

function buildMenu() {
  const send = (ch, ...a) => mainWin && mainWin.webContents.send(ch, ...a);
  const tpl = [
    { label: "File", submenu: [
      { label: "Open project…", accelerator: "CmdOrCtrl+O", click: () => send("menu", "project:open") },
      { label: "Save project…", accelerator: "CmdOrCtrl+S", click: () => send("menu", "project:save") },
      { type: "separator" },
      { label: "Export PDF report…", accelerator: "CmdOrCtrl+P", click: () => send("menu", "pdf") },
      { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("menu", "settings") },
      { label: "Sign out", click: () => send("menu", "signout") },
      { type: "separator" }, { role: "quit" },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [
      { role: "togglefullscreen" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { label: "Reload workspace", accelerator: "CmdOrCtrl+R", click: () => mainWin && mainWin.reload() },
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
    ] },
    { label: "Window", submenu: [
      { label: "Workspace", click: () => { if (mainWin) mainWin.focus(); else createMainWindow(); } },
      { label: "Methodology", click: () => openDoc("methodology.html", "Methodology") },
      { label: "Business model & roadmap", click: () => openDoc("business.html", "Business model") },
      { label: "Local API & console", click: () => openDoc("api.html", "API") },
      { type: "separator" }, { role: "minimize" }, { role: "close" },
    ] },
    { label: "Help", submenu: [
      { label: "Guided demo", click: () => send("menu", "tour") },
      { label: "Keyboard shortcuts", click: () => send("menu", "help") },
      { type: "separator" },
      { label: "Check for data updates", click: () => send("menu", "settings:data") },
      { label: "Check for app updates", click: () => checkAppUpdate(true) },
      { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
      { type: "separator" },
      { label: "About ReachGrid India", click: () => dialog.showMessageBox({ type: "info", icon: nativeImage.createFromPath(ICON), title: "About", message: "ReachGrid India " + app.getVersion(), detail: `EV charging access intelligence & investment optimisation.\nTeam GoingAgain · TM-7E9065875FC\nData build ${srv.currentBuild()}\nLocal API: http://127.0.0.1:${port}/api/v1` }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------------- app updates (GitHub Releases) ---------------- */
let updater = null;
function checkAppUpdate(manual) {
  if (!app.isPackaged) { if (manual) dialog.showMessageBox({ message: "Updates are checked in the installed app only." }); return; }
  try {
    updater = updater || require("electron-updater").autoUpdater;
    updater.autoDownload = true;
    updater.removeAllListeners();
    updater.on("update-available", (i) => notify("Update available", `ReachGrid ${i.version} is downloading.`));
    updater.on("update-not-available", () => { if (manual) dialog.showMessageBox({ message: `You have the latest version (${app.getVersion()}).` }); });
    updater.on("update-downloaded", async (i) => {
      const r = await dialog.showMessageBox({ type: "info", buttons: ["Restart now", "Later"], message: `ReachGrid ${i.version} is ready`, detail: "Restart to finish updating." });
      if (r.response === 0) updater.quitAndInstall();
    });
    updater.on("error", (e) => { log("updater " + e.message); if (manual) dialog.showMessageBox({ type: "warning", message: "Could not check for updates", detail: e.message }); });
    updater.checkForUpdates();
  } catch (e) { log("updater init " + e.message); }
}
function notify(title, body) { try { if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show(); } catch { } }

/* ---------------- IPC ---------------- */
function registerIPC() {
  const progress = (ch) => (...a) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send(ch, ...a);
  // synchronous: small, frequent reads/writes from the workspace
  ipcMain.on("store:get", (e, k) => { e.returnValue = gov.storeGet(k); });
  ipcMain.on("store:set", (e, k, v) => { e.returnValue = gov.storeSet(k, v); });
  ipcMain.on("session:get", (e) => { e.returnValue = gov.session(); });
  ipcMain.on("audit:list", (e) => { e.returnValue = gov.auditList(); });
  ipcMain.on("app:info:sync", (e) => { e.returnValue = { version: app.getVersion(), port, packaged: app.isPackaged, build: srv.currentBuild(), userData: app.getPath("userData"), platform: process.platform }; });

  ipcMain.handle("auth:signIn", (e, u, p) => gov.signIn(u, p));
  ipcMain.handle("auth:auto", () => gov.autoSignIn());
  ipcMain.handle("auth:signOut", () => gov.signOut());
  ipcMain.handle("audit:add", (e, a, d) => gov.auditAdd(a, d));
  ipcMain.handle("audit:verify", () => gov.auditVerify());
  ipcMain.handle("users:list", () => gov.listUsers());
  ipcMain.handle("users:save", (e, u) => gov.saveUser(u));
  ipcMain.handle("users:delete", (e, id) => gov.deleteUser(id));
  ipcMain.handle("pw:change", (e, o, n) => gov.changeOwnPassword(o, n));
  ipcMain.handle("settings:get", () => ({ ...gov.publicSettings(), port, apiUrl: `http://127.0.0.1:${port}/api/v1` }));
  ipcMain.handle("settings:update", (e, p) => gov.updateSettings(p));
  ipcMain.handle("api:rotate", () => gov.regenerateApiKey());

  ipcMain.handle("file:save", async (e, name, content, opts = {}) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const ext = path.extname(name).slice(1) || "txt";
    const r = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath("documents"), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, opts.base64 ? Buffer.from(content, "base64") : content);
    gov.auditAdd("file.save", path.basename(r.filePath));
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle("file:open", async (e, accept = "") => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const exts = accept.split(",").map(s => s.trim().replace(/^\./, "")).filter(s => s && !s.includes("/"));
    const r = await dialog.showOpenDialog(w, { properties: ["openFile"], filters: exts.length ? [{ name: exts.join(", ").toUpperCase(), extensions: exts }, { name: "All files", extensions: ["*"] }] : [] });
    if (r.canceled || !r.filePaths[0]) return null;
    const f = r.filePaths[0];
    if (fs.statSync(f).size > 50e6) return { error: "File larger than 50 MB" };
    return { name: path.basename(f), text: fs.readFileSync(f, "utf8") };
  });
  ipcMain.handle("pdf:report", async (e, name) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const pdf = await w.webContents.printToPDF({ printBackground: true, landscape: true, pageSize: "A4", margins: { marginType: "default" } });
    const r = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath("documents"), name || "reachgrid-report.pdf"), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, pdf); gov.auditAdd("export.pdf", path.basename(r.filePath));
    shell.openPath(r.filePath);
    return { ok: true, path: r.filePath, bytes: pdf.length };
  });
  ipcMain.handle("project:save", async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath("documents"), `reachgrid-project-${new Date().toISOString().slice(0, 10)}.reachgrid`), filters: [{ name: "ReachGrid project", extensions: ["reachgrid"] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(gov.exportProject(), null, 1));
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle("project:open", async (e, mode) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, { properties: ["openFile"], filters: [{ name: "ReachGrid project", extensions: ["reachgrid", "json"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try { return { ...gov.importProject(JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")), mode), path: r.filePaths[0] }; }
    catch (err) { return { ok: false, error: "Could not read project: " + err.message }; }
  });

  ipcMain.handle("data:check", async () => { try { return await srv.checkDataUpdate(); } catch (err) { return { error: err.message }; } });
  ipcMain.handle("data:apply", async () => {
    if (!gov.can("settings")) return { error: "Only an Admin can update data" };
    try { const r = await srv.applyDataUpdate(progress("data:progress")); gov.auditAdd("data.update", r.build); return r; } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle("data:revert", () => { if (!gov.can("settings")) return { error: "Only an Admin can change data" }; const b = srv.revertData(); gov.auditAdd("data.revert", b); return { build: b }; });
  ipcMain.handle("grid:osm", async () => {
    if (!gov.can("settings")) return { error: "Only an Admin can refresh the grid layer" };
    try { const r = await srv.refreshGridFromOSM(progress("grid:progress")); gov.auditAdd("data.grid_osm", `${r.substations} substations`); return r; } catch (err) { return { error: err.message }; }
  });
  let tileAbort = null;
  ipcMain.handle("tiles:prefetch", async (e, bbox, zmin, zmax) => {
    tileAbort = new AbortController();
    try { const r = await srv.prefetchTiles(bbox, zmin, zmax, progress("tiles:progress"), tileAbort.signal); gov.auditAdd("tiles.offline", `${r.total} tiles z${zmin}-${zmax}`); return r; } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle("tiles:cancel", () => { tileAbort && tileAbort.abort(); return true; });
  ipcMain.handle("tiles:size", () => srv.tileCacheSize());
  ipcMain.handle("tiles:clear", () => { srv.clearTiles(); return srv.tileCacheSize(); });
  ipcMain.handle("secret:set", (e, k, v) => {
    const f = path.join(app.getPath("userData"), `secret-${k.replace(/\W/g, "")}.bin`);
    if (!v) { fs.rmSync(f, { force: true }); return { ok: true }; }
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "OS encryption unavailable" };
    fs.writeFileSync(f, safeStorage.encryptString(v)); return { ok: true };
  });
  ipcMain.handle("secret:get", (e, k) => {
    const f = path.join(app.getPath("userData"), `secret-${k.replace(/\W/g, "")}.bin`);
    try { return fs.existsSync(f) ? safeStorage.decryptString(fs.readFileSync(f)) : null; } catch { return null; }
  });
  ipcMain.handle("notify", (e, t, b) => { notify(t, b); return true; });
  ipcMain.handle("open:doc", (e, page) => { openDoc(page, page.replace(".html", "")); return true; });
  ipcMain.handle("open:external", (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  ipcMain.handle("open:userData", () => shell.openPath(app.getPath("userData")));
  ipcMain.handle("app:update", () => { checkAppUpdate(true); return true; });
}

/* ---------------- smoke test (used by the Windows build pipeline) ---------------- */
async function runSmoke() {
  const results = []; const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) }); };
  const w = mainWin;
  try {
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("boot timeout")), 90000); const poll = async () => { try { if (await w.webContents.executeJavaScript("!!(window.RGApp && window.RGApp.ready)")) { clearTimeout(t); res(); } else setTimeout(poll, 300); } catch { setTimeout(poll, 300); } }; poll(); });
    ok("workspace boots", true);
    const r = await w.webContents.executeJavaScript("window.RGApp.selfTest()", true);
    for (const x of r) ok(x.name, x.pass, x.detail);
    // external API with key (as curl would)
    const key = gov.settings().apiKey;
    const get = (p, h = {}) => new Promise((res) => http.get({ host: "127.0.0.1", port, path: p, headers: h }, (resp) => { let b = ""; resp.on("data", c => b += c); resp.on("end", () => res({ status: resp.statusCode, body: b })); }).on("error", (e) => res({ status: 0, body: e.message })));
    const post = (p, body, h = {}) => new Promise((res) => { const rq = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", ...h } }, (resp) => { let b = ""; resp.on("data", c => b += c); resp.on("end", () => res({ status: resp.statusCode, body: b })); }); rq.on("error", (e) => res({ status: 0, body: e.message })); rq.end(JSON.stringify(body)); });
    const noKey = await get("/api/v1/geographies"); ok("API rejects requests without key", noKey.status === 401, noKey.status);
    const geo = await get("/api/v1/geographies", { "X-API-Key": key }); ok("API lists geographies with key", geo.status === 200 && JSON.parse(geo.body).count === 36, geo.status);
    const base = await get("/api/v1/geographies/jharkhand.east-singhbhum/baseline", { "X-API-Key": key }); ok("API baseline", base.status === 200 && JSON.parse(base.body).baseline_metrics.weighted_coverage > 0, base.status);
    const denied = await post("/api/v1/scenarios", { geography_id: "maharashtra.pune" }, { "X-API-Key": key }); ok("API key writes blocked by default", denied.status === 403, denied.status);
    const created = await post("/api/v1/scenarios", { geography_id: "maharashtra.pune", budget_lakh: 300 }, { "X-Session-Token": gov.session().token }); ok("API scenario via session", created.status === 201 || created.status === 200, created.status + " " + created.body.slice(0, 80));
    ok("audit chain verifies", gov.auditVerify().ok, JSON.stringify(gov.auditVerify()));
    const pdf = await w.webContents.printToPDF({ printBackground: true, landscape: true }); ok("PDF report renders", pdf.length > 20000, pdf.length + " bytes");
    if (process.env.REACHGRID_SMOKE_NETWORK) {
      // online checks: these run in the Windows build pipeline, which has internet access
      const tileUrl = "/tiles/a/6/45/27.png";
      const t = await get(tileUrl); ok("network: basemap tile via proxy + disk cache", t.status === 200, t.status);
      const t2 = await get(tileUrl); ok("network: tile served from cache second time", t2.status === 200, t2.status);
      const pre = await srv.prefetchTiles([86.0, 22.5, 86.6, 23.0], 7, 9, null); ok("network: offline tile download", pre.total > 0 && pre.failed < pre.total, JSON.stringify(pre));
      const dc = await srv.checkDataUpdate().catch(e => ({ error: e.message })); ok("network: data update check reaches published data", !dc.error && !!dc.remote, JSON.stringify(dc));
      const da = await srv.applyDataUpdate(null).catch(e => ({ error: e.message })); ok("network: data update downloads and applies", !da.error && da.files > 30, JSON.stringify(da));
      const reverted = srv.revertData(); ok("network: revert to bundled data", !!reverted, reverted);
      const os = await get("/proxy/osrm?coords=77.209,28.6139;75.7873,26.9124");
      let osOk = false; try { osOk = os.status === 200 && JSON.parse(os.body).routes[0].distance > 200000; } catch { }
      ok("network: OSRM street routing (best effort; app falls back to highway graph)", true, osOk ? "routed" : "unavailable " + os.status);
    }
    // role enforcement: viewer cannot write evidence
    const viewerId = "smoke-viewer";
    gov.saveUser({ id: viewerId, name: "Smoke viewer", role: "viewer", password: "pw-123456" });
    gov.signIn(viewerId, "pw-123456");
    const blocked = gov.storeSet("evidence", [{ lat: 1, lng: 1 }]); ok("viewer cannot write evidence (enforced in main)", !blocked.ok, blocked.error);
    gov.signIn("owner", ""); gov.deleteUser(viewerId);
  } catch (e) { ok("smoke run", false, e.stack || e.message); }
  const pass = results.every(r => r.pass);
  const out = JSON.stringify({ pass, version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, results }, null, 2);
  console.log(out); if (SMOKE_OUT) fs.writeFileSync(SMOKE_OUT, out);
  app.exit(pass ? 0 : 1);
}

app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.whenReady().then(async () => {
  try {
    app.setAppUserModelId("in.reachgrid.india");
    const userDir = app.getPath("userData"); fs.mkdirSync(userDir, { recursive: true });
    gov = createGovernance(userDir);
    srv = createServer({ appDir: APP_DIR, userDir, gov, log });
    const wanted = gov.settings().apiPort || 0;
    try { port = await srv.listen(wanted); } catch { port = await srv.listen(0); }
    log(`started ${app.getVersion()} on port ${port}, app dir ${APP_DIR}`);
    registerIPC(); buildMenu(); createMainWindow();
    if (SMOKE) { gov.autoSignIn(); mainWin.webContents.once("did-finish-load", () => runSmoke()); }
    else if (gov.settings().autoUpdate) setTimeout(() => checkAppUpdate(false), 8000);
  } catch (e) {
    log("fatal " + e.stack);
    dialog.showErrorBox("ReachGrid could not start", e.message + "\n\nLog: " + logFile());
    app.exit(1);
  }
});
