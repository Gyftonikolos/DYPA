const assert = require("assert");
const fs = require("fs");
const path = require("path");

function main() {
  const rendererPath = path.resolve(__dirname, "../../electron/renderer/renderer.js");
  const rendererJs = fs.readFileSync(rendererPath, "utf8");

  assert.ok(rendererJs.includes("const shouldRefreshHeartbeat ="));
  assert.ok(rendererJs.includes("lastAction !== null"));
  assert.ok(rendererJs.includes("embeddedAutomation.running"));
  assert.ok(rendererJs.includes("patch?.processRunning === true"));

  const heartbeatRefreshPattern =
    /const shouldRefreshHeartbeat =[\s\S]*?if \(shouldRefreshHeartbeat\)\s*\{\s*runtimeDiagnostics\.heartbeatAt = new Date\(\)\.toISOString\(\);/m;
  assert.ok(
    heartbeatRefreshPattern.test(rendererJs),
    "Expected heartbeat refresh guard for active updates without lastAction."
  );

  console.log("renderer heartbeat unit tests passed");
}

main();
