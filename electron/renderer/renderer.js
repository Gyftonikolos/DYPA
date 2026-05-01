let appConfig = null;
let currentSettings = null;
let fullLogs = [];
let detachWebviewWindowOpenListener = null;
let detachWebviewJsDialogListener = null;
let activeHelpKey = null;
let activeLogGroup = "all";
let lastRuntimeState = {};
let lastHandledScheduleTriggerToken = null;
let settingsPreviewExpanded = false;
const notificationCooldownByType = {};
const notificationCooldownByHash = {};
const NOTIFICATION_COOLDOWN_MS = 30_000;
const webviewConsoleCooldownByMessage = {};
const WEBVIEW_CONSOLE_DEDUPE_MS = 60_000;
const webviewAbortCooldownByKey = {};
const WEBVIEW_ABORT_DEDUPE_MS = 15_000;
const webviewAbortStatsByUrl = {};

const DEFAULT_FEATURE_FLAGS = {
  notifications: {
    enabled: true,
    startStop: true,
    errors: true,
    limits: true,
    validation: true,
    discordWebhookEnabled: false,
    discordWebhookUrl: "",
    discordVerbose: false,
    discordVerboseFlushSeconds: 20
  },
  logging: {
    verboseWebviewConsole: false
  },
  ui: {
    simpleMode: false,
    lightTheme: false
  },
  navigation: {
    directCourseMode: false
  }
};

const HELP_CONTENT = {
  startAutomation: {
    title: "Start Study Session",
    summary: "Starts the full login to SCORM study flow.",
    what: "Runs the end-to-end sequence in the embedded browser and updates live runtime state.",
    when: "Use when credentials and settings are ready for a run.",
    safe: "No numeric value.",
    example: "Click Start Study Session after checking settings."
  },
  stopAutomation: {
    title: "Stop Safely",
    summary: "Stops with a safe exit attempt.",
    what: "Requests stop and tries to exit SCORM activity cleanly before idling.",
    when: "Use before closing app or changing key settings.",
    safe: "No numeric value.",
    example: "Click Stop Safely, then wait for idle."
  },
  username: {
    title: "Username",
    summary: "GoLearn account identifier for login.",
    what: "Used in automated login form filling.",
    when: "Change when switching accounts.",
    safe: "Must match your real account username/email.",
    example: "you@example.com"
  },
  password: {
    title: "Password",
    summary: "GoLearn password stored encrypted locally.",
    what: "Used during automated authentication.",
    when: "Update after password change.",
    safe: "Keep secret; never share screenshots with this visible.",
    example: "Use your current account password."
  },
  baseUrl: {
    title: "Training URL",
    summary: "Main training landing page.",
    what: "Automation navigates here before opening courses.",
    when: "Only when platform route changes.",
    safe: "Use official full https URL.",
    example: "https://edu.golearn.gr/training/trainee/training"
  },
  loginUrl: {
    title: "Login URL",
    summary: "Initial auth page URL.",
    what: "First page loaded by the automation login step.",
    when: "Only when auth route changes.",
    safe: "Use official full https login URL.",
    example: "https://edu.golearn.gr/login?returnUrl=%2f"
  },
  dashboardPort: {
    title: "Dashboard Port",
    summary: "Local port used for runtime dashboard endpoints.",
    what: "Sets where local dashboard APIs are served.",
    when: "Change if port is in use.",
    safe: "1024-65535 recommended.",
    example: "3030"
  },
  headless: {
    title: "Headless",
    summary: "Run browser hidden or visible.",
    what: "Visible helps debugging; headless is background mode.",
    when: "Set false while troubleshooting.",
    safe: "false for debug, true for unattended runs.",
    example: "false"
  },
  slowMo: {
    title: "Slow Mo (ms)",
    summary: "Delay between automation actions.",
    what: "Higher values slow actions and can reduce timing issues.",
    when: "Increase if site behaves inconsistently.",
    safe: "100-600 typical.",
    example: "250"
  },
  timeoutMs: {
    title: "Timeout (ms)",
    summary: "Max wait per operation.",
    what: "Caps wait duration for selectors/navigation.",
    when: "Increase on slow network/site response.",
    safe: "30000-90000 typical.",
    example: "30000"
  },
  sessionMinMinutes: {
    title: "Session Min Minutes",
    summary: "Minimum randomized minutes for each SCORM session.",
    what: "Each session picks a random value between min and max.",
    when: "Increase if you want longer average sessions.",
    safe: "20-60 recommended.",
    example: "30"
  },
  sessionMaxMinutes: {
    title: "Session Max Minutes",
    summary: "Maximum randomized minutes for each SCORM session.",
    what: "Upper bound for per-session random duration.",
    when: "Increase for more variance and longer possible sessions.",
    safe: "Min <= Max, typical 30-70.",
    example: "50"
  },
  dailyLimitMinutes: {
    title: "Daily Limit Minutes",
    summary: "Daily total minute cap.",
    what: "Automation stops once this daily total is reached.",
    when: "Adjust daily target.",
    safe: "180-420 common.",
    example: "360"
  },
  validateSettings: {
    title: "Validate Settings",
    summary: "Checks settings before save.",
    what: "Runs basic required-field and numeric validations.",
    when: "Use after editing settings.",
    safe: "No numeric value.",
    example: "Click Validate before Save."
  },
  saveSettings: {
    title: "Save Settings",
    summary: "Persists settings and encrypted credentials.",
    what: "Writes settings used by future runs.",
    when: "Use after successful validation.",
    safe: "No numeric value.",
    example: "Save, then restart automation."
  }
};

const LESSON_SECTION_CONFIG = [
  { id: "3", targetHours: 29, lessonKey: "E1" },
  { id: "4", targetHours: 30, lessonKey: "E2" },
  { id: "5", targetHours: 30, lessonKey: "E3" },
  { id: "6", targetHours: 30, lessonKey: "E4" },
  { id: "7", targetHours: 30, lessonKey: "E5" }
];

const embeddedAutomation = {
  running: false,
  stopRequested: false,
  refreshIntervalId: null,
  webviewReady: false,
  webviewReadyPromise: null,
  webviewReadyResolver: null,
  webviewReadyRejector: null,
  navigationChain: Promise.resolve(),
  lastRequestedUrl: null
};
const runtimeDiagnostics = {
  currentStep: "-",
  lastSuccessfulStep: "-",
  retryCount: 0,
  lastSelectorFailure: "-",
  lastRecoveryAction: "-",
  recoveryAttempts: 0,
  lastStableCheckpoint: "-",
  heartbeatAt: null
};
const UX_TELEMETRY_KEY = "dypa_ui_telemetry_v1";
const SETTINGS_PROFILES_KEY = "dypa_settings_profiles_v1";
const ONBOARDING_STATE_KEY = "dypa_onboarding_state_v1";
let lastActivatedTab = "dashboard";
const uiTelemetry = {
  actions: {},
  warnings: {},
  lastActionAt: null
};

const WEBVIEW_READY_TIMEOUT_MS = 60000;
let webviewLoadQueue = Promise.resolve();

function enqueueWebviewLoad(task) {
  const chained = webviewLoadQueue.then(task, task);
  webviewLoadQueue = chained.catch(() => null);
  return chained;
}

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

function fmtCountdown(targetIso) {
  if (!targetIso) return "-";
  const diffMs = new Date(targetIso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "-";
  if (diffMs <= 0) return "due";
  return fmtMinutes(Math.ceil(diffMs / 60000));
}

function formatScheduledForHuman(targetIso) {
  if (!targetIso) {
    return "-";
  }
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) {
    return targetIso;
  }
  const now = new Date();
  const isSameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate();
  const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isSameDay) {
    return `Today at ${time}`;
  }
  if (isTomorrow) {
    return `Tomorrow at ${time}`;
  }
  return fmtDate(targetIso);
}

function recordUiTelemetry(actionName, warningKey = null) {
  const key = String(actionName || "unknown");
  uiTelemetry.actions[key] = Number(uiTelemetry.actions[key] || 0) + 1;
  uiTelemetry.lastActionAt = new Date().toISOString();
  if (warningKey) {
    const warning = String(warningKey);
    uiTelemetry.warnings[warning] = Number(uiTelemetry.warnings[warning] || 0) + 1;
  }
  try {
    localStorage.setItem(UX_TELEMETRY_KEY, JSON.stringify(uiTelemetry));
  } catch {}
  window.desktopApi
    ?.appendLog?.({
      event: "ui_telemetry_action",
      action: key,
      warning: warningKey || null,
      tab: lastActivatedTab
    })
    .catch(() => {});
}

