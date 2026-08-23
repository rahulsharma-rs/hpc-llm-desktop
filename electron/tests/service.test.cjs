const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore } = require("../config.cjs");
const { HpcLlmService, testEndpoint } = require("../service.cjs");

class FakeRemote {
  constructor(record) {
    this.record = record;
  }

  async connect() { this.record.connected += 1; }
  async preparePaths() {
    return this.pathInfo();
  }
  pathInfo() {
    return {
      remote_home: "/users/testuser",
      remote_workdir: "/users/testuser/.cheaha-llm/runtime",
      models_directory: "/users/testuser/cheaha_llm_client/gguf_models",
    };
  }
  close() { this.record.closed += 1; }
  async testConnection() {
    return { connected: true, hostname: "c0001", username: "testuser", message: "SSH key login succeeded." };
  }
  async listModels() {
    return [{
      label: "Qwen3.8-27B-Q4_K_M.gguf (17.7 GB)",
      path: "/home/testuser/cheaha_llm_client/gguf_models/Qwen3.8-27B-Q4_K_M.gguf",
      size: "17.7 GB",
      location: "home",
      context_options: [8192, 16384, 32768, 65536, 131072, 262144],
      default_context: 65536,
    }];
  }
  async installStatuses() { return { qwen38: "Qwen3.8 27B: ready." }; }
  async listSessions() { return []; }
  async partitionStatuses() {
    return {
      items: [{ name: "amperenodes", availability: "up", total_nodes: 20, idle_nodes: 3, mixed_nodes: 14 }],
      checked_at: "2026-08-23T16:00:00.000Z",
    };
  }
  async downloadModels(group, onProgress) {
    this.record.downloads.push(group);
    onProgress?.({ progress: 40, message: "Downloading test model" });
    if (this.record.installError) throw new Error(this.record.installError);
    onProgress?.({ progress: 100, message: "Verified test model" });
  }
  async startLlamaSession(values) {
    this.record.started = values;
    return "40000001";
  }
  async preflightLlamaSession(values) {
    this.record.preflights.push(values);
    return { accepted: true, message: `Slurm accepted ${values.queue.name}. No job was submitted.` };
  }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-llm-service-"));
  const keyPath = path.join(directory, "id_ed25519");
  fs.writeFileSync(keyPath, "test-key", { mode: 0o600 });
  const store = new ConfigStore(directory);
  store.save({
    username: "testuser",
    private_key_path: keyPath,
    remote_host: "cheaha.rc.uab.edu",
    ssh_port: 22,
    local_port: 12435,
    remote_port: 8000,
    remote_workdir: "/gpfs/scratch/testuser/cheaha_llm_client",
    remote_gguf_model_path: "",
    llama_context_tokens: 65536,
  });
  const record = { connected: 0, closed: 0, started: null, preflights: [], downloads: [], installError: null };
  const tunnel = { isRunning: false, stop: async () => {}, stopExisting: async () => {} };
  const service = new HpcLlmService({
    configStore: store,
    tunnel,
    remoteFactory: () => new FakeRemote(record),
  });
  return { service, store, record };
}

test("refresh returns persistent models through the standalone Node remote layer", async () => {
  const { service, record } = fixture();
  const result = await service.refresh();

  assert.equal(result.connection.connected, true);
  assert.equal(result.models.home_count, 1);
  assert.equal(result.partitions.items[0].idle_nodes, 3);
  assert.equal(result.models.items[0].label, "Qwen3.8-27B-Q4_K_M.gguf (17.7 GB)");
  assert.equal(record.connected, 1);
  assert.equal(record.closed, 1);
});

test("session preflight validates the exact request without submitting a job", async () => {
  const { service, record } = fixture();
  const modelPath = "/home/testuser/cheaha_llm_client/gguf_models/Qwen3.8-27B-Q4_K_M.gguf";

  const result = await service.preflightSession({
    backend: "llama",
    queue: "amperenodes",
    runtime: "2 hours",
    resource: "Medium - 8 CPU / 64G",
    context_tokens: 65536,
    model_path: modelPath,
  });

  assert.equal(result.accepted, true);
  assert.equal(record.preflights[0].queue.name, "amperenodes");
  assert.equal(record.started, null);
});

