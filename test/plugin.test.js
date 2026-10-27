import assert from "node:assert/strict"
import { readFile, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Host } from "@opencode/plugin/host"
import plugin from "../dist/plugin.js"

function createMockContext() {
  const tools = new Map()
  const prompts = []
  const sessions = [
    { id: "session-old", title: "Older session", time: { created: 1, updated: 1 }, location: { directory: process.cwd() } },
    { id: "target-session", title: "Target session", time: { created: 2, updated: 2 }, location: { directory: process.cwd() } },
    { id: "foreign-session", title: "Foreign session", time: { created: 3, updated: 3 }, location: { directory: `${process.cwd()}/foreign` } },
  ]
  const eventWaiters = []
  let eventSignal
  let toolDisposed = false
  let subscriptionStarted
  const subscribed = new Promise((resolve) => {
    subscriptionStarted = resolve
  })

  const context = {
    location: { directory: process.cwd() },
    session: {
      async list({ directory }) {
        assert.equal(directory, process.cwd())
        return {
          data: sessions.filter((session) => session.location.directory === directory),
          cursor: {},
        }
      },
      async get({ sessionID }) {
        const session = sessions.find((session) => session.id === sessionID)
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
            toolDisposed = true
            tools.clear()
          },
        }
      },
    },
    event: {
      async *subscribe({ signal }) {
        eventSignal = signal
        subscriptionStarted()
        while (!signal.aborted) {
          const event = await new Promise((resolve) => {
            const waiter = (value) => {
              signal.removeEventListener("abort", onAbort)
              resolve(value)
            }
            const onAbort = () => {
              const index = eventWaiters.indexOf(waiter)
              if (index !== -1) eventWaiters.splice(index, 1)
              resolve(null)
            }
            eventWaiters.push(waiter)
            signal.addEventListener("abort", onAbort, { once: true })
          })
          if (!event) return
          yield event
        }
      },
    },
  }

  return {
    context,
    tools,
    prompts,
    sessions,
    get eventSignal() {
      return eventSignal
    },
    get toolDisposed() {
      return toolDisposed
    },
    subscribed,
    async emit(event) {
      const waiter = eventWaiters.shift()
      assert.ok(waiter, "event subscription is waiting for an event")
      waiter(event)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (eventWaiters.length) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.fail("event subscription did not finish processing")
    },
  }
}

