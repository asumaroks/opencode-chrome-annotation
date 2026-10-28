import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { webcrypto } from "node:crypto"
import vm from "node:vm"
import test from "node:test"
import ts from "typescript"

const draft = { runtimeKey: "local", directory: "/repo", sessionId: null, draftId: "draft-one", generation: 2 }
const limits = { textCharacters: 24000, packetBytes: 131072, tabs: 100, requestTtlMs: 15000 }
const codes = ["permission-denied", "tab-closed", "navigation-changed", "empty-text", "unavailable", "capture-failed"]
const plain = (value) => JSON.parse(JSON.stringify(value))
const flush = () => new Promise((resolve) => setImmediate(resolve))

function transpile(path) {
  const file = new URL(path, import.meta.url)
  assert.ok(existsSync(file), `${path} is missing`)
  return ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

function load(path, sandbox = {}) {
  const exports = {}
  const context = vm.createContext({
    exports,
    module: { exports },
    URL,
    Date,
    crypto: webcrypto,
    performance,
    TextEncoder,
    AbortSignal,
    fetch,
    setTimeout,
    clearTimeout,
    console,
    ...sandbox,
  })
  vm.runInContext(transpile(path), context)
  return { exports, context }
}

const { exports: client, context: clientContext } = load("../extension-src/tab-context.ts")
const errorIn = vm.runInContext("(code) => new Error(code)", clientContext)

function chromeFixture(options = {}) {
  const listeners = new Set()
  const state = {
    tab: { id: 4, windowId: 2, url: "https://example.com/", title: "Page", incognito: false, status: "complete" },
    document: "document-one",
    allowed: true,
    text: "Page text",
    truncated: false,
    afterInject: () => {},
    injectError: null,
    injections: 0,
    targets: [],
    queries: [],
    permissionOrigins: [],
  }
  const defaultTabs = () => [
    state.tab,
    { ...state.tab, id: 5, incognito: true },
    { ...state.tab, id: 6, url: "chrome://settings" },
    { ...state.tab, id: 7, url: "https://user:pass@example.com/" },
  ]
  const api = {
    tabs: {
      query: async (query) => {
        state.queries.push(query)
        return options.tabs ? options.tabs(state) : defaultTabs()
      },
      get: async () => {
        if (!state.tab) throw new Error("closed")
        return { ...state.tab }
      },
      onUpdated: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    },
    permissions: {
      contains: async (details) => {
        state.permissionOrigins.push(details.origins)
        return state.allowed
      },
    },
    webNavigation: {
      getFrame: async (details) =>
        options.frame
          ? options.frame(details, state)
          : { documentId: state.document, url: state.tab.url, frameId: 0, documentLifecycle: "active" },
    },
    scripting: {
      executeScript: async (args) => {
        state.injections += 1
        state.targets.push(args.target)
        state.afterInject()
        if (state.injectError) throw new Error("inject failed")
        return [{ documentId: state.document, frameId: 0, result: { url: state.tab.url, title: "Page", text: state.text, truncated: state.truncated } }]
      },
    },
  }
  const context = client.createChromeContext(api)
  return {
    context,
    state,
    notify: (tabId, change) => {
      for (const fn of listeners) fn(tabId, change)
    },
  }
}

const visible = { display: "block", visibility: "visible", contentVisibility: "visible", opacity: "1" }
const computed = { invisible: { ...visible, display: "none" }, transparent: { ...visible, opacity: "0" }, collapsed: { ...visible, visibility: "collapse" }, unpainted: { ...visible, contentVisibility: "hidden" } }

function extractor(nodes, options = {}) {
  const document = {
    body: options.body === undefined ? {} : options.body,
    title: "Title",
    createTreeWalker: () => {
      let index = 0
      return { nextNode: () => nodes[index++] ?? null }
    },
  }
  return vm.runInNewContext(`(${client.extractDocumentText.toString()})()`, {
    document,
    Date,
    performance,
    location: { href: "https://example.com/" },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: (node) => computed[node.variant] ?? visible,
  })
}

function textNode(value, parent) {
  return { nodeValue: value, parentElement: parent }
}

function element(tag, options = {}) {
  const children = options.children ?? []
  const contained = options.contains ?? []
  return {
    tagName: tag,
    parentElement: options.parent ?? null,
    hidden: options.hidden ?? false,
    children,
    variant: options.variant ?? null,
    contains: (candidate) => contained.includes(candidate),
    getAttribute: (name) => (name === "aria-hidden" ? options.ariaHidden ?? null : null),
    hasAttribute: (name) => (options.attributes ?? []).includes(name),
  }
}

function transport(options = {}) {
  const calls = []
  let polls = 0
  const request = async (url, init) => {
    const route = url.slice(url.lastIndexOf("/") + 1)
    calls.push({ route, url, body: JSON.parse(init.body), headers: init.headers, init })
    const reply = (status, fields) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ version: 1, instanceId: "instance", ...fields }),
    })
    if (route === "begin") return reply(201, { connectionId: "connection", capability: "private", code: "12345678", expiresAt: 61000 })
    if (route === "poll") return reply(200, { connectionId: "connection", expiresAt: 301000, cancelled: [], jobs: options.jobs ? options.jobs(polls++) : [] })
    return reply(options.replyStatus ?? 200, { ok: true })
  }
  return { request, calls, replies: () => calls.filter((call) => call.route === "reply") }
}

