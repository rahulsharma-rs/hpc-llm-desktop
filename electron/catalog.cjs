const BACKENDS = [
  { label: "llama-server - GGUF models", value: "llama" },
];

const RESOURCE_PRESETS = [
  { label: "Small - 4 CPU / 32G", cpus: 4, mem: "32G" },
  { label: "Medium - 8 CPU / 64G", cpus: 8, mem: "64G" },
  { label: "Large - 16 CPU / 128G", cpus: 16, mem: "128G" },
  { label: "Large memory - 24 CPU / 256G", cpus: 24, mem: "256G" },
  { label: "GLM large memory - 32 CPU / 450G", cpus: 32, mem: "450G" },
  { label: "GLM extra large memory - 48 CPU / 500G", cpus: 48, mem: "500G" },
];

const GPU_QUEUES = [
  queue({ name: "interactive", nodes: 52, maxHours: 2, maxNodes: 1, priority: 20, maxRuntime: "2 hours", slurmTime: "02:00:00", category: "CPU", recommendedRuntime: "1 hour", recommendedResource: "Small - 4 CPU / 32G", usageNote: "Short CPU tests." }),
  queue({ name: "express", nodes: 52, maxHours: 2, maxNodes: null, priority: 20, maxRuntime: "2 hours", slurmTime: "02:00:00", category: "CPU", recommendedRuntime: "1 hour", recommendedResource: "Small - 4 CPU / 32G", usageNote: "Short CPU sessions." }),
  queue({ name: "short", nodes: 52, maxHours: 12, maxNodes: 44, priority: 16, maxRuntime: "12 hours", slurmTime: "12:00:00", category: "CPU", recommendedRuntime: "2 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "CPU sessions up to 12 hours." }),
  queue({ name: "medium", nodes: 52, maxHours: 50, maxNodes: 44, priority: 12, maxRuntime: "2 days, 2 hours", slurmTime: "2-02:00:00", category: "CPU", recommendedRuntime: "20 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Long CPU sessions." }),
  queue({ name: "long", nodes: 52, maxHours: 150, maxNodes: 5, priority: 8, maxRuntime: "6 days, 6 hours", slurmTime: "6-06:00:00", category: "CPU", recommendedRuntime: "20 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Extended CPU sessions." }),
  queue({ name: "intel-dcb", nodes: 21, maxHours: 150, maxNodes: 5, priority: 8, maxRuntime: "6 days, 6 hours", slurmTime: "6-06:00:00", category: "CPU", recommendedRuntime: "20 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Intel CPU sessions." }),
  queue({ name: "amd-hdr100", nodes: 33, maxHours: 150, maxNodes: 5, priority: 8, maxRuntime: "6 days, 6 hours", slurmTime: "6-06:00:00", category: "CPU", recommendedRuntime: "20 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "AMD CPU sessions." }),
  queue({ name: "amperenodes", nodes: 20, maxHours: 12, maxNodes: 2, priority: 16, maxRuntime: "12 hours", slurmTime: "12:00:00", category: "GPU", gpuType: "ampere", recommendedRuntime: "2 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Ampere GPU sessions." }),
  queue({ name: "amperenodes-medium", nodes: 10, maxHours: 48, maxNodes: 2, priority: 16, maxRuntime: "2 days", slurmTime: "2-00:00:00", category: "GPU", gpuType: "ampere", recommendedRuntime: "20 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Long Ampere GPU sessions." }),
  queue({ name: "pascalnodes", nodes: 18, maxHours: 12, maxNodes: null, priority: 16, maxRuntime: "12 hours", slurmTime: "12:00:00", category: "GPU", gpuType: "pascal", recommendedRuntime: "2 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Pascal GPU sessions." }),
  queue({ name: "pascalnodes-medium", nodes: 7, maxHours: 48, maxNodes: null, priority: 15, maxRuntime: "2 days", slurmTime: "2-00:00:00", category: "GPU", gpuType: "pascal", recommendedRuntime: "20 hours", recommendedResource: "Medium - 8 CPU / 64G", usageNote: "Long Pascal GPU sessions." }),
  queue({ name: "largemem", nodes: 14, maxHours: 50, maxNodes: 10, priority: 6, maxRuntime: "2 days, 2 hours", slurmTime: "2-02:00:00", category: "Large mem", recommendedRuntime: "20 hours", recommendedResource: "Large memory - 24 CPU / 256G", usageNote: "Large GGUF CPU sessions." }),
  queue({ name: "largemem-long", nodes: 5, maxHours: 150, maxNodes: 10, priority: 6, maxRuntime: "6 days, 6 hours", slurmTime: "6-06:00:00", category: "Large mem", recommendedRuntime: "20 hours", recommendedResource: "Large memory - 24 CPU / 256G", usageNote: "Extended large-memory sessions." }),
];

const SESSION_RUNTIMES = [
  { label: "1 hour", hours: 1, slurm_time: "01:00:00" },
  { label: "2 hours", hours: 2, slurm_time: "02:00:00" },
  { label: "5 hours", hours: 5, slurm_time: "05:00:00" },
  { label: "10 hours", hours: 10, slurm_time: "10:00:00" },
  { label: "12 hours", hours: 12, slurm_time: "12:00:00" },
  { label: "15 hours", hours: 15, slurm_time: "15:00:00" },
  { label: "20 hours", hours: 20, slurm_time: "20:00:00" },
];

const MODEL_DOWNLOADS = {
  starter: [
    download(
      "Qwen2.5 Coder 1.5B Instruct Q4_K_M",
      "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
      "https://huggingface.co/unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
      986048032,
    ),
    download(
      "Qwen3 Coder 30B A3B Instruct Q4_K_M",
      "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
      "https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
      18556689568,
    ),
  ],
  qwen36: [
    download(
      "Qwen3.6 35B A3B Coding UD-Q4_K_M",
      "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
      "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
      22134528992,
    ),
  ],
  qwen38: [
    download(
      "Qwen3.8 27B Q4_K_M",
      "Qwen3.8-27B-Q4_K_M.gguf",
      "https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf",
      18973870432,
    ),
  ],
  gpt_oss: [
    download(
      "GPT-OSS 120B Q4_K_M shard 1/2",
      "gpt-oss-120b-Q4_K_M-00001-of-00002.gguf",
      "https://huggingface.co/unsloth/gpt-oss-120b-GGUF/resolve/main/Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf",
      49630904192,
    ),
    download(
      "GPT-OSS 120B Q4_K_M shard 2/2",
      "gpt-oss-120b-Q4_K_M-00002-of-00002.gguf",
      "https://huggingface.co/unsloth/gpt-oss-120b-GGUF/resolve/main/Q4_K_M/gpt-oss-120b-Q4_K_M-00002-of-00002.gguf",
      13137819360,
    ),
  ],
  glm52: [
    download("GLM-5.2 UD-IQ1_M shard 1/6", "GLM-5.2-UD-IQ1_M-00001-of-00006.gguf", "https://huggingface.co/unsloth/GLM-5.2-GGUF/resolve/main/UD-IQ1_M/GLM-5.2-UD-IQ1_M-00001-of-00006.gguf", 9423744),
    download("GLM-5.2 UD-IQ1_M shard 2/6", "GLM-5.2-UD-IQ1_M-00002-of-00006.gguf", "https://huggingface.co/unsloth/GLM-5.2-GGUF/resolve/main/UD-IQ1_M/GLM-5.2-UD-IQ1_M-00002-of-00006.gguf", 49257241920),
    download("GLM-5.2 UD-IQ1_M shard 3/6", "GLM-5.2-UD-IQ1_M-00003-of-00006.gguf", "https://huggingface.co/unsloth/GLM-5.2-GGUF/resolve/main/UD-IQ1_M/GLM-5.2-UD-IQ1_M-00003-of-00006.gguf", 48943068032),
    download("GLM-5.2 UD-IQ1_M shard 4/6", "GLM-5.2-UD-IQ1_M-00004-of-00006.gguf", "https://huggingface.co/unsloth/GLM-5.2-GGUF/resolve/main/UD-IQ1_M/GLM-5.2-UD-IQ1_M-00004-of-00006.gguf", 48891518400),
    download("GLM-5.2 UD-IQ1_M shard 5/6", "GLM-5.2-UD-IQ1_M-00005-of-00006.gguf", "https://huggingface.co/unsloth/GLM-5.2-GGUF/resolve/main/UD-IQ1_M/GLM-5.2-UD-IQ1_M-00005-of-00006.gguf", 49934857248),
    download("GLM-5.2 UD-IQ1_M shard 6/6", "GLM-5.2-UD-IQ1_M-00006-of-00006.gguf", "https://huggingface.co/unsloth/GLM-5.2-GGUF/resolve/main/UD-IQ1_M/GLM-5.2-UD-IQ1_M-00006-of-00006.gguf", 31456857280),
  ],
};

const SPLIT_GROUPS = {
  "gpt-oss-120b-Q4_K_M-00001-of-00002.gguf": MODEL_DOWNLOADS.gpt_oss,
  "GLM-5.2-UD-IQ1_M-00001-of-00006.gguf": MODEL_DOWNLOADS.glm52,
};

function queue({ name, nodes, maxHours, maxNodes, priority, maxRuntime, gpuType = "", slurmTime, category, recommendedRuntime, recommendedResource, usageNote }) {
  return {
    name,
    documented_nodes: nodes,
    max_hours: maxHours,
    max_runtime: maxRuntime,
    max_nodes_per_researcher: maxNodes,
    priority_tier: priority,
    gpu_type: gpuType,
    slurm_time: slurmTime,
    category,
    recommended_runtime: recommendedRuntime,
    recommended_resource: recommendedResource,
    usage_note: usageNote,
    llama_supported: true,
    display_label: `${name} - ${category}`,
  };
}

function download(label, filename, url, expectedSizeBytes = null) {
  return { label, filename, url, expected_size_bytes: expectedSizeBytes };
}

function findQueue(name) {
  const normalized = String(name).split(" - ", 1)[0];
  const value = GPU_QUEUES.find((item) => item.name === normalized || item.display_label === name);
  if (!value) throw new Error(`Unknown partition: ${name}`);
  return value;
}

function findRuntime(label) {
  const value = SESSION_RUNTIMES.find((item) => item.label === label);
  if (!value) throw new Error(`Unknown runtime: ${label}`);
  return value;
}

function findResource(label) {
  const value = RESOURCE_PRESETS.find((item) => item.label === label);
  if (!value) throw new Error(`Unknown resource preset: ${label}`);
  return value;
}

function contextLimitForModel(value) {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("glm-5.2") || normalized.includes("glm5.2")) return 1000000;
  if (normalized.includes("qwen3-coder-30b-a3b")) return 262144;
  if (normalized.includes("qwen3.6-35b-a3b")) return 262144;
  if (normalized.includes("qwen3.8-27b")) return 262144;
  if (normalized.includes("gpt-oss-120b")) return 131072;
  if (normalized.includes("qwen2.5-coder-1.5b")) return 32768;
  return 32768;
}

function contextOptionsForModel(value) {
  const normalized = String(value).toLowerCase();
  const base = [8192, 16384, 32768, 65536, 131072, 262144];
  if (normalized.includes("glm-5.2") || normalized.includes("glm5.2")) {
    return [8192, 16384, 32768, 65536, 131072];
  }
  const limit = contextLimitForModel(value);
  return base.filter((item) => item <= limit);
}

function defaultContextForModel(value) {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("qwen3.8-27b") || normalized.includes("glm-5.2")) return 65536;
  const options = contextOptionsForModel(value);
  return options.includes(32768) ? 32768 : options.at(-1);
}

function recommendedConfigForModel(value) {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("glm-5.2") || normalized.includes("glm5.2")) {
    return { queue: "largemem", runtime: "20 hours", resource: "GLM large memory - 32 CPU / 450G", context_tokens: 65536 };
  }
  if (normalized.includes("gpt-oss-120b")) {
    return { queue: "largemem", runtime: "20 hours", resource: "Large memory - 24 CPU / 256G", context_tokens: 32768 };
  }
  if (normalized.includes("qwen2.5-coder-1.5b")) {
    return { queue: "amperenodes", runtime: "2 hours", resource: "Small - 4 CPU / 32G", context_tokens: 32768 };
  }
  return {
    queue: "amperenodes",
    runtime: "2 hours",
    resource: "Medium - 8 CPU / 64G",
    context_tokens: defaultContextForModel(value),
  };
}

module.exports = {
  BACKENDS,
  GPU_QUEUES,
  MODEL_DOWNLOADS,
  RESOURCE_PRESETS,
  SESSION_RUNTIMES,
  SPLIT_GROUPS,
  contextLimitForModel,
  contextOptionsForModel,
  defaultContextForModel,
  findQueue,
  findResource,
  findRuntime,
  recommendedConfigForModel,
};
