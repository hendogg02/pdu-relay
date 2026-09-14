#!/usr/bin/env bash
# PDU Relay installer for Debian (or Debian-based) hosts.
#
#   curl -fsSL https://raw.githubusercontent.com/hendogg02/pdu-relay/main/install.sh | bash
#
# Installs Node.js if needed, clones (or updates) the repo into
# /opt/pdu-relay, installs dependencies, and sets it up as a systemd service.
# Nothing UniFi-specific is configured here - that happens afterward in the
# web UI (see the printed URL at the end, or the Installation Guide PDF).
set -euo pipefail

REPO_URL="https://github.com/hendogg02/pdu-relay.git"
INSTALL_DIR="/opt/pdu-relay"
SERVICE_USER="nobody"
SERVICE_GROUP="nogroup"

echo "==> Checking for Node.js 18+"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 18 ]; then
  echo "==> Installing Node.js 20.x from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "==> Found $(node -v), skipping Node.js install"
fi

echo "==> Fetching PDU Relay into ${INSTALL_DIR}"
if [ -d "${INSTALL_DIR}/.git" ]; then
  sudo git -C "${INSTALL_DIR}" pull --ff-only
else
  sudo git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

echo "==> Installing dependencies"
cd "${INSTALL_DIR}"
sudo npm install --omit=dev

echo "==> Installing systemd service"
sudo cp "${INSTALL_DIR}/pdu-relay.service" /etc/systemd/system/pdu-relay.service
sudo chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"
sudo systemctl daemon-reload
sudo systemctl enable --now pdu-relay

echo "==> Waiting for the relay to come up"
sleep 2
sudo systemctl --no-pager status pdu-relay || true

IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "Done. Finish setup in a browser:"
echo "  http://${IP_ADDR:-<this-host>}:8090/"
echo ""
echo "That page creates the admin login and holds the UniFi controller"
echo "connection settings - nothing else needs editing by hand."