test("client speaks the origin and instance envelope to the bounded loopback range", async () => {
  for (const baseUrl of ["http://localhost:39240", "https://127.0.0.1:39240", "http://127.0.0.1:39239", "http://127.0.0.1:39261", "http://127.0.0.1:39240/extra"]) {
    assert.throws(() => client.createContextConnection({ baseUrl, instanceId: "instance" }, { dispose() {} }), { message: "unavailable" })
  }
  assert.throws(() => client.createContextConnection({ baseUrl: "http://127.0.0.1:39240", instanceId: "" }, { dispose() {} }), { message: "unavailable" })

  const t = transport()
  const connection = client.createContextConnection({ baseUrl: "http://127.0.0.1:39240", instanceId: "instance" }, { list: async () => ({ tabs: [] }), dispose() {} }, t.request, () => 1000)
  assert.equal((await connection.begin()).code, "12345678")
  await connection.tick()
  assert.equal(t.calls[0].url, "http://127.0.0.1:39240/tab-context/v1/begin")
  assert.deepEqual(t.calls[0].body, { version: 1, instanceId: "instance" })
  assert.deepEqual(t.calls[1].body, { version: 1, instanceId: "instance", connectionId: "connection" })
  assert.equal(t.calls[0].headers["X-Tab-Context-Capability"], undefined)
  assert.equal(t.calls[1].headers["X-Tab-Context-Capability"], "private")
  for (const call of t.calls) assert.equal(call.url.includes("private"), false)
  assert.equal(t.calls[1].init.method, "POST")
  assert.equal(t.calls[1].init.credentials, "omit")
  assert.equal(t.calls[1].init.cache, "no-store")
  assert.equal(t.calls[1].init.redirect, "error")
  assert.equal(t.calls[1].init.referrerPolicy, "no-referrer")
  connection.stop()
})

test("one connection cannot bootstrap twice or reconnect after stop", async () => {
  let calls = 0
  const connection = client.createContextConnection(
    { baseUrl: "http://127.0.0.1:39240", instanceId: "instance" },
    { dispose() {} },
    async () => {
      calls += 1
      return { ok: true, json: async () => ({ version: 1, instanceId: "instance", connectionId: "connection", capability: "private", code: "12345678", expiresAt: 61000 }) }
    },
    () => 1000
  )
  await connection.begin()
  await assert.rejects(connection.begin(), { message: "unavailable" })
  assert.equal(calls, 1)
  connection.stop()
  await assert.rejects(connection.begin(), { message: "unavailable" })
  await assert.rejects(connection.tick(), { message: "unavailable" })
})

test("poll cancels in-flight extraction and never replies with expired text", async () => {
  let finish
  let now = 1000
  let polls = 0
  const job = { version: 1, instanceId: "instance", connectionId: "connection", requestId: "request", kind: "capture", draft, target: { tabRef: "ref", url: "https://example.com/", documentId: "doc" }, expiresAt: 16000, limits }
  const t = transport({ jobs: () => (polls++ === 0 ? [job] : []) })
  const connection = client.createContextConnection(
    { baseUrl: "http://127.0.0.1:39240", instanceId: "instance" },
    { list: async () => ({ tabs: [] }), capture: async () => new Promise((resolve) => { finish = resolve }), dispose() {} },
    t.request,
    () => now
  )
  await connection.begin()
  await connection.tick()
  now = 16000
  await connection.tick()
  finish({ ...job.target, title: "Page", text: "discard me", capturedAt: new Date().toISOString(), truncated: false })
  await connection.settle()
  assert.equal(t.replies().length, 0)
  now = 302000
  await assert.rejects(connection.tick(), { message: "unavailable" })
})

