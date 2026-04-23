const assert = require("assert");
const fs = require("fs");
const path = require("path");

function main() {
  const indexPath = path.resolve(__dirname, "../../electron/renderer/index.html");
  const rendererPath = path.resolve(__dirname, "../../electron/renderer/renderer.js");
  const cssPath = path.resolve(__dirname, "../../electron/renderer/styles.css");

  const html = fs.readFileSync(indexPath, "utf8");
  const rendererJs = fs.readFileSync(rendererPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");

  assert.ok(html.includes('id="settingsSimpleMode"'));
  assert.ok(html.includes('id="settingsLightTheme"'));
  assert.ok((html.match(/class="[^"]*dev-only[^"]*"/g) || []).length >= 5);
  assert.ok(rendererJs.includes("applyUiPreferences"));
  assert.ok(rendererJs.includes("settingsSimpleMode"));
  assert.ok(rendererJs.includes("settingsLightTheme"));
  assert.ok(css.includes("body.simple-mode .dev-only"));
  assert.ok(css.includes("body.theme-light"));
  console.log("renderer static integration tests passed");
}

main();
