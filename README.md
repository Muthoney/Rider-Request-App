# Rider Requests

Internal delivery coordination for requesters, dispatchers, managers and motorcycle riders. Names, phone numbers, emails and addresses in this repository are examples. No live accounts, passwords, keys or database records are included.

## Features

- **Accounts & security**: email/password sign-in, forced replacement of temporary passwords (72-hour expiry, minimum 12 characters), HttpOnly/SameSite session cookies, CSRF tokens plus strict `Origin` checks, login rate limiting, and administrator account management.
- **Requests**: ASAP or scheduled pickups, up to 12 ordered drop-offs, contacts per stop, item-handling flags and notes, and manual **WhatsApp message and map-pin import** that parses pickup, drop-offs, phones, pins and handling.
- **Dispatch board**: drag-and-drop assignment to rider lanes, shift status and rider load. Priority ordering puts urgent work first, then Triangle, then Finance.
- **Priority rules**: Triangle and Finance work is reserved for designated riders, and designated riders are held while their reserved work waits. Substitutions need an acknowledged reason and are **recorded**.
- **Integrity**: server-enforced company isolation, request ownership, a rider identity that is fixed after collection, and optimistic version checks on every write. A stale write returns `409` with the latest copy.
- **Delivery records**: the assigned rider records the collection and a handover per drop-off (delivered or failed with a reason). GPS verification is explicitly marked *not connected*.
- **Runs, shifts and activity**: batched runs per rider, a weekly shift planner, and an append-only activity history for each request and the company.
- **Interface**: a responsive single-page app with light/dark themes, a mobile rider view, an illustrative route map (clearly labelled *not live GPS*), and a dashboard with a 7-day chart.

| Role | Can |
|---|---|
| Requester | Create requests; edit or cancel their own before assignment; see only their own |
| Rider | See assigned jobs, record collections and handovers, start/finish their runs, view own shifts |
| Dispatcher / Manager | Everything above for the whole company, plus assign riders, override rules with a reason, plan runs and shifts |
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

30 tests cover authentication, temporary-password replacement and expiry, CSRF/origin protection, roles and company isolation, reserved work and recorded overrides, stale updates, delivery progress and the fixed rider, runs, shifts, static-file safety and WhatsApp parsing. The tests use an in-memory database and synthetic accounts.

## Layout

- `dist/`: the browser app. `js/hosted.js` loads only the sign-in screens up front and imports operational views after authentication. `js/whatsapp.js` is the parser shared with the server.
- `server/`: HTTP API (`app.mjs`), SQLite schema (`db.mjs`), business rules (`rules.mjs`), password security, provisioning and backups.
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

## Still to connect

WhatsApp Business notifications and OTP, SMS fallback, Microsoft SSO, rider background tracking and live positions, GPS-based handover validation, address search and routing, email recovery and off-server backups. See [deploy/remaining-work.txt](deploy/remaining-work.txt). The map is illustrative, not live GPS.
