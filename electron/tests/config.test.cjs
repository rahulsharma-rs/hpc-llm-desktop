const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore } = require("../config.cjs");

test("HPC LLM config is stored independently and round-trips account settings", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-llm-config-"));
  const store = new ConfigStore(directory);
  const saved = store.save({
    username: "testuser",
    private_key_path: "~/.ssh/test-key",
    remote_host: "cheaha.rc.uab.edu",
    ssh_port: 2222,
    local_port: 11435,
    remote_port: 8000,
    remote_workdir: "/gpfs/scratch/testuser/cheaha_llm_client",
    remote_gguf_model_path: "/home/testuser/cheaha_llm_client/gguf_models/model.gguf",
    llama_context_tokens: 65536,
    known_host_fingerprint: "SHA256:test",
  });

  assert.equal(saved.private_key_path, path.join(os.homedir(), ".ssh", "test-key"));
  assert.equal(saved.ssh_port, 2222);
  assert.deepEqual(store.load(), saved);
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
});

test("Electron config defaults runtime storage to the remote home directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-llm-config-"));
  const store = new ConfigStore(directory);
  const saved = store.save({ username: "newuser" });

  assert.equal(saved.remote_workdir, "~/.hpc-llm/runtime");
  assert.equal(saved.remote_host, "");
  assert.match(saved.private_key_path, /hpc_llm_desktop_ed25519$/);
});

test("legacy Cheaha settings migrate into the renamed config directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-llm-migration-"));
  const legacyDirectory = path.join(root, "cheaha-llm-electron");
  const currentDirectory = path.join(root, "hpc-llm-desktop");
  const legacyStore = new ConfigStore(legacyDirectory);
  legacyStore.save({
    username: "existing-user",
    remote_host: "cheaha.rc.uab.edu",
    remote_workdir: "~/.cheaha-llm/runtime",
  });

  const migratedStore = new ConfigStore(currentDirectory, { legacyDirectory });
  const migrated = migratedStore.load();

  assert.equal(migrated.username, "existing-user");
  assert.equal(migrated.remote_host, "cheaha.rc.uab.edu");
  assert.equal(migrated.remote_workdir, "~/.cheaha-llm/runtime");
  assert.equal(fs.existsSync(migratedStore.filePath), true);
});