function loadUiTelemetry() {
  try {
    const raw = localStorage.getItem(UX_TELEMETRY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    uiTelemetry.actions = parsed.actions || {};
    uiTelemetry.warnings = parsed.warnings || {};
    uiTelemetry.lastActionAt = parsed.lastActionAt || null;
  } catch {}
}

function getMostFrequentEntry(mapLike = {}) {
  let topKey = null;
  let topCount = 0;
  for (const [key, count] of Object.entries(mapLike)) {
    if (Number(count) > topCount) {
      topKey = key;
      topCount = Number(count);
    }
  }
  return topKey ? { key: topKey, count: topCount } : null;
}

function getLessonDisplay(sectionId) {
  const lesson = LESSON_SECTION_CONFIG.find((entry) => entry.id === String(sectionId));
  return lesson ? `${lesson.lessonKey} • Section ${sectionId}` : `Section ${sectionId}`;
}

function getNextLessonHint(lessonTotals = {}) {
  const sequence = LESSON_SECTION_CONFIG.map((entry) => entry.id);
  let lastCompleted = null;
  for (const sectionId of sequence) {
    const lesson = lessonTotals[sectionId];
    const completed = Number(lesson?.completedMinutes || 0);
    const target = Number(lesson?.targetHours || 0) * 60;
    if (target > 0 && completed >= target) {
      lastCompleted = sectionId;
      continue;
    }
    if (target <= 0 || completed < target) {
      return `${lastCompleted ? `${getLessonDisplay(lastCompleted)} complete -> ` : ""}targeting ${getLessonDisplay(sectionId)} (${completed}/${target || 0} min)`;
    }
  }
  return "All configured lessons reached target.";
}

function getWebview() {
  return document.getElementById("embeddedBrowser");
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function randomIntInRange(min, max) {
  const safeMin = Math.ceil(Number(min) || 0);
  const safeMax = Math.floor(Number(max) || 0);
  if (safeMax <= safeMin) {
    return safeMin;
  }
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function getAthensDayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function waitForWebviewReady(timeoutMs = WEBVIEW_READY_TIMEOUT_MS) {
  if (embeddedAutomation.webviewReady) {
    return true;
  }

  if (embeddedAutomation.webviewReadyPromise) {
    return Promise.race([
      embeddedAutomation.webviewReadyPromise,
      new Promise((_, reject) => {
        window.setTimeout(() => {
          reject(new Error("Embedded browser did not become ready in time."));
        }, timeoutMs);
      })
    ]);
  }

  embeddedAutomation.webviewReadyPromise = new Promise((resolve, reject) => {
    embeddedAutomation.webviewReadyResolver = resolve;
    embeddedAutomation.webviewReadyRejector = reject;
  });

  return embeddedAutomation.webviewReadyPromise;
}

function getSafeWebviewUrl() {
  const webview = getWebview();

  try {
    if (embeddedAutomation.webviewReady) {
      return webview.getURL() || webview.src || "-";
    }
  } catch {}

  return webview.getAttribute("src") || webview.src || "-";
}

function ensureProgressShape(progressState) {
  const next = {
    startedAt: progressState.startedAt || new Date().toISOString(),
    baseSectionIndex: Number(progressState.baseSectionIndex) || 0,
    lessonDurationMinutes: Number(progressState.lessonDurationMinutes) || 60,
    scormSessionMinMinutes:
      Number.isFinite(Number(progressState.scormSessionMinMinutes)) && Number(progressState.scormSessionMinMinutes) > 0
        ? Number(progressState.scormSessionMinMinutes)
        : Number(progressState.scormSessionMinutes) > 0
          ? Number(progressState.scormSessionMinutes)
          : 30,
    scormSessionMaxMinutes:
      Number.isFinite(Number(progressState.scormSessionMaxMinutes)) && Number(progressState.scormSessionMaxMinutes) > 0
        ? Number(progressState.scormSessionMaxMinutes)
        : Number(progressState.scormSessionMinutes) > 0
          ? Number(progressState.scormSessionMinutes)
          : 45,
    dailyScormLimitMinutes:
      Number.isFinite(Number(progressState.dailyScormLimitMinutes)) && Number(progressState.dailyScormLimitMinutes) > 0
        ? Number(progressState.dailyScormLimitMinutes)
        : null,
    lastResolvedSectionId: progressState.lastResolvedSectionId || null,
    lastScormStartedAt: progressState.lastScormStartedAt || null,
    lastScormExitedAt: progressState.lastScormExitedAt || null,
    lessonProgress: progressState.lessonProgress || {},
    dailyProgress: progressState.dailyProgress || {
      date: getAthensDayKey(),
      completedMinutes: 0
    },
    sessionLedger: progressState.sessionLedger || { appliedKeys: {} },
    stateVersion: Number(progressState.stateVersion || 0)
  };

  for (const lesson of LESSON_SECTION_CONFIG) {
    if (!next.lessonProgress[lesson.id]) {
      next.lessonProgress[lesson.id] = {
        targetHours: lesson.targetHours,
        completedMinutes: 0,
        updatedAt: null
      };
    }
  }

  if (next.dailyProgress.date !== getAthensDayKey()) {
    next.dailyProgress = {
      date: getAthensDayKey(),
      completedMinutes: 0
    };
  }

  if (next.scormSessionMaxMinutes < next.scormSessionMinMinutes) {
    next.scormSessionMaxMinutes = next.scormSessionMinMinutes;
  }

  return next;
}

function ensureLedger(progressState) {
  if (!progressState.sessionLedger || typeof progressState.sessionLedger !== "object") {
    progressState.sessionLedger = { appliedKeys: {} };
  }
  if (!progressState.sessionLedger.appliedKeys || typeof progressState.sessionLedger.appliedKeys !== "object") {
    progressState.sessionLedger.appliedKeys = {};
  }
  return progressState.sessionLedger;
}

function applyLedgerCheckpoint(progressState, sessionId, checkpointKey, applyFn) {
  const ledger = ensureLedger(progressState);
  const key = `${String(sessionId || "unknown")}:${String(checkpointKey || "final")}`;
  if (ledger.appliedKeys[key]) {
    return false;
  }
  applyFn();
  ledger.appliedKeys[key] = new Date().toISOString();
  return true;
}

async function withRetry(fn, options = {}) {
  const retries = Number(options.retries || 2);
  const baseDelayMs = Number(options.baseDelayMs || 400);
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > retries) {
        throw error;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await appendLog("retry_attempt", {
        phase: options.phase || "unknown",
        attempt,
        delayMs,
        message: error.message || String(error)
      });
      await delay(delayMs);
    }
  }
  return null;
}

async function saveProgressStateSafe(progressState) {
  const expectedVersion = Number(progressState.stateVersion || 0);
  const response = await window.desktopApi.saveProgressStateVersioned({
    expectedVersion,
    state: progressState
  });
  if (response?.ok && response?.value) {
    Object.assign(progressState, response.value);
    return response.value;
  }
  await saveProgressStateSafe(progressState);
  progressState.stateVersion = expectedVersion + 1;
  return progressState;
}

function clampProgressInvariants(progressState) {
  const warnings = [];
  const dailyLimit = Number(progressState.dailyScormLimitMinutes || appConfig.dailyScormLimitMinutes || 0);
  const dailyCompleted = Number(progressState.dailyProgress?.completedMinutes || 0);
  if (!Number.isFinite(dailyCompleted) || dailyCompleted < 0) {
    progressState.dailyProgress.completedMinutes = 0;
    warnings.push({ type: "dailyProgress_invalid_or_negative_clamped" });
  } else if (dailyLimit > 0 && dailyCompleted > dailyLimit) {
    progressState.dailyProgress.completedMinutes = dailyLimit;
    warnings.push({ type: "dailyProgress_over_limit_clamped", dailyLimitMinutes: dailyLimit });
  }

  for (const [sectionId, lesson] of Object.entries(progressState.lessonProgress || {})) {
    const completedMinutes = Number(lesson.completedMinutes || 0);
    const targetMinutes = Number(lesson.targetHours || 0) * 60;
    if (!Number.isFinite(completedMinutes) || completedMinutes < 0) {
      lesson.completedMinutes = 0;
      warnings.push({ type: "lessonProgress_invalid_or_negative_clamped", sectionId });
      continue;
    }
    if (targetMinutes > 0 && completedMinutes > targetMinutes) {
      lesson.completedMinutes = targetMinutes;
      warnings.push({ type: "lessonProgress_over_target_clamped", sectionId, targetMinutes });
    }
  }
  return warnings;
}

async function appendLog(event, extra = {}) {
  if (String(event || "").includes("retry")) {
    runtimeDiagnostics.retryCount += 1;
  }
  if (event === "recovery_playbook_applied") {
    runtimeDiagnostics.lastRecoveryAction = extra.recoveryAction || "-";
    runtimeDiagnostics.recoveryAttempts = Number(runtimeDiagnostics.recoveryAttempts || 0) + 1;
  }
  if (event === "portal_drift_detected") {
    runtimeDiagnostics.lastSelectorFailure = (extra.missingSelectors || []).join(", ") || "-";
  }
  if (event === "progress_invariant_warning") {
    runtimeDiagnostics.lastSelectorFailure = extra.type || "progress_invariant_warning";
  }
  await window.desktopApi.appendLog({
    event,
    ...extra
  });

  // Optional: stream everything to Discord (batched by main process).
  const notif = currentSettings?.featureFlags?.notifications || DEFAULT_FEATURE_FLAGS.notifications;
  if (notif.discordWebhookEnabled && notif.discordVerbose) {
    const bits = [];
    if (extra?.sectionId) bits.push(`section=${extra.sectionId}`);
    if (extra?.chosenSessionMinutes) bits.push(`mins=${extra.chosenSessionMinutes}`);
    if (extra?.completedMinutesToday !== undefined) bits.push(`today=${extra.completedMinutesToday}`);
    if (extra?.dailyLimitMinutes !== undefined) bits.push(`limit=${extra.dailyLimitMinutes}`);
    if (extra?.nextWindowStartIso) bits.push(`next=${extra.nextWindowStartIso}`);
    const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
    const line = `${String(event || "event")}${suffix}`;
    await window.desktopApi
      .sendDiscordNotification({ kind: "trace", message: line })
      .catch(() => null);
  }
}

async function updateRuntimeState(patch, lastAction = null) {
  const nextPatch = {
    ...patch,
    processRunning: embeddedAutomation.running
  };
  const shouldRefreshHeartbeat =
    lastAction !== null || embeddedAutomation.running || patch?.processRunning === true;
  if (shouldRefreshHeartbeat) {
    runtimeDiagnostics.heartbeatAt = new Date().toISOString();
  }
  if (lastAction !== null) {
    nextPatch.lastAction = lastAction;
    runtimeDiagnostics.currentStep = lastAction;
    if (!/failed|error|timed out|missing/i.test(lastAction)) {
      runtimeDiagnostics.lastSuccessfulStep = lastAction;
      runtimeDiagnostics.lastStableCheckpoint = lastAction;
    }
  }
  nextPatch.runtimeDiagnostics = { ...runtimeDiagnostics };
  if (Object.prototype.hasOwnProperty.call(nextPatch, "status")) {
    const status = nextPatch.status;
    const { status: _ignored, ...restPatch } = nextPatch;
    const transitioned = await window.desktopApi.transitionState({
      status,
      patch: restPatch
    });
    if (!transitioned?.ok) {
      await window.desktopApi.updateState({
        ...restPatch,
        lastAction: `Blocked invalid transition ${transitioned?.from || "?"} -> ${transitioned?.to || "?"}`
      });
      return;
    }
    return;
  }
  await window.desktopApi.updateState(nextPatch);
}

function renderState(state, analytics = null) {
  lastRuntimeState = state || {};
  const status = state.status || "idle";
  const statusBadge = document.getElementById("statusBadge");
  statusBadge.className = `status ${status}`;
  statusBadge.textContent = status.toUpperCase();

  document.getElementById("currentLesson").textContent = state.currentLesson || "-";
  if (state.currentLesson) {
    document.getElementById("currentLesson").textContent = getLessonDisplay(state.currentLesson);
  }
  document.getElementById("currentLessonTitle").textContent = state.currentLessonTitle || "";
  const nextLessonHint = document.getElementById("nextLessonHint");
  if (nextLessonHint) {
    nextLessonHint.textContent = getNextLessonHint(state.lessonTotals || {});
  }
  document.getElementById("todayMinutes").textContent = state.todayMinutes ?? 0;
  document.getElementById("dailyLimit").textContent = `of ${state.dailyLimitMinutes ?? 0} planned`;
  document.getElementById("lastAction").textContent = state.lastAction || "-";
  document.getElementById("lastUpdatedAt").textContent = fmtDate(state.lastUpdatedAt);
  document.getElementById("botUrl").textContent = state.currentUrl || "-";
  document.getElementById("pausedText").textContent = String(Boolean(state.paused));
  document.getElementById("processRunningText").textContent = String(Boolean(state.processRunning));
  document.getElementById("nextExit").textContent = fmtDate(state.nextPlannedExitAt);
  const diagnostics = state.runtimeDiagnostics || runtimeDiagnostics;
  const scheduledRun = state.scheduledRun || {};
  const humanSchedulerStatus = (() => {
    const raw = String(scheduledRun.status || "idle")
      .replace(/_/g, " ")
      .trim();
    if (!raw) return "Idle";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  })();
  const currentStepText = diagnostics.currentStep || "Waiting";
  document.getElementById("diagCurrentStep").textContent = currentStepText;
  const diagSchedulerStatus = document.getElementById("diagSchedulerStatus");
  if (diagSchedulerStatus) {
    diagSchedulerStatus.textContent = humanSchedulerStatus;
  }
  const diagScheduledFor = document.getElementById("diagScheduledFor");
  if (diagScheduledFor) {
    diagScheduledFor.textContent = formatScheduledForHuman(scheduledRun.scheduledForIso);
  }
  const diagScheduleCountdown = document.getElementById("diagScheduleCountdown");
  if (diagScheduleCountdown) {
    diagScheduleCountdown.textContent = fmtCountdown(scheduledRun.scheduledForIso);
  }
  const diagLastSuccessfulStep = document.getElementById("diagLastSuccessfulStep");
  if (diagLastSuccessfulStep) {
    diagLastSuccessfulStep.textContent = diagnostics.lastSuccessfulStep || "-";
  }
  const diagRetryCount = document.getElementById("diagRetryCount");
  if (diagRetryCount) {
    diagRetryCount.textContent = String(diagnostics.retryCount || 0);
  }
  const diagLastSelectorFailure = document.getElementById("diagLastSelectorFailure");
  if (diagLastSelectorFailure) {
    diagLastSelectorFailure.textContent = diagnostics.lastSelectorFailure || "-";
  }
  const diagLastRecoveryAction = document.getElementById("diagLastRecoveryAction");
  if (diagLastRecoveryAction) {
    diagLastRecoveryAction.textContent = diagnostics.lastRecoveryAction || "-";
  }
  const diagRecoveryAttempts = document.getElementById("diagRecoveryAttempts");
  if (diagRecoveryAttempts) {
    diagRecoveryAttempts.textContent = String(diagnostics.recoveryAttempts || 0);
  }
  const diagLastStableCheckpoint = document.getElementById("diagLastStableCheckpoint");
  if (diagLastStableCheckpoint) {
    diagLastStableCheckpoint.textContent = diagnostics.lastStableCheckpoint || "-";
  }
  document.getElementById("diagHeartbeatAt").textContent = fmtDate(diagnostics.heartbeatAt);
  renderUxTelemetrySummary();
  const nextScheduledRun = document.getElementById("settingsNextScheduledRun");
  if (nextScheduledRun) {
    nextScheduledRun.textContent = scheduledRun.scheduledForIso
      ? `Next scheduled run: ${formatScheduledForHuman(scheduledRun.scheduledForIso)}`
      : "Next scheduled run: none";
  }
  const scheduledRunBadge = document.getElementById("scheduledRunBadge");
  if (scheduledRunBadge) {
    scheduledRunBadge.textContent = scheduledRun.scheduledForIso
      ? `Scheduled: ${formatScheduledForHuman(scheduledRun.scheduledForIso)}`
      : "No scheduled run";
  }
  maybeHandleScheduledTrigger(state);
  applyActionButtonStates(state, scheduledRun);

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
        <strong>${getLessonDisplay(sectionId)}</strong>
        <span class="muted">${lesson.targetHours || 0}h target</span>
      </div>
      <div class="muted">${completedMinutes} / ${targetMinutes} min</div>
      <div class="bar"><span style="width:${percent}%"></span></div>
    `;
    lessonTotalsRoot.appendChild(card);
  }

  const testTotalsRoot = document.getElementById("testTotals");
  if (testTotalsRoot) {
    testTotalsRoot.innerHTML = "";
    const tests = Array.isArray(state.testTotals) ? state.testTotals : [];
    for (const test of tests) {
      const completedMinutes = Number(test.completedMinutes || 0);
      const targetMinutes = Number(test.targetMinutes || 0);
      const percent = targetMinutes > 0 ? Math.min(100, (completedMinutes / targetMinutes) * 100) : 0;
      const card = document.createElement("div");
      card.className = "lesson-card test-card";
      card.innerHTML = `
        <div class="top">
          <strong>${String(test.title || "").trim() || "Test"}</strong>
          <span class="muted">${Math.round((targetMinutes / 60) * 100) / 100}h target</span>
        </div>
        <div class="muted">${completedMinutes} / ${targetMinutes} min</div>
        <div class="bar"><span style="width:${percent}%"></span></div>
      `;
      testTotalsRoot.appendChild(card);
    }
    if (tests.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No tests found in async stats panel.";
      testTotalsRoot.appendChild(empty);
    }
  }

  renderAnalytics(state, analytics);
}

function setButtonState(buttonId, options = {}) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  const {
    disabled = false,
    label = null,
    classes = null,
    title = null,
    ariaLabel = null
  } = options;
  button.disabled = Boolean(disabled);
  button.setAttribute("aria-disabled", String(Boolean(disabled)));
  if (typeof title === "string") {
    button.title = title;
  } else {
    button.removeAttribute("title");
  }
  if (typeof ariaLabel === "string" && ariaLabel.trim()) {
    button.setAttribute("aria-label", ariaLabel.trim());
  }
  if (typeof label === "string" && label.length > 0) {
    button.textContent = label;
  }
  if (Array.isArray(classes)) {
    button.className = `control-btn ${classes.join(" ").trim()}`.trim();
  }
}

function applyActionButtonStates(state, scheduledRun = {}) {
  const isAutomationRunning = Boolean(state?.processRunning);
  const scheduledStatus = String(scheduledRun?.status || "idle");
  const hasScheduledRun = Boolean(
    scheduledRun?.scheduledForIso &&
      !["idle", "cleared", "consumed", "skipped_running"].includes(scheduledStatus)
  );

  const canSetSchedule = !isAutomationRunning && !hasScheduledRun;
  const canCancelSchedule = hasScheduledRun;
  const canStartNow = !isAutomationRunning;
  const canStopNow = isAutomationRunning;
  const stopDisabledReason = hasScheduledRun && !isAutomationRunning
    ? "Stop is available only while a session is running. Use Cancel Scheduled Run."
    : "Nothing is currently running.";
  const stopLabel = "Stop Safely";
  const quickStopLabel = "Stop Automation";

  setButtonState("startBotBtn", {
    disabled: !canStartNow,
    label: "Start Study Session",
    classes: ["primary"]
  });
  setButtonState("quickStartBtn", {
    disabled: !canStartNow,
    label: "Start Automation",
    classes: ["primary"]
  });
  setButtonState("stopBotBtn", {
    disabled: !canStopNow,
    label: stopLabel,
    classes: ["danger"],
    title: canStopNow ? "Stop the active automation session safely." : stopDisabledReason,
    ariaLabel: canStopNow ? stopLabel : `${stopLabel}. ${stopDisabledReason}`
  });
  setButtonState("quickStopBtn", {
    disabled: !canStopNow,
    label: quickStopLabel,
    classes: ["danger"],
    title: canStopNow ? "Stop the active automation session." : stopDisabledReason,
    ariaLabel: canStopNow ? quickStopLabel : `${quickStopLabel}. ${stopDisabledReason}`
  });

  setButtonState("runAtTimeBtn", {
    disabled: !canSetSchedule,
    label: hasScheduledRun ? "Scheduled" : "Run at this time",
    classes: ["success"]
  });
  setButtonState("cancelScheduledRunBtn", {
    disabled: !canCancelSchedule,
    label: "Cancel Scheduled Run",
    classes: ["danger"]
  });

  const scheduleActionHint = document.getElementById("scheduleActionHint");
  if (scheduleActionHint) {
    scheduleActionHint.classList.remove("schedule-hint-neutral", "schedule-hint-success");
    if (hasScheduledRun) {
      const runLabel = formatScheduledForHuman(scheduledRun.scheduledForIso);
      const timeLeftLabel = fmtCountdown(scheduledRun.scheduledForIso);
      scheduleActionHint.textContent = `Scheduled for ${runLabel} (${timeLeftLabel}). Use Cancel Scheduled Run to remove it.`;
      scheduleActionHint.classList.add("schedule-hint-success");
    } else if (isAutomationRunning) {
      scheduleActionHint.textContent = "Scheduling is disabled while automation is running.";
      scheduleActionHint.classList.add("schedule-hint-neutral");
    } else {
      scheduleActionHint.textContent = "No scheduled run.";
      scheduleActionHint.classList.add("schedule-hint-neutral");
    }
  }

  const stopActionHint = document.getElementById("stopActionHint");
  if (stopActionHint) {
    stopActionHint.classList.remove("schedule-hint-neutral", "schedule-hint-success");
    stopActionHint.textContent = canStopNow ? "Automation is running. You can stop safely now." : stopDisabledReason;
    stopActionHint.classList.add(canStopNow ? "schedule-hint-success" : "schedule-hint-neutral");
  }
  const quickStopHint = document.getElementById("quickStopHint");
  if (quickStopHint) {
    quickStopHint.classList.remove("schedule-hint-neutral", "schedule-hint-success");
    quickStopHint.textContent = canStopNow ? "Automation is running. Stop is available." : stopDisabledReason;
    quickStopHint.classList.add(canStopNow ? "schedule-hint-success" : "schedule-hint-neutral");
  }

  const syncStatsBtn = document.getElementById("syncStatsBtn");
  if (syncStatsBtn) {
    syncStatsBtn.disabled = isAutomationRunning;
    syncStatsBtn.setAttribute("aria-disabled", String(Boolean(isAutomationRunning)));
  }
}

function renderUxTelemetrySummary() {
  const summary = document.getElementById("uxTelemetrySummary");
  const lastAction = document.getElementById("lastSuccessfulUiAction");
  const frequentWarning = document.getElementById("mostFrequentUiWarning");
  if (!summary || !lastAction || !frequentWarning) return;
  const topAction = getMostFrequentEntry(uiTelemetry.actions);
  const topWarning = getMostFrequentEntry(uiTelemetry.warnings);
  lastAction.textContent = uiTelemetry.lastActionAt
    ? `Last action: ${fmtDate(uiTelemetry.lastActionAt)}`
    : "Last action: -";
  frequentWarning.textContent = topWarning
    ? `Most frequent warning: ${topWarning.key} (${topWarning.count})`
    : "Most frequent warning: -";
  summary.textContent = topAction
    ? `Top interaction: ${topAction.key} (${topAction.count} uses).`
    : "No local UX activity yet.";
}

function getFilteredLogs(logs) {
  const filterValue = (document.getElementById("logFilter")?.value || "").trim().toLowerCase();
  return logs.filter((log) => {
    const { group } = classifyLog(log);
    if (activeLogGroup !== "all" && group !== activeLogGroup) {
      return false;
    }
    if (!filterValue) {
      return true;
    }
    return `${log.event || ""} ${log.message || ""} ${log.url || ""} ${log.reason || ""}`
      .toLowerCase()
      .includes(filterValue);
  });
}

function renderLogs(logs) {
  const filteredLogs = getFilteredLogs(logs);
  const root = document.getElementById("logs");
  root.innerHTML = "";
  if (filteredLogs.length === 0) {
    root.innerHTML = '<div class="muted">No logs match current filters.</div>';
    return;
  }
  for (const log of filteredLogs) {
    const { severity, group } = classifyLog(log);
    const el = document.createElement("div");
    el.className = `log severity-${severity}`;
    el.innerHTML = `
      <div><strong>${log.event || "event"}</strong> <span class="muted">[${group}] ${fmtDate(log.timestamp)}</span> <span class="risk-badge risk-${severity === "error" ? "high" : severity === "warn" ? "medium" : "low"}">${severity}</span></div>
      <div class="muted mono">${log.url || log.message || log.reason || ""}</div>
    `;
    root.appendChild(el);
  }
}

async function handleRunAtTime() {
  const runAtLocalTime = String(document.getElementById("scheduleTimeInput")?.value || "").trim();
  const response = await window.desktopApi.setScheduledRun({ runAtLocalTime });
  if (!response?.ok) {
    const reason = response?.reason || "invalid_time_format";
    setSettingsFeedback(
      reason === "already_scheduled"
        ? "A scheduled run is already pending. Cancel it first."
        : "Invalid time format. Use HH:mm.",
      true
    );
    recordUiTelemetry("schedule_set_failed", reason);
    return;
  }
  setSettingsFeedback(`Scheduled run set for ${fmtDate(response.scheduledRun?.scheduledForIso)}.`);
  recordUiTelemetry("schedule_set");
  await refreshDashboard();
}

async function handleCancelScheduledRun() {
  const response = await window.desktopApi.clearScheduledRun();
  if (!response?.ok) {
    setSettingsFeedback("Could not cancel scheduled run.", true);
    return;
  }
  setSettingsFeedback("Scheduled run cancelled.");
  recordUiTelemetry("schedule_cancelled");
  await refreshDashboard();
}

function setAutomationScheduleFeedback(message, isError = false) {
  const el = document.getElementById("automationScheduleFeedback");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("schedule-hint-danger", Boolean(isError));
  el.classList.toggle("schedule-hint-neutral", !isError);
}

function buildAllowedWindowsCsvFromAutomationInputs() {
  const normalizeTime = (value) => {
    const raw = String(value || "").trim();
    const hhmmss = raw.match(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/);
    return hhmmss ? `${hhmmss[1]}:${hhmmss[2]}` : raw;
  };
  const nightStart = String(document.getElementById("automationNightStart")?.value || "").trim();
  const nightEnd = String(document.getElementById("automationNightEnd")?.value || "").trim();
  const eveningStart = String(document.getElementById("automationEveningStart")?.value || "").trim();
  const eveningEnd = String(document.getElementById("automationEveningEnd")?.value || "").trim();
  const tokens = [];
  const nStart = normalizeTime(nightStart);
  const nEnd = normalizeTime(nightEnd);
  const eStart = normalizeTime(eveningStart);
  const eEnd = normalizeTime(eveningEnd);
  if (nStart && nEnd) tokens.push(`${nStart}-${nEnd}`);
  if (eStart && eEnd) tokens.push(`${eStart}-${eEnd}`);
  return {
    allowedWindowsCsv: tokens.join(","),
    runAtLocalTime: nStart || eStart || "00:00"
  };
}

async function handleApplyAutomationSchedule() {
  const enabled = Boolean(document.getElementById("automationSchedulerEnabled")?.checked);
  if (!enabled) {
    setAutomationScheduleFeedback("Enable the checkbox first, then click Apply & Enable.", true);
    return;
  }

  const { allowedWindowsCsv, runAtLocalTime } = buildAllowedWindowsCsvFromAutomationInputs();
  const dailyLimit = Number(document.getElementById("automationDailyLimitMinutes")?.value || 0);
  const nightTargetMinutes = Number(document.getElementById("automationNightTargetMinutes")?.value || 0);
  const nightJitterMinutes = Number(document.getElementById("automationNightJitterMinutes")?.value || 0);

  // Keep Settings tab and Automation tab in sync by writing into settings inputs,
  // then reusing the existing save pipeline.
  const windowsInput = document.getElementById("settingsAllowedWindowsCsv");
  if (windowsInput) windowsInput.value = allowedWindowsCsv;
  const dailyLimitInput = document.getElementById("settingsDailyLimitMinutes");
  if (dailyLimitInput && Number.isFinite(dailyLimit) && dailyLimit >= 0) {
    dailyLimitInput.value = String(dailyLimit);
  }
  const defaultRunAt = document.getElementById("settingsDefaultRunAtTime");
  if (defaultRunAt) {
    defaultRunAt.value = runAtLocalTime;
  }
  const nightTargetInput = document.getElementById("settingsNightTargetMinutes");
  if (nightTargetInput && Number.isFinite(nightTargetMinutes) && nightTargetMinutes >= 0) {
    nightTargetInput.value = String(nightTargetMinutes);
  }
  const nightJitterInput = document.getElementById("settingsNightJitterMinutes");
  if (nightJitterInput && Number.isFinite(nightJitterMinutes) && nightJitterMinutes >= 0) {
    nightJitterInput.value = String(nightJitterMinutes);
  }

  const saved = await handleSaveSettings().catch(() => null);
  if (saved === null) {
    // handleSaveSettings already reports errors to Settings feedback; mirror a short hint here.
    setAutomationScheduleFeedback("Could not save settings. Open Settings tab for details.", true);
    return;
  }

  const scheduleResponse = await window.desktopApi.setScheduledRun({ runAtLocalTime }).catch(() => null);
  if (!scheduleResponse?.ok) {
    setAutomationScheduleFeedback(
      scheduleResponse?.reason === "already_scheduled"
        ? "A scheduled run is already pending. Disable it first."
        : "Could not enable scheduler (invalid time).",
      true
    );
    return;
  }

  setAutomationScheduleFeedback(
    scheduleResponse?.scheduledRun?.scheduledForIso
      ? `Enabled. Next run: ${fmtDate(scheduleResponse.scheduledRun.scheduledForIso)}`
      : "Enabled."
  );
  await refreshDashboard();
}

async function handleDisableAutomationSchedule() {
  document.getElementById("automationSchedulerEnabled")?.setAttribute("disabled", "disabled");
  const response = await window.desktopApi.clearScheduledRun().catch(() => null);
  document.getElementById("automationSchedulerEnabled")?.removeAttribute("disabled");
  if (!response?.ok) {
    setAutomationScheduleFeedback("Could not disable scheduler.", true);
    return;
  }
  const checkbox = document.getElementById("automationSchedulerEnabled");
  if (checkbox) checkbox.checked = false;
  setAutomationScheduleFeedback("Scheduler disabled.");
  await refreshDashboard();
}

async function maybeHandleScheduledTrigger(state) {
  const scheduledRun = state?.scheduledRun || {};
  if (scheduledRun.status !== "triggered_pending_ui" || !scheduledRun.triggerToken) {
    return;
  }
  if (scheduledRun.triggerToken === lastHandledScheduleTriggerToken) {
    return;
  }
  lastHandledScheduleTriggerToken = scheduledRun.triggerToken;
  await appendLog("schedule_triggered_ui_starting", {
    triggerToken: scheduledRun.triggerToken,
    scheduledForIso: scheduledRun.scheduledForIso || null
  });
  if (!embeddedAutomation.running) {
    await handleStartBot().catch(() => null);
  }
  await window.desktopApi.consumeScheduledTrigger({ triggerToken: scheduledRun.triggerToken }).catch(() => null);
}

async function refreshDashboard() {
  const [state, logs, analytics] = await Promise.all([
    window.desktopApi.getState(),
    window.desktopApi.getLogs(),
    window.desktopApi.getAnalytics().catch(() => null)
  ]);
  fullLogs = logs;
  renderState(state, analytics);
  renderLogs(logs);
  renderRunHealth();
  renderValidationAssistant();

  const reachedLimit = Number(state.todayMinutes || 0) >= Number(state.dailyLimitMinutes || 0) && Number(state.dailyLimitMinutes || 0) > 0;
  if (reachedLimit) {
    maybeNotify("Daily limit reached.", "limits");
  }

  const hasErrorLog = [...logs].reverse().some((log) => classifyLog(log).severity === "error");
  if (hasErrorLog) {
    maybeNotify("Recent automation error detected. Check Run Health and Logs.", "errors");
  }

  // Keep scheduler panel feedback roughly in sync.
  const automationEnabled = Boolean(document.getElementById("automationSchedulerEnabled")?.checked);
  if (!automationEnabled) {
    setAutomationScheduleFeedback(
      state?.scheduledRun?.enabled && state?.scheduledRun?.scheduledForIso
        ? `Enabled. Next run: ${fmtDate(state.scheduledRun.scheduledForIso)}`
        : "Scheduler is not enabled."
    );
  }
}

async function handleTestDiscordWebhook() {
  const result = await window.desktopApi.testDiscordWebhook().catch(() => null);
  if (!result?.ok) {
    setSettingsFeedback(
      result && result.enabled && result.hasUrl
        ? "Discord ping failed. Check webhook URL and network."
        : "Discord is not enabled (toggle it + add URL, then Save Settings).",
      true
    );
    return;
  }
  setSettingsFeedback("Discord ping sent. Check your Discord channel.");
}

function getSettingsFromForm() {
  return {
    ...currentSettings,
    featureFlags: {
      ...(currentSettings?.featureFlags || DEFAULT_FEATURE_FLAGS),
      notifications: {
        enabled: Boolean(document.getElementById("notifEnabled")?.checked),
        startStop: Boolean(document.getElementById("notifStartStop")?.checked),
        errors: Boolean(document.getElementById("notifErrors")?.checked),
        limits: Boolean(document.getElementById("notifLimits")?.checked),
        validation: Boolean(document.getElementById("notifValidation")?.checked),
        discordWebhookEnabled: Boolean(document.getElementById("notifDiscordEnabled")?.checked),
        discordWebhookUrl: String(document.getElementById("discordWebhookUrl")?.value || "").trim(),
        discordVerbose: Boolean(document.getElementById("notifDiscordVerbose")?.checked),
        discordVerboseFlushSeconds: Number(document.getElementById("notifDiscordVerboseFlushSeconds")?.value || 20) || 20
      },
      logging: {
        verboseWebviewConsole: Boolean(document.getElementById("verboseWebviewConsole")?.checked)
      },
      ui: {
        simpleMode: Boolean(document.getElementById("settingsSimpleMode")?.checked),
        lightTheme: Boolean(document.getElementById("settingsLightTheme")?.checked)
      },
      navigation: {
        directCourseMode: Boolean(document.getElementById("settingsDirectCourseMode")?.checked)
      }
    },
    scheduler: {
      defaultRunAtLocalTime: String(document.getElementById("settingsDefaultRunAtTime")?.value || "17:40"),
      allowedWindowsCsv: String(document.getElementById("settingsAllowedWindowsCsv")?.value || "").trim(),
      nightTargetMinutes: Number(document.getElementById("settingsNightTargetMinutes")?.value || 0) || 0,
      nightJitterMinutes: Number(document.getElementById("settingsNightJitterMinutes")?.value || 0) || 0
    },
    credentials: {
      username: document.getElementById("settingsUsername").value.trim(),
      password: document.getElementById("settingsPassword").value
    },
    baseUrl: currentSettings?.baseUrl || appConfig?.trainingUrl || "",
    loginUrl: currentSettings?.loginUrl || appConfig?.loginUrl || "",
    dashboardPort: Number(document.getElementById("settingsDashboardPort").value || 0),
    headless: document.getElementById("settingsHeadless").value === "true",
    slowMo: Number(document.getElementById("settingsSlowMo").value || 0),
    timeoutMs: Number(document.getElementById("settingsTimeoutMs").value || 0),
    scormSessionMinMinutes: Number(document.getElementById("settingsSessionMinMinutes").value || 0),
    scormSessionMaxMinutes: Number(document.getElementById("settingsSessionMaxMinutes").value || 0),
    maxScormSessionMinutes: Number(document.getElementById("settingsSessionMaxMinutes").value || 0),
    dailyScormLimitMinutes: Number(document.getElementById("settingsDailyLimitMinutes").value || 0)
  };
}

function applyUiPreferences(settingsLike) {
  const uiFlags = settingsLike?.featureFlags?.ui || DEFAULT_FEATURE_FLAGS.ui;
  const simpleMode = Boolean(uiFlags.simpleMode);
  const lightTheme = Boolean(uiFlags.lightTheme);
  const body = document.body;
  if (!body) return;
  body.classList.toggle("simple-mode", simpleMode);
  body.classList.toggle("theme-light", lightTheme);

  if (simpleMode) {
    const activeIsHidden = document.querySelector(".nav-btn.nav-active.dev-only");
    if (activeIsHidden) {
      document.querySelector('.nav-btn[data-tab="settings"]')?.click();
    }
  }
}

function setSettingsFeedback(message, isError = false) {
  const feedback = document.getElementById("settingsFeedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.remove("feedback-error", "feedback-success");
  feedback.classList.add(isError ? "feedback-error" : "feedback-success");
}

function updateRiskBadges() {
  const timeoutMs = Number(document.getElementById("settingsTimeoutMs").value || 0);
  const sessionMinMinutes = Number(document.getElementById("settingsSessionMinMinutes").value || 0);
  const sessionMaxMinutes = Number(document.getElementById("settingsSessionMaxMinutes").value || 0);
  const dailyLimit = Number(document.getElementById("settingsDailyLimitMinutes").value || 0);
  const slowMo = Number(document.getElementById("settingsSlowMo").value || 0);
  const port = Number(document.getElementById("settingsDashboardPort").value || 0);

  const setRisk = (id, level) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `risk-badge risk-${level}`;
    el.textContent = level;
  };

  setRisk("riskTimeoutMs", timeoutMs < 15000 ? "high" : timeoutMs < 30000 ? "medium" : "low");
  const sessionMinRisk = sessionMinMinutes < 15 ? "high" : sessionMinMinutes > 60 ? "medium" : "low";
  const sessionMaxRisk = sessionMaxMinutes < sessionMinMinutes || sessionMaxMinutes > 90 ? "high" : sessionMaxMinutes > 70 ? "medium" : "low";
  setRisk("riskSessionMinMinutes", sessionMinRisk);
  setRisk("riskSessionMaxMinutes", sessionMaxRisk);
  setRisk("riskDailyLimit", dailyLimit > 480 || dailyLimit < 120 ? "high" : dailyLimit > 360 ? "medium" : "low");
  setRisk("riskSlowMo", slowMo > 700 ? "medium" : "low");
  setRisk("riskDashboardPort", port < 1024 || port > 65535 ? "high" : "low");
  const summary = document.getElementById("settingsRiskSummary");
  if (summary) {
    const levels = [
      timeoutMs < 15000 ? "high" : timeoutMs < 30000 ? "medium" : "low",
      sessionMinRisk,
      sessionMaxRisk,
      dailyLimit > 480 || dailyLimit < 120 ? "high" : dailyLimit > 360 ? "medium" : "low",
      slowMo > 700 ? "medium" : "low",
      port < 1024 || port > 65535 ? "high" : "low"
    ];
    const hasHigh = levels.includes("high");
    const hasMedium = levels.includes("medium");
    summary.className = `settings-risk-summary ${hasHigh ? "risk-high" : hasMedium ? "risk-medium" : "risk-low"}`;
    summary.textContent = hasHigh
      ? "Needs attention: some values may cause unstable runs."
      : hasMedium
        ? "Mostly good: consider reviewing one or two values."
        : "Looks good for everyday use.";
  }
  updateRangeValidationHint();
}

function updateRangeValidationHint() {
  const hint = document.getElementById("rangeValidationHint");
  const autoSwapButton = document.getElementById("autoSwapRangeBtn");
  if (!hint || !autoSwapButton) return;
  const min = Number(document.getElementById("settingsSessionMinMinutes").value || 0);
  const max = Number(document.getElementById("settingsSessionMaxMinutes").value || 0);
  hint.classList.remove("is-valid", "is-invalid");
  autoSwapButton.classList.remove("range-fix-needed");
  if (min > 0 && max > 0 && min > max) {
    hint.textContent = "Maximum Minutes must be greater than or equal to Minimum Minutes.";
    hint.classList.add("is-invalid");
    autoSwapButton.classList.add("range-fix-needed");
    autoSwapButton.disabled = false;
    return;
  }
  hint.textContent = "Session range looks good.";
  hint.classList.add("is-valid");
  autoSwapButton.disabled = true;
}

function autoSwapSessionRange() {
  const minInput = document.getElementById("settingsSessionMinMinutes");
  const maxInput = document.getElementById("settingsSessionMaxMinutes");
  const min = Number(minInput.value || 0);
  const max = Number(maxInput.value || 0);
  if (min > max) {
    minInput.value = String(max);
    maxInput.value = String(min);
    setSettingsFeedback("Minimum and Maximum minutes were fixed automatically.");
  }
  updateRiskBadges();
  renderSettingsPreview();
}

function applyPreset(mode) {
  const presets = {
    safe: { slowMo: 250, scormSessionMinMinutes: 38, scormSessionMaxMinutes: 41, timeoutMs: 30000, dailyScormLimitMinutes: 350, headless: false },
    balanced: { slowMo: 250, scormSessionMinMinutes: 30, scormSessionMaxMinutes: 45, timeoutMs: 30000, dailyScormLimitMinutes: 360, headless: false },
    fast: { slowMo: 80, scormSessionMinMinutes: 35, scormSessionMaxMinutes: 55, timeoutMs: 20000, dailyScormLimitMinutes: 420, headless: true }
  };
  const preset = presets[mode];
  if (!preset) return;

  document.getElementById("settingsSlowMo").value = preset.slowMo;
  document.getElementById("settingsTimeoutMs").value = preset.timeoutMs;
  document.getElementById("settingsSessionMinMinutes").value = preset.scormSessionMinMinutes;
  document.getElementById("settingsSessionMaxMinutes").value = preset.scormSessionMaxMinutes;
  document.getElementById("settingsDailyLimitMinutes").value = preset.dailyScormLimitMinutes;
  document.getElementById("settingsHeadless").value = String(preset.headless);
  updateRiskBadges();
  renderSettingsPreview();
  const label = mode === "safe" ? "Recommended (Safe)" : mode === "balanced" ? "Balanced" : "Fast";
  setSettingsFeedback(`${label} setup applied.`);
  recordUiTelemetry(`preset_${mode}`);
}

function loadSavedProfiles() {
  try {
    const raw = localStorage.getItem(SETTINGS_PROFILES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function persistSavedProfiles(profiles) {
  try {
    localStorage.setItem(SETTINGS_PROFILES_KEY, JSON.stringify(profiles));
  } catch {}
}

function renderSavedProfilesSelect() {
  const select = document.getElementById("savedProfilesSelect");
  if (!select) return;
  const profiles = loadSavedProfiles();
  const keys = Object.keys(profiles).sort();
  select.innerHTML = `<option value="">Select profile</option>${keys
    .map((key) => `<option value="${key}">${key}</option>`)
    .join("")}`;
}

function saveCurrentProfile() {
  const nameInput = document.getElementById("settingsProfileName");
  const name = String(nameInput?.value || "").trim();
  if (!name) {
    setSettingsFeedback("Enter a profile name before saving.", true);
    return;
  }
  const profiles = loadSavedProfiles();
  profiles[name] = getSettingsFromForm();
  persistSavedProfiles(profiles);
  renderSavedProfilesSelect();
  setSettingsFeedback(`Profile saved: ${name}.`);
  recordUiTelemetry("save_profile");
}

function applySavedProfile() {
  const select = document.getElementById("savedProfilesSelect");
  const selected = String(select?.value || "").trim();
  if (!selected) {
    setSettingsFeedback("Choose a saved profile before applying.", true);
    return;
  }
  const profiles = loadSavedProfiles();
  const profile = profiles[selected];
  if (!profile) {
    setSettingsFeedback("That saved profile was not found.", true);
    return;
  }
  fillSettingsForm(profile);
  setSettingsFeedback(`Profile applied: ${selected}.`);
  recordUiTelemetry("apply_profile");
}

function renderSettingsPreview() {
  const next = getSettingsFromForm();
  const preview = document.getElementById("settingsPreview");
  const previewBtn = document.getElementById("previewSettingsBtn");
  if (!preview || !currentSettings) {
    return;
  }

  const changes = [];
  const pushIfChanged = (label, oldValue, newValue) => {
    if (String(oldValue ?? "") !== String(newValue ?? "")) {
      changes.push(`${label}: ${oldValue ?? "-"} -> ${newValue ?? "-"}`);
    }
  };

  pushIfChanged("Username", currentSettings.credentials?.username, next.credentials?.username);
  pushIfChanged("Dashboard Port", currentSettings.dashboardPort, next.dashboardPort);
  pushIfChanged("Headless", currentSettings.headless, next.headless);
  pushIfChanged("Slow Mo", currentSettings.slowMo, next.slowMo);
  pushIfChanged("Timeout", currentSettings.timeoutMs, next.timeoutMs);
  pushIfChanged("Session Min Minutes", currentSettings.scormSessionMinMinutes, next.scormSessionMinMinutes);
  pushIfChanged("Session Max Minutes", currentSettings.scormSessionMaxMinutes, next.scormSessionMaxMinutes);
  pushIfChanged("Daily Limit", currentSettings.dailyScormLimitMinutes, next.dailyScormLimitMinutes);
  pushIfChanged(
    "Direct Course Mode",
    Boolean(currentSettings.featureFlags?.navigation?.directCourseMode),
    Boolean(next.featureFlags?.navigation?.directCourseMode)
  );
  if ((next.credentials?.password || "") !== (currentSettings.credentials?.password || "")) {
    changes.push("Password: changed");
  }

  preview.innerHTML =
    changes.length > 0 ? changes.map((line) => `<div>${line}</div>`).join("") : "<div>No unsaved changes.</div>";
  preview.classList.toggle("hidden-preview", !settingsPreviewExpanded);
  if (previewBtn) {
    previewBtn.textContent = settingsPreviewExpanded ? "Hide Change Details" : "Show Change Details";
  }
  const safetyWarning = document.getElementById("settingsSafetyWarning");
  if (safetyWarning) {
    const hasUnsafeChange =
      Number(next.dailyScormLimitMinutes || 0) > 480 ||
      Number(next.timeoutMs || 0) < 15000 ||
      Number(next.scormSessionMaxMinutes || 0) > 90;
    safetyWarning.classList.toggle("visible", hasUnsafeChange);
    safetyWarning.textContent = hasUnsafeChange
      ? "Heads up: one or more settings may increase failure risk. Review Page Wait Time, Maximum Minutes, and Daily Target."
      : "";
  }
}

function toggleSettingsPreview() {
  settingsPreviewExpanded = !settingsPreviewExpanded;
  renderSettingsPreview();
}

function classifyLog(log) {
  const event = String(log.event || "").toLowerCase();
  const message = String(log.message || "").toLowerCase();
  if (event.includes("recovery") || event.includes("supervisor_step_failed")) {
    return { severity: "warn", group: "system" };
  }
  if (
    event.includes("webview_console_message") &&
    (message.includes("server timeout elapsed without receiving a message from the server") ||
      message.includes("websocket connected to wss://") ||
      message.includes("normalizing '_blazor'"))
  ) {
    return { severity: "info", group: "system" };
  }
  if (event.includes("error") || event.includes("failed") || message.includes("error")) {
    return { severity: "error", group: "errors" };
  }
  if (event.includes("login") || event.includes("auth")) {
    return { severity: "info", group: "auth" };
  }
  if (event.includes("scorm") || event.includes("section")) {
    return { severity: "info", group: "scorm" };
  }
  if (event.includes("settings") || event.includes("validation")) {
    return { severity: "warn", group: "settings" };
  }
  return { severity: "info", group: "system" };
}

function createValidationWarnings(candidate = getSettingsFromForm()) {
  const warnings = [];
  if (!candidate.credentials?.username || !candidate.credentials?.password) {
    warnings.push({
      id: "missing-creds",
      text: "Username or password is missing.",
      fix: () => {
        document.getElementById("settingsUsername").focus();
      }
    });
  }
  if (candidate.timeoutMs < 15000) {
    warnings.push({
      id: "timeout-low",
      text: "Page Wait Time is very low and may cause failures.",
      fix: () => {
        document.getElementById("settingsTimeoutMs").value = 30000;
      }
    });
  }
  if (candidate.scormSessionMinMinutes <= 0 || candidate.scormSessionMaxMinutes <= 0) {
    warnings.push({
      id: "session-range-positive",
      text: "Minimum and Maximum Minutes must be above zero.",
      fix: () => {
        document.getElementById("settingsSessionMinMinutes").value = 30;
        document.getElementById("settingsSessionMaxMinutes").value = 45;
      }
    });
  }
  if (candidate.scormSessionMaxMinutes < candidate.scormSessionMinMinutes) {
    warnings.push({
      id: "session-range-order",
      text: "Maximum Minutes must be equal to or greater than Minimum Minutes.",
      fix: () => {
        document.getElementById("settingsSessionMaxMinutes").value =
          Math.max(candidate.scormSessionMinMinutes || 30, 45);
      }
    });
  }
  if (candidate.dailyScormLimitMinutes < candidate.scormSessionMinMinutes) {
    warnings.push({
      id: "daily-vs-session",
      text: "Daily Target is lower than Minimum Minutes.",
      fix: () => {
        document.getElementById("settingsDailyLimitMinutes").value = Math.max(
          candidate.scormSessionMinMinutes,
          120
        );
      }
    });
  }
  if (candidate.dashboardPort < 1024 || candidate.dashboardPort > 65535) {
    warnings.push({
      id: "port-range",
      text: "Dashboard Port should be between 1024 and 65535.",
      fix: () => {
        document.getElementById("settingsDashboardPort").value = 3030;
      }
    });
  }
  return warnings;
}

function renderValidationAssistant() {
  const root = document.getElementById("validationAssistant");
  if (!root) return;
  const warnings = createValidationWarnings();
  if (warnings.length === 0) {
    root.innerHTML = '<div class="muted">Everything looks ready.</div>';
    return;
  }
  const visibleWarnings = warnings.slice(0, 2);

  root.innerHTML = visibleWarnings
    .map(
      (warning, index) => `
      <div class="assistant-item">
        <div>${warning.text}</div>
        <button class="control-btn" type="button" data-fix-index="${index}">Apply fix</button>
      </div>
    `
    )
    .join("") + (warnings.length > 2 ? `<div class="muted">+${warnings.length - 2} more checks not shown.</div>` : "");

  Array.from(root.querySelectorAll("[data-fix-index]")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const warning = visibleWarnings[Number(btn.getAttribute("data-fix-index"))];
      warning.fix();
      updateRiskBadges();
      renderSettingsPreview();
      renderValidationAssistant();
      maybeNotify("Validation auto-fix applied.", "validation");
    });
  });
}

function exportCurrentLogs() {
  const format = document.getElementById("exportFormat")?.value || "json";
  const filteredOnly = Boolean(document.getElementById("exportFilteredOnly")?.checked);
  const logsToExport = filteredOnly ? getFilteredLogs(fullLogs) : fullLogs;
  const output =
    format === "jsonl"
      ? logsToExport.map((entry) => JSON.stringify(entry)).join("\n")
      : JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            format,
            filteredOnly,
            logCount: logsToExport.length,
            logs: logsToExport
          },
          null,
          2
        );
  const extension = format === "jsonl" ? "jsonl" : "json";
  const mime = format === "jsonl" ? "text/plain" : "application/json";
  Promise.resolve().then(() => {
    const blob = new Blob([output], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dypa-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  });
  recordUiTelemetry("export_logs");
}

async function exportSupportBundle() {
  const bundle = await window.desktopApi.exportSupportBundle();
  const output = JSON.stringify(bundle, null, 2);
  const blob = new Blob([output], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dypa-support-bundle-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  await appendLog("support_bundle_exported", { bundleVersion: bundle.bundleVersion || 1 });
  const button = document.getElementById("exportSupportBundleBtn");
  if (button) {
    const original = button.textContent;
    button.classList.add("success");
    button.textContent = "Bundle Exported";
    window.setTimeout(() => {
      button.classList.remove("success");
      button.textContent = original;
    }, 1500);
  }
  recordUiTelemetry("export_support_bundle");
}

function renderRunHealth() {
  const card = document.getElementById("runHealthCard");
  if (!card) return;
  const latest = [...fullLogs].reverse().find((log) => {
    const event = String(log.event || "").toLowerCase();
    return event.includes("failed") || event.includes("error");
  });
  if (!latest) {
    card.textContent = "Healthy: no recent failure events.";
    return;
  }

  const event = String(latest.event || "").toLowerCase();
  let recommendation = "Review logs for context.";
  if (event.includes("login")) {
    recommendation = "Check credentials and login URL.";
  } else if (event.includes("timeout")) {
    recommendation = "Increase timeout and/or slowMo.";
  } else if (event.includes("webview") || event.includes("render")) {
    recommendation = "Reload app and verify network stability.";
  }
  card.innerHTML = `<div><strong>${latest.event}</strong></div><div class="muted">${recommendation}</div>`;
}

function renderAnalytics(state, analyticsSnapshot = null) {
  const root = document.getElementById("analyticsCards");
  if (!root) return;
  const today = Number(state?.todayMinutes || 0);
  const limit = Number(state?.dailyLimitMinutes || 0);
  const fallback = {
    dailyCompletionPct: limit > 0 ? Math.round((today / limit) * 100) : 0,
    dailyRemainingMinutes: Math.max(0, limit - today),
    lessonForecastPct: 0,
    activeStreakDays: today > 0 ? 1 : 0,
    etaToDailyTargetMinutes: Math.max(0, limit - today)
  };
  const metrics = {
    ...fallback,
    ...(analyticsSnapshot || {})
  };
  root.innerHTML = `
    <div class="analytics-card"><strong>Daily Completion</strong><div>${metrics.dailyCompletionPct}%</div></div>
    <div class="analytics-card"><strong>Minutes Remaining</strong><div>${metrics.dailyRemainingMinutes}</div></div>
    <div class="analytics-card"><strong>Lesson Forecast</strong><div>${metrics.lessonForecastPct}%</div></div>
    <div class="analytics-card"><strong>ETA to Limit</strong><div>${metrics.etaToDailyTargetMinutes} min</div></div>
    <div class="analytics-card"><strong>Active Streak</strong><div>${metrics.activeStreakDays} day</div></div>
  `;
}

function maybeNotify(message, type) {
  const notif = currentSettings?.featureFlags?.notifications || DEFAULT_FEATURE_FLAGS.notifications;
  if (!notif.enabled) return;
  if (type === "startStop" && !notif.startStop) return;
  if (type === "errors" && !notif.errors) return;
  if (type === "limits" && !notif.limits) return;
  if (type === "validation" && !notif.validation) return;
  const now = Date.now();
  const lastTs = notificationCooldownByType[type] || 0;
  const hashKey = `${type}:${String(message || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
  const lastHashTs = notificationCooldownByHash[hashKey] || 0;
  if (now - lastTs < NOTIFICATION_COOLDOWN_MS) {
    return;
  }
  if (now - lastHashTs < NOTIFICATION_COOLDOWN_MS) {
    return;
  }
  notificationCooldownByType[type] = now;
  notificationCooldownByHash[hashKey] = now;

  if (!("Notification" in window)) {
    return;
  }
  if (Notification.permission === "granted") {
    new Notification("DYPA Desktop", { body: message });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        new Notification("DYPA Desktop", { body: message });
      }
    });
  }
}

