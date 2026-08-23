const state = {
  token: "",
  bootstrap: null,
  config: null,
  models: [],
  partitions: [],
  sessions: [],
  selectedJobId: null,
  activeOperation: null,
  operationPollFailures: 0,
  launchInitialized: false,
  local: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function readToken() {
  const params = new URLSearchParams(window.location.search);
  const incoming = params.get("token");
  if (incoming) {
    window.sessionStorage.setItem("hpc-llm-app-token", incoming);
    params.delete("token");
    const suffix = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${suffix ? `?${suffix}` : ""}`);
  }
  return incoming || window.sessionStorage.getItem("hpc-llm-app-token") || "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-HPC-LLM-Token": state.token,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  }
  return payload.data;
}

function setBusy(active, label = "Working...") {
  $("#busy-label").textContent = label;
  $("#busy-overlay").hidden = !active;
}

function activity(title, detail, type = "info") {
  const list = $("#activity-list");
  const empty = list.querySelector(".activity-empty");
  if (empty) empty.remove();
  const item = document.createElement("li");
  item.className = type === "error" ? "is-error" : type === "success" ? "is-success" : "";
  const heading = document.createElement("strong");
  const copy = document.createElement("span");
  const time = document.createElement("time");
  heading.textContent = title;
  copy.textContent = detail;
  time.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  item.append(heading, copy, time);
  list.prepend(item);
  while (list.children.length > 30) list.lastElementChild.remove();
}

async function runAction(label, action, successTitle = label) {
  setBusy(true, label);
  try {
    const result = await action();
    if (successTitle) activity(successTitle, result?.message || "Completed.", "success");
    return result;
  } catch (error) {
    activity(`${label} failed`, error.message, "error");
    throw error;
  } finally {
    setBusy(false);
  }
}

function setConnection(connected, message) {
  const badge = $("#connection-state");
  badge.textContent = message;
  badge.className = `connection-state ${connected ? "is-good" : "is-bad"}`;
  $("#hpc-summary").textContent = connected ? "Connected" : "Unavailable";
  $("#hpc-detail").textContent = message;
}

function switchView(viewName) {
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".app-view").forEach((view) => view.classList.toggle("is-active", view.id === `view-${viewName}`));
  $("#view-title").textContent = viewName[0].toUpperCase() + viewName.slice(1);
  $("#view-eyebrow").textContent = viewName === "account" ? "LOCAL CONFIGURATION" : "HPC WORKSPACE";
}

function addOptions(select, items, valueKey, labelKey, preferredValue) {
  select.replaceChildren();
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item[valueKey]);
    option.textContent = String(item[labelKey]);
    select.append(option);
  });
  if (preferredValue && items.some((item) => String(item[valueKey]) === String(preferredValue))) {
    select.value = String(preferredValue);
  }
}

function currentBackend() {
  return $("#backend-choice").value || "llama";
}

function selectedModel() {
  return state.models.find((item) => item.path === $("#model-choice").value) || null;
}

function updateQueueChoices(preferred) {
  const backend = currentBackend();
  const livePartitions = new Map(state.partitions.map((partition) => [partition.name, partition]));
  const queues = state.bootstrap.catalog.queues.filter((queue) => {
    const supportsBackend = backend === "llama" || backend === "ollama"
      ? queue.llama_supported
      : queue.vllm_supported;
    const live = livePartitions.get(queue.name);
    return supportsBackend && (!livePartitions.size || (live && live.availability !== "down"));
  }).map((queue) => ({
    ...queue,
    option_label: queue.display_label,
  }));
  const select = $("#queue-choice");
  addOptions(select, queues, "name", "option_label", preferred || select.value || selectedModel()?.recommended_config?.queue || "amperenodes");
  updateRuntimeChoices();
  updateQueueNote();
}

function updateRuntimeChoices(preferred) {
  const queue = state.bootstrap.catalog.queues.find((item) => item.name === $("#queue-choice").value);
  const runtimes = state.bootstrap.catalog.runtimes.filter((item) => !queue || item.hours <= queue.max_hours);
  const select = $("#runtime-choice");
  addOptions(select, runtimes, "label", "label", preferred || select.value || "2 hours");
}

function updateQueueNote() {
  const queue = state.bootstrap.catalog.queues.find((item) => item.name === $("#queue-choice").value);
  const live = state.partitions.find((item) => item.name === queue?.name);
  if (live) {
    $("#queue-note").textContent = `${live.idle_nodes} idle, ${live.mixed_nodes} mixed of ${live.total_nodes} live nodes | max ${queue.max_runtime} | ${String(live.availability || "unknown").toUpperCase()}`;
    return;
  }
  if (!queue) {
    $("#queue-note").textContent = "";
    return;
  }
  const nodeLimit = queue.max_nodes_per_researcher === null ? "unlimited nodes/user" : `${queue.max_nodes_per_researcher} node${queue.max_nodes_per_researcher === 1 ? "" : "s"}/user`;
  $("#queue-note").textContent = `Reference: ${queue.documented_nodes} nodes | ${nodeLimit} | max ${queue.max_runtime} | priority ${queue.priority_tier}`;
}

function updateModelChoices(preferred) {
  const select = $("#model-choice");
  addOptions(select, state.models, "path", "label", preferred || select.value || state.config.remote_gguf_model_path);
  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No complete GGUF models found";
    select.append(option);
  }
  updateContextChoices();
}

function updateContextChoices(applyDefaults = false) {
  const modelValue = $("#model-choice").value;
  let options = [8192, 16384, 32768, 65536, 131072];
  let preferred = Number($("#context-choice").value || state.config.llama_context_tokens || 32768);
  const model = state.models.find((item) => item.path === modelValue);
  if (model) {
    options = model.context_options;
    if (applyDefaults) preferred = model.default_context;
  }
  addOptions(
    $("#context-choice"),
    options.map((value) => ({ value, label: value.toLocaleString() })),
    "value",
    "label",
    preferred,
  );
}

function setLaunchStatus(status, title, copy) {
  $("#launch-status").dataset.state = status;
  $("#launch-status-title").textContent = title;
  $("#launch-status-copy").textContent = copy;
}

function launchSummary(config) {
  if (!config) return "Choose a model to load recommended settings.";
  return `Recommended: ${config.queue} | ${config.runtime} | ${config.resource} | ${Number(config.context_tokens).toLocaleString()} context`;
}

function markLaunchUntested() {
  setLaunchStatus("untested", "Not tested", launchSummary(selectedModel()?.recommended_config));
}

function applyPartitionDefaults() {
  const queue = state.bootstrap.catalog.queues.find((item) => item.name === $("#queue-choice").value);
  if (!queue) return;
  updateRuntimeChoices(queue.recommended_runtime);
  $("#resource-choice").value = queue.recommended_resource;
  markLaunchUntested();
}

function applyModelDefaults({ announce = false } = {}) {
  const model = selectedModel();
  if (!model) {
    markLaunchUntested();
    return;
  }
  const defaults = model.recommended_config;
  updateQueueChoices(defaults.queue);
  if ($("#queue-choice").value !== defaults.queue) {
    const queue = state.bootstrap.catalog.queues.find((item) => item.name === $("#queue-choice").value);
    updateRuntimeChoices(queue?.recommended_runtime);
    $("#resource-choice").value = queue?.recommended_resource || defaults.resource;
    updateContextChoices(true);
    setLaunchStatus("untested", "Recommended partition unavailable", `${defaults.queue} is not currently available. Using ${queue?.name || "the first live partition"} defaults.`);
    return;
  }
  updateRuntimeChoices(defaults.runtime);
  $("#resource-choice").value = defaults.resource;
  updateContextChoices(true);
  if ([...$("#context-choice").options].some((option) => Number(option.value) === Number(defaults.context_tokens))) {
    $("#context-choice").value = String(defaults.context_tokens);
  }
  markLaunchUntested();
  if (announce) activity("Recommended settings restored", launchSummary(defaults), "success");
}

function renderAccount() {
  const config = state.config;
  $("#username").value = config.username || "";
  $("#remote-host").value = config.remote_host || "";
  $("#ssh-port").value = config.ssh_port || 22;
  $("#private-key-path").value = config.private_key_path || "";
  $("#remote-workdir").value = config.remote_workdir || "";
  $("#local-port").value = config.local_port;
  $("#remote-port").value = config.remote_port;
  $("#fingerprint-status").textContent = config.known_host_fingerprint
    ? `Saved host fingerprint: ${config.known_host_fingerprint}`
    : "No saved host fingerprint.";
}

function accountPayload() {
  return {
    username: $("#username").value.trim(),
    remote_host: $("#remote-host").value.trim(),
    ssh_port: Number($("#ssh-port").value),
    private_key_path: $("#private-key-path").value.trim(),
    remote_workdir: $("#remote-workdir").value.trim(),
    local_port: Number($("#local-port").value),
    remote_port: Number($("#remote-port").value),
    remote_gguf_model_path: $("#model-choice").value || state.config.remote_gguf_model_path,
    llama_context_tokens: Number($("#context-choice").value || state.config.llama_context_tokens),
  };
}

function renderModels(payload) {
  state.models = payload.items || [];
  const body = $("#models-body");
  body.replaceChildren();
  if (!state.models.length) {
    body.innerHTML = '<tr><td class="empty-cell" colspan="4">No complete GGUF models were found.</td></tr>';
  } else {
    state.models.forEach((model) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td title="${escapeHtml(model.path)}">${escapeHtml(model.label.replace(/ \([^)]*\)$/, ""))}</td>
        <td>${escapeHtml(model.size)}</td>
        <td><span class="storage-tag storage-${escapeHtml(model.location)}">${escapeHtml(model.location)}</span></td>
        <td>${Number(model.default_context).toLocaleString()}</td>`;
      body.append(row);
    });
  }
  const scratch = payload.scratch_count ? `; ${payload.scratch_count} scratch` : "";
  $("#model-count").textContent = `${payload.home_count} persistent home model${payload.home_count === 1 ? "" : "s"}${scratch}.`;
  const status = $("#install-status");
  status.replaceChildren();
  const installStatus = payload.install_status || {};
  Object.entries(installStatus).forEach(([group, message]) => {
    const line = document.createElement("p");
    line.textContent = message;
    status.append(line);
    const badge = document.querySelector(`[data-install-status="${group}"]`);
    const button = document.querySelector(`[data-download="${group}"]`);
    if (badge) {
      const ready = message.endsWith(": ready.");
      badge.textContent = ready ? "Installed" : message.includes("downloading:") ? "Incomplete download" : "Not installed";
      badge.className = ready ? "is-installed" : "is-missing";
      if (button && !state.activeOperation) button.disabled = ready;
    }
  });
  if (payload.storage?.models_directory) {
    $("#remote-storage-status").textContent = `Persistent model folder: ${payload.storage.models_directory}`;
  }
  updateModelChoices(state.config.remote_gguf_model_path);
  if (!state.launchInitialized && state.models.length) {
    state.launchInitialized = true;
    applyModelDefaults();
  } else {
    updateQueueChoices();
    markLaunchUntested();
  }
}

