let appConfig = null;

const LESSON_SECTION_CONFIG = [
  { id: "3", targetHours: 29, lessonKey: "E1" },
  { id: "4", targetHours: 30, lessonKey: "E2" },
  { id: "5", targetHours: 30, lessonKey: "E3" },
  { id: "6", targetHours: 30, lessonKey: "E4" },
  { id: "7", targetHours: 30, lessonKey: "E5" }
];

const embeddedAutomation = {
  running: false,
  stopRequested: false,
  refreshIntervalId: null,
  webviewReady: false,
  webviewReadyPromise: null,
  webviewReadyResolver: null,
  webviewReadyRejector: null
};

const WEBVIEW_READY_TIMEOUT_MS = 60000;

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function fmtMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function getLessonDisplay(sectionId) {
  const lesson = LESSON_SECTION_CONFIG.find((entry) => entry.id === String(sectionId));
  return lesson ? `${lesson.lessonKey} • Section ${sectionId}` : `Section ${sectionId}`;
}

function getWebview() {
  return document.getElementById("embeddedBrowser");
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getAthensDayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function waitForWebviewReady(timeoutMs = WEBVIEW_READY_TIMEOUT_MS) {
  if (embeddedAutomation.webviewReady) {
    return true;
  }

  if (embeddedAutomation.webviewReadyPromise) {
    return Promise.race([
      embeddedAutomation.webviewReadyPromise,
      new Promise((_, reject) => {
        window.setTimeout(() => {
          reject(new Error("Embedded browser did not become ready in time."));
        }, timeoutMs);
      })
    ]);
  }

  embeddedAutomation.webviewReadyPromise = new Promise((resolve, reject) => {
    embeddedAutomation.webviewReadyResolver = resolve;
    embeddedAutomation.webviewReadyRejector = reject;
  });

  return embeddedAutomation.webviewReadyPromise;
}

function getSafeWebviewUrl() {
  const webview = getWebview();

  try {
    if (embeddedAutomation.webviewReady) {
      return webview.getURL() || webview.src || "-";
    }
  } catch {}

  return webview.getAttribute("src") || webview.src || "-";
}

function ensureProgressShape(progressState) {
  const next = {
    startedAt: progressState.startedAt || new Date().toISOString(),
    baseSectionIndex: Number(progressState.baseSectionIndex) || 0,
    lessonDurationMinutes: Number(progressState.lessonDurationMinutes) || 60,
    scormSessionMinutes:
      Number.isFinite(Number(progressState.scormSessionMinutes)) && Number(progressState.scormSessionMinutes) > 0
        ? Number(progressState.scormSessionMinutes)
        : null,
    dailyScormLimitMinutes:
      Number.isFinite(Number(progressState.dailyScormLimitMinutes)) && Number(progressState.dailyScormLimitMinutes) > 0
        ? Number(progressState.dailyScormLimitMinutes)
        : null,
    lastResolvedSectionId: progressState.lastResolvedSectionId || null,
    lastScormStartedAt: progressState.lastScormStartedAt || null,
    lastScormExitedAt: progressState.lastScormExitedAt || null,
    lessonProgress: progressState.lessonProgress || {},
    dailyProgress: progressState.dailyProgress || {
      date: getAthensDayKey(),
      completedMinutes: 0
    }
  };

  for (const lesson of LESSON_SECTION_CONFIG) {
    if (!next.lessonProgress[lesson.id]) {
      next.lessonProgress[lesson.id] = {
        targetHours: lesson.targetHours,
        completedMinutes: 0,
        updatedAt: null
      };
    }
  }

  if (next.dailyProgress.date !== getAthensDayKey()) {
    next.dailyProgress = {
      date: getAthensDayKey(),
      completedMinutes: 0
    };
  }

  return next;
}

async function appendLog(event, extra = {}) {
  await window.desktopApi.appendLog({
    event,
    ...extra
  });
}

async function updateRuntimeState(patch, lastAction = null) {
  const nextPatch = {
    ...patch,
    processRunning: embeddedAutomation.running
  };
  if (lastAction !== null) {
    nextPatch.lastAction = lastAction;
  }
  await window.desktopApi.updateState(nextPatch);
}

function renderState(state) {
  const status = state.status || "idle";
  const statusBadge = document.getElementById("statusBadge");
  statusBadge.className = `status ${status}`;
  statusBadge.textContent = status.toUpperCase();

  document.getElementById("currentLesson").textContent = state.currentLesson || "-";
  if (state.currentLesson) {
    document.getElementById("currentLesson").textContent = getLessonDisplay(state.currentLesson);
  }
  document.getElementById("currentLessonTitle").textContent = state.currentLessonTitle || "";
  document.getElementById("todayMinutes").textContent = state.todayMinutes ?? 0;
  document.getElementById("dailyLimit").textContent = `of ${state.dailyLimitMinutes ?? 0} planned`;
  document.getElementById("lastAction").textContent = state.lastAction || "-";
  document.getElementById("lastUpdatedAt").textContent = fmtDate(state.lastUpdatedAt);
  document.getElementById("botUrl").textContent = state.currentUrl || "-";
  document.getElementById("pausedText").textContent = String(Boolean(state.paused));
  document.getElementById("processRunningText").textContent = String(Boolean(state.processRunning));
  document.getElementById("nextExit").textContent = fmtDate(state.nextPlannedExitAt);

  document.getElementById("startBotBtn").disabled = Boolean(state.processRunning);
  document.getElementById("stopBotBtn").disabled = !state.processRunning;

  const countdownEl = document.getElementById("countdown");
  if (state.nextPlannedExitAt) {
    const diffMs = new Date(state.nextPlannedExitAt).getTime() - Date.now();
    countdownEl.textContent = diffMs > 0 ? `in ${fmtMinutes(Math.ceil(diffMs / 60000))}` : "due now";
  } else {
    countdownEl.textContent = "";
  }

  const lessonTotalsRoot = document.getElementById("lessonTotals");
  lessonTotalsRoot.innerHTML = "";
  const entries = Object.entries(state.lessonTotals || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [sectionId, lesson] of entries) {
    const targetMinutes = (lesson.targetHours || 0) * 60;
    const completedMinutes = lesson.completedMinutes || 0;
    const percent = targetMinutes > 0 ? Math.min(100, (completedMinutes / targetMinutes) * 100) : 0;

    const card = document.createElement("div");
    card.className = "lesson-card";
    card.innerHTML = `
      <div class="top">
        <strong>${getLessonDisplay(sectionId)}</strong>
        <span class="muted">${lesson.targetHours || 0}h target</span>
      </div>
      <div class="muted">${completedMinutes} / ${targetMinutes} min</div>
      <div class="bar"><span style="width:${percent}%"></span></div>
    `;
    lessonTotalsRoot.appendChild(card);
  }
}

function renderLogs(logs) {
  const root = document.getElementById("logs");
  root.innerHTML = "";
  for (const log of logs) {
    const el = document.createElement("div");
    el.className = "log";
    el.innerHTML = `
      <div><strong>${log.event || "event"}</strong> <span class="muted">${fmtDate(log.timestamp)}</span></div>
      <div class="muted mono">${log.url || log.message || log.reason || ""}</div>
    `;
    root.appendChild(el);
  }
}

async function refreshDashboard() {
  const [state, logs] = await Promise.all([window.desktopApi.getState(), window.desktopApi.getLogs()]);
  renderState(state);
  renderLogs(logs);
}

async function recordRendererError(eventName, errorLike) {
  const message =
    errorLike?.message ||
    errorLike?.reason?.message ||
    errorLike?.reason ||
    String(errorLike || "Unknown renderer error");

  await window.desktopApi.appendLog({
    event: eventName,
    message
  });
}

function syncEmbeddedUrl() {
  const addressBar = document.getElementById("addressBar");
  const embeddedUrl = document.getElementById("embeddedUrl");
  const currentUrl = getSafeWebviewUrl();
  if (addressBar) {
    addressBar.textContent = currentUrl;
  }
  if (embeddedUrl) {
    embeddedUrl.textContent = currentUrl;
  }
}

async function loadUrl(url) {
  const webview = getWebview();
  if (!embeddedAutomation.webviewReady) {
    webview.setAttribute("src", url);
    syncEmbeddedUrl();
    await waitForWebviewReady();
    return;
  }

  try {
    await webview.loadURL(url);
  } catch (error) {
    if (!/ERR_ABORTED|\(-3\)/i.test(String(error && error.message))) {
      throw error;
    }
  }
  syncEmbeddedUrl();
}

async function executeInWebview(script) {
  await waitForWebviewReady();
  const webview = getWebview();
  return webview.executeJavaScript(script, true);
}

function throwIfStopped() {
  if (embeddedAutomation.stopRequested) {
    throw new Error("Automation stopped by user.");
  }
}

function isScormUrl(url) {
  return /mod\/scorm\/(view|player)\.php/i.test(url || "");
}

async function waitForCondition(checkFn, options = {}) {
  const timeoutMs = options.timeoutMs ?? appConfig.timeoutMs;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    const result = await checkFn();
    if (result) {
      return result;
    }
    await delay(intervalMs);
  }

  throw new Error(options.errorMessage || "Timed out waiting for condition.");
}

