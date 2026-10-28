import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { createServer, type Server } from "http";
import { fileURLToPath, pathToFileURL } from "url";
import { createTabContextBridge, type TabContextBridge } from "./tab-context";

export { createTabContextBridge } from "./tab-context";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");
const TAB_CONTEXT_CONFIG_PATH = process.env.OPENCODE_TAB_CONTEXT_CONFIG || join(__dirname, "..", "tab-context.json");

const BASE_DIR = getRuntimeBaseDir();
const LOG_PATH = join(BASE_DIR, "plugin.log");
const ANNOTATION_DIR = join(BASE_DIR, "annotations");
const PORT_START = 39240;
const PORT_END = 39260;
const LISTEN_HOST = "127.0.0.1";
const APP_ID = "opencode-chrome-annotation";
const INSTANCE_SESSION_PREFIX = "plugin:";
const CLAIM_TTL_MS = 5 * 60 * 1000;

let cachedVersion: string | null = null;

interface PluginRuntime {
  context: Plugin.Context;
  sessionId: string;
  directory: string;
  label: string;
  listeningPort: number | null;
  server: Server | null;
  startupStatus: "not-started" | "starting" | "listening" | "failed";
  startupError: string | null;
  bindFailures: Array<{ port: number; code?: string; message: string }>;
  lastAnnotationStatus: Record<string, unknown> | null;
  lastShare: Record<string, unknown> | null;
  activeSessionId: string | null;
  lastExtensionVersion: string | null;
  sessionTitles: Map<string, string>;
  claims: Map<number, { sessionId: string; claimedAt: string; lastSeenAt: string; extensionVersion?: string }>;
  tabContext: TabContextBridge;
}

function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readTabContextOrigins(
  env: Record<string, string | undefined> = process.env,
  configPath: string = TAB_CONTEXT_CONFIG_PATH
): { adapterOrigins: string[]; extensionOrigins: string[] } {
  const adapterFromEnv = splitOrigins(env.OPENCODE_TAB_CONTEXT_ADAPTER_ORIGINS);
  const extensionFromEnv = splitOrigins(env.OPENCODE_TAB_CONTEXT_EXTENSION_ORIGINS);
  let config: Record<string, unknown> | null = null;
  if (!adapterFromEnv.length || !extensionFromEnv.length) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      config = null;
    }
  }
  const adapterFromFile = Array.isArray(config?.adapterOrigins)
    ? (config.adapterOrigins as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const extensionFromFile = Array.isArray(config?.extensionOrigins)
    ? (config.extensionOrigins as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  return {
    adapterOrigins: adapterFromEnv.length ? adapterFromEnv : adapterFromFile,
    extensionOrigins: extensionFromEnv.length ? extensionFromEnv : extensionFromFile,
  };
}

function createPluginRuntime(context: Plugin.Context): PluginRuntime {
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
    sessionTitles: new Map(),
    claims: new Map(),
    tabContext: createTabContextBridge({ instanceId: sessionId, directory, ...readTabContextOrigins() }),
  };
}

function fallbackSession(runtime: PluginRuntime): { id: string; title: string; directory: string; status: string } {
  return {
    id: runtime.sessionId,
    title: runtime.label,
    directory: runtime.directory,
    status: "open",
  };
}

function getRuntimeBaseDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "opencode-chrome-annotation") : null,
    join(tmpdir(), `opencode-chrome-annotation-${uid ?? "user"}`),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch {
      // Try the next location.
    }
  }

  return join(tmpdir(), `opencode-chrome-annotation-${uid ?? "user"}`);
}

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return pkg.version;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

function buildSessionLabel(directory: string): string {
  const name = basename(directory || process.cwd());
  return name ? `OpenCode: ${name}` : "OpenCode";
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = String(dataUrl).match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) throw new Error("Annotation screenshot must be a base64 data URL");
  return {
    mime: match[1] || "application/octet-stream",
    bytes: Buffer.from(match[2], "base64"),
  };
}

function sanitizeFileStem(value: string): string {
  return String(value || "annotation")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "annotation";
}

function buildAnnotationPrompt(annotation: any): string {
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
    "Please inspect the screenshot and selected element metadata, then make the appropriate code change.",
  ].join("\n");
}

function setLastAnnotationStatus(runtime: PluginRuntime, status: Record<string, unknown>): void {
  runtime.lastAnnotationStatus = { ...status, time: new Date().toISOString() };
}

