const assert = require("assert");
const path = require("path");
const { makeTempDir, cleanupDir, freshRequire } = require("../helpers/testUtils");

function main() {
  const dir = makeTempDir("dypa-settings-unit-");
  const oldSettingsDir = process.env.DYPA_SETTINGS_DIR;
  try {
    process.env.DYPA_SETTINGS_DIR = dir;
    const settingsStore = freshRequire("../../src/settingsStore");

    const initial = settingsStore.loadSettings();
    assert.strictEqual(initial.scormSessionMinMinutes, 38);
    assert.strictEqual(initial.scormSessionMaxMinutes, 41);
    assert.strictEqual(initial.dailyScormLimitMinutes, 350);
    assert.strictEqual(initial.timeoutMs, 30000);

    const saved = settingsStore.saveSettings({
      ...initial,
      timeoutMs: 45000,
      featureFlags: {
        ...initial.featureFlags,
        ui: { simpleMode: true, lightTheme: true }
      },
      credentials: { username: "u", password: "p" }
    });
    assert.strictEqual(saved.timeoutMs, 45000);
    assert.strictEqual(saved.featureFlags.ui.simpleMode, true);
    assert.strictEqual(saved.featureFlags.ui.lightTheme, true);
    assert.strictEqual(saved.credentials.username, "u");
    assert.strictEqual(saved.credentials.password, "p");
    console.log("settingsStore unit tests passed");
  } finally {
    if (oldSettingsDir === undefined) {
      delete process.env.DYPA_SETTINGS_DIR;
    } else {
      process.env.DYPA_SETTINGS_DIR = oldSettingsDir;
    }
    cleanupDir(dir);
  }
}

main();
