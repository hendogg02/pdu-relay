import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Live-editable configuration, stored in config.json next to this file.
// ---------------------------------------------------------------------------
// Unlike .env (read once at process start), this is read/written at runtime
// by the web UI - changing the UniFi host/credentials or the admin login
// takes effect immediately, no restart needed. Only the listen port
// (PDU_RELAY_PORT) stays in .env, since a listening socket can't be rebound
// without restarting the process anyway.

const CONFIG_PATH = path.join(__dirname, "config.json");

const DEFAULTS = {
  udmHost: "",
  udmSiteName: "default",
  udmUsername: "",
  udmPassword: "",
  allowSelfSigned: true,
  pduModel: "USPPDUP",
  admin: null, // { username, salt, hash } - set via the web UI's first-run setup
};

function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
  } catch (err) {
    console.error("Failed to read config.json, falling back to defaults:", err.message);
    return { ...DEFAULTS };
  }
}

function writeConfigFile(config) {
  // mode 0o600: this file holds the UniFi password and the admin password
  // hash, so only the user running the relay should be able to read it.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

let cached = readConfigFile();

export function getConfig() {
  return cached;
}

export function updateConfig(patch) {
  cached = { ...cached, ...patch };
  writeConfigFile(cached);
  return cached;
}

export function isUnifiConfigured() {
  return !!(cached.udmHost && cached.udmUsername && cached.udmPassword);
}

// ---------------------------------------------------------------------------
// Admin account for the web UI (separate from the UniFi login above)
// ---------------------------------------------------------------------------

export function hasAdminAccount() {
  return !!(cached.admin && cached.admin.username);
}

export function setAdminAccount(username, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  updateConfig({ admin: { username, salt, hash } });
}

export function verifyAdminPassword(username, password) {
  if (!cached.admin || cached.admin.username !== username) return false;
  const candidate = crypto.scryptSync(password, cached.admin.salt, 64);
  const stored = Buffer.from(cached.admin.hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