function buildSharePrompt(share: any): string {
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
    ...(selectionText ? ["", "Selected text:", selectionText] : []),
    ...(share?.viewport
      ? [
          "",
          `Viewport: width=${viewport.width ?? ""} height=${viewport.height ?? ""} devicePixelRatio=${viewport.devicePixelRatio ?? ""}`,
        ]
      : []),
    "",
    "Please look at the screenshot, briefly describe the page, and wait for further instructions.",
  ].join("\n");
}

function setLastShareStatus(runtime: PluginRuntime, status: Record<string, unknown>): void {
  runtime.lastShare = { ...status, time: new Date().toISOString() };
}

function applySessionTitle(runtime: PluginRuntime, sessionId: string, title: string): void {
  const next = String(title || "").trim();
  if (!sessionId || !next) return;
  runtime.sessionTitles.set(sessionId, next);
  if (runtime.activeSessionId === sessionId) {
    runtime.label = next;
  }
}

function rememberClaim(runtime: PluginRuntime, tabId: number, sessionId: string, extensionVersion?: string): void {
  const key = Number(tabId);
  const now = new Date().toISOString();
  const prior = runtime.claims.get(key);
  const cleanVersion = cleanExtensionVersion(extensionVersion);
  if (cleanVersion) runtime.lastExtensionVersion = cleanVersion;
  runtime.claims.set(key, {
    sessionId,
    claimedAt: prior?.claimedAt || now,
    lastSeenAt: now,
    extensionVersion: cleanVersion || prior?.extensionVersion,
  });
}

function cleanExtensionVersion(value: any): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isWebOrigin(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function pruneStaleClaims(runtime: PluginRuntime): void {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [tabId, claim] of runtime.claims.entries()) {
    const lastSeen = Date.parse(claim.lastSeenAt);
    if (!Number.isFinite(lastSeen) || lastSeen < cutoff) {
      runtime.claims.delete(tabId);
    }
  }
}

async function ensureSessionTitle(runtime: PluginRuntime, sessionId: string): Promise<void> {
  if (!sessionId || runtime.sessionTitles.has(sessionId)) return;
  try {
    const session = await runtime.context.session.get({ sessionID: sessionId });
    if (session.title) applySessionTitle(runtime, session.id, session.title);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`session lookup failed session=${sessionId} error=${message}`);
  }
}

