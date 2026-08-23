const assert = require("node:assert/strict");
const test = require("node:test");

const { GPU_QUEUES, RESOURCE_PRESETS, SESSION_RUNTIMES, recommendedConfigForModel } = require("../catalog.cjs");
const {
  RemoteClient,
  buildLlamaScript,
  formatDuration,
  modelAlias,
  parseDuration,
  parseModels,
  parsePartitionStatuses,
  progressParser,
} = require("../remote.cjs");

test("Qwen3.8 session script is generated entirely by Node with expected runtime controls", () => {
  const script = buildLlamaScript({
    workdir: "/gpfs/scratch/testuser/cheaha_llm_client",
    modelPath: "/home/testuser/cheaha_llm_client/gguf_models/Qwen3.8-27B-Q4_K_M.gguf",
    modelName: "qwen3.8:27b",
    queue: GPU_QUEUES.find((item) => item.name === "amperenodes-medium"),
    runtime: SESSION_RUNTIMES.find((item) => item.label === "20 hours"),
    resource: RESOURCE_PRESETS.find((item) => item.label === "Medium - 8 CPU / 64G"),
    remotePort: 8000,
    contextTokens: 65536,
  });

  assert.match(script, /#SBATCH --partition=amperenodes-medium/);
  assert.match(script, /#SBATCH --job-name=hpc-llm/);
  assert.match(script, /#SBATCH --time=20:00:00/);
  assert.match(script, /MODEL_NAME='qwen3\.8:27b'/);
  assert.match(script, /--ctx-size "65536"/);
  assert.match(script, /--n-gpu-layers 999/);
  assert.doesNotMatch(script, /python|cheaha_llm_client\.app/);
});

test("model discovery prefers persistent home and assembles complete split models", () => {
  const home = "/home/testuser/cheaha_llm_client/gguf_models";
  const scratch = "/gpfs/scratch/testuser/cheaha_llm_client/gguf_models";
  const lines = [
    `Qwen3.8-27B-Q4_K_M.gguf\t${scratch}/Qwen3.8-27B-Q4_K_M.gguf\t18973870432`,
    `Qwen3.8-27B-Q4_K_M.gguf\t${home}/Qwen3.8-27B-Q4_K_M.gguf\t18973870432`,
  ];
  const models = parseModels(lines.join("\n"), home, scratch);

  assert.equal(models.length, 1);
  assert.equal(models[0].location, "home");
  assert.equal(models[0].default_context, 65536);
});

test("Slurm durations and model aliases match the desktop behavior", () => {
  assert.equal(parseDuration("2-00:00:00"), 172800);
  assert.equal(formatDuration(3661), "1h 1m");
  assert.equal(modelAlias("/models/Qwen3.8-27B-Q4_K_M.gguf"), "qwen3.8:27b");
});

test("partition catalog preserves documented limits without calling them live availability", () => {
  const ampere = GPU_QUEUES.find((item) => item.name === "amperenodes");
  assert.equal(ampere.documented_nodes, 20);
  assert.equal(ampere.max_nodes_per_researcher, 2);
  assert.equal(ampere.priority_tier, 16);
  assert.equal(ampere.max_runtime, "12 hours");
  assert.equal("available_now" in ampere, false);

  assert.deepEqual(recommendedConfigForModel("/models/Qwen3.8-27B-Q4_K_M.gguf"), {
    queue: "amperenodes",
    runtime: "2 hours",
    resource: "Medium - 8 CPU / 64G",
    context_tokens: 65536,
  });
});

test("live Slurm partition rows aggregate idle, mixed, and unavailable nodes", () => {
  const statuses = parsePartitionStatuses(
    [
      "amperenodes|up|2|drain*|12:00:00|gpu:ampere:2",
      "amperenodes|up|14|mix|12:00:00|gpu:ampere:2",
      "amperenodes|up|3|idle|12:00:00|gpu:ampere:2",
    ].join("\n"),
    "PartitionName=amperenodes State=UP MaxNodes=UNLIMITED MaxTime=12:00:00 PriorityTier=16 TotalNodes=20 QoS=ampere",
  );

  assert.equal(statuses[0].total_nodes, 20);
  assert.equal(statuses[0].idle_nodes, 3);
  assert.equal(statuses[0].mixed_nodes, 14);
  assert.equal(statuses[0].unavailable_nodes, 2);
  assert.equal(statuses[0].priority_tier, 16);
});

test("Slurm preflight checks the exact script without submitting a job", async () => {
  const client = new RemoteClient({ remote_workdir: "/runtime" });
  let command = "";
  client.exec = async (value) => {
    command = value;
    return { ok: true, exit_status: 0, stdout: "sbatch: Job 123 to start at 2026-08-23T11:17:31 using 8 processors on nodes c0243 in partition amperenodes\n", stderr: "" };
  };
  const values = llamaValues();

  const result = await client.preflightLlamaSession(values);

  assert.equal(result.accepted, true);
  assert.match(result.message, /No job was submitted/);
  assert.match(result.message, /Estimated start/);
  assert.doesNotMatch(result.message, /Job 123/);
  assert.match(command, /sbatch --test-only/);
  assert.match(command, /llama-server-cuda/);
  assert.equal((command.match(/(?:^|\n)sbatch /g) || []).length, 1);
});

test("impossible Slurm resources return recommended-default guidance", async () => {
  const client = new RemoteClient({ remote_workdir: "/runtime" });
  client.exec = async () => ({
    ok: false,
    exit_status: 1,
    stdout: "allocation failure: Requested node configuration is not available\n",
    stderr: "",
  });

  await assert.rejects(
    client.preflightLlamaSession(llamaValues()),
    /Use the recommended defaults or choose fewer CPUs and memory/,
  );
});

test("real submission is preceded by a non-submitting scheduler preflight", async () => {
  const client = new RemoteClient({ remote_workdir: "/runtime" });
  const commands = [];
  client.exec = async (command) => {
    commands.push(command);
    return commands.length === 1
      ? { ok: true, exit_status: 0, stdout: "sbatch: Job 123 to start on c0243\n", stderr: "" }
      : { ok: true, exit_status: 0, stdout: "Submitted batch job 40000001\n", stderr: "" };
  };

  const jobId = await client.startLlamaSession(llamaValues());

  assert.equal(jobId, "40000001");
  assert.match(commands[0], /sbatch --test-only/);
  assert.match(commands[1], /^sbatch /);
  assert.doesNotMatch(commands[1], /--test-only/);
});

test("remote Bash control structures are emitted without invalid keyword separators", async () => {
  const client = new RemoteClient({
    username: "testuser",
    remote_workdir: "/gpfs/scratch/testuser/cheaha_llm_client",
  });
  const commands = [];
  client.exec = async (command) => {
    commands.push(command);
    return { ok: true, exit_status: 0, stdout: "", stderr: "" };
  };

  await client.listModels();
  await client.installStatuses();

  assert.equal(commands.some((command) => /\b(do|then|else);/.test(command)), false);
});

test("remote paths are discovered from the HPC home instead of assuming /home", async () => {
  const client = new RemoteClient({
    username: "alice",
    remote_workdir: "~/.cheaha-llm/runtime",
  });
  const commands = [];
  client.exec = async (command) => {
    commands.push(command);
    return commands.length === 1
      ? { ok: true, exit_status: 0, stdout: "/users/alice\n", stderr: "" }
      : { ok: true, exit_status: 0, stdout: "", stderr: "" };
  };

  const paths = await client.preparePaths();
  await client.listModels();

  assert.equal(paths.remote_workdir, "/users/alice/.cheaha-llm/runtime");
  assert.equal(paths.models_directory, "/users/alice/cheaha_llm_client/gguf_models");
  assert.match(commands[1], /\/users\/alice\/cheaha_llm_client\/gguf_models/);
});

test("starter models have visible installation status", async () => {
  const client = new RemoteClient({ username: "alice", remote_workdir: "/runtime" });
  client.modelsDir = "/users/alice/cheaha_llm_client/gguf_models";
  client.exec = async (command) => ({
    ok: true,
    exit_status: 0,
    stdout: command.includes("Qwen2.5-Coder")
      ? "starter\tready: Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf\nstarter\tready: Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf\n"
      : "",
    stderr: "",
  });

  const statuses = await client.installStatuses();
  assert.equal(statuses.starter, "Starter models: ready.");
});

test("download progress markers are parsed across SSH chunks", () => {
  const updates = [];
  const parse = progressParser((update) => updates.push(update));
  parse("__HPC_LLM_PROGRESS__\t10\t90\tDown", "stdout");
  parse("loading model\n", "stdout");
  parse("############ 50.0%", "stderr");
  parse("__HPC_LLM_PROGRESS__\t100\tVerified\n", "stdout");

  assert.deepEqual(updates, [
    { progress: 10, message: "Downloading model" },
    { progress: 50, message: "Downloading model" },
    { progress: 100, message: "Verified" },
  ]);
});

test("model download command preflights home storage and remains resumable", async () => {
  const client = new RemoteClient({ username: "alice", remote_workdir: "/runtime" });
  client.modelsDir = "/users/alice/cheaha_llm_client/gguf_models";
  let command = "";
  client.exec = async (value) => {
    command = value;
    return { ok: true, exit_status: 0, stdout: "", stderr: "" };
  };

  await client.downloadModels("starter");

  assert.match(command, /command -v curl/);
  assert.match(command, /df -Pk/);
  assert.match(command, /continue-at/);
  assert.match(command, /retry 4/);
  assert.match(command, /\.part/);
  assert.match(command, /986048032/);
});

function llamaValues() {
  return {
    modelPath: "/home/testuser/cheaha_llm_client/gguf_models/Qwen3.8-27B-Q4_K_M.gguf",
    queue: GPU_QUEUES.find((item) => item.name === "amperenodes"),
    runtime: SESSION_RUNTIMES.find((item) => item.label === "2 hours"),
    resource: RESOURCE_PRESETS.find((item) => item.label === "Medium - 8 CPU / 64G"),
    remotePort: 8000,
    contextTokens: 65536,
  };
}
