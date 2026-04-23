const assert = require("assert");
const fs = require("fs");
const path = require("path");

function mustContain(content, token) {
  assert.ok(content.includes(token), `Expected token missing: ${token}`);
}

function main() {
  const html = fs.readFileSync(
    path.resolve(process.cwd(), "electron", "renderer", "index.html"),
    "utf8"
  );
  const preload = fs.readFileSync(
    path.resolve(process.cwd(), "electron", "preload.js"),
    "utf8"
  );
  const mainJs = fs.readFileSync(
    path.resolve(process.cwd(), "electron", "main.js"),
    "utf8"
  );
  const renderer = fs.readFileSync(
    path.resolve(process.cwd(), "electron", "renderer", "renderer.js"),
    "utf8"
  );

  mustContain(html, "runAtTimeBtn");
  mustContain(html, "cancelScheduledRunBtn");
  mustContain(html, "settingsDefaultRunAtTime");
  mustContain(html, "diagSchedulerStatus");
  mustContain(html, "diagScheduleCountdown");

  mustContain(preload, "setScheduledRun");
  mustContain(preload, "getScheduledRun");
  mustContain(preload, "clearScheduledRun");
  mustContain(preload, "consumeScheduledTrigger");

  mustContain(mainJs, "schedule:set-next-run");
  mustContain(mainJs, "schedule:get");
  mustContain(mainJs, "schedule:clear");
  mustContain(mainJs, "schedule:consume-trigger");

  mustContain(renderer, "handleRunAtTime");
  mustContain(renderer, "handleCancelScheduledRun");
  mustContain(renderer, "maybeHandleScheduledTrigger");

  console.log("phase5 schedule smoke passed");
}

main();
