import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

type RecordValue = Record<string, unknown>;

type Draft = { runtimeKey: string; directory: string; sessionId: string | null; draftId: string; generation: number };
type Target = { tabRef: string; url: string; documentId: string };

type Connection = {
  id: string;
  extensionOrigin: string;
  adapterOrigin?: string;
  extensionCap: string;
  adapterCap?: string;
  code?: string;
  expiresAt: number;
  cancelled: Set<string>;
};

type Job = {
  requestId: string;
  connectionId: string;
  kind: "list" | "capture";
  draft: Draft;
  target?: Target;
  expiresAt: number;
  delivered: boolean;
  response?: RecordValue;
};

export type TabContextBridgeOptions = {
  instanceId: string;
  directory: string;
  adapterOrigins: string[];
  extensionOrigins: string[];
  now?: () => number;
};

export interface TabContextBridge {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): void;
}

const LAUNCHER_ADAPTER_ORIGIN = "openchamber-ui://app";
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
const PREFIX = "/tab-context/";
const V1_PREFIX = "/tab-context/v1/";
const ROUTES = ["begin", "pair", "request", "poll", "reply", "result", "cancel"];
const EXTENSION_ROUTES = ["begin", "poll", "reply"];
const LIMITS = { textCharacters: 24000, packetBytes: 131072, tabs: 100, requestTtlMs: 15000 };
const BODY_LIMIT_BYTES = 131072;
const BODY_TIMEOUT_MS = 5000;
const MAX_CONNECTIONS = 8;
const MAX_JOBS = 32;
const MAX_CANCELLED = 32;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_WINDOW_MS = 60000;
const UNPAIRED_TTL_MS = 60000;
const PAIRED_TTL_MS = 300000;
const SWEEP_INTERVAL_MS = 1000;
const ERRORS = ["permission-denied", "tab-closed", "navigation-changed", "empty-text", "unavailable", "capture-failed"];
const CAPTURE_KEYS = ["tabRef", "url", "documentId", "title", "text", "capturedAt", "truncated"];

class ProtocolError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function reject(status: number, message: string): never {
  throw new ProtocolError(status, message);
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(400, "invalid-payload");
  return value as RecordValue;
}

function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) reject(400, "invalid-field");
  return value;
}

function parseUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    return reject(400, "invalid-url");
  }
}

function webUrl(value: unknown): string {
  const input = text(value, 8192);
  const url = parseUrl(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) reject(400, "invalid-url");
  return input;
}

function target(value: unknown): Target {
  const data = object(value);
  return { tabRef: text(data.tabRef), url: webUrl(data.url), documentId: text(data.documentId) };
}

function draft(value: unknown): Draft {
  const data = object(value);
  if (data.sessionId !== null) text(data.sessionId);
  if (!Number.isSafeInteger(data.generation) || (data.generation as number) < 0) reject(400, "invalid-generation");
  return {
    runtimeKey: text(data.runtimeKey),
    directory: text(data.directory, 4096),
    sessionId: data.sessionId as string | null,
    draftId: text(data.draftId),
    generation: data.generation as number,
  };
}

