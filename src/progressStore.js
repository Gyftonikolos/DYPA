const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = {
  startedAt: null,
  baseSectionIndex: 0,
  lessonDurationMinutes: 60,
  scormSessionMinutes: null,
  dailyScormLimitMinutes: null,
  lastResolvedSectionId: null,
  lastScormStartedAt: null,
  lastScormExitedAt: null,
  lessonProgress: {},
  dailyProgress: {
    date: null,
    completedMinutes: 0
  }
};

function getAbsolutePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function appendSessionLog(filePath, entry) {
  const absolutePath = getAbsolutePath(filePath);
  const payload = {
    timestamp: new Date().toISOString(),
    ...entry
  };

  fs.appendFileSync(absolutePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function loadProgressState(filePath) {
  const absolutePath = getAbsolutePath(filePath);

  if (!fs.existsSync(absolutePath)) {
    return { ...DEFAULT_STATE, _path: absolutePath };
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  return { ...DEFAULT_STATE, ...parsed, _path: absolutePath };
}

function saveProgressState(state) {
  const { _path, ...serializableState } = state;
  fs.writeFileSync(_path, `${JSON.stringify(serializableState, null, 2)}\n`, "utf8");
}

function ensureProgressStarted(state) {
  if (!state.startedAt) {
    state.startedAt = new Date().toISOString();
    saveProgressState(state);
  }

  return state;
}

function getCurrentDayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function ensureDailyProgress(state) {
  const currentDay = getCurrentDayKey();
  if (!state.dailyProgress || state.dailyProgress.date !== currentDay) {
    state.dailyProgress = {
      date: currentDay,
      completedMinutes: 0
    };
    saveProgressState(state);
  }

  return state.dailyProgress;
}

function addCompletedMinutes(state, minutes) {
  const dailyProgress = ensureDailyProgress(state);
  dailyProgress.completedMinutes += minutes;
  saveProgressState(state);
  return dailyProgress.completedMinutes;
}

function ensureLessonProgress(state, sectionId, targetHours) {
  if (!state.lessonProgress) {
    state.lessonProgress = {};
  }

  if (!state.lessonProgress[sectionId]) {
    state.lessonProgress[sectionId] = {
      targetHours,
      completedMinutes: 0,
      updatedAt: null
    };
    saveProgressState(state);
  } else if (state.lessonProgress[sectionId].targetHours !== targetHours) {
    state.lessonProgress[sectionId].targetHours = targetHours;
    saveProgressState(state);
  }

  return state.lessonProgress[sectionId];
}

function addCompletedLessonMinutes(state, sectionId, targetHours, minutes) {
  const lessonProgress = ensureLessonProgress(state, sectionId, targetHours);
  lessonProgress.completedMinutes += minutes;
  lessonProgress.updatedAt = new Date().toISOString();
  saveProgressState(state);
  return lessonProgress;
}

function resolveSectionIndex(state, sectionCount) {
  const startedAtMs = new Date(state.startedAt).getTime();
  const lessonDurationMs = state.lessonDurationMinutes * 60 * 1000;
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const elapsedSteps = lessonDurationMs > 0 ? Math.floor(elapsedMs / lessonDurationMs) : 0;
  const rawIndex = state.baseSectionIndex + elapsedSteps;

  return Math.min(Math.max(rawIndex, 0), Math.max(sectionCount - 1, 0));
}

module.exports = {
  loadProgressState,
  saveProgressState,
  ensureProgressStarted,
  resolveSectionIndex,
  ensureDailyProgress,
  addCompletedMinutes,
  appendSessionLog,
  ensureLessonProgress,
  addCompletedLessonMinutes
};
