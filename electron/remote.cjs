const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { Client } = require("ssh2");

const {
  MODEL_DOWNLOADS,
  SPLIT_GROUPS,
  contextOptionsForModel,
  defaultContextForModel,
  recommendedConfigForModel,
} = require("./catalog.cjs");

class RemoteClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.remoteHome = null;
    this.modelsDir = null;
  }

  connect({ password = null } = {}) {
    if (this.client) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const client = new Client();
      const options = {
        host: this.config.remote_host,
        port: this.config.ssh_port || 22,
        username: this.config.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => verifyHostKey(key, this.config.known_host_fingerprint),
      };
      if (password) {
        options.password = password;
      } else {
        options.privateKey = fs.readFileSync(expandHome(this.config.private_key_path));
      }
      client.once("ready", () => {
        this.client = client;
        resolve();
      });
      client.once("error", reject);
      client.connect(options);
    });
  }

  exec(command, { onOutput = null } = {}) {
    if (!this.client) return Promise.reject(new Error("SSH connection is not open."));
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          stdout += chunk;
          onOutput?.(chunk, "stdout");
        });
        stream.stderr.setEncoding("utf8");
        stream.stderr.on("data", (chunk) => {
          stderr += chunk;
          onOutput?.(chunk, "stderr");
        });
        stream.once("error", reject);
        stream.once("close", (code, signal) => {
          resolve({
            command,
            exit_status: Number(code ?? (signal ? 1 : 0)),
            stdout,
            stderr,
            ok: code === 0,
          });
        });
      });
    });
  }

  close() {
    if (this.client) this.client.end();
    this.client = null;
  }

  async preparePaths() {
    if (this.remoteHome && this.modelsDir) return this.pathInfo();
    const result = await this.exec("printf '%s\\n' \"$HOME\"");
    requireSuccess(result, "Unable to discover the remote home directory.");
    const remoteHome = result.stdout.trim();
    if (!/^\/[^\0\r\n]+$/.test(remoteHome)) {
      throw new Error("The HPC returned an invalid home directory.");
    }
    const configured = String(this.config.remote_workdir || "~/.hpc-llm/runtime").trim();
    const workdir = configured === "~"
      ? remoteHome
      : configured.startsWith("~/")
        ? path.posix.join(remoteHome, configured.slice(2))
        : configured;
    if (!/^\/[^\0\r\n]*$/.test(workdir)) {
      throw new Error("Remote work directory must be an absolute path or start with ~/.");
    }
    this.remoteHome = remoteHome;
    this.modelsDir = path.posix.join(remoteHome, "cheaha_llm_client", "gguf_models");
    this.config.remote_workdir = workdir;
    return this.pathInfo();
  }

  pathInfo() {
    return {
      remote_home: this.remoteHome,
      remote_workdir: this.config.remote_workdir,
      models_directory: this.modelsDir,
    };
  }

  async testConnection() {
    const result = await this.exec("hostname && whoami");
    requireSuccess(result, "SSH key login failed.");
    const [hostname, username] = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return {
      connected: true,
      hostname: hostname || this.config.remote_host,
      username: username || this.config.username,
      ...this.pathInfo(),
      message: `SSH key login succeeded. Models will be stored in ${this.modelsDir}.`,
    };
  }

  async deployPublicKey(publicKeyPath) {
    const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
    const command = [
      "mkdir -p ~/.ssh",
      "chmod 700 ~/.ssh",
      `grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`,
      "chmod 600 ~/.ssh/authorized_keys",
    ].join(" && ");
    const result = await this.exec(command);
    requireSuccess(result, "Unable to deploy the SSH public key.");
    return result;
  }

  async createRemoteFolder() {
    const result = await this.exec(
      `mkdir -p ${shellQuote(this.config.remote_workdir)} ${shellQuote(this.modelsDir)}`,
    );
    requireSuccess(result, "Unable to create the remote work directory.");
    return result;
  }

  async deployHuggingFaceToken(token) {
    const remotePath = `${this.config.remote_workdir.replace(/\/$/, "")}/secrets/hf_token`;
    const encoded = Buffer.from(`${token.trim()}\n`, "utf8").toString("base64");
    const command = [
      `mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`,
      `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(remotePath)}`,
      `chmod 600 ${shellQuote(remotePath)}`,
    ].join(" && ");
    const result = await this.exec(command);
    requireSuccess(result, "Unable to deploy the Hugging Face token.");
    return result;
  }

  async installLlamaServer(script) {
    const installerPath = `${this.config.remote_workdir.replace(/\/$/, "")}/electron/install_llama_server.sh`;
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const command = [
      `mkdir -p ${shellQuote(path.posix.dirname(installerPath))}`,
      `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(installerPath)}`,
      `chmod 700 ${shellQuote(installerPath)}`,
      `APP_DIR=${shellQuote(this.config.remote_workdir)} bash ${shellQuote(installerPath)}`,
    ].join(" && ");
    const result = await this.exec(command);
    requireSuccess(result, "Unable to install llama-server on the HPC.");
    return result;
  }

  async verifyLlamaServer() {
    const binary = `${this.config.remote_workdir.replace(/\/$/, "")}/bin/llama-server-cpu`;
    const script = [
      "module purge >/dev/null 2>&1 || true",
      "module load shared rc-base >/dev/null 2>&1 || true",
      "module load CMake/3.27.6-GCCcore-13.2.0 >/dev/null 2>&1 || true",
      `export LD_LIBRARY_PATH=${shellQuote(`${this.config.remote_workdir}/bin`)}:\${LD_LIBRARY_PATH:-}`,
      `${shellQuote(binary)} --version`,
    ].join("; ");
    const result = await this.exec(`bash -lc ${shellQuote(script)}`);
    requireSuccess(result, "llama-server verification failed.");
    return result.stdout.trim() || "llama-server is installed.";
  }

  async listModels() {
    const homeDir = this.modelsDir || homeModelsDirectory(this.config);
    const scratchDir = `${this.config.remote_workdir.replace(/\/$/, "")}/gguf_models`;
    const script = [
      "for dir in \"$@\"; do",
      "mkdir -p \"$dir\" 2>/dev/null || true",
      "find \"$dir\" -maxdepth 1 -type f -name '*.gguf' -printf '%f\\t%p\\t%s\\n' 2>/dev/null || true",
      "done",
    ].join("\n");
    const result = await this.exec(`bash -lc ${shellQuote(script)} -- ${shellQuote(homeDir)} ${shellQuote(scratchDir)}`);
    requireSuccess(result, "Unable to list GGUF models.");
    return parseModels(result.stdout, homeDir, scratchDir);
  }

  async installStatuses() {
    const homeDir = this.modelsDir || homeModelsDirectory(this.config);
    const scripts = [];
    const groupedLines = {};
    for (const [group, downloads] of Object.entries(MODEL_DOWNLOADS)) {
      groupedLines[group] = [];
      for (const item of downloads) {
        const expected = item.expected_size_bytes || 0;
        const script = [
          `status=${shellQuote(`missing: ${item.filename}`)}`,
          `for dir in ${shellQuote(homeDir)}; do`,
          `target=\"$dir/${item.filename}\"`,
          `partial=\"$target.part\"`,
          "if [ -f \"$target\" ]; then",
          "actual=$(stat -c %s \"$target\" 2>/dev/null || echo 0)",
          expected
            ? `if [ \"$actual\" = \"${expected}\" ]; then status=${shellQuote(`ready: ${item.filename}`)}; else status=\"invalid: ${item.filename} expected ${expected} found $actual\"; fi`
            : `status=${shellQuote(`ready: ${item.filename}`)}`,
          "break",
          "elif [ -f \"$partial\" ]; then",
          "actual=$(stat -c %s \"$partial\" 2>/dev/null || echo 0)",
          expected ? `percent=$(( actual * 100 / ${expected} ))` : "percent=0",
          `status=\"downloading: ${item.filename} $percent%\"`,
          "break",
          "fi",
          "done",
          `printf '%s\\t%s\\n' ${shellQuote(group)} \"$status\"`,
        ].join("\n");
        scripts.push(script);
      }
    }
    const result = await this.exec(`bash -lc ${shellQuote(scripts.join("\n"))}`);
    requireSuccess(result, "Unable to check model installation status.");
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const [group, status] = line.split("\t", 2);
      if (groupedLines[group] && status) groupedLines[group].push(status);
    }
    const statuses = {};
    for (const [group, lines] of Object.entries(groupedLines)) {
      const label = groupLabel(group);
      statuses[group] = lines.length && lines.every((line) => line.startsWith("ready:"))
        ? `${label}: ready.`
        : `${label} incomplete: ${lines.join(" | ")}`;
    }
    return statuses;
  }

  async downloadModels(group, onProgress = null) {
    const downloads = MODEL_DOWNLOADS[group];
    if (!downloads) throw new Error("Unknown model download group.");
    const homeDir = this.modelsDir || homeModelsDirectory(this.config);
    const commands = [
      "command -v curl >/dev/null 2>&1 || { echo 'curl is required on the HPC login node.' >&2; exit 10; }",
      `mkdir -p ${shellQuote(homeDir)}`,
      `test -w ${shellQuote(homeDir)} || { echo ${shellQuote(`Model directory is not writable: ${homeDir}`)} >&2; exit 11; }`,
      "required=0",
      ...downloads.filter((item) => item.expected_size_bytes).map((item) => {
        const target = `${homeDir}/${item.filename}`;
        return `actual=$(stat -c %s ${shellQuote(target)} 2>/dev/null || echo 0); [ \"$actual\" = \"${item.expected_size_bytes}\" ] || required=$(( required + ${item.expected_size_bytes} ))`;
      }),
      `available=$(df -Pk ${shellQuote(homeDir)} | awk 'NR==2 {print $4 * 1024}')`,
      "[ -n \"$available\" ] || { echo 'Unable to determine available home storage.' >&2; exit 12; }",
      "[ \"$required\" -eq 0 ] || [ \"$available\" -ge \"$required\" ] || { echo \"Not enough persistent home storage. Need $required bytes but only $available bytes are available.\" >&2; exit 13; }",
      `printf '__HPC_LLM_PROGRESS__\\t5\\t%s\\n' ${shellQuote(`Home storage ready: ${homeDir}`)}`,
    ];
    downloads.forEach((item, index) => {
      const target = `${homeDir}/${item.filename}`;
      const expected = item.expected_size_bytes ? String(item.expected_size_bytes) : "";
      const startingProgress = 10 + Math.floor((index / downloads.length) * 80);
      const completedProgress = 10 + Math.floor(((index + 1) / downloads.length) * 80);
      commands.push([
        `target=${shellQuote(target)}`,
        "partial=\"$target.part\"",
        `expected=${shellQuote(expected)}`,
        "actual=$(stat -c %s \"$target\" 2>/dev/null || echo 0)",
        "if [ -n \"$expected\" ] && [ \"$actual\" != 0 ] && [ \"$actual\" != \"$expected\" ]; then rm -f \"$target\" \"$partial\"; fi",
        "if [ ! -s \"$target\" ]; then",
        `printf '__HPC_LLM_PROGRESS__\\t${startingProgress}\\t${completedProgress}\\t%s\\n' ${shellQuote(`Downloading ${item.label}`)}`,
        `curl -L --fail --progress-bar --show-error --retry 4 --retry-delay 3 --connect-timeout 30 --continue-at - -o \"$partial\" ${shellQuote(item.url)}`,
        "mv \"$partial\" \"$target\"",
        `else printf '__HPC_LLM_PROGRESS__\\t${startingProgress}\\t%s\\n' ${shellQuote(`${item.label} is already installed`)}` + "; fi",
        "actual=$(stat -c %s \"$target\" 2>/dev/null || echo 0)",
        "if [ -n \"$expected\" ] && [ \"$actual\" != \"$expected\" ]; then echo \"Downloaded file size mismatch: $target\" >&2; exit 4; fi",
        `printf '__HPC_LLM_PROGRESS__\\t${completedProgress}\\t%s\\n' ${shellQuote(`${item.label} verified`)}`,
      ].join("\n"));
    });
    commands.push(`printf '__HPC_LLM_PROGRESS__\\t100\\t%s\\n' ${shellQuote(`${groupLabel(group)} installed`)}`);
    const parseProgress = progressParser(onProgress);
    const result = await this.exec(
      `bash -lc ${shellQuote(`set -euo pipefail\n${commands.join("\n")}`)}`,
      { onOutput: parseProgress },
    );
    requireSuccess(result, `${groupLabel(group)} download failed.`);
    return result;
  }

  async listSessions() {
    const username = shellQuote(this.config.username);
    const result = await this.exec(`squeue -h -u ${username} -o '%i|%P|%j|%T|%M|%l|%D|%R'`);
    requireSuccess(result, "Unable to list Slurm sessions.");
    const jobs = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseQueueLine)
      .filter((job) => /^(hpc-llm|cheaha-vllm|cheaha-llama|cheaha-ollama)/.test(job.name));
    return Promise.all(jobs.map((job) => this.sessionDetails(job)));
  }

  async partitionStatuses() {
    const [sinfoResult, controlResult] = await Promise.all([
      this.exec("sinfo -h -o '%P|%a|%D|%t|%l|%G'"),
      this.exec("scontrol show partition -o"),
    ]);
    requireSuccess(sinfoResult, "Unable to read live Slurm partition status.");
    requireSuccess(controlResult, "Unable to read Slurm partition limits.");
    return {
      items: parsePartitionStatuses(sinfoResult.stdout, controlResult.stdout),
      checked_at: new Date().toISOString(),
    };
  }

  async sessionDetails(jobOrId) {
    const jobId = validateJobId(typeof jobOrId === "string" ? jobOrId : jobOrId.job_id);
    let job = typeof jobOrId === "string" ? null : { ...jobOrId };
    if (!job) {
      const queueResult = await this.exec(`squeue -h -j ${jobId} -o '%i|%P|%j|%T|%M|%l|%D|%R'`);
      requireSuccess(queueResult, `Unable to inspect Slurm job ${jobId}.`);
      const line = queueResult.stdout.trim();
      if (!line) return null;
      job = parseQueueLine(line);
    }
    const [controlResult, metadataResult] = await Promise.all([
      this.exec(`scontrol show job ${jobId}`),
      this.exec(`cat ${shellQuote(`${this.config.remote_workdir}/sessions/${jobId}.env`)} 2>/dev/null || true`),
    ]);
    requireSuccess(controlResult, `Unable to inspect Slurm job ${jobId}.`);
    const fields = parseControlFields(controlResult.stdout);
    job.scheduled_node = fields.SchedNodeList || null;
    job.projected_start_time = fields.StartTime || null;
    job.metadata = parseMetadata(metadataResult.stdout);
    job.assigned_node = job.reason_or_nodelist && !job.reason_or_nodelist.startsWith("(")
      ? job.reason_or_nodelist
      : null;
    job.remaining = remainingTime(job.elapsed, job.time_limit)
      || job.projected_start_time
      || job.reason_or_nodelist
      || "";
    return job;
  }

  async preflightLlamaSession(values) {
    const artifacts = llamaSessionArtifacts(this.config, values);
    const result = await this.exec(`${artifacts.prepareCommand}\nsbatch --test-only ${shellQuote(artifacts.scriptPath)}`);
    if (!result.ok) throw slurmPreflightError(result, artifacts);
    const schedulerMessage = formatPreflightEstimate(result.stdout || result.stderr);
    return {
      accepted: true,
      message: `Slurm accepted ${artifacts.resource.label} on ${artifacts.queue.name}. No job was submitted.${schedulerMessage ? ` ${schedulerMessage}` : ""}`,
      scheduler_message: schedulerMessage,
    };
  }

  async startLlamaSession(values) {
    const artifacts = llamaSessionArtifacts(this.config, values);
    await this.preflightLlamaSession(values);
    const result = await this.exec(`sbatch ${shellQuote(artifacts.scriptPath)}`);
    requireSuccess(result, "Unable to submit the llama-server session.");
    const match = result.stdout.match(/Submitted batch job (\d+)/);
    if (!match) throw new Error(`Unable to parse sbatch output: ${result.stdout.trim()}`);
    return match[1];
  }

  async cancelSession(jobId) {
    const result = await this.exec(`scancel ${validateJobId(jobId)}`);
    requireSuccess(result, `Unable to cancel Slurm job ${jobId}.`);
    return result;
  }
}