test("malformed jobs fail closed before any work starts", async () => {
  const mutations = [
    ["expired", (job) => { job.expiresAt = 1 }],
    ["draft", (job) => { job.draft = { ...draft, draftId: "" } }],
    ["limits", (job) => { job.limits = { ...limits, textCharacters: 25000 } }],
    ["instance", (job) => { job.instanceId = "other" }],
    ["connection", (job) => { job.connectionId = "other" }],
    ["kind", (job) => { job.kind = "share" }],
    ["target", (job) => { delete job.target }],
    ["document", (job) => { job.target.documentId = "" }],
  ]
  for (const [name, mutate] of mutations) {
    let disposed = false
    const job = { version: 1, instanceId: "instance", connectionId: "connection", requestId: "request", kind: "capture", draft, target: { tabRef: "ref", url: "https://example.com/", documentId: "doc" }, expiresAt: 16000, limits }
    mutate(job)
    const t = transport({ jobs: () => [job] })
    const connection = client.createContextConnection(
      { baseUrl: "http://127.0.0.1:39240", instanceId: "instance" },
      { capture: async () => ({ text: "unused" }), dispose() { disposed = true } },
      t.request,
      () => 1000
    )
    await connection.begin()
    await assert.rejects(connection.tick(), { message: "unavailable" }, name)
    assert.equal(disposed, true, name)
    assert.equal(t.replies().length, 0, name)
  }
})

test("an oversized reply packet degrades to capture-failed instead of leaking text", async () => {
  let replied
  const job = { version: 1, instanceId: "instance", connectionId: "connection", requestId: "request", kind: "list", draft, expiresAt: 16000, limits }
  const t = transport({ jobs: (poll) => (poll === 0 ? [job] : []) })
  const connection = client.createContextConnection(
    { baseUrl: "http://127.0.0.1:39240", instanceId: "instance" },
    { list: async () => ({ tabs: [{ title: "界".repeat(50000) }] }), dispose() {} },
    async (url, init) => {
      if (url.endsWith("reply")) replied = JSON.parse(init.body)
      return t.request(url, init)
    },
    () => 1000
  )
  await connection.begin()
  await connection.tick()
  await connection.settle()
  assert.equal(t.replies().length, 1)
  assert.equal(replied.status, "error")
  assert.equal(replied.error, "capture-failed")
  assert.equal(replied.result, undefined)
  connection.stop()
})

test("each of the six error codes reaches the reply unchanged and anything else maps to capture-failed", async () => {
  for (const code of [...codes, "boom", ""]) {
    const job = { version: 1, instanceId: "instance", connectionId: "connection", requestId: `request-${code}`, kind: "capture", draft, target: { tabRef: "ref", url: "https://example.com/", documentId: "doc" }, expiresAt: 16000, limits }
    const t = transport({ jobs: () => [job] })
    const connection = client.createContextConnection(
      { baseUrl: "http://127.0.0.1:39240", instanceId: "instance" },
      { capture: async () => { throw errorIn(code) }, dispose() {} },
      t.request,
      () => 1000
    )
    await connection.begin()
    await connection.tick()
    await connection.settle()
    const [reply] = t.replies()
    assert.equal(reply.body.status, "error", code)
    assert.equal(reply.body.error, codes.includes(code) ? code : "capture-failed", code)
    assert.equal(reply.body.requestId, job.requestId)
    assert.equal(reply.body.result, undefined)
    assert.deepEqual(reply.body.draft, draft)
    connection.stop()
  }
})

test("a reply refused as expired stops nothing and the connection keeps polling", async () => {
  const job = { version: 1, instanceId: "instance", connectionId: "connection", requestId: "request", kind: "list", draft, expiresAt: 16000, limits }
  const t = transport({ jobs: (poll) => (poll === 0 ? [job] : []), replyStatus: 410 })
  const connection = client.createContextConnection(
    { baseUrl: "http://127.0.0.1:39240", instanceId: "instance" },
    { list: async () => ({ tabs: [] }), dispose() {} },
    t.request,
    () => 1000
  )
  await connection.begin()
  await connection.tick()
  await connection.settle()
  assert.equal(t.replies().length, 1)
  assert.equal((await connection.tick()).paired, true)
  connection.stop()
})