async function waitForUrlMatch(pattern, timeoutMs = appConfig.timeoutMs) {
  return waitForCondition(
    async () => {
      const currentUrl = getSafeWebviewUrl() || "";
      return pattern.test(currentUrl) ? currentUrl : null;
    },
    {
      timeoutMs,
      intervalMs: 500,
      errorMessage: `Timed out waiting for URL ${pattern}`
    }
  );
}

async function waitForSelector(selector, timeoutMs = appConfig.timeoutMs) {
  return waitForCondition(
    async () =>
      executeInWebview(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return false;
          const style = window.getComputedStyle(element);
          return style && style.display !== "none" && style.visibility !== "hidden";
        })()
      `),
    {
      timeoutMs,
      intervalMs: 500,
      errorMessage: `Timed out waiting for selector ${selector}`
    }
  );
}

async function clickSelector(selector) {
  return executeInWebview(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    })()
  `);
}

async function exitCurrentScormSafely(targetSection = null, reason = "requested_stop") {
  const currentUrl = getSafeWebviewUrl() || "";
  if (!isScormUrl(currentUrl)) {
    return false;
  }

  await appendLog("scorm_safe_exit_requested", {
    sectionId: targetSection?.id || null,
    reason,
    url: currentUrl
  });

  const clicked = await clickSelector('a[title="Έξοδος από τη δραστηριότητα"]').catch(() => false);
  if (!clicked) {
    await appendLog("scorm_safe_exit_missing", {
      sectionId: targetSection?.id || null,
      reason,
      url: getSafeWebviewUrl() || null
    });
    return false;
  }

  const targetPattern = targetSection?.id
    ? new RegExp(`/course/view\\.php\\?id=7378(?:#section-${targetSection.id})?$`)
    : /\/course\/view\.php\?id=7378/i;

  await waitForUrlMatch(targetPattern);

  await appendLog("scorm_safe_exit_completed", {
    sectionId: targetSection?.id || null,
    reason,
    url: getSafeWebviewUrl() || null
  });
  await updateRuntimeState({
    currentUrl: getSafeWebviewUrl() || null,
    nextPlannedExitAt: null
  }, "SCORM exited safely");
  return true;
}

