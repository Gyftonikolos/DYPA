const { chromium } = require("playwright");
const fs = require("fs");
const config = require("./config");
const {
  loadProgressState,
  saveProgressState,
  ensureProgressStarted,
  resolveSectionIndex,
  ensureDailyProgress,
  addCompletedMinutes,
  appendSessionLog,
  ensureLessonProgress,
  addCompletedLessonMinutes
} = require("./progressStore");

const ELEARNING_URL_PATTERNS = [
  /https:\/\/elearning\.golearn\.gr\/local\/mdl_autologin\/autologin\.php/i,
  /https:\/\/elearning\.golearn\.gr\/$/i,
  /https:\/\/elearning\.golearn\.gr\/my\/?$/i
];
const AUTH_ENTRY_URL = "https://edu.golearn.gr/login?returnUrl=%2f";
const COURSE_URL = "https://elearning.golearn.gr/course/view.php?id=7378";
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
    await page.goto(AUTH_ENTRY_URL, { waitUntil: "domcontentloaded" });

    const loginFormVisible = await page.locator("#Input_Username").isVisible().catch(() => false);
    if (page.url().includes("/login") || loginFormVisible) {
      appendSessionLog(config.sessionLogPath, {
        event: "login_attempt_started",
        attempt,
        url: page.url()
      });

      try {
        await login(page);
      } catch (error) {
        appendSessionLog(config.sessionLogPath, {
          event: "login_attempt_navigation_timeout",
          attempt,
          message: error.message
        });
      }

      await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
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
    currentLessonProgress.completedMinutes = Math.max(
      currentLessonProgress.completedMinutes || 0,
      liveCompletedMinutes
    );
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
  console.log("Training page opened successfully.");

  const openCoursesButtonSelector =
    'button:has(.fa-envelope-open-text), button:has(span.fa-envelope-open-text)';
  let openCoursesButton = page.locator(openCoursesButtonSelector).first();
  await openCoursesButton.waitFor({ state: "visible", timeout: config.timeoutMs });
  await openCoursesButton.scrollIntoViewIfNeeded().catch(() => {});

  const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  appendSessionLog(config.sessionLogPath, {
    event: "open_courses_button_click_attempt",
    url: page.url()
  });
  openCoursesButton = page.locator(openCoursesButtonSelector).first();
  await openCoursesButton.click({ force: true });
  const popup = await popupPromise;
  const targetPage = popup || page;

  await targetPage.waitForURL(
    (url) => ELEARNING_URL_PATTERNS.some((pattern) => pattern.test(url.toString())),
    { timeout: config.timeoutMs }
  );

  await targetPage.waitForLoadState("domcontentloaded");
  appendSessionLog(config.sessionLogPath, {
    event: "courses_page_opened",
    url: targetPage.url()
  });
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
      url: targetPage.url()
    });
    await targetPage.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
  }

  await targetPage.waitForLoadState("domcontentloaded");
  appendSessionLog(config.sessionLogPath, {
    event: "course_opened",
    url: targetPage.url()
  });
  console.log(`Course page opened: ${targetPage.url()}`);

  return targetPage;
}

async function resolveCourseSections(page) {
  await page.locator("li.section.main").first().waitFor({
    state: "visible",
    timeout: config.timeoutMs
  });

  return page.locator("li.section.main").evaluateAll((elements) =>
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

  const targetIndex = resolveSectionIndex(progressState, lessonSections.length);
  const targetSection = lessonSections[targetIndex];

  if (!targetSection || !targetSection.id || !targetSection.activityHref) {
    throw new Error(`Could not resolve the target section at index ${targetIndex}.`);
  }

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
    const playTarget = await getFrameWithSelector(page, PLAYER_PLAY_SELECTOR);
    const muteTarget = await getFrameWithSelector(page, PLAYER_MUTE_SELECTOR);

    if (playTarget || muteTarget) {
      appendSessionLog(config.sessionLogPath, {
        event: "player_controls_ready",
        sectionId: targetSection.id,
        url: page.url()
      });
      return;
    }

    await page.waitForTimeout(1_000);
  }

  appendSessionLog(config.sessionLogPath, {
    event: "player_controls_timeout",
    sectionId: targetSection.id,
    url: page.url()
  });
}

async function mutePresentation(page, targetSection) {
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
  console.log("Presentation muted.");
}

async function startPresentationPlayback(page, targetSection) {
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
  console.log("Presentation playback started.");
}

