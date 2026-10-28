import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import plugin, { createTabContextBridge, readTabContextOrigins } from "../dist/plugin.js"

const extension = `chrome-extension://${"a".repeat(32)}`
const otherExtension = `chrome-extension://${"b".repeat(32)}`
const adapter = "http://127.0.0.1:5173"
const launcher = "openchamber-ui://app"
const draft = { runtimeKey: "local", directory: "/repo", sessionId: null, draftId: "unique", generation: 1 }
const target = { tabRef: "opaque", url: "https://example.com/", documentId: "doc-one" }
const servers = []

after(async () => {
  for (const { server, bridge } of servers) {
    bridge.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function fixture(options = {}) {
  let now = 1000
  const bridge = createTabContextBridge({
    instanceId: "instance",
    directory: "/repo",
    adapterOrigins: [adapter],
    extensionOrigins: [extension],
    ...options,
    now: options.now ?? (() => now),
  })
  const server = createServer(async (req, res) => {
    if (await bridge.handle(req, res)) return
    res.end("legacy")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push({ server, bridge })
  const port = server.address().port

  function call(route, body = {}, capability, origin = adapter, headers = {}) {
    return new Promise((resolve, reject) => {
      const requestHeaders = {
        origin,
        "content-type": "application/json",
        ...(capability ? { "x-tab-context-capability": capability } : {}),
        ...headers,
      }
      for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === null) delete requestHeaders[key]
      const req = httpRequest(
        { host: "127.0.0.1", port, path: `/tab-context/v1/${route}`, method: "POST", headers: requestHeaders },
        (res) => {
          let data = ""
          res.setEncoding("utf8")
          res.on("data", (chunk) => (data += chunk))
          res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }))
        }
      )
      req.on("error", reject)
      req.end(typeof body === "string" ? body : JSON.stringify({ version: 1, instanceId: "instance", ...body }))
    })
  }

  async function pair() {
    const begin = await call("begin", {}, undefined, extension)
    assert.equal(begin.status, 201)
    const paired = await call("pair", { code: begin.body.code })
    assert.equal(paired.status, 201)
    return {
      connectionId: paired.body.connectionId,
      extensionCap: begin.body.capability,
      adapterCap: paired.body.capability,
      code: begin.body.code,
    }
  }

  return { bridge, call, pair, advance: (milliseconds) => (now += milliseconds), port }
}

test("bridge denies missing capabilities, untrusted origins, rebinding hosts and other instances", async () => {
  const f = await fixture()
  for (const origin of ["null", "https://evil.example", "*", ""]) {
    assert.equal((await f.call("begin", {}, undefined, origin)).status, 403)
  }
  assert.equal((await f.call("begin", {}, undefined, null)).status, 403)
  assert.equal((await f.call("begin", {}, undefined, extension, { host: "evil.example" })).status, 403)
  assert.equal((await f.call("begin", { instanceId: "other" }, undefined, extension)).status, 409)

  const pair = await f.pair()
  assert.equal((await f.call("poll", { connectionId: pair.connectionId }, "é".repeat(43), extension)).status, 401)
  assert.equal((await f.call("poll", { connectionId: pair.connectionId }, undefined, extension)).status, 401)
  assert.equal((await f.call("poll", pair, pair.adapterCap, extension)).status, 401)
  assert.equal((await f.call("request", pair, pair.extensionCap)).status, 401)
  assert.equal((await f.call("begin", {}, pair.adapterCap, adapter)).status, 403)
  assert.equal((await f.call("poll", { connectionId: pair.connectionId }, pair.extensionCap, adapter)).status, 403)

  const other = await fixture()
  assert.equal((await other.call("poll", pair, pair.extensionCap, extension)).status, 401)
  assert.equal((await f.call("poll", pair, pair.extensionCap, extension, { "content-type": "text/plain" })).status, 415)
})

test("pairing codes are one-use, expire, have bounded attempts and bounded pending state", async () => {
  const f = await fixture()
  const pair = await f.pair()
  assert.equal((await f.call("pair", { code: pair.code })).status, 403)

  const begin = await f.call("begin", {}, undefined, extension)
  f.advance(60_001)
  assert.equal((await f.call("pair", { code: begin.body.code })).status, 403)

  for (let index = 0; index < 4; index += 1) {
    assert.equal((await f.call("pair", { code: "00000000" })).status, 403)
  }
  assert.equal((await f.call("pair", { code: "00000000" })).status, 429)

  const bounded = await fixture()
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await bounded.call("begin", {}, undefined, extension)).status, 201)
  }
  assert.equal((await bounded.call("begin", {}, undefined, extension)).status, 429)
})