function equalSecret(value: unknown, expected: string | undefined): boolean {
  if (typeof value !== "string" || !expected || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function isChromeExtensionOrigin(origin: string): boolean {
  return EXTENSION_ORIGIN_PATTERN.test(origin);
}

function isTrustedAdapterOrigin(origin: string): boolean {
  if (origin === LAUNCHER_ADAPTER_ORIGIN) return true;
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<RecordValue> {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") reject(415, "json-required");
  return new Promise((resolve, rejectPromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
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
    const onData = (chunk: Buffer) => {
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

export function createTabContextBridge(options: TabContextBridgeOptions): TabContextBridge {
  const now = options.now ?? Date.now;
  const adapters = new Set(options.adapterOrigins.filter(isTrustedAdapterOrigin));
  const extensions = new Set(options.extensionOrigins.filter(isChromeExtensionOrigin));
  const isTrustedExtensionOrigin = (origin: string): boolean =>
    isChromeExtensionOrigin(origin) || extensions.has(origin);
  const connections = new Map<string, Connection>();
  const jobs = new Map<string, Job>();
  let attempts = 0;
  let attemptExpiresAt = 0;
  let closed = false;

  const removeJob = (job: Job) => {
    const connection = connections.get(job.connectionId);
    if (job.delivered && connection && connection.cancelled.size < MAX_CANCELLED) {
      connection.cancelled.add(job.requestId);
    }
    jobs.delete(job.requestId);
  };

  const prune = () => {
    for (const [id, connection] of connections) {
      if (connection.expiresAt <= now()) connections.delete(id);
    }
    for (const job of jobs.values()) {
      if (job.expiresAt <= now() || !connections.has(job.connectionId)) removeJob(job);
    }
    if (attemptExpiresAt <= now()) {
      attempts = 0;
      attemptExpiresAt = now() + PAIRING_WINDOW_MS;
    }
  };

  const sweep = setInterval(prune, SWEEP_INTERVAL_MS);
  sweep.unref();

  const envelope = (fields: RecordValue) => ({ version: 1, instanceId: options.instanceId, ...fields });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith(PREFIX)) return false;
    const send = (status: number, fields: RecordValue) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(envelope(fields)));
    };

    try {
      if (closed) reject(503, "bridge-closed");
      prune();
      const host = req.headers.host;
      if (
        host !== `127.0.0.1:${req.socket.localPort}` ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
      ) {
        reject(403, "untrusted-host");
      }
      const origin = req.headers.origin;
      if (typeof origin !== "string" || (!adapters.has(origin) && !isTrustedExtensionOrigin(origin))) {
        reject(403, "untrusted-origin");
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.url !== path) reject(400, "query-forbidden");
      const route = path.slice(V1_PREFIX.length);
      if (!path.startsWith(V1_PREFIX) || !ROUTES.includes(route)) reject(404, "unknown-route");

      if (req.method === "OPTIONS") {
        if (req.headers["access-control-request-method"] !== "POST") reject(405, "post-required");
        const headers = String(req.headers["access-control-request-headers"] ?? "")
          .toLowerCase()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (headers.some((header) => !["content-type", "x-tab-context-capability"].includes(header))) {
          reject(403, "untrusted-header");
        }
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.setHeader("Access-Control-Allow-Headers", "content-type,x-tab-context-capability");
        send(200, { ok: true });
        return true;
      }

      if (req.method !== "POST") reject(405, "post-required");

      const extensionRoute = EXTENSION_ROUTES.includes(route);
      if (!(extensionRoute ? isTrustedExtensionOrigin(origin) : adapters.has(origin))) reject(403, "wrong-role");
      const capability = req.headers["x-tab-context-capability"];
      const candidates = [...connections.values()].filter((connection) =>
        extensionRoute
          ? connection.extensionOrigin === origin && equalSecret(capability, connection.extensionCap)
          : connection.adapterOrigin === origin && equalSecret(capability, connection.adapterCap)
      );
      if (!["begin", "pair"].includes(route) && candidates.length !== 1) reject(401, "unauthorized");

      const body = await readBody(req);
      if (closed) reject(503, "bridge-closed");
      prune();
      if (body.version !== 1 || body.instanceId !== options.instanceId) reject(409, "instance-mismatch");

      if (route === "begin") {
        if (connections.size >= MAX_CONNECTIONS) reject(429, "connection-limit");
        let code: string;
        do {
          code = randomInt(10000000, 100000000).toString();
        } while ([...connections.values()].some((connection) => connection.code === code));
        const connection: Connection = {
          id: token(),
          extensionOrigin: origin,
          extensionCap: token(),
          code,
          expiresAt: now() + UNPAIRED_TTL_MS,
          cancelled: new Set(),
        };
        connections.set(connection.id, connection);
        send(201, {
          connectionId: connection.id,
          capability: connection.extensionCap,
          code,
          expiresAt: connection.expiresAt,
        });
        return true;
      }

      if (route === "pair") {
        if (attempts >= MAX_PAIRING_ATTEMPTS) reject(429, "pairing-rate-limit");
        attempts += 1;
        const connection = [...connections.values()].find((item) => equalSecret(body.code, item.code));
        if (!connection) reject(403, "invalid-code");
        connection.code = undefined;
        connection.adapterOrigin = origin;
        connection.adapterCap = token();
        connection.expiresAt = now() + PAIRED_TTL_MS;
        send(201, {
          connectionId: connection.id,
          capability: connection.adapterCap,
          expiresAt: connection.expiresAt,
        });
        return true;
      }

      const connection = candidates[0];
      if (!connections.has(connection.id) || body.connectionId !== connection.id) reject(401, "unauthorized");
      if (!connection.adapterCap) reject(409, "pairing-required");

      if (route === "request") {
        if (jobs.size >= MAX_JOBS) reject(429, "request-limit");
        const kind = body.kind;
        if (kind !== "list" && kind !== "capture") reject(400, "invalid-kind");
        const identity = draft(body.draft);
        if (identity.directory !== options.directory) reject(409, "project-mismatch");
        const job: Job = {
          requestId: token(),
          connectionId: connection.id,
          kind,
          draft: identity,
          ...(kind === "capture" ? { target: target(body.target) } : {}),
          expiresAt: Math.min(now() + LIMITS.requestTtlMs, connection.expiresAt),
          delivered: false,
        };
        jobs.set(job.requestId, job);
        send(202, { requestId: job.requestId, connectionId: connection.id, expiresAt: job.expiresAt, limits: LIMITS });
        return true;
      }

      if (route === "poll") {
        const pending = [...jobs.values()]
          .filter((job) => job.connectionId === connection.id && !job.delivered && !job.response)
          .slice(0, 1);
        const cancelled = [...connection.cancelled];
        connection.cancelled.clear();
        for (const job of pending) job.delivered = true;
        send(200, {
          connectionId: connection.id,
          expiresAt: connection.expiresAt,
          cancelled,
          jobs: pending.map(({ delivered, response, ...job }) => ({
            ...job,
            version: 1,
            instanceId: options.instanceId,
            limits: LIMITS,
          })),
        });
        return true;
      }

      const job = jobs.get(text(body.requestId));
      if (!job || job.connectionId !== connection.id) reject(410, "request-expired-or-consumed");

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

      if (job.response || !job.delivered) reject(410, "request-not-pending");
      if (JSON.stringify(draft(body.draft)) !== JSON.stringify(job.draft)) reject(409, "draft-mismatch");

      if (body.status === "error") {
        const error = body.error;
        if (typeof error !== "string" || !ERRORS.includes(error)) reject(400, "invalid-error");
        job.response = { status: "error", error };
      } else {
        if (body.status !== "ok") reject(400, "invalid-status");
        const result = object(body.result);
        if (job.kind === "list") {
          if (!Array.isArray(result.tabs) || result.tabs.length > LIMITS.tabs) reject(400, "invalid-tabs");
          const refs = new Set<string>();
          const tabs = result.tabs.map((value) => {
            const tab = object(value);
            const ref = target(tab);
            if (refs.has(ref.tabRef)) reject(400, "duplicate-tab");
            refs.add(ref.tabRef);
            return { ...ref, title: text(tab.title, 2048), windowId: text(tab.windowId) };
          });
          job.response = { status: "ok", result: { tabs } };
        } else {
          const ref = target(result);
          if (
            JSON.stringify(ref) !== JSON.stringify(job.target) ||
            Object.keys(result).some((key) => !CAPTURE_KEYS.includes(key))
          ) {
            reject(400, "capture-mismatch");
          }
          if (
            typeof result.truncated !== "boolean" ||
            typeof result.capturedAt !== "string" ||
            !Number.isFinite(Date.parse(result.capturedAt))
          ) {
            reject(400, "invalid-capture");
          }
          job.response = {
            status: "ok",
            result: {
              ...ref,
              title: text(result.title, 2048),
              text: text(result.text, LIMITS.textCharacters),
              capturedAt: result.capturedAt,
              truncated: result.truncated,
            },
          };
        }
      }

      send(200, { ok: true });
    } catch (error) {
      send(error instanceof ProtocolError ? error.status : 400, {
        status: "error",
        error: error instanceof ProtocolError ? error.message : "invalid-request",
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
    },
  };
}
