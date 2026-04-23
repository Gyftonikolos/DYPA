const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveLessonSelection } = require("../src/sharedOrchestrator");
const { withRetry } = require("../src/retryPolicy");
const {
  loadProgressState,
  applySessionMinutesIdempotent,
  addCompletedLessonMinutes,
  addCompletedMinutes
} = require("../src/progressStore");

async function testResolveLessonSelection() {
  const lessonSections = [
    { id: "3", lessonKey: "E1", targetHours: 1 },
    { id: "4", lessonKey: "E2", targetHours: 1 }
  ];
  const progressState = {
    lessonProgress: {
      "3": { completedMinutes: 60 },
      "4": { completedMinutes: 0 }
    }
  };
  const result = resolveLessonSelection(lessonSections, progressState);
  assert.strictEqual(result.selectedSectionId, "4");
  assert.strictEqual(result.reason, "previous_lesson_reached_target");
}

async function testRetryPolicy() {
  let tries = 0;
  const value = await withRetry(async () => {
    tries += 1;
    if (tries < 3) {
      throw new Error("timeout");
    }
    return "ok";
  }, { retries: 3, baseDelayMs: 1 });
  assert.strictEqual(value, "ok");
  assert.strictEqual(tries, 3);
}

async function testIdempotentLedger() {
  const tempFile = path.join(os.tmpdir(), `dypa-phase2-${Date.now()}.json`);
  fs.writeFileSync(tempFile, "{}\n", "utf8");
  const state = loadProgressState(tempFile);
  addCompletedMinutes(state, 0);
  addCompletedLessonMinutes(state, "3", 1, 0);

  const first = applySessionMinutesIdempotent(state, "session-a", "m1", () => {
    addCompletedMinutes(state, 1);
    addCompletedLessonMinutes(state, "3", 1, 1);
  });
  const second = applySessionMinutesIdempotent(state, "session-a", "m1", () => {
    addCompletedMinutes(state, 1);
    addCompletedLessonMinutes(state, "3", 1, 1);
  });

  assert.strictEqual(first.applied, true);
  assert.strictEqual(second.applied, false);
}

async function main() {
  await testResolveLessonSelection();
  await testRetryPolicy();
  await testIdempotentLedger();
  console.log("phase2-core tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
