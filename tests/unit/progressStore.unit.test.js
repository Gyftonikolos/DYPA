const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeTempDir, cleanupDir } = require("../helpers/testUtils");
const {
  loadProgressState,
  ensureProgressStarted,
  addCompletedMinutes,
  ensureLessonProgress,
  addCompletedLessonMinutes,
  applySessionMinutesIdempotent
} = require("../../src/progressStore");

function main() {
  const dir = makeTempDir("dypa-progress-unit-");
  try {
    const file = path.join(dir, "progress.json");
    fs.writeFileSync(file, "{}\n", "utf8");

    const state = loadProgressState(file);
    assert.ok(state);
    ensureProgressStarted(state);
    assert.ok(state.startedAt);

    const todayMinutes = addCompletedMinutes(state, 15);
    assert.ok(todayMinutes >= 15);

    const lesson = ensureLessonProgress(state, "3", 29);
    assert.strictEqual(lesson.targetHours, 29);
    const updatedLesson = addCompletedLessonMinutes(state, "3", 29, 10);
    assert.ok(updatedLesson.completedMinutes >= 10);

    const first = applySessionMinutesIdempotent(state, "session-a", "cp1", () => {
      addCompletedMinutes(state, 1);
    });
    const second = applySessionMinutesIdempotent(state, "session-a", "cp1", () => {
      addCompletedMinutes(state, 1);
    });
    assert.strictEqual(first.applied, true);
    assert.strictEqual(second.applied, false);
    console.log("progressStore unit tests passed");
  } finally {
    cleanupDir(dir);
  }
}

main();
