const assert = require("assert");
const fs = require("fs");
const path = require("path");

function main() {
  const rendererPath = path.resolve(__dirname, "../../electron/renderer/renderer.js");
  const rendererJs = fs.readFileSync(rendererPath, "utf8");

  assert.ok(rendererJs.includes("async function waitForScormUrlWithLoginDetection"));
  assert.ok(rendererJs.includes("async function recoverScormOpenAfterLoginRedirect"));
  assert.ok(rendererJs.includes('err.code = "SCORM_LOGIN_REDIRECT"'));
  assert.ok(rendererJs.includes('"scorm_open_redirected_to_login"'));
  assert.ok(rendererJs.includes('"scorm_activity_click_failed_try_loadurl"'));
  assert.ok(rendererJs.includes("SCORM_ENTRY_URL_RE"));
  assert.ok(rendererJs.includes("enqueueWebviewLoad"));
  assert.ok(rendererJs.includes("webviewLoadQueue"));
  assert.ok(rendererJs.includes("WEBVIEW_ABORT_DEDUPE_MS"));
  assert.ok(rendererJs.includes('"webview_load_aborted_expected"'));
  assert.ok(rendererJs.includes("onWebviewJsDialog"));
  assert.ok(rendererJs.includes('"webview_js_dialog_auto_accepted"'));
  assert.ok(
    rendererJs.includes('loading\\s+[\'"][^\'"]+[\'"]'),
    "Expected loadUrl abort matcher to allow single- or double-quoted loading URLs."
  );
  assert.ok(
    rendererJs.includes("error.cause") || rendererJs.includes("error?.cause"),
    "Expected loadUrl to inspect nested error cause for errno -3."
  );

  console.log("scorm open recovery unit tests passed");
}

main();
