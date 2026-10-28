// src/plugin.ts
import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { createServer } from "http";
import { fileURLToPath, pathToFileURL } from "url";

// src/tab-context.ts
import { randomBytes, randomInt, timingSafeEqual } from "crypto";
var LAUNCHER_ADAPTER_ORIGIN = "openchamber-ui://app";
var LAUNCHER_HEADER = "x-tab-context-launcher";
var ALLOWED_HEADERS = ["content-type", "x-tab-context-capability", LAUNCHER_HEADER];
var EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
var PREFIX = "/tab-context/";
var V1_PREFIX = "/tab-context/v1/";
var ROUTES = ["begin", "pair", "request", "poll", "reply", "result", "cancel"];
var EXTENSION_ROUTES = ["begin", "poll", "reply"];
var ADAPTER_ROUTES = ["pair", "request", "result", "cancel"];
var LIMITS = { textCharacters: 24000, packetBytes: 131072, tabs: 100, requestTtlMs: 15000 };
var BODY_LIMIT_BYTES = 131072;
var BODY_TIMEOUT_MS = 5000;
var MAX_CONNECTIONS = 8;
var MAX_JOBS = 32;
var MAX_CANCELLED = 32;
var MAX_PAIRING_ATTEMPTS = 5;
var PAIRING_WINDOW_MS = 60000;
var UNPAIRED_TTL_MS = 60000;
var PAIRED_TTL_MS = 300000;
var SWEEP_INTERVAL_MS = 1000;
var ERRORS = ["permission-denied", "tab-closed", "navigation-changed", "empty-text", "unavailable", "capture-failed"];
var CAPTURE_KEYS = ["tabRef", "url", "documentId", "title", "text", "capturedAt", "truncated"];

