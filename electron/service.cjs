const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  BACKENDS,
  GPU_QUEUES,
  MODEL_DOWNLOADS,
  RESOURCE_PRESETS,
  SESSION_RUNTIMES,
  contextOptionsForModel,
  findQueue,
  findResource,
  findRuntime,
} = require("./catalog.cjs");
const { ConfigStore, normalizeConfig, positiveInteger } = require("./config.cjs");
const { PROVIDER_ID, PROVIDER_NAME, configureOpenCode } = require("./opencode.cjs");
const {
  RemoteClient,
  TunnelController,
  fetchHostFingerprint,
  generateKeyPair,
  jobPayload,
  listenerInfo,
  validateJobId,
} = require("./remote.cjs");

class HpcLlmService {
  constructor(options = {}) {
    this.configStore = options.configStore || new ConfigStore();
    this.remoteFactory = options.remoteFactory || ((config) => new RemoteClient(config));
    this.tunnel = options.tunnel || new TunnelController();
    this.openCodePaths = options.openCodePaths || {};
    this.jobs = new Map();
    this.operations = new Map();
    this.refreshPromise = null;
  }

  async bootstrap() {
    const config = this.configStore.load();
    return {
      app: { name: "HPC LLM Desktop", surface: "Electron + browser", runtime: "Node.js" },
      config: publicConfig(config),
      catalog: {
        backends: BACKENDS,
        queues: GPU_QUEUES,
        resources: RESOURCE_PRESETS,
        runtimes: SESSION_RUNTIMES,
        models: [],
      },
      local: this.localState(config),
      operations: this.recentOperations(),
    };
  }

  async saveSettings(values) {
    const current = this.configStore.load();
    const nextHost = String(values.remote_host ?? current.remote_host).trim();
    const config = normalizeConfig({
      ...current,
      ...values,
      known_host_fingerprint: nextHost === current.remote_host
        && Number(values.ssh_port ?? current.ssh_port) === current.ssh_port
        ? current.known_host_fingerprint
        : null,
    });
    validateAccountFields(config, false);
    return publicConfig(this.configStore.save(config));
  }

  async generateKey(values) {
    await this.saveSettings(values);
    const config = this.configStore.load();
    const key = generateKeyPair(config.private_key_path);
    config.private_key_path = key.privateKeyPath;
    this.configStore.save(config);
    return {
      message: "SSH key is ready.",
      private_key_path: key.privateKeyPath,
      public_key_path: key.publicKeyPath,
    };
  }

  async deployKey(values) {
    const password = String(values.password || "");
    if (!password) throw new Error("HPC account password is required for first-time key deployment.");
    const settings = { ...values };
    delete settings.password;
    await this.saveSettings(settings);
    const config = this.requireAccount(false);
    const key = generateKeyPair(config.private_key_path);
    const remote = this.remoteFactory(config);
    try {
      await remote.connect({ password });
      await remote.deployPublicKey(key.publicKeyPath);
    } finally {
      remote.close();
    }
    return { message: `Public key deployed. Private key: ${key.privateKeyPath}` };
  }

  async fetchFingerprint() {
    const config = this.requireAccount(false);
    const fingerprint = fetchHostFingerprint(config.remote_host, config.ssh_port);
    config.known_host_fingerprint = fingerprint.sha256;
    this.configStore.save(config);
    return {
      message: `${fingerprint.algorithm} ${fingerprint.sha256}`,
      ...fingerprint,
    };
  }

  async testConnection() {
    return this.withRemote((remote) => remote.testConnection());
  }

  async createRemoteFolder() {
    return this.withRemote(async (remote) => {
      await remote.createRemoteFolder();
      const paths = remote.pathInfo();
      return { message: `Runtime and persistent model folders are ready.`, ...paths };
    });
  }

  async saveHuggingFaceToken(token) {
    const cleanToken = String(token || "").trim();
    if (!cleanToken.startsWith("hf_")) throw new Error("Hugging Face token should start with hf_.");
    await this.withRemote((remote) => remote.deployHuggingFaceToken(cleanToken));
    return { message: "Hugging Face token deployed to the HPC. It was not stored locally." };
  }

  async installLlamaServer() {
    const installerPath = path.join(__dirname, "assets", "install_llama_server.sh");
    const script = fs.readFileSync(installerPath, "utf8");
    await this.withRemote((remote) => remote.installLlamaServer(script));
    const version = await this.withRemote((remote) => remote.verifyLlamaServer());
    return { message: `llama-server installed and verified. ${version}` };
  }

