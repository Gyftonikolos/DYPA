const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRunSupervisor } = require("../src/runSupervisor");
const { STEP, StepError } = require("../src/stepContracts");
const {
  loadProgressState,
  applySessionMinutesIdempotent,
  addCompletedMinutes
} = require("../src/progressStore");
const {
  initRuntimeState,
  touchHeartbeat,
  getRuntimeState
} = require("../src/runtimeState");

async function testRecoverySupervisor() {
  let attempts = 0;
  const recoveryEvents = [];
  const supervisor = createRunSupervisor({
    onRecovery: async (event) => {
      recoveryEvents.push(event);
    }
  });
  const result = await supervisor.executeStep(STEP.OPEN_SCORM, async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new StepError(STEP.OPEN_SCORM, "transient open_scorm failure", "transient");
    }
    return { done: true };
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(attempts, 2);
  assert.ok(recoveryEvents.length >= 1);
}

async function testHeartbeatUpdate() {
  const runtimeFile = path.join(os.tmpdir(), `dypa-runtime-${Date.now()}.json`);
  fs.writeFileSync(runtimeFile, "{}\n", "utf8");
  initRuntimeState(runtimeFile);
  touchHeartbeat(STEP.PLAYBACK);
  const state = getRuntimeState();
  assert.ok(state.runtimeDiagnostics.heartbeatAt);
  assert.strictEqual(state.runtimeDiagnostics.currentStep, STEP.PLAYBACK);
}

async function testIdempotentCrashRestart() {
  const progressFile = path.join(os.tmpdir(), `dypa-progress-${Date.now()}.json`);
  fs.writeFileSync(progressFile, "{}\n", "utf8");
  const state1 = loadProgressState(progressFile);
  const first = applySessionMinutesIdempotent(state1, "session-restart", "checkpoint-1", () => {
    addCompletedMinutes(state1, 1);
  });
  assert.strictEqual(first.applied, true);

  const state2 = loadProgressState(progressFile);
  const second = applySessionMinutesIdempotent(state2, "session-restart", "checkpoint-1", () => {
    addCompletedMinutes(state2, 1);
  });
  assert.strictEqual(second.applied, false);
}

async function main() {
  await testRecoverySupervisor();
  await testHeartbeatUpdate();
  await testIdempotentCrashRestart();
  console.log("phase3 recovery tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