test("listing keeps only http(s) tabs with an active document and never reads page text", async () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://ok.example/", title: "Ok", status: "complete" },
    { id: 2, url: "https://private.example/", incognito: true, status: "complete" },
    { id: 3, url: "chrome://settings", status: "complete" },
    { id: 4, url: "file:///etc/passwd", status: "complete" },
    { id: 5, url: "https://loading.example/", status: "loading" },
    { id: 6, url: "https://pending.example/", pendingUrl: "https://next.example/", status: "complete" },
    { url: "https://missing-id.example/", status: "complete" },
    { id: 8, url: "https://stale.example/", status: "complete" },
    { id: 9, url: "https://missing-document.example/", status: "complete" },
    { id: 10, url: "https://prerender.example/", status: "complete" },
    { id: 11, url: "https://credentials.example/", status: "complete" },
  ]
  const frames = {
    8: { documentId: "document-eight", url: "https://moved.example/" },
    9: { url: "https://missing-document.example/" },
    10: { documentId: "document-ten", url: "https://prerender.example/", documentLifecycle: "prerender" },
    11: { documentId: "document-eleven", url: "https://user:password@credentials.example/" },
  }
  const f = chromeFixture({
    tabs: () => tabs,
    frame: (details) => {
      const tab = tabs.find((item) => item.id === details.tabId)
      return { frameId: 0, documentLifecycle: "active", ...(frames[details.tabId] ?? { documentId: `document-${details.tabId}`, url: tab.url }) }
    },
  })
  const { tabs: listed } = await f.context.list()
  assert.deepEqual(plain(listed.map((tab) => tab.url)), ["https://ok.example/"])
  assert.equal(listed[0].documentId, "document-1")
  assert.equal(listed[0].windowId, "1")
  assert.equal(listed[0].title, "Ok")
  assert.notEqual(listed[0].tabRef, "1")
  assert.deepEqual(plain(f.state.queries), [{}])
  assert.equal(f.state.injections, 0)
  assert.equal(f.state.permissionOrigins.length, 0)
  f.context.dispose()
})

test("tab references are opaque, stable per document and replaced after navigation", async () => {
  const f = chromeFixture()
  const first = (await f.context.list()).tabs[0]
  const second = (await f.context.list()).tabs[0]
  assert.equal(second.tabRef, first.tabRef)
  assert.match(first.tabRef, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  f.notify(4, { status: "loading" })
  const afterNavigation = (await f.context.list()).tabs[0]
  assert.notEqual(afterNavigation.tabRef, first.tabRef)
  const other = chromeFixture()
  assert.notEqual((await other.context.list()).tabs[0].tabRef, first.tabRef)
  f.context.dispose()
  other.context.dispose()
})

test("listing is capped at one hundred tabs", async () => {
  const tabs = Array.from({ length: 120 }, (_, index) => ({ id: index + 1, windowId: 1, url: `https://page-${index}.example/`, title: `Page ${index}`, status: "complete" }))
  const f = chromeFixture({
    tabs: () => tabs,
    frame: (details) => ({ frameId: 0, documentLifecycle: "active", documentId: `document-${details.tabId}`, url: tabs.find((tab) => tab.id === details.tabId).url }),
  })
  const { tabs: listed } = await f.context.list()
  assert.equal(listed.length, 100)
  assert.equal(new Set(listed.map((tab) => tab.tabRef)).size, 100)
  f.context.dispose()
})

test("capture injects only into the selected document and returns bounded text", async () => {
  const f = chromeFixture()
  const target = (await f.context.list()).tabs[0]
  assert.equal(f.state.injections, 0)
  const result = await f.context.capture(target)
  assert.equal(result.text, "Page text")
  assert.equal(result.tabRef, target.tabRef)
  assert.equal(result.documentId, target.documentId)
  assert.equal(result.screenshot, undefined)
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)))
  assert.deepEqual(plain(f.state.targets), [{ tabId: 4, documentIds: ["document-one"] }])
  assert.deepEqual(plain(f.state.permissionOrigins), [["https://example.com/*"], ["https://example.com/*"]])
  await assert.rejects(f.context.capture({ ...target, documentId: "other" }), { message: "navigation-changed" })
  assert.equal(f.state.injections, 1)
  f.context.dispose()
})

