#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS. Run as root, from your computer:
#   ssh -i ~/.ssh/lookmedia_vps root@<server-ip> 'bash -s' < deploy/vps/server-setup.sh
# Safe to run again. It:
#   - installs updates, Docker, a firewall (SSH, HTTP, HTTPS only), fail2ban and automatic security updates
#   - creates a "deploy" user that can run Docker, with root's SSH keys
#   - turns off SSH password login (only if root already has an SSH key, so you can't lock yourself out)
#   - adds 2 GB swap, the /opt/rider-requests folder and the nightly backup job
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/rider-requests

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }

echo "==> System updates"
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl ufw fail2ban unattended-upgrades rsync sqlite3

echo "==> Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "==> Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "==> Swap"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> deploy user"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
if [ -s /root/.ssh/authorized_keys ]; then
  cat /root/.ssh/authorized_keys >> /home/deploy/.ssh/authorized_keys
  sort -u -o /home/deploy/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
fi

echo "==> App folder"
install -d -o deploy -g deploy "$APP_DIR"
install -d -o 1000 -g 1000 "$APP_DIR/backups"   # the container runs as uid 1000 (node)

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

echo "==> SSH hardening"
if [ -s /root/.ssh/authorized_keys ]; then
  # 00- so it wins over cloud-init's 50-cloud-init.conf (sshd uses the first value it reads).
  cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t && systemctl reload ssh
else
  echo "   Skipped: root has no SSH key yet, so password login stays on."
fi
systemctl enable --now fail2ban

echo "==> Nightly backup (02:17 server time)"
cat > /etc/cron.d/rider-requests-backup <<'EOF'
17 2 * * * deploy docker exec rider-requests node --no-warnings=ExperimentalWarning server/backup.mjs >> /opt/rider-requests/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/rider-requests-backup

timedatectl set-timezone Africa/Nairobi || true

echo
echo "Server ready. Next, from your computer: deploy/vps/deploy.sh"