async function fillLoginForm() {
  const { username, password } = appConfig.credentials || {};
  if (!username || !password) {
    throw new Error("Missing GOLEARN credentials for desktop automation.");
  }

  await waitForSelector("#Input_Username");

  await executeInWebview(`
    (() => {
      const setInputValue = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) return;
        input.focus();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };

      setInputValue("#Input_Username", ${JSON.stringify(username)});
      setInputValue("#Input_Password", ${JSON.stringify(password)});

      const rememberMe = document.querySelector("#Input_RememberMe");
      if (rememberMe && !rememberMe.checked) {
        rememberMe.click();
      }

      const button = document.querySelector('button[type="submit"]');
      if (button) {
        button.click();
        return true;
      }

      return false;
    })()
  `);
}

async function findTargetSection(progressState) {
  const sections = await executeInWebview(`
    (() => Array.from(document.querySelectorAll("li.section.main")).map((element) => {
      const titleAnchor = element.querySelector(".sectionname a");
      const activityAnchor = element.querySelector(".activityinstance a.aalink");
      return {
        id: element.getAttribute("data-sectionid") || element.id?.replace("section-", "") || null,
        title: titleAnchor ? titleAnchor.textContent.trim() : "",
        activityHref: activityAnchor ? activityAnchor.href : null
      };
    }))()
  `);

  const lessonSections = LESSON_SECTION_CONFIG.map((configEntry) => {
    const found = sections.find((section) => section.id === configEntry.id);
    return found ? { ...found, ...configEntry } : null;
  }).filter(Boolean);

  if (lessonSections.length === 0) {
    throw new Error("No lesson sections were found in the embedded course page.");
  }

  return (
    lessonSections.find((section) => {
      const completedMinutes = progressState.lessonProgress?.[section.id]?.completedMinutes || 0;
      return completedMinutes < section.targetHours * 60;
    }) || lessonSections[0]
  );
}

