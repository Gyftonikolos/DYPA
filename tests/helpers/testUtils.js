const fs = require("fs");
const os = require("os");
const path = require("path");

function makeTempDir(prefix = "dypa-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dirPath) {
  if (!dirPath) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

module.exports = {
  makeTempDir,
  cleanupDir,
  freshRequire
};
