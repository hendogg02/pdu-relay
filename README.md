# PDU Relay

Relay service and web interface that let the `PDU Ctrl.grid` Ross Video DashBoard panel
power-cycle USP-PDU-Pro outlets through a UniFi Network controller.

The panel's scripting engine (ogScript) can only send plain, header-less HTTP requests, so it
can't carry the cookie/CSRF session UniFi's outlet-control API requires. This relay does that
login on the panel's behalf and exposes the simple endpoints the panel calls instead.

It also serves a small web UI (`http://<host>:8090/`) for setup and day-to-day use: a one-time
login creates an admin account, a Connection Settings page holds the UniFi controller
host/credentials, and a PDUs page shows every discovered PDU with live outlet status and reboot
buttons.

## Install (Debian / Debian-based)

```bash
curl -fsSL https://raw.githubusercontent.com/hendogg02/pdu-relay/main/install.sh | bash
```

This installs Node.js if needed, clones this repo to `/opt/pdu-relay`, installs dependencies,
and sets it up as a systemd service (`pdu-relay`). Nothing UniFi-specific is configured by the
script — finish setup in the browser at the URL it prints at the end.

Review [`install.sh`](install.sh) before running it against a host you care about, the way
you would with any `curl | bash` installer.

For the full manual walkthrough (including firewall guidance and troubleshooting), see
[`Installation Guide.pdf`](Installation%20Guide.pdf).

## Updating

```bash
cd /opt/pdu-relay
sudo git pull --ff-only
sudo npm install --omit=dev
sudo systemctl restart pdu-relay
```

Your saved admin login and UniFi connection settings live in `config.json`, which is
git-ignored and untouched by updates.

## Security note

The three endpoints the DashBoard panel calls (`/pdu/list`, `/pdu/:id/outlets`,
`/pdu/:id/outlet/:index/cycle`) have **no authentication of their own** — the panel's scripting
engine can't send an auth header, so they can't require one. The web UI's login only protects
the configuration surface (UniFi credentials, admin account), not those three endpoints.
Restrict access to this service's port at the firewall to only the devices that need it.

## Files

| File | Purpose |
|---|---|
| `pdu-relay-server.js` | HTTP server: panel endpoints, web UI, session auth |
| `unifi-client.js` | UniFi legacy REST API client (login, PDU discovery, outlet control) |
| `config-store.js` | Live-editable settings, backed by `config.json` |
| `cli.js` | Command-line equivalents (`pdu-list`, `pdu-outlets`, `pdu-cycle`) for testing |
| `public/index.html` | The web UI |
| `install.sh` | One-command installer for a Debian host |
| `pdu-relay.service` | systemd unit installed by `install.sh` |
