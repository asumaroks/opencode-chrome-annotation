import assert from "node:assert/strict"
import { readFile, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"
import plugin from "../dist/plugin.js"

function createMockContext() {
  const tools = new Map()
  const prompts = []
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
          data: [
            {
              id: "session-old",
              title: "Older session",
              time: { created: 1, updated: 1 },
              location: { directory },
            },
            {
              id: "target-session",
              title: "Target session",
              time: { created: 2, updated: 2 },
              location: { directory },
            },
          ],
          cursor: {},
        }
      },
      async get({ sessionID }) {
        return { id: sessionID, title: "Target session" }
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
    get eventSignal() {
      return eventSignal
    },
    get toolDisposed() {
      return toolDisposed
    },
    subscribed,
    emit(event) {
      const waiter = eventWaiters.shift()
      assert.ok(waiter, "event subscription is waiting for an event")
      waiter(event)
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

    first.emit({ type: "session.viewed", data: { sessionID: "target-session" } })
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
