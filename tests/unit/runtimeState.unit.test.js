const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeTempDir, cleanupDir, freshRequire } = require("../helpers/testUtils");

function main() {
  const dir = makeTempDir("dypa-runtime-unit-");
  try {
    const file = path.join(dir, "runtime.json");
    fs.writeFileSync(file, "{}\n", "utf8");
    const runtimeState = freshRequire("../../src/runtimeState");

    runtimeState.initRuntimeState(file);
    let state = runtimeState.getRuntimeState();
    assert.strictEqual(state.status, "idle");

    runtimeState.transitionRuntimeState("running");
    state = runtimeState.getRuntimeState();
    assert.strictEqual(state.status, "running");
    assert.strictEqual(state.processRunning, true);

    runtimeState.updateRuntimeDiagnostics({ retryCount: 2 });
    runtimeState.touchHeartbeat("PLAYBACK");
    state = runtimeState.getRuntimeState();
    assert.strictEqual(state.runtimeDiagnostics.retryCount, 2);
    assert.strictEqual(state.runtimeDiagnostics.currentStep, "PLAYBACK");
    assert.ok(state.runtimeDiagnostics.heartbeatAt);

    runtimeState.transitionRuntimeState("idle");
    state = runtimeState.getRuntimeState();
    assert.strictEqual(state.status, "idle");
    console.log("runtimeState unit tests passed");
  } finally {
    cleanupDir(dir);
  }
}

main();