test("capture refuses unknown references, expired leases and cancelled preflight before injecting", async () => {
  const f = chromeFixture()
  const target = (await f.context.list()).tabs[0]
  await assert.rejects(f.context.capture({ tabRef: "unknown", url: "https://example.com/", documentId: "document-one" }), { message: "unavailable" })
  await assert.rejects(f.context.capture({ ...target, tabRef: "stale" }), { message: "unavailable" })
  await assert.rejects(f.context.capture(target, { expiresAt: Date.now() - 1, isActive: () => true }), { message: "unavailable" })
  await assert.rejects(f.context.capture(target, { expiresAt: Date.now() + 15000, isActive: () => false }), { message: "unavailable" })
  assert.equal(f.state.injections, 0)
  assert.equal(f.state.permissionOrigins.length, 0)
  const expired = vm.runInNewContext(`(${client.extractDocumentText.toString()})(1)`, {
    Date,
    location: { href: "https://example.com/" },
    document: { title: "Page", body: {} },
  })
  assert.equal(expired.text, "")
  f.context.dispose()
})

test("capture rejects permission denial, revocation, closure and navigation", async () => {
  const expected = { denied: "permission-denied", revoked: "permission-denied", closed: "tab-closed", document: "navigation-changed", navigation: "navigation-changed", url: "navigation-changed", incognito: "unavailable", loading: "navigation-changed", pending: "navigation-changed" }
  for (const [mode, code] of Object.entries(expected)) {
    const f = chromeFixture()
    const target = (await f.context.list()).tabs[0]
    if (mode === "denied") f.state.allowed = false
    if (mode === "url") f.state.tab = { ...f.state.tab, url: "https://elsewhere.test/" }
    if (mode === "incognito") f.state.tab = { ...f.state.tab, incognito: true }
    if (mode === "loading") f.state.tab = { ...f.state.tab, status: "loading" }
    if (mode === "pending") f.state.tab = { ...f.state.tab, pendingUrl: "https://example.com/next" }
    f.state.afterInject = () => {
      if (mode === "revoked") f.state.allowed = false
      if (mode === "closed") f.state.tab = null
      if (mode === "document") f.state.document = "new-document"
      if (mode === "navigation") f.notify(4, { url: "https://example.com/" })
    }
    await assert.rejects(f.context.capture(target), { message: code }, mode)
    if (["denied", "url", "incognito", "loading", "pending"].includes(mode)) assert.equal(f.state.injections, 0, mode)
    f.context.dispose()
  }
})

test("capture maps empty, oversized, truncated and failed extractions to their codes", async () => {
  const f = chromeFixture()
  const target = (await f.context.list()).tabs[0]
  f.state.text = "   "
  await assert.rejects(f.context.capture(target), { message: "empty-text" })
  f.state.text = "x".repeat(24001)
  await assert.rejects(f.context.capture(target), { message: "capture-failed" })
  f.state.text = "x".repeat(24000)
  f.state.truncated = true
  const truncated = await f.context.capture(target)
  assert.equal(truncated.text.length, 24000)
  assert.equal(truncated.truncated, true)
  f.context.dispose()

  const failed = chromeFixture()
  const failedTarget = (await failed.context.list()).tabs[0]
  failed.state.injectError = true
  await assert.rejects(failed.context.capture(failedTarget), { message: "capture-failed" })
  failed.context.dispose()

  const moved = chromeFixture()
  const movedTarget = (await moved.context.list()).tabs[0]
  moved.state.document = "other-document"
  await assert.rejects(moved.context.capture(movedTarget), { message: "navigation-changed" })
  moved.context.dispose()
})

test("extraction skips form controls, script, frames, hidden subtrees and closed details", () => {
  const contained = []
  const details = element("DETAILS")
  const summary = element("SUMMARY", { parent: details, contains: contained })
  const collapsed = element("SPAN", { parent: details })
  details.children.push(summary)
  const summaryText = textNode("visible-summary", summary)
  contained.push(summaryText)
  const nodes = [
    textNode("visible", element("P")),
    textNode("input-secret", element("INPUT")),
    textNode("textarea-secret", element("TEXTAREA")),
    textNode("select-secret", element("SELECT")),
    textNode("option-secret", element("OPTION")),
    textNode("script-secret", element("SCRIPT")),
    textNode("style-secret", element("STYLE")),
    textNode("noscript-secret", element("NOSCRIPT")),
    textNode("template-secret", element("TEMPLATE")),
    textNode("iframe-secret", element("IFRAME")),
    textNode("object-secret", element("OBJECT")),
    textNode("embed-secret", element("EMBED")),
    textNode("hidden-secret", element("P", { hidden: true })),
    textNode("aria-secret", element("P", { ariaHidden: "true" })),
    textNode("inert-secret", element("P", { attributes: ["inert"] })),
    textNode("display-secret", element("P", { variant: "invisible" })),
    textNode("opacity-secret", element("P", { variant: "transparent" })),
    textNode("visibility-secret", element("P", { variant: "collapsed" })),
    textNode("content-secret", element("P", { variant: "unpainted" })),
    summaryText,
    textNode("collapsed-secret", collapsed),
    textNode("open-details", element("DETAILS", { attributes: ["open"] })),
  ]
  const result = extractor(nodes)
  assert.equal(result.text, "visible visible-summary open-details")
  assert.equal(result.truncated, false)
  assert.equal(result.url, "https://example.com/")
  assert.equal(result.title, "Title")

  const empty = extractor([textNode("   ", element("P"))], { body: null })
  assert.equal(empty.text, "")
})

