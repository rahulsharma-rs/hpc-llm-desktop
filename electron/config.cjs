const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "hpc-llm-desktop";
const LEGACY_APP_NAME = "cheaha-llm-electron";

function configDirectory() {
  const configured = process.env.HPC_LLM_CONFIG_DIR || process.env.CHEAHA_ELECTRON_CONFIG_DIR;
  if (configured) return path.resolve(configured);
  return platformConfigDirectory(APP_NAME);
}

function legacyConfigDirectory() {
  return platformConfigDirectory(LEGACY_APP_NAME);
}

function platformConfigDirectory(appName) {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName);
}

function defaultConfig() {
  return {
    username: "",
    private_key_path: path.join(os.homedir(), ".ssh", "hpc_llm_desktop_ed25519"),
    remote_host: "",
    ssh_port: 22,
    local_port: 11435,
    remote_port: 8000,
    remote_workdir: "~/.hpc-llm/runtime",
    remote_gguf_model_path: "",
    llama_context_tokens: 65536,
    known_host_fingerprint: null,
  };
}

class ConfigStore {
  constructor(directory = null, options = {}) {
    const usesDefaultDirectory = !directory
      && !process.env.HPC_LLM_CONFIG_DIR
      && !process.env.CHEAHA_ELECTRON_CONFIG_DIR;
    this.directory = directory || configDirectory();
    this.filePath = path.join(this.directory, "config.json");
    const fallbackDirectory = options.legacyDirectory
      || (usesDefaultDirectory ? legacyConfigDirectory() : null);
    this.legacyFilePath = fallbackDirectory ? path.join(fallbackDirectory, "config.json") : null;
  }

  load() {
    const defaults = defaultConfig();
    const sourcePath = !fs.existsSync(this.filePath) && this.legacyFilePath
      ? this.legacyFilePath
      : this.filePath;
    try {
      const payload = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      const config = normalizeConfig({ ...defaults, ...payload });
      if (sourcePath !== this.filePath) {
        try {
          this.save(config);
        } catch {
          // Reading a valid legacy config should still work if migration cannot write.
        }
      }
      return config;
    } catch (error) {
      if (error.code === "ENOENT") return defaults;
      if (error instanceof SyntaxError) throw new Error(`Invalid Electron config JSON: ${sourcePath}`);
      throw error;
    }
  }

  save(values) {
    const config = normalizeConfig(values);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return config;
  }
}

function normalizeConfig(values) {
  const defaults = defaultConfig();
  const username = String(values.username ?? defaults.username).trim();
  const remoteWorkdir = String(values.remote_workdir ?? defaults.remote_workdir).trim()
    || defaults.remote_workdir;
  return {
    username,
    private_key_path: expandHome(String(values.private_key_path ?? defaults.private_key_path).trim()),
    remote_host: String(values.remote_host ?? defaults.remote_host).trim(),
    ssh_port: validPort(values.ssh_port ?? defaults.ssh_port, "SSH port"),
    local_port: validPort(values.local_port ?? defaults.local_port, "Local port"),
    remote_port: validPort(values.remote_port ?? defaults.remote_port, "Remote port"),
    remote_workdir: remoteWorkdir,
    remote_gguf_model_path: String(values.remote_gguf_model_path ?? "").trim(),
    llama_context_tokens: positiveInteger(
      values.llama_context_tokens ?? defaults.llama_context_tokens,
      "Context tokens",
    ),
    known_host_fingerprint: values.known_host_fingerprint
      ? String(values.known_host_fingerprint)
      : null,
  };
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function validPort(value, label) {
  const port = positiveInteger(value, label);
  if (port > 65535) throw new Error(`${label} must be between 1 and 65535.`);
  return port;
}

module.exports = {
  ConfigStore,
  configDirectory,
  defaultConfig,
  legacyConfigDirectory,
  normalizeConfig,
  positiveInteger,
  validPort,
};
