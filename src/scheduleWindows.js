function isValidTimeToken(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ""));
}

function parseTimeToMinutes(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

function parseScheduleWindowsCsv(csvValue) {
  const csv = String(csvValue || "").trim();
  if (!csv) {
    return { windows: [], errors: [] };
  }

  const tokens = csv
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  const windows = [];
  const errors = [];

  for (const token of tokens) {
    const parts = token.split("-").map((part) => part.trim());
    if (parts.length !== 2) {
      errors.push(`Invalid window "${token}" (expected HH:mm-HH:mm)`);
      continue;
    }
    const [start, end] = parts;
    if (!isValidTimeToken(start) || !isValidTimeToken(end)) {
      errors.push(`Invalid window "${token}" (expected HH:mm-HH:mm)`);
      continue;
    }
    const startMinutes = parseTimeToMinutes(start);
    const endMinutes = parseTimeToMinutes(end);
    windows.push({
      start,
      end,
      startMinutes,
      endMinutes,
      wrapsMidnight: endMinutes <= startMinutes
    });
  }

  windows.sort((a, b) => a.startMinutes - b.startMinutes);
  return { windows, errors };
}

function getMinutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function isNowWithinAnyWindow(windows, now = new Date()) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return { within: true, activeWindow: null };
  }
  const minutes = getMinutesSinceMidnight(now);
  for (const window of windows) {
    if (!window.wrapsMidnight) {
      if (minutes >= window.startMinutes && minutes < window.endMinutes) {
        return { within: true, activeWindow: window };
      }
      continue;
    }
    if (minutes >= window.startMinutes || minutes < window.endMinutes) {
      return { within: true, activeWindow: window };
    }
  }
  return { within: false, activeWindow: null };
}

function computeNextWindowStart(windows, now = new Date()) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return null;
  }

  const minutes = getMinutesSinceMidnight(now);
  const today = new Date(now);
  today.setSeconds(0, 0);

  const startsToday = windows
    .map((w) => w.startMinutes)
    .sort((a, b) => a - b)
    .map((startMinutes) => {
      const startAt = new Date(today);
      startAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
      return startAt;
    });

  for (const startAt of startsToday) {
    const startMinutes = startAt.getHours() * 60 + startAt.getMinutes();
    if (startMinutes > minutes) {
      return startAt;
    }
  }

  const first = startsToday[0];
  if (!first) return null;
  const next = new Date(first);
  next.setDate(next.getDate() + 1);
  return next;
}

function minutesUntilWindowEnd(activeWindow, now = new Date()) {
  if (!activeWindow) {
    return null;
  }
  const minutes = getMinutesSinceMidnight(now);
  if (!activeWindow.wrapsMidnight) {
    return Math.max(0, activeWindow.endMinutes - minutes);
  }
  if (minutes >= activeWindow.startMinutes) {
    return Math.max(0, 24 * 60 - minutes + activeWindow.endMinutes);
  }
  return Math.max(0, activeWindow.endMinutes - minutes);
}

module.exports = {
  parseScheduleWindowsCsv,
  isNowWithinAnyWindow,
  computeNextWindowStart,
  minutesUntilWindowEnd
};

