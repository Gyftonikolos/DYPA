const { chromium } = require("playwright");
const fs = require("fs");
const config = require("./config");
const { resolveSessionRange, pickSessionMinutes } = require("./sessionPolicy");
const { resolveLessonSelection } = require("./sharedOrchestrator");
const { withRetry } = require("./retryPolicy");
const { createRunSupervisor } = require("./runSupervisor");
const { STEP, StepError } = require("./stepContracts");
const { startDashboardServer } = require("./dashboardServer");
const {
  isNowWithinAnyWindow,
  computeNextWindowStart,
  minutesUntilWindowEnd
} = require("./scheduleWindows");
const {
  loadProgressState,
  saveProgressState,
  ensureProgressStarted,
  resolveSectionIndex,
  ensureDailyProgress,
  addCompletedMinutes,
  addCompletedMinutesSplitByCurrentAthensDay,
  appendSessionLog,
  ensureLessonProgress,
  addCompletedLessonMinutes,
  validateAndClampProgressState,
  applySessionMinutesIdempotent
} = require("./progressStore");
const {
  initRuntimeState,
  updateRuntimeState,
  transitionRuntimeState,
  setLessonTotals,
  setLastAction,
  updateRuntimeDiagnostics,
  touchHeartbeat
} = require("./runtimeState");

const ELEARNING_URL_PATTERNS = [
  /https:\/\/elearning\.golearn\.gr\/local\/mdl_autologin\/autologin\.php/i,
  /https:\/\/elearning\.golearn\.gr\/$/i,
  /https:\/\/elearning\.golearn\.gr\/my\/?$/i
];
const AUTH_ENTRY_URL = "https://edu.golearn.gr/login?returnUrl=%2f";
const COURSE_URL = "https://elearning.golearn.gr/course/view.php?id=7378";
const ELEARNING_AUTOLOGIN_URL = "https://elearning.golearn.gr/local/mdl_autologin/autologin.php";
const COURSE_URL_PATTERN = /https:\/\/elearning\.golearn\.gr\/course\/view\.php\?id=7378/i;
const PLAYER_PLAY_SELECTOR = "#play-pause";
const PLAYER_NEXT_SELECTOR = "#next";
const PLAYER_MUTE_SELECTOR = 'button[aria-label*="Mute"], button[aria-label*="Unmute"]';
const LESSON_SECTION_CONFIG = [
  { id: "3", targetHours: 29, lessonKey: "E1" },
  { id: "4", targetHours: 30, lessonKey: "E2" },
  { id: "5", targetHours: 30, lessonKey: "E3" },
  { id: "6", targetHours: 30, lessonKey: "E4" },
  { id: "7", targetHours: 30, lessonKey: "E5" }
];

const LOG_ERROR_TAXONOMY = {
  login_attempt_navigation_timeout: { errorCode: "AUTH_LOGIN_NAV_TIMEOUT", source: "auth.ensureAuthenticated" },
  auth_attempt_failed: { errorCode: "AUTH_ATTEMPT_FAILED", source: "auth.ensureAuthenticated" },
  portal_drift_detected: { errorCode: "PORTAL_UI_DRIFT", source: "course.resolveSections" },
  supervisor_terminal_failure: { errorCode: "SUPERVISOR_STEP_FAILED", source: "workflow.supervisor" },
  unhandled_promise_rejection: { errorCode: "PROCESS_UNHANDLED_REJECTION", source: "process.global" },
  uncaught_exception: { errorCode: "PROCESS_UNCAUGHT_EXCEPTION", source: "process.global" },
  workflow_failed: { errorCode: "WORKFLOW_MAIN_FAILED", source: "workflow.main" }
};

const LOG_WARNING_TAXONOMY = {
  async_stats_panel_missing: { warningCode: "PORTAL_STATS_PANEL_MISSING", source: "stats.syncLessonStatsFromPanel" },
  portal_drift_detected: { warningCode: "PORTAL_UI_DRIFT", source: "workflow.portal" },
  training_card_missing_fallback: { warningCode: "TRAINING_CARD_MISSING", source: "course.openCoursePage" },
  course_link_hidden_fallback: { warningCode: "COURSE_LINK_HIDDEN", source: "course.openCoursePage" },
  player_controls_timeout: { warningCode: "SCORM_CONTROLS_TIMEOUT", source: "scorm.waitForPlayerReady" },
  player_mute_button_missing: { warningCode: "SCORM_MUTE_BUTTON_MISSING", source: "scorm.mutePresentation" },
  player_play_button_missing: { warningCode: "SCORM_PLAY_BUTTON_MISSING", source: "scorm.startPlayback" },
  player_next_button_missing: { warningCode: "SCORM_NEXT_BUTTON_MISSING", source: "scorm.advancePresentation" },
  scorm_session_interrupted: { warningCode: "SCORM_SESSION_INTERRUPTED", source: "scorm.exitAttempt" }
};

function serializeError(error) {
  if (!error) {
    return {
      errorName: "UnknownError",
      errorMessage: "Unknown error"
    };
  }

  const name = String(error.name || "Error");
  const message = String(error.message || String(error));
  const stack = typeof error.stack === "string" ? error.stack : null;

  return {
    errorName: name,
    errorMessage: message,
    errorStack: stack
  };
}

function logFailure(event, context = {}, error = null) {
  const mapped = LOG_ERROR_TAXONOMY[event] || {};
  const payload = {
    event,
    errorCode: context.errorCode || mapped.errorCode || "UNKNOWN_ERROR",
    source: context.source || mapped.source || "unknown",
    ...context,
    ...serializeError(error)
  };
  appendSessionLog(config.sessionLogPath, payload);
  console.error(`[${event}]`, payload);
}

function logWarning(event, context = {}) {
  const mapped = LOG_WARNING_TAXONOMY[event] || {};
  const payload = {
    event,
    warningCode: context.warningCode || mapped.warningCode || "GENERIC_WARNING",
    source: context.source || mapped.source || "unknown",
    ...context
  };
  appendSessionLog(config.sessionLogPath, payload);
  console.warn(`[${event}]`, payload);
}

function repairLessonTargets(progressState) {
  if (!progressState || typeof progressState !== "object") {
    return { changed: false, changes: [] };
  }
  if (!progressState.lessonProgress || typeof progressState.lessonProgress !== "object") {
    return { changed: false, changes: [] };
  }

  const expectedById = new Map(LESSON_SECTION_CONFIG.map((item) => [String(item.id), Number(item.targetHours)]));
  const changes = [];

  for (const [sectionId, entry] of Object.entries(progressState.lessonProgress)) {
    const expected = expectedById.get(String(sectionId));
    if (!Number.isFinite(expected) || expected <= 0) continue;
    const currentTarget = Number(entry?.targetHours);
    if (!Number.isFinite(currentTarget) || currentTarget <= 0.25) {
      if (entry && typeof entry === "object") {
        entry.targetHours = expected;
        entry.updatedAt = new Date().toISOString();
      } else {
        progressState.lessonProgress[sectionId] = {
          targetHours: expected,
          completedMinutes: 0,
          updatedAt: new Date().toISOString()
        };
      }
      changes.push({ sectionId, from: Number.isFinite(currentTarget) ? currentTarget : null, to: expected });
    }
  }

  return { changed: changes.length > 0, changes };
}