async function advancePresentation(page, targetSection) {
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
  console.log(`Opened section activity: ${page.url()}`);

  await passScormRedirect(page);
  await waitForPlayerReady(page, targetSection);
  await mutePresentation(page, targetSection);
  await startPresentationPlayback(page, targetSection);

  progressState.lastScormStartedAt = new Date().toISOString();
  saveProgressState(progressState);
  appendSessionLog(config.sessionLogPath, {
    event: "scorm_session_started",
    sectionId: targetSection.id,
    startedAt: progressState.lastScormStartedAt
  });
}

async function exitScormAttempt(page, targetSection, progressState, sessionMinutes) {
  const safeSessionMs = Math.max(1, sessionMinutes) * 60 * 1000;
  console.log(`Waiting ${sessionMinutes} minutes before exiting the SCORM activity.`);
  const endAt = Date.now() + safeSessionMs;

  while (Date.now() < endAt) {
    const remainingMs = endAt - Date.now();
    const chunkMs = Math.min(15_000, remainingMs);
    await page.waitForTimeout(chunkMs);

    if (Date.now() < endAt) {
      await advancePresentation(page, targetSection).catch(() => false);
    }
  }

  const exitActivityLink = page.locator('a[title="Έξοδος από τη δραστηριότητα"]').first();
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
  const completedMinutesToday = addCompletedMinutes(progressState, sessionMinutes);
  const lessonProgress = addCompletedLessonMinutes(
    progressState,
    targetSection.id,
    targetSection.targetHours,
    sessionMinutes
  );

  appendSessionLog(config.sessionLogPath, {
    event: "scorm_session_completed",
    sectionId: targetSection.id,
    exitedAt: progressState.lastScormExitedAt,
    sessionMinutes,
    completedMinutesToday,
    completedMinutesForSection: lessonProgress.completedMinutes,
    targetHours: targetSection.targetHours,
    url: page.url()
  });
  console.log(`Exited activity safely: ${page.url()}`);
  console.log(`Completed ${completedMinutesToday}/${config.dailyScormLimitMinutes} minutes for today.`);
  console.log(
    `Section ${targetSection.id} local total: ${lessonProgress.completedMinutes}/${targetSection.targetHours * 60} minutes.`
  );
}

async function runDailyScormLoop(page, targetSection, progressState) {
  const sessionMinutesOverride =
    Number.isFinite(Number(progressState.scormSessionMinutes)) && Number(progressState.scormSessionMinutes) > 0
      ? Number(progressState.scormSessionMinutes)
      : config.maxScormSessionMinutes;
  const dailyLimitOverride =
    Number.isFinite(Number(progressState.dailyScormLimitMinutes)) && Number(progressState.dailyScormLimitMinutes) > 0
      ? Number(progressState.dailyScormLimitMinutes)
      : config.dailyScormLimitMinutes;

  while (true) {
    const dailyProgress = ensureDailyProgress(progressState);
    const remainingMinutes = dailyLimitOverride - dailyProgress.completedMinutes;

    if (remainingMinutes <= 0) {
      appendSessionLog(config.sessionLogPath, {
        event: "daily_limit_reached",
        completedMinutesToday: dailyProgress.completedMinutes,
        dailyLimitMinutes: dailyLimitOverride
      });
      console.log("Daily SCORM limit reached. Stopping for today.");
      return;
    }

    const sessionMinutes = Math.min(sessionMinutesOverride, remainingMinutes);
    await startScormAttempt(page, targetSection, progressState);
    await exitScormAttempt(page, targetSection, progressState, sessionMinutes);
  }
}

async function runWorkflow(page) {
  const progressState = ensureProgressStarted(loadProgressState(config.progressStatePath));
  ensureDailyProgress(progressState);
  appendSessionLog(config.sessionLogPath, {
    event: "workflow_started",
    baseSectionIndex: progressState.baseSectionIndex
  });

  await syncLessonStatsFromPanel(page, progressState);

  const coursePage = await openCoursePage(page);
  const targetSection = await resolveTargetSection(coursePage, progressState);
  ensureLessonProgress(progressState, targetSection.id, targetSection.targetHours);
  appendSessionLog(config.sessionLogPath, {
    event: "lesson_target_synced",
    sectionId: targetSection.id,
    targetHours: targetSection.targetHours
  });
  await runDailyScormLoop(coursePage, targetSection, progressState);
}

async function main() {
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
    await runWorkflow(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  appendSessionLog(config.sessionLogPath, {
    event: "workflow_failed",
    message: error.message
  });
  console.error("Automation failed:");
  console.error(error);
  process.exitCode = 1;
});
