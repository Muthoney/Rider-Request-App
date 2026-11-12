# Implementation report — v2 (MVP feedback, mobile, offline)

Date: 13 Nov 2026. Related: [architecture](architecture.md) · [configuration](configuration.md) ·
[testing report](testing-report.md) · [request form review](request-form-review.md) · [Android app](../mobile/README.md).

## Phase 1 — Audit and rollback of the previous APK

The previous APK work (uncommitted) was a hand-built WebView shell: `android/` (Java activity, build script,
signing key with a weak default password), `dist/rider-requests.apk`, a download link on the sign-in page,
`.apk` download headers in the server, and a relaxed cookie rule allowing plain HTTP on private LAN addresses
(the "same Wi-Fi" workaround). All of it was reverted. `android/` and the old APK were **moved, not deleted**, to
`../Rider-Request-App-apk-v1-archive/`, because its keystore is the only key that can update phones that
installed v1. Other uncommitted work (multiple pickups, integrations panel) was kept. Verified: 60/60 tests and
the server started; the APK URL then returned 404.

## Feature summary

| # | Feature | Status | What changed | Tested by |
|---|---|---|---|---|
| A | Rider availability & standby (Brian) | Done | Five statuses; rider sets Available/On break; derived Assigned/On delivery/Offline; standby timeout → *Not responding*; break limit; job limit with recorded override; dispatch counts, last location/contact/action; configurable in Settings → Operations | v2 tests (availability, override, limit), browser smoke |
| B1 | Emergency / incident reporting | Done | SOS button on every rider screen; 5 types; photos (4), video (≤30 MB), GPS, time, delivery link; immediate SMS to dispatch for accident/medical/security; Incidents page, live-map markers, history; works offline | v2 incident test, device test (offline incident synced once) |
| B2 | Pickup/drop-off changes during delivery | Done | Change-address dialog for requester/dispatch; rider notified at once (SMS fallback); old vs new shown, stop highlighted; significant changes must be confirmed before recording the stop; full history; route and ETA follow the new address | v2 location-change tests |
| B3 | Proof modification | Done | Pickup photo optional; drop-off photo + signature still required; GPS and phone time on every proof record, verified against the pin | updated existing test, v2 GPS test |
| B4 | Client ratings | Done | 1–5 stars + 4 criteria + comment; requester only, once, after delivery; averages on board; Rider performance report + Excel | v2 rating test |
| B5 | Exact location details | Done | Building, no., floor, unit, gate, landmark, directions per stop; shown to riders and dispatch | v2 tests, browser smoke |
| B6 | Communication | Done (calls); chat is a future extension | One-tap calls by role; numbers shown only on active deliveries; call history in the request log; dispatch phone setting | v2 privacy test |
| B7 | Shifts & overtime | Done | Clock in/out (no duplicates, no self clock-out while carrying); standard shift; overtime request/offer + approval; shift-over notice; reports + Excel | v2 overtime test |
| C | Requester form simplification | Done as proposal for Kokeb | Fields reorganised, nothing removed; see [request-form-review.md](request-form-review.md) | browser smoke |
| 3 | Mobile responsiveness | Done | Touch targets, phone dialogs, 16 px inputs, layout fixes; automated "nothing cut off" check | browser smoke at 360/1280 px |
| 4 | Google Maps live tracking | Done (needs real key to see Google tiles) | Status-coloured riders, all active stops, road routes (Directions), emergencies, rider selection, ETA (Routes API or estimate), navigation links; request page route from the rider's live position | browser smoke (fallback map); ETA code tested against the fallback |
| 5 | Africa's Talking SMS fallback | Done (needs account) | Reusable notifier, templates, outbox with retries/backoff/de-dup, permanent-error handling, delivery reports, preferences, fallback timing, emergency escalation | v2 SMS tests through the real AT client |
| 6 | Offline-first & sync | Done | Service worker, IndexedDB cache/outbox/blobs/GPS, idempotency keys, version-conflict retry, review queue, offline GPS batches | v2 tests, browser offline cycle, device offline tests |
| 7 | Fresh Android app | Done | Capacitor 8, native foreground GPS service, debug APK, signed release APK, AAB | emulator: 15/15 device checks; release APK installs |
| 8 | Docs & testing | Done | This report, architecture, configuration, testing report, mobile README, form review | — |

