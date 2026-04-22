const fs = require("fs");
const path = require("path");

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
  dashboardStartedAt: null
};

let state = { ...defaultState };

function saveState() {
  state.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

function getRuntimeState() {
  return state;
}

module.exports = {
  initRuntimeState,
  updateRuntimeState,
  setLessonTotals,
  setLastAction,
  getRuntimeState
};