test("list jobs correlate the exact connection and draft and results are consumed once", async () => {
  const f = await fixture()
  const p = await f.pair()
  const second = await f.pair()
  const started = await f.call("request", { connectionId: p.connectionId, kind: "list", draft }, p.adapterCap)
  assert.equal(started.status, 202)
  assert.deepEqual(started.body.limits, { textCharacters: 24000, packetBytes: 131072, tabs: 100, requestTtlMs: 15000 })
  const requestId = started.body.requestId

  assert.equal((await f.call("result", { connectionId: p.connectionId, requestId }, p.adapterCap)).status, 202)
  const jobs = await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)
  assert.equal(jobs.body.jobs.length, 1)
  assert.deepEqual(jobs.body.jobs[0].draft, draft)
  assert.equal((await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)).body.jobs.length, 0)

  const response = {
    requestId,
    connectionId: p.connectionId,
    draft,
    status: "ok",
    result: { tabs: [{ ...target, title: "Page", windowId: "window" }] },
  }
  assert.equal(
    (await f.call("reply", { ...response, connectionId: second.connectionId }, second.extensionCap, extension)).status,
    410
  )
  assert.equal(
    (await f.call("reply", { ...response, draft: { ...draft, draftId: "other" } }, p.extensionCap, extension)).status,
    409
  )
  assert.equal((await f.call("reply", response, p.extensionCap, extension)).status, 200)
  assert.equal((await f.call("reply", response, p.extensionCap, extension)).status, 410)

  const result = await f.call("result", { connectionId: p.connectionId, requestId }, p.adapterCap)
  assert.equal(result.body.result.tabs[0].title, "Page")
  assert.deepEqual(result.body.draft, draft)
  assert.equal((await f.call("result", { connectionId: p.connectionId, requestId }, p.adapterCap)).status, 410)
})

test("capture replies must match the issued target and stay inside the bounds", async () => {
  const f = await fixture()
  const p = await f.pair()
  assert.equal(
    (await f.call("request", { connectionId: p.connectionId, kind: "capture", draft: { ...draft, directory: "/foreign" }, target }, p.adapterCap)).status,
    409
  )
  assert.equal((await f.call("request", { connectionId: p.connectionId, kind: "capture", draft }, p.adapterCap)).status, 400)

  const started = await f.call("request", { connectionId: p.connectionId, kind: "capture", draft, target }, p.adapterCap)
  assert.equal(started.status, 202)
  const requestId = started.body.requestId
  await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)

  const result = { ...target, title: "Page", text: "Visible text", capturedAt: "2026-10-27T00:00:00.000Z", truncated: false }
  const response = { connectionId: p.connectionId, requestId, draft, status: "ok", result }
  for (const change of [
    { documentId: "stale" },
    { url: "https://changed.example/" },
    { text: " " },
    { text: "x".repeat(24_001) },
    { url: "file:///private" },
    { truncated: "no" },
    { capturedAt: "not a date" },
    { screenshot: "data:secret" },
  ]) {
    assert.equal((await f.call("reply", { ...response, result: { ...result, ...change } }, p.extensionCap, extension)).status, 400)
  }
  assert.equal(
    (await f.call("reply", { ...response, result: { ...result, text: "x".repeat(140_000) } }, p.extensionCap, extension)).status,
    413
  )
  assert.equal((await f.call("reply", response, p.extensionCap, extension)).status, 200)
  assert.equal((await f.call("result", { connectionId: p.connectionId, requestId }, p.adapterCap)).body.result.text, "Visible text")
})

