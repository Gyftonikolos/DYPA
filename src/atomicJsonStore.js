const fs = require("fs");
const path = require("path");

function getAbsolutePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function readJsonFile(filePath, fallback) {
  const absolutePath = getAbsolutePath(filePath);
  try {
    if (!fs.existsSync(absolutePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, payload) {
  const absolutePath = getAbsolutePath(filePath);
  const tempPath = `${absolutePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, absolutePath);
}

function updateJsonFileVersioned(filePath, mutateFn, options = {}) {
  const fallback = options.fallback || {};
  const expectedVersion = options.expectedVersion;
  const current = readJsonFile(filePath, fallback);
  const currentVersion = Number(current?.stateVersion || 0);
  if (
    Number.isFinite(Number(expectedVersion)) &&
    Number(expectedVersion) !== currentVersion
  ) {
    return {
      ok: false,
      reason: "version_mismatch",
      expectedVersion: Number(expectedVersion),
      currentVersion,
      current
    };
  }
  const next = mutateFn({ ...current }) || current;
  next.stateVersion = currentVersion + 1;
  next.updatedAt = new Date().toISOString();
  writeJsonFileAtomic(filePath, next);
  return { ok: true, value: next };
}

module.exports = {
  getAbsolutePath,
  readJsonFile,
  writeJsonFileAtomic,
  updateJsonFileVersioned
};