function renderOperation(operation) {
  state.activeOperation = ["queued", "installing"].includes(operation.status) ? operation : null;
  const panel = $("#install-progress");
  panel.hidden = false;
  panel.dataset.status = operation.status;
  $("#install-progress-title").textContent = operation.label;
  $("#install-progress-state").textContent = operation.status === "complete"
    ? "Installed"
    : operation.status === "failed"
      ? "Stopped"
      : operation.status === "queued"
        ? "Queued"
        : "Installing";
  const progress = Math.max(0, Math.min(100, Number(operation.progress || 0)));
  $("#install-progress-bar").value = progress;
  $("#install-progress-bar").textContent = `${progress}%`;
  $("#install-progress-percent").textContent = `${progress}%`;
  $("#install-progress-message").textContent = operation.message;
  const error = $("#install-progress-error");
  error.hidden = !operation.error;
  error.textContent = operation.error || "";
  $$('[data-download]').forEach((button) => {
    if (state.activeOperation) button.disabled = true;
  });
}

async function pollOperation(operationId) {
  try {
    const operation = await api(`/api/operations/${encodeURIComponent(operationId)}`);
    state.operationPollFailures = 0;
    renderOperation(operation);
    if (["queued", "installing"].includes(operation.status)) {
      window.setTimeout(() => pollOperation(operationId), 1200);
      return;
    }
    if (operation.status === "complete") {
      activity(`${operation.label} installed`, operation.message, "success");
    } else {
      activity(`${operation.label} installation stopped`, operation.error || operation.message, "error");
    }
    await refreshModels().catch(() => {});
  } catch (error) {
    state.operationPollFailures += 1;
    $("#install-progress-message").textContent = `Status check failed: ${error.message}. Retrying...`;
    if (state.operationPollFailures < 20) {
      window.setTimeout(() => pollOperation(operationId), 2000);
    } else {
      activity("Installation status unavailable", "Reconnect or refresh the app; the remote partial file is preserved.", "error");
    }
  }
}

