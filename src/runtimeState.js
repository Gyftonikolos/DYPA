const fs = require("fs");
const path = require("path");
const { writeJsonFileAtomic } = require("./atomicJsonStore");

let runtimeStatePath = path.resolve(process.cwd(), "runtime-state.json");

const defaultState = {
  status: "idle",
  paused: false,
  currentLesson: null,
  currentLessonTitle: null,
  currentUrl: null,
  lastAction: "Idle",
  lastUpdatedAt: null,
  nextPlannedExitAt: null,
  todayMinutes: 0,
  dailyLimitMinutes: 0,
  lessonTotals: {},
  dashboardStartedAt: null,
  processRunning: false,
  runtimeDiagnostics: {
    currentStep: "-",
    lastSuccessfulStep: "-",
    retryCount: 0,
    lastSelectorFailure: "-",
    lastRecoveryAction: "-",
    recoveryAttempts: 0,
    lastStableCheckpoint: "-",
    heartbeatAt: null
  },
  scheduledRun: {
    enabled: false,
    runAtLocalTime: null,
    scheduledForIso: null,
    createdAt: null,
    status: "idle",
    triggerToken: null,
    consumedToken: null,
    lastTriggeredAt: null
  },
  stateVersion: 0,
  updatedAt: null
};

let state = { ...defaultState };

function saveState() {
  state.lastUpdatedAt = new Date().toISOString();
  state.stateVersion = Number(state.stateVersion || 0) + 1;
  state.updatedAt = new Date().toISOString();
  writeJsonFileAtomic(runtimeStatePath, state);
}

const VALID_TRANSITIONS = {
  idle: ["running"],
  running: ["paused", "stopping", "error", "idle"],
  paused: ["running", "stopping", "error", "idle"],
  stopping: ["idle", "error"],
  error: ["idle", "running"]
};

function transitionRuntimeState(nextStatus, patch = {}) {
  const from = state.status || "idle";
  const to = String(nextStatus || from);
  const allowed = VALID_TRANSITIONS[from] || [];
  if (to !== from && !allowed.includes(to)) {
    state.lastAction = `Invalid state transition blocked: ${from} -> ${to}`;
    saveState();
    return { ...state, transitionRejected: true };
  }
  state = {
    ...state,
    ...patch,
    status: to,
    processRunning: to === "running" || to === "paused" || to === "stopping"
  };
  saveState();
  return state;
}

function initRuntimeState(filePath) {
  runtimeStatePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (fs.existsSync(runtimeStatePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
      state = { ...defaultState, ...parsed };
    } catch {
      state = { ...defaultState };
    }
  }

  state.dashboardStartedAt = new Date().toISOString();
  saveState();
}

function updateRuntimeState(patch) {
  state = { ...state, ...patch };
  saveState();
  return state;
}

function setLessonTotals(lessonProgress = {}) {
  const lessonTotals = Object.fromEntries(
    Object.entries(lessonProgress).map(([sectionId, value]) => [
      sectionId,
      {
        targetHours: value.targetHours || 0,
        completedMinutes: value.completedMinutes || 0,
        updatedAt: value.updatedAt || null
      }
    ])
  );

  state.lessonTotals = lessonTotals;
  saveState();
  return state;
}

function setLastAction(lastAction, extra = {}) {
  state = {
    ...state,
    lastAction,
    ...extra
  };
  saveState();
  return state;
}

function updateRuntimeDiagnostics(patch = {}) {
  state.runtimeDiagnostics = {
    ...(state.runtimeDiagnostics || {}),
    ...patch
  };
  saveState();
  return state;
}

function touchHeartbeat(step = null) {
  const diagnostics = {
    ...(state.runtimeDiagnostics || {}),
    heartbeatAt: new Date().toISOString()
  };
  if (step) {
    diagnostics.currentStep = step;
  }
  state.runtimeDiagnostics = diagnostics;
  saveState();
  return state;
}

function getRuntimeState() {
  return state;
}

module.exports = {
  initRuntimeState,
  updateRuntimeState,
  transitionRuntimeState,
  setLessonTotals,
  setLastAction,
  updateRuntimeDiagnostics,
  touchHeartbeat,
  getRuntimeState
};
