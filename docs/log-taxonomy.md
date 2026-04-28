# Log Taxonomy

This file documents normalized log fields used in `session-log.jsonl`:

- `errorCode`: present on failure/error events.
- `warningCode`: present on warning/non-fatal issue events.
- `source`: component/function that emitted the log.

Use these fields to quickly filter and diagnose failures.

## Error Codes

| errorCode | Event(s) | Source |
|---|---|---|
| `AUTH_LOGIN_NAV_TIMEOUT` | `login_attempt_navigation_timeout` | `auth.ensureAuthenticated` |
| `AUTH_ATTEMPT_FAILED` | `auth_attempt_failed` | `auth.ensureAuthenticated` |
| `PORTAL_UI_DRIFT` | `portal_drift_detected` (error-path variant) | `course.resolveSections` |
| `SUPERVISOR_STEP_FAILED` | `supervisor_terminal_failure` | `workflow.supervisor` |
| `PROCESS_UNHANDLED_REJECTION` | `unhandled_promise_rejection` | `process.global` |
| `PROCESS_UNCAUGHT_EXCEPTION` | `uncaught_exception` | `process.global` |
| `WORKFLOW_MAIN_FAILED` | `workflow_failed` | `workflow.main` |
| `SUPERVISOR_AUTH_STEP_FAILED` | `supervisor_step_failed` for `AUTH` step | `runSupervisor.executeStep` |
| `SUPERVISOR_OPEN_COURSE_STEP_FAILED` | `supervisor_step_failed` for `OPEN_COURSE` step | `runSupervisor.executeStep` |
| `SUPERVISOR_OPEN_SCORM_STEP_FAILED` | `supervisor_step_failed` for `OPEN_SCORM` step | `runSupervisor.executeStep` |
| `SUPERVISOR_PLAYBACK_STEP_FAILED` | `supervisor_step_failed` for `PLAYBACK` step | `runSupervisor.executeStep` |
| `BOT_STDERR` | `desktop_bot_stderr` | `electron.bot.stderr` |
| `UNKNOWN_ERROR` | any unmapped error event | `unknown` (fallback) |

## Warning Codes

| warningCode | Event(s) | Source |
|---|---|---|
| `PORTAL_STATS_PANEL_MISSING` | `async_stats_panel_missing` | `stats.syncLessonStatsFromPanel` |
| `PORTAL_UI_DRIFT` | `portal_drift_detected` (warning-path variant) | `workflow.portal` |
| `TRAINING_CARD_MISSING` | `training_card_missing_fallback` | `course.openCoursePage` |
| `COURSE_LINK_HIDDEN` | `course_link_hidden_fallback` | `course.openCoursePage` |
| `SCORM_CONTROLS_TIMEOUT` | `player_controls_timeout` | `scorm.waitForPlayerReady` |
| `SCORM_MUTE_BUTTON_MISSING` | `player_mute_button_missing` | `scorm.mutePresentation` |
| `SCORM_PLAY_BUTTON_MISSING` | `player_play_button_missing` | `scorm.startPlayback` |
| `SCORM_NEXT_BUTTON_MISSING` | `player_next_button_missing` | `scorm.advancePresentation` |
| `SCORM_SESSION_INTERRUPTED` | `scorm_session_interrupted` | `scorm.exitAttempt` |
| `HEARTBEAT_STALE` | `stale_run_detected` | `electron.staleRunMonitor` |
| `SCHEDULE_SKIPPED_ALREADY_RUNNING` | `schedule_skipped_running` | `electron.scheduleMonitor` |
| `GENERIC_WARNING` | any unmapped warning event | `unknown` (fallback) |

## Search Examples

PowerShell examples:

```powershell
# Find all fatal workflow failures
rg '"errorCode":"WORKFLOW_MAIN_FAILED"' session-log.jsonl

# Find all SCORM interruption warnings
rg '"warningCode":"SCORM_SESSION_INTERRUPTED"' session-log.jsonl

# Find all logs from one source
rg '"source":"runSupervisor.executeStep"' session-log.jsonl

# Find all logs related to portal drift (error or warning)
rg '"PORTAL_UI_DRIFT"' session-log.jsonl
```

## Notes

- A single event name can appear in different paths with different semantics.
- `portal_drift_detected` is intentionally used in both error and warning paths.
- If new taxonomy values are added in code, update this document in the same change.
