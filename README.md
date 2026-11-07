# Rider Requests

Internal delivery coordination for requesters, dispatchers, managers and motorcycle riders. Names, phone numbers, emails and addresses in this repository are examples. No live accounts, passwords, keys or database records are included.

## Features

- **Accounts & security**: email/password sign-in, forced replacement of temporary passwords (72-hour expiry, minimum 12 characters), HttpOnly/SameSite session cookies, CSRF tokens plus strict `Origin` checks, login rate limiting, and administrator account management.
- **Requests**: ASAP or scheduled pickups, up to 12 ordered drop-offs, contacts per stop, item-handling flags and notes, and manual **WhatsApp message and map-pin import** that parses pickup, drop-offs, phones, pins and handling.
- **Dispatch board**: drag-and-drop assignment to rider lanes, shift status and rider load. Priority ordering puts urgent work first, then Triangle, then Finance.
- **Priority rules**: Triangle and Finance work is reserved for designated riders, and designated riders are held while their reserved work waits. Substitutions need an acknowledged reason and are **recorded**.
- **Integrity**: server-enforced company isolation, request ownership, a rider identity that is fixed after collection, and optimistic version checks on every write. A stale write returns `409` with the latest copy.
- **Delivery records**: the assigned rider records the collection and a handover per drop-off (delivered or failed with a reason). GPS verification of handovers is explicitly marked *not connected*.
- **Shifts**: one on/off switch per rider (riders can switch themselves). Switching off adds the shift to the shift log.
- **Rider notifications**: when a rider is assigned, they get a WhatsApp message (WhatsApp Cloud API) at the mobile number on their account. If WhatsApp rejects it, or later reports it undelivered through the webhook, an SMS goes out instead (Africa's Talking). Every attempt is shown on the request and can be re-sent.
- **Live GPS tracking**: riders on shift share their phone's GPS position from the app. Dispatch sees everyone on a **Live map** (Google Maps, restricted to Kenya), and request pages show the rider's live position and track.
- **Kenya-only places**: pins must be inside Kenya. Address search uses Google geocoding restricted to Kenya, or a built-in list of Kenyan landmarks, streets, areas and towns. Without a pin, the map places a stop from the landmark or street named in its address.
- **Fuel & quotes**: quote = base fee + fuel (distance ÷ km/L × current pump price) + rider time. Fuel use per rider comes from GPS tracks, and each delivered trip shows its cost. The pump price defaults to the EPRA Nairobi Super Petrol price (KES 226.96/L, 15 Oct – 14 Nov 2026) and managers update it monthly.
- **Runs and activity**: batched runs per rider and an append-only activity history for each request and the company.
- **Interface**: a responsive single-page app with light/dark themes, a mobile rider view, Google Maps (or an illustrative map when no key is set), and a dashboard with a 7-day chart.

| Role | Can |
|---|---|
| Requester | Create requests; edit or cancel their own before assignment; see only their own |
| Rider | See assigned jobs, record collections and handovers, start/finish their runs, switch own shift on/off (shares live GPS while on) |
| Dispatcher / Manager | Everything above for the whole company, plus assign riders, override rules with a reason, plan runs, switch riders on/off shift, live map, fuel report. Managers set fuel pricing |
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

48 tests cover authentication, temporary-password replacement and expiry, CSRF/origin protection, roles and company isolation, reserved work and recorded overrides, stale updates, delivery progress and the fixed rider, runs, the shift switch, WhatsApp/SMS notifications and the webhook fallback, live GPS, Kenya-only pins and places, fuel quotes and tracking, static-file safety and WhatsApp parsing. The tests use an in-memory database, synthetic accounts and fake providers, so no real messages are sent.

## Layout

- `dist/`: the browser app. `js/hosted.js` loads only the sign-in screens up front and imports operational views after authentication. `js/whatsapp.js` (message parser), `js/kenya.js` (Kenyan places and bounds) and `js/fuel.js` (quote maths) are shared with the server. `js/tracker.js` shares rider GPS, and `js/gmaps.js` wraps Google Maps.
- `server/`: HTTP API (`app.mjs`), SQLite schema and migrations (`db.mjs`), business rules (`rules.mjs`), external providers (`integrations.mjs`: Google, WhatsApp, Africa's Talking), password security, provisioning and backups.
- `tests/`: HTTP integration and parser tests.
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

WhatsApp OTP sign-in, Microsoft SSO, background GPS on Android (browsers pause location when the app is in the background), GPS-based handover validation, email recovery and off-server backups. See [deploy/remaining-work.txt](deploy/remaining-work.txt).