async function syncProgressState(progressState, targetSection, sessionMinutes) {
  progressState.dailyProgress.completedMinutes += sessionMinutes;
  progressState.lastScormExitedAt = new Date().toISOString();
  progressState.lastResolvedSectionId = targetSection.id;
  progressState.lessonProgress[targetSection.id].completedMinutes += sessionMinutes;
  progressState.lessonProgress[targetSection.id].updatedAt = new Date().toISOString();
  await window.desktopApi.saveProgressState(progressState);

  await updateRuntimeState({
    lessonTotals: progressState.lessonProgress,
    todayMinutes: progressState.dailyProgress.completedMinutes,
    currentLesson: targetSection.id,
    currentLessonTitle: targetSection.title,
    nextPlannedExitAt: null
  }, "SCORM session completed");
}

async function clickPlayerControl(selector) {
  return executeInWebview(`
    (() => {
      const lookupTargets = () => {
        const results = [];
        const visit = (doc) => {
          const element = doc.querySelector(${JSON.stringify(selector)});
          if (element) {
            results.push(element);
          }
          for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
            try {
              if (frame.contentDocument) {
                visit(frame.contentDocument);
              }
            } catch {}
          }
        };
        visit(document);
        return results;
      };

      const target = lookupTargets()[0];
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    })()
  `);
}

async function muteAndPlayPresentation() {
  await waitForCondition(
    async () =>
      executeInWebview(`
        (() => {
          const hasInTree = (selector) => {
            const visit = (doc) => {
              if (doc.querySelector(selector)) return true;
              for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
                try {
                  if (frame.contentDocument && visit(frame.contentDocument)) {
                    return true;
                  }
                } catch {}
              }
              return false;
            };
            return visit(document);
          };

          return hasInTree("#play-pause") || hasInTree('button[aria-label*="Mute"], button[aria-label*="Unmute"]');
        })()
      `),
    {
      timeoutMs: appConfig.timeoutMs,
      intervalMs: 1000,
      errorMessage: "Player controls did not appear in time."
    }
  );

  await clickPlayerControl('button[aria-label*="Mute"], button[aria-label*="Unmute"]').catch(() => false);
  await delay(1500);
  await clickPlayerControl("#play-pause").catch(() => false);
}

async function advanceSlidesUntil(endAt) {
  let nextAdvanceAt = Date.now() + 15000;

  while (Date.now() < endAt) {
    if (embeddedAutomation.stopRequested) {
      return "stopped";
    }

    const now = Date.now();
    const remainingMs = endAt - now;
    const untilNextAdvance = Math.max(0, nextAdvanceAt - now);
    const chunkMs = Math.min(1000, remainingMs, untilNextAdvance || 1000);
    await delay(chunkMs);

    if (embeddedAutomation.stopRequested) {
      return "stopped";
    }

    if (Date.now() >= nextAdvanceAt && Date.now() < endAt) {
      await clickPlayerControl("#next").catch(() => false);
      nextAdvanceAt = Date.now() + 15000;
    }
  }

  return "completed";
}

async function openTrainingAndCourse() {
  await loadUrl(appConfig.trainingUrl);
  await waitForUrlMatch(/\/training\/trainee\/training/i);
  await appendLog("training_page_opened", { url: getSafeWebviewUrl() });
  await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Training page opened");

  await waitForCondition(
    async () =>
      executeInWebview(`
        (() => Boolean(
          document.querySelector('button .fa-envelope-open-text')
        ))()
      `),
    {
      timeoutMs: appConfig.timeoutMs,
      intervalMs: 500,
      errorMessage: "Open courses button did not appear."
    }
  );

  await executeInWebview(`
    (() => {
      const button = document.querySelector("button .fa-envelope-open-text")?.closest("button");
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return true;
    })()
  `);

  await waitForCondition(
    async () => {
      const currentUrl = getSafeWebviewUrl() || "";
      return /https:\/\/elearning\.golearn\.gr\//i.test(currentUrl) ? currentUrl : null;
    },
    {
      timeoutMs: appConfig.timeoutMs,
      intervalMs: 500,
      errorMessage: "Did not reach elearning after opening courses."
    }
  );

  const currentUrl = getSafeWebviewUrl() || "";
  if (!/course\/view\.php\?id=7378/i.test(currentUrl)) {
    await loadUrl(appConfig.courseUrl);
    await waitForUrlMatch(/course\/view\.php\?id=7378/i);
  }

  await appendLog("course_page_opened", { url: getSafeWebviewUrl() });
  await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Course page opened");
}