class TunnelController {
  constructor() {
    this.process = null;
    this.jobId = null;
  }

  get isRunning() {
    return Boolean(this.process && this.process.exitCode === null && !this.process.killed);
  }

  async start(config, job) {
    if (this.isRunning) await this.stop();
    if (!(await isPortAvailable(config.local_port))) {
      throw new Error(`Local port ${config.local_port} is already in use. Stop the existing tunnel first.`);
    }
    const node = job.assigned_node;
    if (!node) throw new Error(`Slurm job ${job.job_id} does not have an assigned compute node.`);
    const keyPath = expandHome(config.private_key_path);
    const remotePort = Number(job.metadata.REMOTE_PORT || config.remote_port);
    const proxyCommand = `ssh -p ${Number(config.ssh_port || 22)} -i ${localCommandQuote(keyPath)} -W %h:%p ${config.username}@${config.remote_host}`;
    const computeKnownHosts = path.join(os.tmpdir(), "hpc_llm_compute_known_hosts");
    const args = [
      "-N",
      "-L", `127.0.0.1:${config.local_port}:127.0.0.1:${remotePort}`,
      "-o", `ProxyCommand=${proxyCommand}`,
      "-o", "StrictHostKeyChecking=no",
      "-o", `UserKnownHostsFile=${computeKnownHosts}`,
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-i", keyPath,
      `${config.username}@${node}`,
    ];
    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 900);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`SSH tunnel failed to start (${code}). ${stderr.trim()}`));
      });
    });
    this.process = child;
    this.jobId = job.job_id;
    child.once("exit", () => {
      if (this.process === child) {
        this.process = null;
        this.jobId = null;
      }
    });
    return { node, remotePort };
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.jobId = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stopExisting(port) {
    if (this.isRunning) {
      await this.stop();
      return;
    }
    let pids = "";
    try {
      pids = execFileSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    } catch {
      return;
    }
    for (const pid of pids.split(/\s+/).filter(Boolean)) {
      try {
        const command = execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).trim();
        if (command.endsWith("ssh")) process.kill(Number(pid), "SIGTERM");
      } catch {
        // The process may have already exited.
      }
    }
  }
}

