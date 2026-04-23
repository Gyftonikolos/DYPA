const assert = require("assert");
const { withRetry, classifyRetryError } = require("../../src/retryPolicy");

function testClassifyRetryError() {
  assert.strictEqual(classifyRetryError(new Error("timeout happened")), "transient");
  assert.strictEqual(
    classifyRetryError(new Error("Target page, context or browser has been closed")),
    "fatal"
  );
}

async function testWithRetryEventuallySucceeds() {
  let attempts = 0;
  const value = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("timeout");
      return "ok";
    },
    { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }
  );
  assert.strictEqual(value, "ok");
  assert.strictEqual(attempts, 2);
}

async function main() {
  testClassifyRetryError();
  await testWithRetryEventuallySucceeds();
  console.log("retryPolicy unit tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
