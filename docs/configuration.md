# Configuration and API keys

All secrets are environment variables on the server (`.env`, never committed). See `.env.example`.

## Required

| Variable | Example | Notes |
|---|---|---|
| `APP_ORIGIN` | `https://ride-request.lookmedia.co.ke` | Exact HTTPS origin users and the Android app open. |
| `COOKIE_SECURE` | `true` | `false` only for loopback development. |
| `TRUST_PROXY` | `1` | Behind a reverse proxy, to read the client IP. |

## Google Maps (live map, routes, ETA, Kenya address search)

Create two keys in Google Cloud (billing must be enabled):

| Variable | Restrict to | APIs |
|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | HTTP referrer `https://<APP_ORIGIN>/*` | Maps JavaScript API, Directions API |
| `GOOGLE_MAPS_SERVER_KEY` | Server IP address | Geocoding API, Routes API |
| `GOOGLE_MAPS_MAP_ID` (optional) | — | Vector map / advanced markers |

The browser key is visible to users by design (that is how Google Maps works), which is why it must be
referrer-restricted. Set a daily quota and a budget alert. Without keys the app uses an illustrative map, the
built-in Kenyan place list and straight-line estimates.

## Africa's Talking (SMS fallback)

| Variable | Notes |
|---|---|
| `AT_USERNAME`, `AT_API_KEY` | `sandbox` + sandbox key for testing. |
| `AT_SENDER_ID` | Registered alphanumeric sender ID (optional but recommended). |
| `AT_CALLBACK_TOKEN` | Long random string. In the AT dashboard set the delivery-report URL to `https://<APP_ORIGIN>/api/webhooks/sms?token=<AT_CALLBACK_TOKEN>`. |

Keep the account funded: *InsufficientBalance* is retried for about an hour, then marked failed.

## Firebase push (optional)

`FCM_SERVICE_ACCOUNT`: service-account JSON (or its base64). Plus `google-services.json` in `mobile/` for the
app build. See `mobile/README.md`.

## Operations settings (in the app)

*Settings → Operations* (administrators):

| Setting | Default | Meaning |
|---|---|---|
| Active jobs per rider | 2 | More needs an authorised override. Raise it if riders routinely carry batched runs. |
| Standby timeout | 15 min | Clocked-in riders with no contact for this long show as *Not responding*. |
| Longest break | 60 min | Dispatch is told when a break runs longer. |
| Standard shift | 8 h | Time beyond it is overtime. |
| Most overtime per shift | 4 h | Upper limit for requests/offers. |
| SMS fallback after | 90 s | Unseen critical notifications are texted after this. |
| Dispatch phone | — | Shown to riders and requesters on active deliveries and on the SOS screen. |
| Text recipients | off | SMS each recipient when their delivery is on the way (costs one SMS per drop-off). |

## Other existing variables

WhatsApp (`WHATSAPP_*`), SMTP (`SMTP_*`), `DATA_DIR`, `BACKUP_DIR`, `PORT`, `HOST`, `LOG_REQUESTS`: unchanged; see
`.env.example` and `deploy/OPERATIONS.md`.
