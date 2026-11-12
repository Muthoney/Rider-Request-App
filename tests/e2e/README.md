# End-to-end tests (manual)

Not part of `npm test` (they need Chrome / an Android emulator). They install `puppeteer-core` into a
temporary folder; the project itself keeps no dependencies.

- `run-browser.sh` — every role and main page at 360 px and 1280 px (no JS errors, nothing cut off at the
  right edge), plus an offline → sync cycle that must create exactly one handover and one incident.
- `device.mjs` — Android app on an emulator (debug APK built for `http://localhost:3111`, server started with
  `APP_ORIGIN=http://localhost:3111` and the sample data from `setup.mjs`, `adb reverse tcp:3111 tcp:3111`,
  app launched). Usage: `node device.mjs <path-to-sqlite> <screenshot-dir>`. Checks the native GPS service,
  screen-off tracking, airplane mode + offline queueing, offline cold start, and exactly-once sync.
