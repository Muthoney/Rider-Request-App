# Operations notes

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `APP_ORIGIN` | yes | Exact origin users open, e.g. `https://riders.example.com`. Mutating requests from any other `Origin` are refused. |
| `COOKIE_SECURE` | no (default `true`) | `false` is accepted only for `http://127.0.0.1` / `localhost` development. |
| `TRUST_PROXY` | no | `1` to read the client IP from `X-Forwarded-For` (for login rate limiting) when behind your reverse proxy. |
| `DATA_DIR` / `DB_FILE` | no | Database location (default `/data/rider-requests.sqlite`). |
| `BACKUP_DIR`, `BACKUP_KEEP` | no | Backup location (default `/backups`) and retention (default 14). |
| `LOG_REQUESTS` | no | `1` logs one line per API call. |
| `GOOGLE_MAPS_BROWSER_KEY` | no | Maps JavaScript API key for the live map and request maps. Restrict it to your `APP_ORIGIN` (HTTP referrer). |
| `GOOGLE_MAPS_MAP_ID` | no | Map ID for vector maps / advanced markers. Without it, classic markers are used. |
| `GOOGLE_MAPS_SERVER_KEY` | no | Server key for the Geocoding API (address search, `components=country:KE`) and the Routes API (road distance for quotes). Restrict it to the server IP. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | no | WhatsApp Cloud API credentials for rider job notifications. |
| `WHATSAPP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANG` | recommended | Approved template name and language (default `en`). Without a template, plain text is sent, which WhatsApp only delivers within 24 hours of the rider last messaging the business number. |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | for fallback | Webhook verification token and Meta app secret (used to check `X-Hub-Signature-256`). |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | no | Africa's Talking SMS fallback. Use `AT_USERNAME=sandbox` for testing. |

## Rider notifications

When a dispatcher assigns a rider, the server sends a WhatsApp message to the rider's account phone number (Kenyan numbers like `0712…` are normalised to `+254712…`). If WhatsApp is not configured or rejects the message, an SMS is sent. If WhatsApp accepts the message but later reports it as failed through the webhook, the SMS is sent then. Every attempt appears on the request under *Rider notifications*. Staff can **Resend** from there.

WhatsApp template (category *Utility*). Create it in WhatsApp Manager with exactly five body variables, for example:

```
New delivery {{1}}: {{2}}
Pickup: {{3}}
Drop-off: {{4}}
Open the job: {{5}}
```

Webhook: in the Meta app, set the callback URL to `https://<your domain>/api/webhooks/whatsapp`, set the verify token to `WHATSAPP_VERIFY_TOKEN`, and subscribe to the `messages` field. Unsigned or wrongly signed webhook calls are refused.

## Live GPS

Riders share their position from the browser while they are **on shift**: at most every 15 seconds, or sooner after moving 30 m. Positions outside Kenya are refused, and switching off shift stops sharing and removes the rider from the live map. Phones pause browser GPS when the app is in the background or the screen is locked, so riders should keep the app open while riding. Track points are kept for 90 days.

## Fuel pricing

Kenyan pump prices are set by EPRA on the 14th of each month. A manager or administrator updates **Fuel & quotes → Pricing** after each review. The page warns when the stored price predates the latest review. Quotes are calculated as base fee + fuel (km ÷ km/L × price) + rider time, rounded up to the next KES 10.

## Reverse proxy

Route your HTTPS host to `rider-requests:3000` on the shared Docker network. Pass `X-Forwarded-For`. Validate the complete proxy configuration (for example `nginx -t` or `caddy validate`) before you reload it, and leave unrelated sites, DNS and email records, and databases untouched.

## First deployment

1. Edit the example accounts in `server/provision.mjs` to real people.
2. Start the container, then run `docker exec rider-requests node --no-warnings server/provision.mjs`.
3. Copy `/data/bootstrap-credentials.json` out privately, hand each person their temporary password through a private channel, then delete the file: `docker exec rider-requests rm /data/bootstrap-credentials.json`.

## Redeploying

Back up first (`server/backup.mjs`), build the new image, and replace only the application container. Keep both volumes. The app checks `/healthz`. If the new container is not healthy, start the previous image again.

## Restore

Stop the container, copy a backup over `/data/rider-requests.sqlite`, delete any `-wal`/`-shm` files beside it, and start the container again. Rehearse this before go-live.

## Account recovery

There is no email recovery yet. An administrator opens **Manage accounts → key icon** to issue a temporary password. This signs the person out of every session.