async function runEmbeddedAutomation() {
  await waitForWebviewReady();
  const progressState = ensureProgressShape(await window.desktopApi.getProgressState());
  await window.desktopApi.saveProgressState(progressState);
  const sessionMinutes = progressState.scormSessionMinutes || appConfig.maxScormSessionMinutes;
  const dailyLimitMinutes = progressState.dailyScormLimitMinutes || appConfig.dailyScormLimitMinutes;

  embeddedAutomation.running = true;
  embeddedAutomation.stopRequested = false;

  await updateRuntimeState({
    status: "running",
    paused: false,
    processRunning: true,
    lessonTotals: progressState.lessonProgress,
    todayMinutes: progressState.dailyProgress.completedMinutes,
    dailyLimitMinutes
  }, "Embedded automation started");
  await appendLog("embedded_automation_started");
  await refreshDashboard();

  try {
    await appendLog("embedded_step", { message: "Loading login page" });
    await loadUrl(appConfig.loginUrl);
    await appendLog("embedded_step", { message: "Filling login form", url: getSafeWebviewUrl() || null });
    await fillLoginForm();
    await waitForCondition(
      async () => {
        const currentUrl = getSafeWebviewUrl() || "";
        return !/\/login/i.test(currentUrl) ? currentUrl : null;
      },
      {
        timeoutMs: appConfig.timeoutMs,
        intervalMs: 500,
        errorMessage: "Login did not leave the login page in the embedded browser."
      }
    );

    await appendLog("embedded_authenticated", { url: getSafeWebviewUrl() });
    await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "Authenticated in embedded browser");

    while (!embeddedAutomation.stopRequested) {
      if (progressState.dailyProgress.completedMinutes >= dailyLimitMinutes) {
        await appendLog("daily_limit_reached", {
          completedMinutesToday: progressState.dailyProgress.completedMinutes,
          dailyLimitMinutes
        });
        await updateRuntimeState({
          status: "idle",
          paused: false,
          processRunning: false,
          nextPlannedExitAt: null,
          todayMinutes: progressState.dailyProgress.completedMinutes
        }, "Daily limit reached");
        return;
      }

      await openTrainingAndCourse();
      const targetSection = await findTargetSection(progressState);
      progressState.lastResolvedSectionId = targetSection.id;
      await window.desktopApi.saveProgressState(progressState);

      await appendLog("section_selected", {
        sectionId: targetSection.id,
        sectionTitle: targetSection.title,
        lessonUrl: targetSection.activityHref
      });
      await updateRuntimeState({
        currentLesson: targetSection.id,
        currentLessonTitle: targetSection.title,
        currentUrl: getSafeWebviewUrl()
      }, `Section ${targetSection.id} selected`);

      await executeInWebview(`
        (() => {
          const section = document.querySelector(${JSON.stringify(`#section-${targetSection.id}`)});
          const link = section ? section.querySelector(".activityinstance a.aalink") : null;
          if (!link) return false;
          link.scrollIntoView({ block: "center", inline: "center" });
          link.click();
          return true;
        })()
      `);

      await waitForCondition(
        async () => {
          const currentUrl = getSafeWebviewUrl() || "";
          return /mod\/scorm\/(view|player)\.php/i.test(currentUrl) ? currentUrl : null;
        },
        {
          timeoutMs: appConfig.timeoutMs,
          intervalMs: 500,
          errorMessage: "SCORM page did not open in embedded browser."
        }
      );

      await appendLog("scorm_opened", {
        sectionId: targetSection.id,
        url: getSafeWebviewUrl()
      });
      await updateRuntimeState({ currentUrl: getSafeWebviewUrl() }, "SCORM opened");

      const redirectVisible = await executeInWebview(`
        (() => Boolean(document.querySelector('input[type="submit"][value="Είσοδος/Σύνδεση"]')))()
      `);
      if (redirectVisible) {
        await clickSelector('input[type="submit"][value="Είσοδος/Σύνδεση"]');
        await waitForCondition(
          async () => {
            const currentUrl = getSafeWebviewUrl() || "";
            return /mod\/scorm\/player\.php/i.test(currentUrl) ? currentUrl : null;
          },
          {
            timeoutMs: appConfig.timeoutMs,
            intervalMs: 500,
            errorMessage: "SCORM player redirect did not complete."
          }
        );
      }

      await muteAndPlayPresentation();

      progressState.lastScormStartedAt = new Date().toISOString();
      await window.desktopApi.saveProgressState(progressState);
      const plannedExitAt = new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString();
      await appendLog("scorm_session_started", {
        sectionId: targetSection.id,
        startedAt: progressState.lastScormStartedAt,
        url: getSafeWebviewUrl()
      });
      await updateRuntimeState({
        currentUrl: getSafeWebviewUrl(),
        nextPlannedExitAt: plannedExitAt
      }, `Waiting ${sessionMinutes} minutes before exit`);

      const sessionOutcome = await advanceSlidesUntil(Date.now() + sessionMinutes * 60 * 1000);
      if (sessionOutcome === "stopped") {
        await exitCurrentScormSafely(targetSection, "user_stop_requested");
        progressState.lastScormExitedAt = new Date().toISOString();
        await window.desktopApi.saveProgressState(progressState);
        await appendLog("embedded_automation_stopped", {
          sectionId: targetSection.id,
          url: getSafeWebviewUrl() || null
        });
        await updateRuntimeState({
          status: "idle",
          paused: false,
          processRunning: false,
          nextPlannedExitAt: null,
          currentUrl: getSafeWebviewUrl() || null
        }, "Stopped safely by user");
        return;
      }

      await clickSelector('a[title="Έξοδος από τη δραστηριότητα"]');
      await waitForUrlMatch(new RegExp(`/course/view\\.php\\?id=7378(?:#section-${targetSection.id})?$`));

      await syncProgressState(progressState, targetSection, sessionMinutes);
      await appendLog("scorm_session_completed", {
        sectionId: targetSection.id,
        sessionMinutes,
        completedMinutesToday: progressState.dailyProgress.completedMinutes,
        completedMinutesForSection: progressState.lessonProgress[targetSection.id].completedMinutes,
        url: getSafeWebviewUrl()
      });
      await refreshDashboard();
    }
  } finally {
    embeddedAutomation.running = false;
    embeddedAutomation.stopRequested = false;
    await updateRuntimeState({
      status: "idle",
      paused: false,
      processRunning: false,
      nextPlannedExitAt: null,
      currentUrl: getSafeWebviewUrl() || null
    }, "Embedded automation stopped");
    await refreshDashboard();
  }
}