test("extraction truncates at twenty-four thousand characters", () => {
  const result = extractor([textNode("Visible "), textNode("x".repeat(25000))])
  assert.equal(result.text.length, 24000)
  assert.equal(result.text.startsWith("Visible "), true)
  assert.equal(result.truncated, true)
  const wide = extractor([textNode("界".repeat(30000))])
  assert.equal(wide.text.length, 24000)
  assert.equal(wide.truncated, true)
})

function optionsPage(options = {}) {
  const elements = new Map()
  const windowHandlers = new Map()
  const timers = []
  const permissionRequests = []
  const connections = []
  const calls = { list: 0, dispose: 0, begin: 0, tick: 0, stop: 0, request: 0 }
  const instances = options.instances ?? [{ baseUrl: "http://127.0.0.1:39240", status: { app: "opencode-chrome-annotation", instanceId: "instance", directory: "repo" } }]
  const tabs = options.tabs ?? [{ tabRef: "ref", url: "https://example.com/", documentId: "document-one", title: "Page", windowId: "1" }]
  const ticks = options.ticks ?? (() => ({ paired: false, expiresAt: 301000 }))
  const disabledByDefault = new Set(["connect", "disconnect", "grant"])

  function element(id) {
    if (elements.has(id)) return elements.get(id)
    const listeners = new Map()
    const value = {
      id,
      textContent: id === "status" ? "Finding local instances…" : "",
      value: "",
      disabled: disabledByDefault.has(id),
      children: [],
      replaceChildren(...children) {
        value.children = children
        value.value = children.length ? children[0].value : ""
      },
      addEventListener: (type, handler) => listeners.set(type, handler),
      fire: (type) => (listeners.has(type) ? listeners.get(type)() : undefined),
    }
    elements.set(id, value)
    return value
  }

  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: (specifier) => {
      if (specifier === "./server-api.js") {
        return {
          discoverInstances: async () => {
            if (options.discoveryError) throw new Error("offline")
            return instances
          },
        }
      }
      if (specifier === "./tab-context.js") {
        return {
          createChromeContext: () => ({
            list: async () => {
              calls.list += 1
              return { tabs }
            },
            dispose: () => {
              calls.dispose += 1
            },
          }),
          createContextConnection: (endpoint, context) => {
            const connection = options.connection
              ? options.connection(endpoint, context, calls)
              : {
                  begin: async () => {
                    calls.begin += 1
                    return { code: "12345678", expiresAt: 61000, connectionId: "connection" }
                  },
                  tick: async () => {
                    calls.tick += 1
                    return ticks()
                  },
                  stop: () => {
                    calls.stop += 1
                  },
                }
            connections.push({ endpoint, context, connection })
            return connection
          },
        }
      }
      throw new Error(`unexpected import ${specifier}`)
    },
    document: {
      getElementById: (id) => element(id),
      createElement: () => ({ value: "", textContent: "" }),
    },
    window: {
      addEventListener: (type, handler) => windowHandlers.set(type, handler),
    },
    chrome: {
      permissions: {
        request: async (details) => {
          calls.request += 1
          permissionRequests.push(details)
          return options.granted ?? true
        },
      },
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay, cleared: false })
      return timers.length
    },
    clearTimeout: (id) => {
      const timer = timers[id - 1]
      if (timer) timer.cleared = true
    },
    URL,
    console,
  }
  vm.runInNewContext(transpile("../extension-src/options.ts"), sandbox)

  return {
    calls,
    timers,
    connections,
    permissionRequests,
    windowHandlers,
    element,
    ready: flush,
    fire: async (id, type) => {
      await element(id).fire(type)
      await flush()
    },
    fireWindow: async (type) => {
      await windowHandlers.get(type)()
      await flush()
    },
    runTimer: async (index = timers.length - 1) => {
      assert.ok(timers[index], `timer ${index} is missing`)
      await timers[index].fn()
      await flush()
    },
    labels: (id) => element(id).children.map((item) => item.value),
  }
}

