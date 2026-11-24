const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat();
const requestList = $("#request-list");
const startButton = $("#start-button");
const stopButton = $("#stop-button");
let inFlight = false;

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${number.format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}

function ago(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function setBusy(value) {
  inFlight = value;
  startButton.disabled = value || startButton.dataset.disabled === "true";
  stopButton.disabled = value || stopButton.dataset.disabled === "true";
}

function renderChart(buckets = []) {
  const width = 720;
  const height = 180;
  const usableHeight = 158;
  const values = Array.from({ length: 60 }, (_, index) => {
    const bucket = buckets[buckets.length - 60 + index];
    return bucket?.requests ?? 0;
  });
  const maximum = Math.max(4, ...values);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 8 - (value / maximum) * usableHeight;
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  $("#chart-line").setAttribute("d", line);
  $("#chart-area").setAttribute("d", area);
  $("#chart-grid").innerHTML = [28, 68, 108, 148].map((y) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}"></line>`).join("");
  $("#chart-empty").hidden = values.some((value) => value > 0);
}

function renderRequests(events = []) {
  $("#recent-count").textContent = `${events.length}`;
  if (!events.length) {
    requestList.innerHTML = '<div class="empty-row">No requests captured yet.</div>';
    return;
  }
  requestList.innerHTML = events.map((event) => {
    const status = Number(event.status);
    const statusClass = status >= 500 ? "bad" : status >= 400 ? "warn" : "";
    const method = String(event.method).replace(/[<>&"]/g, "");
    const path = String(event.path).replace(/[<>&"]/g, "");
    return `<div class="request-row">
      <span class="request-path" title="${method} ${path}">${method} ${path}</span>
      <span class="request-status ${statusClass}">${status}</span>
      <span class="request-time" title="${Number(event.durationMs).toFixed(1)} ms">${ago(event.at)}</span>
    </div>`;
  }).join("");
}

function render(data) {
  const running = Boolean(data.running);
  const dot = $("#status-dot");
  dot.className = `status-dot ${running ? "running" : "stopped"}`;
  $("#status-label").textContent = running ? "Server online" : "Server stopped";
  $("#managed-label").textContent = data.managed ? "CONTROLLED" : running ? "EXTERNAL" : "READY";
  $("#server-url").textContent = `${data.url}/api`;
  $("#uptime").textContent = running ? formatDuration(data.uptimeSeconds) : "Offline";
  $("#requests-total").textContent = data.traffic ? number.format(data.traffic.totals.requests) : "—";
  $("#requests-rate").textContent = data.traffic ? `${data.traffic.totals.errors} error responses since start` : "Starts counting when managed";
  $("#bytes-total").textContent = data.traffic ? formatBytes(data.traffic.totals.responseBytes) : "—";
  $("#connections-total").textContent = data.traffic ? number.format(data.traffic.activeSockets) : "—";
  $("#connections-detail").textContent = data.traffic
    ? `${number.format(data.traffic.totals.connections)} total sessions`
    : "Live Socket.IO sessions";
  $("#errors-total").textContent = data.traffic ? number.format(data.traffic.totals.errors) : "—";
  renderChart(data.traffic?.buckets ?? []);
  renderRequests(data.traffic?.recent ?? []);
  $("#error-message").hidden = !data.lastError;
  $("#error-message").textContent = data.lastError ?? "";
  $("#control-hint").textContent = running && !data.managed
    ? "This Syncura server is already running outside this panel. Start here to safely restart it under panel control."
    : data.traffic
      ? "Traffic records are metadata only; request and message contents are never logged."
      : "Controls affect only this PC’s Syncura server process.";
  startButton.dataset.disabled = String(running && data.managed);
  stopButton.dataset.disabled = String(!running || !data.controllable);
  setBusy(inFlight);
}

async function api(path, method = "GET") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

async function refresh() {
  try {
    render(await api("/api/status"));
  } catch (error) {
    $("#error-message").hidden = false;
    $("#error-message").textContent = error instanceof Error ? error.message : "Could not reach the local controller.";
  }
}

async function control(action) {
  if (inFlight) return;
  if (action === "start" && $("#managed-label").textContent === "EXTERNAL") {
    const accepted = window.confirm(
      "Syncura is already running outside this panel. Take control by stopping that verified local Syncura process and starting a managed one? The server may be briefly unavailable.",
    );
    if (!accepted) return;
  }
  setBusy(true);
  $("#error-message").hidden = true;
  try {
    render(await api(`/api/${action}`, "POST"));
  } catch (error) {
    $("#error-message").hidden = false;
    $("#error-message").textContent = error instanceof Error ? error.message : `Could not ${action} the server.`;
  } finally {
    setBusy(false);
    await refresh();
  }
}

startButton.addEventListener("click", () => void control("start"));
stopButton.addEventListener("click", () => void control("stop"));
void refresh();
window.setInterval(() => void refresh(), 2000);
