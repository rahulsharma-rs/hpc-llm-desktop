const assert = require("node:assert/strict");
const test = require("node:test");

const { startServer, stopServer } = require("../server.cjs");

test("loopback server serves the browser UI and protects the control API", async () => {
  const service = {
    bootstrap: async () => ({ app: { runtime: "Node.js" }, config: {}, catalog: {}, local: {} }),
    refresh: async () => ({ connection: { connected: true }, models: { items: [] }, sessions: [] }),
    refreshPartitions: async () => ({ items: [{ name: "amperenodes", availability: "up" }] }),
    preflightSession: async (values) => ({ accepted: true, queue: values.queue, message: "No job was submitted." }),
    startModelInstall: async (group) => ({ id: "install-1", group, status: "queued" }),
    getOperation: (id) => ({ id, group: "starter", status: "installing", progress: 40 }),
    recentOperations: () => [],
    close: async () => {},
  };
  const instance = await startServer({ service, token: "test-token", port: 0 });
  const baseUrl = `http://127.0.0.1:${instance.port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.data.runtime, "node");

    const page = await fetch(`${baseUrl}/`).then((response) => response.text());
    assert.match(page, /HPC LLM Desktop/);
    assert.match(page, /data-testid="model-select"/);

    const icon = await fetch(`${baseUrl}/icon.png`);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.ok((await icon.arrayBuffer()).byteLength > 1000);

    const unauthorized = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { "X-HPC-LLM-Token": "test-token" },
    }).then((response) => response.json());
    assert.equal(authorized.data.app.runtime, "Node.js");

    const refresh = await fetch(`${baseUrl}/api/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HPC-LLM-Token": "test-token",
      },
    }).then((response) => response.json());
    assert.equal(refresh.data.connection.connected, true);

    const preflight = await fetch(`${baseUrl}/api/sessions/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HPC-LLM-Token": "test-token",
      },
      body: JSON.stringify({ queue: "amperenodes" }),
    }).then((response) => response.json());
    assert.equal(preflight.data.accepted, true);
    assert.equal(preflight.data.queue, "amperenodes");

    const install = await fetch(`${baseUrl}/api/models/install`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HPC-LLM-Token": "test-token",
      },
      body: JSON.stringify({ group: "starter" }),
    }).then((response) => response.json());
    assert.equal(install.data.status, "queued");

    const operation = await fetch(`${baseUrl}/api/operations/install-1`, {
      headers: { "X-HPC-LLM-Token": "test-token" },
    }).then((response) => response.json());
    assert.equal(operation.data.progress, 40);
  } finally {
    await stopServer(instance);
  }
});