test("simultaneous Electron and browser refreshes share one SSH operation", async () => {
  const { service, record } = fixture();
  const [electronResult, browserResult] = await Promise.all([service.refresh(), service.refresh()]);

  assert.equal(record.connected, 1);
  assert.deepEqual(electronResult.models.items, browserResult.models.items);
});

test("Qwen3.8 launch values are validated and sent to the Node Slurm layer", async () => {
  const { service, store, record } = fixture();
  const modelPath = "/home/testuser/cheaha_llm_client/gguf_models/Qwen3.8-27B-Q4_K_M.gguf";
  const result = await service.startSession({
    backend: "llama",
    queue: "amperenodes-medium",
    runtime: "20 hours",
    resource: "Medium - 8 CPU / 64G",
    context_tokens: 65536,
    model_path: modelPath,
  });

  assert.equal(result.job_id, "40000001");
  assert.equal(record.started.modelPath, modelPath);
  assert.equal(record.started.queue.name, "amperenodes-medium");
  assert.equal(store.load().remote_gguf_model_path, modelPath);
});

test("unsafe Slurm values are rejected before an SSH command is created", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.cancelSession("4000; touch /tmp/no"),
    /only digits/,
  );
});

test("model-aware defaults reject Pascal and undersized-memory combinations before SSH", async () => {
  const { service, record } = fixture();
  const qwenPath = "/home/testuser/cheaha_llm_client/gguf_models/Qwen3.8-27B-Q4_K_M.gguf";
  await assert.rejects(
    service.preflightSession({
      backend: "llama",
      queue: "pascalnodes",
      runtime: "2 hours",
      resource: "Medium - 8 CPU / 64G",
      context_tokens: 65536,
      model_path: qwenPath,
    }),
    /too large.*Pascal preset/i,
  );
  await assert.rejects(
    service.preflightSession({
      backend: "llama",
      queue: "largemem",
      runtime: "20 hours",
      resource: "Large memory - 24 CPU / 256G",
      context_tokens: 65536,
      model_path: "/home/testuser/cheaha_llm_client/gguf_models/GLM-5.2-UD-IQ1_M-00001-of-00006.gguf",
    }),
    /requires at least 450G host memory/,
  );
  assert.equal(record.preflights.length, 0);
});

test("model installation runs in the background and reports completion", async () => {
  const { service, record } = fixture();
  const started = await service.startModelInstall("starter");

  assert.equal(started.status, "queued");
  await waitFor(() => service.getOperation(started.id).status === "complete");
  const completed = service.getOperation(started.id);
  assert.equal(completed.progress, 100);
  assert.match(completed.message, /persistent home storage/);
  assert.deepEqual(record.downloads, ["starter"]);
});

test("failed model installation preserves a clear retry message", async () => {
  const { service, record } = fixture();
  record.installError = "curl: remote server returned 503";
  const started = await service.startModelInstall("starter");

  await waitFor(() => service.getOperation(started.id).status === "failed");
  const failed = service.getOperation(started.id);
  assert.equal(failed.progress, 40);
  assert.match(failed.message, /partial download is preserved/);
  assert.match(failed.error, /503/);
});

test("SSH authentication failures are translated into actionable guidance", async () => {
  const { service } = fixture();
  service.remoteFactory = () => ({
    connect: async () => { throw new Error("All configured authentication methods failed"); },
    close: () => {},
  });

  await assert.rejects(
    service.testConnection(),
    /Check the username, private key, and whether the public key is installed/,
  );
});

test("an inactive local endpoint returns actionable session and tunnel guidance", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const result = await testEndpoint(port);

  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(`local port ${port}`));
  assert.match(result.message, /Start a model session and connect its tunnel/);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for background operation.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
