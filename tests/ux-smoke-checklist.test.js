const assert = require("assert");
const fs = require("fs");
const path = require("path");

function mustContain(content, token) {
  assert.ok(content.includes(token), `Expected token missing: ${token}`);
}

function main() {
  const htmlPath = path.resolve(process.cwd(), "electron", "renderer", "index.html");
  const cssPath = path.resolve(process.cwd(), "electron", "renderer", "styles.css");
  const jsPath = path.resolve(process.cwd(), "electron", "renderer", "renderer.js");

  const html = fs.readFileSync(htmlPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");
  const js = fs.readFileSync(jsPath, "utf8");

  mustContain(html, "view-onboarding");
  mustContain(html, "onboardingOverlay");
  mustContain(html, "savedProfilesSelect");
  mustContain(html, "settingsSafetyWarning");
  mustContain(html, "quickExportBundleBtn");
  mustContain(html, "runAtTimeBtn");
  mustContain(html, "settingsDefaultRunAtTime");

  mustContain(css, ".onboarding-overlay");
  mustContain(css, ".settings-safety-warning");
  mustContain(css, ".view.active");

  mustContain(js, "recordUiTelemetry(");
  mustContain(js, "renderOnboarding(");
  mustContain(js, "saveCurrentProfile(");
  mustContain(js, "renderSavedProfilesSelect(");

  console.log("ux smoke checklist passed");
}

main();
