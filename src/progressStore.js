const fs = require("fs");
const path = require("path");
const { writeJsonFileAtomic } = require("./atomicJsonStore");

const DEFAULT_STATE = {
  startedAt: null,
  baseSectionIndex: 0,
  lessonDurationMinutes: 60,
  scormSessionMinMinutes: null,
  scormSessionMaxMinutes: null,
  scormSessionMinutes: null,
  dailyScormLimitMinutes: null,
  preferredSectionId: null,
  lastResolvedSectionId: null,
  lastScormStartedAt: null,
  lastScormExitedAt: null,
  lessonProgress: {},
  dailyProgress: {
    date: null,
    completedMinutes: 0,
  },
  sessionLedger: {
    appliedKeys: {},
  },
  stateVersion: 0,
  updatedAt: null,
};

function getAbsolutePath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function appendSessionLog(filePath, entry) {
  const absolutePath = getAbsolutePath(filePath);
  const payload = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  fs.appendFileSync(absolutePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function validateAndClampProgressState(state, options = {}) {
  const warnings = [];
  const dailyLimitMinutes = Number(
    options.dailyLimitMinutes || state.dailyScormLimitMinutes || 0,
  );

  if (
    !state.dailyProgress ||
    !Number.isFinite(Number(state.dailyProgress.completedMinutes))
  ) {
    state.dailyProgress = {
      date: getCurrentDayKey(),
      completedMinutes: 0,
    };
    warnings.push({ type: "dailyProgress_invalid_reset" });
  }

  if (Number(state.dailyProgress.completedMinutes) < 0) {
    state.dailyProgress.completedMinutes = 0;
    warnings.push({ type: "dailyProgress_negative_clamped" });
  }

  if (
    dailyLimitMinutes > 0 &&
    Number(state.dailyProgress.completedMinutes) > dailyLimitMinutes
  ) {
    state.dailyProgress.completedMinutes = dailyLimitMinutes;
    warnings.push({
      type: "dailyProgress_over_limit_clamped",
      dailyLimitMinutes,
    });
  }

  if (state.lessonProgress && typeof state.lessonProgress === "object") {
    for (const [sectionId, lesson] of Object.entries(state.lessonProgress)) {
      const targetMinutes = Number(lesson?.targetHours || 0) * 60;
      if (!Number.isFinite(Number(lesson?.completedMinutes))) {
        lesson.completedMinutes = 0;
        warnings.push({ type: "lessonProgress_invalid_reset", sectionId });
      }
      if (Number(lesson.completedMinutes) < 0) {
        lesson.completedMinutes = 0;
        warnings.push({ type: "lessonProgress_negative_clamped", sectionId });
      }
      if (
        targetMinutes > 0 &&
        Number(lesson.completedMinutes) > targetMinutes
      ) {
        lesson.completedMinutes = targetMinutes;
        warnings.push({
          type: "lessonProgress_over_target_clamped",
          sectionId,
          targetMinutes,
        });
      }
    }
  }

  return warnings;
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
  serializableState.stateVersion =
    Number(serializableState.stateVersion || 0) + 1;
  serializableState.updatedAt = new Date().toISOString();
  state.stateVersion = serializableState.stateVersion;
  state.updatedAt = serializableState.updatedAt;
  writeJsonFileAtomic(_path, serializableState);
}

function ensureSessionLedger(state) {
  if (!state.sessionLedger || typeof state.sessionLedger !== "object") {
    state.sessionLedger = { appliedKeys: {} };
  }
  if (
    !state.sessionLedger.appliedKeys ||
    typeof state.sessionLedger.appliedKeys !== "object"
  ) {
    state.sessionLedger.appliedKeys = {};
  }
  return state.sessionLedger;
}

function applySessionMinutesIdempotent(
  state,
  sessionId,
  checkpointKey,
  applyFn,
) {
  const ledger = ensureSessionLedger(state);
  const key = `${String(sessionId || "unknown")}:${String(checkpointKey || "final")}`;
  if (ledger.appliedKeys[key]) {
    return { applied: false, key };
  }
  applyFn();
  ledger.appliedKeys[key] = new Date().toISOString();
  saveProgressState(state);
  return { applied: true, key };
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
    day: "2-digit",
  }).format(new Date());
}

function getAthensParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function getAthensOffsetMs(date = new Date()) {
  const parts = getAthensParts(date);
  const utcLikeAthens = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return utcLikeAthens - date.getTime();
}

function getAthensDayStartMs(date = new Date()) {
  const parts = getAthensParts(date);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0) -
    getAthensOffsetMs(date)
  );
}

function getCurrentAthensDayElapsedMinutes(startedAt, endedAt = new Date()) {
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return 0;
  }
  const dayStartMs = getAthensDayStartMs(new Date(endMs));
  const overlapStartMs = Math.max(startMs, dayStartMs);
  const overlapMs = Math.max(0, endMs - overlapStartMs);
  return Math.floor(overlapMs / 60000);
}

function addCompletedMinutesSplitByCurrentAthensDay(
  state,
  plannedMinutes,
  startedAt,
  endedAt = new Date(),
) {
  const dailyProgress = ensureDailyProgress(state);
  const currentDayElapsedMinutes = getCurrentAthensDayElapsedMinutes(
    startedAt,
    endedAt,
  );
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const fullElapsedMinutes =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.max(0, Math.round((endMs - startMs) / 60000))
      : 0;
  const targetPlannedMinutes =
    Number.isFinite(Number(plannedMinutes)) && Number(plannedMinutes) > 0
      ? Number(plannedMinutes)
      : currentDayElapsedMinutes;
  const minutesCountedToday =
    fullElapsedMinutes > 0
      ? Math.max(
          0,
          Math.min(
            targetPlannedMinutes,
            Math.round(
              (targetPlannedMinutes * currentDayElapsedMinutes) /
                fullElapsedMinutes,
            ),
          ),
        )
      : 0;

  dailyProgress.completedMinutes += minutesCountedToday;
  validateAndClampProgressState(state);
  saveProgressState(state);

  return {
    completedMinutesToday: dailyProgress.completedMinutes,
    minutesCountedToday,
    minutesCountedPreviousDay: Math.max(
      0,
      targetPlannedMinutes - minutesCountedToday,
    ),
  };
}

function ensureDailyProgress(state) {
  const currentDay = getCurrentDayKey();
  if (!state.dailyProgress || state.dailyProgress.date !== currentDay) {
    state.dailyProgress = {
      date: currentDay,
      completedMinutes: 0,
    };
    saveProgressState(state);
  }

  return state.dailyProgress;
}

function addCompletedMinutes(state, minutes) {
  const dailyProgress = ensureDailyProgress(state);
  dailyProgress.completedMinutes += minutes;
  validateAndClampProgressState(state);
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
      updatedAt: null,
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
  validateAndClampProgressState(state);
  saveProgressState(state);
  return lessonProgress;
}

function resolveSectionIndex(state, sectionCount) {
  const startedAtMs = new Date(state.startedAt).getTime();
  const lessonDurationMs = state.lessonDurationMinutes * 60 * 1000;
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const elapsedSteps =
    lessonDurationMs > 0 ? Math.floor(elapsedMs / lessonDurationMs) : 0;
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
  addCompletedMinutesSplitByCurrentAthensDay,
  validateAndClampProgressState,
  appendSessionLog,
  ensureLessonProgress,
  addCompletedLessonMinutes,
  applySessionMinutesIdempotent,
  ensureSessionLedger,
};
