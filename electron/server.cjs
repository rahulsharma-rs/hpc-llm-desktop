const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { HpcLlmService } = require("./service.cjs");

const DEBUG_ENABLED = process.env.HPC_LLM_DEBUG === "1" || process.env.CHEAHA_ELECTRON_DEBUG === "1";

const WEB_ROOT = path.join(__dirname, "web");
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/icon.png": [path.join("..", "assets", "icon.png"), "image/png"],
};

async function startServer(options = {}) {
  const host = options.host || "127.0.0.1";
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("HPC LLM Desktop may only bind to the local loopback interface.");
  }
  const token = options.token || crypto.randomBytes(32).toString("base64url");
  const service = options.service || new HpcLlmService();
  const server = http.createServer((request, response) => handleRequest(request, response, { service, token }));
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`;
  return { server, service, token, url, port: address.port };
}

async function stopServer(instance) {
  if (!instance) return;
  await instance.service.close();
  await new Promise((resolve) => instance.server.close(resolve));
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url, "http://127.0.0.1");
  const startedAt = Date.now();
  const debug = DEBUG_ENABLED && url.pathname.startsWith("/api/");
  if (debug) console.log(`[api] ${request.method} ${url.pathname} started`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, data: { status: "ready", runtime: "node" } });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const requestToken = request.headers["x-hpc-llm-token"] || request.headers["x-cheaha-token"];
      if (requestToken !== context.token) {
        sendJson(response, 401, { ok: false, error: "Missing or invalid local app token." });
        return;
      }
      await handleApi(request, response, url.pathname, context.service);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    if (debug) console.error(`[api] ${request.method} ${url.pathname} failed: ${error.message}`);
    const status = isClientError(error) ? 400 : 500;
    sendJson(response, status, { ok: false, error: error.message || error.constructor.name });
  } finally {
    if (debug) console.log(`[api] ${request.method} ${url.pathname} finished in ${Date.now() - startedAt}ms`);
  }
}

async function handleApi(request, response, route, service) {
  if (request.method === "GET") {
    if (route.startsWith("/api/operations/")) {
      const operationId = decodeURIComponent(route.slice("/api/operations/".length));
      sendJson(response, 200, { ok: true, data: service.getOperation(operationId) });
      return;
    }
    const handlers = {
      "/api/bootstrap": () => service.bootstrap(),
      "/api/endpoint": () => service.testEndpoint(),
      "/api/operations": () => service.recentOperations(),
    };
    const handler = handlers[route];
    if (!handler) {
      sendJson(response, 404, { ok: false, error: "API route not found." });
      return;
    }
    sendJson(response, 200, { ok: true, data: await handler() });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }
  const body = await readJson(request);
  const handlers = {
    "/api/settings": () => service.saveSettings(body),
    "/api/account/generate-key": () => service.generateKey(body),
    "/api/account/deploy-key": () => service.deployKey(body),
    "/api/account/fingerprint": () => service.fetchFingerprint(),
    "/api/account/test": () => service.testConnection(),
    "/api/account/create-folder": () => service.createRemoteFolder(),
    "/api/account/huggingface-token": () => service.saveHuggingFaceToken(body.token),
    "/api/account/install-llama": () => service.installLlamaServer(),
    "/api/account/verify-llama": () => service.verifyLlamaServer(),
    "/api/refresh": () => service.refresh(),
    "/api/models/refresh": () => service.refreshModels(),
    "/api/models/install": () => service.startModelInstall(body.group),
    "/api/models/download": () => service.startModelInstall(body.group),
    "/api/partitions/refresh": () => service.refreshPartitions(),
    "/api/sessions/refresh": () => service.refreshSessions(),
    "/api/sessions/preflight": () => service.preflightSession(body),
    "/api/sessions/start": () => service.startSession(body),
    "/api/sessions/cancel": () => service.cancelSession(body.job_id),
    "/api/tunnel/start": () => service.connectTunnel(body.job_id),
    "/api/tunnel/stop": () => service.stopTunnel(),
    "/api/opencode/configure": () => service.configureOpenCode(body.job_id || null),
  };
  const handler = handlers[route];
  if (!handler) {
    sendJson(response, 404, { ok: false, error: "API route not found." });
    return;
  }
  sendJson(response, 200, { ok: true, data: await handler() });
}

function serveStatic(request, response, route) {
  const entry = STATIC_FILES[route];
  if (!entry) {
    sendJson(response, 404, { ok: false, error: "Page not found." });
    return;
  }
  const [filename, contentType] = entry;
  const content = fs.readFileSync(path.join(WEB_ROOT, filename));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const content = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 1000000) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || Array.isArray(value) || typeof value !== "object") {
          reject(new Error("Request body must be a JSON object."));
          return;
        }
        resolve(value);
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
  });
}

function isClientError(error) {
  return /required|invalid|unknown|select|must|not found|does not|only supports|already in use|after it is running/i
    .test(error.message || "");
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = fs.existsSync("/Applications/Google Chrome.app")
      ? ["-a", "Google Chrome", url]
      : [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", (error) => console.error(`Unable to open a browser: ${error.message}`));
  child.unref();
}

async function runStandalone() {
  const args = new Set(process.argv.slice(2));
  const portArg = process.argv.find((value) => value.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=", 2)[1]) : 11380;
  const instance = await startServer({ port });
  console.log(`HPC LLM Desktop browser app: ${instance.url}`);
  if (args.has("--open-browser")) openBrowser(instance.url);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await stopServer(instance);
  };
  process.on("SIGINT", async () => { await stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await stop(); process.exit(0); });
}

if (require.main === module) {
  runStandalone().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  handleRequest,
  openBrowser,
  startServer,
  stopServer,
};
