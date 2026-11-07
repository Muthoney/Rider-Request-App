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