function generateKeyPair(privateKeyPath) {
  const resolved = expandHome(privateKeyPath);
  const publicKeyPath = `${resolved}.pub`;
  if (fs.existsSync(resolved) && fs.existsSync(publicKeyPath)) {
    return { privateKeyPath: resolved, publicKeyPath };
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const result = spawnAndCapture("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", resolved]);
  if (result.code !== 0) throw new Error(result.stderr || "Unable to create the SSH key.");
  fs.chmodSync(resolved, 0o600);
  return { privateKeyPath: resolved, publicKeyPath };
}

function fetchHostFingerprint(hostname, port = 22) {
  const scan = spawnAndCapture("ssh-keyscan", ["-p", String(port), "-T", "10", "-t", "ed25519", hostname]);
  if (scan.code !== 0 && !scan.stdout.trim()) throw new Error(scan.stderr || "Unable to fetch the host key.");
  const line = scan.stdout.split(/\r?\n/).find((value) => value && !value.startsWith("#"));
  if (!line) throw new Error("The remote host did not return an SSH host key.");
  const [, algorithm, encoded] = line.trim().split(/\s+/);
  const key = Buffer.from(encoded, "base64");
  const sha256 = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  const md5 = crypto.createHash("md5").update(key).digest("hex").match(/.{2}/g).join(":");
  return { algorithm, sha256, md5 };
}