test("options page discovers instances and sites without permission or page text", async () => {
  const page = optionsPage()
  await page.ready()
  assert.deepEqual(page.labels("instance"), ["http://127.0.0.1:39240"])
  assert.deepEqual(page.labels("site"), ["https://example.com/*"])
  assert.equal(page.element("instance").children[0].textContent, "repo · http://127.0.0.1:39240")
  assert.equal(page.element("connect").disabled, false)
  assert.equal(page.element("grant").disabled, false)
  assert.equal(page.element("disconnect").disabled, true)
  assert.equal(page.element("status").textContent, "Choose an instance and get a pairing code. Site permission is a separate action.")
  assert.equal(page.element("code").textContent, "")
  assert.equal(page.calls.list, 1)
  assert.equal(page.calls.dispose, 1)
  assert.equal(page.calls.begin, 0)
  assert.equal(page.calls.request, 0)
  assert.equal(page.connections.length, 0)
})

test("options page shows the plugin code, begins once per connection and polls every 500 ms", async () => {
  const page = optionsPage()
  await page.ready()
  await page.fire("connect", "click")
  assert.equal(page.calls.begin, 1)
  assert.equal(page.element("code").textContent, "12345678")
  assert.equal(page.element("status").textContent, "Waiting for pairing. Enter the code in the composer within 60 seconds.")
  assert.equal(page.element("disconnect").disabled, false)
  assert.equal(page.element("instance").disabled, true)
  assert.equal(page.element("connect").disabled, true)
  assert.equal(page.timers.length, 1)
  assert.equal(page.timers[0].delay, 500)
  assert.equal(page.calls.tick, 1)

  await page.fire("connect", "click")
  assert.equal(page.calls.begin, 1)
  assert.equal(page.connections.length, 1)

  await page.runTimer()
  assert.equal(page.calls.tick, 2)
  assert.equal(page.timers.length, 2)
  assert.equal(page.timers[1].delay, 500)
  assert.equal(page.element("code").textContent, "12345678")
  assert.equal(page.calls.request, 0)
})

test("options page clears the code once the composer pairs", async () => {
  let polls = 0
  const page = optionsPage({ ticks: () => ({ paired: polls++ > 0, expiresAt: 301000 }) })
  await page.ready()
  await page.fire("connect", "click")
  assert.equal(page.element("code").textContent, "12345678")
  await page.runTimer()
  assert.equal(page.element("code").textContent, "")
  assert.equal(page.element("status").textContent, "Connected. Select a Chrome tab in the composer to capture its text.")
})

test("options page requests site permission only from the explicit button", async () => {
  const page = optionsPage()
  await page.ready()
  await page.fire("connect", "click")
  await page.runTimer()
  await page.runTimer()
  assert.equal(page.calls.request, 0)
  assert.equal(page.permissionRequests.length, 0)

  await page.fire("grant", "click")
  assert.equal(page.calls.request, 1)
  assert.deepEqual(plain(page.permissionRequests[0]), { origins: ["https://example.com/*"] })
  assert.equal(page.element("status").textContent, "Site permission granted. Text is captured only after a composer selection.")
  assert.equal(page.element("grant").disabled, false)

  page.element("site").value = "https://unknown.example/*"
  await page.fire("grant", "click")
  assert.equal(page.calls.request, 1)
})

test("options page reports a denied site permission without capturing anything", async () => {
  const page = optionsPage({ granted: false })
  await page.ready()
  await page.fire("grant", "click")
  assert.equal(page.calls.request, 1)
  assert.equal(page.element("status").textContent, "Site permission denied. Capture remains blocked for this site.")
  assert.equal(page.calls.list, 1)
  assert.equal(page.connections.length, 0)
})