async function startModelInstall(button) {
  const label = button.querySelector("strong").textContent;
  const accepted = await confirmAction(
    `Install ${label}`,
    `${label} will be downloaded to your persistent HPC home folder. Existing verified files are kept and interrupted downloads can be resumed.`,
    "Install model",
  );
  if (!accepted) return;
  try {
    const operation = await api("/api/models/install", {
      method: "POST",
      body: { group: button.dataset.download },
    });
    renderOperation(operation);
    activity(`${label} installation started`, "You can continue using the app while installation runs.");
    pollOperation(operation.id);
  } catch (error) {
    activity(`${label} installation failed to start`, error.message, "error");
  }
}

function renderSessions(sessions) {
  state.sessions = sessions || [];
  if (state.selectedJobId && !state.sessions.some((job) => job.job_id === state.selectedJobId)) {
    state.selectedJobId = null;
  }
  const body = $("#sessions-body");
  body.replaceChildren();
  if (!state.sessions.length) {
    body.innerHTML = '<tr><td class="empty-cell" colspan="6">No active HPC LLM sessions.</td></tr>';
  } else {
    state.sessions.forEach((job) => {
      const row = document.createElement("tr");
      row.dataset.jobId = job.job_id;
      row.tabIndex = 0;
      row.setAttribute("aria-selected", String(job.job_id === state.selectedJobId));
      row.classList.toggle("is-selected", job.job_id === state.selectedJobId);
      row.innerHTML = `
        <td>${escapeHtml(job.job_id)}</td>
        <td>${escapeHtml(job.backend)}</td>
        <td title="${escapeHtml(job.model)}">${escapeHtml(job.model)}</td>
        <td><span class="state-tag state-${job.state.toLowerCase()}">${escapeHtml(job.state)}</span></td>
        <td title="${escapeHtml(job.node)}">${escapeHtml(job.node)}</td>
        <td title="${escapeHtml(job.remaining)}">${escapeHtml(job.remaining)}</td>`;
      row.addEventListener("click", () => selectJob(job.job_id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectJob(job.job_id);
        }
      });
      body.append(row);
    });
  }
  $("#sessions-copy").textContent = `${state.sessions.length} active app session${state.sessions.length === 1 ? "" : "s"}.`;
  selectJob(state.selectedJobId);
}