async function listOpenCodeSessions(
  runtime: PluginRuntime
): Promise<Array<{ id: string; title: string; directory?: string; status: string }>> {
  const response = await runtime.context.session.list({ directory: runtime.directory });
  const sessions = response.data
    .filter((item) => !item.time.archived && item.location.directory === runtime.directory)
    .map((item) => {
      const title = item.title?.trim() || `Session ${item.id.slice(0, 8)}`;
      applySessionTitle(runtime, item.id, title);
      return {
        id: item.id,
        title,
        directory: item.location.directory,
        status: "open",
        updatedAt: item.time.updated || item.time.created,
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

  if (!sessions.length) return [fallbackSession(runtime)];

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const { updatedAt: _updatedAt, ...latest } = sessions[0];
  return [latest];
}

function json(res: any, statusCode: number, body: any, origin?: string): void {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: any): Promise<any> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 10 * 1024 * 1024) reject(new Error("Request body too large"));
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

function listClaims(runtime: PluginRuntime): Array<Record<string, unknown>> {
  pruneStaleClaims(runtime);
  return Array.from(runtime.claims.entries())
    .map(([tabId, info]) => ({ tabId, ...info }))
    .sort((a, b) => a.tabId - b.tabId);
}

async function queuePrompt(
  runtime: PluginRuntime,
  sessionId: string,
  options: { text: string; screenshot?: any; stem?: string }
): Promise<any> {
  let promptText = options.text;
  const screenshot = options.screenshot;
  let screenshotFile: string | undefined;
  if (screenshot?.dataUrl) {
    mkdirSync(ANNOTATION_DIR, { recursive: true });
    const { mime, bytes } = decodeDataUrl(screenshot.dataUrl);
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const stem = sanitizeFileStem(options.stem || "annotation");
    const filePath = join(ANNOTATION_DIR, `${Date.now()}-${stem}.${ext}`);
    writeFileSync(filePath, bytes);
    screenshotFile = filePath;
    promptText += `\n\nScreenshot: ${filePath}`;
  }

  const response = await runtime.context.session.prompt({
    sessionID: sessionId,
    text: promptText,
    files: screenshotFile ? [{ uri: pathToFileURL(screenshotFile).href, name: basename(screenshotFile) }] : undefined,
  });

  return response;
}

async function queueAnnotationPrompt(runtime: PluginRuntime, sessionId: string, annotation: any): Promise<void> {
  setLastAnnotationStatus(runtime, {
    ok: null,
    sessionId,
    phase: "received",
    commentLength: typeof annotation?.comment === "string" ? annotation.comment.length : 0,
  });

  try {
    const response = await queuePrompt(runtime, sessionId, {
      text: buildAnnotationPrompt(annotation),
      screenshot: annotation?.screenshot,
      stem: annotation?.page?.title || annotation?.element?.tag || "annotation",
    });
    setLastAnnotationStatus(runtime, {
      ok: true,
      sessionId,
      transport: "session.prompt",
      response,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastAnnotationStatus(runtime, { ok: false, sessionId, error: message });
    throw error;
  }
}

async function queueSharePrompt(runtime: PluginRuntime, sessionId: string, share: any): Promise<void> {
  setLastShareStatus(runtime, { ok: null, sessionId, phase: "received" });

  try {
    const response = await queuePrompt(runtime, sessionId, {
      text: buildSharePrompt(share),
      screenshot: share?.screenshot,
      stem: share?.page?.title || "shared-tab",
    });
    setLastShareStatus(runtime, {
      ok: true,
      sessionId,
      transport: "session.prompt",
      response,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastShareStatus(runtime, { ok: false, sessionId, error: message });
    throw error;
  }
}

function buildStatus(runtime: PluginRuntime): Record<string, unknown> {
  return {
    app: APP_ID,
    version: getPackageVersion(),
    runtime: {
      platform: process.platform,
      node: process.version,
      tmpdir: tmpdir(),
      xdgRuntimeDir: Boolean(process.env.XDG_RUNTIME_DIR),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
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
      bindFailures: runtime.bindFailures,
    },
    port: runtime.listeningPort,
    lastExtensionVersion: runtime.lastExtensionVersion,
    claimTtlMs: CLAIM_TTL_MS,
    claims: listClaims(runtime),
    lastAnnotation: runtime.lastAnnotationStatus,
    lastShare: runtime.lastShare,
  };
}

async function startServer(runtime: PluginRuntime): Promise<void> {
  if (runtime.listeningPort) return;
  runtime.startupStatus = "starting";
  runtime.startupError = null;
  runtime.bindFailures.length = 0;

  for (let port = PORT_START; port <= PORT_END; port++) {
    const server = createServer(async (req, res) => {
      if (await runtime.tabContext.handle(req, res)) return;
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
          json(
            res,
            200,
            {
              sessions,
            },
            origin
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
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
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          if (!annotation || typeof annotation !== "object") throw new Error("annotation is required");

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
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          if (!share || typeof share !== "object") throw new Error("share is required");

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
          if (cleanVersion) runtime.lastExtensionVersion = cleanVersion;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
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

    const started = await new Promise<boolean>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        const failure = {
          port,
          code: error.code,
          message: error.message,
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

    if (!started) continue;
    runtime.server = server;
    runtime.listeningPort = port;
    runtime.startupStatus = "listening";
    server.on("error", (error: NodeJS.ErrnoException) => {
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

async function stopServer(runtime: PluginRuntime): Promise<void> {
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

  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export default Plugin.define({
  id: "opencode-chrome-annotation",
  async setup(context) {
    const runtime = createPluginRuntime(context);
    const controller = new AbortController();
    const toolRegistration = await context.tool.transform((editor) => {
      editor.add({
        name: "chrome_status",
        description: "Report OpenCode Chrome Annotation local server, session, tab claim, last annotation, and last tab share status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: JSON.stringify(buildStatus(runtime), null, 2) };
        },
      });
    });

    const eventTask = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (
            event.location?.directory !== runtime.directory ||
            (event.location && "workspaceID" in event.location ? event.location.workspaceID : undefined) !==
              context.location.workspaceID
          ) continue;
          switch (event.type) {
            case "session.created":
              if (event.data.title) applySessionTitle(runtime, event.data.sessionID, event.data.title);
              break;
            case "session.renamed":
              applySessionTitle(runtime, event.data.sessionID, event.data.title);
              break;
            case "session.viewed":
              runtime.activeSessionId = event.data.sessionID;
              await ensureSessionTitle(runtime, event.data.sessionID);
              runtime.label =
                runtime.sessionTitles.get(event.data.sessionID) || buildSessionLabel(runtime.directory);
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
  },
});