function shouldSkipWebviewConsoleMessage(rawMessage) {
  const verboseWebviewConsole = Boolean(
    currentSettings?.featureFlags?.logging?.verboseWebviewConsole
  );
  if (verboseWebviewConsole) {
    return false;
  }
  const message = String(rawMessage || "");
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();

  // Drop expected noisy framework reconnect chatter entirely.
  const isTransientFrameworkNoise =
    normalized.includes("normalizing '_blazor'") || normalized.includes("websocket connected to wss://");
  if (isTransientFrameworkNoise) {
    return true;
  }

  // Keep timeout messages, but dedupe identical entries aggressively.
  const now = Date.now();
  const lastSeen = webviewConsoleCooldownByMessage[normalized] || 0;
  if (now - lastSeen < WEBVIEW_CONSOLE_DEDUPE_MS) {
    return true;
  }
  webviewConsoleCooldownByMessage[normalized] = now;
  return false;
}

function fillSettingsForm(settings) {
  document.getElementById("settingsUsername").value = settings.credentials?.username || "";
  document.getElementById("settingsPassword").value = settings.credentials?.password || "";
  document.getElementById("settingsDashboardPort").value = settings.dashboardPort ?? "";
  document.getElementById("settingsHeadless").value = String(Boolean(settings.headless));
  document.getElementById("settingsSlowMo").value = settings.slowMo ?? "";
  document.getElementById("settingsTimeoutMs").value = settings.timeoutMs ?? "";
  document.getElementById("settingsSessionMinMinutes").value =
    settings.scormSessionMinMinutes ?? settings.maxScormSessionMinutes ?? "";
  document.getElementById("settingsSessionMaxMinutes").value =
    settings.scormSessionMaxMinutes ?? settings.maxScormSessionMinutes ?? "";
  document.getElementById("settingsDailyLimitMinutes").value = settings.dailyScormLimitMinutes ?? "";
  const notif = settings.featureFlags?.notifications || DEFAULT_FEATURE_FLAGS.notifications;
  const loggingFlags = settings.featureFlags?.logging || DEFAULT_FEATURE_FLAGS.logging;
  const uiFlags = settings.featureFlags?.ui || DEFAULT_FEATURE_FLAGS.ui;
  const navigationFlags = settings.featureFlags?.navigation || DEFAULT_FEATURE_FLAGS.navigation;
  document.getElementById("notifEnabled").checked = Boolean(notif.enabled);
  document.getElementById("notifStartStop").checked = Boolean(notif.startStop);
  document.getElementById("notifErrors").checked = Boolean(notif.errors);
  document.getElementById("notifLimits").checked = Boolean(notif.limits);
  document.getElementById("notifValidation").checked = Boolean(notif.validation);
  const discordEnabled = document.getElementById("notifDiscordEnabled");
  if (discordEnabled) {
    discordEnabled.checked = Boolean(notif.discordWebhookEnabled);
  }
  const discordUrlInput = document.getElementById("discordWebhookUrl");
  if (discordUrlInput) {
    discordUrlInput.value = String(notif.discordWebhookUrl || "");
  }
  const discordVerboseEl = document.getElementById("notifDiscordVerbose");
  if (discordVerboseEl) {
    discordVerboseEl.checked = Boolean(notif.discordVerbose);
  }
  const discordVerboseFlushEl = document.getElementById("notifDiscordVerboseFlushSeconds");
  if (discordVerboseFlushEl) {
    discordVerboseFlushEl.value = String(Number(notif.discordVerboseFlushSeconds || 20));
  }
  document.getElementById("verboseWebviewConsole").checked = Boolean(loggingFlags.verboseWebviewConsole);
  document.getElementById("settingsSimpleMode").checked = Boolean(uiFlags.simpleMode);
  document.getElementById("settingsLightTheme").checked = Boolean(uiFlags.lightTheme);
  document.getElementById("settingsDirectCourseMode").checked = Boolean(navigationFlags.directCourseMode);
  const defaultRunAtTimeInput = document.getElementById("settingsDefaultRunAtTime");
  if (defaultRunAtTimeInput) {
    defaultRunAtTimeInput.value = settings.scheduler?.defaultRunAtLocalTime || "17:40";
  }
  const allowedWindowsInput = document.getElementById("settingsAllowedWindowsCsv");
  if (allowedWindowsInput) {
    allowedWindowsInput.value = settings.scheduler?.allowedWindowsCsv || "";
  }
  const nightTargetInput = document.getElementById("settingsNightTargetMinutes");
  if (nightTargetInput) {
    nightTargetInput.value = settings.scheduler?.nightTargetMinutes ?? "";
  }
  const nightJitterInput = document.getElementById("settingsNightJitterMinutes");
  if (nightJitterInput) {
    nightJitterInput.value = settings.scheduler?.nightJitterMinutes ?? "";
  }

  // Mirror scheduler settings onto the Automation tab panel.
  const dailyLimitMirror = document.getElementById("automationDailyLimitMinutes");
  if (dailyLimitMirror) {
    dailyLimitMirror.value = settings.dailyScormLimitMinutes ?? "";
  }
  const windowsCsv = String(settings.scheduler?.allowedWindowsCsv || "").trim();
  const windows = windowsCsv
    ? windowsCsv
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .slice(0, 2)
    : [];
  const [night, evening] = windows;
  const [nightStart, nightEnd] = night ? night.split("-").map((v) => v.trim()) : ["00:00", "02:00"];
  const [eveningStart, eveningEnd] = evening ? evening.split("-").map((v) => v.trim()) : ["17:00", "21:00"];
  const nightStartEl = document.getElementById("automationNightStart");
  const nightEndEl = document.getElementById("automationNightEnd");
  const eveningStartEl = document.getElementById("automationEveningStart");
  const eveningEndEl = document.getElementById("automationEveningEnd");
  if (nightStartEl && nightStart) nightStartEl.value = nightStart;
  if (nightEndEl && nightEnd) nightEndEl.value = nightEnd;
  if (eveningStartEl && eveningStart) eveningStartEl.value = eveningStart;
  if (eveningEndEl && eveningEnd) eveningEndEl.value = eveningEnd;
  const automationNightTarget = document.getElementById("automationNightTargetMinutes");
  if (automationNightTarget) {
    const fallback = Number.isFinite(Number(settings.scheduler?.nightTargetMinutes))
      ? Number(settings.scheduler?.nightTargetMinutes)
      : 120;
    automationNightTarget.value = String(fallback);
  }
  const automationNightJitter = document.getElementById("automationNightJitterMinutes");
  if (automationNightJitter) {
    const fallback = Number.isFinite(Number(settings.scheduler?.nightJitterMinutes))
      ? Number(settings.scheduler?.nightJitterMinutes)
      : 15;
    automationNightJitter.value = String(fallback);
  }

  updateRiskBadges();
  renderSettingsPreview();
  applyUiPreferences(settings);
}