function selectJob(jobId) {
  state.selectedJobId = jobId;
  const selected = state.sessions.find((job) => job.job_id === jobId) || null;
  $$("#sessions-body tr[data-job-id]").forEach((row) => {
    const active = row.dataset.jobId === jobId;
    row.classList.toggle("is-selected", active);
    row.setAttribute("aria-selected", String(active));
  });
  $("#connect-tunnel").disabled = !selected || selected.state !== "RUNNING";
  $("#configure-opencode").disabled = !selected;
  $("#cancel-session").disabled = !selected || !["PENDING", "RUNNING", "CONFIGURING", "COMPLETING"].includes(selected.state);
  if (selected) {
    $("#session-summary").textContent = `${selected.model} | ${selected.state}`;
    $("#session-detail").textContent = `${selected.job_id} on ${selected.node || selected.partition}`;
  } else {
    $("#session-summary").textContent = "None";
    $("#session-detail").textContent = "Choose a session from the table";
  }
}

function renderLocal(local) {
  state.local = local;
  $("#endpoint-url").textContent = local.endpoint_url;
  $("#tunnel-summary").textContent = local.tunnel_active ? "Tunnel active" : "Tunnel stopped";
  $("#stop-tunnel").disabled = !local.tunnel_active;
}

function renderPartitions(payload) {
  state.partitions = payload?.items || [];
  updateQueueNote();
  if (payload?.warning) activity("Partition status unavailable", payload.warning, "error");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refreshAll() {
  const data = await runAction("Refreshing HPC", () => api("/api/refresh", { method: "POST" }), "Refresh complete");
  setConnection(true, data.connection.message);
  renderPartitions(data.partitions);
  renderModels(data.models);
  renderSessions(data.sessions);
  renderLocal(data.local);
}

function confirmAction(title, copy, buttonLabel = "Continue") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-copy").textContent = copy;
  $("#confirm-action").textContent = buttonLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function launchPayload() {
  return {
    backend: currentBackend(),
    queue: $("#queue-choice").value,
    runtime: $("#runtime-choice").value,
    resource: $("#resource-choice").value,
    context_tokens: Number($("#context-choice").value),
    model_path: $("#model-choice").value,
  };
}

async function testLaunchConfiguration() {
  const payload = launchPayload();
  if (!payload.model_path) {
    const error = new Error("Select a complete model first.");
    setLaunchStatus("rejected", "Configuration rejected", error.message);
    activity("Cannot test configuration", error.message, "error");
    throw error;
  }
  try {
    const result = await runAction(
      "Testing launch configuration",
      () => api("/api/sessions/preflight", { method: "POST", body: payload }),
      "Configuration accepted",
    );
    setLaunchStatus("ready", "Configuration accepted", result.message);
    return { payload, result };
  } catch (error) {
    setLaunchStatus("rejected", "Configuration rejected", error.message);
    throw error;
  }
}

async function startSession() {
  const modelValue = $("#model-choice").value;
  if (!modelValue) {
    activity("Cannot start session", "Select a complete model first.", "error");
    return;
  }
  const { payload } = await testLaunchConfiguration();
  const accepted = await confirmAction(
    "Start HPC session",
    `Slurm accepted this configuration without creating a job. Submit ${$("#model-choice").selectedOptions[0].textContent} to ${payload.queue} for ${payload.runtime}?`,
    "Start session",
  );
  if (!accepted) return;
  const submitted = await runAction("Submitting LLM session", () => api("/api/sessions/start", { method: "POST", body: payload }), "Session submitted");
  setLaunchStatus("ready", "Session submitted", submitted.message);
  await refreshSessions();
}

async function refreshSessions() {
  const sessions = await runAction(
    "Refreshing sessions",
    () => api("/api/sessions/refresh", { method: "POST" }),
    "Sessions refreshed",
  );
  renderSessions(sessions);
}

async function refreshModels() {
  const models = await runAction(
    "Refreshing models",
    () => api("/api/models/refresh", { method: "POST" }),
    "Models refreshed",
  );
  renderModels(models);
}

async function initialize() {
  state.token = readToken();
  try {
    state.bootstrap = await api("/api/bootstrap");
  } catch (error) {
    setConnection(false, "Local API unavailable");
    activity("App initialization failed", error.message, "error");
    return;
  }
  state.config = state.bootstrap.config;
  renderAccount();
  renderLocal(state.bootstrap.local);
  addOptions($("#backend-choice"), state.bootstrap.catalog.backends, "value", "label", "llama");
  addOptions($("#resource-choice"), state.bootstrap.catalog.resources, "label", "label", "Medium - 8 CPU / 64G");
  updateQueueChoices("amperenodes");
  updateModelChoices(state.config.remote_gguf_model_path);
  activity("Local app ready", "Electron and browser share this control service.", "success");
  const activeOperation = (state.bootstrap.operations || []).find((operation) => ["queued", "installing"].includes(operation.status));
  if (activeOperation) {
    renderOperation(activeOperation);
    pollOperation(activeOperation.id);
  }
  if (state.config.username && state.config.private_key_path) {
    refreshAll().catch((error) => setConnection(false, error.message));
  }
  window.__HPC_LLM_APP__ = state;
}

$$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("#clear-activity").addEventListener("click", () => {
  $("#activity-list").innerHTML = '<li class="activity-empty">Activity cleared.</li>';
});
$("#backend-choice").addEventListener("change", () => {
  updateQueueChoices();
  updateModelChoices();
  applyModelDefaults();
});
$("#model-choice").addEventListener("change", applyModelDefaults);
$("#queue-choice").addEventListener("change", () => {
  updateQueueNote();
  applyPartitionDefaults();
});
$("#runtime-choice").addEventListener("change", markLaunchUntested);
$("#resource-choice").addEventListener("change", markLaunchUntested);
$("#context-choice").addEventListener("change", markLaunchUntested);
$("#refresh-all").addEventListener("click", () => refreshAll().catch((error) => setConnection(false, error.message)));
$("#refresh-sessions").addEventListener("click", () => refreshSessions().catch(() => {}));
$("#refresh-models").addEventListener("click", () => refreshModels().catch(() => {}));
$("#test-configuration").addEventListener("click", () => testLaunchConfiguration().catch(() => {}));
$("#restore-defaults").addEventListener("click", () => applyModelDefaults({ announce: true }));
$("#start-session").addEventListener("click", () => startSession().catch(() => {}));
$("#connect-tunnel").addEventListener("click", async () => {
  if (!state.selectedJobId) return;
  const result = await runAction(
    "Connecting tunnel",
    () => api("/api/tunnel/start", { method: "POST", body: { job_id: state.selectedJobId } }),
    "Tunnel connected",
  ).catch(() => null);
  if (result) renderLocal(result.local);
});
$("#stop-tunnel").addEventListener("click", async () => {
  const result = await runAction("Stopping tunnel", () => api("/api/tunnel/stop", { method: "POST" }), "Tunnel stopped").catch(() => null);
  if (result) renderLocal(result.local);
});
$("#configure-opencode").addEventListener("click", () => runAction(
  "Configuring OpenCode",
  () => api("/api/opencode/configure", { method: "POST", body: { job_id: state.selectedJobId } }),
  "OpenCode configured",
).catch(() => {}));
$("#cancel-session").addEventListener("click", async () => {
  if (!state.selectedJobId) return;
  const accepted = await confirmAction(
    "Cancel HPC session",
    `Cancel Slurm job ${state.selectedJobId}? The running model endpoint will stop.`,
    "Cancel session",
  );
  if (!accepted) return;
  await runAction(
    "Cancelling session",
    () => api("/api/sessions/cancel", { method: "POST", body: { job_id: state.selectedJobId } }),
    "Session cancelled",
  ).catch(() => null);
  state.selectedJobId = null;
  await refreshSessions().catch(() => {});
});
$("#test-endpoint").addEventListener("click", async () => {
  const result = await runAction("Testing endpoint", () => api("/api/endpoint"), null).catch(() => null);
  if (result) activity(result.ok ? "Endpoint responding" : "Endpoint unavailable", result.model_ids?.join(", ") || result.message, result.ok ? "success" : "error");
});
$$('[data-download]').forEach((button) => button.addEventListener("click", () => startModelInstall(button)));

$("#save-account").addEventListener("click", async () => {
  const config = await runAction(
    "Saving settings",
    () => api("/api/settings", { method: "POST", body: accountPayload() }),
    "Settings saved",
  ).catch(() => null);
  if (config) {
    state.config = config;
    renderAccount();
  }
});
$("#test-account").addEventListener("click", async () => {
  const saved = await api("/api/settings", { method: "POST", body: accountPayload() }).catch((error) => {
    activity("Saving settings failed", error.message, "error");
    return null;
  });
  if (!saved) return;
  state.config = saved;
  const result = await runAction("Testing SSH login", () => api("/api/account/test", { method: "POST" }), "SSH login succeeded").catch(() => null);
  if (result) {
    setConnection(true, `${result.username}@${result.hostname}`);
    $("#remote-storage-status").textContent = `Persistent model folder: ${result.models_directory}`;
  }
});
$("#generate-key").addEventListener("click", async () => {
  const result = await runAction(
    "Creating SSH key",
    () => api("/api/account/generate-key", { method: "POST", body: accountPayload() }),
    "SSH key ready",
  ).catch(() => null);
  if (result) {
    $("#private-key-path").value = result.private_key_path;
    state.config.private_key_path = result.private_key_path;
  }
});
$("#deploy-key").addEventListener("click", async () => {
  const payload = { ...accountPayload(), password: $("#hpc-password").value };
  await runAction(
    "Deploying SSH key",
    () => api("/api/account/deploy-key", { method: "POST", body: payload }),
    "SSH key deployed",
  ).catch(() => null);
  $("#hpc-password").value = "";
});
$("#fetch-fingerprint").addEventListener("click", async () => {
  await api("/api/settings", { method: "POST", body: accountPayload() }).catch(() => null);
  const result = await runAction(
    "Checking host fingerprint",
    () => api("/api/account/fingerprint", { method: "POST" }),
    "Fingerprint checked",
  ).catch(() => null);
  if (result) $("#fingerprint-status").textContent = `Saved host fingerprint: ${result.sha256}`;
});
$("#create-folder").addEventListener("click", () => runAction(
  "Creating remote folder",
  () => api("/api/account/create-folder", { method: "POST" }),
  "Remote folder ready",
).catch(() => {}));
$("#save-hf-token").addEventListener("click", async () => {
  const token = $("#hf-token").value;
  await runAction(
    "Deploying Hugging Face token",
    () => api("/api/account/huggingface-token", { method: "POST", body: { token } }),
    "Hugging Face token deployed",
  ).catch(() => null);
  $("#hf-token").value = "";
});
$("#verify-llama").addEventListener("click", () => runAction(
  "Verifying llama-server",
  () => api("/api/account/verify-llama", { method: "POST" }),
  "llama-server verified",
).catch(() => {}));
$("#install-llama").addEventListener("click", async () => {
  const accepted = await confirmAction(
    "Install llama-server",
    "Build the CPU and CUDA llama-server binaries in your HPC work directory? This can take several minutes.",
    "Install",
  );
  if (!accepted) return;
  await runAction(
    "Installing llama-server",
    () => api("/api/account/install-llama", { method: "POST" }),
    "llama-server installed",
  ).catch(() => null);
});

window.addEventListener("DOMContentLoaded", initialize);
window.addEventListener("error", (event) => {
  setBusy(false);
  activity("Interface error", event.message || "An unexpected interface error occurred.", "error");
});
window.addEventListener("unhandledrejection", (event) => {
  setBusy(false);
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason || "Unexpected request failure.");
  activity("Request error", message, "error");
});
