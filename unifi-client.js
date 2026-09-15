import { Agent } from "undici";
import { getConfig } from "./config-store.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Outlet power control only exists on the UniFi controller's legacy classic
// REST API, which needs a real logged-in session (cookie + CSRF token) -
// there's no API-key surface for it, so this client doesn't need one either.
// Connection details come from config-store.js (editable live via the web
// UI), not fixed environment variables, so changing them takes effect on the
// next request with no restart needed.

let dispatcher = null;
let dispatcherAllowSelfSigned = null;

// Local UDM controllers use a self-signed cert by default. Node's built-in
// fetch (undici under the hood) needs a `dispatcher`, not a plain https.Agent,
// to override TLS verification per-request. Rebuilt only when the setting
// actually changes.
function getDispatcher(allowSelfSigned) {
  if (dispatcher && dispatcherAllowSelfSigned === allowSelfSigned) return dispatcher;
  dispatcher = new Agent({ connect: { rejectUnauthorized: !allowSelfSigned } });
  dispatcherAllowSelfSigned = allowSelfSigned;
  return dispatcher;
}

// -- Legacy classic REST API auth (session cookie + CSRF token) --

let sessionCookie = null;
let csrfToken = null;
let sessionForHost = null;
let sessionForUser = null;

// If the host or username changed since the last login (e.g. edited via the
// web UI), the old session is for a different account entirely - drop it.
function invalidateStaleSession(cfg) {
  if (sessionForHost !== cfg.udmHost || sessionForUser !== cfg.udmUsername) {
    sessionCookie = null;
    csrfToken = null;
    sessionForHost = cfg.udmHost;
    sessionForUser = cfg.udmUsername;
  }
}

async function loginLegacy(cfg) {
  const res = await fetch(`https://${cfg.udmHost}/api/auth/login`, {
    method: "POST",
    dispatcher: getDispatcher(cfg.allowSelfSigned),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.udmUsername, password: cfg.udmPassword }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let reason = null;
    try {
      reason = JSON.parse(text)?.meta?.msg;
    } catch {
      // not JSON - fall through with no extra detail
    }
    throw new Error(
      `Legacy login failed: ${res.status} ${res.statusText}` + (reason ? ` (${reason})` : "")
    );
  }

  // Set-Cookie includes attributes (Path, Expires, HttpOnly, Secure, etc.)
  // that must be stripped down to just the "name=value" pair before being
  // reused as a request Cookie header.
  const rawCookie = res.headers.get("set-cookie");
  sessionCookie = rawCookie ? rawCookie.split(";")[0] : null;
  csrfToken = res.headers.get("x-csrf-token");

  if (!sessionCookie) {
    throw new Error("Legacy login succeeded but no session cookie was returned.");
  }
}

/**
 * Request helper for the legacy classic REST API. Logs in lazily on first
 * use, and retries once on a 401 in case the session expired between calls.
 */
async function requestLegacy(method, path, body, isRetry = false) {
  const cfg = getConfig();
  if (!cfg.udmHost || !cfg.udmUsername || !cfg.udmPassword) {
    throw new Error("UniFi connection isn't configured yet - open the relay's Setup page.");
  }

  invalidateStaleSession(cfg);
  if (!sessionCookie) {
    await loginLegacy(cfg);
  }

  const baseUrl = `https://${cfg.udmHost}/proxy/network/api/s/${cfg.udmSiteName || "default"}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    dispatcher: getDispatcher(cfg.allowSelfSigned),
    headers: {
      Cookie: sessionCookie,
      "X-Csrf-Token": csrfToken,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !isRetry) {
    // Session likely expired - clear it and retry once with a fresh login.
    sessionCookie = null;
    csrfToken = null;
    return requestLegacy(method, path, body, true);
  }

  const text = await res.text();
  let data = null;
  let parseFailed = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (!res.ok) {
    // UniFi's error responses put the actual reason in meta.msg (e.g.
    // "api.err.LoginRequired", "api.err.NoPermission") - surface that
    // instead of just the bare HTTP status, since "401" alone doesn't say
    // whether it's bad credentials, an unauthorized role, or something else.
    const reason = data?.meta?.msg || (parseFailed ? text.slice(0, 200) : null);
    const err = new Error(
      `UniFi legacy API ${method} ${path} failed: ${res.status} ${res.statusText}` +
        (reason ? ` (${reason})` : "")
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

// ---------------------------------------------------------------------------
// PDU (USP-PDU-Pro) discovery and outlet control
// ---------------------------------------------------------------------------
// The panel doesn't know PDU MAC addresses or IDs up front - it asks this
// relay what exists, so adding a physical PDU to the church network is the
// only "setup" step. A PUT to a PDU device replaces its *entire*
// outlet_overrides array, so every write here re-reads the current device
// first and only changes the one outlet being toggled - otherwise a stale
// in-memory copy would silently revert other outlets.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stable, URL-safe id for a device: its MAC with the colons stripped. */
function pduId(device) {
  return (device.mac || "").toLowerCase().replace(/:/g, "");
}

/** Every adopted USP-PDU-Pro on the controller, in {id, name, mac} form. */
export async function listPduDevices() {
  const cfg = getConfig();
  const result = await requestLegacy("GET", "/stat/device");
  return (result?.data || [])
    .filter((d) => d.model === cfg.pduModel)
    .map((d) => ({ id: pduId(d), name: d.name || d.mac, mac: d.mac }));
}

/** Find one PDU's full device object by the id listPduDevices() gave out. */
export async function getPduDeviceById(id) {
  const cfg = getConfig();
  const result = await requestLegacy("GET", "/stat/device");
  const device = (result?.data || []).find(
    (d) => d.model === cfg.pduModel && pduId(d) === id.toLowerCase()
  );
  if (!device) {
    throw new Error(`No PDU found with id ${id}`);
  }
  return device;
}

/** Live per-outlet status (index, name, relay_state) as configured in the UniFi web UI. */
export function listPduOutlets(device) {
  return (device.outlet_table || []).map((o) => ({
    index: o.index,
    name: o.name,
    relay_state: o.relay_state ? 1 : 0,
  }));
}

/**
 * Build a full outlet_overrides array for a PUT, preserving every existing
 * override (name, cycle_enabled, etc.) and changing relay_state only for the
 * target outlet index.
 */
function buildOutletOverrides(device, targetIndex, relayState) {
  const existingByIndex = {};
  for (const o of device.outlet_overrides || []) {
    existingByIndex[o.index] = { ...o };
  }
  return (device.outlet_table || []).map((o) => {
    const base = existingByIndex[o.index] || { index: o.index };
    return {
      ...base,
      index: o.index,
      relay_state: o.index === targetIndex ? relayState : base.relay_state ?? Boolean(o.relay_state),
    };
  });
}

/** Power-cycle one outlet: relay off, wait, relay on. Re-fetches state after the wait. */
export async function cyclePduOutlet(id, index, offMs = 3000) {
  const device = await getPduDeviceById(id);
  await requestLegacy("PUT", `/rest/device/${device._id}`, {
    outlet_overrides: buildOutletOverrides(device, index, false),
  });

  await sleep(offMs);

  const deviceAfterOff = await getPduDeviceById(id);
  await requestLegacy("PUT", `/rest/device/${deviceAfterOff._id}`, {
    outlet_overrides: buildOutletOverrides(deviceAfterOff, index, true),
  });
}
