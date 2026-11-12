# Testing report (v2, 13 Nov 2026)

## 1. Automated server tests — `npm test`

**77 / 77 pass** (60 existing + 17 new in `tests/v2.test.mjs`). In-memory database, synthetic accounts.
Africa's Talking is exercised through its real client code with a fake HTTP layer (request format, API key,
sender ID, sandbox host, error codes).

| Area | Covered |
|---|---|
| Availability | offline → available → assigned → on delivery → available; break blocked with active jobs; last seen; dispatch summary counts |
| Assignment rules | on-break rider needs recorded override; active-job limit blocks third job and self-accept; clocked-out rider → warning only |
| Incidents | create with photo; idempotent replay by client id; immediate SMS to admin + dispatcher with map link; video upload (type sniffed), bad bytes refused; HTTP range requests for video; other riders/requesters denied; acknowledge (rider notified) and resolve; history |
| Address changes | requester changes a drop-off while in transit; riders and other clients refused; rider notified (critical); handover blocked until confirmed; history with from/to/by/distance; finished stops locked; edit form also records changes |
| Proof | pickup photo optional; drop-off photo and signature still required; GPS stored and verified against the pin |
| Ratings | only the requesting client, only after delivery, 1–5 validation, once only; dispatch cannot rate; rider sees score not comment; averages and report |
| Contact privacy | no numbers for open-job browsing; assigned rider sees recipient & requester numbers; client sees rider number while active; all hidden after delivery; calls logged; permission checks |
| Shifts & overtime | double clock-in is a no-op; clock-out refused while carrying items; overtime limits, one pending at a time, approval rules both ways; states at 8.5 h and 9.5 h; shift-over notice; report minutes/overtime/approved |
| SMS outbox | de-duplication; gateway down → queued with backoff → sent after retry; delivery report webhook (token checked); InvalidPhoneNumber final; InsufficientBalance retried; user preference *off* |
| Live events | SSE stream opens, notification delivered live; SMS only after the fallback delay and only if unseen |
| Offline sync | Idempotency-Key replay returns the same result without duplicating; key reuse for another action → 422; offline GPS batch accepts in-shift Kenyan points only |
| Static | service worker precache lists exactly the files in `dist/`; CSP allows the worker and media |

## 2. Browser end-to-end (headless Chrome, sample data)

Every role, every main page, at **360 px (phone)** and **1280 px (desktop)**: dashboard, dispatch board, live
map, incidents, rider performance, shifts, requests, request detail, settings, accounts, fuel, request form,
rider jobs, rider shift, rider incidents. Checks: no JavaScript errors, no server errors, no page-level sideways
scrolling, and no content cut off at the right edge (outside deliberate scroll areas such as tables).
**Result: pass**, after fixing the layout problems the check found (stop rows, rider job buttons, live-map
rider list).

Offline cycle in the browser: go offline → offline indicator → hand over a drop-off and file an incident →
"waiting to sync" markers → back online → **exactly one** handover and **one** incident on the server, queue empty.

## 3. Android device testing (emulator, Android 15 / API 35, Pixel 6 profile)

Debug APK against a local server, driven through WebView DevTools and adb. **15 / 15 checks pass:**

- App runs with the Capacitor bridge and the `RiderTracker` plugin; service worker active in the WebView.
- Clocking in starts the foreground location service; GPS reaches the server.
- **Screen off**: positions keep arriving (8 in ~35 s).
- **Airplane mode with the server unreachable**: GPS is queued on the phone; a handover with photo/signature and
  an incident report are saved offline.
- **Cold start with no network** (app killed and reopened): opens on the saved jobs with the offline banner;
  queued actions survive the restart. The first measurement showed 15–20 s to open because module requests
  hung about 12 s; fixed with a 2.5 s network timeout in the service worker (now about 5 s on this emulator).
- **Back online**: handover synced exactly once, incident synced exactly once, queued GPS uploaded, native
  queue empty.
- SOS dialog renders on the phone.
- **Release APK** installs (versionCode 200, minSdk 24, targetSdk 36); with the production server not yet live
  it shows the bundled *Can't reach the server* page instead of a blank screen.

## Not yet tested — needs real devices / live services

- Physical phones, especially Android 7–11 and battery-aggressive brands (Tecno, Infinix, Xiaomi, Samsung).
  Only one emulator profile (Android 15) was run; disk space on the build machine did not allow more images.
- Tablets (layout was checked in the browser at phone and desktop widths only; tablet widths sit between the
  two tested breakpoints).
- Slow 2G/3G and flapping connections on real networks (simulated: fully offline and fully online).
- Camera capture of photos/video on a physical device (emulator uses a virtual camera; uploads were tested
  with generated files).
- Live Google Maps, Routes, Africa's Talking, WhatsApp and Firebase with real keys (all tested with fakes or
  their fallbacks). Before go-live: send a sandbox SMS, check the delivery-report callback, and open the
  live map with the real browser key.
- iOS (not built; see `mobile/README.md`).
- A dedicated security test (penetration test). Role, ownership, CSRF/Origin, contact privacy and media access
  rules are covered by the automated tests above.

## How to re-run

```bash
npm test                                   # server
cd mobile && ./build.sh debug http://localhost:3000   # app for an emulator (adb reverse tcp:3000 tcp:3000)
```