function wireTabNavigation() {
  const navButtons = Array.from(document.querySelectorAll(".nav-btn[data-tab]"));
  const views = {
    dashboard: document.getElementById("view-dashboard"),
    automation: document.getElementById("view-automation"),
    settings: document.getElementById("view-settings"),
    logs: document.getElementById("view-logs"),
    onboarding: document.getElementById("view-onboarding")
  };

  const activate = (tab) => {
    lastActivatedTab = tab;
    for (const [key, view] of Object.entries(views)) {
      if (!view) continue;
      view.classList.toggle("active", key === tab);
    }
    for (const button of navButtons) {
      button.classList.toggle("nav-active", button.dataset.tab === tab);
    }
    recordUiTelemetry(`tab_${tab}`);
  };

  for (const button of navButtons) {
    button.addEventListener("click", () => activate(button.dataset.tab));
  }
}

function getOnboardingState() {
  try {
    const raw = localStorage.getItem(ONBOARDING_STATE_KEY);
    if (!raw) {
      return {
        dismissed: false,
        checklist: {
          savedSettings: false,
          testedLogin: false,
          startedAutomation: false
        }
      };
    }
    return JSON.parse(raw);
  } catch {
    return {
      dismissed: false,
      checklist: {
        savedSettings: false,
        testedLogin: false,
        startedAutomation: false
      }
    };
  }
}

function saveOnboardingState(state) {
  try {
    localStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(state));
  } catch {}
}

function renderOnboarding() {
  const state = getOnboardingState();
  const root = document.getElementById("onboardingChecklist");
  const changesRoot = document.getElementById("recentChangesList");
  if (!root || !changesRoot) return;
  const items = [
    { id: "savedSettings", label: "Validate and save your settings." },
    { id: "testedLogin", label: "Run Test Login Only to verify credentials/network." },
    { id: "startedAutomation", label: "Start automation and verify diagnostics update." }
  ];
  root.innerHTML = items
    .map((item) => {
      const done = Boolean(state.checklist?.[item.id]);
      return `<div class="assistant-item"><div>${done ? "Done" : "Pending"} - ${item.label}</div></div>`;
    })
    .join("");
  changesRoot.innerHTML = `
    <div>Phase 2: Reliability core (idempotency, retries, IPC guards).</div>
    <div>Phase 3: Supervisor/recovery timeline and stale-run protection.</div>
    <div>Phase 4: Professional UX workflows, onboarding, and local telemetry.</div>
  `;
  const overlay = document.getElementById("onboardingOverlay");
  if (overlay) {
    overlay.classList.toggle("open", !state.dismissed);
    overlay.setAttribute("aria-hidden", state.dismissed ? "true" : "false");
  }
}

function updateOnboardingChecklist(id, done = true) {
  const state = getOnboardingState();
  if (!state.checklist) {
    state.checklist = {};
  }
  state.checklist[id] = Boolean(done);
  saveOnboardingState(state);
  renderOnboarding();
}

function dismissOnboarding() {
  const state = getOnboardingState();
  state.dismissed = true;
  saveOnboardingState(state);
  renderOnboarding();
}

function closeHelpPanel() {
  const panel = document.getElementById("helpPanel");
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  activeHelpKey = null;
}

function openHelpPanel(helpKey) {
  const content = HELP_CONTENT[helpKey];
  if (!content) {
    return;
  }

  activeHelpKey = helpKey;
  document.getElementById("helpPanelTitle").textContent = content.title;
  document.getElementById("helpPanelSummary").textContent = content.summary;
  document.getElementById("helpPanelWhat").textContent = content.what;
  document.getElementById("helpPanelWhen").textContent = content.when;
  document.getElementById("helpPanelSafe").textContent = content.safe;
  document.getElementById("helpPanelExample").textContent = content.example;
  const panel = document.getElementById("helpPanel");
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
}

function hideTooltip() {
  const tooltip = document.getElementById("helpTooltip");
  tooltip.classList.remove("show");
  tooltip.setAttribute("aria-hidden", "true");
}

function showTooltip(target, helpKey) {
  const content = HELP_CONTENT[helpKey];
  if (!content) {
    return;
  }

  const tooltip = document.getElementById("helpTooltip");
  const rect = target.getBoundingClientRect();
  tooltip.textContent = content.summary;
  tooltip.style.left = `${Math.min(window.innerWidth - 300, Math.max(10, rect.left))}px`;
  tooltip.style.top = `${Math.max(10, rect.top - 44)}px`;
  tooltip.classList.add("show");
  tooltip.setAttribute("aria-hidden", "false");
}

function wireHelpSystem() {
  const triggers = Array.from(document.querySelectorAll(".help-trigger[data-help-key]"));
  const closeButton = document.getElementById("closeHelpPanelBtn");

  for (const trigger of triggers) {
    const helpKey = trigger.dataset.helpKey;
    const content = HELP_CONTENT[helpKey];
    if (content) {
      trigger.setAttribute("title", content.summary);
    }

    trigger.addEventListener("mouseenter", () => showTooltip(trigger, helpKey));
    trigger.addEventListener("mouseleave", hideTooltip);
    trigger.addEventListener("focus", () => showTooltip(trigger, helpKey));
    trigger.addEventListener("blur", hideTooltip);
    trigger.addEventListener("click", () => openHelpPanel(helpKey));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openHelpPanel(helpKey);
      }
    });
  }

  closeButton.addEventListener("click", closeHelpPanel);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideTooltip();
      if (activeHelpKey) {
        closeHelpPanel();
      }
    }
  });
}

async function loadSettingsIntoUi() {
  const payload = await window.desktopApi.getSettings();
  currentSettings = {
    ...payload.settings,
    featureFlags: {
      ...DEFAULT_FEATURE_FLAGS,
      ...(payload.settings.featureFlags || {}),
      notifications: {
        ...DEFAULT_FEATURE_FLAGS.notifications,
        ...(payload.settings.featureFlags?.notifications || {})
      },
      logging: {
        ...DEFAULT_FEATURE_FLAGS.logging,
        ...(payload.settings.featureFlags?.logging || {})
      },
      ui: {
        ...DEFAULT_FEATURE_FLAGS.ui,
        ...(payload.settings.featureFlags?.ui || {})
      }
    }
  };
  fillSettingsForm(currentSettings);
}

async function handleSaveSettings() {
  const candidate = getSettingsFromForm();
  if (candidate.scormSessionMinMinutes > candidate.scormSessionMaxMinutes) {
    setSettingsFeedback("Minimum Minutes must be less than or equal to Maximum Minutes.", true);
    return null;
  }
  const result = await window.desktopApi.saveSettings(candidate);
  if (!result.ok) {
    setSettingsFeedback((result.errors || ["Failed to save settings."]).join(" "), true);
    return null;
  }

  currentSettings = result.settings;
  fillSettingsForm(currentSettings);
  appConfig = {
    ...appConfig,
    directCourseMode: Boolean(currentSettings?.featureFlags?.navigation?.directCourseMode),
    timeoutMs: currentSettings.timeoutMs,
    scormSessionMinMinutes: currentSettings.scormSessionMinMinutes,
    scormSessionMaxMinutes: currentSettings.scormSessionMaxMinutes,
    dailyScormLimitMinutes: currentSettings.dailyScormLimitMinutes,
    credentials: currentSettings.credentials
  };
  setSettingsFeedback("Settings saved. You can now start a study session.");
  const scheduleTimeInput = document.getElementById("scheduleTimeInput");
  if (scheduleTimeInput) {
    scheduleTimeInput.value = currentSettings.scheduler?.defaultRunAtLocalTime || scheduleTimeInput.value || "17:40";
  }
  updateOnboardingChecklist("savedSettings", true);
  recordUiTelemetry("save_settings");
  renderSettingsPreview();
}

async function handleTestSettings() {
  const result = await window.desktopApi.testSettings(getSettingsFromForm());
  if (result.ok) {
    setSettingsFeedback("Great - your settings look ready.");
  } else {
    maybeNotify("Some settings need attention. Open assistant fixes.", "validation");
    setSettingsFeedback((result.errors || ["Some settings need attention."]).join(" "), true);
  }
  renderValidationAssistant();
  recordUiTelemetry("test_settings");
}

async function handleTestLoginOnly() {
  try {
    const backendResult = await window.desktopApi.testLoginOnly(getSettingsFromForm());
    if (!backendResult.ok) {
      throw new Error(backendResult.message || "Backend login-only test failed.");
    }
    await waitForWebviewReady();
    await loadUrl(appConfig.loginUrl);
    await fillLoginForm();
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        return !/\/login/i.test(currentUrl) ? currentUrl : null;
      },
      {
        timeoutMs: appConfig.timeoutMs,
        intervalMs: 500,
        errorMessage: "Embedded login-only test stayed on login page."
      }
    );
    await appendLog("embedded_login_only_passed", { url: getSafeWebviewUrl() || null });
    setSettingsFeedback(`Login-only test passed (${getSafeWebviewUrl() || backendResult.url || "-"})`);
    maybeNotify("Login-only test passed.", "validation");
    updateOnboardingChecklist("testedLogin", true);
    recordUiTelemetry("test_login_only");
    return;
  } catch (error) {
    setSettingsFeedback(`Login-only test failed: ${error.message || "Unknown error."}`, true);
    maybeNotify("Login-only test failed.", "errors");
    await appendLog("embedded_login_only_failed", { message: error.message || "Unknown error." });
    recordUiTelemetry("test_login_only_failed", "login_failed");
  }
}

async function persistCurrentSettingsSilently() {
  try {
    const payload = getSettingsFromForm();
    const result = await window.desktopApi.saveSettings(payload);
    if (result.ok) {
      currentSettings = result.settings;
    }
  } catch {}
}

async function recordRendererError(eventName, errorLike) {
  const message =
    errorLike?.message ||
    errorLike?.reason?.message ||
    errorLike?.reason ||
    String(errorLike || "Unknown renderer error");

  await window.desktopApi.appendLog({
    event: eventName,
    message
  });
}

function syncEmbeddedUrl() {
  const addressBar = document.getElementById("addressBar");
  const embeddedUrl = document.getElementById("embeddedUrl");
  const currentUrl = getSafeWebviewUrl();
  if (addressBar) {
    addressBar.textContent = currentUrl;
  }
  if (embeddedUrl) {
    embeddedUrl.textContent = currentUrl;
  }
}

async function loadUrl(url) {
  return enqueueWebviewLoad(async () => {
    const webview = getWebview();
    // Using webview.loadURL() can cause Electron to print noisy
    // "GUEST_VIEW_MANAGER_CALL: (-3) loading ..." logs when navigations are superseded.
    // Setting `src` performs the same navigation without triggering that IPC spam.
    webview.setAttribute("src", String(url || ""));
    syncEmbeddedUrl();
    if (!embeddedAutomation.webviewReady) {
      await waitForWebviewReady();
    }
  });
}

async function executeInWebview(script) {
  await waitForWebviewReady();
  const webview = getWebview();
  return webview.executeJavaScript(script, true);
}

async function clickWebviewAt(x, y) {
  await waitForWebviewReady();
  const webview = getWebview();
  if (!webview || typeof webview.sendInputEvent !== "function") {
    return false;
  }

  const clickX = Math.max(1, Math.floor(Number(x) || 0));
  const clickY = Math.max(1, Math.floor(Number(y) || 0));
  if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) {
    return false;
  }

  if (typeof window.focus === "function") {
    window.focus();
  }
  if (typeof webview.focus === "function") {
    webview.focus();
  }
  await delay(20);
  webview.sendInputEvent({ type: "mouseMove", x: clickX, y: clickY, button: "left" });
  await delay(20);
  webview.sendInputEvent({ type: "mouseDown", x: clickX, y: clickY, button: "left", clickCount: 1 });
  await delay(30);
  webview.sendInputEvent({ type: "mouseUp", x: clickX, y: clickY, button: "left", clickCount: 1 });
  return true;
}

function throwIfStopped() {
  if (embeddedAutomation.stopRequested) {
    throw new Error("Automation stopped by user.");
  }
}

function getRandomPreClickDelayMs() {
  const minMs = 1000;
  const maxMs = 3000;
  const stepMs = 100;
  const stepCount = randomIntInRange(0, Math.floor((maxMs - minMs) / stepMs));
  return minMs + stepCount * stepMs;
}

async function waitInterruptible(totalMs, chunkMs = 100) {
  let remaining = Math.max(0, Number(totalMs) || 0);
  const safeChunk = Math.max(20, Number(chunkMs) || 100);
  while (remaining > 0) {
    throwIfStopped();
    const slice = Math.min(safeChunk, remaining);
    await delay(slice);
    remaining -= slice;
  }
}

async function applyRandomPreClickDelay(phase, extra = {}) {
  const delayMs = getRandomPreClickDelayMs();
  await appendLog("pre_click_delay_scheduled", {
    phase: String(phase || "unknown"),
    delayMs,
    delaySeconds: Number((delayMs / 1000).toFixed(1)),
    ...extra,
    url: getSafeWebviewUrl() || null
  });
  await waitInterruptible(delayMs, 100);
  return delayMs;
}

function isScormUrl(url) {
  return /mod\/scorm\/(view|player)\.php/i.test(url || "");
}

const OPEN_COURSES_BUTTON_SELECTORS = [
  "button .fa-envelope-open-text",
  "button span.fa-envelope-open-text",
  "button i.fa-envelope-open-text",
  'button[title*="Open"]',
  'button[aria-label*="Open"]',
  'button[title*="μάθη"]',
  'button[aria-label*="μάθη"]',
  'button[class*="course"]',
  'button[class*="lesson"]',
  '[role="button"][title*="Open"]',
  '[role="button"][aria-label*="Open"]',
  '[role="button"][title*="μάθη"]',
  '[role="button"][aria-label*="μάθη"]'
];

const OPEN_COURSES_TEXT_HINTS = [
  "open courses",
  "open course",
  "courses",
  "mathim",
  "lessons",
  "open lessons",
  "άνοιγμα μαθημάτων",
  "ανοιγμα μαθηματων",
  "μαθήματα",
  "μαθηματα"
];

