function toLessonCandidate(section, progressState) {
  const sectionId = section?.id;
  const progressEntry = sectionId ? progressState?.lessonProgress?.[sectionId] : null;
  const targetHoursFromProgress = Number(progressEntry?.targetHours);
  const targetHoursFromConfig = Number(section?.targetHours);
  const resolvedTargetHours =
    Number.isFinite(targetHoursFromProgress) && targetHoursFromProgress > 0
      ? targetHoursFromProgress
      : targetHoursFromConfig;
  return {
    id: sectionId,
    lessonKey: section.lessonKey,
    completedMinutes: Number(progressEntry?.completedMinutes || 0),
    targetMinutes: Number(resolvedTargetHours || 0) * 60
  };
}

function resolveLessonSelection(lessonSections, progressState) {
  const candidates = (lessonSections || []).map((section) => toLessonCandidate(section, progressState));
  if (candidates.length === 0) {
    return {
      selectedSectionId: null,
      selectedLessonKey: null,
      reason: "fallback_selected",
      candidateSnapshot: []
    };
  }

  let reason = "first_incomplete_in_sequence";
  let selected = candidates.find((candidate, index) => {
    const isIncomplete = candidate.completedMinutes < candidate.targetMinutes;
    if (!isIncomplete) return false;
    if (index > 0) {
      const previous = candidates[index - 1];
      if (previous.completedMinutes >= previous.targetMinutes) {
        reason = "previous_lesson_reached_target";
      }
    }
    return true;
  });

  if (!selected) {
    selected = candidates[0];
    reason = "fallback_selected";
  }

  return {
    selectedSectionId: selected.id,
    selectedLessonKey: selected.lessonKey,
    reason,
    candidateSnapshot: candidates
  };
}

module.exports = {
  resolveLessonSelection
};
