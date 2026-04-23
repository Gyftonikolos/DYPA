function classifyRetryError(error) {
  const message = String(error?.message || "");
  if (/timed out|timeout|ERR_ABORTED|\(-3\)|net::/i.test(message)) {
    return "transient";
  }
  if (/Target page, context or browser has been closed/i.test(message)) {
    return "fatal";
  }
  return "transient";
}

async function withRetry(fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 400,
    maxDelayMs = 2500,
    classifyError = classifyRetryError,
    onRetry = null
  } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt + 1);
    } catch (error) {
      attempt += 1;
      const kind = classifyError(error);
      if (kind === "fatal" || attempt > retries) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      if (typeof onRetry === "function") {
        await onRetry({
          attempt,
          retries,
          delayMs,
          message: error.message || String(error)
        });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = {
  withRetry,
  classifyRetryError
};