const ELEARNING_URL_PATTERNS = [
  /https:\/\/elearning\.golearn\.gr\/local\/mdl_autologin\/autologin\.php/i,
  /https:\/\/elearning\.golearn\.gr\/$/i,
  /https:\/\/elearning\.golearn\.gr\/my\/?$/i
];

function isCourseUrl(url) {
  return /https:\/\/elearning\.golearn\.gr\/course\/view\.php\?id=7378/i.test(url || "");
}

function isElearningLandingUrl(url) {
  if (!url) {
    return false;
  }
  return ELEARNING_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function isAutologinBridgeUrl(url) {
  return /https:\/\/elearning\.golearn\.gr\/local\/mdl_autologin\/autologin\.php/i.test(url || "");
}

function isMoodleLoginUrl(url) {
  return /https:\/\/elearning\.golearn\.gr\/login\/index\.php/i.test(url || "");
}

function getElearningAutologinUrl() {
  return String(appConfig?.elearningAutologinUrl || "https://elearning.golearn.gr/local/mdl_autologin/autologin.php");
}

async function openCourseViaElearningAutologin() {
  const recoveryStartedAt = Date.now();
  const recoveryBudgetMs = Math.min(appConfig.timeoutMs, 35_000);
  const assertRecoveryBudget = () => {
    if (Date.now() - recoveryStartedAt > recoveryBudgetMs) {
      throw new Error(`Recovery budget exceeded (${recoveryBudgetMs}ms).`);
    }
  };

  let lastUrl = getSafeWebviewUrl() || null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptStartedAt = Date.now();
    const bridgeUrl = getElearningAutologinUrl();
    assertRecoveryBudget();
    await appendLog("autologin_bridge_attempted", {
      attempt,
      phase: "bridge_probe",
      fromUrl: getSafeWebviewUrl() || null,
      targetUrl: bridgeUrl
    });
    await loadUrl(bridgeUrl);
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        if (isCourseUrl(currentUrl) || isElearningLandingUrl(currentUrl) || isMoodleLoginUrl(currentUrl)) {
          return currentUrl;
        }
        return null;
      },
      {
        timeoutMs: Math.min(appConfig.timeoutMs, 8_000),
        intervalMs: 500,
        errorMessage: "Autologin bridge probe did not resolve."
      }
    ).catch(async (error) => {
      await appendLog("elearning_probe_stalled", {
        attempt,
        phase: "bridge_probe",
        message: error.message || "autologin_bridge_probe_timeout",
        url: getSafeWebviewUrl() || null
      });
      return null;
    });

    lastUrl = getSafeWebviewUrl() || null;
    await appendLog("autologin_bridge_resolved", {
      attempt,
      phase: "bridge_probe",
      fromUrl: bridgeUrl,
      toUrl: lastUrl,
      elapsedMs: Date.now() - attemptStartedAt
    });
    if (isCourseUrl(lastUrl)) {
      return;
    }
    if (isMoodleLoginUrl(lastUrl)) {
      await appendLog("autologin_bridge_login_wall", {
        attempt,
        phase: "bridge_probe",
        fromUrl: bridgeUrl,
        toUrl: lastUrl,
        elapsedMs: Date.now() - attemptStartedAt
      });
    }

    assertRecoveryBudget();
    await appendLog("auth_recovery_step_applied", {
      step: "elearning_my_probe",
      attempt,
      sourceUrl: getSafeWebviewUrl() || null
    });
    await loadUrl("https://elearning.golearn.gr/my/");
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        if (
          isCourseUrl(currentUrl) ||
          /https:\/\/elearning\.golearn\.gr\/my\/?$/i.test(currentUrl) ||
          isMoodleLoginUrl(currentUrl)
        ) {
          return currentUrl;
        }
        return null;
      },
      {
        timeoutMs: Math.min(appConfig.timeoutMs, 6_000),
        intervalMs: 500,
        errorMessage: "Elearning /my probe did not resolve."
      }
    ).catch(async (error) => {
      await appendLog("elearning_probe_stalled", {
        attempt,
        message: error.message || "elearning_my_probe_timeout",
        url: getSafeWebviewUrl() || null
      });
      return null;
    });

    lastUrl = getSafeWebviewUrl() || null;
    if (isCourseUrl(lastUrl)) {
      return;
    }
    if (isMoodleLoginUrl(lastUrl)) {
      await appendLog("moodle_login_wall_detected", { attempt, phase: "my_probe", url: lastUrl });
    }

    assertRecoveryBudget();
    await appendLog("auth_recovery_step_applied", {
      step: "open_course_direct",
      attempt,
      sourceUrl: getSafeWebviewUrl() || null
    });
    await loadUrl(appConfig.courseUrl);
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        if (isCourseUrl(currentUrl) || isMoodleLoginUrl(currentUrl)) {
          return currentUrl;
        }
        return null;
      },
      {
        timeoutMs: Math.min(appConfig.timeoutMs, 8_000),
        intervalMs: 500,
        errorMessage: "Direct course open did not resolve."
      }
    ).catch(() => null);

    lastUrl = getSafeWebviewUrl() || null;
    if (isCourseUrl(lastUrl)) {
      return;
    }
    if (isMoodleLoginUrl(lastUrl)) {
      await appendLog("moodle_login_wall_detected", { attempt, phase: "course_direct", url: lastUrl });
    }

    if (attempt === 1 && isMoodleLoginUrl(lastUrl)) {
      assertRecoveryBudget();
      await appendLog("auth_recovery_step_applied", {
        step: "reauth_edu",
        attempt,
        sourceUrl: getSafeWebviewUrl() || null
      });
      await loadUrl(appConfig.loginUrl);
      await fillLoginForm();
      await waitForCondition(
        async () => {
          const currentUrl = getSafeWebviewUrl() || "";
          return !/\/login/i.test(currentUrl) ? currentUrl : null;
        },
        {
          timeoutMs: Math.min(appConfig.timeoutMs, 12_000),
          intervalMs: 500,
          errorMessage: "Edu re-auth did not leave login page."
        }
      );
    }
  }

  await appendLog("auth_recovery_step_applied", {
    step: "retry_training_button",
    attempt: 3,
    sourceUrl: getSafeWebviewUrl() || null
  });
  await loadUrl(appConfig.trainingUrl);
  await waitForUrlMatch(/\/training\/trainee\/training/i, Math.min(appConfig.timeoutMs, 10_000));
  await waitForCondition(
    async () =>
      executeInWebview(`
        (() => {
          const selectors = ${JSON.stringify(OPEN_COURSES_BUTTON_SELECTORS)};
          const hasSelector = selectors.some((selector) => Boolean(document.querySelector(selector)));
          if (hasSelector) return true;
          const normalize = (value) =>
            String(value || "")
              .normalize("NFD")
              .replace(/[\\u0300-\\u036f]/g, "")
              .toLowerCase()
              .trim();
          const hints = ${JSON.stringify(OPEN_COURSES_TEXT_HINTS)};
          return Array.from(document.querySelectorAll("button, [role='button']")).some((button) => {
            const text = normalize(button.textContent);
            const aria = normalize(button.getAttribute("aria-label"));
            const title = normalize(button.getAttribute("title"));
            return hints.some((hint) => {
              const h = normalize(hint);
              return text.includes(h) || aria.includes(h) || title.includes(h);
            });
          });
        })()
      `),
    {
      timeoutMs: Math.min(appConfig.timeoutMs, 6_000),
      intervalMs: 300,
      errorMessage: "Training retry button did not appear."
    }
  );
  const trainingRetryClick = await executeInWebview(`
    (() => {
      const selectors = ${JSON.stringify(OPEN_COURSES_BUTTON_SELECTORS)};
      const textHints = ${JSON.stringify(OPEN_COURSES_TEXT_HINTS)};
      const normalize = (value) =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\\u0300-\\u036f]/g, "")
          .toLowerCase()
          .trim();
      const findButton = () => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) continue;
          const btn = node.closest("button, [role='button']");
          if (btn) return btn;
        }
        return Array.from(document.querySelectorAll("button, [role='button']")).find((button) => {
          const text = normalize(button.textContent);
          const aria = normalize(button.getAttribute("aria-label"));
          const title = normalize(button.getAttribute("title"));
          return textHints.some((hint) => {
            const h = normalize(hint);
            return text.includes(h) || aria.includes(h) || title.includes(h);
          });
        }) || null;
      };
      const button = findButton();
      if (!button) return { clicked: false, clickX: null, clickY: null };
      const rect = button.getBoundingClientRect();
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return {
        clicked: true,
        clickX: Math.max(1, Math.floor(rect.left + rect.width / 2)),
        clickY: Math.max(1, Math.floor(rect.top + rect.height / 2))
      };
    })()
  `).catch(() => ({ clicked: false, clickX: null, clickY: null }));
  if (trainingRetryClick?.clicked) {
    const retryPoints = [
      { x: Number(trainingRetryClick.clickX || 0), y: Number(trainingRetryClick.clickY || 0), strategy: "center" },
      {
        x: Number(trainingRetryClick.clickX || 0) + 6,
        y: Number(trainingRetryClick.clickY || 0) + 2,
        strategy: "offset_plus"
      },
      {
        x: Number(trainingRetryClick.clickX || 0) - 6,
        y: Number(trainingRetryClick.clickY || 0) - 2,
        strategy: "offset_minus"
      }
    ].filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 0 && point.y > 0);
    for (let idx = 0; idx < retryPoints.length; idx += 1) {
      const point = retryPoints[idx];
      const hostInputClicked = await clickWebviewAt(point.x, point.y).catch(() => false);
      await appendLog("open_courses_host_input_click", {
        attempt: 3,
        hostInputClicked,
        clickX: point.x,
        clickY: point.y,
        clickStrategy: point.strategy,
        clickAttempt: idx + 1,
        phase: "retry_training_button",
        url: getSafeWebviewUrl() || null
      });
      if (hostInputClicked) {
        await delay(120);
      }
    }
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        return isCourseUrl(currentUrl) || isElearningLandingUrl(currentUrl) ? currentUrl : null;
      },
      {
        timeoutMs: Math.min(appConfig.timeoutMs, 8_000),
        intervalMs: 500,
        errorMessage: "Training button retry did not navigate."
      }
    ).catch(() => null);
    lastUrl = getSafeWebviewUrl() || null;
    if (!isCourseUrl(lastUrl)) {
      const bridgeRetryUrl = getElearningAutologinUrl();
      await appendLog("autologin_bridge_attempted", {
        attempt: 3,
        phase: "post_training_bridge_probe",
        fromUrl: getSafeWebviewUrl() || null,
        targetUrl: bridgeRetryUrl
      });
      await loadUrl(bridgeRetryUrl);
      await waitForCondition(
        async () => {
          const currentUrl = getSafeWebviewUrl() || "";
          return isCourseUrl(currentUrl) || isElearningLandingUrl(currentUrl) || isMoodleLoginUrl(currentUrl)
            ? currentUrl
            : null;
        },
        {
          timeoutMs: Math.min(appConfig.timeoutMs, 8_000),
          intervalMs: 500,
          errorMessage: "Post-training autologin bridge probe did not resolve."
        }
      ).catch(() => null);
      lastUrl = getSafeWebviewUrl() || null;
      await appendLog("autologin_bridge_resolved", {
        attempt: 3,
        phase: "post_training_bridge_probe",
        fromUrl: bridgeRetryUrl,
        toUrl: lastUrl,
        elapsedMs: null
      });
      if (isMoodleLoginUrl(lastUrl)) {
        await appendLog("autologin_bridge_login_wall", {
          attempt: 3,
          phase: "post_training_bridge_probe",
          fromUrl: bridgeRetryUrl,
          toUrl: lastUrl,
          elapsedMs: null
        });
      }
    }
    if (!isCourseUrl(lastUrl)) {
      await loadUrl(appConfig.courseUrl);
      await waitForCondition(
        async () => {
          const currentUrl = getSafeWebviewUrl() || "";
          return isCourseUrl(currentUrl) || isMoodleLoginUrl(currentUrl) ? currentUrl : null;
        },
        {
          timeoutMs: Math.min(appConfig.timeoutMs, 8_000),
          intervalMs: 500,
          errorMessage: "Training retry direct course did not resolve."
        }
      ).catch(() => null);
      lastUrl = getSafeWebviewUrl() || null;
    }
    if (isCourseUrl(lastUrl)) {
      return;
    }
  }

  throw new Error(`Autologin bridge recovery did not reach course. Last URL: ${lastUrl || "-"}`);
}

async function waitForCondition(checkFn, options = {}) {
  const timeoutMs = options.timeoutMs ?? appConfig.timeoutMs;
  const intervalMs = options.intervalMs ?? 500;
  const allowStopRequested = options.allowStopRequested === true;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!allowStopRequested) {
      throwIfStopped();
    }
    const result = await checkFn();
    if (result) {
      return result;
    }
    await delay(intervalMs);
  }

  throw new Error(options.errorMessage || "Timed out waiting for condition.");
}

async function waitForUrlMatch(pattern, timeoutMs = appConfig.timeoutMs) {
  return waitForCondition(
    async () => {
      const currentUrl = getSafeWebviewUrl() || "";
      return pattern.test(currentUrl) ? currentUrl : null;
    },
    {
      timeoutMs,
      intervalMs: 500,
      allowStopRequested: false,
      errorMessage: `Timed out waiting for URL ${pattern}`
    }
  );
}

const SCORM_ENTRY_URL_RE = /mod\/scorm\/(view|player)\.php/i;

/**
 * Waits until the webview URL is a SCORM view/player page, or throws.
 * If Moodle sends the user to the login page, throws with code SCORM_LOGIN_REDIRECT
 * so callers can run session recovery instead of waiting the full timeout.
 */
async function waitForScormUrlWithLoginDetection(timeoutMs = appConfig.timeoutMs, intervalMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    const currentUrl = getSafeWebviewUrl() || "";
    if (SCORM_ENTRY_URL_RE.test(currentUrl)) {
      return currentUrl;
    }
    if (isMoodleLoginUrl(currentUrl)) {
      const err = new Error("SCORM open redirected to Moodle login.");
      err.code = "SCORM_LOGIN_REDIRECT";
      err.url = currentUrl;
      throw err;
    }
    await delay(intervalMs);
  }
  throw new Error("SCORM page did not open in embedded browser.");
}

async function recoverScormOpenAfterLoginRedirect(targetSection) {
  const lessonUrl = targetSection.activityHref;
  await appendLog("scorm_open_redirected_to_login", {
    sectionId: targetSection.id,
    lessonUrl: lessonUrl || null,
    url: getSafeWebviewUrl() || null
  });
  if (!lessonUrl) {
    throw new Error("SCORM recovery skipped: missing activity URL.");
  }
  await openCourseViaElearningAutologin();
  await loadUrl(lessonUrl);
}

async function waitForSelector(selector, timeoutMs = appConfig.timeoutMs) {
  return waitForCondition(
    async () =>
      executeInWebview(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return false;
          const style = window.getComputedStyle(element);
          return style && style.display !== "none" && style.visibility !== "hidden";
        })()
      `),
    {
      timeoutMs,
      intervalMs: 500,
      errorMessage: `Timed out waiting for selector ${selector}`
    }
  );
}

async function emitPortalDriftWarning(phase, missingSelectors = []) {
  runtimeDiagnostics.lastSelectorFailure = missingSelectors.join(", ") || "-";
  await appendLog("portal_drift_detected", {
    phase,
    missingSelectors,
    url: getSafeWebviewUrl() || null
  });
  await updateRuntimeState(
    { runtimeDiagnostics: { ...runtimeDiagnostics } },
    `Portal drift detected (${phase})`
  );
}

async function clickSelector(selector) {
  return executeInWebview(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    })()
  `);
}

const SCORM_EXIT_SELECTORS = [
  'a[title="Έξοδος από τη δραστηριότητα"]',
  'a[aria-label="Έξοδος από τη δραστηριότητα"]',
  'a[title*="Έξοδος"]',
  'a[aria-label*="Έξοδος"]',
  'a[href*="/course/view.php?id=7378"]',
  'a[href*="/course/view.php"]'
];

const SCORM_EXIT_TEXT_HINTS = [
  "έξοδος από τη δραστηριότητα",
  "εξοδος απο τη δραστηριοτητα",
  "έξοδος",
  "εξοδος"
];

async function clickScormExitButton() {
  return executeInWebview(`
    (() => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\\u0300-\\u036f]/g, "")
          .toLowerCase()
          .replace(/\\s+/g, " ")
          .trim();

      const selectors = ${JSON.stringify(SCORM_EXIT_SELECTORS)};
      const textHints = ${JSON.stringify(SCORM_EXIT_TEXT_HINTS)}.map(normalize);
      const candidates = [];

      for (const selector of selectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (!node || candidates.some((entry) => entry.node === node)) continue;
          candidates.push({ node, selector });
        }
      }

      for (const node of Array.from(document.querySelectorAll("a,button,[role='button']"))) {
        if (!node || candidates.some((entry) => entry.node === node)) continue;
        const combined = normalize([
          node.textContent || "",
          node.getAttribute("title") || "",
          node.getAttribute("aria-label") || ""
        ].join(" "));
        if (!combined) continue;
        if (!textHints.some((hint) => combined.includes(hint))) continue;
        candidates.push({ node, selector: "text_hint_match" });
      }

      for (const candidate of candidates) {
        const element = candidate.node;
        if (!element) continue;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style && style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
        if (!visible) continue;
        element.scrollIntoView({ block: "center", inline: "center" });
        element.click();
        return { clicked: true, selector: candidate.selector };
      }

      return { clicked: false, selector: null };
    })()
  `);
}

async function exitCurrentScormSafely(targetSection = null, reason = "requested_stop") {
  const currentUrl = getSafeWebviewUrl() || "";
  if (!isScormUrl(currentUrl)) {
    return false;
  }

  await appendLog("scorm_safe_exit_requested", {
    sectionId: targetSection?.id || null,
    reason,
    url: currentUrl
  });

  const maxAttempts = 4;
  let selectedSelector = null;
  let clicked = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const clickResult = await clickScormExitButton().catch(() => ({ clicked: false, selector: null }));
    clicked = Boolean(clickResult?.clicked);
    selectedSelector = clickResult?.selector || selectedSelector;
    await appendLog("scorm_exit_click_attempt", {
      sectionId: targetSection?.id || null,
      reason,
      attempt,
      maxAttempts,
      clicked,
      selector: clickResult?.selector || null,
      url: getSafeWebviewUrl() || null
    });
    if (clicked) {
      break;
    }
    await delay(250);
  }

  if (!clicked) {
    await appendLog("scorm_safe_exit_missing", {
      sectionId: targetSection?.id || null,
      reason,
      attemptedSelectors: SCORM_EXIT_SELECTORS,
      attemptedTextHints: SCORM_EXIT_TEXT_HINTS,
      url: getSafeWebviewUrl() || null
    });
    await appendLog("system_progress_commit_unconfirmed", {
      sectionId: targetSection?.id || null,
      reason,
      stage: "exit_click_not_found",
      url: getSafeWebviewUrl() || null
    });
    return false;
  }

  const targetPattern = targetSection?.id
    ? new RegExp(`/course/view\\.php\\?id=7378(?:#section-${targetSection.id})?$`)
    : /\/course\/view\.php\?id=7378/i;

  try {
    await waitForCondition(
      async () => {
        const latestUrl = getSafeWebviewUrl() || "";
        return targetPattern.test(latestUrl) ? latestUrl : null;
      },
      {
        timeoutMs: Math.max(6_000, Math.min(appConfig.timeoutMs || 30_000, 20_000)),
        intervalMs: 400,
        allowStopRequested: true,
        errorMessage: `Timed out waiting for SCORM exit URL ${targetPattern}`
      }
    );
  } catch (error) {
    await appendLog("system_progress_commit_unconfirmed", {
      sectionId: targetSection?.id || null,
      reason,
      selector: selectedSelector,
      stage: "navigation_confirmation_timeout",
      message: error?.message || String(error),
      url: getSafeWebviewUrl() || null
    });
    throw error;
  }

  await appendLog("scorm_exit_navigation_confirmed", {
    sectionId: targetSection?.id || null,
    reason,
    selector: selectedSelector,
    url: getSafeWebviewUrl() || null
  });
  await appendLog("system_progress_commit_confirmed", {
    sectionId: targetSection?.id || null,
    reason,
    selector: selectedSelector,
    url: getSafeWebviewUrl() || null
  });

  await appendLog("scorm_safe_exit_completed", {
    sectionId: targetSection?.id || null,
    reason,
    url: getSafeWebviewUrl() || null
  });
  await updateRuntimeState({
    currentUrl: getSafeWebviewUrl() || null,
    nextPlannedExitAt: null
  }, "SCORM exited safely");
  return true;
}

async function fillLoginForm() {
  const { username, password } = appConfig.credentials || {};
  if (!username || !password) {
    throw new Error("Missing GOLEARN credentials for desktop automation.");
  }

  await waitForSelector("#Input_Username");

  await executeInWebview(`
    (() => {
      const setInputValue = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) return;
        input.focus();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };

      setInputValue("#Input_Username", ${JSON.stringify(username)});
      setInputValue("#Input_Password", ${JSON.stringify(password)});

      const rememberMe = document.querySelector("#Input_RememberMe");
      if (rememberMe && !rememberMe.checked) {
        rememberMe.click();
      }

      const button = document.querySelector('button[type="submit"]');
      if (button) {
        button.click();
        return true;
      }

      return false;
    })()
  `);
}