## Mobile framework decision

**Capacitor**, loading the hosted app. The existing web app is plain ES modules with no build step and
already has the mobile UI, so packaging it reuses all of it. React Native or Flutter would mean rewriting every
screen and keeping two codebases in step. Loading the server URL (rather than bundling a copy) keeps one origin,
so the existing secure cookies, CSRF and Origin protections work unchanged and every client always runs the
same code as the server. Native code was added only where the WebView falls short: a foreground location
service that posts GPS itself (reliable with the screen off), alerts and permissions. A ready-made community
background-GPS plugin was rejected: it is old (Capacitor 3 era) and relies on JavaScript callbacks that
Android may pause.

**AAB:** generated (`mobile/dist/rider-requests-2.0.0.aab`), because Google Play requires bundles for new apps.
Use the APK for side-loading and internal testing.

## Deliverables

- Web app + API changes: `dist/`, `server/` (new `ops.mjs`, `notify.mjs`, `realtime.mjs`).
- Database migrations: additive, automatic on start (`server/db.mjs`).
- Android: `mobile/` project; `mobile/dist/rider-requests-2.0.0-debug.apk`, `rider-requests-2.0.0.apk`
  (signed), `rider-requests-2.0.0.aab` (signed). All built for `https://ride-request.lookmedia.co.ke`.
- Release signing key: `~/.config/rider-requests/` (outside the repository). **Back it up.**
- Tests: `tests/v2.test.mjs` (in `npm test`), `tests/e2e/` (browser + device harnesses).

## Deployment checklist

1. Back up the database (`npm run backup`), deploy the server, restart. Migrations run automatically.
2. Proxy: no buffering for `/api/events`; uploads ≥ 32 MB ([OPERATIONS](../deploy/OPERATIONS.md)).
3. Set Google Maps keys (Directions API on the browser key), Africa's Talking + `AT_CALLBACK_TOKEN`, and
   optionally `FCM_SERVICE_ACCOUNT` ([configuration](configuration.md)).
4. Settings → Operations: dispatch phone, job limit (raise above 2 if riders carry batched runs), shift length.
5. Make sure `https://ride-request.lookmedia.co.ke` is live (the release APK points there), then install the
   APK on a few riders' phones and run a delivery end to end, including airplane mode.

## Outstanding limitations

- **Server not yet deployed** at the APK's URL; the release APK shows its offline page until it is.
- **Not tested on physical phones** or tablets; one Android 15 emulator profile only (see the testing report).
- **External services untested live**: Google Maps/Routes/Directions, Africa's Talking, WhatsApp, Firebase were
  tested with fakes or fallbacks.
- **Push notifications** need a Firebase project (`google-services.json` + `FCM_SERVICE_ACCOUNT`). Until then,
  background alerts come from the running app or by SMS.
- **In-app messaging/chat** not built (phone calls and call history are); suggested as a next step.
- **iOS** not built. The web app works in Safari, but iOS pauses background GPS. A native iOS build needs a
  Mac, Xcode and an Apple developer account.
- **Request form**: final field choices await Kokeb's review (marked ❓ in the review).
- **First sign-in needs a connection** on each phone; offline mode starts after that. Sessions last 12 hours, so
  a rider offline longer than that must sign in again before queued work can sync (it stays on the phone).
- **Default job limit (2)** is a guess; tune it with dispatch. Older tests that stack jobs on one rider set the
  limit high on purpose.
- Off-server backups, WhatsApp OTP and Microsoft SSO remain on the earlier roadmap.