class ProtocolError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function reject(status, message) {
  throw new ProtocolError(status, message);
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject(400, "invalid-payload");
  return value;
}
function text(value, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    reject(400, "invalid-field");
  return value;
}
function parseUrl(input) {
  try {
    return new URL(input);
  } catch {
    return reject(400, "invalid-url");
  }
}
function webUrl(value) {
  const input = text(value, 8192);
  const url = parseUrl(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    reject(400, "invalid-url");
  return input;
}
function target(value) {
  const data = object(value);
  return { tabRef: text(data.tabRef), url: webUrl(data.url), documentId: text(data.documentId) };
}
function draft(value) {
  const data = object(value);
  if (data.sessionId !== null)
    text(data.sessionId);
  if (!Number.isSafeInteger(data.generation) || data.generation < 0)
    reject(400, "invalid-generation");
  return {
    runtimeKey: text(data.runtimeKey),
    directory: text(data.directory, 4096),
    sessionId: data.sessionId,
    draftId: text(data.draftId),
    generation: data.generation
  };
}
function equalSecret(value, expected) {
  if (typeof value !== "string" || !expected || value.length !== expected.length)
    return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function token() {
  return randomBytes(32).toString("base64url");
}
function isChromeExtensionOrigin(origin) {
  return EXTENSION_ORIGIN_PATTERN.test(origin);
}
function isTrustedAdapterOrigin(origin) {
  if (origin === LAUNCHER_ADAPTER_ORIGIN)
    return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
async function readBody(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    reject(415, "json-required");
  return new Promise((resolve, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const finish = (error) => {
      if (finished)
        return;
      finished = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      if (error) {
        req.resume();
        rejectPromise(error);
        return;
      }
      try {
        resolve(object(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch {
        rejectPromise(new ProtocolError(400, "invalid-json"));
      }
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT_BYTES) {
        finish(new ProtocolError(413, "packet-too-large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new ProtocolError(400, "body-failed"));
    const onAbort = () => finish(new ProtocolError(400, "body-aborted"));
    const timer = setTimeout(() => finish(new ProtocolError(408, "body-timeout")), BODY_TIMEOUT_MS);
    req.on("data", onData).once("end", onEnd).once("error", onError).once("aborted", onAbort);
  });
}
function createTabContextBridge(options) {
  const now = options.now ?? Date.now;
  const adapters = new Set(options.adapterOrigins.filter(isTrustedAdapterOrigin));
  const extensions = new Set(options.extensionOrigins.filter(isChromeExtensionOrigin));
  const isTrustedExtensionOrigin = (origin) => isChromeExtensionOrigin(origin) || extensions.has(origin);
  const declaredLauncherOrigin = (req, adapterRoute) => {
    if (!adapterRoute)
      return null;
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null")
      return null;
    const declared = req.headers[LAUNCHER_HEADER];
    if (typeof declared !== "string" || !isTrustedAdapterOrigin(declared) || !adapters.has(declared))
      return null;
    return declared;
  };
  const connections = new Map;
  const jobs = new Map;
  let attempts = 0;
  let attemptExpiresAt = 0;
  let closed = false;
  const removeJob = (job) => {
    const connection = connections.get(job.connectionId);
    if (job.delivered && connection && connection.cancelled.size < MAX_CANCELLED) {
      connection.cancelled.add(job.requestId);
    }
    jobs.delete(job.requestId);
  };
  const prune = () => {
    for (const [id, connection] of connections) {
      if (connection.expiresAt <= now())
        connections.delete(id);
    }
    for (const job of jobs.values()) {
      if (job.expiresAt <= now() || !connections.has(job.connectionId))
        removeJob(job);
    }
    if (attemptExpiresAt <= now()) {
      attempts = 0;
      attemptExpiresAt = now() + PAIRING_WINDOW_MS;
    }
  };
  const sweep = setInterval(prune, SWEEP_INTERVAL_MS);
  sweep.unref();
  const envelope = (fields) => ({ version: 1, instanceId: options.instanceId, ...fields });
  async function handle(req, res) {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith(PREFIX))
      return false;
    const send = (status, fields) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(JSON.stringify(envelope(fields)));
    };
    try {
      if (closed)
        reject(503, "bridge-closed");
      prune();
      const host = req.headers.host;
      if (host !== `127.0.0.1:${req.socket.localPort}` || !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) {
        reject(403, "untrusted-host");
      }
      const route = path.startsWith(V1_PREFIX) ? path.slice(V1_PREFIX.length) : "";
      const origin = typeof req.headers.origin === "string" && req.headers.origin !== "null" ? req.headers.origin : declaredLauncherOrigin(req, ADAPTER_ROUTES.includes(route));
      if (typeof origin !== "string" || !adapters.has(origin) && !isTrustedExtensionOrigin(origin)) {
        reject(403, "untrusted-origin");
      }
      res.setHeader("Access-Control-Allow-Origin", typeof req.headers.origin === "string" ? req.headers.origin : origin);
      res.setHeader("Vary", "Origin");
      if (req.url !== path)
        reject(400, "query-forbidden");
      if (!route || !ROUTES.includes(route))
        reject(404, "unknown-route");
      if (req.method === "OPTIONS") {
        if (req.headers["access-control-request-method"] !== "POST")
          reject(405, "post-required");
        const headers = String(req.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
        if (headers.some((header) => !ALLOWED_HEADERS.includes(header))) {
          reject(403, "untrusted-header");
        }
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(","));
        send(200, { ok: true });
        return true;
      }
      if (req.method !== "POST")
        reject(405, "post-required");
      const extensionRoute = EXTENSION_ROUTES.includes(route);
      if (!(extensionRoute ? isTrustedExtensionOrigin(origin) : adapters.has(origin)))
        reject(403, "wrong-role");
      const capability = req.headers["x-tab-context-capability"];
      const candidates = [...connections.values()].filter((connection) => extensionRoute ? connection.extensionOrigin === origin && equalSecret(capability, connection.extensionCap) : connection.adapterOrigin === origin && equalSecret(capability, connection.adapterCap));
      if (!["begin", "pair"].includes(route) && candidates.length !== 1)
        reject(401, "unauthorized");
      const body = await readBody(req);
      if (closed)
        reject(503, "bridge-closed");
      prune();
      if (body.version !== 1 || body.instanceId !== options.instanceId)
        reject(409, "instance-mismatch");
      if (route === "begin") {
        if (connections.size >= MAX_CONNECTIONS)
          reject(429, "connection-limit");
        let code;
        do {
          code = randomInt(1e7, 1e8).toString();
        } while ([...connections.values()].some((connection) => connection.code === code));
        const connection = {
          id: token(),
          extensionOrigin: origin,
          extensionCap: token(),
          code,
          expiresAt: now() + UNPAIRED_TTL_MS,
          cancelled: new Set
        };
        connections.set(connection.id, connection);
        send(201, {
          connectionId: connection.id,
          capability: connection.extensionCap,
          code,
          expiresAt: connection.expiresAt
        });
        return true;
      }
      if (route === "pair") {
        if (attempts >= MAX_PAIRING_ATTEMPTS)
          reject(429, "pairing-rate-limit");
        attempts += 1;
        const connection = [...connections.values()].find((item) => equalSecret(body.code, item.code));
        if (!connection)
          reject(403, "invalid-code");
        connection.code = undefined;
        connection.adapterOrigin = origin;
        connection.adapterCap = token();
        connection.expiresAt = now() + PAIRED_TTL_MS;
        send(201, {
          connectionId: connection.id,
          capability: connection.adapterCap,
          expiresAt: connection.expiresAt
        });
        return true;
      }
      const connection = candidates[0];
      if (!connections.has(connection.id) || body.connectionId !== connection.id)
        reject(401, "unauthorized");
      if (!connection.adapterCap)
        reject(409, "pairing-required");
      if (route === "request") {
        if (jobs.size >= MAX_JOBS)
          reject(429, "request-limit");
        const kind = body.kind;
        if (kind !== "list" && kind !== "capture")
          reject(400, "invalid-kind");
        const identity = draft(body.draft);
        if (identity.directory !== options.directory)
          reject(409, "project-mismatch");
        const job = {
          requestId: token(),
          connectionId: connection.id,
          kind,
          draft: identity,
          ...kind === "capture" ? { target: target(body.target) } : {},
          expiresAt: Math.min(now() + LIMITS.requestTtlMs, connection.expiresAt),
          delivered: false
        };
        jobs.set(job.requestId, job);
        send(202, { requestId: job.requestId, connectionId: connection.id, expiresAt: job.expiresAt, limits: LIMITS });
        return true;
      }
      if (route === "poll") {
        const pending = [...jobs.values()].filter((job) => job.connectionId === connection.id && !job.delivered && !job.response).slice(0, 1);
        const cancelled = [...connection.cancelled];
        connection.cancelled.clear();
        for (const job of pending)
          job.delivered = true;
        send(200, {
          connectionId: connection.id,
          expiresAt: connection.expiresAt,
          cancelled,
          jobs: pending.map(({ delivered, response, ...job }) => ({
            ...job,
            version: 1,
            instanceId: options.instanceId,
            limits: LIMITS
          }))
        });
        return true;
      }
      const job = jobs.get(text(body.requestId));
      if (!job || job.connectionId !== connection.id)
        reject(410, "request-expired-or-consumed");
      if (route === "cancel") {
        removeJob(job);
        send(200, { ok: true });
        return true;
      }
      if (route === "result") {
        if (!job.response) {
          send(202, { requestId: job.requestId, expiresAt: job.expiresAt, status: "pending" });
          return true;
        }
        jobs.delete(job.requestId);
        send(200, { requestId: job.requestId, connectionId: connection.id, draft: job.draft, ...job.response });
        return true;
      }
      if (job.response || !job.delivered)
        reject(410, "request-not-pending");
      if (JSON.stringify(draft(body.draft)) !== JSON.stringify(job.draft))
        reject(409, "draft-mismatch");
      if (body.status === "error") {
        const error = body.error;
        if (typeof error !== "string" || !ERRORS.includes(error))
          reject(400, "invalid-error");
        job.response = { status: "error", error };
      } else {
        if (body.status !== "ok")
          reject(400, "invalid-status");
        const result = object(body.result);
        if (job.kind === "list") {
          if (!Array.isArray(result.tabs) || result.tabs.length > LIMITS.tabs)
            reject(400, "invalid-tabs");
          const refs = new Set;
          const tabs = result.tabs.map((value) => {
            const tab = object(value);
            const ref = target(tab);
            if (refs.has(ref.tabRef))
              reject(400, "duplicate-tab");
            refs.add(ref.tabRef);
            return { ...ref, title: text(tab.title, 2048), windowId: text(tab.windowId) };
          });
          job.response = { status: "ok", result: { tabs } };
        } else {
          const ref = target(result);
          if (JSON.stringify(ref) !== JSON.stringify(job.target) || Object.keys(result).some((key) => !CAPTURE_KEYS.includes(key))) {
            reject(400, "capture-mismatch");
          }
          if (typeof result.truncated !== "boolean" || typeof result.capturedAt !== "string" || !Number.isFinite(Date.parse(result.capturedAt))) {
            reject(400, "invalid-capture");
          }
          job.response = {
            status: "ok",
            result: {
              ...ref,
              title: text(result.title, 2048),
              text: text(result.text, LIMITS.textCharacters),
              capturedAt: result.capturedAt,
              truncated: result.truncated
            }
          };
        }
      }
      send(200, { ok: true });
    } catch (error) {
      send(error instanceof ProtocolError ? error.status : 400, {
        status: "error",
        error: error instanceof ProtocolError ? error.message : "invalid-request"
      });
    }
    return true;
  }
  return {
    handle,
    close() {
      closed = true;
      clearInterval(sweep);
      connections.clear();
      jobs.clear();
    }
  };
}

// src/plugin.ts
var __filename2 = fileURLToPath(import.meta.url);
var __dirname2 = dirname(__filename2);
var PACKAGE_JSON_PATH = join(__dirname2, "..", "package.json");
var TAB_CONTEXT_CONFIG_PATH = process.env.OPENCODE_TAB_CONTEXT_CONFIG || join(__dirname2, "..", "tab-context.json");
var BASE_DIR = getRuntimeBaseDir();
var LOG_PATH = join(BASE_DIR, "plugin.log");
var ANNOTATION_DIR = join(BASE_DIR, "annotations");
var PORT_START = 39240;
var PORT_END = 39260;
var LISTEN_HOST = "127.0.0.1";
var APP_ID = "opencode-chrome-annotation";
var INSTANCE_SESSION_PREFIX = "plugin:";
var CLAIM_TTL_MS = 5 * 60 * 1000;
var cachedVersion = null;
function splitOrigins(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
function readTabContextOrigins(env = process.env, configPath = TAB_CONTEXT_CONFIG_PATH) {
  const adapterFromEnv = splitOrigins(env.OPENCODE_TAB_CONTEXT_ADAPTER_ORIGINS);
  const extensionFromEnv = splitOrigins(env.OPENCODE_TAB_CONTEXT_EXTENSION_ORIGINS);
  let config = null;
  if (!adapterFromEnv.length || !extensionFromEnv.length) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      config = null;
    }
  }
  const adapterFromFile = Array.isArray(config?.adapterOrigins) ? config.adapterOrigins.filter((value) => typeof value === "string") : [];
  const extensionFromFile = Array.isArray(config?.extensionOrigins) ? config.extensionOrigins.filter((value) => typeof value === "string") : [];
  return {
    adapterOrigins: adapterFromEnv.length ? adapterFromEnv : adapterFromFile,
    extensionOrigins: extensionFromEnv.length ? extensionFromEnv : extensionFromFile
  };
}
function createPluginRuntime(context) {
  const directory = context.location.directory || process.cwd();
  const sessionId = `${INSTANCE_SESSION_PREFIX}${Math.random().toString(36).slice(2)}`;
  return {
    context,
    sessionId,
    directory,
    label: buildSessionLabel(directory),
    listeningPort: null,
    server: null,
    startupStatus: "not-started",
    startupError: null,
    bindFailures: [],
    lastAnnotationStatus: null,
    lastShare: null,
    activeSessionId: null,
    lastExtensionVersion: null,
    sessionTitles: new Map,
    claims: new Map,
    tabContext: createTabContextBridge({ instanceId: sessionId, directory, ...readTabContextOrigins() })
  };
}
function fallbackSession(runtime) {
  return {
    id: runtime.sessionId,
    title: runtime.label,
    directory: runtime.directory,
    status: "open"
  };
}
function getRuntimeBaseDir() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "opencode-chrome-annotation") : null,
    join(tmpdir(), `opencode-chrome-annotation-${uid ?? "user"}`)
  ];
  for (const candidate of candidates) {
    if (!candidate)
      continue;
    try {
      mkdirSync(candidate, { recursive: true, mode: 448 });
      return candidate;
    } catch {}
  }
  return join(tmpdir(), `opencode-chrome-annotation-${uid ?? "user"}`);
}
function getPackageVersion() {
  if (cachedVersion)
    return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return pkg.version;
    }
  } catch {}
  cachedVersion = "unknown";
  return cachedVersion;
}
function logDebug(message) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}
`, "utf8");
  } catch {}
}
function buildSessionLabel(directory) {
  const name = basename(directory || process.cwd());
  return name ? `OpenCode: ${name}` : "OpenCode";
}
function decodeDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match)
    throw new Error("Annotation screenshot must be a base64 data URL");
  return {
    mime: match[1] || "application/octet-stream",
    bytes: Buffer.from(match[2], "base64")
  };
}
function sanitizeFileStem(value) {
  return String(value || "annotation").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "annotation";
}
function buildAnnotationPrompt(annotation) {
  const comment = typeof annotation?.comment === "string" ? annotation.comment.trim() : "";
  const page = annotation?.page || {};
  const element = annotation?.element || {};
  const rect = element?.rect || {};
  const viewport = annotation?.viewport || {};
  return [
    "Browser annotation from Chrome",
    "",
    "User comment:",
    comment || "(no comment provided)",
    "",
    "Page:",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    typeof annotation?.tabId === "number" ? `Tab ID: ${annotation.tabId}` : "Tab ID: ",
    `Viewport: width=${viewport.width ?? ""} height=${viewport.height ?? ""} devicePixelRatio=${viewport.devicePixelRatio ?? ""}`,
    "",
    "Selected element:",
    `Selector: ${element.selector || ""}`,
    `Tag: ${element.tag || ""}`,
    `Role: ${element.role || ""}`,
    `Text: ${element.text || ""}`,
    `Aria label: ${element.ariaLabel || ""}`,
    `Rect: x=${rect.x ?? ""} y=${rect.y ?? ""} width=${rect.width ?? ""} height=${rect.height ?? ""}`,
    "",
    "Please inspect the screenshot and selected element metadata, then make the appropriate code change."
  ].join(`
