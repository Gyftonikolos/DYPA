const STEP = {
  AUTH: "auth",
  OPEN_COURSE: "open_course",
  OPEN_SCORM: "open_scorm",
  PLAYBACK: "playback",
  EXIT_SCORM: "exit_scorm"
};

class StepError extends Error {
  constructor(step, message, kind = "transient", details = {}) {
    super(message);
    this.name = "StepError";
    this.step = step;
    this.kind = kind;
    this.details = details;
  }
}

function ok(step, data = {}) {
  return {
    ok: true,
    step,
    kind: "ok",
    data,
    timestamp: new Date().toISOString()
  };
}

function fail(step, error, kind = "transient", details = {}) {
  return {
    ok: false,
    step,
    kind,
    error: String(error?.message || error || "unknown"),
    details,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  STEP,
  StepError,
  ok,
  fail
};
