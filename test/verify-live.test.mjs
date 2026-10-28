import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  buildReport,
  checkInstance,
  compareAdapterFiles,
  discoverInstances,
  parseArgs,
  scanStatusPayload,
} from "../scripts/verify-tab-context-live.mjs"

const ADAPTER_SOURCE_DIR = resolve(fileURLToPath(new URL("../integrations/openchamber", import.meta.url)))
const TRUSTED_ORIGIN = "openchamber-ui://app"
const TIMEOUT_MS = 1000

const servers = []
after(async () => {
  for (const server of servers) await new Promise(done => server.close(done))
})

function listen(handler) {
  return new Promise((done, fail) => {
    const server = createServer(handler)
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      servers.push(server)
      done(server.address().port)
    })
  })
}

async function mimicBridge(options = {}) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", chunk => chunks.push(chunk))
    req.on("end", () => {
      const port = server.address().port
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
      calls.push({ method: req.method, path: url.pathname, host: req.headers.host, origin: req.headers.origin })
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers })
        res.end(JSON.stringify(body))
      }
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { version: 1, status: "error", error: "untrusted-host" })
      if (url.pathname === "/status") {
        const status = {
          app: options.app ?? "opencode-chrome-annotation",
          version: "9.9.9",
          instanceId: "plugin:test",
          directory: "/repo",
          server: { status: "listening", port },
          claims: [],
        }
        if (options.leak) Object.assign(status, { capability: "secret", tabRef: "tab", documentId: "doc" })
        return send(200, status)
      }
      if (url.pathname === "/tab-context/v1/pair" && req.method === "OPTIONS") {
        const headers = String(req.headers["access-control-request-headers"] ?? "")
        const method = String(req.headers["access-control-request-method"] ?? "")
        if (method !== "POST" || !headers.toLowerCase().includes("x-tab-context-capability")) {
          return send(405, { version: 1, status: "error", error: "post-required" })
        }
        return send(200, { version: 1, ok: true })
      }
      if (url.pathname === "/tab-context/v1/begin" && req.method === "POST") {
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(String(req.headers.origin))) {
          return send(403, { version: 1, status: "error", error: "untrusted-origin" })
        }
        return send(201, { version: 1, connectionId: "connection", capability: "secret-capability", code: "12345678", expiresAt: 1761696000000 })
      }
      if (url.pathname === "/tab-context/v1/request" && req.method === "POST") {
        if (req.headers.origin === "https://evil.test") {
          return send(options.evilOriginStatus ?? 403, { version: 1, status: "error", error: "untrusted-origin" })
        }
        if (req.headers.origin !== TRUSTED_ORIGIN) return send(403, { version: 1, status: "error", error: "untrusted-origin" })
        if (options.requestStatus) return send(options.requestStatus, { version: 1, ok: true })
        if (!req.headers["x-tab-context-capability"]) {
          return send(401, { version: 1, status: "error", error: "unauthorized" })
        }
        return send(202, { version: 1, ok: true })
      }
      send(404, { version: 1, status: "error", error: "unknown-route" })
    })
  })
  await new Promise(done => server.listen(0, "127.0.0.1", done))
  servers.push(server)
  return { port: server.address().port, calls }
}

function byName(checks) {
  return new Map(checks.map(check => [check.name, check]))
}

function reportOptions(overrides = {}) {
  return {
    ports: "39240-39260",
    timeoutMs: TIMEOUT_MS,
    probeExtension: false,
    webDist: join(tmpdir(), "octm-absent"),
    ...overrides,
  }
}

test("parseArgs applies the documented defaults", () => {
  const options = parseArgs([])
  assert.deepEqual(options.range, { start: 39240, end: 39260 })
  assert.equal(options.ports, "39240-39260")
  assert.equal(options.timeoutMs, 1500)
  assert.equal(options.probeExtension, false)
  assert.equal(options.json, false)
  assert.equal(options.webDist, resolve(parseArgs([]).webDist))
  assert.equal(parseArgs(["--ports", "40000-40001", "--timeout", "275", "--probe-extension", "--json"]).probeExtension, true)
  assert.equal(parseArgs(["--ports", "40000-40001", "--timeout", "275"]).timeoutMs, 275)
})

test("parseArgs rejects an invalid port range and a non-numeric timeout", () => {
  assert.throws(() => parseArgs(["--ports", "39300-39200"]), /ports range is invalid/)
  assert.throws(() => parseArgs(["--ports", "39240"]), /--ports must look like/)
  assert.throws(() => parseArgs(["--ports", "0-10"]), /ports range is invalid/)
  assert.throws(() => parseArgs(["--ports", "39240-70000"]), /ports range is invalid/)
  assert.throws(() => parseArgs(["--timeout", "soon"]), /--timeout must be a positive integer/)
  assert.throws(() => parseArgs(["--timeout", "0"]), /--timeout must be a positive integer/)
  assert.throws(() => parseArgs(["--timeout", "12.5"]), /--timeout must be a positive integer/)
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/)
})

