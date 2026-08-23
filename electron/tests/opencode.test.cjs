const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LEGACY_PROVIDER_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  configureOpenCode,
} = require("../opencode.cjs");

test("OpenCode configuration migrates the legacy provider to HPC LLM Desktop", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-llm-opencode-"));
  const configPath = path.join(directory, "opencode.json");
  const authPath = path.join(directory, "auth.json");
  fs.writeFileSync(configPath, JSON.stringify({
    provider: {
      [LEGACY_PROVIDER_ID]: {
        options: { baseURL: "http://127.0.0.1:10000/v1" },
      },
    },
    model: `${LEGACY_PROVIDER_ID}/old-model`,
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    [LEGACY_PROVIDER_ID]: { type: "api", key: "EMPTY" },
  }));

  const result = configureOpenCode(11435, "qwen3.8:27b", 65536, { configPath, authPath });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));

  assert.equal(PROVIDER_NAME, "HPC LLM Desktop");
  assert.equal(result.model, `${PROVIDER_ID}/qwen3.8:27b`);
  assert.equal(config.model, result.model);
  assert.equal(config.provider[LEGACY_PROVIDER_ID], undefined);
  assert.equal(config.provider[PROVIDER_ID].options.baseURL, "http://127.0.0.1:11435/v1");
  assert.equal(config.provider[PROVIDER_ID].models["qwen3.8:27b"].limit.context, 65536);
  assert.equal(auth[LEGACY_PROVIDER_ID], undefined);
  assert.deepEqual(auth[PROVIDER_ID], { type: "api", key: "EMPTY" });
});
