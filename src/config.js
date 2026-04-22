require("dotenv").config();

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  baseUrl: process.env.BASE_URL || "https://edu.golearn.gr/training/trainee/training",
  loginUrl:
    process.env.LOGIN_URL || "https://edu.golearn.gr/login?returnUrl=%2Fp%2Fm%2Fel-GR",
  headless: parseBoolean(process.env.HEADLESS, false),
  slowMo: parseNumber(process.env.SLOW_MO, 250),
  timeoutMs: parseNumber(process.env.TIMEOUT_MS, 30_000),
  maxScormSessionMinutes: parseNumber(process.env.MAX_SCORM_SESSION_MINUTES, 40),
  dailyScormLimitMinutes: parseNumber(process.env.DAILY_SCORM_LIMIT_MINUTES, 360),
  storageStatePath: process.env.STORAGE_STATE_PATH || "storage-state.json",
  progressStatePath: process.env.PROGRESS_STATE_PATH || "progress-state.json",
  sessionLogPath: process.env.SESSION_LOG_PATH || "session-log.jsonl",
  credentials: {
    username: process.env.GOLEARN_USERNAME || "",
    password: process.env.GOLEARN_PASSWORD || ""
  }
};
