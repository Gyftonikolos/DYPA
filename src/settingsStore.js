const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS_VERSION = 6;

const DEFAULT_SETTINGS = {
  baseUrl: null,
  loginUrl: null,
  dashboardPort: null,
  headless: null,
  slowMo: null,
  timeoutMs: 30_000,
  scormSessionMinMinutes: 38,
  scormSessionMaxMinutes: 41,
  maxScormSessionMinutes: null,
  dailyScormLimitMinutes: 350,
  storageStatePath: null,
  progressStatePath: null,
  sessionLogPath: null,
  runtimeStatePath: null,
  featureFlags: {
    notifications: {
      enabled: true,
      startStop: true,
      errors: true,
      limits: true,
      validation: true,
      discordWebhookEnabled: false,
      discordWebhookUrl: ""
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
  },
  scheduler: {
    defaultRunAtLocalTime: "17:40",
    allowedWindowsCsv: "",
    nightTargetMinutes: 120,
    nightJitterMinutes: 15
  },
  credentials: {
    username: "",
    password: ""
  }
};

function getSettingsDir() {
  if (process.env.DYPA_SETTINGS_DIR) {
    return process.env.DYPA_SETTINGS_DIR;
  }

  return path.join(os.homedir(), ".dypa-automation");
}

function getSettingsPaths() {
  const baseDir = getSettingsDir();
  return {
    settingsPath: path.join(baseDir, "app-settings.json"),
    keyPath: path.join(baseDir, "app-settings.key")
  };
}

function ensureSettingsDirectory() {
  const { settingsPath } = getSettingsPaths();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
}

function getOrCreateKey() {
  ensureSettingsDirectory();
  const { keyPath } = getSettingsPaths();
  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === 32) {
      return existing;
    }
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key);
  return key;
}

function encryptSecret(plainText) {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText || ""), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decryptSecret(cipherText) {
  if (!cipherText) {
    return "";
  }

  const key = getOrCreateKey();
  const payload = Buffer.from(cipherText, "base64");
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
}

function readRawSettings() {
  const { settingsPath } = getSettingsPaths();
  const empty = {
    version: SETTINGS_VERSION,
    updatedAt: null,
    config: { ...DEFAULT_SETTINGS, credentials: undefined },
    secrets: {}
  };
  if (!fs.existsSync(settingsPath)) {
    return empty;
  }

  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return empty;
  }
}

function migrateRawSettings(rawInput) {
  const raw = rawInput && typeof rawInput === "object" ? { ...rawInput } : {};
  const migrated = {
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    updatedAt: raw.updatedAt || null,
    config: { ...(raw.config || {}) },
    secrets: { ...(raw.secrets || {}) }
  };

  if (migrated.version < 2) {
    const rangeFallback = Number(
      migrated.config.maxScormSessionMinutes || migrated.config.scormSessionMinutes || 40
    );
    if (
      !Number.isFinite(Number(migrated.config.scormSessionMinMinutes)) ||
      Number(migrated.config.scormSessionMinMinutes) <= 0
    ) {
      migrated.config.scormSessionMinMinutes = rangeFallback;
    }
    if (
      !Number.isFinite(Number(migrated.config.scormSessionMaxMinutes)) ||
      Number(migrated.config.scormSessionMaxMinutes) <= 0
    ) {
      migrated.config.scormSessionMaxMinutes = rangeFallback;
    }
    migrated.version = 2;
  }
  if (migrated.version < 3) {
    if (migrated.config?.featureFlags?.checklist) {
      delete migrated.config.featureFlags.checklist;
    }
    migrated.version = 3;
  }
  if (migrated.version < 4) {
    if (!migrated.config.scheduler || typeof migrated.config.scheduler !== "object") {
      migrated.config.scheduler = { defaultRunAtLocalTime: "17:40" };
    }
    if (!migrated.config.scheduler.defaultRunAtLocalTime) {
      migrated.config.scheduler.defaultRunAtLocalTime = "17:40";
    }
    migrated.version = 4;
  }
  if (migrated.version < 5) {
    if (!migrated.config.scheduler || typeof migrated.config.scheduler !== "object") {
      migrated.config.scheduler = { defaultRunAtLocalTime: "17:40", allowedWindowsCsv: "" };
    }
    if (!Object.hasOwn(migrated.config.scheduler, "allowedWindowsCsv")) {
      migrated.config.scheduler.allowedWindowsCsv = "";
    }
    if (!Object.hasOwn(migrated.config.scheduler, "nightTargetMinutes")) {
      migrated.config.scheduler.nightTargetMinutes = 120;
    }
    if (!Object.hasOwn(migrated.config.scheduler, "nightJitterMinutes")) {
      migrated.config.scheduler.nightJitterMinutes = 15;
    }
    migrated.version = 5;
  }
  if (migrated.version < 6) {
    if (!migrated.config.featureFlags || typeof migrated.config.featureFlags !== "object") {
      migrated.config.featureFlags = {};
    }
    if (!migrated.config.featureFlags.notifications || typeof migrated.config.featureFlags.notifications !== "object") {
      migrated.config.featureFlags.notifications = {};
    }
    if (!Object.hasOwn(migrated.config.featureFlags.notifications, "discordWebhookEnabled")) {
      migrated.config.featureFlags.notifications.discordWebhookEnabled = false;
    }
    if (!Object.hasOwn(migrated.config.featureFlags.notifications, "discordWebhookUrl")) {
      migrated.config.featureFlags.notifications.discordWebhookUrl = "";
    }
    migrated.version = 6;
  }

  return migrated;
}

