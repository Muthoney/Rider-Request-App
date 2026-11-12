# Rider Requests

Internal delivery coordination for requesters, dispatchers, managers and motorcycle riders. Names, phone numbers, emails and addresses in this repository are examples. No live accounts, passwords, keys or database records are included.

## Features

- **Accounts & security**: email/password sign-in, forced replacement of temporary passwords (72-hour expiry, minimum 12 characters), HttpOnly/SameSite session cookies, CSRF tokens plus strict `Origin` checks, login rate limiting, and administrator account management.
- **Requests**: ASAP or **scheduled pickups for future dates** (up to 180 days ahead, with quick picks; a *Schedule* button on every page that can create requests and a *Scheduled* tab), up to 5 pickups (each collected and photographed separately; the request is in transit once all are collected) and up to 12 ordered drop-offs, contacts per stop, item-handling flags and notes, and manual **WhatsApp message and map-pin import** that parses pickup, drop-offs, phones, pins and handling.
- **Dispatch board**: three distinct zones (waiting requests, available riders on shift, unavailable riders off shift), shown as tabs on phones. Drag-and-drop or tap to assign. Priority ordering puts urgent work first, then Triangle, then Finance; scheduled work is grouped under *Scheduled later*.
- **Rider self-accept**: riders on shift see waiting jobs their designation allows (the same priority rules dispatch uses) and accept them. Dispatchers, and administrators with a recorded override, can still assign anyone.
- **Priority rules**: Triangle and Finance work is reserved for designated riders, and designated riders are held while their reserved work waits. Substitutions need an acknowledged reason and are **recorded**.
- **Integrity**: server-enforced company isolation, request ownership, a rider identity that is fixed after collection, and optimistic version checks on every write. A stale write returns `409` with the latest copy.
- **Delivery records with proof**: at pickup the rider records who handed over (photo optional, D-note signature optional); at each delivered drop-off a photo and the recipient's on-screen D-note signature are required. Every record carries the phone's GPS position and time, checked against the stop's pin (*At the stop* / *Away from the pin*). Photos are downscaled on the phone before upload.
- **Password recovery**: *Forgot password?* sends a single-use link (30 minutes) by email (SMTP), falling back to WhatsApp and then Africa's Talking SMS at the account's mobile number.
- **Excel export**: activity, request history, requests, shift log and fuel tables download as `.xlsx`.
- **Shifts and overtime**: riders clock in and out (no duplicate clock-ins; a rider carrying items cannot clock themselves out). A configurable standard shift length; time beyond it is overtime. Riders request overtime and dispatch approves, or dispatch authorises overtime and the rider accepts. Shift reports show standard, approved and unapproved overtime, exportable to Excel.
- **Rider notifications**: when a rider is assigned, they get a WhatsApp message (WhatsApp Cloud API) at the mobile number on their account. If WhatsApp rejects it, or later reports it undelivered through the webhook, an SMS goes out instead (Africa's Talking). Every attempt is shown on the request and can be re-sent.
- **Live GPS tracking**: clocked-in riders share GPS. In the Android app a foreground service keeps sharing with the screen off and queues positions without signal. Dispatch sees every rider on a **Live map** coloured by status, with the stops and road routes of their active jobs and open emergencies. Request pages show the rider's position, the route through the remaining stops and an ETA (Google Routes with traffic, or an estimate).
- **Kenya-only places**: pins must be inside Kenya. Address search uses Google geocoding restricted to Kenya, or a built-in list of Kenyan landmarks, streets, areas and towns. Without a pin, the map places a stop from the landmark or street named in its address.
- **Fuel & quotes**: petrol and **electric motorcycles**. Each rider has a vehicle; quote = base fee + energy (km ÷ km/L × pump price, or km ÷ km/kWh × electricity price) + rider time, with a petrol-vs-electric comparison. Fuel use per rider comes from GPS tracks, and each delivered trip shows its cost. The pump price defaults to the EPRA Nairobi Super Petrol price (KES 226.96/L, 15 Oct – 14 Nov 2026) and managers update it monthly.
- **Runs and activity**: batched runs per rider and an append-only activity history for each request and the company.
- **Interface**: a responsive single-page app (phones, tablets, laptops, desktops) with light/dark themes, 44 px touch targets on touch screens, bottom-sheet dialogs on phones, real-time updates over Server-Sent Events, an in-app notification inbox, and an offline mode (service worker + on-device queue). Google Maps, or an illustrative map when no key is set.

- **Rider availability & standby**: Available, Assigned, On delivery, On break, Offline. Riders set Available / On break; Assigned and On delivery follow their jobs; Offline is clocked out. Dispatch sees counts, last location, last contact and last action, and riders silent past the standby timeout are flagged *Not responding*. Assigning a rider on break or at the active-job limit needs an authorised, recorded override.
- **Emergency & incident reporting**: a red SOS button on every rider screen: road accident, breakdown, medical, security or other, with photos, a video, GPS, time and the affected delivery. Dispatch gets it in the app and on the live map at once; accidents, medical and security reports are also texted to dispatch immediately. Reports made without signal are kept on the phone and sent automatically. Incidents are acknowledged and resolved with a recorded history.
- **Address changes during a delivery**: the requester or dispatch can change a pickup or drop-off while it is under way. The rider is told at once (SMS if the app cannot reach them), sees old and new addresses with the stop highlighted, and must confirm a significant change before recording that stop. Every change is kept with who, when, why and how far it moved.
- **Exact location details**: building, building/plot number, floor, apartment/office/suite, gate or entrance, landmark and directions for every stop, shown to riders and dispatch.
- **Communication**: one-tap calls to the rider (for the client), and to the recipient, pickup contact, requester and dispatch (for the rider). Numbers are shown only to people on an active delivery, and every call is logged in the request history.
- **Client ratings**: after delivery the requesting client rates the rider 1–5 stars overall, with optional professionalism, timeliness, communication and handling scores and a comment (one rating per delivery). Averages appear on the dispatch board; a *Rider performance* report combines ratings, deliveries, delivery time, failed drop-offs, incidents, hours and overtime.
- **Notifications with SMS fallback**: in-app first (live stream + inbox, and Android push when Firebase is configured). Critical notifications not seen within a set time, or for people the app can't reach, go by Africa's Talking SMS through a de-duplicated outbox with retries and delivery reports. Users choose critical-only, all, or no SMS.
- **Offline-first**: riders keep working without signal (jobs, collections, drop-offs with proof, address confirmations, incident reports, GPS). Every action has a unique idempotency key, so syncing never duplicates; conflicts are retried against the latest version or shown for review.
- **Android app**: `mobile/` (Capacitor) builds a debug APK, a signed release APK and a Play Store bundle (AAB). See [mobile/README.md](mobile/README.md).

| Role | Can |
|---|---|
| Requester | Create requests; edit or cancel their own before assignment; change an address during delivery; call and track the rider; rate the rider; see only their own |
| Rider | See assigned jobs, record collections and handovers (also offline), confirm address changes, report emergencies, set Available/On break, clock in/out, request or accept overtime |
| Dispatcher | Everything above for the whole company, plus assign riders, override rules with a reason, plan runs, switch riders on/off shift, live map, fuel report and fuel pricing |
| Manager | Read-only: sees everything a dispatcher sees but cannot change anything |
| Administrator | Everything, plus create, edit and deactivate accounts and issue temporary passwords |

## Requirements

Node.js 22.5+ (uses the built-in `node:sqlite`; Node 24 recommended). There are no npm dependencies. Docker is the simplest way to run with persistent storage.

## Run locally (no Docker)

```bash
npm run provision:sample
```

```bash
npm run dev
```

These scripts work the same in PowerShell, Command Prompt, macOS and Linux. Open http://127.0.0.1:3000. Temporary passwords are in `./data/bootstrap-credentials.json`, a private file that git ignores. Every account must replace its temporary password on first sign-in. `--sample` also adds demo requests, shifts and a run.

## Run from VS Code

Open the `rider-requests` folder in VS Code and press **F5**, or choose **Run and Debug → Rider Requests: run on localhost**. This creates the sample data if needed, starts the server on http://127.0.0.1:3000 and opens your browser. Breakpoints in `server/` work. Stop with **Shift+F5**. **Terminal → Run Task** also has *Start dev server* and *Run tests*.

## Run with Docker

```bash
docker build -f deploy/Dockerfile -t rider-requests:dev .
```

```bash
docker run -d --name rider-requests-dev -p 127.0.0.1:3000:3000 -e APP_ORIGIN=http://127.0.0.1:3000 -e COOKIE_SECURE=false -e TRUST_PROXY=0 -v rider-requests-dev-data:/data -v rider-requests-dev-backups:/backups rider-requests:dev
```

```bash
docker exec rider-requests-dev node --no-warnings server/provision.mjs
```

HTTP and non-Secure cookies are refused for anything except loopback origins. Production requires HTTPS. Provisioning is idempotent and never resets existing accounts. Change the example account definitions in `server/provision.mjs` before provisioning a real deployment.

## Tests

```bash
npm test
```

77 automated tests cover the original features plus availability, override rules, incidents with photo/video evidence, address changes and confirmation, GPS on proofs, ratings, contact privacy, shifts and overtime, the SMS outbox (retries, de-duplication, permanent failures, delivery reports, fallback timing), live events, idempotent offline replay, offline GPS upload and the service-worker precache. They use an in-memory database, synthetic accounts and fake providers, so no real messages are sent. See [docs/testing-report.md](docs/testing-report.md) for browser and Android device testing.

## Layout

- `dist/`: the browser app. `js/hosted.js` loads only the sign-in screens up front and imports operational views after authentication. `js/whatsapp.js` (message parser), `js/kenya.js` (Kenyan places and bounds) and `js/fuel.js` (quote maths) are shared with the server. `js/tracker.js` shares rider GPS, `js/gmaps.js` wraps Google Maps, `js/offline.js` + `sw.js` provide offline mode and sync, `js/realtime.js` the live event stream and inbox, `js/native.js` the Android bridge, `js/incident.js` the SOS report and `js/stops.js` location details.
- `server/`: HTTP API (`app.mjs`; v2 operations in `ops.mjs`), notifications and the SMS outbox (`notify.mjs`), live events (`realtime.mjs`), SQLite schema and migrations (`db.mjs`), business rules (`rules.mjs`), external providers (`integrations.mjs`: Google, WhatsApp, Africa's Talking), password security, provisioning and backups.
- `tests/`: HTTP integration and parser tests (`v2.test.mjs` covers the post-demo features).
- `mobile/`: the Android app (Capacitor) with a native background-GPS service; see [mobile/README.md](mobile/README.md).
- `docs/`: [architecture](docs/architecture.md), [configuration](docs/configuration.md), [request form review](docs/request-form-review.md), [testing report](docs/testing-report.md), [v2 implementation report](docs/implementation-report-v2.md).
- `deploy/`: Dockerfile, example Compose file, backup cron, operations notes and the launch checklist.
- `docs/`: design notes.

## Deploy

Copy `.env.example` to a private `.env` and set `APP_ORIGIN` to the exact HTTPS origin. Adapt `deploy/compose.example.yml` (it expects an external network `rider-requests-edge` shared with your reverse proxy) and keep the `rider-requests-data` and `rider-requests-backups` volumes across redeployments. Read [deploy/OPERATIONS.md](deploy/OPERATIONS.md) first. **No automatic deployment is configured in this repository.**

## Backups

```bash
docker exec rider-requests node --no-warnings server/backup.mjs
```

This takes a consistent snapshot (`VACUUM INTO`), runs an integrity check and keeps the 14 newest copies. Configure an off-server copy and rehearse a restore before relying on it.

## Integrations

Google Maps, WhatsApp and SMS are switched on by environment variables. See `.env.example` and [deploy/OPERATIONS.md](deploy/OPERATIONS.md). For local development, put keys in a private `.env.local` (git ignores it). Each one is optional and the app falls back without it: an illustrative map, the built-in Kenyan place list, straight-line distance estimates, and notifications recorded as *not sent*.

## Still to connect

WhatsApp OTP sign-in, Microsoft SSO, in-app chat, route optimisation, iOS app and off-server backups. Firebase push needs a Firebase project (see mobile/README.md). See [docs/implementation-report-v2.md](docs/implementation-report-v2.md#outstanding-limitations) and [deploy/remaining-work.txt](deploy/remaining-work.txt).
