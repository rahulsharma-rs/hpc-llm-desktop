const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROVIDER_ID = "hpc-llm-desktop";
const PROVIDER_NAME = "HPC LLM Desktop";
const LEGACY_PROVIDER_ID = "local-tunnel-2cheaha";

function configureOpenCode(localPort, model, contextTokens = null, paths = {}) {
  const configPath = paths.configPath || path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const authPath = paths.authPath || path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  const config = readObject(configPath);
  const auth = readObject(authPath);
  const providers = { ...(config.provider || {}) };
  const current = { ...(providers[PROVIDER_ID] || providers[LEGACY_PROVIDER_ID] || {}) };
  delete providers[LEGACY_PROVIDER_ID];
  const modelEntry = contextTokens
    ? { limit: { context: Number(contextTokens), output: 4096 } }
    : {};
  providers[PROVIDER_ID] = {
    ...current,
    npm: "@ai-sdk/openai-compatible",
    name: PROVIDER_NAME,
    options: {
      ...(current.options || {}),
      baseURL: `http://127.0.0.1:${localPort}/v1`,
    },
    models: { [model]: modelEntry },
  };
  const reference = `${PROVIDER_ID}/${model}`;
  const mergedConfig = {
    ...config,
    $schema: config.$schema || "https://opencode.ai/config.json",
    provider: providers,
    model: shouldReplaceModel(config.model) ? reference : config.model,
    small_model: shouldReplaceModel(config.small_model) ? reference : config.small_model,
  };
  const mergedAuth = { ...auth };
  delete mergedAuth[LEGACY_PROVIDER_ID];
  mergedAuth[PROVIDER_ID] = { type: "api", key: "EMPTY" };
  writeObject(configPath, mergedConfig);
  writeObject(authPath, mergedAuth);
  return { configPath, authPath, model: reference };
}

function shouldReplaceModel(value) {
  return typeof value !== "string"
    || !value
    || value.startsWith(`${PROVIDER_ID}/`)
    || value.startsWith(`${LEGACY_PROVIDER_ID}/`);
}

function readObject(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new Error(`${filePath} must contain a JSON object.`);
    }
    return payload;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`${filePath} is not valid JSON.`);
    throw error;
  }
}

function writeObject(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_NAME,
  LEGACY_PROVIDER_ID,
  configureOpenCode,
};
