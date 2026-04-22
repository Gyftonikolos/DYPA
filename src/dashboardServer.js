const fs = require("fs");
const http = require("http");
const path = require("path");
const { getRuntimeState } = require("./runtimeState");

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readRecentLogs(filePath, limit = 30) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const lines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit);

    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { timestamp: null, event: "raw", message: line };
      }
    });
  } catch {
    return [];
  }
}

function getDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DYPA Dashboard</title>
  <style>
    :root {
      --bg: #f4f1e8;
      --panel: #fffdf8;
      --ink: #1d2a36;
      --muted: #607284;
      --line: #d8d2c4;
      --accent: #125b50;
      --warn: #b7791f;
      --danger: #b83232;
      --good: #1f7a4f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #fdf7ea 0, #f4f1e8 40%, #ebe5d6 100%);
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 2rem;
    }
    .sub {
      color: var(--muted);
      margin-bottom: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 8px 30px rgba(43, 52, 69, 0.06);
    }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .label {
      color: var(--muted);
      font-size: 0.9rem;
      margin-bottom: 6px;
    }
    .value {
      font-size: 1.5rem;
      font-weight: 700;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      font-weight: 700;
      background: #edf7f2;
      color: var(--good);
    }
    .status.idle { background: #eef2f7; color: #4a5568; }
    .status.running { background: #e8f6ef; color: var(--good); }
    .status.paused { background: #fff7e6; color: var(--warn); }
    .status.error { background: #fdecec; color: var(--danger); }
    .muted { color: var(--muted); }
    .mono { font-family: Consolas, monospace; }
    .list {
      display: grid;
      gap: 10px;
    }
    .lesson {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: #fff;
    }
    .bar {
      height: 10px;
      border-radius: 999px;
      background: #ece6da;
      overflow: hidden;
      margin-top: 8px;
    }
    .bar > span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, #125b50, #1f7a4f);
    }
    .logs {
      max-height: 380px;
      overflow: auto;
      display: grid;
      gap: 8px;
    }
    .log {
      border-bottom: 1px solid #eee6d8;
      padding-bottom: 8px;
      font-size: 0.92rem;
    }
    .topline {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    @media (max-width: 900px) {
      .span-3, .span-4, .span-5, .span-6, .span-7, .span-8, .span-12 { grid-column: span 12; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topline">
      <div>
        <h1>DYPA Dashboard</h1>
        <div class="sub">Live local view of the automation runtime</div>
      </div>
      <div id="statusBadge" class="status idle">Idle</div>
    </div>
    <div class="grid">
      <div class="card span-3">
        <div class="label">Current Lesson</div>
        <div id="currentLesson" class="value">-</div>
        <div id="currentLessonTitle" class="muted"></div>
      </div>
      <div class="card span-3">
        <div class="label">Today's Minutes</div>
        <div id="todayMinutes" class="value">0</div>
        <div id="dailyLimit" class="muted">of 0 planned</div>
      </div>
      <div class="card span-3">
        <div class="label">Next Planned Exit</div>
        <div id="nextExit" class="value">-</div>
        <div id="countdown" class="muted"></div>
      </div>
      <div class="card span-3">
        <div class="label">Last Action</div>
        <div id="lastAction" class="value" style="font-size:1.05rem;">-</div>
        <div id="lastUpdatedAt" class="muted"></div>
      </div>

      <div class="card span-5">
        <div class="label">Runtime</div>
        <div class="list">
          <div><strong>Status:</strong> <span id="statusText">idle</span></div>
          <div><strong>Paused:</strong> <span id="pausedText">false</span></div>
          <div><strong>Current URL:</strong> <span id="currentUrl" class="mono muted">-</span></div>
          <div><strong>Dashboard Started:</strong> <span id="dashboardStartedAt" class="muted">-</span></div>
        </div>
      </div>

      <div class="card span-7">
        <div class="label">Lesson Totals</div>
        <div id="lessonTotals" class="list"></div>
      </div>

      <div class="card span-12">
        <div class="label">Recent Logs</div>
        <div id="logs" class="logs"></div>
      </div>
    </div>
  </div>
  <script>
    function fmtDate(value) {
      if (!value) return "-";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return value;
      return d.toLocaleString();
    }

    function fmtMinutes(minutes) {
      if (!Number.isFinite(minutes)) return "-";
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return h > 0 ? h + "h " + m + "m" : m + "m";
    }

    function renderState(state) {
      const status = state.status || "idle";
      const badge = document.getElementById("statusBadge");
      badge.className = "status " + status;
      badge.textContent = status.toUpperCase();

      document.getElementById("statusText").textContent = status;
      document.getElementById("pausedText").textContent = String(Boolean(state.paused));
      document.getElementById("currentLesson").textContent = state.currentLesson || "-";
      document.getElementById("currentLessonTitle").textContent = state.currentLessonTitle || "";
      document.getElementById("todayMinutes").textContent = state.todayMinutes ?? 0;
      document.getElementById("dailyLimit").textContent = "of " + (state.dailyLimitMinutes ?? 0) + " planned";
      document.getElementById("lastAction").textContent = state.lastAction || "-";
      document.getElementById("lastUpdatedAt").textContent = fmtDate(state.lastUpdatedAt);
      document.getElementById("currentUrl").textContent = state.currentUrl || "-";
      document.getElementById("dashboardStartedAt").textContent = fmtDate(state.dashboardStartedAt);
      document.getElementById("nextExit").textContent = fmtDate(state.nextPlannedExitAt);

      const countdownEl = document.getElementById("countdown");
      if (state.nextPlannedExitAt) {
        const diff = new Date(state.nextPlannedExitAt).getTime() - Date.now();
        countdownEl.textContent = diff > 0 ? "in " + fmtMinutes(Math.ceil(diff / 60000)) : "due now";
      } else {
        countdownEl.textContent = "";
      }

      const lessonTotals = document.getElementById("lessonTotals");
      lessonTotals.innerHTML = "";
      const entries = Object.entries(state.lessonTotals || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
      for (const [sectionId, lesson] of entries) {
        const targetMinutes = (lesson.targetHours || 0) * 60;
        const completedMinutes = lesson.completedMinutes || 0;
        const percent = targetMinutes > 0 ? Math.min(100, (completedMinutes / targetMinutes) * 100) : 0;

        const card = document.createElement("div");
        card.className = "lesson";
        card.innerHTML = \`
          <div><strong>Section \${sectionId}</strong></div>
          <div class="muted">\${completedMinutes} / \${targetMinutes} min</div>
          <div class="bar"><span style="width:\${percent}%"></span></div>
        \`;
        lessonTotals.appendChild(card);
      }
    }

    function renderLogs(logs) {
      const root = document.getElementById("logs");
      root.innerHTML = "";
      for (const log of logs) {
        const item = document.createElement("div");
        item.className = "log";
        item.innerHTML = \`
          <div><strong>\${log.event || "event"}</strong> <span class="muted">\${fmtDate(log.timestamp)}</span></div>
          <div class="muted mono">\${log.url || log.message || ""}</div>
        \`;
        root.appendChild(item);
      }
    }

    async function refresh() {
      const [stateRes, logsRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/logs')
      ]);

      const state = await stateRes.json();
      const logs = await logsRes.json();
      renderState(state);
      renderLogs(logs);
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

function startDashboardServer({ port, runtimeStatePath, progressStatePath, sessionLogPath }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/state") {
      const runtimeState = getRuntimeState();
      const persistedProgress = readJsonFile(progressStatePath, {});
      const merged = {
        ...runtimeState,
        todayMinutes:
          persistedProgress.dailyProgress?.completedMinutes ?? runtimeState.todayMinutes ?? 0,
        lessonTotals:
          Object.keys(runtimeState.lessonTotals || {}).length > 0
            ? runtimeState.lessonTotals
            : persistedProgress.lessonProgress || {}
      };

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(merged));
      return;
    }

    if (url.pathname === "/api/logs") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(readRecentLogs(sessionLogPath)));
      return;
    }

    if (url.pathname === "/api/runtime-file") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(readJsonFile(runtimeStatePath, {})));
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.listen(port, "127.0.0.1");
  return server;
}

module.exports = {
  startDashboardServer
};