  async verifyLlamaServer() {
    const version = await this.withRemote((remote) => remote.verifyLlamaServer());
    return { message: version };
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async performRefresh() {
    const connection = await this.withRemote(async (remote) => {
      const identity = await remote.testConnection();
      const [models, installStatus, sessions, partitions] = await Promise.all([
        remote.listModels(),
        remote.installStatuses(),
        remote.listSessions(),
        remote.partitionStatuses().catch((error) => ({
          items: [],
          checked_at: null,
          warning: friendlyRemoteError(error).message,
        })),
      ]);
      return { identity, models, installStatus, sessions, partitions, storage: remote.pathInfo() };
    });
    this.jobs = new Map(connection.sessions.map((job) => [job.job_id, job]));
    const config = this.configStore.load();
    return {
      connection: {
        connected: true,
        message: `${connection.identity.username}@${connection.identity.hostname}`,
      },
      models: modelsPayload(connection.models, connection.installStatus, connection.storage),
      sessions: connection.sessions.map(jobPayload),
      partitions: connection.partitions,
      local: this.localState(config),
    };
  }

  async refreshPartitions() {
    return this.withRemote((remote) => remote.partitionStatuses());
  }

  async refreshModels() {
    const result = await this.withRemote(async (remote) => {
      const [models, installStatus] = await Promise.all([
        remote.listModels(),
        remote.installStatuses(),
      ]);
      return { models, installStatus, storage: remote.pathInfo() };
    });
    return modelsPayload(result.models, result.installStatus, result.storage);
  }

  async startModelInstall(group) {
    if (!MODEL_DOWNLOADS[group]) throw new Error("Unknown model download group.");
    const active = [...this.operations.values()].find(
      (operation) => ["queued", "installing"].includes(operation.status),
    );
    if (active?.group === group) return publicOperation(active);
    if (active) throw new Error(`${active.label} is already installing. Wait for it to finish before installing another model.`);
    const operation = {
      id: crypto.randomUUID(),
      type: "model-install",
      group,
      label: groupLabel(group),
      status: "queued",
      progress: 0,
      message: "Waiting to connect to the HPC.",
      error: null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.operations.set(operation.id, operation);
    setImmediate(() => this.runModelInstall(operation));
    return publicOperation(operation);
  }

  async runModelInstall(operation) {
    updateOperation(operation, {
      status: "installing",
      progress: 1,
      message: "Connecting to the HPC and checking persistent home storage.",
    });
    try {
      await this.withRemote((remote) => remote.downloadModels(operation.group, (progress) => {
        updateOperation(operation, progress);
      }));
      updateOperation(operation, {
        status: "complete",
        progress: 100,
        message: `${operation.label} is installed and verified in persistent home storage.`,
      });
    } catch (error) {
      updateOperation(operation, {
        status: "failed",
        message: "Installation stopped. The partial download is preserved for retry.",
        error: friendlyRemoteError(error).message,
      });
    }
  }

  getOperation(id) {
    const operation = this.operations.get(String(id || ""));
    if (!operation) throw new Error("Installation operation not found.");
    return publicOperation(operation);
  }

  recentOperations() {
    return [...this.operations.values()].slice(-20).reverse().map(publicOperation);
  }

  async refreshSessions() {
    const sessions = await this.withRemote((remote) => remote.listSessions());
    this.jobs = new Map(sessions.map((job) => [job.job_id, job]));
    return sessions.map(jobPayload);
  }

  validateSession(values) {
    if (String(values.backend || "llama") !== "llama") {
      throw new Error("The standalone Electron client currently supports llama-server GGUF sessions.");
    }
    const queue = findQueue(values.queue);
    const runtime = findRuntime(values.runtime);
    const resource = findResource(values.resource);
    const contextTokens = positiveInteger(values.context_tokens, "Context tokens");
    const modelPath = String(values.model_path || "").trim();
    if (!/^\/[^\0\r\n]*\.gguf$/.test(modelPath)) {
      throw new Error("Select an absolute HPC GGUF model path before starting llama-server.");
    }
    if (!contextOptionsForModel(modelPath).includes(contextTokens)) {
      throw new Error(`Context must be one of: ${contextOptionsForModel(modelPath).join(", ")}.`);
    }
    if (runtime.hours > queue.max_hours) {
      throw new Error(`${queue.name} allows up to ${queue.max_runtime}.`);
    }
    const normalizedModel = modelPath.toLowerCase();
    const minimumMemory = minimumMemoryForModel(normalizedModel);
    if (memoryGiB(resource.mem) < minimumMemory) {
      throw new Error(`${modelLabel(modelPath)} requires at least ${minimumMemory}G host memory. Use the recommended defaults.`);
    }
    if (normalizedModel.includes("glm-5.2") && !["largemem", "largemem-long"].includes(queue.name)) {
      throw new Error("GLM-5.2 requires a largemem partition.");
    }
    if (normalizedModel.includes("gpt-oss-120b") && queue.gpu_type) {
      throw new Error("GPT-OSS 120B is not supported by the app's one-GPU preset. Use the recommended largemem configuration.");
    }
    if (queue.gpu_type === "pascal" && /qwen3(?:-coder|\.6|\.8)/.test(normalizedModel)) {
      throw new Error("This Qwen model is too large for the app's one-GPU Pascal preset. Use the recommended Ampere configuration.");
    }
    const config = this.requireAccount();
    return {
      config,
      request: {
        modelPath,
        queue,
        runtime,
        resource,
        remotePort: config.remote_port,
        contextTokens,
      },
    };
  }

  async preflightSession(values) {
    const { request } = this.validateSession(values);
    return this.withRemote((remote) => remote.preflightLlamaSession(request));
  }

  async startSession(values) {
    const { config, request } = this.validateSession(values);
    const jobId = await this.withRemote((remote) => remote.startLlamaSession({
      ...request,
    }));
    config.remote_gguf_model_path = request.modelPath;
    config.llama_context_tokens = request.contextTokens;
    this.configStore.save(config);
    return { job_id: jobId, message: `Submitted HPC LLM session ${jobId}.` };
  }

  async cancelSession(jobId) {
    const validated = validateJobId(jobId);
    await this.withRemote((remote) => remote.cancelSession(validated));
    this.jobs.delete(validated);
    return { message: `Cancelled HPC LLM session ${validated}.` };
  }

  async connectTunnel(jobId) {
    const validated = validateJobId(jobId);
    const config = this.requireAccount();
    const job = await this.withRemote((remote) => remote.sessionDetails(validated));
    if (!job) throw new Error(`Slurm job ${validated} is no longer active.`);
    if (job.state !== "RUNNING" || !job.assigned_node) {
      throw new Error(`Slurm job ${validated} is ${job.state}; connect after it is running.`);
    }
    this.jobs.set(validated, job);
    const target = await this.tunnel.start(config, job);
    const endpoint = await testEndpoint(config.local_port);
    const modelId = endpoint.model_ids[0] || job.metadata.MODEL_ID || "hpc-llm";
    const openCode = configureOpenCode(
      config.local_port,
      modelId,
      numberOrNull(job.metadata.CONTEXT_TOKENS),
      this.openCodePaths,
    );
    return {
      message: `Tunnel connected to ${target.node}:${target.remotePort} for job ${validated}.`,
      endpoint,
      opencode: {
        model: openCode.model,
        config_path: openCode.configPath,
        auth_path: openCode.authPath,
      },
      local: this.localState(config),
    };
  }

  async stopTunnel() {
    const config = this.configStore.load();
    await this.tunnel.stopExisting(config.local_port);
    return { message: "SSH tunnel stopped.", local: this.localState(config) };
  }

  async testEndpoint() {
    return testEndpoint(this.configStore.load().local_port);
  }

  async configureOpenCode(jobId = null) {
    let job = jobId ? this.jobs.get(validateJobId(jobId)) : null;
    if (!job) job = [...this.jobs.values()].find((item) => item.state === "RUNNING") || null;
    const config = this.configStore.load();
    const endpoint = await testEndpoint(config.local_port);
    const modelId = endpoint.model_ids[0] || job?.metadata.MODEL_ID || "hpc-llm";
    const result = configureOpenCode(
      config.local_port,
      modelId,
      numberOrNull(job?.metadata.CONTEXT_TOKENS),
      this.openCodePaths,
    );
    return {
      message: `Configured ${PROVIDER_NAME} with model ${PROVIDER_ID}/${modelId}.`,
      config_path: result.configPath,
      auth_path: result.authPath,
      model: result.model,
    };
  }

  localState(config = this.configStore.load()) {
    const listener = listenerInfo(config.local_port);
    return {
      tunnel_active: Boolean(listener),
      tunnel_managed: this.tunnel.isRunning,
      endpoint_url: `http://127.0.0.1:${config.local_port}/v1`,
    };
  }

  requireAccount(requireKey = true) {
    const config = this.configStore.load();
    validateAccountFields(config, requireKey);
    return config;
  }

  async withRemote(action) {
    const config = this.requireAccount();
    const remote = this.remoteFactory(config);
    try {
      await remote.connect();
      await remote.preparePaths();
      return await action(remote);
    } catch (error) {
      throw friendlyRemoteError(error);
    } finally {
      remote.close();
    }
  }

  async close() {
    await this.tunnel.stop();
  }
}

async function testEndpoint(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* Preserve the response text below. */ }
    const modelIds = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((item) => typeof item === "string")
      : [];
    return {
      ok: response.ok,
      status_code: response.status,
      message: response.ok ? "Endpoint is responding." : text.slice(0, 300),
      model_ids: modelIds,
    };
  } catch (error) {
    const causeCode = error.cause?.code;
    let message;
    if (error.name === "TimeoutError") {
      message = `The endpoint on local port ${port} did not respond within 5 seconds. Check the tunnel and retry.`;
    } else if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(causeCode) || error.message === "fetch failed") {
      message = `No model endpoint is listening on local port ${port}. Start a model session and connect its tunnel, then retry.`;
    } else {
      message = `Endpoint check failed on local port ${port}: ${error.message}`;
    }
    return { ok: false, status_code: null, message, model_ids: [] };
  }
}