function parseModels(output, homeDir, scratchDir) {
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    const [filename, remotePath, rawSize] = line.split("\t");
    if (!filename || !remotePath || !/^\d+$/.test(rawSize || "")) continue;
    entries.push({ filename, path: remotePath, sizeBytes: Number(rawSize) });
  }
  const fileSizes = new Map(entries.map((entry) => [entry.filename, entry.sizeBytes]));
  const preferred = new Map();
  for (const entry of entries) {
    if (!preferred.has(entry.filename) || entry.path.startsWith(`${homeDir}/`)) {
      preferred.set(entry.filename, entry);
    }
  }
  const models = [];
  for (const entry of preferred.values()) {
    if (/-of-/.test(entry.filename) && !/-00001-of-/.test(entry.filename)) continue;
    const group = SPLIT_GROUPS[entry.filename];
    if (group && !group.every((part) => {
      const size = fileSizes.get(part.filename);
      return Number.isFinite(size) && (!part.expected_size_bytes || size === part.expected_size_bytes);
    })) continue;
    let totalSize = entry.sizeBytes;
    let labelName = entry.filename;
    if (group) {
      totalSize = group.reduce((sum, part) => sum + fileSizes.get(part.filename), 0);
      labelName = entry.filename.replace(/-00001-of-\d+\.gguf$/, " split GGUF");
    }
    const location = entry.path.startsWith(`${homeDir}/`)
      ? "home"
      : entry.path.startsWith(`${scratchDir}/`)
        ? "scratch"
        : "other";
    models.push({
      label: `${labelName} (${humanSize(totalSize)})`,
      path: entry.path,
      size: humanSize(totalSize),
      location,
      context_options: contextOptionsForModel(entry.path),
      default_context: defaultContextForModel(entry.path),
      recommended_config: recommendedConfigForModel(entry.path),
    });
  }
  return models.sort((a, b) => a.label.localeCompare(b.label));
}