async function ensureTrainingPageLoaded() {
  await loadUrl(appConfig.trainingUrl);
  const landedOnLogin = await waitForCondition(
    async () => {
      const currentUrl = getSafeWebviewUrl() || "";
      const loginVisible = await executeInWebview(
        `(() => Boolean(document.querySelector("#Input_Username") && document.querySelector("#Input_Password")))()`
      ).catch(() => false);
      return /\/login/i.test(currentUrl) || loginVisible ? true : currentUrl;
    },
    {
      timeoutMs: appConfig.timeoutMs,
      intervalMs: 500,
      errorMessage: "Training page did not finish loading."
    }
  );
  if (landedOnLogin === true) {
    await appendLog("manual_sync_login_required", { url: getSafeWebviewUrl() || null });
    await fillLoginForm();
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        return !/\/login/i.test(currentUrl) ? currentUrl : null;
      },
      {
        timeoutMs: appConfig.timeoutMs,
        intervalMs: 500,
        errorMessage: "Login did not complete while syncing website stats."
      }
    );
    await loadUrl(appConfig.trainingUrl);
  }
  await waitForUrlMatch(/\/training\/trainee\/training/i);
}

async function readWebsiteStatsPanel() {
  return executeInWebview(`
    (() => {
      let panel = document.querySelector("#asyncStatsPanel");
      if (!panel) {
        const toggle = document.querySelector(
          'button.accordion-button[data-bs-target="#asyncStatsPanel"], button.accordion-button[aria-controls="asyncStatsPanel"]'
        );
        if (toggle) {
          try { toggle.click(); } catch (_) {}
        }
        panel = document.querySelector("#asyncStatsPanel");
      }
      if (!panel) return null;
      return Array.from(panel.querySelectorAll(".rz-card")).map((card) => {
        const code = card.querySelector(".fw-bold span.text-muted")?.textContent?.trim() || "";
        const title = card.querySelector(".fw-bold")?.textContent?.replace(/\\s+/g, " ").trim() || "";
        const progressText = card.querySelector(".progress-info .fw-bold")?.textContent?.replace(/\\s+/g, " ").trim() || "";
        return { code, title, progressText };
      });
    })()
  `);
}

function parseGreekHours(value) {
  const text = String(value || "");
  const match = text.match(/-?\d{1,3}(?:\.\d{3})*(?:,\d+)?|-?\d+(?:,\d+)?/);
  if (!match) {
    return NaN;
  }
  const normalized = match[0].replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function resolveLessonSectionIdFromStatsRow(row) {
  const fromCode = String(row.code || "").match(/^100-(\d+)-/);
  if (fromCode && ["3", "4", "5", "6", "7"].includes(fromCode[1])) {
    return fromCode[1];
  }
  const lessonMatch = String(row.title || "").match(/Ε([1-5])\./u);
  if (!lessonMatch) {
    return null;
  }
  const lessonKey = `E${lessonMatch[1]}`;
  const lessonConfig = LESSON_SECTION_CONFIG.find((entry) => entry.lessonKey === lessonKey);
  return lessonConfig?.id || null;
}

function classifyStatsRow(row) {
  const title = String(row?.title || "");
  const isTestCard = /ερωτησ(?:εισ|εις)|questions?|quiz/iu.test(title);
  if (isTestCard) return "test";
  const isLessonCard = /Ε([1-5])\./u.test(title);
  if (isLessonCard) return "lesson";
  return "other";
}

async function syncWebsiteStatsToProgress(progressState) {
  const rows = await waitForCondition(
    async () => readWebsiteStatsPanel(),
    {
      timeoutMs: 15_000,
      intervalMs: 750,
      errorMessage: "Async stats panel was not found."
    }
  ).catch(() => null);

  if (!rows) {
    await appendLog("website_stats_panel_missing", { url: getSafeWebviewUrl() || null });
    await emitPortalDriftWarning("stats_panel", ["#asyncStatsPanel"]);
    await updateRuntimeState({}, "Website stats panel not found");
    return { synced: 0, missing: true };
  }

  let synced = 0;
  let skipped = 0;
  const testTotals = [];
  const parsedRows = [];
  for (const row of rows) {
    const rowType = classifyStatsRow(row);
    const rawCode = String(row?.code || "").trim();
    const codeMatch = rawCode.match(/^100-(\d+)-/);
    // Per portal structure: only sections 100-3..100-7 are actionable (E1..E5 lessons + their tests).
    if (!codeMatch || !["3", "4", "5", "6", "7"].includes(codeMatch[1])) {
      skipped += 1;
      await appendLog("website_stats_row_skipped", {
        reason: "code_not_actionable",
        code: rawCode,
        rowType,
        row
      });
      continue;
    }
    const sectionId = resolveLessonSectionIdFromStatsRow(row);
    if (!sectionId) {
      skipped += 1;
      await appendLog("website_stats_row_skipped", {
        reason: "section_not_mapped",
        row
      });
      continue;
    }
    const lessonConfig = LESSON_SECTION_CONFIG.find((entry) => entry.id === sectionId);
    if (!lessonConfig) {
      skipped += 1;
      await appendLog("website_stats_row_skipped", {
        reason: "lesson_config_missing",
        sectionId,
        row
      });
      continue;
    }

    const parts = String(row.progressText || "").split(/\s*από\s*/u);
    const completedHours = parseGreekHours(parts[0]);
    const targetHoursParsed = parseGreekHours(parts[1]);
    if (!Number.isFinite(completedHours) || completedHours < 0) {
      skipped += 1;
      await appendLog("website_stats_row_skipped", {
        reason: "invalid_completed_hours",
        sectionId,
        progressText: row.progressText
      });
      continue;
    }
    const targetHours = Number.isFinite(targetHoursParsed) && targetHoursParsed >= 0
      ? targetHoursParsed
      : lessonConfig.targetHours;
    const completedMinutes = Math.round(completedHours * 60);
    const targetMinutes = Math.round(targetHours * 60);
    if (completedMinutes < 0 || completedMinutes > 10_000 || targetMinutes > 20_000) {
      skipped += 1;
      await appendLog("website_stats_row_skipped", {
        reason: "minutes_out_of_range",
        sectionId,
        completedMinutes,
        targetMinutes
      });
      continue;
    }

    // Portal tests are 0.25-hour rows paired after each lesson. Treat small targets as tests
    // even if the title text drifts (deterministic separation).
    if (targetHours > 0 && targetHours <= 1 || rowType === "test") {
      testTotals.push({
        sectionId,
        code: rawCode,
        title: row.title,
        completedMinutes: Math.max(0, Math.min(targetMinutes, completedMinutes)),
        targetMinutes
      });
      continue;
    }

    if (rowType !== "lesson") {
      skipped += 1;
      await appendLog("website_stats_row_skipped", {
        reason: "row_not_lesson",
        sectionId,
        rowType,
        row
      });
      continue;
    }

    const existing = progressState.lessonProgress[sectionId] || {
      targetHours,
      completedMinutes: 0,
      updatedAt: null
    };
    const existingCompletedMinutes = Number(existing.completedMinutes || 0);
    const normalizedCompletedMinutes = Math.max(0, Math.min(targetMinutes, completedMinutes));
    const correctedCompletedMinutes =
      existingCompletedMinutes > targetMinutes
        ? normalizedCompletedMinutes
        : Math.max(existingCompletedMinutes, normalizedCompletedMinutes);
    progressState.lessonProgress[sectionId] = {
      targetHours,
      completedMinutes: correctedCompletedMinutes,
      updatedAt: new Date().toISOString()
    };
    parsedRows.push({
      sectionId,
      code: rawCode,
      completedHours,
      targetHours,
      completedMinutes: progressState.lessonProgress[sectionId].completedMinutes
    });
    synced += 1;
  }

  const warnings = clampProgressInvariants(progressState);
  for (const warning of warnings) {
    await appendLog("progress_invariant_warning", warning);
  }
  await saveProgressStateSafe(progressState);
  await appendLog("website_stats_sync_completed", {
    synced,
    parsedCount: rows.length,
    skipped,
    parsedRows,
    testTotals,
    url: getSafeWebviewUrl() || null
  });
  await updateRuntimeState(
    {
      lessonTotals: progressState.lessonProgress,
      testTotals,
      todayMinutes: progressState.dailyProgress.completedMinutes
    },
    synced > 0 ? `Synced ${synced} website stats` : "No website stats matched lessons"
  );
  await refreshDashboard();
  return { synced, missing: false };
}

async function findTargetSection(progressState) {
  const sections = await executeInWebview(`
    (() => {
      const extractModuleId = (href) => {
        const match = String(href || "").match(/[?&]id=(\\d+)/);
        return match ? match[1] : null;
      };
      return Array.from(document.querySelectorAll("li.section.main")).map((element) => {
        const titleAnchor = element.querySelector(".sectionname a");
        const activityAnchors = Array.from(element.querySelectorAll(".activityinstance a.aalink"));
        const activities = activityAnchors
          .map((anchor) => ({
            href: anchor?.href || null,
            label: anchor?.textContent?.replace(/\\s+/g, " ").trim() || "",
            moduleId: extractModuleId(anchor?.href || null)
          }))
          .filter((activity) => Boolean(activity.href));
        return {
          id: element.getAttribute("data-sectionid") || element.id?.replace("section-", "") || null,
          title: titleAnchor ? titleAnchor.textContent.trim() : "",
          activities
        };
      });
    })()
  `);
  if (!Array.isArray(sections) || sections.length === 0) {
    await emitPortalDriftWarning("lesson_section_list", ["li.section.main"]);
  }

  const lessonSections = LESSON_SECTION_CONFIG.map((configEntry) => {
    const found = sections.find((section) => section.id === configEntry.id);
    return found ? { ...found, ...configEntry } : null;
  }).filter(Boolean);

  if (lessonSections.length === 0) {
    await emitPortalDriftWarning("lesson_section_mapping", ["li.section.main[data-sectionid='3-7']"]);
    throw new Error("No lesson sections were found in the embedded course page.");
  }

  const selection = await window.desktopApi.resolveLessonSelection({
    lessonSections,
    progressState
  });
  const selected =
    lessonSections.find((section) => section.id === selection?.selectedSectionId) || lessonSections[0];

  const pickLessonAndTestActivities = (section) => {
    const activities = Array.isArray(section?.activities) ? section.activities : [];
    const lessonNumber = Number(String(section?.lessonKey || "").replace(/^E/u, ""));
    const isScorm = (activity) => /\/mod\/scorm\/view\.php\?/i.test(String(activity?.href || ""));
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

    const scormActivities = activities.filter(isScorm);
    const lessonActivity =
      scormActivities.find((activity) => new RegExp(`^${lessonNumber}\\s*\\.`, "u").test(normalize(activity.label))) ||
      scormActivities.find((activity) => new RegExp(`\\bΕ${lessonNumber}\\s*\\.`, "u").test(normalize(activity.label))) ||
      scormActivities.find((activity) => /\\blesson\\b/i.test(normalize(activity.label))) ||
      scormActivities[0] ||
      null;

    const testActivity =
      scormActivities.find((activity) => /^ερωτησ(?:εισ|εις)\\b/iu.test(normalize(activity.label))) ||
      scormActivities.find((activity) => /\\bquestions?\\b|\\bquiz\\b/iu.test(normalize(activity.label))) ||
      null;

    return { lessonActivity, testActivity };
  };

  const { lessonActivity, testActivity } = pickLessonAndTestActivities(selected);
  selected.activityHref = lessonActivity?.href || selected.activityHref || null;
  selected.lessonModuleId = lessonActivity?.moduleId || null;
  selected.testModuleId = testActivity?.moduleId || null;
  selected.testActivityHref = testActivity?.href || null;

  await appendLog("lesson_selection_reason", {
    selectedSectionId: selected.id,
    selectedLessonKey: selected.lessonKey,
    reason: selection?.reason || "fallback_selected",
    candidateSnapshot: selection?.candidateSnapshot || [],
    selectedLessonModuleId: selected.lessonModuleId,
    selectedTestModuleId: selected.testModuleId
  });
  await updateRuntimeState({}, `Lesson ${selected.lessonKey} selected (${selection?.reason || "fallback_selected"})`);
  return selected;
}

async function syncProgressState(progressState, targetSection, sessionMinutes) {
  progressState.lastScormExitedAt = new Date().toISOString();
  progressState.lastResolvedSectionId = targetSection.id;
  progressState.lessonProgress[targetSection.id].updatedAt = new Date().toISOString();
  const warnings = clampProgressInvariants(progressState);
  for (const warning of warnings) {
    await appendLog("progress_invariant_warning", warning);
  }
  await saveProgressStateSafe(progressState);

  await updateRuntimeState({
    lessonTotals: progressState.lessonProgress,
    todayMinutes: progressState.dailyProgress.completedMinutes,
    currentLesson: targetSection.id,
    currentLessonTitle: targetSection.title,
    nextPlannedExitAt: null
  }, "SCORM session completed");
}

async function applyIncrementalSessionProgress(progressState, targetSection, sessionId, checkpointKey, minutesToAdd = 1) {
  const minutes = Math.max(0, Number(minutesToAdd) || 0);
  if (minutes <= 0) {
    return;
  }
  const todayKey = getAthensDayKey();
  if (!progressState.dailyProgress || progressState.dailyProgress.date !== todayKey) {
    progressState.dailyProgress = {
      date: todayKey,
      completedMinutes: 0
    };

  return result;
  }
  const applied = applyLedgerCheckpoint(progressState, sessionId, checkpointKey, () => {
    progressState.dailyProgress.completedMinutes += minutes;
    progressState.lessonProgress[targetSection.id].completedMinutes += minutes;
    progressState.lessonProgress[targetSection.id].updatedAt = new Date().toISOString();
  });
  if (!applied) {
    return;
  }
  const warnings = clampProgressInvariants(progressState);
  for (const warning of warnings) {
    await appendLog("progress_invariant_warning", warning);
  }
  await saveProgressStateSafe(progressState);
  await updateRuntimeState({
    lessonTotals: progressState.lessonProgress,
    todayMinutes: progressState.dailyProgress.completedMinutes,
    currentLesson: targetSection.id,
    currentLessonTitle: targetSection.title
  });
}

async function handleSyncWebsiteStats() {
  if (embeddedAutomation.running) {
    return;
  }
  try {
    recordUiTelemetry("sync_website_stats");
    await appendLog("website_stats_sync_requested", { url: getSafeWebviewUrl() || null });
    embeddedAutomation.running = true;
    embeddedAutomation.stopRequested = false;
    await updateRuntimeState(
      {
        status: "running",
        paused: false,
        processRunning: true,
        currentUrl: getSafeWebviewUrl() || null
      },
      "Syncing website stats"
    );
    await waitForWebviewReady();
    const progressState = ensureProgressShape(await window.desktopApi.getProgressState());
    await saveProgressStateSafe(progressState);
    await ensureTrainingPageLoaded();
    await syncWebsiteStatsToProgress(progressState);
  } catch (error) {
    await appendLog("website_stats_sync_failed", {
      message: error.message,
      url: getSafeWebviewUrl() || null
    });
    await updateRuntimeState(
      {
        status: "error",
        paused: false,
        processRunning: false,
        currentUrl: getSafeWebviewUrl() || null
      },
      `Website stats sync failed: ${error.message}`
    );
  } finally {
    embeddedAutomation.running = false;
    embeddedAutomation.stopRequested = false;
    await updateRuntimeState(
      {
        status: "idle",
        paused: false,
        processRunning: false,
        currentUrl: getSafeWebviewUrl() || null
      },
      "Website stats sync finished"
    );
    await refreshDashboard();
  }
}

async function clickPlayerControl(selector) {
  return executeInWebview(`
    (() => {
      const lookupTargets = () => {
        const results = [];
        const visit = (doc) => {
          const element = doc.querySelector(${JSON.stringify(selector)});
          if (element) {
            results.push(element);
          }
          for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
            try {
              if (frame.contentDocument) {
                visit(frame.contentDocument);
              }
            } catch {}
          }
        };
        visit(document);
        return results;
      };

      const target = lookupTargets()[0];
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    })()
  `);
}

async function clickAnySelector(selectors = []) {
  for (const selector of selectors) {
    const clicked = await clickPlayerControl(selector).catch(() => false);
    if (clicked) {
      return selector;
    }
  }
  return null;
}

async function muteAndPlayPresentation() {
  const controlsVisible = await waitForCondition(
    async () =>
      executeInWebview(`
        (() => {
          const hasInTree = (selector) => {
            const visit = (doc) => {
              if (doc.querySelector(selector)) return true;
              for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
                try {
                  if (frame.contentDocument && visit(frame.contentDocument)) {
                    return true;
                  }
                } catch {}
              }
              return false;
            };
            return visit(document);
          };

          return hasInTree("#play-pause") || hasInTree('button[aria-label*="Mute"], button[aria-label*="Unmute"]');
        })()
      `),
    {
      timeoutMs: appConfig.timeoutMs,
      intervalMs: 1000,
      errorMessage: "Player controls did not appear in time."
    }
  ).catch(async () => {
    await emitPortalDriftWarning("scorm_controls", ["#play-pause", "button[aria-label*='Mute']"]);
    return false;
  });
  if (!controlsVisible) {
    throw new Error("Player controls did not appear in time.");
  }

  await clickAnySelector([
    'button[aria-label*="Mute"], button[aria-label*="Unmute"]',
    ".vjs-mute-control",
    ".mute-button"
  ]).catch(() => false);
  await delay(1500);
  await clickAnySelector(["#play-pause", ".vjs-play-control", "button[aria-label*='Play']"]).catch(() => false);
}

async function advanceSlidesUntil(endAt, onMinuteElapsed = null) {
  let nextAdvanceAt = Date.now() + 15000;
  let nextMinuteCheckpointAt = Date.now() + 60_000;

  while (Date.now() < endAt) {
    if (embeddedAutomation.stopRequested) {
      return "stopped";
    }

    const now = Date.now();
    const remainingMs = endAt - now;
    const untilNextAdvance = Math.max(0, nextAdvanceAt - now);
    const untilMinuteCheckpoint = Math.max(0, nextMinuteCheckpointAt - now);
    const chunkMs = Math.min(1000, remainingMs, untilNextAdvance || 1000, untilMinuteCheckpoint || 1000);
    await delay(chunkMs);

    if (embeddedAutomation.stopRequested) {
      return "stopped";
    }

    while (Date.now() >= nextMinuteCheckpointAt && Date.now() < endAt) {
      if (typeof onMinuteElapsed === "function") {
        await onMinuteElapsed();
      }
      nextMinuteCheckpointAt += 60_000;
    }

    if (Date.now() >= nextAdvanceAt && Date.now() < endAt) {
      await applyRandomPreClickDelay("advance_slides_next_button");
      await clickAnySelector(["#next", ".vjs-next-button", "button[aria-label*='Next']"]).catch(() => false);
      nextAdvanceAt = Date.now() + 15000;
    }
  }

  return "completed";
}

async function openTrainingAndCourse() {
  const stepStartedAt = Date.now();
  await loadUrl(appConfig.trainingUrl);
  await waitForUrlMatch(/\/training\/trainee\/training/i);
  await appendLog("training_page_opened", { url: getSafeWebviewUrl() });
  await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Training page opened");

  const directCourseModeEnabled = Boolean(currentSettings?.featureFlags?.navigation?.directCourseMode);
  await appendLog("open_courses_strategy_selected", {
    strategy: directCourseModeEnabled ? "direct_first" : "click_first",
    url: getSafeWebviewUrl() || null
  });

  if (directCourseModeEnabled) {
    try {
      await openCourseViaElearningAutologin();
      const currentUrl = getSafeWebviewUrl() || "";
      if (!isCourseUrl(currentUrl)) {
        throw new Error(`Direct mode did not reach course URL. Last URL: ${currentUrl || "-"}`);
      }
      await appendLog("open_courses_resolved_via_direct_mode", {
        elapsedMs: Date.now() - stepStartedAt,
        url: currentUrl || null
      });
      await appendLog("course_page_opened", { url: getSafeWebviewUrl() });
      await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Course page opened");
      return;
    } catch (error) {
      await appendLog("open_courses_navigation_fallback", {
        reason: "direct_mode_failed_fallback_to_click",
        message: error.message || "Direct mode failed.",
        url: getSafeWebviewUrl() || null
      });
    }
  }

  const openCoursesReady = await waitForCondition(
    async () =>
      executeInWebview(`
        (() => {
          const selectors = ${JSON.stringify(OPEN_COURSES_BUTTON_SELECTORS)};
          const textHints = ${JSON.stringify(OPEN_COURSES_TEXT_HINTS)};
          const normalize = (value) =>
            String(value || "")
              .normalize("NFD")
              .replace(/[\\u0300-\\u036f]/g, "")
              .toLowerCase()
              .trim();
          const bySelector = selectors.some((selector) => Boolean(document.querySelector(selector)));
          if (bySelector) return true;
          const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
          return buttons.some((button) => {
            const text = normalize(button.textContent);
            const aria = normalize(button.getAttribute("aria-label"));
            const title = normalize(button.getAttribute("title"));
            return textHints.some((hint) => {
              const normalizedHint = normalize(hint);
              return (
                text.includes(normalizedHint) ||
                aria.includes(normalizedHint) ||
                title.includes(normalizedHint)
              );
            });
          });
        })()
      `),
    {
      timeoutMs: appConfig.timeoutMs,
      intervalMs: 500,
      errorMessage: "Open courses button did not appear."
    }
  ).catch(async () => {
    await emitPortalDriftWarning("open_courses_button", OPEN_COURSES_BUTTON_SELECTORS);
    return false;
  });
  if (!openCoursesReady) {
    throw new Error("Open courses button did not appear.");
  }

  let clicked = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await applyRandomPreClickDelay("open_courses_button", { attempt });
    const clickResult = await executeInWebview(`
      (() => {
        const selectors = ${JSON.stringify(OPEN_COURSES_BUTTON_SELECTORS)};
        const textHints = ${JSON.stringify(OPEN_COURSES_TEXT_HINTS)};
        const normalize = (value) =>
          String(value || "")
            .normalize("NFD")
            .replace(/[\\u0300-\\u036f]/g, "")
            .toLowerCase()
            .trim();
        const candidates = [];
        const seen = new Set();
        const pushCandidate = (button, selector, score) => {
          if (!button || seen.has(button)) return;
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          const disabled =
            button.disabled ||
            button.getAttribute("aria-disabled") === "true" ||
            style.pointerEvents === "none";
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none";
          if (!visible || disabled) return;
          seen.add(button);
          candidates.push({ button, selector, score });
        };
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) continue;
          const button = node.closest("button, [role='button']");
          if (button) pushCandidate(button, selector, 70);
        }
        for (const button of Array.from(document.querySelectorAll("button, [role='button']"))) {
          const text = normalize(button.textContent);
          const aria = normalize(button.getAttribute("aria-label"));
          const title = normalize(button.getAttribute("title"));
          for (const hint of textHints) {
            const normalizedHint = normalize(hint);
            if (text === normalizedHint || aria === normalizedHint || title === normalizedHint) {
              pushCandidate(button, "exact-text", 120);
              break;
            }
            if (
              text.includes(normalizedHint) ||
              aria.includes(normalizedHint) ||
              title.includes(normalizedHint)
            ) {
              pushCandidate(button, "text-hint", 100);
              break;
            }
          }
          const className = normalize(button.className || "");
          if (className.includes("course") || className.includes("lesson") || className.includes("mathim")) {
            pushCandidate(button, "class-hint", 80);
          }
          const icon = button.querySelector(".fa-envelope-open-text");
          if (icon) {
            pushCandidate(button, "icon-hint", 90);
          }
        }
        const triggerUserLikeClick = (button) => {
          const rect = button.getBoundingClientRect();
          const x = Math.max(1, Math.floor(rect.left + rect.width / 2));
          const y = Math.max(1, Math.floor(rect.top + rect.height / 2));
          const pointerType = "mouse";
          const mouseEventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 1
          };
          const pointerEventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 1,
            pointerId: 1,
            pointerType,
            isPrimary: true
          };
          try {
            button.dispatchEvent(new PointerEvent("pointerdown", pointerEventInit));
            button.dispatchEvent(new MouseEvent("mousedown", mouseEventInit));
            button.dispatchEvent(new PointerEvent("pointerup", { ...pointerEventInit, buttons: 0 }));
            button.dispatchEvent(new MouseEvent("mouseup", { ...mouseEventInit, buttons: 0 }));
            button.dispatchEvent(new MouseEvent("click", { ...mouseEventInit, buttons: 0, detail: 1 }));
            return { clickMethod: "pointer-mouse-sequence", clickX: x, clickY: y };
          } catch {
            button.click();
            return { clickMethod: "dom-click-fallback", clickX: x, clickY: y };
          }
        };

        candidates.sort((a, b) => b.score - a.score);
        const target = candidates[0];
        if (!target || !target.button) {
          return {
            clicked: false,
            selector: null,
            score: null,
            candidateCount: candidates.length,
            clickMethod: null,
            clickX: null,
            clickY: null
          };
        }
        target.button.scrollIntoView({ block: "center", inline: "center" });
        const clickInfo = triggerUserLikeClick(target.button);
        return {
          clicked: true,
          selector: target.selector || null,
          score: target.score,
          candidateCount: candidates.length,
          clickMethod: clickInfo?.clickMethod || null,
          clickX: clickInfo?.clickX ?? null,
          clickY: clickInfo?.clickY ?? null
        };
      })()
    `);
    clicked = Boolean(clickResult?.clicked);
    await appendLog("open_courses_click_attempt", {
      attempt,
      clicked,
      selector: clickResult?.selector || null,
      score: clickResult?.score ?? null,
      candidateCount: clickResult?.candidateCount ?? 0,
      clickMethod: clickResult?.clickMethod || null,
      url: getSafeWebviewUrl() || null
    });
    if (clicked) {
      const baseX = Number(clickResult?.clickX ?? 0);
      const baseY = Number(clickResult?.clickY ?? 0);
      const clickPoints = [
        { x: baseX, y: baseY, strategy: "center" },
        { x: baseX + 6, y: baseY + 2, strategy: "offset_plus" },
        { x: baseX - 6, y: baseY - 2, strategy: "offset_minus" }
      ].filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 0 && point.y > 0);
      let hostInputClicked = false;
      for (let idx = 0; idx < clickPoints.length; idx += 1) {
        const point = clickPoints[idx];
        hostInputClicked = await clickWebviewAt(point.x, point.y).catch(() => false);
        await appendLog("open_courses_host_input_click", {
          attempt,
          hostInputClicked,
          clickX: point.x,
          clickY: point.y,
          clickStrategy: point.strategy,
          clickAttempt: idx + 1,
          url: getSafeWebviewUrl() || null
        });
        if (hostInputClicked) {
          await delay(120);
        }
      }
      break;
    }
    await delay(400);
  }
  if (!clicked) {
    await appendLog("open_courses_failed_terminal", {
      reason: "button_click_failed",
      elapsedMs: Date.now() - stepStartedAt,
      url: getSafeWebviewUrl() || null
    });
    throw new Error("Open courses button click failed.");
  }

  await delay(200);

  let navigationReached = false;
  const postClickNavigationTimeoutMs = Math.min(appConfig.timeoutMs, 3_500);
  try {
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        return isElearningLandingUrl(currentUrl) || isCourseUrl(currentUrl) ? currentUrl : null;
      },
      {
        timeoutMs: postClickNavigationTimeoutMs,
        intervalMs: 500,
        errorMessage: "Did not reach elearning after opening courses."
      }
    );
    navigationReached = true;
    await appendLog("open_courses_effect_confirmed", {
      source: "click_navigation",
      url: getSafeWebviewUrl() || null,
      elapsedMs: Date.now() - stepStartedAt
    });
  } catch (error) {
    await appendLog("open_courses_navigation_fallback", {
      message: error.message || "Did not reach elearning after click.",
      reason: "post_click_navigation_timeout",
      url: getSafeWebviewUrl() || null
    });
  }

  let resolvedVia = navigationReached ? "click" : "recovery";
  if (!navigationReached) {
    try {
      await openCourseViaElearningAutologin();
    } catch (error) {
      await appendLog("open_courses_failed_terminal", {
        reason: "recovery_error",
        message: error.message || "Recovery flow failed.",
        elapsedMs: Date.now() - stepStartedAt,
        url: getSafeWebviewUrl() || null
      });
      throw error;
    }
  }

  let currentUrl = getSafeWebviewUrl() || "";
  if (!isCourseUrl(currentUrl)) {
    await appendLog("open_courses_navigation_fallback", {
      reason: "not_on_course_after_landing",
      url: currentUrl || null
    });
    resolvedVia = "recovery";
    try {
      await openCourseViaElearningAutologin();
    } catch (error) {
      await appendLog("open_courses_failed_terminal", {
        reason: "recovery_error",
        message: error.message || "Recovery flow failed.",
        elapsedMs: Date.now() - stepStartedAt,
        url: getSafeWebviewUrl() || null
      });
      throw error;
    }
    currentUrl = getSafeWebviewUrl() || "";
  }

  if (!isCourseUrl(currentUrl)) {
    await appendLog("open_courses_failed_terminal", {
      reason: "not_on_course_after_recovery",
      elapsedMs: Date.now() - stepStartedAt,
      url: currentUrl || null
    });
    throw new Error(`Failed to reach course page after click/recovery. Last URL: ${currentUrl || "-"}`);
  }

  if (resolvedVia === "click") {
    await appendLog("open_courses_resolved_via_click", {
      elapsedMs: Date.now() - stepStartedAt,
      url: currentUrl || null
    });
  } else {
    await appendLog("open_courses_resolved_via_recovery", {
      elapsedMs: Date.now() - stepStartedAt,
      url: currentUrl || null
    });
  }

  await appendLog("course_page_opened", { url: getSafeWebviewUrl() });
  await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Course page opened");
}

