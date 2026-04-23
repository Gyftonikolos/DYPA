function getRecoveryActionsForStep(step) {
  switch (step) {
    case "auth":
      return ["reload_auth_entry", "retry_login"];
    case "open_course":
      return ["reload_training_page", "open_course_direct"];
    case "open_scorm":
      return ["reopen_section_activity", "reload_course_page"];
    case "playback":
      return ["reclick_player_controls", "reload_scorm_player"];
    case "exit_scorm":
      return ["retry_exit_link", "open_course_direct"];
    default:
      return ["retry"];
  }
}

function getRecoveryBudget(step) {
  if (step === "playback") {
    return { maxAttempts: 3, cooldownMs: 1000 };
  }
  return { maxAttempts: 2, cooldownMs: 750 };
}

module.exports = {
  getRecoveryActionsForStep,
  getRecoveryBudget
};