function loadSettings() {
  const raw = migrateRawSettings(readRawSettings());
  const password = raw.secrets?.golearnPassword ? decryptSecret(raw.secrets.golearnPassword) : "";
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(raw.config || {}),
    credentials: {
      username: raw.config?.credentials?.username || "",
      password
    }
  };

  const migratedRangeFallback = Number(raw.config?.maxScormSessionMinutes || raw.config?.scormSessionMinutes || 40);
  if (!Number.isFinite(Number(merged.scormSessionMinMinutes)) || Number(merged.scormSessionMinMinutes) <= 0) {
    merged.scormSessionMinMinutes = migratedRangeFallback;
  }
  if (!Number.isFinite(Number(merged.scormSessionMaxMinutes)) || Number(merged.scormSessionMaxMinutes) <= 0) {
    merged.scormSessionMaxMinutes = migratedRangeFallback;
  }
  if (Number(merged.scormSessionMaxMinutes) < Number(merged.scormSessionMinMinutes)) {
    merged.scormSessionMaxMinutes = Number(merged.scormSessionMinMinutes);
  }

  if (raw.version !== SETTINGS_VERSION) {
    saveSettings(merged);
  }

  return merged;
}

function saveSettings(nextSettings) {
  ensureSettingsDirectory();
  const { settingsPath } = getSettingsPaths();
  const currentRaw = readRawSettings();
  const previousEncryptedPassword = currentRaw.secrets?.golearnPassword || "";
  const passwordProvided = Object.prototype.hasOwnProperty.call(nextSettings.credentials || {}, "password");
  const nextPassword = passwordProvided
    ? String(nextSettings.credentials.password || "")
    : decryptSecret(previousEncryptedPassword || "");

  const configPayload = {
    ...DEFAULT_SETTINGS,
    ...nextSettings,
    credentials: {
      username: String(nextSettings.credentials?.username || ""),
      password: undefined
    }
  };

  const rawPayload = {
    version: SETTINGS_VERSION,
    updatedAt: new Date().toISOString(),
    config: configPayload,
    secrets: {
      golearnPassword: nextPassword ? encryptSecret(nextPassword) : ""
    }
  };

  fs.writeFileSync(settingsPath, `${JSON.stringify(rawPayload, null, 2)}\n`, "utf8");
  return loadSettings();
}

function sanitizeForRenderer(settings) {
  return {
    ...settings,
    credentials: {
      username: settings.credentials?.username || "",
      password: settings.credentials?.password || ""
    }
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  getSettingsPaths,
  loadSettings,
  saveSettings,
  sanitizeForRenderer,
  migrateRawSettings
};