`);
}
function setLastAnnotationStatus(runtime, status) {
  runtime.lastAnnotationStatus = { ...status, time: new Date().toISOString() };
}
function buildSharePrompt(share) {
  const page = share?.page || {};
  const viewport = share?.viewport || {};
  const selectionText = typeof share?.selectionText === "string" ? share.selectionText.trim() : "";
  return [
    "Browser tab shared from Chrome",
    "",
    "Page:",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    typeof share?.tabId === "number" ? `Tab ID: ${share.tabId}` : "Tab ID: ",
    ...selectionText ? ["", "Selected text:", selectionText] : [],
    ...share?.viewport ? [
      "",
      `Viewport: width=${viewport.width ?? ""} height=${viewport.height ?? ""} devicePixelRatio=${viewport.devicePixelRatio ?? ""}`
    ] : [],
    "",
    "Please look at the screenshot, briefly describe the page, and wait for further instructions."
  ].join(`
`);
}
function setLastShareStatus(runtime, status) {
  runtime.lastShare = { ...status, time: new Date().toISOString() };
}
function applySessionTitle(runtime, sessionId, title) {
  const next = String(title || "").trim();
  if (!sessionId || !next)
    return;
  runtime.sessionTitles.set(sessionId, next);
  if (runtime.activeSessionId === sessionId) {
    runtime.label = next;
  }
}
function rememberClaim(runtime, tabId, sessionId, extensionVersion) {
  const key = Number(tabId);
  const now = new Date().toISOString();
  const prior = runtime.claims.get(key);
  const cleanVersion = cleanExtensionVersion(extensionVersion);
  if (cleanVersion)
    runtime.lastExtensionVersion = cleanVersion;
  runtime.claims.set(key, {
    sessionId,
    claimedAt: prior?.claimedAt || now,
    lastSeenAt: now,
    extensionVersion: cleanVersion || prior?.extensionVersion
  });
}
function cleanExtensionVersion(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function isWebOrigin(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}
function pruneStaleClaims(runtime) {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [tabId, claim] of runtime.claims.entries()) {
    const lastSeen = Date.parse(claim.lastSeenAt);
    if (!Number.isFinite(lastSeen) || lastSeen < cutoff) {
      runtime.claims.delete(tabId);
    }
  }
}
async function ensureSessionTitle(runtime, sessionId) {
  if (!sessionId || runtime.sessionTitles.has(sessionId))
    return;
  try {
    const session = await runtime.context.session.get({ sessionID: sessionId });
    if (session.title)
      applySessionTitle(runtime, session.id, session.title);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`session lookup failed session=${sessionId} error=${message}`);
  }
}
async function listOpenCodeSessions(runtime) {
  const response = await runtime.context.session.list({ directory: runtime.directory });
  const sessions = response.data.filter((item) => !item.time.archived && item.location.directory === runtime.directory).map((item) => {
    const title = item.title?.trim() || `Session ${item.id.slice(0, 8)}`;
    applySessionTitle(runtime, item.id, title);
    return {
      id: item.id,
      title,
      directory: item.location.directory,
      status: "open",
      updatedAt: item.time.updated || item.time.created
    };
  });
  if (runtime.activeSessionId) {
    const active = sessions.find((session) => session.id === runtime.activeSessionId);
    if (active) {
      const { updatedAt: _updatedAt, ...rest } = active;
      return [rest];
    }
    runtime.activeSessionId = null;
    runtime.label = buildSessionLabel(runtime.directory);
  }
  if (!sessions.length)
    return [fallbackSession(runtime)];
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const { updatedAt: _updatedAt, ...latest } = sessions[0];
  return [latest];
}
function json(res, statusCode, body, origin) {
  if (origin)
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 10 * 1024 * 1024)
        reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
function listClaims(runtime) {
  pruneStaleClaims(runtime);
  return Array.from(runtime.claims.entries()).map(([tabId, info]) => ({ tabId, ...info })).sort((a, b) => a.tabId - b.tabId);
}
async function queuePrompt(runtime, sessionId, options) {
  let promptText = options.text;
  const screenshot = options.screenshot;
  let screenshotFile;
  if (screenshot?.dataUrl) {
    mkdirSync(ANNOTATION_DIR, { recursive: true });
    const { mime, bytes } = decodeDataUrl(screenshot.dataUrl);
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const stem = sanitizeFileStem(options.stem || "annotation");
    const filePath = join(ANNOTATION_DIR, `${Date.now()}-${stem}.${ext}`);
    writeFileSync(filePath, bytes);
    screenshotFile = filePath;
    promptText += `