async function request(baseUrl, path, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForStatus(baseUrl, predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(baseUrl, "/status")
    if (predicate(response.body)) return response.body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("plugin status did not reach the expected state")
}

test("built V2 plugin serves the extension protocol and cleans up on reload", async () => {
  const entrypoints = Host.resolve({ directory: fileURLToPath(new URL("../", import.meta.url)) })
  assert.ok(entrypoints.server)
  const loaded = await Host.load(entrypoints.server)
  assert.equal(loaded.default, plugin)
  assert.equal(plugin.id, "opencode-chrome-annotation")
  assert.equal(typeof plugin.setup, "function")

  const first = createMockContext()
  const firstCleanup = await plugin.setup(first.context)
  let screenshotPath
  let statusUrl
  let firstInstanceId

  try {
    await first.subscribed
    const tool = first.tools.get("chrome_status")
    assert.ok(tool)

    const toolStatus = JSON.parse((await tool.execute({})).content)
    firstInstanceId = toolStatus.instanceId
    assert.equal(toolStatus.server.status, "listening")
    assert.equal(toolStatus.server.host, "127.0.0.1")
    assert.ok(toolStatus.server.port >= 39240 && toolStatus.server.port <= 39260)
    statusUrl = `http://127.0.0.1:${toolStatus.server.port}`

    const sessions = await request(statusUrl, "/sessions")
    assert.equal(sessions.status, 200)
    assert.deepEqual(sessions.body.sessions, [
      {
        id: "target-session",
        title: "Target session",
        directory: process.cwd(),
        status: "open",
      },
    ])

    await first.emit({ type: "session.viewed", location: first.context.location, data: { sessionID: "target-session", idle: 0 } })
    const activeStatus = await waitForStatus(
      statusUrl,
      (value) => value.opencodeSessionId === "target-session"
    )
    assert.equal(activeStatus.label, "Target session")

    const claim = await request(statusUrl, "/claim", "POST", {
      tabId: 17,
      sessionId: "target-session",
      extensionVersion: "1.2.3",
    })
    assert.equal(claim.status, 200)
    assert.deepEqual(claim.body, { ok: true, sessionId: "target-session" })

    const annotation = await request(statusUrl, "/annotation", "POST", {
      tabId: 17,
      sessionId: "target-session",
      extensionVersion: "1.2.3",
      annotation: {
        comment: "Check this element",
        page: { title: "Example page", url: "https://example.test" },
        element: { tag: "button", selector: "#submit" },
        screenshot: { dataUrl: "data:image/png;base64,SGVsbG8=" },
      },
    })
    assert.equal(annotation.status, 200)
    assert.deepEqual(annotation.body, { ok: true, sessionId: "target-session" })
    assert.equal(first.prompts.length, 1)
    assert.equal(first.prompts[0].sessionID, "target-session")
    assert.match(first.prompts[0].text, /Check this element/)
    assert.equal(first.prompts[0].files.length, 1)
    screenshotPath = fileURLToPath(first.prompts[0].files[0].uri)
    assert.equal(first.prompts[0].files[0].name, screenshotPath.split(/[\\/]/).at(-1))
    assert.deepEqual(await readFile(screenshotPath), Buffer.from("Hello"))

    const claimedStatus = await request(statusUrl, "/status")
    assert.equal(claimedStatus.body.claims[0].tabId, 17)
    assert.equal(claimedStatus.body.lastExtensionVersion, "1.2.3")
    assert.equal(claimedStatus.body.lastAnnotation.ok, true)
    assert.equal(claimedStatus.body.lastAnnotation.transport, "session.prompt")

    const invalidClaim = await request(statusUrl, "/claim", "POST", { sessionId: "target-session" })
    assert.equal(invalidClaim.status, 400)
    assert.equal(invalidClaim.body.ok, false)

    const unclaim = await request(statusUrl, "/unclaim", "POST", { tabId: 17 })
    assert.equal(unclaim.status, 200)
    assert.deepEqual(unclaim.body, { ok: true })
    assert.deepEqual((await request(statusUrl, "/status")).body.claims, [])
  } finally {
    await firstCleanup()
    if (screenshotPath) await unlink(screenshotPath).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  assert.equal(first.eventSignal.aborted, true)
  assert.equal(first.toolDisposed, true)
  await assert.rejects(request(statusUrl, "/status"))

  const second = createMockContext()
  const secondCleanup = await plugin.setup(second.context)
  try {
    await second.subscribed
    const toolStatus = JSON.parse((await second.tools.get("chrome_status").execute({})).content)
    assert.notEqual(toolStatus.instanceId, firstInstanceId)
    assert.deepEqual(toolStatus.claims, [])
  } finally {
    await secondCleanup()
  }
  assert.equal(second.eventSignal.aborted, true)
  assert.equal(second.toolDisposed, true)
})

async function withRuntime(run) {
  const mock = createMockContext()
  const cleanup = await plugin.setup(mock.context)
  try {
    await mock.subscribed
    const status = JSON.parse((await mock.tools.get("chrome_status").execute({})).content)
    await run(mock, `http://127.0.0.1:${status.port}`)
  } finally {
    await cleanup()
  }
}

test("viewing an older local session selects it instead of the newest", async () => {
  await withRuntime(async (mock, baseUrl) => {
    assert.equal((await request(baseUrl, "/sessions")).body.sessions[0].id, "target-session")
    await mock.emit({ type: "session.viewed", location: mock.context.location, data: { sessionID: "session-old", idle: 0 } })
    assert.equal((await request(baseUrl, "/sessions")).body.sessions[0].id, "session-old")
  })
})

for (const location of [undefined, { directory: `${process.cwd()}/foreign` }, { directory: process.cwd(), workspaceID: "foreign-workspace" }]) {
  test(`foreign session view cannot select a target with location ${JSON.stringify(location)}`, async () => {
    await withRuntime(async (mock, baseUrl) => {
      await mock.emit({ type: "session.viewed", location: mock.context.location, data: { sessionID: "session-old", idle: 0 } })
      await mock.emit({ type: "session.renamed", location, data: { sessionID: "foreign-session", title: "Cached foreign title" } })
      await mock.emit({ type: "session.viewed", location, data: { sessionID: "foreign-session", idle: 0 } })
      assert.equal((await request(baseUrl, "/status")).body.opencodeSessionId, "session-old")
      assert.equal((await request(baseUrl, "/sessions")).body.sessions[0].id, "session-old")
    })
  })
}

for (const type of ["session.deleted", "session.archived"]) {
  test(`${type} clears the active session and excludes it from selection`, async () => {
    await withRuntime(async (mock, baseUrl) => {
      await mock.emit({ type: "session.viewed", location: mock.context.location, data: { sessionID: "session-old", idle: 0 } })
      const index = mock.sessions.findIndex((session) => session.id === "session-old")
      if (type === "session.deleted") mock.sessions.splice(index, 1)
      else mock.sessions[index].time.archived = Date.now()
      await mock.emit({ type, location: mock.context.location, data: { sessionID: "session-old" } })
      assert.equal((await request(baseUrl, "/status")).body.opencodeSessionId, null)
      assert.equal((await request(baseUrl, "/sessions")).body.sessions[0].id, "target-session")
    })
  })
}

test("a missing active session is not reconstructed from a cached title", async () => {
  await withRuntime(async (mock, baseUrl) => {
    await mock.emit({ type: "session.viewed", location: mock.context.location, data: { sessionID: "session-old", idle: 0 } })
    mock.sessions.splice(mock.sessions.findIndex((session) => session.id === "session-old"), 1)
    assert.equal((await request(baseUrl, "/sessions")).body.sessions[0].id, "target-session")
  })
})

test("annotation uses the selected older local session and preserves screenshot files", async () => {
  await withRuntime(async (mock, baseUrl) => {
    let screenshotPath
    try {
      await mock.emit({ type: "session.viewed", location: mock.context.location, data: { sessionID: "session-old", idle: 0 } })
      await mock.emit({ type: "session.viewed", location: mock.sessions[2].location, data: { sessionID: "foreign-session", idle: 0 } })
      const selected = (await request(baseUrl, "/sessions")).body.sessions[0]
      assert.equal(selected.id, "session-old")
      const response = await request(baseUrl, "/annotation", "POST", {
        tabId: 18,
        sessionId: selected.id,
        annotation: {
          comment: "Older local target",
          screenshot: { dataUrl: "data:image/png;base64,SGVsbG8=" },
        },
      })
      assert.equal(response.status, 200)
      assert.equal(mock.prompts.length, 1)
      assert.equal(mock.prompts[0].sessionID, "session-old")
      assert.match(mock.prompts[0].text, /Older local target/)
      assert.equal(mock.prompts[0].files.length, 1)
      screenshotPath = fileURLToPath(mock.prompts[0].files[0].uri)
      assert.equal(mock.prompts[0].files[0].name, screenshotPath.split(/[\\/]/).at(-1))
      assert.deepEqual(await readFile(screenshotPath), Buffer.from("Hello"))
    } finally {
      if (screenshotPath) await unlink(screenshotPath)
    }
  })
})