function isPageAlive(page) {
  try {
    return Boolean(
      page &&
        !page.isClosed() &&
        page.context() &&
        page.context().browser() &&
        page.context().browser().isConnected()
    );
  } catch {
    return false;
  }
}

function getSafePageUrl(page) {
  try {
    return isPageAlive(page) ? page.url() : null;
  } catch {
    return null;
  }
}

function isClosedTargetError(error) {
  return /Target page, context or browser has been closed/i.test(error?.message || "");
}

async function waitOnLivePage(page, timeoutMs) {
  if (!isPageAlive(page)) {
    return false;
  }

  try {
    await page.waitForTimeout(timeoutMs);
    return true;
  } catch (error) {
    if (isClosedTargetError(error)) {
      return false;
    }

    throw error;
  }
}

async function login(page) {
  if (!config.credentials.username || !config.credentials.password) {
    throw new Error("GOLEARN_USERNAME and GOLEARN_PASSWORD must be set in .env.");
  }

  if (!page.url().includes("/login")) {
    await page.goto(AUTH_ENTRY_URL, { waitUntil: "domcontentloaded" });
  }

  const usernameInput = page.locator("#Input_Username");
  const passwordInput = page.locator("#Input_Password");
  await usernameInput.waitFor({ state: "visible", timeout: config.timeoutMs });
  await passwordInput.waitFor({ state: "visible", timeout: config.timeoutMs });

  appendSessionLog(config.sessionLogPath, {
    event: "login_form_detected",
    url: page.url()
  });
  setLastAction("Login form detected", { currentUrl: page.url() });

  await usernameInput.fill("");
  await usernameInput.fill(config.credentials.username);
  await passwordInput.fill("");
  await passwordInput.fill(config.credentials.password);

  const rememberMe = page.locator("#Input_RememberMe");
  if ((await rememberMe.count()) > 0) {
    await rememberMe.check().catch(() => {});
  }

  await page.locator('button[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");

  const currentUrl = page.url();
  const reachedPostLoginArea =
    currentUrl === "https://edu.golearn.gr/" ||
    /https:\/\/edu\.golearn\.gr\/(?:$|\?)/i.test(currentUrl) ||
    /\/p\/m\/el-GR/i.test(currentUrl) ||
    /\/training\/trainee/i.test(currentUrl);

  if (!reachedPostLoginArea && currentUrl.includes("/login")) {
    throw new Error(`Login stayed on the login page: ${currentUrl}`);
  }
}

async function waitForPortalLinks(page, timeoutMs) {
  await page
    .locator('a[href="/training/trainee/training"], a[href="/training/trainee/cv"]')
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function ensureAuthenticated(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await withRetry(
      () => page.goto(AUTH_ENTRY_URL, { waitUntil: "domcontentloaded" }),
      {
        retries: 2,
        onRetry: ({ attempt: retryAttempt, delayMs, message }) =>
          appendSessionLog(config.sessionLogPath, {
            event: "retry_attempt",
            phase: "auth_entry_navigation",
            retryAttempt,
            delayMs,
            message
          })
      }
    );

    const loginFormVisible = await page.locator("#Input_Username").isVisible().catch(() => false);
    if (page.url().includes("/login") || loginFormVisible) {
      appendSessionLog(config.sessionLogPath, {
        event: "login_attempt_started",
        attempt,
        url: page.url()
      });
      updateRuntimeState({
        status: "running",
        paused: false,
        currentUrl: page.url()
      });
      setLastAction(`Login attempt ${attempt} started`);

      try {
        await login(page);
      } catch (error) {
        logFailure(
          "login_attempt_navigation_timeout",
          {
            attempt,
            url: getSafePageUrl(page)
          },
          error
        );
      }

      await withRetry(() => page.goto(config.baseUrl, { waitUntil: "domcontentloaded" }), {
        retries: 2,
        onRetry: ({ attempt: retryAttempt, delayMs, message }) =>
          appendSessionLog(config.sessionLogPath, {
            event: "retry_attempt",
            phase: "base_navigation",
            retryAttempt,
            delayMs,
            message
          })
      });
    }

    const onAuthWall = page.url().includes("/challenge") || page.url().includes("/login");
    if (onAuthWall) {
      console.log("Manual verification/login is required in the open browser window.");
      console.log("Complete the challenge and sign in, then the session will be saved automatically.");
      appendSessionLog(config.sessionLogPath, {
        event: "manual_auth_required",
        attempt,
        url: page.url()
      });
      setLastAction("Manual verification required", { currentUrl: page.url() });

      try {
        await waitForPortalLinks(page, 5 * 60_000);
      } catch {
        await page.waitForURL(/\/training\/trainee|\/p\/m\/el-GR/i, {
          timeout: 5 * 60_000
        });
      }
    }

    try {
      await page.waitForLoadState("domcontentloaded");
      const stillOnLogin = page.url().includes("/login");
      const loginStillVisible = await page.locator("#Input_Username").isVisible().catch(() => false);

      if (stillOnLogin || loginStillVisible) {
        throw new Error(`Still on login screen after submit: ${page.url()}`);
      }

      await page.context().storageState({ path: config.storageStatePath });
      appendSessionLog(config.sessionLogPath, {
        event: "authenticated",
        url: page.url(),
        attempt
      });
      updateRuntimeState({
        status: "running",
        paused: false,
        currentUrl: page.url()
      });
      setLastAction("Authenticated successfully");
      console.log(`Authenticated session saved to ${config.storageStatePath}.`);
      return;
    } catch (error) {
      logFailure(
        "auth_attempt_failed",
        {
          attempt,
          url: getSafePageUrl(page)
        },
        error
      );
    }
  }

  throw new Error("Authentication did not reach the trainee portal after retries.");
}

async function ensureAsyncStatsPanelExpanded(page) {
  const panel = page.locator("#asyncStatsPanel");
  if ((await panel.count().catch(() => 0)) === 0) {
    return { exists: false, expanded: false };
  }

  const panelVisible = await panel.isVisible().catch(() => false);
  if (panelVisible) {
    return { exists: true, expanded: true };
  }

  const toggle = page
    .locator(
      'button.accordion-button[data-bs-target="#asyncStatsPanel"], button.accordion-button[aria-controls="asyncStatsPanel"]'
    )
    .first();

  if ((await toggle.count().catch(() => 0)) === 0) {
    return { exists: true, expanded: false };
  }

  await toggle.click({ force: true }).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  const visibleAfter = await panel.isVisible().catch(() => false);
  return { exists: true, expanded: visibleAfter };
}

async function syncLessonStatsFromPanel(page, progressState) {
  function parseGreekNumber(value) {
    const raw = String(value || "")
      .replace(/\s+/g, "")
      .replace(",", ".");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const expansionState = await ensureAsyncStatsPanelExpanded(page);
  if (!expansionState.exists) {
    appendSessionLog(config.sessionLogPath, {
      event: "async_stats_panel_missing",
      url: page.url()
    });
    appendSessionLog(config.sessionLogPath, {
      event: "portal_drift_detected",
      phase: "stats_panel",
      missingSelectors: ["#asyncStatsPanel"],
      url: page.url()
    });
    setLastAction("Async stats panel missing", { currentUrl: page.url() });
    console.log("Async stats panel not found on the page. Continuing with local totals.");
    return;
  }

  const cardsLocator = page.locator("#asyncStatsPanel .rz-card");
  if ((await cardsLocator.count().catch(() => 0)) === 0 && !expansionState.expanded) {
    await ensureAsyncStatsPanelExpanded(page);
  }

  const cards = await page.locator("#asyncStatsPanel .rz-card").evaluateAll((elements) =>
    elements.map((element) => {
      const title = element.querySelector(".fw-bold")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const progressText =
        element.querySelector(".progress-info .fw-bold")?.textContent?.replace(/\s+/g, " ").trim() || "";

      return { title, progressText };
    })
  );

  const lessonMap = new Map(LESSON_SECTION_CONFIG.map((item) => [item.lessonKey, item]));
  let syncedCount = 0;

  for (const card of cards) {
    const lessonMatch = card.title.match(/Ε([1-5])\./u);
    const isQuestionsCard = /ερωτησ(?:εισ|εις)|questions?|quiz/iu.test(card.title);
    if (isQuestionsCard) {
      continue;
    }
    const hoursMatch = card.progressText.match(/([\d.,]+)\s*από\s*([\d.,]+)/u);

    if (!lessonMatch || !hoursMatch) {
      continue;
    }

    const lessonKey = `E${lessonMatch[1]}`;
    const lessonConfig = lessonMap.get(lessonKey);
    if (!lessonConfig) {
      continue;
    }

    const completedHours = parseGreekNumber(hoursMatch[1]);
    const targetHours = parseGreekNumber(hoursMatch[2]);
    if (!Number.isFinite(completedHours) || !Number.isFinite(targetHours)) {
      continue;
    }
    // Guardrail: only treat substantial targets as lessons.
    // Portal also renders non-lesson rows with 0 / 0.25 hours (info/tests); ignore them here.
    if (targetHours <= 1) {
      continue;
    }
    const liveCompletedMinutes = completedHours * 60;

    const currentLessonProgress = ensureLessonProgress(
      progressState,
      lessonConfig.id,
      targetHours || lessonConfig.targetHours
    );

    currentLessonProgress.targetHours = targetHours || lessonConfig.targetHours;
    const targetMinutes = (targetHours || lessonConfig.targetHours) * 60;
    const normalizedCompletedMinutes = Math.max(0, Math.min(targetMinutes, liveCompletedMinutes));
    const existingCompletedMinutes = Number(currentLessonProgress.completedMinutes || 0);
    currentLessonProgress.completedMinutes =
      existingCompletedMinutes > targetMinutes
        ? normalizedCompletedMinutes
        : Math.max(existingCompletedMinutes, normalizedCompletedMinutes);
    currentLessonProgress.updatedAt = new Date().toISOString();
    syncedCount += 1;

    appendSessionLog(config.sessionLogPath, {
      event: "lesson_stats_synced",
      sectionId: lessonConfig.id,
      lessonKey,
      targetHours: currentLessonProgress.targetHours,
      completedMinutesForSection: currentLessonProgress.completedMinutes
    });
  }

  saveProgressState(progressState);
  const invariantWarnings = validateAndClampProgressState(progressState, {
    dailyLimitMinutes: progressState.dailyScormLimitMinutes || config.dailyScormLimitMinutes
  });
  for (const warning of invariantWarnings) {
    appendSessionLog(config.sessionLogPath, {
      event: "progress_invariant_warning",
      ...warning
    });
  }
  setLessonTotals(progressState.lessonProgress);
  setLastAction(`Synced ${syncedCount} lesson totals from portal`, { currentUrl: page.url() });
  console.log(`Synced ${syncedCount} lesson totals from asyncStatsPanel.`);
}

async function openCoursePage(page) {
  const alreadyOnTrainingPage = /\/training\/trainee\/training/i.test(page.url());

  if (!alreadyOnTrainingPage) {
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
  }

  if (!/\/training\/trainee\/training/i.test(page.url())) {
    const trainingCard = page.locator('a[href="/training/trainee/training"]').first();
    const trainingCardVisible = await trainingCard.isVisible().catch(() => false);

    if (trainingCardVisible) {
      await Promise.all([
        page.waitForURL(/\/training\/trainee\/training/i, { timeout: config.timeoutMs }),
        trainingCard.click()
      ]);
    } else {
      logWarning("training_card_missing_fallback", { url: page.url() });
      await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  await page.waitForLoadState("domcontentloaded");
  updateRuntimeState({ currentUrl: page.url() });
  setLastAction("Training page opened", { currentUrl: page.url() });
  console.log("Training page opened successfully.");

  const openCoursesSelectors = [
    "button .fa-envelope-open-text",
    "button span.fa-envelope-open-text",
    "button i.fa-envelope-open-text",
    'button[title*="Open"]',
    'button[aria-label*="Open"]',
    'button[title*="μάθη"]',
    'button[aria-label*="μάθη"]',
    'button[class*="course"]',
    'button[class*="lesson"]',
    '[role="button"][title*="Open"]',
    '[role="button"][aria-label*="Open"]',
    '[role="button"][title*="μάθη"]',
    '[role="button"][aria-label*="μάθη"]'
  ];
  const openCoursesTextHints = [
    "open courses",
    "open course",
    "open lessons",
    "courses",
    "lessons",
    "mathim",
    "άνοιγμα μαθημάτων",
    "ανοιγμα μαθηματων",
    "μαθήματα",
    "μαθηματα"
  ];

  const openCoursesTarget = await page.evaluate(
    ({ selectors, textHints }) => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .trim();
      const candidates = [];
      const seen = new Set();
      const pushCandidate = (button, strategy, score) => {
        if (!button || seen.has(button)) {
          return;
        }
        const style = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        const disabled =
          button.disabled ||
          button.getAttribute("aria-disabled") === "true" ||
          style.pointerEvents === "none";
        if (!visible || disabled) {
          return;
        }
        seen.add(button);
        candidates.push({ button, strategy, score });
      };

      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) {
          continue;
        }
        const button = node.closest("button, [role='button']");
        if (button) {
          pushCandidate(button, selector, 70);
        }
      }

      const buttonNodes = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const button of buttonNodes) {
        const text = normalize(button.textContent);
        const aria = normalize(button.getAttribute("aria-label"));
        const title = normalize(button.getAttribute("title"));
        const className = normalize(button.className || "");

        for (const hint of textHints) {
          const normalizedHint = normalize(hint);
          if (text === normalizedHint || aria === normalizedHint || title === normalizedHint) {
            pushCandidate(button, "exact-text", 120);
            break;
          }
          if (
            text.includes(normalizedHint) ||
            aria.includes(normalizedHint) ||
            title.includes(normalizedHint)
          ) {
            pushCandidate(button, "text-hint", 100);
            break;
          }
        }

        if (className.includes("course") || className.includes("lesson") || className.includes("mathim")) {
          pushCandidate(button, "class-hint", 80);
        }
        if (button.querySelector(".fa-envelope-open-text")) {
          pushCandidate(button, "icon-hint", 90);
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0] || null;
      if (!best) {
        return { found: false, buttonIndex: -1, strategy: null, score: null, candidateCount: 0 };
      }

      const buttonIndex = buttonNodes.indexOf(best.button);
      return {
        found: buttonIndex >= 0,
        buttonIndex,
        strategy: best.strategy || null,
        score: best.score || null,
        candidateCount: candidates.length
      };
    },
    { selectors: openCoursesSelectors, textHints: openCoursesTextHints }
  );

  if (!openCoursesTarget?.found) {
    logWarning("portal_drift_detected", {
      phase: "open_courses_button",
      missingSelectors: openCoursesSelectors,
      url: page.url()
    });
    throw new Error("Open courses button did not appear.");
  }

  let openCoursesButton = page.locator("button, [role='button']").nth(openCoursesTarget.buttonIndex);
  await openCoursesButton.scrollIntoViewIfNeeded().catch(() => {});

  const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  appendSessionLog(config.sessionLogPath, {
    event: "open_courses_button_click_attempt",
    strategy: openCoursesTarget.strategy || null,
    score: openCoursesTarget.score ?? null,
    candidateCount: openCoursesTarget.candidateCount ?? 0,
    url: page.url()
  });
  setLastAction("Opening courses", { currentUrl: page.url() });
  await openCoursesButton.click({ force: true });
  const popup = await popupPromise;
  const targetPage = popup || page;
  const clickNavigationMode = popup ? "popup" : "same_tab";
  appendSessionLog(config.sessionLogPath, {
    event: "open_courses_click_result",
    navigationMode: clickNavigationMode,
    url: targetPage.url()
  });

  await targetPage.waitForURL(
    (url) => ELEARNING_URL_PATTERNS.some((pattern) => pattern.test(url.toString())),
    { timeout: config.timeoutMs }
  );

  await targetPage.waitForLoadState("domcontentloaded");
  appendSessionLog(config.sessionLogPath, {
    event: "courses_page_opened",
    url: targetPage.url()
  });
  updateRuntimeState({ currentUrl: targetPage.url() });
  setLastAction("Courses page opened", { currentUrl: targetPage.url() });
  console.log(`Courses page opened: ${targetPage.url()}`);

  const goToCourseLink = targetPage.locator(`a[href="${COURSE_URL}"]`).first();
  const linkExists = (await goToCourseLink.count()) > 0;
  const linkVisible = linkExists
    ? await goToCourseLink.isVisible().catch(() => false)
    : false;

  if (linkVisible) {
    await Promise.all([
      targetPage.waitForURL((url) => COURSE_URL_PATTERN.test(url.toString()), {
        timeout: config.timeoutMs
      }),
      goToCourseLink.click()
    ]);
  } else {
    logWarning("course_link_hidden_fallback", {
      reason: "course_link_not_visible",
      url: targetPage.url()
    });
    await targetPage.goto(ELEARNING_AUTOLOGIN_URL, { waitUntil: "domcontentloaded" });
    await targetPage.waitForURL(
      (url) =>
        ELEARNING_URL_PATTERNS.some((pattern) => pattern.test(url.toString())) ||
        COURSE_URL_PATTERN.test(url.toString()),
      { timeout: Math.min(config.timeoutMs, 15_000) }
    );
    if (!COURSE_URL_PATTERN.test(targetPage.url())) {
      await targetPage.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
    }
  }

  await targetPage.waitForLoadState("domcontentloaded");
  appendSessionLog(config.sessionLogPath, {
    event: "course_opened",
    url: targetPage.url()
  });
  updateRuntimeState({ currentUrl: targetPage.url() });
  setLastAction("Course opened", { currentUrl: targetPage.url() });
  console.log(`Course page opened: ${targetPage.url()}`);

  return targetPage;
}

async function resolveCourseSections(page) {
  try {
    const primarySelector = "li.section.main";
    const fallbackSelector = ".course-content li.section";
    await page.locator(`${primarySelector}, ${fallbackSelector}`).first().waitFor({
      state: "visible",
      timeout: config.timeoutMs
    });
  } catch (error) {
    logFailure(
      "portal_drift_detected",
      {
        phase: "lesson_section_list",
        missingSelectors: ["li.section.main"],
        url: getSafePageUrl(page)
      },
      error
    );
    throw error;
  }

  return page.locator("li.section.main, .course-content li.section").evaluateAll((elements) =>
    elements.map((element, index) => {
      const titleAnchor = element.querySelector(".sectionname a");
      const activityAnchors = Array.from(element.querySelectorAll(".activityinstance a.aalink"));
      const activities = activityAnchors
        .map((anchor) => {
          const href = anchor?.href || null;
          const label = anchor?.textContent?.replace(/\s+/g, " ").trim() || "";
          return { href, label };
        })
        .filter((activity) => Boolean(activity.href));

      return {
        index,
        id: element.getAttribute("data-sectionid") || element.id?.replace("section-", "") || null,
        title: titleAnchor?.textContent?.trim() || `Section ${index + 1}`,
        activities
      };
    })
  );
}

function extractModuleIdFromHref(href) {
  const match = String(href || "").match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

function pickLessonAndTestScormActivities(section) {
  const activities = Array.isArray(section?.activities) ? section.activities : [];
  const lessonNumber = Number(String(section?.lessonKey || "").replace(/^E/u, ""));
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isScorm = (activity) => /\/mod\/scorm\/view\.php\?/i.test(String(activity?.href || ""));

  const scormActivities = activities.filter(isScorm);
  const lessonActivity =
    scormActivities.find((activity) => new RegExp(`^${lessonNumber}\\s*\\.`, "u").test(normalize(activity.label))) ||
    scormActivities.find((activity) => new RegExp(`\\bΕ${lessonNumber}\\s*\\.`, "u").test(normalize(activity.label))) ||
    scormActivities[0] ||
    null;

  const testActivity =
    scormActivities.find((activity) => /^ερωτησ(?:εισ|εις)\b/iu.test(normalize(activity.label))) ||
    scormActivities.find((activity) => /\bquestions?\b|\bquiz\b/iu.test(normalize(activity.label))) ||
    null;

  const decorate = (activity) =>
    activity
      ? {
          ...activity,
          type: "scorm",
          moduleId: extractModuleIdFromHref(activity.href)
        }
      : null;

  return { lessonActivity: decorate(lessonActivity), testActivity: decorate(testActivity) };
}

async function resolveTargetSection(page, progressState) {
  const sections = await resolveCourseSections(page);
  const lessonSections = LESSON_SECTION_CONFIG.map((lessonConfig) => {
    const matchingSection = sections.find((section) => section.id === lessonConfig.id);
    return matchingSection ? { ...matchingSection, ...lessonConfig } : null;
  }).filter(Boolean);

  if (lessonSections.length === 0) {
    throw new Error("None of the expected lesson sections (3-7) were found on the course page.");
  }

  if (config.forceScormModuleId) {
    const forcedId = String(config.forceScormModuleId).trim();
    const forcedPattern = new RegExp(`[?&]id=${forcedId}(?:$|&)`);
    for (const section of lessonSections) {
      const match = (section.activities || []).find((activity) =>
        forcedPattern.test(String(activity?.href || ""))
      );
      if (match?.href) {
        section.activityHref = match.href;
        section.activityType = "scorm";
        section.activityLabel = match.label || "";
        appendSessionLog(config.sessionLogPath, {
          event: "force_scorm_activity_selected",
          forcedModuleId: forcedId,
          sectionId: section.id,
          lessonKey: section.lessonKey,
          activityHref: section.activityHref,
          activityLabel: section.activityLabel,
          url: page.url()
        });
        return section;
      }
    }
    appendSessionLog(config.sessionLogPath, {
      event: "force_scorm_activity_not_found",
      forcedModuleId: forcedId,
      url: page.url()
    });
  }

  const selection = resolveLessonSelection(lessonSections, progressState);
  let targetSection = lessonSections.find((section) => section.id === selection.selectedSectionId) || null;
  if (!targetSection) {
    const fallbackIndex = resolveSectionIndex(progressState, lessonSections.length);
    targetSection = lessonSections[fallbackIndex];
  }

  const { lessonActivity, testActivity } = pickLessonAndTestScormActivities(targetSection);
  if (lessonActivity?.href) {
    targetSection.activityHref = lessonActivity.href;
    targetSection.activityType = lessonActivity.type;
    targetSection.activityLabel = lessonActivity.label || "";
    targetSection.lessonModuleId = lessonActivity.moduleId || null;
  }
  if (testActivity?.href) {
    targetSection.testActivityHref = testActivity.href;
    targetSection.testModuleId = testActivity.moduleId || null;
  }

  if (!targetSection || !targetSection.id || !targetSection.activityHref) {
    const first = Array.isArray(targetSection?.activities) ? targetSection.activities[0] : null;
    if (!first || !first.href) {
      appendSessionLog(config.sessionLogPath, {
        event: "lesson_activity_missing",
        sectionId: targetSection?.id || null,
        sectionTitle: targetSection?.title || null,
        url: page.url()
      });
      throw new Error("Could not resolve a valid target lesson section (missing activities).");
    }
    targetSection.activityHref = first.href;
    targetSection.activityType = /\/mod\/scorm\/|scorm/i.test(String(first.href)) ? "scorm" : "unknown";
    targetSection.activityLabel = first.label || "";
    if (targetSection.activityType !== "scorm") {
      appendSessionLog(config.sessionLogPath, {
        event: "lesson_scorm_activity_not_found",
        sectionId: targetSection.id,
        sectionTitle: targetSection.title,
        pickedActivityType: targetSection.activityType,
        pickedActivityHref: first.href,
        pickedActivityLabel: first.label || "",
        url: page.url()
      });
      console.log(
        `Warning: no SCORM activity detected for section ${targetSection.id}; using first activity instead.`
      );
    }
  }

  if (!targetSection.activityHref) {
    const { lessonActivity: fallbackLesson } = pickLessonAndTestScormActivities(targetSection);
    if (fallbackLesson?.href) {
      targetSection.activityHref = fallbackLesson.href;
      targetSection.activityType = fallbackLesson.type;
      targetSection.activityLabel = fallbackLesson.label || "";
      targetSection.lessonModuleId = fallbackLesson.moduleId || null;
    }
  } else if (!targetSection.activityType) {
    const inferredType = /\/mod\/scorm\/|scorm/i.test(String(targetSection.activityHref))
      ? "scorm"
      : /\/mod\/quiz\/|quiz/i.test(String(targetSection.activityHref))
        ? "quiz"
        : "unknown";
    targetSection.activityType = inferredType;
    targetSection.activityLabel = targetSection.activityLabel || "";
  }

  appendSessionLog(config.sessionLogPath, {
    event: "lesson_selection_reason",
    selectedSectionId: targetSection.id,
    selectedLessonKey: targetSection.lessonKey,
    reason: selection.reason,
    candidateSnapshot: selection.candidateSnapshot,
    activityType: targetSection.activityType || null,
    activityHref: targetSection.activityHref || null,
    activityLabel: targetSection.activityLabel || null,
    lessonModuleId: targetSection.lessonModuleId || null,
    testModuleId: targetSection.testModuleId || null
  });
  setLastAction(`Lesson ${targetSection.lessonKey} selected (${selection.reason})`, {
    currentLesson: targetSection.id
  });

  return targetSection;
}

async function passScormRedirect(page) {
  const loginRedirectButton = page.locator('input[type="submit"][value="Είσοδος/Σύνδεση"]').first();
  const redirectButtonVisible = await loginRedirectButton.isVisible().catch(() => false);

  if (!redirectButtonVisible) {
    return;
  }

  await loginRedirectButton.click();
  await page.waitForLoadState("domcontentloaded");
  appendSessionLog(config.sessionLogPath, {
    event: "scorm_redirect_passed",
    url: page.url()
  });
  updateRuntimeState({ currentUrl: page.url() });
  setLastAction("SCORM redirect passed", { currentUrl: page.url() });
  console.log(`Passed SCORM redirect page: ${page.url()}`);
}

async function getFrameWithSelector(page, selector) {
  for (const frame of page.frames()) {
    const locator = frame.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      return { frame, locator };
    }
  }

  const pageLocator = page.locator(selector).first();
  const pageVisible = await pageLocator.isVisible().catch(() => false);
  if (pageVisible) {
    return { frame: page.mainFrame(), locator: pageLocator };
  }

  return null;
}

async function waitForPlayerReady(page, targetSection) {
  const timeoutAt = Date.now() + config.timeoutMs;

  while (Date.now() < timeoutAt) {
    if (!isPageAlive(page)) {
      appendSessionLog(config.sessionLogPath, {
        event: "player_controls_aborted_page_closed",
        sectionId: targetSection.id,
        url: getSafePageUrl(page)
      });
      return;
    }

    const playTarget = await getFrameWithSelector(page, PLAYER_PLAY_SELECTOR);
    const muteTarget = await getFrameWithSelector(page, PLAYER_MUTE_SELECTOR);

    if (playTarget || muteTarget) {
      appendSessionLog(config.sessionLogPath, {
        event: "player_controls_ready",
        sectionId: targetSection.id,
        url: page.url()
      });
      setLastAction("Player controls ready", { currentUrl: page.url() });
      return;
    }

    const pageStillAlive = await waitOnLivePage(page, 1_000);
    if (!pageStillAlive) {
      appendSessionLog(config.sessionLogPath, {
        event: "player_controls_wait_interrupted",
        sectionId: targetSection.id,
        url: getSafePageUrl(page)
      });
      return;
    }
  }

  logWarning("player_controls_timeout", {
    sectionId: targetSection.id,
    url: page.url()
  });
  logWarning("portal_drift_detected", {
    phase: "scorm_controls",
    missingSelectors: [PLAYER_PLAY_SELECTOR, PLAYER_NEXT_SELECTOR, PLAYER_MUTE_SELECTOR],
    sectionId: targetSection.id,
    url: page.url()
  });
}

async function mutePresentation(page, targetSection) {
  if (!isPageAlive(page)) {
    return;
  }

  const muteTarget = await getFrameWithSelector(page, PLAYER_MUTE_SELECTOR);
  if (!muteTarget) {
    logWarning("player_mute_button_missing", {
      sectionId: targetSection.id,
      url: page.url()
    });
    return;
  }

  const ariaLabel = (await muteTarget.locator.getAttribute("aria-label").catch(() => "")) || "";
  if (/unmute/i.test(ariaLabel)) {
    appendSessionLog(config.sessionLogPath, {
      event: "player_already_muted",
      sectionId: targetSection.id,
      url: page.url()
    });
    return;
  }

  await muteTarget.locator.scrollIntoViewIfNeeded().catch(() => {});
  await muteTarget.locator.click({ force: true });
  appendSessionLog(config.sessionLogPath, {
    event: "player_muted",
    sectionId: targetSection.id,
    url: page.url()
  });
  setLastAction("Presentation muted", { currentUrl: page.url() });
  console.log("Presentation muted.");
}

async function startPresentationPlayback(page, targetSection) {
  if (!isPageAlive(page)) {
    return;
  }

  const playTarget = await getFrameWithSelector(page, PLAYER_PLAY_SELECTOR);
  if (!playTarget) {
    logWarning("player_play_button_missing", {
      sectionId: targetSection.id,
      url: page.url()
    });
    return;
  }

  await playTarget.locator.scrollIntoViewIfNeeded().catch(() => {});
  await playTarget.locator.click({ force: true });
  appendSessionLog(config.sessionLogPath, {
    event: "player_play_clicked",
    sectionId: targetSection.id,
    url: page.url()
  });
  setLastAction("Presentation started", { currentUrl: page.url() });
  console.log("Presentation playback started.");
}

async function advancePresentation(page, targetSection) {
  if (!isPageAlive(page)) {
    return false;
  }

  const nextTarget = await getFrameWithSelector(page, PLAYER_NEXT_SELECTOR);
  if (!nextTarget) {
    logWarning("player_next_button_missing", {
      sectionId: targetSection.id,
      url: page.url()
    });
    return false;
  }

  await nextTarget.locator.scrollIntoViewIfNeeded().catch(() => {});
  await nextTarget.locator.click({ force: true });
  appendSessionLog(config.sessionLogPath, {
    event: "player_next_clicked",
    sectionId: targetSection.id,
    url: page.url()
  });
  setLastAction("Moved to next slide", { currentUrl: page.url() });
  return true;
}

async function startScormAttempt(page, targetSection, progressState) {
  const targetSectionLocator = page.locator(`#section-${targetSection.id}`);
  await targetSectionLocator.scrollIntoViewIfNeeded();
  await targetSectionLocator.waitFor({ state: "visible", timeout: config.timeoutMs });

  const lessonProgress = ensureLessonProgress(
    progressState,
    targetSection.id,
    targetSection.targetHours
  );
  progressState.lastResolvedSectionId = targetSection.id;
  saveProgressState(progressState);
  appendSessionLog(config.sessionLogPath, {
    event: "section_selected",
    sectionId: targetSection.id,
    sectionTitle: targetSection.title,
    lessonUrl: targetSection.activityHref,
    targetHours: targetSection.targetHours,
    completedMinutesForSection: lessonProgress.completedMinutes
  });
  updateRuntimeState({
    currentLesson: targetSection.id,
    currentLessonTitle: targetSection.title,
    currentUrl: page.url()
  });
  setLessonTotals(progressState.lessonProgress);
  setLastAction(`Section ${targetSection.id} selected`, {
    currentLesson: targetSection.id,
    currentLessonTitle: targetSection.title
  });

  console.log(`Selected section ${targetSection.id}: ${targetSection.title}`);

  const sectionActivityLink = targetSection.activityHref
    ? targetSectionLocator.locator(`.activityinstance a.aalink[href="${targetSection.activityHref}"]`).first()
    : targetSectionLocator.locator(".activityinstance a.aalink").first();
  await Promise.all([
    page.waitForURL((url) => url.toString() === targetSection.activityHref, {
      timeout: config.timeoutMs
    }),
    sectionActivityLink.click()
  ]);

  await page.waitForLoadState("domcontentloaded");
  appendSessionLog(config.sessionLogPath, {
    event: "scorm_opened",
    sectionId: targetSection.id,
    url: page.url()
  });
  updateRuntimeState({ currentUrl: page.url() });
  setLastAction("SCORM opened", { currentUrl: page.url() });
  console.log(`Opened section activity: ${page.url()}`);

  await passScormRedirect(page);
  await waitForPlayerReady(page, targetSection);
  await mutePresentation(page, targetSection);
  await startPresentationPlayback(page, targetSection);

  progressState.lastScormStartedAt = new Date().toISOString();
  progressState.currentSessionId = `${targetSection.id}-${Date.now()}`;
  saveProgressState(progressState);
  appendSessionLog(config.sessionLogPath, {
    event: "scorm_session_started",
    sectionId: targetSection.id,
    startedAt: progressState.lastScormStartedAt,
    sessionId: progressState.currentSessionId
  });
  setLastAction("SCORM session started");
}

async function exitScormAttempt(page, targetSection, progressState, sessionMinutes, sessionRange = null) {
  const safeSessionMs = Math.max(1, sessionMinutes) * 60 * 1000;
  console.log(`Waiting ${sessionMinutes} minutes before exiting the SCORM activity.`);
  updateRuntimeState({
    nextPlannedExitAt: new Date(Date.now() + safeSessionMs).toISOString()
  });
  setLastAction(`Waiting ${sessionMinutes} minutes before exit`);
  const endAt = Date.now() + safeSessionMs;

  while (Date.now() < endAt) {
    touchHeartbeat(STEP.PLAYBACK);
    if (!isPageAlive(page)) {
      logWarning("scorm_session_interrupted", {
        sectionId: targetSection.id,
        reason: "page_closed_during_wait",
        url: getSafePageUrl(page)
      });
      updateRuntimeState({
        status: "idle",
        paused: false,
        nextPlannedExitAt: null,
        currentUrl: getSafePageUrl(page)
      });
      setLastAction("SCORM session interrupted");
      console.log("SCORM session was interrupted because the page or browser closed.");
      return false;
    }

    const remainingMs = endAt - Date.now();
    const chunkMs = Math.min(15_000, remainingMs);
    const pageStillAlive = await waitOnLivePage(page, chunkMs);
    if (!pageStillAlive) {
      logWarning("scorm_session_interrupted", {
        sectionId: targetSection.id,
        reason: "page_closed_during_wait",
        url: getSafePageUrl(page)
      });
      updateRuntimeState({
        status: "idle",
        paused: false,
        nextPlannedExitAt: null,
        currentUrl: getSafePageUrl(page)
      });
      setLastAction("SCORM session interrupted");
      console.log("SCORM session was interrupted because the page or browser closed.");
      return false;
    }

    if (Date.now() < endAt) {
      await advancePresentation(page, targetSection).catch(() => false);
    }
  }

  if (!isPageAlive(page)) {
    logWarning("scorm_session_interrupted", {
      sectionId: targetSection.id,
      reason: "page_closed_before_exit",
      url: getSafePageUrl(page)
    });
    updateRuntimeState({
      status: "idle",
      paused: false,
      nextPlannedExitAt: null,
      currentUrl: getSafePageUrl(page)
    });
    setLastAction("SCORM session interrupted");
    return false;
  }

  const exitActivityLink = page
    .locator('a[title="Έξοδος από τη δραστηριότητα"], a[href*="course/view.php?id=7378"]')
    .first();
  await exitActivityLink.waitFor({ state: "visible", timeout: config.timeoutMs });

  const expectedCourseUrl = new RegExp(`/course/view\\.php\\?id=7378(?:#section-${targetSection.id})?$`);
  await Promise.all([
    page.waitForURL((url) => expectedCourseUrl.test(url.toString()), {
      timeout: config.timeoutMs
    }),
    exitActivityLink.click()
  ]);

  await page.waitForLoadState("domcontentloaded");
  progressState.lastScormExitedAt = new Date().toISOString();
  const sessionId = progressState.currentSessionId || `${targetSection.id}-${Date.now()}`;
  let dailySplit = {
    completedMinutesToday: progressState.dailyProgress?.completedMinutes || 0,
    minutesCountedToday: 0,
    minutesCountedPreviousDay: 0
  };
  let lessonProgress = ensureLessonProgress(progressState, targetSection.id, targetSection.targetHours);
  const applyResult = applySessionMinutesIdempotent(progressState, sessionId, "final", () => {
    dailySplit = addCompletedMinutesSplitByCurrentAthensDay(
      progressState,
      sessionMinutes,
      progressState.lastScormStartedAt,
      progressState.lastScormExitedAt
    );
    lessonProgress = addCompletedLessonMinutes(
      progressState,
      targetSection.id,
      targetSection.targetHours,
      sessionMinutes
    );
  });
  const completedMinutesToday = dailySplit.completedMinutesToday;
  const invariantWarnings = validateAndClampProgressState(progressState, {
    dailyLimitMinutes: progressState.dailyScormLimitMinutes || config.dailyScormLimitMinutes
  });
  for (const warning of invariantWarnings) {
    appendSessionLog(config.sessionLogPath, {
      event: "progress_invariant_warning",
      ...warning
    });
  }

  appendSessionLog(config.sessionLogPath, {
    event: "scorm_session_completed",
    sectionId: targetSection.id,
    exitedAt: progressState.lastScormExitedAt,
    sessionMinutes,
    chosenSessionMinutes: sessionMinutes,
    sessionId,
    idempotentApplied: applyResult.applied,
    rangeMin: sessionRange?.min ?? null,
    rangeMax: sessionRange?.max ?? null,
    completedMinutesToday,
    completedMinutesForSection: lessonProgress.completedMinutes,
    targetHours: targetSection.targetHours,
    url: page.url()
  });
  if (dailySplit.minutesCountedToday !== sessionMinutes) {
    appendSessionLog(config.sessionLogPath, {
      event: "session_split_across_days",
      sectionId: targetSection.id,
      sessionMinutes,
      minutesCountedToday: dailySplit.minutesCountedToday,
      minutesCountedPreviousDay: dailySplit.minutesCountedPreviousDay,
      startedAt: progressState.lastScormStartedAt,
      exitedAt: progressState.lastScormExitedAt
    });
  }
  setLessonTotals(progressState.lessonProgress);
  updateRuntimeState({
    currentUrl: page.url(),
    nextPlannedExitAt: null,
    todayMinutes: completedMinutesToday
  });
  setLastAction("SCORM session completed", { currentUrl: page.url() });
  console.log(`Exited activity safely: ${page.url()}`);
  console.log(`Completed ${completedMinutesToday}/${config.dailyScormLimitMinutes} minutes for today.`);
  console.log(
    `Section ${targetSection.id} local total: ${lessonProgress.completedMinutes}/${targetSection.targetHours * 60} minutes.`
  );
  return true;
}

async function runDailyScormLoop(page, progressState) {
  const sessionRange = resolveSessionRange(progressState, config);
  const dailyLimitOverride =
    Number.isFinite(Number(progressState.dailyScormLimitMinutes)) && Number(progressState.dailyScormLimitMinutes) > 0
      ? Number(progressState.dailyScormLimitMinutes)
      : config.dailyScormLimitMinutes;

  let lastSectionId = null;

  while (true) {
    touchHeartbeat(STEP.PLAYBACK);
    const dailyProgress = ensureDailyProgress(progressState);
    const remainingMinutes = dailyLimitOverride - dailyProgress.completedMinutes;

    if (remainingMinutes <= 0) {
      appendSessionLog(config.sessionLogPath, {
        event: "daily_limit_reached",
        completedMinutesToday: dailyProgress.completedMinutes,
        dailyLimitMinutes: dailyLimitOverride
      });
      transitionRuntimeState("idle", {
        paused: false,
        nextPlannedExitAt: null,
        todayMinutes: dailyProgress.completedMinutes,
        dailyLimitMinutes: dailyLimitOverride
      });
      setLastAction("Daily limit reached");
      console.log("Daily SCORM limit reached. Stopping for today.");
      return;
    }

    if (Array.isArray(config.scheduleWindowsErrors) && config.scheduleWindowsErrors.length > 0) {
      appendSessionLog(config.sessionLogPath, {
        event: "schedule_windows_invalid",
        errors: config.scheduleWindowsErrors
      });
    }

    const windowCheck = isNowWithinAnyWindow(config.scheduleWindows);
    if (!windowCheck.within) {
      const nextStart = computeNextWindowStart(config.scheduleWindows);
      const nextStartIso = nextStart ? nextStart.toISOString() : null;
      transitionRuntimeState("paused", {
        paused: true,
        nextPlannedExitAt: nextStartIso,
        currentUrl: page.url()
      });
      setLastAction("Waiting for scheduled window to open", {
        nextPlannedExitAt: nextStartIso
      });
      appendSessionLog(config.sessionLogPath, {
        event: "schedule_window_waiting",
        nextWindowStartIso: nextStartIso
      });
      console.log(`Outside schedule windows. Waiting until ${nextStartIso || "next available window"}.`);

      while (!isNowWithinAnyWindow(config.scheduleWindows).within) {
        touchHeartbeat(STEP.PLAYBACK);
        const next = computeNextWindowStart(config.scheduleWindows);
        const wakeMs = next ? Math.max(5_000, Math.min(60_000, next.getTime() - Date.now())) : 60_000;
        const stillAlive = await waitOnLivePage(page, wakeMs);
        if (!stillAlive) {
          appendSessionLog(config.sessionLogPath, {
            event: "schedule_window_wait_interrupted",
            reason: "page_closed",
            url: getSafePageUrl(page)
          });
          return;
        }
      }

      transitionRuntimeState("running", { paused: false, currentUrl: page.url() });
      setLastAction("Scheduled window open; resuming run", { currentUrl: page.url() });
      appendSessionLog(config.sessionLogPath, { event: "schedule_window_resumed" });
    }

    const targetSection = await resolveTargetSection(page, progressState);
    ensureLessonProgress(progressState, targetSection.id, targetSection.targetHours);
    setLessonTotals(progressState.lessonProgress);

    if (lastSectionId !== targetSection.id) {
      lastSectionId = targetSection.id;
      appendSessionLog(config.sessionLogPath, {
        event: "lesson_section_advanced",
        sectionId: targetSection.id,
        lessonKey: targetSection.lessonKey,
        sectionTitle: targetSection.title,
        url: page.url()
      });
      updateRuntimeState({
        currentLesson: targetSection.id,
        currentLessonTitle: targetSection.title,
        currentUrl: page.url()
      });
      setLastAction(`Advanced to lesson ${targetSection.lessonKey}`, {
        currentLesson: targetSection.id,
        currentLessonTitle: targetSection.title
      });
      console.log(`Advancing to lesson ${targetSection.lessonKey} (section ${targetSection.id}).`);
    }

    const activeWindow = isNowWithinAnyWindow(config.scheduleWindows).activeWindow;
    const windowRemaining = minutesUntilWindowEnd(activeWindow);
    const effectiveRemainingMinutes =
      windowRemaining === null ? remainingMinutes : Math.max(0, Math.min(remainingMinutes, windowRemaining));

    if (effectiveRemainingMinutes <= 0) {
      // Window is effectively closed; loop back into the wait logic.
      continue;
    }

    const sessionMinutes = pickSessionMinutes(sessionRange, effectiveRemainingMinutes);
    updateRuntimeState({
      currentLesson: targetSection.id,
      currentLessonTitle: targetSection.title,
      nextPlannedExitAt: new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString()
    });
    appendSessionLog(config.sessionLogPath, {
      event: "scorm_session_randomized",
      sectionId: targetSection.id,
      chosenSessionMinutes: sessionMinutes,
      rangeMin: sessionRange.min,
      rangeMax: sessionRange.max
    });
    await startScormAttempt(page, targetSection, progressState);
    const completedAttempt = await exitScormAttempt(
      page,
      targetSection,
      progressState,
      sessionMinutes,
      sessionRange
    );
    if (!completedAttempt) {
      return;
    }
  }
}

async function runWorkflow(page) {
  let recoveryAttempts = 0;
  const supervisor = createRunSupervisor({
    appendLog: (entry) => {
      appendSessionLog(config.sessionLogPath, entry);
    },
    onStepSuccess: async (step) => {
      touchHeartbeat(step);
      updateRuntimeDiagnostics({
        currentStep: step,
        lastSuccessfulStep: step,
        lastStableCheckpoint: step
      });
    },
    onStepFailure: async (step, attempt, error) => {
      updateRuntimeDiagnostics({
        currentStep: step,
        lastSelectorFailure: error?.message || "step_failed"
      });
      logFailure(
        "supervisor_terminal_failure",
        {
          step,
          attempt,
          currentUrl: getSafePageUrl(page)
        },
        error
      );
    },
    onRecovery: async ({ step, attempt, recoveryAction, message }) => {
      recoveryAttempts += 1;
      updateRuntimeDiagnostics({
        currentStep: step,
        lastRecoveryAction: recoveryAction,
        recoveryAttempts
      });
      appendSessionLog(config.sessionLogPath, {
        event: "recovery_playbook_applied",
        step,
        attempt,
        recoveryAction,
        message
      });
    }
  });
  const progressState = ensureProgressStarted(loadProgressState(config.progressStatePath));
  const repair = repairLessonTargets(progressState);
  if (repair.changed) {
    saveProgressState(progressState);
    appendSessionLog(config.sessionLogPath, {
      event: "progress_repaired_lesson_targets",
      changes: repair.changes
    });
  }
  try {
    ensureDailyProgress(progressState);
    setLessonTotals(progressState.lessonProgress);
    transitionRuntimeState("running", {
      paused: false,
      currentUrl: page.url(),
      todayMinutes: progressState.dailyProgress.completedMinutes,
      dailyLimitMinutes:
        Number.isFinite(Number(progressState.dailyScormLimitMinutes)) && Number(progressState.dailyScormLimitMinutes) > 0
          ? Number(progressState.dailyScormLimitMinutes)
          : config.dailyScormLimitMinutes
    });
    appendSessionLog(config.sessionLogPath, {
      event: "workflow_started",
      baseSectionIndex: progressState.baseSectionIndex
    });
    setLastAction("Workflow started");

    const authResult = await supervisor.executeStep(STEP.AUTH, async () => {
      await syncLessonStatsFromPanel(page, progressState);
      return { ok: true };
    });
    if (!authResult.ok) {
      throw new StepError(STEP.AUTH, authResult.error, authResult.kind);
    }

    const openCourseResult = await supervisor.executeStep(STEP.OPEN_COURSE, async () => {
      const coursePage = await openCoursePage(page);
      return { coursePage };
    });
    if (!openCourseResult.ok) {
      throw new StepError(STEP.OPEN_COURSE, openCourseResult.error, openCourseResult.kind);
    }
    const coursePage = openCourseResult.data.coursePage;

    const openScormResult = await supervisor.executeStep(STEP.OPEN_SCORM, async () => {
      const targetSection = await resolveTargetSection(coursePage, progressState);
      return { targetSection };
    });
    if (!openScormResult.ok) {
      throw new StepError(STEP.OPEN_SCORM, openScormResult.error, openScormResult.kind);
    }
    const targetSection = openScormResult.data.targetSection;
    ensureLessonProgress(progressState, targetSection.id, targetSection.targetHours);
    setLessonTotals(progressState.lessonProgress);
    appendSessionLog(config.sessionLogPath, {
      event: "lesson_target_synced",
      sectionId: targetSection.id,
      targetHours: targetSection.targetHours
    });
    setLastAction("Lesson target synced");
    const playbackResult = await supervisor.executeStep(STEP.PLAYBACK, async () => {
      await runDailyScormLoop(coursePage, progressState);
      return { done: true };
    });
    if (!playbackResult.ok) {
      throw new StepError(STEP.PLAYBACK, playbackResult.error, playbackResult.kind);
    }
  } finally {
    updateRuntimeState({
      supervisorTimeline: supervisor.getTimeline(200)
    });
  }
}

async function main() {
  initRuntimeState(config.runtimeStatePath);
  startDashboardServer({
    port: config.dashboardPort,
    runtimeStatePath: config.runtimeStatePath,
    progressStatePath: config.progressStatePath,
    sessionLogPath: config.sessionLogPath
  });
  transitionRuntimeState("idle", {
    paused: false,
    dailyLimitMinutes: config.dailyScormLimitMinutes,
    nextPlannedExitAt: null
  });
  setLastAction(`Dashboard started at http://127.0.0.1:${config.dashboardPort}`);
  console.log(`Dashboard available at http://127.0.0.1:${config.dashboardPort}`);

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMo
  });

  const contextOptions = {};
  if (fs.existsSync(config.storageStatePath)) {
    contextOptions.storageState = config.storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);

  try {
    await ensureAuthenticated(page);
    if (process.argv.includes("--test-login-only")) {
      return;
    }
    await runWorkflow(page);
  } finally {
    transitionRuntimeState("idle", {
      paused: false,
      nextPlannedExitAt: null,
      currentUrl: getSafePageUrl(page)
    });
    setLastAction("Browser closed");
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

process.on("unhandledRejection", (reason) => {
  const rejectionError =
    reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
  logFailure("unhandled_promise_rejection", {}, rejectionError);
});

process.on("uncaughtException", (error) => {
  logFailure("uncaught_exception", {}, error);
});

main().catch((error) => {
  transitionRuntimeState("error", {
    paused: false,
    nextPlannedExitAt: null
  });
  setLastAction(`Error: ${error.message}`);
  logFailure("workflow_failed", { phase: "main" }, error);
  process.exitCode = 1;
});
