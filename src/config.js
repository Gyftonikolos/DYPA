require("dotenv").config();
const { loadSettings } = require("./settingsStore");

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  ...(() => {
    const persisted = loadSettings();
    return {
      baseUrl: persisted.baseUrl || process.env.BASE_URL || "https://edu.golearn.gr/training/trainee/training",
      loginUrl:
        persisted.loginUrl ||
        process.env.LOGIN_URL ||
        "https://edu.golearn.gr/login?returnUrl=%2Fp%2Fm%2Fel-GR",
      dashboardPort: parseNumber(persisted.dashboardPort, parseNumber(process.env.DASHBOARD_PORT, 3030)),
      headless: parseBoolean(persisted.headless, parseBoolean(process.env.HEADLESS, false)),
      slowMo: parseNumber(persisted.slowMo, parseNumber(process.env.SLOW_MO, 250)),
      timeoutMs: parseNumber(persisted.timeoutMs, parseNumber(process.env.TIMEOUT_MS, 30_000)),
      scormSessionMinMinutes: parseNumber(
        persisted.scormSessionMinMinutes,
        parseNumber(process.env.SCORM_SESSION_MIN_MINUTES, parseNumber(process.env.MAX_SCORM_SESSION_MINUTES, 38))
      ),
      scormSessionMaxMinutes: parseNumber(
        persisted.scormSessionMaxMinutes,
        parseNumber(process.env.SCORM_SESSION_MAX_MINUTES, parseNumber(process.env.MAX_SCORM_SESSION_MINUTES, 41))
      ),
      maxScormSessionMinutes: parseNumber(
        persisted.maxScormSessionMinutes,
        parseNumber(process.env.MAX_SCORM_SESSION_MINUTES, 41)
      ),
      dailyScormLimitMinutes: parseNumber(
        persisted.dailyScormLimitMinutes,
        parseNumber(process.env.DAILY_SCORM_LIMIT_MINUTES, 350)
      ),
      directCourseMode: Boolean(persisted.featureFlags?.navigation?.directCourseMode),
      storageStatePath: persisted.storageStatePath || process.env.STORAGE_STATE_PATH || "storage-state.json",
      progressStatePath: persisted.progressStatePath || process.env.PROGRESS_STATE_PATH || "progress-state.json",
      sessionLogPath: persisted.sessionLogPath || process.env.SESSION_LOG_PATH || "session-log.jsonl",
      runtimeStatePath: persisted.runtimeStatePath || process.env.RUNTIME_STATE_PATH || "runtime-state.json",
      credentials: {
        username: persisted.credentials?.username || process.env.GOLEARN_USERNAME || "",
        password: persisted.credentials?.password || process.env.GOLEARN_PASSWORD || ""
      }
    };
  })(),
};
