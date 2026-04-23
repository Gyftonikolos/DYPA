const assert = require("assert");
const { resolveSessionRange, pickSessionMinutes } = require("../../src/sessionPolicy");

function testResolveSessionRange() {
  const range = resolveSessionRange(
    { scormSessionMinMinutes: 38, scormSessionMaxMinutes: 41 },
    { scormSessionMinMinutes: 30, scormSessionMaxMinutes: 50 }
  );
  assert.deepStrictEqual(range, { min: 38, max: 41 });

  const fallback = resolveSessionRange({}, { maxScormSessionMinutes: 40 });
  assert.deepStrictEqual(fallback, { min: 40, max: 40 });
}

function testPickSessionMinutesClamp() {
  for (let i = 0; i < 20; i += 1) {
    const picked = pickSessionMinutes({ min: 38, max: 41 }, 39);
    assert.ok(picked >= 1 && picked <= 39);
  }
  assert.strictEqual(pickSessionMinutes({ min: 38, max: 41 }, 0), 1);
}

function main() {
  testResolveSessionRange();
  testPickSessionMinutesClamp();
  console.log("sessionPolicy unit tests passed");
}

main();