test("discovery keeps only instances that report the plugin app", async () => {
  const mine = await mimicBridge()
  const foreign = await mimicBridge({ app: "some-other-app" })
  const [own] = await discoverInstances({ range: { start: mine.port, end: mine.port }, timeoutMs: TIMEOUT_MS })
  assert.deepEqual(Object.keys(own).sort(), ["directory", "instanceId", "port", "serverStatus", "version"])
  assert.equal(own.port, mine.port)
  assert.equal(own.serverStatus, "listening")
  assert.equal(own.instanceId, "plugin:test")
  assert.deepEqual(await discoverInstances({ range: { start: foreign.port, end: foreign.port }, timeoutMs: TIMEOUT_MS }), [])
  const closed = await mimicBridge()
  await new Promise(done => servers.pop().close(done))
  assert.deepEqual(await discoverInstances({ range: { start: closed.port, end: closed.port }, timeoutMs: 250 }), [])
})

test("a live-looking bridge passes every non-mutating check", async () => {
  const bridge = await mimicBridge()
  const [instance] = await discoverInstances({ range: { start: bridge.port, end: bridge.port }, timeoutMs: TIMEOUT_MS })
  const checks = byName(await checkInstance(instance, { timeoutMs: TIMEOUT_MS }))
  assert.equal(checks.get("request without capability").status, "pass")
  assert.equal(checks.get("request without capability").detail, "401 unauthorized")
  assert.equal(checks.get("untrusted origin").status, "pass")
  assert.equal(checks.get("untrusted origin").detail, "403 untrusted-origin")
  assert.equal(checks.get("untrusted host").status, "pass")
  assert.equal(checks.get("untrusted host").detail, "403 untrusted-host")
  assert.equal(checks.get("pair preflight").status, "pass")
  assert.equal(checks.get("status has no secrets").status, "pass")
  assert.equal(checks.get("begin probe").status, "skip")
  assert.equal(bridge.calls.filter(call => call.path === "/tab-context/v1/request").every(call => call.method === "POST"), true)
  assert.equal(bridge.calls.some(call => call.host === "evil.test"), true)
})

test("the 401 and 403 expectations fail when the bridge stops enforcing them", async () => {
  const open = await mimicBridge({ requestStatus: 200 })
  const [openInstance] = await discoverInstances({ range: { start: open.port, end: open.port }, timeoutMs: TIMEOUT_MS })
  const openChecks = byName(await checkInstance(openInstance, { timeoutMs: TIMEOUT_MS }))
  assert.equal(openChecks.get("request without capability").status, "fail")
  assert.equal(openChecks.get("request without capability").detail.includes("expected 401 unauthorized"), true)

  const permissive = await mimicBridge({ evilOriginStatus: 401 })
  const [permissiveInstance] = await discoverInstances({ range: { start: permissive.port, end: permissive.port }, timeoutMs: TIMEOUT_MS })
  const permissiveChecks = byName(await checkInstance(permissiveInstance, { timeoutMs: TIMEOUT_MS }))
  assert.equal(permissiveChecks.get("untrusted origin").status, "fail")
  assert.equal(permissiveChecks.get("untrusted origin").detail.includes("expected 403 untrusted-origin"), true)

  const leaky = await mimicBridge({ leak: true })
  const [leakyInstance] = await discoverInstances({ range: { start: leaky.port, end: leaky.port }, timeoutMs: TIMEOUT_MS })
  const leakyChecks = byName(await checkInstance(leakyInstance, { timeoutMs: TIMEOUT_MS }))
  assert.equal(leakyChecks.get("status has no secrets").status, "fail")
  assert.equal(leakyChecks.get("status has no secrets").detail.includes("capability"), true)

  const bridgeLess = await mimicBridge({ requestStatus: 404 })
  const [bridgeLessInstance] = await discoverInstances({ range: { start: bridgeLess.port, end: bridgeLess.port }, timeoutMs: TIMEOUT_MS })
  const bridgeLessChecks = byName(await checkInstance(bridgeLessInstance, { timeoutMs: TIMEOUT_MS }))
  assert.equal(bridgeLessChecks.get("request without capability").status, "fail")
  assert.equal(bridgeLessChecks.get("request without capability").detail.includes("restart the host with the new plugin"), true)
  assert.deepEqual(scanStatusPayload({ version: "1.0.4", claimTtlMs: 300000 }), [])
  assert.deepEqual(scanStatusPayload({ code: "12345678" }), ["code holds an 8-digit value"])
  assert.deepEqual(scanStatusPayload({ nested: [{ capability: "x" }] }), ["nested[0].capability"])
})

