# Architecture (v2)

```
 Riders (Android app / browser)      Requesters, dispatch, managers (browser, any device)
        │  HTTPS (any network)                     │  HTTPS
        ▼                                          ▼
 ┌──────────────────────────── Rider Requests server (Node 22) ───────────────────────────┐
 │  REST API (/api/…)   live events (SSE /api/events)   static app + service worker (dist/) │
 │  sessions · CSRF · Origin check · roles · company isolation · version checks             │
 │  ops.mjs: availability, incidents, address changes, ETA, ratings, shifts/overtime, …     │
 │  notify.mjs: inbox → push → SMS fallback (outbox, retries, de-dup, delivery reports)     │
 │  SQLite (WAL) — the single authoritative database for every dispatch site               │
 └───────────┬───────────────────────┬─────────────────────────┬───────────────────────────┘
             │                       │                         │
     Google Maps / Routes     Africa's Talking SMS     Firebase Cloud Messaging (optional)
```

There is **one** central, internet-reachable server and database. Browsers and the Android app are clients
of the same API with the same rules, so web and mobile can never disagree. Riders, dispatchers and requesters
can be in different towns on different networks; nothing assumes a shared Wi-Fi or LAN.

## Clients

- **Web app** (`dist/`): plain ES modules, no build step. `hosted.js` routes and renders views; `api.js` talks
  to the server; `ui.js`, `map.js`/`gmaps.js`, `stops.js` render.
- **Android app** (`mobile/`): Capacitor shell loading the hosted app (`server.url`), so it shares origin,
  cookies, CSRF and Origin checks with the browser. Native additions: `RiderTracker` foreground GPS service,
  local notifications, haptics, geolocation permission handling, optional FCM push.

## Real-time

`GET /api/events` is a Server-Sent Events stream per signed-in client (plain HTTPS, through proxies and mobile
networks, auto-reconnecting). After any successful change the server publishes a small event (`change`,
`request`, `riders`, `location`, `incident`, `shifts`, `notification`); views re-fetch what they show
(debounced). Events carry ids only; data still comes through the normal, permission-checked API. Polling
remains as a slow safety net.

## Notifications and SMS fallback

1. `notify()` writes an **inbox** row per recipient (unique `dedupe_key` → a repeat call does nothing),
   pushes it on the live stream, and to FCM tokens when configured.
2. SMS (Africa's Talking) is queued in **`sms_outbox`** when:
   - the recipient has no live connection and the event is critical (or they chose "all updates");
   - a critical item is still unseen after `sms_fallback_seconds` (push failed / phone asleep);
   - it is an emergency (accident, medical, security): texted to dispatch **immediately**.
3. A worker (every 5 s) sends due SMS, retries temporary failures with backoff (30 s → 1 h, 6 attempts),
   marks permanent ones failed (invalid number, blacklist, DND, bad sender ID), and recovers rows left
   "sending" by a crash. Delivery reports (`/api/webhooks/sms?token=…`) mark messages delivered/failed.
4. Per-user preference: `critical` (default), `all`, `off` (emergencies to dispatch ignore `off`).

SMS needs cellular coverage on the recipient's phone and a reachable gateway from the server. While the
gateway is unreachable, messages stay queued.

## Offline-first and synchronisation

| Layer | What it does |
|---|---|
| Service worker (`sw.js`) | Precaches the app shell; network-first with a 2.5 s timeout, then cache. Never caches `/api`. |
| Read cache (`offline.js`, IndexedDB `cache`) | Last copy of jobs, requests, shift, settings per user; shown when offline (marked `__offline`). |
| Outbox (IndexedDB `outbox`) | Actions taken offline, replayed in order on reconnect. Each has a UUID sent as `Idempotency-Key`. |
| Blobs (IndexedDB `blobs`) | Incident videos waiting to upload. |
| GPS buffer | Browser: IndexedDB `gps`; Android: `TrackerService` queue file. Uploaded via `POST /api/location/batch`. |

**No duplicates:** the server stores the response of every successful mutating call with an
`Idempotency-Key` (`idempotency` table, kept 7 days) and replays it for the same key; incidents and media also
de-duplicate on a client id. A lost response followed by a retry therefore never runs twice.

**Conflicts:** if a queued action meets a newer version of the request (someone else changed it meanwhile),
the client re-reads it and retries once with the current version. The server still enforces every business
rule (e.g. a stop already delivered, a changed address the rider has not confirmed). Anything still refused is
kept as *needs attention* for the rider to retry or discard. Nothing is silently dropped.

**Optimistic view:** while actions wait, the rider sees their own progress (stops marked *To sync*), so they can
carry on (e.g. hand over after an offline collection).

**Limits:** live tracking, live updates and messages need some connectivity. Offline mode preserves work and
syncs it later; it cannot make other people see updates while the phone has no connection. GPS points are
accepted up to 24 h late and only for time the rider was clocked in.

## Security model (unchanged foundations, extended)

- Sessions: HttpOnly, Secure, SameSite=Strict cookie; CSRF token header; strict `Origin` check on writes.
- Roles and company isolation on every query; managers read-only.
- Contact numbers by role: riders see stop/requester numbers only for their active jobs; requesters see the
  rider's number only while the delivery is active; staff see all. Every call made from the app is logged.
- Ratings: only the requesting client, once per delivered request.
- Media: proof photos, incident photos and videos are served only to users who can see the request/incident.
- Keys: all provider keys are server environment variables. The Maps **browser** key is the only one sent to
  browsers and must be referrer-restricted; the server key (Geocoding/Routes), Africa's Talking, WhatsApp and
  FCM credentials never leave the server.
- Android: HTTPS-only release builds, app data excluded from backups, foreground service only while clocked in.

## Data model additions (v2, migrated automatically on start)

New tables: `ops_settings`, `incidents`, `incident_media`, `location_changes`, `ratings`, `overtime`,
`contact_log`, `inbox`, `sms_outbox`, `idempotency`, `push_tokens`.
New columns: `users.break_since`, `users.last_seen_at`, `users.sms_pref`; `requests.pickup_details`,
`pickups.details`, `dropoffs.details`; `records.lat/lng/accuracy/client_recorded_at`;
`shifts.planned_minutes/overtime_minutes/approved_overtime_minutes`.
Migrations are additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` when missing), so existing
databases upgrade in place without data loss. Back up before deploying anyway (`npm run backup`).

## Rider availability

`availability` is derived, never stored stale: Offline (clocked out) → On break (`break_since`) → On delivery
(any job collected) → Assigned (any job assigned) → Available. `unresponsive` = clocked in but no contact
for `standby_timeout_min`. Assignment needs a recorded override when the rider is on break or at
`max_active_jobs`; clocked-out riders get a warning only (scheduled work).