test("cancel, deadline, connection expiry, job caps and shutdown erase pending state", async () => {
  const f = await fixture()
  const p = await f.pair()
  const start = () => f.call("request", { connectionId: p.connectionId, kind: "list", draft }, p.adapterCap)

  const first = await start()
  const requestId = first.body.requestId
  assert.equal((await f.call("cancel", { connectionId: p.connectionId, requestId }, p.adapterCap)).status, 200)
  assert.equal((await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)).body.jobs.length, 0)
  assert.equal(
    (await f.call("reply", { connectionId: p.connectionId, requestId, draft, status: "error", error: "permission-denied" }, p.extensionCap, extension)).status,
    410
  )

  const timed = await start()
  f.advance(15_001)
  assert.equal((await f.call("result", { connectionId: p.connectionId, requestId: timed.body.requestId }, p.adapterCap)).status, 410)

  for (let index = 0; index < 32; index += 1) assert.equal((await start()).status, 202)
  assert.equal((await start()).status, 429)

  f.advance(300_001)
  assert.equal((await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)).status, 401)

  f.bridge.close()
  assert.equal((await f.call("begin", {}, undefined, extension)).status, 503)
})

test("bodies must be json under the packet limit and query strings are refused", async () => {
  const f = await fixture()
  const p = await f.pair()
  assert.equal((await f.call("begin", "{not json", undefined, extension)).status, 400)
  assert.equal((await f.call("begin", JSON.stringify([]), undefined, extension)).status, 400)
  assert.equal((await f.call("begin", { padding: "x".repeat(140_000) }, undefined, extension)).status, 413)
  assert.equal((await f.call("begin?capability=not-accepted", {}, undefined, extension)).status, 400)
  assert.equal((await f.call("unknown")).status, 404)
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}/status`)).text(), "legacy")

  const delivered = await f.call("request", { connectionId: p.connectionId, kind: "list", draft }, p.adapterCap)
  await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)
  const reply = { connectionId: p.connectionId, requestId: delivered.body.requestId, draft, status: "ok", result: { tabs: [] } }
  assert.equal((await f.call("reply", reply, p.extensionCap, extension, { "content-type": "text/plain" })).status, 415)
  assert.equal((await f.call("reply", reply, p.extensionCap, extension, { "content-type": "application/json; charset=utf-8" })).status, 200)
})

test("tab lists enforce count, unique opaque references and web URLs", async () => {
  const f = await fixture()
  const p = await f.pair()
  const started = await f.call("request", { connectionId: p.connectionId, kind: "list", draft }, p.adapterCap)
  await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)
  const tab = { ...target, title: "Page", windowId: "window" }
  for (const tabs of [
    [tab, tab],
    [{ ...tab, url: "chrome://settings" }],
    Array.from({ length: 101 }, (_, index) => ({ ...tab, tabRef: `ref-${index}` })),
  ]) {
    assert.equal(
      (await f.call("reply", { connectionId: p.connectionId, requestId: started.body.requestId, draft, status: "ok", result: { tabs } }, p.extensionCap, extension)).status,
      400
    )
  }
  const oversized = Array.from({ length: 100 }, (_, index) => ({ ...tab, tabRef: `ref-${index}`, title: "界".repeat(2048) }))
  assert.equal(
    (await f.call("reply", { connectionId: p.connectionId, requestId: started.body.requestId, draft, status: "ok", result: { tabs: oversized } }, p.extensionCap, extension)).status,
    413
  )
})

test("delivered cancellations reach the worker and safe errors reach only the paired adapter", async () => {
  const f = await fixture()
  const p = await f.pair()
  const start = () => f.call("request", { connectionId: p.connectionId, kind: "list", draft }, p.adapterCap)

  const cancelled = await start()
  await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)
  await f.call("cancel", { connectionId: p.connectionId, requestId: cancelled.body.requestId }, p.adapterCap)
  assert.deepEqual((await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)).body.cancelled, [
    cancelled.body.requestId,
  ])

  const started = await start()
  const response = { connectionId: p.connectionId, requestId: started.body.requestId, draft, status: "error", error: "permission-denied" }
  assert.equal((await f.call("reply", response, p.extensionCap, extension)).status, 410)
  await f.call("poll", { connectionId: p.connectionId }, p.extensionCap, extension)
  assert.equal((await f.call("reply", { ...response, error: "sensitive page text" }, p.extensionCap, extension)).status, 400)
  assert.equal((await f.call("reply", { ...response, error: "permission-denied " }, p.extensionCap, extension)).status, 400)
  assert.equal((await f.call("reply", response, p.extensionCap, extension)).status, 200)

  const result = await f.call("result", { connectionId: p.connectionId, requestId: started.body.requestId }, p.adapterCap)
  assert.equal(result.body.status, "error")
  assert.equal(result.body.error, "permission-denied")
  assert.equal(JSON.stringify(result.body).includes(p.extensionCap), false)
})

test("trusted preflight is narrow and untrusted verbs fail closed", async () => {
  const f = await fixture()
  const preflight = await fetch(`http://127.0.0.1:${f.port}/tab-context/v1/request`, {
    method: "OPTIONS",
    headers: {
      origin: adapter,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-tab-context-capability",
    },
  })
  assert.equal(preflight.status, 200)
  assert.equal(preflight.headers.get("access-control-allow-origin"), adapter)
  assert.equal(preflight.headers.get("cache-control"), "no-store")

  const launcherPreflight = await fetch(`http://127.0.0.1:${f.port}/tab-context/v1/request`, {
    method: "OPTIONS",
    headers: { origin: launcher, "access-control-request-method": "POST" },
  })
  assert.equal(launcherPreflight.status, 403)

  const configured = await fixture({ adapterOrigins: [adapter, launcher] })
  const launcherAllowed = await fetch(`http://127.0.0.1:${configured.port}/tab-context/v1/request`, {
    method: "OPTIONS",
    headers: { origin: launcher, "access-control-request-method": "POST" },
  })
  assert.equal(launcherAllowed.status, 200)
  assert.equal(launcherAllowed.headers.get("access-control-allow-origin"), launcher)

  const forbiddenHeader = await fetch(`http://127.0.0.1:${f.port}/tab-context/v1/request`, {
    method: "OPTIONS",
    headers: { origin: adapter, "access-control-request-method": "POST", "access-control-request-headers": "x-secret" },
  })
  assert.equal(forbiddenHeader.status, 403)

  const wrongVerb = await fetch(`http://127.0.0.1:${f.port}/tab-context/v1/request`, { headers: { origin: adapter } })
  assert.equal(wrongVerb.status, 405)
})