async function runEmbeddedAutomation() {
  function isValidTimeToken(value) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ""));
  }
  function parseTimeToMinutes(value) {
    const [h, m] = String(value).split(":").map(Number);
    return h * 60 + m;
  }
  function parseScheduleWindowsCsv(csvValue) {
    const csv = String(csvValue || "").trim();
    if (!csv) return { windows: [], errors: [] };
    const tokens = csv
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const windows = [];
    const errors = [];
    for (const token of tokens) {
      const parts = token.split("-").map((part) => part.trim());
      if (parts.length !== 2) {
        errors.push(`Invalid window "${token}" (expected HH:mm-HH:mm)`);
        continue;
      }
      const [start, end] = parts;
      if (!isValidTimeToken(start) || !isValidTimeToken(end)) {
        errors.push(`Invalid window "${token}" (expected HH:mm-HH:mm)`);
        continue;
      }
      const startMinutes = parseTimeToMinutes(start);
      const endMinutes = parseTimeToMinutes(end);
      windows.push({
        start,
        end,
        startMinutes,
        endMinutes,
        wrapsMidnight: endMinutes <= startMinutes
      });
    }
    windows.sort((a, b) => a.startMinutes - b.startMinutes);
    return { windows, errors };
  }
  function getMinutesSinceMidnight(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes();
  }
  function isNowWithinAnyWindow(windows, now = new Date()) {
    if (!Array.isArray(windows) || windows.length === 0) {
      return { within: true, activeWindow: null };
    }
    const minutes = getMinutesSinceMidnight(now);
    for (const window of windows) {
      if (!window.wrapsMidnight) {
        if (minutes >= window.startMinutes && minutes < window.endMinutes) {
          return { within: true, activeWindow: window };
        }
        continue;
      }
      if (minutes >= window.startMinutes || minutes < window.endMinutes) {
        return { within: true, activeWindow: window };
      }
    }
    return { within: false, activeWindow: null };
  }
  function computeNextWindowStart(windows, now = new Date()) {
    if (!Array.isArray(windows) || windows.length === 0) {
      return null;
    }
    const minutes = getMinutesSinceMidnight(now);
    const today = new Date(now);
    today.setSeconds(0, 0);
    const startsToday = windows
      .map((w) => w.startMinutes)
      .sort((a, b) => a - b)
      .map((startMinutes) => {
        const startAt = new Date(today);
        startAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
        return startAt;
      });
    for (const startAt of startsToday) {
      const startMinutes = startAt.getHours() * 60 + startAt.getMinutes();
      if (startMinutes > minutes) {
        return startAt;
      }
    }
    const first = startsToday[0];
    if (!first) return null;
    const next = new Date(first);
    next.setDate(next.getDate() + 1);
    return next;
  }
  function minutesUntilWindowEnd(activeWindow, now = new Date()) {
    if (!activeWindow) return null;
    const minutes = getMinutesSinceMidnight(now);
    if (!activeWindow.wrapsMidnight) {
      return Math.max(0, activeWindow.endMinutes - minutes);
    }
    if (minutes >= activeWindow.startMinutes) {
      return Math.max(0, 24 * 60 - minutes + activeWindow.endMinutes);
    }
    return Math.max(0, activeWindow.endMinutes - minutes);
  }

  await waitForWebviewReady();
  const progressState = ensureProgressShape(await window.desktopApi.getProgressState());
  await saveProgressStateSafe(progressState);
  const sessionRange = await window.desktopApi.resolveSessionRange({
    progressState,
    configLike: appConfig
  });
  const dailyLimitMinutes = progressState.dailyScormLimitMinutes || appConfig.dailyScormLimitMinutes;
  const scheduleWindowsCsv = String(currentSettings?.scheduler?.allowedWindowsCsv || "").trim();
  const scheduleWindows = parseScheduleWindowsCsv(scheduleWindowsCsv).windows || [];
  const nightTargetBaseMinutes = Math.max(0, Number(currentSettings?.scheduler?.nightTargetMinutes || 0) || 0);
  const nightJitterMinutes = Math.max(0, Number(currentSettings?.scheduler?.nightJitterMinutes || 0) || 0);

  const resolveActiveWindowIndex = (activeWindow) => {
    if (!activeWindow) return -1;
    return scheduleWindows.findIndex(
      (w) =>
        Number(w.startMinutes) === Number(activeWindow.startMinutes) &&
        Number(w.endMinutes) === Number(activeWindow.endMinutes)
    );
  };

  const todayKey = getAthensDayKey();
  if (!progressState.schedulerDailySplit || progressState.schedulerDailySplit.date !== todayKey) {
    const plannedNightMinutes =
      nightTargetBaseMinutes > 0
        ? Math.max(
            0,
            Math.min(
              dailyLimitMinutes,
              randomIntInRange(nightTargetBaseMinutes - nightJitterMinutes, nightTargetBaseMinutes + nightJitterMinutes)
            )
          )
        : 0;
    progressState.schedulerDailySplit = {
      date: todayKey,
      plannedNightMinutes,
      nightMinutes: 0,
      eveningMinutes: 0
    };
    await saveProgressStateSafe(progressState);
    await appendLog("schedule_randomized_night_budget", {
      date: todayKey,
      plannedNightMinutes,
      nightTargetBaseMinutes,
      nightJitterMinutes
    });
  }

  embeddedAutomation.running = true;
  embeddedAutomation.stopRequested = false;

  await updateRuntimeState({
    status: "running",
    paused: false,
    processRunning: true,
    lessonTotals: progressState.lessonProgress,
    todayMinutes: progressState.dailyProgress.completedMinutes,
    dailyLimitMinutes
  }, "Embedded automation started");
  await appendLog("embedded_automation_started");
  await refreshDashboard();

  try {
    await appendLog("embedded_step", { message: "Loading login page" });
    await loadUrl(appConfig.loginUrl);
    await appendLog("embedded_step", { message: "Filling login form", url: getSafeWebviewUrl() || null });
    await fillLoginForm();
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        return !/\/login/i.test(currentUrl) ? currentUrl : null;
      },
      {
        timeoutMs: appConfig.timeoutMs,
        intervalMs: 500,
        errorMessage: "Login did not leave the login page in the embedded browser."
      }
    );

    await appendLog("embedded_authenticated", { url: getSafeWebviewUrl() });
    await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Authenticated in embedded browser");

    while (!embeddedAutomation.stopRequested) {
      if (progressState.dailyProgress.completedMinutes >= dailyLimitMinutes) {
        await appendLog("daily_limit_reached", {
          completedMinutesToday: progressState.dailyProgress.completedMinutes,
          dailyLimitMinutes
        });
        await window.desktopApi
          .sendDiscordNotification({
            kind: "limits",
            message: "Daily limit reached.",
            details: {
              completedMinutesToday: progressState.dailyProgress.completedMinutes,
              dailyLimitMinutes
            }
          })
          .catch(() => null);
        await updateRuntimeState({
          status: "idle",
          paused: false,
          processRunning: false,
          nextPlannedExitAt: null,
          todayMinutes: progressState.dailyProgress.completedMinutes
        }, "Daily limit reached");
        return;
      }

      const windowCheck = isNowWithinAnyWindow(scheduleWindows);
      if (!windowCheck.within) {
        const nextStart = computeNextWindowStart(scheduleWindows);
        const nextStartIso = nextStart ? nextStart.toISOString() : null;
        await updateRuntimeState(
          {
            status: "paused",
            paused: true,
            nextPlannedExitAt: nextStartIso,
            currentUrl: getSafeWebviewUrl() || null
          },
          "Waiting for scheduled window to open"
        );
        await appendLog("schedule_window_waiting", {
          nextWindowStartIso: nextStartIso
        });

        while (!embeddedAutomation.stopRequested && !isNowWithinAnyWindow(scheduleWindows).within) {
          const next = computeNextWindowStart(scheduleWindows);
          const wakeMs = next ? Math.max(5_000, Math.min(60_000, next.getTime() - Date.now())) : 60_000;
          await delay(wakeMs);
        }

        await updateRuntimeState(
          {
            status: "running",
            paused: false,
            currentUrl: getSafeWebviewUrl() || null
          },
          "Scheduled window open; resuming run"
        );
        await appendLog("schedule_window_resumed", {});
      }

      await openTrainingAndCourse();
      const targetSection = await findTargetSection(progressState);
      progressState.lastResolvedSectionId = targetSection.id;
      await saveProgressStateSafe(progressState);

      await appendLog("section_selected", {
        sectionId: targetSection.id,
        sectionTitle: targetSection.title,
        lessonUrl: targetSection.activityHref
      });
      await updateRuntimeState({
        currentLesson: targetSection.id,
        currentLessonTitle: targetSection.title,
        currentUrl: getSafeWebviewUrl()
      }, `Section ${targetSection.id} selected`);

      await applyRandomPreClickDelay("open_scorm_activity_link", {
        sectionId: targetSection.id,
        lessonUrl: targetSection.activityHref || null
      });
      const clickedActivityLink = await executeInWebview(`
        (() => {
          const section = document.querySelector(${JSON.stringify(`#section-${targetSection.id}`)});
          const link = section ? section.querySelector(".activityinstance a.aalink") : null;
          if (!link) return false;
          link.scrollIntoView({ block: "center", inline: "center" });
          link.click();
          return true;
        })()
      `);

      if (!clickedActivityLink && targetSection.activityHref) {
        await appendLog("scorm_activity_click_failed_try_loadurl", {
          sectionId: targetSection.id,
          lessonUrl: targetSection.activityHref
        });
        await loadUrl(targetSection.activityHref);
      } else if (!clickedActivityLink) {
        throw new Error("SCORM activity link not found on course page.");
      }

      const maxScormLoginRecoveries = 2;
      let scormLoginRecoveriesUsed = 0;
      let scormWaitTimeoutMs = appConfig.timeoutMs;

      while (true) {
        try {
          await waitForScormUrlWithLoginDetection(scormWaitTimeoutMs, 500);
          break;
        } catch (error) {
          if (error && error.code === "SCORM_LOGIN_REDIRECT") {
            if (scormLoginRecoveriesUsed >= maxScormLoginRecoveries) {
              throw new Error(
                `SCORM page did not open after login redirect recovery (${maxScormLoginRecoveries} attempts). Last URL: ${getSafeWebviewUrl() || "-"}`
              );
            }
            scormLoginRecoveriesUsed += 1;
            await recoverScormOpenAfterLoginRedirect(targetSection);
            scormWaitTimeoutMs = Math.min(20_000, appConfig.timeoutMs);
            continue;
          }
          throw error;
        }
      }

      await appendLog("scorm_opened", {
        sectionId: targetSection.id,
        url: getSafeWebviewUrl()
      });
      await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "SCORM opened");

      const redirectVisible = await executeInWebview(`
        (() => Boolean(document.querySelector('input[type="submit"][value="Είσοδος/Σύνδεση"]')))()
      `);
      if (redirectVisible) {
        await clickSelector('input[type="submit"][value="Είσοδος/Σύνδεση"]');
        await waitForCondition(
          async () => {
            const currentUrl = getSafeWebviewUrl() || "";
            return /mod\/scorm\/player\.php/i.test(currentUrl) ? currentUrl : null;
          },
          {
            timeoutMs: appConfig.timeoutMs,
            intervalMs: 500,
            errorMessage: "SCORM player redirect did not complete."
          }
        );
      }

      await muteAndPlayPresentation();

      progressState.lastScormStartedAt = new Date().toISOString();
      progressState.currentSessionId = `${targetSection.id}-${Date.now()}`;
      await saveProgressStateSafe(progressState);
      const remainingMinutes = Math.max(0, dailyLimitMinutes - progressState.dailyProgress.completedMinutes);
      if (remainingMinutes <= 0) {
        await exitCurrentScormSafely(targetSection, "daily_limit_reached_before_session").catch(async (error) => {
          await appendLog("scorm_safe_exit_failed", {
            sectionId: targetSection.id,
            reason: "daily_limit_reached_before_session",
            message: error?.message || String(error),
            url: getSafeWebviewUrl() || null
          });
          return false;
        });
        await appendLog("daily_limit_reached", {
          completedMinutesToday: progressState.dailyProgress.completedMinutes,
          dailyLimitMinutes
        });
        await updateRuntimeState({
          status: "idle",
          paused: false,
          processRunning: false,
          nextPlannedExitAt: null,
          todayMinutes: progressState.dailyProgress.completedMinutes
        }, "Daily limit reached");
        return;
      }
      const activeWindow = isNowWithinAnyWindow(scheduleWindows).activeWindow;
      const activeWindowIndex = resolveActiveWindowIndex(activeWindow);
      const windowRemaining = minutesUntilWindowEnd(activeWindow);
      const effectiveRemainingMinutes =
        windowRemaining === null ? remainingMinutes : Math.max(0, Math.min(remainingMinutes, windowRemaining));
      if (effectiveRemainingMinutes <= 0) {
        continue;
      }

      // If we're in the first window (night) and already hit the randomized night budget, wait until next window.
      const split = progressState.schedulerDailySplit;
      if (
        activeWindowIndex === 0 &&
        split &&
        Number.isFinite(Number(split.plannedNightMinutes)) &&
        Number.isFinite(Number(split.nightMinutes)) &&
        Number(split.plannedNightMinutes) > 0 &&
        Number(split.nightMinutes) >= Number(split.plannedNightMinutes)
      ) {
        const nextStart = computeNextWindowStart(scheduleWindows);
        const nextStartIso = nextStart ? nextStart.toISOString() : null;
        await appendLog("schedule_night_budget_reached", {
          plannedNightMinutes: split.plannedNightMinutes,
          nightMinutes: split.nightMinutes,
          nextWindowStartIso: nextStartIso
        });
        await updateRuntimeState(
          {
            status: "paused",
            paused: true,
            nextPlannedExitAt: nextStartIso,
            currentUrl: getSafeWebviewUrl() || null
          },
          "Night budget reached; waiting for next window"
        );
        while (!embeddedAutomation.stopRequested && !isNowWithinAnyWindow(scheduleWindows).within) {
          const next = computeNextWindowStart(scheduleWindows);
          const wakeMs = next ? Math.max(5_000, Math.min(60_000, next.getTime() - Date.now())) : 60_000;
          await delay(wakeMs);
        }
        await updateRuntimeState(
          {
            status: "running",
            paused: false,
            currentUrl: getSafeWebviewUrl() || null
          },
          "Resuming in next window"
        );
        continue;
      }

      const sessionMinutes = await window.desktopApi.pickSessionMinutes({
        range: sessionRange,
        remainingMinutes: effectiveRemainingMinutes
      });
      const plannedExitAt = new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString();
      await appendLog("scorm_session_started", {
        sectionId: targetSection.id,
        sessionId: progressState.currentSessionId,
        startedAt: progressState.lastScormStartedAt,
        chosenSessionMinutes: sessionMinutes,
        rangeMin: sessionRange.min,
        rangeMax: sessionRange.max,
        url: getSafeWebviewUrl()
      });
      await updateRuntimeState({
        currentUrl: getSafeWebviewUrl(),
        nextPlannedExitAt: plannedExitAt
      }, `Waiting ${sessionMinutes} minutes before exit`);

      let persistedSessionMinutes = 0;
      const persistOneMinute = async () => {
        if (persistedSessionMinutes >= sessionMinutes) {
          return;
        }
        await applyIncrementalSessionProgress(
          progressState,
          targetSection,
          progressState.currentSessionId,
          `minute-${persistedSessionMinutes + 1}`,
          1
        );
        const split = progressState.schedulerDailySplit;
        if (split && split.date === getAthensDayKey()) {
          const activeWindow = isNowWithinAnyWindow(scheduleWindows).activeWindow;
          const idx = resolveActiveWindowIndex(activeWindow);
          if (idx === 0) {
            split.nightMinutes = Number(split.nightMinutes || 0) + 1;
          } else if (idx === 1) {
            split.eveningMinutes = Number(split.eveningMinutes || 0) + 1;
          }
          await saveProgressStateSafe(progressState);
        }
        persistedSessionMinutes += 1;
      };
      const sessionOutcome = await advanceSlidesUntil(Date.now() + sessionMinutes * 60 * 1000, persistOneMinute);
      if (sessionOutcome === "stopped") {
        await exitCurrentScormSafely(targetSection, "user_stop_requested").catch(async (error) => {
          await appendLog("scorm_safe_exit_failed", {
            sectionId: targetSection.id,
            reason: "user_stop_requested",
            message: error?.message || String(error),
            url: getSafeWebviewUrl() || null
          });
          return false;
        });
        progressState.lastScormExitedAt = new Date().toISOString();
        await saveProgressStateSafe(progressState);
        await appendLog("embedded_automation_stopped", {
          sectionId: targetSection.id,
          url: getSafeWebviewUrl() || null
        });
        await updateRuntimeState({
          status: "idle",
          paused: false,
          processRunning: false,
          nextPlannedExitAt: null,
          currentUrl: getSafeWebviewUrl() || null
        }, "Stopped safely by user");
        return;
      }
      const remainingSessionMinutes = Math.max(0, sessionMinutes - persistedSessionMinutes);
      if (remainingSessionMinutes > 0) {
        await applyIncrementalSessionProgress(
          progressState,
          targetSection,
          progressState.currentSessionId,
          "final-remainder",
          remainingSessionMinutes
        );
      }

      await exitCurrentScormSafely(targetSection, "session_completed").catch(async (error) => {
        await appendLog("scorm_safe_exit_failed", {
          sectionId: targetSection.id,
          reason: "session_completed",
          message: error?.message || String(error),
          url: getSafeWebviewUrl() || null
        });
        throw error;
      });

      await syncProgressState(progressState, targetSection, sessionMinutes);
      await appendLog("scorm_session_completed", {
        sectionId: targetSection.id,
        sessionMinutes,
        chosenSessionMinutes: sessionMinutes,
        rangeMin: sessionRange.min,
        rangeMax: sessionRange.max,
        completedMinutesToday: progressState.dailyProgress.completedMinutes,
        completedMinutesForSection: progressState.lessonProgress[targetSection.id].completedMinutes,
        url: getSafeWebviewUrl()
      });
      await refreshDashboard();
    }
  } finally {
    embeddedAutomation.running = false;
    embeddedAutomation.stopRequested = false;
    await updateRuntimeState({
      status: "idle",
      paused: false,
      processRunning: false,
      nextPlannedExitAt: null,
      currentUrl: getSafeWebviewUrl() || null
    }, "Embedded automation stopped");
    await refreshDashboard();
  }
}

async function handleStartBot() {
  if (embeddedAutomation.running) {
    return;
  }

  try {
    maybeNotify("Study session started.", "startStop");
    await window.desktopApi
      .sendDiscordNotification({
        kind: "startStop",
        message: "Study session started (embedded automation)."
      })
      .catch(() => null);
    updateOnboardingChecklist("startedAutomation", true);
    recordUiTelemetry("start_automation");
    await runEmbeddedAutomation();
  } catch (error) {
    embeddedAutomation.running = false;
    embeddedAutomation.stopRequested = false;
    if (error.message === "Automation stopped by user.") {
      await appendLog("embedded_automation_stopped", {
        url: getSafeWebviewUrl() || null
      });
      await updateRuntimeState({
        status: "idle",
        paused: false,
        processRunning: false,
        nextPlannedExitAt: null,
        currentUrl: getSafeWebviewUrl() || null
      }, "Stopped by user");
      await refreshDashboard();
      return;
    }

    await appendLog("embedded_automation_failed", {
      message: error.message,
      url: getSafeWebviewUrl() || null
    });
    await window.desktopApi
      .sendDiscordNotification({
        kind: "errors",
        message: "Embedded automation failed.",
        details: { message: error.message, url: getSafeWebviewUrl() || null }
      })
      .catch(() => null);
    await updateRuntimeState({
      status: "error",
      paused: false,
      processRunning: false,
      nextPlannedExitAt: null,
      currentUrl: getSafeWebviewUrl() || null
    }, `Error: ${error.message}`);
    await refreshDashboard();
    console.error(error);
  }
}

async function handleStopBot() {
  embeddedAutomation.stopRequested = true;
  recordUiTelemetry("stop_automation");
  maybeNotify("Stopping safely...", "startStop");
  await window.desktopApi
    .sendDiscordNotification({
      kind: "startStop",
      message: "Stop requested (embedded automation)."
    })
    .catch(() => null);
  if (isScormUrl(getSafeWebviewUrl() || "")) {
    await appendLog("stop_requested_during_scorm", {
      url: getSafeWebviewUrl() || null
    });
  }
  await appendLog("embedded_automation_stop_requested", {
    url: getSafeWebviewUrl() || null
  });
  await exitCurrentScormSafely(null, "user_stop_requested").catch(async (error) => {
    await appendLog("scorm_safe_exit_failed", {
      sectionId: null,
      reason: "user_stop_requested",
      message: error?.message || String(error),
      url: getSafeWebviewUrl() || null
    });
    return false;
  });
  await updateRuntimeState({
    status: "paused",
    paused: true,
    processRunning: true,
    nextPlannedExitAt: null
  }, "Stopping safely");
  await refreshDashboard();
}

function setupEmbeddedBrowser() {
  const webview = getWebview();
  let readySettled = false;

  if (typeof window.desktopApi.onWebviewWindowOpen === "function") {
    if (typeof detachWebviewWindowOpenListener === "function") {
      detachWebviewWindowOpenListener();
    }
    detachWebviewWindowOpenListener = window.desktopApi.onWebviewWindowOpen((payload) => {
      const targetUrl = String(payload?.targetUrl || "").trim();
      if (!targetUrl) {
        return;
      }
      appendLog("webview_popup_intercepted_main", {
        targetUrl,
        sourceUrl: payload?.sourceUrl || getSafeWebviewUrl() || null
      }).catch(() => {});
      loadUrl(targetUrl)
        .then(() => updateRuntimeState({ currentUrl: getSafeWebviewUrl() || targetUrl }, "Popup URL intercepted"))
        .catch((error) =>
          appendLog("webview_popup_intercept_failed", {
            targetUrl,
            message: error?.message || String(error || "Unknown popup interception error")
          }).catch(() => {})
        );
    });
  }
  if (typeof window.desktopApi.onWebviewJsDialog === "function") {
    if (typeof detachWebviewJsDialogListener === "function") {
      detachWebviewJsDialogListener();
    }
    detachWebviewJsDialogListener = window.desktopApi.onWebviewJsDialog((payload) => {
      const dialogType = String(payload?.dialogType || "unknown");
      appendLog("webview_js_dialog_auto_accepted", {
        dialogType,
        message: String(payload?.message || "").slice(0, 300),
        url: payload?.url || getSafeWebviewUrl() || null
      }).catch(() => {});
      updateRuntimeState(
        { currentUrl: payload?.url || getSafeWebviewUrl() || null },
        `Auto-accepted ${dialogType} dialog`
      ).catch(() => {});
    });
  }

  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    embeddedAutomation.webviewReady = true;
    if (embeddedAutomation.webviewReadyResolver) {
      embeddedAutomation.webviewReadyResolver(true);
    }
    embeddedAutomation.webviewReadyResolver = null;
    embeddedAutomation.webviewReadyRejector = null;
  };

  const markFailed = (message) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    if (embeddedAutomation.webviewReadyRejector) {
      embeddedAutomation.webviewReadyRejector(new Error(message));
    }
    embeddedAutomation.webviewReadyResolver = null;
    embeddedAutomation.webviewReadyRejector = null;
  };

  webview.addEventListener("did-navigate", syncEmbeddedUrl);
  webview.addEventListener("did-navigate-in-page", syncEmbeddedUrl);
  webview.addEventListener("did-start-navigation", (event) => {
    appendLog("webview_did_start_navigation", {
      url: event?.url || getSafeWebviewUrl(),
      isMainFrame: Boolean(event?.isMainFrame),
      isInPlace: Boolean(event?.isInPlace)
    }).catch(() => {});
  });
  webview.addEventListener("did-redirect-navigation", (event) => {
    appendLog("webview_did_redirect_navigation", {
      url: event?.url || getSafeWebviewUrl(),
      isMainFrame: Boolean(event?.isMainFrame),
      isInPlace: Boolean(event?.isInPlace)
    }).catch(() => {});
  });
  webview.addEventListener("new-window", (event) => {
    const targetUrl = String(event.url || "").trim();
    if (!targetUrl) {
      return;
    }
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    appendLog("webview_popup_intercepted", {
      targetUrl,
      sourceUrl: getSafeWebviewUrl() || null
    }).catch(() => {});
    loadUrl(targetUrl)
      .then(() => updateRuntimeState({ currentUrl: getSafeWebviewUrl() || targetUrl }, "Popup URL intercepted"))
      .catch((error) =>
        appendLog("webview_popup_intercept_failed", {
          targetUrl,
          message: error?.message || String(error || "Unknown popup interception error")
        }).catch(() => {})
      );
  });
  webview.addEventListener("dom-ready", () => {
    syncEmbeddedUrl();
    appendLog("webview_dom_ready", { url: getSafeWebviewUrl() }).catch(() => {});
    markReady();
  });
  webview.addEventListener("did-finish-load", syncEmbeddedUrl);
  webview.addEventListener("did-start-loading", () => {
    appendLog("webview_did_start_loading", { url: getSafeWebviewUrl() }).catch(() => {});
  });
  webview.addEventListener("did-stop-loading", () => {
    appendLog("webview_did_stop_loading", { url: getSafeWebviewUrl() }).catch(() => {});
  });
  webview.addEventListener("did-fail-load", (event) => {
    if (event.errorCode === -3) {
      return;
    }

    const addressBar = document.getElementById("addressBar");
    const embeddedUrl = document.getElementById("embeddedUrl");
    if (addressBar) {
      addressBar.textContent = `Load failed: ${event.validatedURL || event.errorDescription}`;
    }
    if (embeddedUrl) {
      embeddedUrl.textContent = event.validatedURL || "-";
    }
    appendLog("webview_did_fail_load", {
      message: event.errorDescription,
      url: event.validatedURL || getSafeWebviewUrl()
    }).catch(() => {});
    markFailed(event.errorDescription || "Embedded browser failed to load.");
    console.error("Embedded browser load failed:", event.errorCode, event.errorDescription, event.validatedURL);
  });
  webview.addEventListener("console-message", (event) => {
    const messageText = `[${event.level}] ${event.message}`;
    if (shouldSkipWebviewConsoleMessage(messageText)) {
      return;
    }
    appendLog("webview_console_message", {
      message: messageText,
      url: getSafeWebviewUrl()
    }).catch(() => {});
  });
  webview.addEventListener("render-process-gone", (event) => {
    appendLog("webview_render_process_gone", {
      message: event.details?.reason || "unknown",
      url: getSafeWebviewUrl()
    }).catch(() => {});
    markFailed(`Embedded browser render process gone: ${event.details?.reason || "unknown"}`);
  });
  webview.addEventListener("destroyed", () => {
    appendLog("webview_destroyed", { url: getSafeWebviewUrl() }).catch(() => {});
    markFailed("Embedded browser was destroyed.");
  });

  embeddedAutomation.webviewReady = false;
  embeddedAutomation.webviewReadyPromise = new Promise((resolve, reject) => {
    embeddedAutomation.webviewReadyResolver = resolve;
    embeddedAutomation.webviewReadyRejector = reject;
  });

  window.setTimeout(() => {
    if (!embeddedAutomation.webviewReady) {
      markFailed("Embedded browser did not become ready in time.");
      appendLog("webview_ready_timeout", { url: getSafeWebviewUrl() }).catch(() => {});
    }
  }, WEBVIEW_READY_TIMEOUT_MS);

  webview.setAttribute("src", appConfig.loginUrl);
  syncEmbeddedUrl();
}

async function boot() {
  appConfig = await window.desktopApi.getAppConfig();
  loadUiTelemetry();
  wireTabNavigation();
  wireHelpSystem();
  document.getElementById("startBotBtn").addEventListener("click", handleStartBot);
  document.getElementById("testLoginOnlyBtn").addEventListener("click", handleTestLoginOnly);
  document.getElementById("syncStatsBtn").addEventListener("click", handleSyncWebsiteStats);
  document.getElementById("stopBotBtn").addEventListener("click", handleStopBot);
  document.getElementById("refreshBtn").addEventListener("click", refreshDashboard);
  document.getElementById("saveSettingsBtn").addEventListener("click", handleSaveSettings);
  document.getElementById("testDiscordWebhookBtn")?.addEventListener("click", handleTestDiscordWebhook);
  document.getElementById("testSettingsBtn").addEventListener("click", handleTestSettings);
  document.getElementById("previewSettingsBtn").addEventListener("click", toggleSettingsPreview);
  document.getElementById("presetSafeBtn").addEventListener("click", () => applyPreset("safe"));
  document.getElementById("presetBalancedBtn").addEventListener("click", () => applyPreset("balanced"));
  document.getElementById("presetFastBtn").addEventListener("click", () => applyPreset("fast"));
  document.getElementById("logFilter").addEventListener("input", () => renderLogs(fullLogs));
  document.getElementById("exportLogsBtn").addEventListener("click", exportCurrentLogs);
  document.getElementById("exportSupportBundleBtn").addEventListener("click", exportSupportBundle);
  document.getElementById("quickStartBtn").addEventListener("click", handleStartBot);
  document.getElementById("quickStopBtn").addEventListener("click", handleStopBot);
  document.getElementById("quickSyncBtn").addEventListener("click", handleSyncWebsiteStats);
  document.getElementById("quickExportBundleBtn").addEventListener("click", exportSupportBundle);
  document.getElementById("runAtTimeBtn").addEventListener("click", handleRunAtTime);
  document.getElementById("cancelScheduledRunBtn").addEventListener("click", handleCancelScheduledRun);
  document.getElementById("automationApplyScheduleBtn")?.addEventListener("click", handleApplyAutomationSchedule);
  document.getElementById("automationDisableScheduleBtn")?.addEventListener("click", handleDisableAutomationSchedule);
  document.getElementById("saveProfileBtn").addEventListener("click", saveCurrentProfile);
  document.getElementById("applyProfileBtn").addEventListener("click", applySavedProfile);
  document.getElementById("dismissOnboardingBtn").addEventListener("click", dismissOnboarding);
  document.getElementById("skipOnboardingOverlayBtn").addEventListener("click", dismissOnboarding);
  document.getElementById("openOnboardingTabBtn").addEventListener("click", () => {
    document.querySelector('.nav-btn[data-tab="onboarding"]')?.click();
    dismissOnboarding();
  });
  document.getElementById("resetOnboardingBtn").addEventListener("click", () => {
    localStorage.removeItem(ONBOARDING_STATE_KEY);
    renderOnboarding();
  });
  document.getElementById("autoSwapRangeBtn").addEventListener("click", autoSwapSessionRange);
  Array.from(document.querySelectorAll(".chip-btn[data-log-group]")).forEach((button) => {
    button.addEventListener("click", () => {
      activeLogGroup = button.getAttribute("data-log-group") || "all";
      Array.from(document.querySelectorAll(".chip-btn[data-log-group]")).forEach((chip) =>
        chip.classList.toggle("chip-active", chip === button)
      );
      renderLogs(fullLogs);
    });
  });
  [
    "settingsDashboardPort",
    "settingsSlowMo",
    "settingsTimeoutMs",
    "settingsSessionMinMinutes",
    "settingsSessionMaxMinutes",
    "settingsDailyLimitMinutes",
    "settingsUsername",
    "settingsPassword",
    "settingsHeadless",
    "notifDiscordEnabled",
    "discordWebhookUrl",
    "notifDiscordVerbose",
    "notifDiscordVerboseFlushSeconds"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      updateRiskBadges();
      renderSettingsPreview();
    });
    el.addEventListener("change", () => {
      updateRiskBadges();
      renderSettingsPreview();
    });
  });
  document.getElementById("togglePasswordBtn").addEventListener("click", () => {
    const passwordField = document.getElementById("settingsPassword");
    const toggle = document.getElementById("togglePasswordBtn");
    const isPassword = passwordField.getAttribute("type") === "password";
    passwordField.setAttribute("type", isPassword ? "text" : "password");
    toggle.textContent = isPassword ? "Hide" : "Show";
  });
  [
    "notifEnabled",
    "notifStartStop",
    "notifErrors",
    "notifLimits",
    "notifValidation",
    "verboseWebviewConsole",
    "settingsSimpleMode",
    "settingsLightTheme",
    "settingsDirectCourseMode"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (id === "settingsSimpleMode" || id === "settingsLightTheme") {
        applyUiPreferences(getSettingsFromForm());
      }
      renderSettingsPreview();
      persistCurrentSettingsSilently();
    });
  });
  await loadSettingsIntoUi();
  const scheduleTimeInput = document.getElementById("scheduleTimeInput");
  if (scheduleTimeInput && document.getElementById("settingsDefaultRunAtTime")) {
    scheduleTimeInput.value = document.getElementById("settingsDefaultRunAtTime").value || "17:40";
  }
  renderSavedProfilesSelect();
  renderOnboarding();
  setupEmbeddedBrowser();
  await refreshDashboard();
  embeddedAutomation.refreshIntervalId = window.setInterval(refreshDashboard, 3000);
}

window.addEventListener("error", (event) => {
  recordRendererError("renderer_window_error", event.error || event.message).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  recordRendererError("renderer_unhandled_rejection", event.reason).catch(() => {});
});

boot();