test("the extension probe is skipped by default and masks the pairing code when enabled", async () => {
  const bridge = await mimicBridge()
  const [instance] = await discoverInstances({ range: { start: bridge.port, end: bridge.port }, timeoutMs: TIMEOUT_MS })
  const skipped = byName(await checkInstance(instance, { timeoutMs: TIMEOUT_MS }))
  assert.equal(skipped.get("begin probe").status, "skip")
  assert.equal(skipped.get("begin probe").detail.includes("--probe-extension"), true)
  assert.equal(bridge.calls.some(call => call.path === "/tab-context/v1/begin"), false)

  const checks = await checkInstance(instance, { timeoutMs: TIMEOUT_MS, probeExtension: true })
  const probed = byName(checks).get("begin probe")
  assert.equal(probed.status, "pass")
  assert.equal(probed.detail.includes("code: ****"), true)
  assert.equal(JSON.stringify(checks).includes("12345678"), false)
  assert.equal(JSON.stringify(checks).includes("secret-capability"), false)

  const report = buildReport({ options: reportOptions({ probeExtension: true }), instances: [instance], checks, adapter: null })
  const json = JSON.stringify(report)
  assert.equal(report.ok, true)
  assert.equal(report.result, "ok")
  assert.equal(/12345678/.test(json), false)
  assert.equal(/(?<!\d)\d{8}(?!\d)/.test(json), false)
  assert.equal(JSON.parse(json).probeExtension, true)
})

test("the report fails when any check fails and never carries raw status payloads", async () => {
  const bridge = await mimicBridge({ requestStatus: 200 })
  const [instance] = await discoverInstances({ range: { start: bridge.port, end: bridge.port }, timeoutMs: TIMEOUT_MS })
  const checks = await checkInstance(instance, { timeoutMs: TIMEOUT_MS })
  const report = buildReport({ options: reportOptions(), instances: [instance], checks, adapter: null })
  assert.equal(report.ok, false)
  assert.equal(report.failed, 1)
  assert.equal(report.result, "failed (1)")
  assert.deepEqual(Object.keys(report.instances[0]).sort(), ["directory", "instanceId", "port", "serverStatus", "version"])
  assert.equal(JSON.stringify(report).includes("secret-capability"), false)
})

test("adapter comparison reports match, drift and missing against a temp octm directory", async t => {
  const root = mkdtempSync(join(tmpdir(), "octm-live-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const moduleDir = join(root, "octm")
  mkdirSync(moduleDir)
  const names = readdirSync(ADAPTER_SOURCE_DIR).filter(name => name.endsWith(".mjs"))
  assert.deepEqual(names.sort(), [
    "bridge-client.mjs",
    "draft-controller.mjs",
    "index.mjs",
    "mention-source.mjs",
    "patch-manifest.mjs",
    "runtime.mjs",
  ])
  for (const name of names.filter(name => name !== "runtime.mjs")) {
    writeFileSync(join(moduleDir, name), readFileSync(join(ADAPTER_SOURCE_DIR, name)))
  }
  writeFileSync(join(moduleDir, "draft-controller.mjs"), `${readFileSync(join(ADAPTER_SOURCE_DIR, "draft-controller.mjs"))}\nconst driftMarker = 1\n`)
  writeFileSync(
    join(root, ".octm-install.json"),
    JSON.stringify({
      files: [{ path: join(moduleDir, "index.mjs") }, { path: join(root, "index.html") }, { path: join(root, "..", "outside.mjs") }],
      added: [join(moduleDir, "bridge-client.mjs")],
    })
  )

  const report = compareAdapterFiles({ webDist: root, sourceDir: ADAPTER_SOURCE_DIR })
  const statuses = new Map(report.files.map(file => [file.name, file.status]))
  assert.equal(statuses.get("bridge-client.mjs"), "match")
  assert.equal(statuses.get("index.mjs"), "match")
  assert.equal(statuses.get("mention-source.mjs"), "match")
  assert.equal(statuses.get("patch-manifest.mjs"), "match")
  assert.equal(statuses.get("draft-controller.mjs"), "drift")
  assert.equal(statuses.get("runtime.mjs"), "missing")
  assert.equal(report.installed, true)
  assert.deepEqual(report.record, { exists: true, recorded: 4, outside: 1, parsed: true })

  const empty = compareAdapterFiles({ webDist: join(root, "absent"), sourceDir: ADAPTER_SOURCE_DIR })
  assert.deepEqual(
    empty.files.map(file => file.status),
    ["missing", "missing", "missing", "missing", "missing", "missing"]
  )
  assert.equal(empty.record.exists, false)
})
