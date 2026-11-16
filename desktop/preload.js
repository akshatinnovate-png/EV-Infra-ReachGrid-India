/* Bridge between the workspace (renderer) and the desktop main process. Exposes a narrow, typed API. */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const EVENTS = ["menu", "data:progress", "grid:progress", "tiles:progress"];
contextBridge.exposeInMainWorld("RGDesktop", {
  // synchronous workspace store (permission-checked in the main process)
  storeGet: (k) => ipcRenderer.sendSync("store:get", k),
  storeSet: (k, v) => ipcRenderer.sendSync("store:set", k, v),
  session: () => ipcRenderer.sendSync("session:get"),
  auditList: () => ipcRenderer.sendSync("audit:list"),
  info: () => ipcRenderer.sendSync("app:info:sync"),
  // async
  signIn: (u, p) => ipcRenderer.invoke("auth:signIn", u, p),
  autoSignIn: () => ipcRenderer.invoke("auth:auto"),
  signOut: () => ipcRenderer.invoke("auth:signOut"),
  auditAdd: (a, d) => ipcRenderer.invoke("audit:add", a, d),
  auditVerify: () => ipcRenderer.invoke("audit:verify"),
  users: () => ipcRenderer.invoke("users:list"),
  saveUser: (u) => ipcRenderer.invoke("users:save", u),
  deleteUser: (id) => ipcRenderer.invoke("users:delete", id),
  changePassword: (o, n) => ipcRenderer.invoke("pw:change", o, n),
  settings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (p) => ipcRenderer.invoke("settings:update", p),
  rotateApiKey: () => ipcRenderer.invoke("api:rotate"),
  saveFile: (name, content, opts) => ipcRenderer.invoke("file:save", name, content, opts),
  openFile: (accept) => ipcRenderer.invoke("file:open", accept),
  pdfReport: (name) => ipcRenderer.invoke("pdf:report", name),
  saveProject: () => ipcRenderer.invoke("project:save"),
  openProject: (mode) => ipcRenderer.invoke("project:open", mode),
  checkData: () => ipcRenderer.invoke("data:check"),
  applyData: () => ipcRenderer.invoke("data:apply"),
  revertData: () => ipcRenderer.invoke("data:revert"),
  refreshGrid: () => ipcRenderer.invoke("grid:osm"),
  prefetchTiles: (bbox, zmin, zmax) => ipcRenderer.invoke("tiles:prefetch", bbox, zmin, zmax),
  cancelTiles: () => ipcRenderer.invoke("tiles:cancel"),
  tileCache: () => ipcRenderer.invoke("tiles:size"),
  clearTiles: () => ipcRenderer.invoke("tiles:clear"),
  secretSet: (k, v) => ipcRenderer.invoke("secret:set", k, v),
  secretGet: (k) => ipcRenderer.invoke("secret:get", k),
  notify: (t, b) => ipcRenderer.invoke("notify", t, b),
  openDoc: (page) => ipcRenderer.invoke("open:doc", page),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  openUserData: () => ipcRenderer.invoke("open:userData"),
  checkAppUpdate: () => ipcRenderer.invoke("app:update"),
  on: (ch, cb) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (e, ...a) => cb(...a)); },
});