async function handleStartBot() {
  if (embeddedAutomation.running) {
    return;
  }

  try {
    await runEmbeddedAutomation();
  } catch (error) {
    embeddedAutomation.running = false;
    embeddedAutomation.stopRequested = false;
    if (error.message === "Automation stopped by user.") {
      await appendLog("embedded_automation_stopped", {
        url: getSafeWebviewUrl() || null
      });
      await updateRuntimeState({
        status: "idle",
        paused: false,
        processRunning: false,
        nextPlannedExitAt: null,
        currentUrl: getSafeWebviewUrl() || null
      }, "Stopped by user");
      await refreshDashboard();
      return;
    }

    await appendLog("embedded_automation_failed", {
      message: error.message,
      url: getSafeWebviewUrl() || null
    });
    await updateRuntimeState({
      status: "error",
      paused: false,
      processRunning: false,
      nextPlannedExitAt: null,
      currentUrl: getSafeWebviewUrl() || null
    }, `Error: ${error.message}`);
    await refreshDashboard();
    console.error(error);
  }
}

async function handleStopBot() {
  embeddedAutomation.stopRequested = true;
  await appendLog("embedded_automation_stop_requested", {
    url: getSafeWebviewUrl() || null
  });
  await exitCurrentScormSafely(null, "user_stop_requested").catch(() => false);
  await updateRuntimeState({
    status: "paused",
    paused: true,
    processRunning: true,
    nextPlannedExitAt: null
  }, "Stopping safely");
  await refreshDashboard();
}

