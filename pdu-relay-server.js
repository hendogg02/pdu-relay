import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import * as unifi from "./unifi-client.js";
import {
  getConfig,
  updateConfig,
  isUnifiConfigured,
  hasAdminAccount,
  setAdminAccount,
  verifyAdminPassword,
} from "./config-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PDU relay: DashBoard-panel API + a small web UI for setup and monitoring.
// ---------------------------------------------------------------------------
// The panel's ogScript engine can only send plain, header-less HTTP requests
// (see ogscript.asyncHTTP), so it can't do the UniFi controller's cookie +
// CSRF-token login flow itself, or send an auth header of its own. This
// server does that login (via unifi-client.js) and exposes dead-simple
// unauthenticated endpoints for the panel to call instead. The panel never
// needs to know a PDU's MAC/id ahead of time - it asks /pdu/list on connect
// and builds one tab per PDU found.
//
//   GET  /pdu/list                       -> "id|name\n" per discovered PDU
//   GET  /pdu/:id/outlets                -> "index|name|relay_state\n" per outlet
//   POST /pdu/:id/outlet/:index/cycle    -> power-cycles that outlet, replies "OK"
//
// Those three stay unauthenticated by necessity - restrict who can reach
// this port at the firewall, not here.
//
// Everything under /api/* and the web UI itself (served at /) DOES require a
// login, since it can view/change the UniFi controller credentials stored in
// config.json. That login only protects the config/admin surface, though -
// it does not add protection to the three panel endpoints above, which must
// stay open for the DashBoard panel to work at all.

const PORT = Number(process.env.PDU_RELAY_PORT || 8090);
const PUBLIC_DIR = path.join(__dirname, "public");

// -- Sessions: a single in-memory session store is fine for a small,
//    single-instance internal tool. Sessions don't survive a process
//    restart, which is an acceptable tradeoff for the simplicity it buys. --

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { username, expires }

function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).pdu_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `pdu_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "pdu_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

const MIME_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveStatic(req, res, urlPath) {
  const filePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const resolved = path.join(PUBLIC_DIR, filePath);
  // Guard against path traversal outside the public/ directory.
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(resolved, (err, content) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // -- Panel-facing endpoints: unauthenticated by necessity. --

    if (req.method === "GET" && p === "/pdu/list") {
      const pdus = await unifi.listPduDevices();
      sendText(res, 200, pdus.map((d) => `${d.id}|${d.name}`).join("\n") + "\n");
      return;
    }

    const outletsMatch = p.match(/^\/pdu\/([^/]+)\/outlets$/);
    if (req.method === "GET" && outletsMatch) {
      const device = await unifi.getPduDeviceById(outletsMatch[1]);
      const outlets = unifi.listPduOutlets(device);
      sendText(res, 200, outlets.map((o) => `${o.index}|${o.name}|${o.relay_state}`).join("\n") + "\n");
      return;
    }

    const cycleMatch = p.match(/^\/pdu\/([^/]+)\/outlet\/(\d+)\/cycle$/);
    if (req.method === "POST" && cycleMatch) {
      const [, id, indexStr] = cycleMatch;
      await unifi.cyclePduOutlet(id, Number(indexStr));
      sendText(res, 200, "OK");
      return;
    }

    // -- Auth endpoints --

    if (req.method === "GET" && p === "/api/session") {
      const session = getSession(req);
      sendJson(res, 200, {
        setupNeeded: !hasAdminAccount(),
        loggedIn: !!session,
        username: session ? session.username : null,
      });
      return;
    }

    if (req.method === "POST" && p === "/api/setup") {
      if (hasAdminAccount()) {
        sendJson(res, 409, { error: "An admin account already exists." });
        return;
      }
      const { username, password } = await readJsonBody(req);
      if (!username || !password || password.length < 8) {
        sendJson(res, 400, { error: "Username and an 8+ character password are required." });
        return;
      }
      setAdminAccount(username, password);
      setSessionCookie(res, createSession(username));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && p === "/api/login") {
      const { username, password } = await readJsonBody(req);
      if (!verifyAdminPassword(username, password)) {
        sendJson(res, 401, { error: "Incorrect username or password." });
        return;
      }
      setSessionCookie(res, createSession(username));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && p === "/api/logout") {
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    // -- Everything below this line requires a logged-in session. --

    if (p.startsWith("/api/")) {
      const session = getSession(req);
      if (!session) {
        sendJson(res, 401, { error: "Not authenticated." });
        return;
      }

      if (req.method === "GET" && p === "/api/config") {
        const cfg = getConfig();
        sendJson(res, 200, {
          udmHost: cfg.udmHost,
          udmSiteName: cfg.udmSiteName,
          udmUsername: cfg.udmUsername,
          hasPassword: !!cfg.udmPassword,
          allowSelfSigned: cfg.allowSelfSigned,
          pduModel: cfg.pduModel,
          configured: isUnifiConfigured(),
        });
        return;
      }

      if (req.method === "POST" && p === "/api/config") {
        const body = await readJsonBody(req);
        const patch = {};
        if (typeof body.udmHost === "string") patch.udmHost = body.udmHost.trim();
        if (typeof body.udmSiteName === "string" && body.udmSiteName.trim()) {
          patch.udmSiteName = body.udmSiteName.trim();
        }
        if (typeof body.udmUsername === "string") patch.udmUsername = body.udmUsername.trim();
        if (typeof body.udmPassword === "string" && body.udmPassword.length > 0) {
          patch.udmPassword = body.udmPassword;
        }
        if (typeof body.allowSelfSigned === "boolean") patch.allowSelfSigned = body.allowSelfSigned;
        if (typeof body.pduModel === "string" && body.pduModel.trim()) {
          patch.pduModel = body.pduModel.trim();
        }
        updateConfig(patch);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && p === "/api/admin/password") {
        const { currentPassword, newUsername, newPassword } = await readJsonBody(req);
        if (!verifyAdminPassword(session.username, currentPassword || "")) {
          sendJson(res, 401, { error: "Current password is incorrect." });
          return;
        }
        if (!newUsername || !newPassword || newPassword.length < 8) {
          sendJson(res, 400, { error: "Username and an 8+ character password are required." });
          return;
        }
        setAdminAccount(newUsername, newPassword);
        sendJson(res, 200, { ok: true });
        return;
      }

      // JSON mirrors of the panel's PDU endpoints, for the web UI's own use.
      if (req.method === "GET" && p === "/api/pdus") {
        const pdus = await unifi.listPduDevices();
        sendJson(res, 200, pdus);
        return;
      }

      const apiOutletsMatch = p.match(/^\/api\/pdus\/([^/]+)\/outlets$/);
      if (req.method === "GET" && apiOutletsMatch) {
        const device = await unifi.getPduDeviceById(apiOutletsMatch[1]);
        sendJson(res, 200, unifi.listPduOutlets(device));
        return;
      }

      const apiCycleMatch = p.match(/^\/api\/pdus\/([^/]+)\/outlet\/(\d+)\/cycle$/);
      if (req.method === "POST" && apiCycleMatch) {
        const [, id, indexStr] = apiCycleMatch;
        await unifi.cyclePduOutlet(id, Number(indexStr));
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
      return;
    }

    // -- Static web UI (index.html handles its own login/setup gating). --

    if (req.method === "GET") {
      serveStatic(req, res, p);
      return;
    }

    sendText(res, 404, "Not found");
  } catch (err) {
    console.error(err);
    if (p.startsWith("/api/")) {
      sendJson(res, 500, { error: err.message });
    } else {
      sendText(res, 500, `ERROR: ${err.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`PDU relay listening on :${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}/`);
});
