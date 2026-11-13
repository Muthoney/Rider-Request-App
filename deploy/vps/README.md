# Deploying to a Hostinger VPS

One Ubuntu 24.04 VPS runs two containers: the app and Caddy (automatic HTTPS). The database lives in the
Docker volume `rider-requests-data`; backups go to `/opt/rider-requests/backups` every night at 02:17.

## 1. Buy and prepare the VPS (Hostinger panel)

1. Buy a VPS: **KVM 1 or KVM 2**, OS **Ubuntu 24.04** (plain, no control panel), any EU location. Prefer a yearly plan with auto-renew.
2. During setup, add this SSH public key (or later under *VPS → Settings → SSH keys*):
   `cat ~/.ssh/lookmedia_vps.pub`
3. Note the server's **IPv4 address**.

## 2. Point the domain at it (Hostinger → Domains → lookmedia.co.ke → DNS)

Add an **A** record: name `ride-request`, value `<server IPv4>`, TTL 300. Don't change any other records
(the website and email depend on them). Check with `dig +short ride-request.lookmedia.co.ke`.

## 3. Set up the server (once)

```bash
cp deploy/vps/target.env.example deploy/vps/target.env     # put the IP in DEPLOY_HOST
ssh -i ~/.ssh/lookmedia_vps root@<server-ip> 'bash -s' < deploy/vps/server-setup.sh
```

## 4. Deploy (first time and every update)

```bash
deploy/vps/deploy.sh
```

This deploys the **last commit**: it runs the tests, uploads the code, backs up the database, builds the image,
switches over, waits for `/healthz` and rolls back automatically if the new version is unhealthy.

## 5. Create the real accounts (once)

```bash
cp deploy/vps/accounts.example.json accounts.json          # git-ignored; fill in real people
ssh -i ~/.ssh/lookmedia_vps deploy@<server-ip> \
  'docker exec -i rider-requests node --no-warnings server/provision.mjs --accounts -' < accounts.json
ssh -i ~/.ssh/lookmedia_vps deploy@<server-ip> \
  'docker exec rider-requests cat /data/bootstrap-credentials.json && docker exec rider-requests rm /data/bootstrap-credentials.json'
```

Hand each person their temporary password privately (valid 72 hours; they must change it on first sign-in).
Re-running provisioning only adds new people and never resets existing accounts. Later accounts can be
created in the app under **Manage accounts**.

## 6. API keys (when you have them)

```bash
ssh -i ~/.ssh/lookmedia_vps deploy@<server-ip>
nano /opt/rider-requests/app.env      # Google Maps, Africa's Talking, WhatsApp, SMTP…
cd /opt/rider-requests && docker compose up -d     # restarts the app with the new keys
```

Each key is optional; see `.env.example` and `deploy/OPERATIONS.md`.

## Everyday operations

| Task | Command |
|---|---|
| Copy backups to this computer | `deploy/vps/pull-backups.sh` (do this weekly) |
| Logs | `ssh … deploy@<ip> 'docker logs --tail 100 rider-requests'` |
| Manual backup | `ssh … deploy@<ip> 'docker exec rider-requests node --no-warnings server/backup.mjs'` |
| Restart | `ssh … deploy@<ip> 'cd /opt/rider-requests && docker compose restart app'` |
| Roll back | edit `APP_TAG` in `/opt/rider-requests/.env` to an older tag (`docker images rider-requests`), then `docker compose up -d` |

**Restore a backup:** `docker compose stop app`, then copy the backup into the volume:
`docker run --rm -v rider-requests-data:/data -v /opt/rider-requests/backups:/b alpine sh -c 'cp /b/<file>.sqlite /data/rider-requests.sqlite && rm -f /data/rider-requests.sqlite-wal /data/rider-requests.sqlite-shm && chown 1000:1000 /data/rider-requests.sqlite'`,
then `docker compose start app`.

## Android app

The release APK already targets `https://ride-request.lookmedia.co.ke`. Build it with `mobile/build.sh release`
once the site is live.
