const { app, BrowserWindow, dialog, session, shell } = require("electron");

const { openBrowser, startServer, stopServer } = require("./server.cjs");

const DEBUG_ENABLED = process.env.HPC_LLM_DEBUG === "1" || process.env.CHEAHA_ELECTRON_DEBUG === "1";

let window = null;
let serverInstance = null;
let shuttingDown = false;

function createWindow(url) {
  const nextWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "HPC LLM Desktop",
    backgroundColor: "#f3f5f2",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  nextWindow.webContents.setWindowOpenHandler(({ url: requestedUrl }) => {
    if (/^https?:\/\//.test(requestedUrl)) shell.openExternal(requestedUrl);
    return { action: "deny" };
  });
  nextWindow.webContents.on("will-navigate", (event, requestedUrl) => {
    if (new URL(requestedUrl).origin !== new URL(url).origin) event.preventDefault();
  });
  nextWindow.webContents.on("console-message", (_event, details) => {
    if (DEBUG_ENABLED) {
      const message = typeof details === "object" ? details.message : String(details);
      console.log(`[renderer] ${message}`);
    }
  });
  if (DEBUG_ENABLED) {
    const debugTimer = setInterval(async () => {
      if (nextWindow.isDestroyed()) {
        clearInterval(debugTimer);
        return;
      }
      try {
        const snapshot = await nextWindow.webContents.executeJavaScript(`({
          busy: !document.querySelector("#busy-overlay").hidden,
          activity: document.querySelector("#activity-list").innerText,
          hpc: document.querySelector("#hpc-summary").textContent,
          modelCount: window.__HPC_LLM_APP__?.models?.length ?? null
        })`);
        console.log(`[renderer-state] ${JSON.stringify(snapshot)}`);
      } catch (error) {
        console.error(`[renderer-state] ${error.message}`);
      }
    }, 10000);
    nextWindow.once("closed", () => clearInterval(debugTimer));
  }
  nextWindow.on("closed", () => { window = null; });
  nextWindow.loadURL(url);
  return nextWindow;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.on("second-instance", () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(async () => {
  try {
    serverInstance = await startServer({ port: 0 });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window = createWindow(serverInstance.url);
    await new Promise((resolve, reject) => {
      window.webContents.once("did-finish-load", resolve);
      window.webContents.once("did-fail-load", (_event, code, description) => reject(new Error(`${code}: ${description}`)));
    });
    openBrowser(serverInstance.url);
  } catch (error) {
    dialog.showErrorBox("HPC LLM Desktop could not start", error.message || String(error));
    app.quit();
  }
});

app.on("activate", () => {
  if (!window && serverInstance) {
    window = createWindow(serverInstance.url);
  }
});

app.on("before-quit", (event) => {
  if (shuttingDown || !serverInstance) return;
  event.preventDefault();
  shuttingDown = true;
  stopServer(serverInstance).finally(() => {
    serverInstance = null;
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