function buildLlamaScript({ workdir, modelPath, modelName, queue, runtime, resource, remotePort, contextTokens }) {
  const gres = queue.gpu_type ? `#SBATCH --gres=gpu:${queue.gpu_type}:1` : "";
  const gpuLayers = queue.gpu_type ? "--n-gpu-layers 999" : "--n-gpu-layers 0";
  const binary = queue.gpu_type ? "llama-server-cuda" : "llama-server-cpu";
  return `#!/usr/bin/env bash
#SBATCH --job-name=hpc-llm
#SBATCH --partition=${queue.name}
${gres}
#SBATCH --cpus-per-task=${resource.cpus}
#SBATCH --mem=${resource.mem}
#SBATCH --time=${runtime.slurm_time}
#SBATCH --output=${workdir}/logs/llama-%j.out
#SBATCH --error=${workdir}/logs/llama-%j.err

set -euo pipefail

APP_DIR=${shellQuote(workdir)}
MODEL_PATH=${shellQuote(modelPath)}
MODEL_NAME=${shellQuote(modelName)}
REQUESTED_PORT=${Number(remotePort)}

module purge || true
module load shared rc-base || true
module load CMake/3.27.6-GCCcore-13.2.0 || true
module load CUDA/12.1.1 || true
mkdir -p "$APP_DIR/logs" "$APP_DIR/sessions"
export LD_LIBRARY_PATH="/share/apps/rc/software/GCCcore/14.2.0/lib64:$APP_DIR/bin:\${LD_LIBRARY_PATH:-}"
if [[ ! -x "$APP_DIR/bin/${binary}" ]]; then
  echo "Missing $APP_DIR/bin/${binary}. Install llama-server on the HPC first." >&2
  exit 2
fi
if [[ ! -f "$MODEL_PATH" ]]; then
  echo "Missing GGUF model file: $MODEL_PATH" >&2
  exit 3
fi

PORT=""
for candidate in $(seq "$REQUESTED_PORT" "$((REQUESTED_PORT + 99))"); do
  if ! (echo > "/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
    PORT="$candidate"
    break
  fi
done
if [[ -z "$PORT" ]]; then
  echo "No free localhost port found from $REQUESTED_PORT to $((REQUESTED_PORT + 99))" >&2
  exit 4
fi

cat > "$APP_DIR/sessions/$SLURM_JOB_ID.env" <<META
JOB_ID=$SLURM_JOB_ID
BACKEND=llama-server
MODEL_ID=$MODEL_NAME
MODEL_LABEL=$MODEL_NAME
GGUF_MODEL_PATH=$MODEL_PATH
PARTITION=${queue.name}
SESSION_RUNTIME=${runtime.label}
REMOTE_PORT=$PORT
CONTEXT_TOKENS=${Number(contextTokens)}
PARALLEL_SLOTS=1
META

"$APP_DIR/bin/${binary}" \\
  --host 127.0.0.1 \\
  --port "$PORT" \\
  --model "$MODEL_PATH" \\
  --alias "$MODEL_NAME" \\
  --ctx-size "${Number(contextTokens)}" \\
  --parallel 1 \\
  --threads "${resource.cpus}" \\
  ${gpuLayers}
`;
}

