#!/usr/bin/env bash
# Copy the server's database backups to this computer (the off-server copy).
#   deploy/vps/pull-backups.sh [destination]   default: ~/Backups/rider-requests
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f deploy/vps/target.env ] && . deploy/vps/target.env
: "${DEPLOY_HOST:?Set DEPLOY_HOST in deploy/vps/target.env}"
SSH_KEY=${SSH_KEY:-$HOME/.ssh/lookmedia_vps}
DEST=${1:-$HOME/Backups/rider-requests}
mkdir -p "$DEST" && chmod 700 "$DEST"
rsync -av -e "ssh -i ${SSH_KEY/#\~/$HOME} -o IdentitiesOnly=yes" --include='rider-requests-*.sqlite' --exclude='*' \
  "$DEPLOY_HOST:/opt/rider-requests/backups/" "$DEST/"
echo "Backups are in $DEST"
