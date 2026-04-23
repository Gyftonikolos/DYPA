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
        appendSessionLog(config.sessionLogPath, {
          event: "login_attempt_navigation_timeout",
          attempt,
          message: error.message
        });
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
      appendSessionLog(config.sessionLogPath, {
        event: "auth_attempt_failed",
        attempt,
        url: page.url(),
        message: error.message
      });
    }
  }

  throw new Error("Authentication did not reach the trainee portal after retries.");
}

async function syncLessonStatsFromPanel(page, progressState) {
  const statsPanel = page.locator("#asyncStatsPanel");
  const panelVisible = await statsPanel.isVisible().catch(() => false);

  if (!panelVisible) {
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
    const hoursMatch = card.progressText.match(/(\d+)\s*από\s*(\d+)/u);

    if (!lessonMatch || !hoursMatch) {
      continue;
    }

    const lessonKey = `E${lessonMatch[1]}`;
    const lessonConfig = lessonMap.get(lessonKey);
    if (!lessonConfig) {
      continue;
    }

    const completedHours = Number(hoursMatch[1]);
    const targetHours = Number(hoursMatch[2]);
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
      appendSessionLog(config.sessionLogPath, {
        event: "training_card_missing_fallback",
        url: page.url()
      });
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
    appendSessionLog(config.sessionLogPath, {
      event: "portal_drift_detected",
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
    appendSessionLog(config.sessionLogPath, {
      event: "course_link_hidden_fallback",
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
    appendSessionLog(config.sessionLogPath, {
      event: "portal_drift_detected",
      phase: "lesson_section_list",
      missingSelectors: ["li.section.main"],
      url: page.url(),
      message: error.message
    });
    throw error;
  }

  return page.locator("li.section.main, .course-content li.section").evaluateAll((elements) =>
    elements.map((element, index) => {
      const titleAnchor = element.querySelector(".sectionname a");
      const activityAnchor = element.querySelector(".activityinstance a.aalink");

      return {
        index,
        id: element.getAttribute("data-sectionid") || element.id?.replace("section-", "") || null,
        title: titleAnchor?.textContent?.trim() || `Section ${index + 1}`,
        activityHref: activityAnchor?.href || null
      };
    })
  );
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

  const selection = resolveLessonSelection(lessonSections, progressState);
  let targetSection = lessonSections.find((section) => section.id === selection.selectedSectionId) || null;
  if (!targetSection) {
    const fallbackIndex = resolveSectionIndex(progressState, lessonSections.length);
    targetSection = lessonSections[fallbackIndex];
  }

  if (!targetSection || !targetSection.id || !targetSection.activityHref) {
    throw new Error("Could not resolve a valid target lesson section.");
  }

  appendSessionLog(config.sessionLogPath, {
    event: "lesson_selection_reason",
    selectedSectionId: targetSection.id,
    selectedLessonKey: targetSection.lessonKey,
    reason: selection.reason,
    candidateSnapshot: selection.candidateSnapshot
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

  appendSessionLog(config.sessionLogPath, {
    event: "player_controls_timeout",
    sectionId: targetSection.id,
    url: page.url()
  });
  appendSessionLog(config.sessionLogPath, {
    event: "portal_drift_detected",
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
    appendSessionLog(config.sessionLogPath, {
      event: "player_mute_button_missing",
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
    appendSessionLog(config.sessionLogPath, {
      event: "player_play_button_missing",
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
    appendSessionLog(config.sessionLogPath, {
      event: "player_next_button_missing",
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

  const sectionActivityLink = targetSectionLocator.locator(".activityinstance a.aalink").first();
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
      appendSessionLog(config.sessionLogPath, {
        event: "scorm_session_interrupted",
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
      appendSessionLog(config.sessionLogPath, {
        event: "scorm_session_interrupted",
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
    appendSessionLog(config.sessionLogPath, {
      event: "scorm_session_interrupted",
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

async function runDailyScormLoop(page, targetSection, progressState) {
  const sessionRange = resolveSessionRange(progressState, config);
  const dailyLimitOverride =
    Number.isFinite(Number(progressState.dailyScormLimitMinutes)) && Number(progressState.dailyScormLimitMinutes) > 0
      ? Number(progressState.dailyScormLimitMinutes)
      : config.dailyScormLimitMinutes;

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

    const sessionMinutes = pickSessionMinutes(sessionRange, remainingMinutes);
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
      appendSessionLog(config.sessionLogPath, {
        event: "supervisor_terminal_failure",
        step,
        attempt,
        message: error?.message || String(error)
      });
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
      await runDailyScormLoop(coursePage, targetSection, progressState);
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

main().catch((error) => {
  transitionRuntimeState("error", {
    paused: false,
    nextPlannedExitAt: null
  });
  setLastAction(`Error: ${error.message}`);
  appendSessionLog(config.sessionLogPath, {
    event: "workflow_failed",
    message: error.message
  });
  console.error("Automation failed:");
  console.error(error);
  process.exitCode = 1;
});
