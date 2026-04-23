const { fail, ok, StepError } = require("./stepContracts");
const { getRecoveryActionsForStep, getRecoveryBudget } = require("./recoveryPlaybooks");

function createRunSupervisor(deps = {}) {
  const timeline = [];
  const heartbeatByStep = {};

  function push(entry) {
    const event = { timestamp: new Date().toISOString(), ...entry };
    timeline.push(event);
    if (typeof deps.appendLog === "function") {
      deps.appendLog(event);
    }
  }

  async function executeStep(step, action) {
    const budget = getRecoveryBudget(step);
    let attempt = 0;
    while (attempt <= budget.maxAttempts) {
      attempt += 1;
      heartbeatByStep[step] = Date.now();
      push({ event: "supervisor_step_started", step, attempt });
      try {
        const result = await action({ attempt });
        push({ event: "supervisor_step_succeeded", step, attempt });
        if (typeof deps.onStepSuccess === "function") {
          await deps.onStepSuccess(step, attempt);
        }
        return ok(step, result || {});
      } catch (error) {
        const kind = error instanceof StepError ? error.kind : "transient";
        push({
          event: "supervisor_step_failed",
          step,
          attempt,
          kind,
          message: error.message || String(error)
        });
        if (kind === "fatal" || attempt > budget.maxAttempts) {
          if (typeof deps.onStepFailure === "function") {
            await deps.onStepFailure(step, attempt, error, kind);
          }
          return fail(step, error, kind, { attempt });
        }
        const actions = getRecoveryActionsForStep(step);
        const recoveryAction = actions[Math.min(attempt - 1, actions.length - 1)] || "retry";
        if (typeof deps.onRecovery === "function") {
          await deps.onRecovery({
            step,
            attempt,
            recoveryAction,
            cooldownMs: budget.cooldownMs,
            message: error.message || String(error)
          });
        }
        push({
          event: "supervisor_recovery_triggered",
          step,
          attempt,
          recoveryAction
        });
        await new Promise((resolve) => setTimeout(resolve, budget.cooldownMs));
      }
    }
    return fail(step, new Error("Step retries exhausted"), "transient");
  }

  function getHeartbeat(step) {
    return heartbeatByStep[step] || null;
  }

  function getTimeline(limit = 200) {
    return timeline.slice(-limit);
  }

  return {
    executeStep,
    getHeartbeat,
    getTimeline
  };
}

module.exports = {
  createRunSupervisor
};
