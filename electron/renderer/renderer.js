let appConfig = null;

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
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderState(state) {
  const status = state.status || "idle";
  const statusBadge = document.getElementById("statusBadge");
  statusBadge.className = `status ${status}`;
  statusBadge.textContent = status.toUpperCase();

  document.getElementById("currentLesson").textContent = state.currentLesson || "-";
  document.getElementById("currentLessonTitle").textContent = state.currentLessonTitle || "";
  document.getElementById("todayMinutes").textContent = state.todayMinutes ?? 0;
  document.getElementById("dailyLimit").textContent = `of ${state.dailyLimitMinutes ?? 0} planned`;
  document.getElementById("lastAction").textContent = state.lastAction || "-";
  document.getElementById("lastUpdatedAt").textContent = fmtDate(state.lastUpdatedAt);
  document.getElementById("botUrl").textContent = state.currentUrl || "-";
  document.getElementById("pausedText").textContent = String(Boolean(state.paused));
  document.getElementById("processRunningText").textContent = String(Boolean(state.processRunning));
  document.getElementById("nextExit").textContent = fmtDate(state.nextPlannedExitAt);

  document.getElementById("startBotBtn").disabled = Boolean(state.processRunning);
  document.getElementById("stopBotBtn").disabled = !state.processRunning;

  const countdownEl = document.getElementById("countdown");
  if (state.nextPlannedExitAt) {
    const diffMs = new Date(state.nextPlannedExitAt).getTime() - Date.now();
    countdownEl.textContent = diffMs > 0 ? `in ${fmtMinutes(Math.ceil(diffMs / 60000))}` : "due now";
  } else {
    countdownEl.textContent = "";
  }

  const lessonTotalsRoot = document.getElementById("lessonTotals");
  lessonTotalsRoot.innerHTML = "";
  const entries = Object.entries(state.lessonTotals || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [sectionId, lesson] of entries) {
    const targetMinutes = (lesson.targetHours || 0) * 60;
    const completedMinutes = lesson.completedMinutes || 0;
    const percent = targetMinutes > 0 ? Math.min(100, (completedMinutes / targetMinutes) * 100) : 0;

    const card = document.createElement("div");
    card.className = "lesson-card";
    card.innerHTML = `
      <div class="top">
        <strong>Section ${sectionId}</strong>
        <span class="muted">${lesson.targetHours || 0}h target</span>
      </div>
      <div class="muted">${completedMinutes} / ${targetMinutes} min</div>
      <div class="bar"><span style="width:${percent}%"></span></div>
    `;
    lessonTotalsRoot.appendChild(card);
  }
}

function renderLogs(logs) {
  const root = document.getElementById("logs");
  root.innerHTML = "";
  for (const log of logs) {
    const el = document.createElement("div");
    el.className = "log";
    el.innerHTML = `
      <div><strong>${log.event || "event"}</strong> <span class="muted">${fmtDate(log.timestamp)}</span></div>
      <div class="muted mono">${log.url || log.message || ""}</div>
    `;
    root.appendChild(el);
  }
}

async function refreshDashboard() {
  const [state, logs] = await Promise.all([
    window.desktopApi.getState(),
    window.desktopApi.getLogs()
  ]);

  renderState(state);
  renderLogs(logs);
}

async function handleStartBot() {
  await window.desktopApi.startBot();
  await refreshDashboard();
}

async function handleStopBot() {
  await window.desktopApi.stopBot();
  await refreshDashboard();
}

function setupEmbeddedBrowser() {
  const webview = document.getElementById("embeddedBrowser");
  const addressBar = document.getElementById("addressBar");
  const embeddedUrl = document.getElementById("embeddedUrl");

  const syncUrl = () => {
    const currentUrl = webview.getURL() || webview.src || "-";
    addressBar.textContent = currentUrl;
    embeddedUrl.textContent = currentUrl;
  };

  webview.addEventListener("did-navigate", syncUrl);
  webview.addEventListener("did-navigate-in-page", syncUrl);
  webview.addEventListener("dom-ready", syncUrl);
  webview.addEventListener("did-finish-load", syncUrl);
  webview.addEventListener("did-fail-load", (event) => {
    if (event.errorCode === -3) {
      return;
    }

    addressBar.textContent = `Load failed: ${event.validatedURL || event.errorDescription}`;
    embeddedUrl.textContent = event.validatedURL || "-";
    console.error("Embedded browser load failed:", event.errorCode, event.errorDescription, event.validatedURL);
  });

  document.querySelectorAll("[data-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = `${button.dataset.target}Url`;
      if (appConfig[key]) {
        webview.loadURL(appConfig[key]);
      }
    });
  });

  document.getElementById("reloadBtn").addEventListener("click", () => {
    webview.reload();
  });

  webview.loadURL(appConfig.loginUrl);
}

async function boot() {
  appConfig = await window.desktopApi.getAppConfig();
  document.getElementById("startBotBtn").addEventListener("click", handleStartBot);
  document.getElementById("stopBotBtn").addEventListener("click", handleStopBot);
  document.getElementById("refreshBtn").addEventListener("click", refreshDashboard);
  setupEmbeddedBrowser();
  await refreshDashboard();
  setInterval(refreshDashboard, 3000);
}

boot();
