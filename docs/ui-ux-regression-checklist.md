# UI/UX Regression Checklist

Run this checklist before shipping UI changes.

## Navigation and Layout
- Verify all tabs switch correctly: Dashboard, Automation, Settings, Logs, Onboarding.
- Confirm dashboard quick actions trigger expected handlers.
- Resize app to smaller widths and verify no clipped critical controls.

## Onboarding and Guidance
- Confirm onboarding overlay appears on first launch and can be dismissed.
- Open Onboarding tab and verify checklist renders.
- Validate help tooltips and help panel open/close behavior.

## Settings Ergonomics
- Save a named profile and apply it back.
- Verify unsafe settings warning appears for risky values.
- Validate session range hint and auto-swap behavior.

## Diagnostics and Logs
- Confirm runtime diagnostics fields update (step, recovery, heartbeat, checkpoint).
- Verify logs filter and severity badges render correctly.
- Confirm support bundle export shows success feedback.

## Telemetry and Support
- Perform key actions (start, stop, sync, export, test login) and verify local telemetry summary updates.
- Export support bundle and confirm incident payload includes:
  - `recoveryTimeline`
  - `supervisorTimeline`
  - `uiTelemetry`