test("extension origins are trusted when well formed while adapters stay allowlisted", async () => {
  const open = await fixture({ adapterOrigins: [], extensionOrigins: [] })
  assert.equal((await open.call("begin", {}, undefined, extension)).status, 201)
  assert.equal((await open.call("begin", {}, undefined, otherExtension)).status, 201)
  assert.equal((await open.call("begin", {}, undefined, `chrome-extension://${"z".repeat(32)}`)).status, 403)
  assert.equal((await open.call("begin", {}, undefined, "chrome-extension://short")).status, 403)
  assert.equal((await open.call("pair", { code: "00000000" }, undefined, extension)).status, 403)
  assert.equal((await open.call("begin", {}, undefined, adapter)).status, 403)

  const listed = await fixture({ adapterOrigins: [], extensionOrigins: [otherExtension] })
  assert.equal((await listed.call("begin", {}, undefined, otherExtension)).status, 201)

  const invalidTrust = await fixture({ adapterOrigins: ["null", "*", "https://evil.example", "http://[::1]:5173"], extensionOrigins: [] })
  assert.equal((await invalidTrust.call("begin", {}, undefined, "null")).status, 403)
  assert.equal((await invalidTrust.call("begin", {}, undefined, launcher)).status, 403)
})

test("tab context origins resolve from the environment first and fall back to the config file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tab-context-origins-"))
  try {
    const configPath = join(directory, "tab-context.json")
    writeFileSync(configPath, JSON.stringify({ adapterOrigins: [launcher], extensionOrigins: [extension] }))

    assert.deepEqual(readTabContextOrigins({}, configPath), {
      adapterOrigins: [launcher],
      extensionOrigins: [extension],
    })
    assert.deepEqual(
      readTabContextOrigins(
        {
          OPENCODE_TAB_CONTEXT_ADAPTER_ORIGINS: ` ${adapter} , http://localhost:8080 `,
          OPENCODE_TAB_CONTEXT_EXTENSION_ORIGINS: ` ${otherExtension} ,`,
        },
        configPath
      ),
      { adapterOrigins: [adapter, "http://localhost:8080"], extensionOrigins: [otherExtension] }
    )
    assert.deepEqual(readTabContextOrigins({ OPENCODE_TAB_CONTEXT_ADAPTER_ORIGINS: adapter }, configPath), {
      adapterOrigins: [adapter],
      extensionOrigins: [extension],
    })
    assert.deepEqual(readTabContextOrigins({}, join(directory, "missing.json")), {
      adapterOrigins: [],
      extensionOrigins: [],
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createMockContext() {
  const tools = new Map()
  const prompts = []
  let subscriptionSignal
  let subscriptionReady
  const subscribed = new Promise((resolve) => (subscriptionReady = resolve))
  const sessions = [
    { id: "session-a", title: "Session A", time: { created: 1, updated: 1 }, location: { directory: process.cwd() } },
  ]

  const context = {
    location: { directory: process.cwd() },
    session: {
      async list({ directory }) {
        return { data: sessions.filter((session) => session.location.directory === directory), cursor: {} }
      },
      async get({ sessionID }) {
        const session = sessions.find((item) => item.id === sessionID)
        if (!session) throw new Error("Session not found")
        return session
      },
      async prompt(input) {
        prompts.push(input)
        return { id: `inbox-${prompts.length}` }
      },
    },
    tool: {
      async transform(callback) {
        callback({ add: (definition) => tools.set(definition.name, definition) })
        return {
          async dispose() {
            tools.clear()
          },
        }
      },
    },
    event: {
      async *subscribe({ signal }) {
        subscriptionSignal = signal
        subscriptionReady()
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    },
  }

  return {
    context,
    tools,
    prompts,
    subscribed,
    get subscriptionSignal() {
      return subscriptionSignal
    },
  }
}

async function callServer(baseUrl, path, method = "GET", body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", connection: "close", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }
}

test("legacy annotation routes keep their behaviour with the bridge mounted", async () => {
  const mock = createMockContext()
  const cleanup = await plugin.setup(mock.context)
  let baseUrl
  try {
    await mock.subscribed
    const status = JSON.parse((await mock.tools.get("chrome_status").execute({})).content)
    baseUrl = `http://127.0.0.1:${status.port}`
    assert.equal(status.server.status, "listening")
    assert.equal(JSON.stringify(status).includes("capability"), false)
    assert.equal(JSON.stringify(status).includes("tabContext"), false)

    const sessions = await callServer(baseUrl, "/sessions")
    assert.deepEqual(sessions.body.sessions, [
      { id: "session-a", title: "Session A", directory: process.cwd(), status: "open" },
    ])

    const claim = await callServer(baseUrl, "/claim", "POST", { tabId: 4, sessionId: "session-a", extensionVersion: "1.0.0" })
    assert.deepEqual(claim.body, { ok: true, sessionId: "session-a" })

    const annotation = await callServer(baseUrl, "/annotation", "POST", {
      tabId: 4,
      sessionId: "session-a",
      extensionVersion: "1.0.0",
      annotation: { comment: "legacy annotation", page: { title: "Page", url: "https://example.test" } },
    })
    assert.deepEqual(annotation.body, { ok: true, sessionId: "session-a" })
    assert.equal(mock.prompts.length, 1)
    assert.match(mock.prompts[0].text, /legacy annotation/)

    const share = await callServer(baseUrl, "/share", "POST", {
      tabId: 4,
      sessionId: "session-a",
      share: { page: { title: "Page", url: "https://example.test" } },
    })
    assert.deepEqual(share.body, { ok: true, sessionId: "session-a" })
    assert.equal(mock.prompts.length, 2)

    assert.deepEqual((await callServer(baseUrl, "/unclaim", "POST", { tabId: 4 })).body, { ok: true })
    assert.deepEqual((await callServer(baseUrl, "/status")).body.claims, [])

    const untrusted = await callServer(baseUrl, "/tab-context/v1/begin", "POST", { version: 1, instanceId: status.instanceId }, { origin: "null" })
    assert.equal(untrusted.status, 403)

    const bridged = await callServer(baseUrl, "/tab-context/v1/begin", "POST", { version: 1, instanceId: status.instanceId }, { origin: extension })
    assert.equal(bridged.status, 201)
    assert.equal(typeof bridged.body.code, "string")
  } finally {
    await cleanup()
  }
  assert.equal(mock.subscriptionSignal.aborted, true)
  await assert.rejects(callServer(baseUrl, "/status"))
})