Screenshot: ${filePath}`;
  }
  const response = await runtime.context.session.prompt({
    sessionID: sessionId,
    text: promptText,
    files: screenshotFile ? [{ uri: pathToFileURL(screenshotFile).href, name: basename(screenshotFile) }] : undefined
  });
  return response;
}
async function queueAnnotationPrompt(runtime, sessionId, annotation) {
  setLastAnnotationStatus(runtime, {
    ok: null,
    sessionId,
    phase: "received",
    commentLength: typeof annotation?.comment === "string" ? annotation.comment.length : 0
  });
  try {
    const response = await queuePrompt(runtime, sessionId, {
      text: buildAnnotationPrompt(annotation),
      screenshot: annotation?.screenshot,
      stem: annotation?.page?.title || annotation?.element?.tag || "annotation"
    });
    setLastAnnotationStatus(runtime, {
      ok: true,
      sessionId,
      transport: "session.prompt",
      response
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastAnnotationStatus(runtime, { ok: false, sessionId, error: message });
    throw error;
  }
}
async function queueSharePrompt(runtime, sessionId, share) {
  setLastShareStatus(runtime, { ok: null, sessionId, phase: "received" });
  try {
    const response = await queuePrompt(runtime, sessionId, {
      text: buildSharePrompt(share),
      screenshot: share?.screenshot,
      stem: share?.page?.title || "shared-tab"
    });
    setLastShareStatus(runtime, {
      ok: true,
      sessionId,
      transport: "session.prompt",
      response
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastShareStatus(runtime, { ok: false, sessionId, error: message });
    throw error;
  }
}
function buildStatus(runtime) {
  return {
    app: APP_ID,
    version: getPackageVersion(),
    runtime: {
      platform: process.platform,
      node: process.version,
      tmpdir: tmpdir(),
      xdgRuntimeDir: Boolean(process.env.XDG_RUNTIME_DIR),
      uid: typeof process.getuid === "function" ? process.getuid() : null
    },
    instanceId: runtime.sessionId,
    sessionId: runtime.sessionId,
    opencodeSessionId: runtime.activeSessionId,
    label: runtime.label,
    directory: runtime.directory,
    runtimeBaseDir: BASE_DIR,
    annotationDir: ANNOTATION_DIR,
    logPath: LOG_PATH,
    server: {
      status: runtime.startupStatus,
      host: LISTEN_HOST,
      port: runtime.listeningPort,
      startupError: runtime.startupError,
      bindFailures: runtime.bindFailures
    },
    port: runtime.listeningPort,
    lastExtensionVersion: runtime.lastExtensionVersion,
    claimTtlMs: CLAIM_TTL_MS,
    claims: listClaims(runtime),
    lastAnnotation: runtime.lastAnnotationStatus,
    lastShare: runtime.lastShare
  };
}
async function startServer(runtime) {
  if (runtime.listeningPort)
    return;
  runtime.startupStatus = "starting";
  runtime.startupError = null;
  runtime.bindFailures.length = 0;
  for (let port = PORT_START;port <= PORT_END; port++) {
    const server = createServer(async (req, res) => {
      if (await runtime.tabContext.handle(req, res))
        return;
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : "*";
      if (req.method === "OPTIONS") {
        json(res, 200, { ok: true }, origin);
        return;
      }
      try {
        const url = new URL(req.url || "/", `http://${LISTEN_HOST}:${port}`);
        if (req.method === "GET" && url.pathname === "/status") {
          json(res, 200, buildStatus(runtime), origin);
          return;
        }
        if (req.method === "GET" && url.pathname === "/sessions") {
          const sessions = await listOpenCodeSessions(runtime);
          json(res, 200, {
            sessions
          }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          if (!Number.isFinite(tabId))
            throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId)
            throw new Error("sessionId is required");
          await ensureSessionTitle(runtime, sessionId);
          rememberClaim(runtime, Number(tabId), sessionId, extensionVersion);
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/annotation") {
          if (isWebOrigin(req.headers.origin)) {
            json(res, 403, { ok: false, error: "cross-origin requests are not allowed" }, origin);
            return;
          }
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          const annotation = body?.annotation;
          if (!Number.isFinite(tabId))
            throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId)
            throw new Error("sessionId is required");
          if (!annotation || typeof annotation !== "object")
            throw new Error("annotation is required");
          rememberClaim(runtime, Number(tabId), sessionId, extensionVersion);
          await queueAnnotationPrompt(runtime, sessionId, { ...annotation, tabId: Number(tabId) });
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/share") {
          if (isWebOrigin(req.headers.origin)) {
            json(res, 403, { ok: false, error: "cross-origin requests are not allowed" }, origin);
            return;
          }
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          const share = body?.share;
          if (!Number.isFinite(tabId))
            throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId)
            throw new Error("sessionId is required");
          if (!share || typeof share !== "object")
            throw new Error("share is required");
          rememberClaim(runtime, Number(tabId), sessionId, extensionVersion);
          await queueSharePrompt(runtime, sessionId, { ...share, tabId: Number(tabId) });
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/unclaim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const extensionVersion = body?.extensionVersion;
          const cleanVersion = cleanExtensionVersion(extensionVersion);
          if (cleanVersion)
            runtime.lastExtensionVersion = cleanVersion;
          if (!Number.isFinite(tabId))
            throw new Error("tabId is required");
          runtime.claims.delete(Number(tabId));
          json(res, 200, { ok: true }, origin);
          return;
        }
        json(res, 404, { ok: false, error: "Not found" }, origin);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDebug(`http error path=${req.url || ""} error=${message}`);
        json(res, 400, { ok: false, error: message }, origin);
      }
    });
    const started = await new Promise((resolve) => {
      const onError = (error) => {
        const failure = {
          port,
          code: error.code,
          message: error.message
        };
        runtime.bindFailures.push(failure);
        logDebug(`http bind failed port=${port} code=${failure.code || ""} error=${failure.message}`);
        resolve(false);
      };
      server.once("error", onError);
      server.listen(port, LISTEN_HOST, () => {
        server.off("error", onError);
        resolve(true);
      });
    });
    if (!started)
      continue;
    runtime.server = server;
    runtime.listeningPort = port;
    runtime.startupStatus = "listening";
    server.on("error", (error) => {
      runtime.startupStatus = "failed";
      runtime.startupError = error.message;
      logDebug(`http server error port=${port} code=${error.code || ""} error=${error.message}`);
    });
    logDebug(`http server listening port=${port} session=${runtime.sessionId} label=${JSON.stringify(runtime.label)}`);
    return;
  }
  runtime.startupStatus = "failed";
  runtime.startupError = `Could not bind OpenCode annotation server on ${LISTEN_HOST} ports ${PORT_START}-${PORT_END}`;
  throw new Error(runtime.startupError);
}
async function stopServer(runtime) {
  const server = runtime.server;
  runtime.server = null;
  runtime.listeningPort = null;
  runtime.startupStatus = "not-started";
  runtime.startupError = null;
  runtime.activeSessionId = null;
  runtime.label = buildSessionLabel(runtime.directory);
  runtime.lastExtensionVersion = null;
  runtime.lastAnnotationStatus = null;
  runtime.lastShare = null;
  runtime.sessionTitles.clear();
  runtime.claims.clear();
  runtime.tabContext.close();
  if (!server)
    return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
var plugin_default = Plugin.define({
  id: "opencode-chrome-annotation",
  async setup(context) {
    const runtime = createPluginRuntime(context);
    const controller = new AbortController;
    const toolRegistration = await context.tool.transform((editor) => {
      editor.add({
        name: "chrome_status",
        description: "Report OpenCode Chrome Annotation local server, session, tab claim, last annotation, and last tab share status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: JSON.stringify(buildStatus(runtime), null, 2) };
        }
      });
    });
    const eventTask = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (event.location?.directory !== runtime.directory || (event.location && "workspaceID" in event.location ? event.location.workspaceID : undefined) !== context.location.workspaceID)
            continue;
          switch (event.type) {
            case "session.created":
              if (event.data.title)
                applySessionTitle(runtime, event.data.sessionID, event.data.title);
              break;
            case "session.renamed":
              applySessionTitle(runtime, event.data.sessionID, event.data.title);
              break;
            case "session.viewed":
              runtime.activeSessionId = event.data.sessionID;
              await ensureSessionTitle(runtime, event.data.sessionID);
              runtime.label = runtime.sessionTitles.get(event.data.sessionID) || buildSessionLabel(runtime.directory);
              break;
            case "session.deleted":
            case "session.archived":
              runtime.sessionTitles.delete(event.data.sessionID);
              if (runtime.activeSessionId === event.data.sessionID) {
                runtime.activeSessionId = null;
                runtime.label = buildSessionLabel(runtime.directory);
              }
              break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          logDebug(`event subscription failed error=${message}`);
        }
      }
    })();
    const cleanup = async () => {
      controller.abort();
      try {
        await stopServer(runtime);
      } finally {
        await toolRegistration.dispose();
        await eventTask;
      }
    };
    try {
      await startServer(runtime);
    } catch (error) {
      await cleanup();
      throw error;
    }
    return cleanup;
  }
});
export {
  createTabContextBridge,
  plugin_default as default,
  readTabContextOrigins
};