function llamaSessionArtifacts(config, { modelPath, queue, runtime, resource, remotePort, contextTokens }) {
  const modelName = modelAlias(modelPath);
  const safeName = modelName.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  const scriptPath = `${config.remote_workdir}/sessions/hpc-llm-${safeName}.sbatch`;
  const binary = queue.gpu_type ? "llama-server-cuda" : "llama-server-cpu";
  const script = buildLlamaScript({
    workdir: config.remote_workdir,
    modelPath,
    modelName,
    queue,
    runtime,
    resource,
    remotePort,
    contextTokens,
  });
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const prepareCommand = [
    "set -e",
    `mkdir -p ${shellQuote(`${config.remote_workdir}/sessions`)} ${shellQuote(`${config.remote_workdir}/logs`)}`,
    `if [ ! -s ${shellQuote(modelPath)} ]; then echo ${shellQuote(`Model file is missing or empty: ${modelPath}`)} >&2; exit 3; fi`,
    `if [ ! -x ${shellQuote(`${config.remote_workdir}/bin/${binary}`)} ]; then echo ${shellQuote(`Missing ${binary}. Verify or install llama-server before starting this partition.`)} >&2; exit 4; fi`,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(scriptPath)}`,
  ].join("\n");
  return { binary, modelName, modelPath, prepareCommand, queue, resource, scriptPath };
}

function formatPreflightEstimate(output) {
  const cleaned = String(output || "").trim().replace(/^sbatch:\s*/i, "");
  const match = cleaned.match(/^Job \d+ to start at (\S+) using (\d+) processors? on nodes? (.+?) in partition (\S+)$/i);
  if (!match) return cleaned.replace(/^Job \d+\s*/i, "");
  return `Estimated start ${match[1]} using ${match[2]} processors on ${match[3]}.`;
}

function slurmPreflightError(result, artifacts) {
  const raw = (result.stderr || result.stdout || "Slurm rejected the configuration.").trim();
  if (/Requested node configuration is not available/i.test(raw)) {
    return new Error(`Slurm cannot schedule ${artifacts.resource.label} on ${artifacts.queue.name}. Use the recommended defaults or choose fewer CPUs and memory.`);
  }
  if (/invalid partition|partition.*not found/i.test(raw)) {
    return new Error(`The ${artifacts.queue.name} partition is not available to this HPC account. Refresh partition status or choose another partition.`);
  }
  if (/time limit|invalid time/i.test(raw)) {
    return new Error(`The requested runtime is not allowed on ${artifacts.queue.name}. Restore that partition's defaults and retry.`);
  }
  return new Error(`Slurm rejected the ${artifacts.queue.name} configuration: ${raw}`);
}