function setupEmbeddedBrowser() {
  const webview = getWebview();
  let readySettled = false;

  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    embeddedAutomation.webviewReady = true;
    if (embeddedAutomation.webviewReadyResolver) {
      embeddedAutomation.webviewReadyResolver(true);
    }
    embeddedAutomation.webviewReadyResolver = null;
    embeddedAutomation.webviewReadyRejector = null;
  };

  const markFailed = (message) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    if (embeddedAutomation.webviewReadyRejector) {
      embeddedAutomation.webviewReadyRejector(new Error(message));
    }
    embeddedAutomation.webviewReadyResolver = null;
    embeddedAutomation.webviewReadyRejector = null;
  };

  webview.addEventListener("did-navigate", syncEmbeddedUrl);
  webview.addEventListener("did-navigate-in-page", syncEmbeddedUrl);
  webview.addEventListener("dom-ready", () => {
    syncEmbeddedUrl();
    appendLog("webview_dom_ready", { url: getSafeWebviewUrl() }).catch(() => {});
    markReady();
  });
  webview.addEventListener("did-finish-load", syncEmbeddedUrl);
  webview.addEventListener("did-start-loading", () => {
    appendLog("webview_did_start_loading", { url: getSafeWebviewUrl() }).catch(() => {});
  });
  webview.addEventListener("did-stop-loading", () => {
    appendLog("webview_did_stop_loading", { url: getSafeWebviewUrl() }).catch(() => {});
  });
  webview.addEventListener("did-fail-load", (event) => {
    if (event.errorCode === -3) {
      return;
    }

    const addressBar = document.getElementById("addressBar");
    const embeddedUrl = document.getElementById("embeddedUrl");
    if (addressBar) {
      addressBar.textContent = `Load failed: ${event.validatedURL || event.errorDescription}`;
    }
    if (embeddedUrl) {
      embeddedUrl.textContent = event.validatedURL || "-";
    }
    appendLog("webview_did_fail_load", {
      message: event.errorDescription,
      url: event.validatedURL || getSafeWebviewUrl()
    }).catch(() => {});
    markFailed(event.errorDescription || "Embedded browser failed to load.");
    console.error("Embedded browser load failed:", event.errorCode, event.errorDescription, event.validatedURL);
  });
  webview.addEventListener("console-message", (event) => {
    appendLog("webview_console_message", {
      message: `[${event.level}] ${event.message}`,
      url: getSafeWebviewUrl()
    }).catch(() => {});
  });
  webview.addEventListener("render-process-gone", (event) => {
    appendLog("webview_render_process_gone", {
      message: event.details?.reason || "unknown",
      url: getSafeWebviewUrl()
    }).catch(() => {});
    markFailed(`Embedded browser render process gone: ${event.details?.reason || "unknown"}`);
  });
  webview.addEventListener("destroyed", () => {
    appendLog("webview_destroyed", { url: getSafeWebviewUrl() }).catch(() => {});
    markFailed("Embedded browser was destroyed.");
  });

  embeddedAutomation.webviewReady = false;
  embeddedAutomation.webviewReadyPromise = new Promise((resolve, reject) => {
    embeddedAutomation.webviewReadyResolver = resolve;
    embeddedAutomation.webviewReadyRejector = reject;
  });

  window.setTimeout(() => {
    if (!embeddedAutomation.webviewReady) {
      markFailed("Embedded browser did not become ready in time.");
      appendLog("webview_ready_timeout", { url: getSafeWebviewUrl() }).catch(() => {});
    }
  }, WEBVIEW_READY_TIMEOUT_MS);

  webview.setAttribute("src", appConfig.loginUrl);
  syncEmbeddedUrl();
}

async function boot() {
  appConfig = await window.desktopApi.getAppConfig();
  document.getElementById("startBotBtn").addEventListener("click", handleStartBot);
  document.getElementById("stopBotBtn").addEventListener("click", handleStopBot);
  document.getElementById("refreshBtn").addEventListener("click", refreshDashboard);
  setupEmbeddedBrowser();
  await refreshDashboard();
  embeddedAutomation.refreshIntervalId = window.setInterval(refreshDashboard, 3000);
}

window.addEventListener("error", (event) => {
  recordRendererError("renderer_window_error", event.error || event.message).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  recordRendererError("renderer_unhandled_rejection", event.reason).catch(() => {});
});

boot();
