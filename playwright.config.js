const { defineConfig } = require("playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL || "https://edu.golearn.gr/training/trainee/training",
    headless: String(process.env.HEADLESS || "false").toLowerCase() === "true",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  }
});