function modelsPayload(models, installStatus, storage = null) {
  return {
    items: models,
    home_count: models.filter((model) => model.location === "home").length,
    scratch_count: models.filter((model) => model.location === "scratch").length,
    install_status: installStatus,
    storage,
  };
}

function publicConfig(config) {
  return { ...config };
}

function validateAccountFields(config, requireKey) {
  if (!config.username) throw new Error("HPC username is required.");
  if (!/^[A-Za-z0-9._-]+$/.test(config.username)) throw new Error("HPC username contains unsupported characters.");
  if (!config.remote_host) throw new Error("Remote host is required.");
  if (!/^[A-Za-z0-9.-]+$/.test(config.remote_host)) throw new Error("Remote host contains unsupported characters.");
  if ((!config.remote_workdir.startsWith("/") && !config.remote_workdir.startsWith("~/"))
      || /[\0\r\n]/.test(config.remote_workdir)) {
    throw new Error("Remote work directory must be an absolute path or start with ~/.");
  }
  if (requireKey) {
    if (!config.private_key_path) throw new Error("SSH private key path is required.");
    if (!fs.existsSync(config.private_key_path)) throw new Error(`SSH private key not found: ${config.private_key_path}`);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function groupLabel(group) {
  return {
    starter: "Starter models",
    qwen36: "Qwen3.6 35B",
    qwen38: "Qwen3.8 27B",
    gpt_oss: "GPT-OSS 120B",
    glm52: "GLM-5.2",
  }[group] || group;
}

function memoryGiB(value) {
  const match = String(value || "").match(/^(\d+)G$/i);
  return match ? Number(match[1]) : 0;
}

function minimumMemoryForModel(value) {
  if (value.includes("glm-5.2") || value.includes("glm5.2")) return 450;
  if (value.includes("gpt-oss-120b")) return 128;
  if (/qwen3(?:-coder|\.6|\.8)/.test(value)) return 64;
  return 32;
}

function modelLabel(value) {
  return path.posix.basename(String(value || "")).replace(/\.gguf$/i, "");
}

function updateOperation(operation, values) {
  Object.assign(operation, values, { updated_at: new Date().toISOString() });
}

function publicOperation(operation) {
  return { ...operation };
}

function friendlyRemoteError(error) {
  const message = String(error?.message || error || "Unknown remote error.");
  if (/All configured authentication methods failed/i.test(message)) {
    return new Error("SSH authentication was rejected. Check the username, private key, and whether the public key is installed on the HPC.");
  }
  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    return new Error("The HPC host could not be resolved. Check the remote host and network connection.");
  }
  if (/ECONNREFUSED/i.test(message)) {
    return new Error("The HPC refused the SSH connection. Check the host and SSH port.");
  }
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(message)) {
    return new Error("The SSH connection timed out. Check VPN access, the HPC host, and the SSH port.");
  }
  if (/Host key verification failed/i.test(message)) {
    return new Error("The HPC host key does not match the saved fingerprint. Verify the host before replacing the fingerprint.");
  }
  return error instanceof Error ? error : new Error(message);
}

module.exports = {
  HpcLlmService,
  modelsPayload,
  testEndpoint,
  validateAccountFields,
};