test("options page disconnects on the button and when the page is hidden", async () => {
  const page = optionsPage()
  await page.ready()
  await page.fire("connect", "click")
  await page.fire("disconnect", "click")
  assert.equal(page.calls.stop, 1)
  assert.equal(page.element("code").textContent, "")
  assert.equal(page.element("disconnect").disabled, true)
  assert.equal(page.element("instance").disabled, false)
  assert.equal(page.element("status").textContent, "Disconnected. No context is shared.")
  assert.equal(page.timers[0].cleared, true)

  const hidden = optionsPage()
  await hidden.ready()
  await hidden.fire("connect", "click")
  assert.equal(hidden.windowHandlers.has("pagehide"), true)
  await hidden.fireWindow("pagehide")
  assert.equal(hidden.calls.stop, 1)
  assert.equal(hidden.element("code").textContent, "")
  assert.equal(hidden.timers.every((timer) => timer.cleared), true)
})

test("options page keeps a failed pairing and a failed discovery explicit", async () => {
  const page = optionsPage({
    connection: (endpoint, context, calls) => ({
      begin: async () => {
        throw errorIn("unavailable")
      },
      tick: async () => ({ paired: false, expiresAt: 301000 }),
      stop: () => {
        calls.stop += 1
      },
    }),
  })
  await page.ready()
  await page.fire("connect", "click")
  assert.equal(page.calls.stop, 1)
  assert.equal(page.element("code").textContent, "")
  assert.equal(page.element("status").textContent, "Pairing unavailable. Confirm the trusted extension Origin is configured for this instance, then reconnect.")
  assert.equal(page.element("disconnect").disabled, true)
  assert.equal(page.element("connect").disabled, false)

  const offline = optionsPage({ discoveryError: true })
  await offline.ready()
  assert.equal(offline.element("status").textContent, "Discovery unavailable. Refresh to try again.")
  assert.equal(offline.element("connect").disabled, true)
  assert.equal(offline.calls.dispose, 1)
  assert.equal(offline.calls.request, 0)
})

test("the recovered client pairs with this repository's bridge and returns metadata then capture", async () => {
  const bridgeExports = {}
  const bridgeFile = new URL("../src/tab-context.ts", import.meta.url)
  assert.ok(existsSync(bridgeFile), "src/tab-context.ts is missing")
  vm.runInNewContext(transpile("../src/tab-context.ts"), {
    exports: bridgeExports,
    module: { exports: bridgeExports },
    require: createRequire(import.meta.url),
    Buffer,
    URL,
    Date,
    TextEncoder,
    AbortSignal,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    console,
  })
  const origin = `chrome-extension://${"a".repeat(32)}`
  const adapter = "http://127.0.0.1:5173"
  const bridge = bridgeExports.createTabContextBridge({ instanceId: "instance", directory: "/repo", extensionOrigins: [origin], adapterOrigins: [adapter] })
  const server = createServer((request, response) => {
    void bridge.handle(request, response)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const f = chromeFixture()
  const connection = client.createContextConnection({ baseUrl: "http://127.0.0.1:39240", instanceId: "instance" }, f.context, (url, init) =>
    fetch(url.replace("http://127.0.0.1:39240", base), { ...init, headers: { ...init.headers, Origin: origin } })
  )
  async function call(route, fields, capability) {
    const response = await fetch(`${base}/tab-context/v1/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: adapter, ...(capability ? { "X-Tab-Context-Capability": capability } : {}) },
      body: JSON.stringify({ version: 1, instanceId: "instance", ...fields }),
    })
    assert.ok(response.ok, `${route}: ${response.status}`)
    return response.json()
  }
  try {
    const begin = await connection.begin()
    assert.equal((await connection.tick()).paired, false)
    const paired = await call("pair", { code: begin.code })
    const listed = await call("request", { connectionId: paired.connectionId, kind: "list", draft }, paired.capability)
    await connection.tick()
    await connection.settle()
    const list = await call("result", { connectionId: paired.connectionId, requestId: listed.requestId }, paired.capability)
    assert.equal(list.status, "ok")
    assert.equal(list.result.tabs.length, 1)
    assert.equal(f.state.injections, 0)
    const { tabRef, url, documentId } = list.result.tabs[0]
    const captured = await call("request", { connectionId: paired.connectionId, kind: "capture", draft, target: { tabRef, url, documentId } }, paired.capability)
    await connection.tick()
    await connection.settle()
    const result = await call("result", { connectionId: paired.connectionId, requestId: captured.requestId }, paired.capability)
    assert.equal(result.status, "ok")
    assert.equal(result.result.text, "Page text")
    assert.equal(f.state.injections, 1)
  } finally {
    connection.stop()
    bridge.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