function parsePartitionStatuses(sinfoOutput, controlOutput) {
  const partitions = new Map();
  for (const line of String(sinfoOutput || "").split(/\r?\n/)) {
    const [rawName, availability, rawNodes, rawState, timeLimit, gres] = line.split("|", 6);
    const name = String(rawName || "").replace(/\*$/, "");
    const nodes = Number(rawNodes);
    if (!name || !Number.isFinite(nodes)) continue;
    const state = String(rawState || "").replace(/[\*+~#]+$/, "").toLowerCase();
    const current = partitions.get(name) || {
      name,
      availability,
      total_nodes: 0,
      idle_nodes: 0,
      mixed_nodes: 0,
      allocated_nodes: 0,
      unavailable_nodes: 0,
      time_limit: timeLimit,
      gres: gres === "(null)" ? "" : gres,
    };
    current.total_nodes += nodes;
    if (state.startsWith("idle")) current.idle_nodes += nodes;
    else if (state.startsWith("mix")) current.mixed_nodes += nodes;
    else if (state.startsWith("alloc")) current.allocated_nodes += nodes;
    else current.unavailable_nodes += nodes;
    partitions.set(name, current);
  }
  for (const line of String(controlOutput || "").split(/\r?\n/)) {
    const fields = parseControlFields(line);
    const name = fields.PartitionName;
    if (!name) continue;
    const current = partitions.get(name) || { name, idle_nodes: 0, mixed_nodes: 0, allocated_nodes: 0, unavailable_nodes: 0 };
    current.availability = fields.State?.toLowerCase() || current.availability || "unknown";
    current.total_nodes = Number(fields.TotalNodes) || current.total_nodes || 0;
    current.max_nodes = fields.MaxNodes || null;
    current.time_limit = fields.MaxTime || current.time_limit || null;
    current.priority_tier = Number(fields.PriorityTier) || null;
    current.qos = fields.QoS === "(null)" ? "" : fields.QoS || "";
    partitions.set(name, current);
  }
  return [...partitions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseQueueLine(line) {
  const parts = line.split("|", 8);
  return {
    job_id: parts[0],
    partition: parts[1],
    name: parts[2],
    state: parts[3],
    elapsed: parts[4],
    time_limit: parts[5],
    nodes: parts[6],
    reason_or_nodelist: parts[7],
    metadata: {},
  };
}

function parseControlFields(output) {
  const fields = {};
  for (const token of output.replaceAll("\n", " ").split(/\s+/)) {
    const index = token.indexOf("=");
    if (index > 0) fields[token.slice(0, index)] = token.slice(index + 1);
  }
  return fields;
}

function parseMetadata(output) {
  const metadata = {};
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) metadata[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return metadata;
}

function remainingTime(elapsed, limit) {
  const elapsedSeconds = parseDuration(elapsed);
  const limitSeconds = parseDuration(limit);
  if (elapsedSeconds === null || limitSeconds === null) return null;
  return formatDuration(Math.max(0, limitSeconds - elapsedSeconds));
}

function parseDuration(value) {
  if (!value || value === "UNLIMITED" || value === "NOT_SET") return null;
  let days = 0;
  let rest = value;
  if (value.includes("-")) {
    const parts = value.split("-", 2);
    days = Number(parts[0]);
    rest = parts[1];
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${remaining}s`;
}

function modelAlias(modelPath) {
  const filename = path.posix.basename(modelPath) || "gguf-model";
  const lower = filename.toLowerCase();
  if (lower.includes("glm-5.2") || lower.includes("glm5.2")) return "glm-5.2-gguf:ud-iq1_m";
  if (filename.startsWith("gpt-oss-120b-")) return "gpt-oss:120b";
  if (filename.startsWith("Qwen3.6-35B-A3B-")) return "qwen3.6:35b-a3b-coding";
  if (filename.startsWith("Qwen3.8-27B-")) return "qwen3.8:27b";
  return filename;
}

function jobPayload(job) {
  const model = job.metadata.MODEL_LABEL || job.metadata.MODEL_ID || job.name || "HPC LLM";
  const backend = job.metadata.BACKEND || (["hpc-llm", "cheaha-llama"].includes(job.name) ? "llama-server" : "vLLM");
  return {
    job_id: job.job_id,
    backend,
    model,
    state: job.state || "",
    partition: job.partition || "",
    node: job.assigned_node || job.scheduled_node || job.reason_or_nodelist || "",
    remaining: job.remaining || "",
    context_tokens: Number(job.metadata.CONTEXT_TOKENS || 0) || null,
    metadata: job.metadata,
  };
}

function verifyHostKey(key, expected) {
  if (!expected) return true;
  const actual = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function validateJobId(value) {
  const jobId = String(value || "").trim();
  if (!/^\d+$/.test(jobId)) throw new Error("Slurm job ID must contain only digits.");
  return jobId;
}

function homeModelsDirectory(config) {
  return `/home/${config.username}/cheaha_llm_client/gguf_models`;
}

function progressParser(onProgress) {
  if (!onProgress) return null;
  let stdoutPending = "";
  let stderrPending = "";
  let currentRange = null;
  return (chunk, source) => {
    if (source === "stderr") {
      if (!currentRange) return;
      stderrPending += chunk;
      const matches = [...stderrPending.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)];
      if (!matches.length) {
        stderrPending = stderrPending.slice(-24);
        return;
      }
      const percentage = Math.min(100, Number(matches.at(-1)[1]));
      const progress = currentRange.start
        + Math.floor(((currentRange.end - currentRange.start) * percentage) / 100);
      onProgress({ progress, message: currentRange.message });
      const lastMatch = matches.at(-1);
      stderrPending = stderrPending.slice(lastMatch.index + lastMatch[0].length);
      return;
    }
    stdoutPending += chunk;
    const lines = stdoutPending.split(/\r?\n/);
    stdoutPending = lines.pop() || "";
    for (const line of lines) {
      const match = line.match(/^__(?:HPC_LLM|CHEAHA)_PROGRESS__\t(\d+)\t(?:(\d+)\t)?(.+)$/);
      if (!match) continue;
      const progress = Math.min(100, Number(match[1]));
      currentRange = match[2]
        ? { start: progress, end: Math.min(100, Number(match[2])), message: match[3] }
        : null;
      onProgress({ progress, message: match[3] });
    }
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function localCommandQuote(value) {
  const normalized = process.platform === "win32" ? String(value).replaceAll("\\", "/") : String(value);
  if (/^[A-Za-z0-9_./:@%+~-]+$/.test(normalized)) return normalized;
  if (process.platform === "win32") return `"${normalized.replaceAll('"', '\\"')}"`;
  return shellQuote(normalized);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function requireSuccess(result, fallback) {
  if (!result.ok) throw new Error((result.stderr || result.stdout || fallback).trim());
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

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

function listenerInfo(port) {
  try {
    return execFileSync("lsof", ["-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function spawnAndCapture(command, args) {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: Number(error.status || 1),
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || error.message,
    };
  }
}

module.exports = {
  RemoteClient,
  TunnelController,
  buildLlamaScript,
  fetchHostFingerprint,
  formatDuration,
  generateKeyPair,
  homeModelsDirectory,
  jobPayload,
  listenerInfo,
  modelAlias,
  parseDuration,
  parseModels,
  parsePartitionStatuses,
  progressParser,
  shellQuote,
  validateJobId,
};
