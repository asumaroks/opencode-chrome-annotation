import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { after, test } from "node:test"
import { createTabContextBridge } from "../dist/plugin.js"
import {
  createBridgeMentionClient,
  createTabContextClient,
  normalizeTrustedOrigin,
} from "../integrations/openchamber/bridge-client.mjs"
import { createDraftController } from "../integrations/openchamber/draft-controller.mjs"
import { createChromeMentionAdapter } from "../integrations/openchamber/index.mjs"
import {
  createChromeRows,
  createMentionLayout,
  deriveMentionQuery,
  filterChromeRows,
  mentionIndexAt,
  ROW_KIND,
} from "../integrations/openchamber/mention-source.mjs"
import {
  ADAPTER_API,
  ADAPTER_SEAMS,
  PATCH_MANIFEST,
  SEAM_CONTRACT,
  applyPatch,
  applyPatches,
  mentionMenuPatches,
  orderedPatches,
} from "../integrations/openchamber/patch-manifest.mjs"
import {
  countOccurrences,
  patchDelta,
  verifyAssetBytes,
} from "../scripts/verify-openchamber-patch-manifest.mjs"

const adapterOrigin = "http://127.0.0.1:5173"
const foreignOrigin = "http://127.0.0.1:5199"
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`
const draft = { runtimeKey: "runtime", directory: "/repo", sessionId: null, draftId: "draft-one", generation: 0 }
const target = { tabRef: "tab-ref", url: "https://example.com/page", documentId: "document-one" }
const captureResult = { ...target, title: "Example page", text: "Page text", capturedAt: "2026-10-27T20:00:00.000Z", truncated: false }
const tabA = { tabRef: "tab-a", url: "https://example.com/docs", documentId: "document-a", title: "Example docs", windowId: "1" }
const tabB = { tabRef: "tab-b", url: "https://other.test/page", documentId: "document-b", title: "Unrelated page", windowId: "2" }

function composerSeam(initial) {
  const state = { ...initial }
  const edits = []
  return {
    read: () => ({ ...state }),
    set: update => Object.assign(state, update),
    state,
    edits,
    editRange(from, to, insert) {
      edits.push([from, to, insert])
      state.text = state.text.slice(0, from) + insert + state.text.slice(to)
      state.from = from + insert.length
      state.to = from + insert.length
    },
  }
}

function baseComposer(overrides = {}) {
  return composerSeam({
    runtimeKey: "runtime",
    directory: "/repo",
    sessionId: null,
    draftId: "draft-one",
    sessionKey: "draft",
    generation: 0,
    text: "@",
    from: 0,
    to: 1,
    ...overrides,
  })
}

function captureOf(row) {
  return { tabRef: row.tabRef, url: row.url, documentId: row.documentId, title: "Captured page", text: "Page text", capturedAt: "2026-10-27T20:00:00.000Z", truncated: false }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function drain(rounds = 40) {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve))
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail("the expected adapter state did not settle in time")
}

function adapterWith(composer, client, extra = {}) {
  return createChromeMentionAdapter({
    client,
    readComposer: composer.read,
    addDraft: () => "draft-id",
    editRange: composer.editRange,
    ...extra,
  })
}

test("chrome rows keep the native index space and filter by title and URL", async () => {
  const rows = createChromeRows([tabA, { ...tabB, title: "" }])
  assert.deepEqual(rows.map(row => [row.kind, row.title, row.description]), [
    [ROW_KIND.tab, "Example docs", "https://example.com/docs"],
    [ROW_KIND.tab, "https://other.test/page", "https://other.test/page"],
  ])
  assert.deepEqual(filterChromeRows(rows, "DOCS").map(row => row.tabRef), ["tab-a"])
  assert.deepEqual(filterChromeRows(rows, "other").map(row => row.tabRef), ["tab-b"])
  assert.deepEqual(filterChromeRows(rows, "   ").map(row => row.tabRef), ["tab-a", "tab-b"])
  const layout = createMentionLayout({ agents: 2, openFiles: 1, searchedFiles: 3, sessions: 4 }, rows)
  assert.equal(layout.nativeCount, 10)
  assert.equal(layout.chromeStart, layout.nativeCount)
  assert.equal(layout.count, 12)
  assert.deepEqual(mentionIndexAt(layout, 0), { kind: "agent", index: 0 })
  assert.deepEqual(mentionIndexAt(layout, 2), { kind: "openFile", index: 0 })
  assert.deepEqual(mentionIndexAt(layout, 3), { kind: "searchedFile", index: 0 })
  assert.deepEqual(mentionIndexAt(layout, 6), { kind: "session", index: 0 })
  assert.deepEqual(mentionIndexAt(layout, layout.chromeStart), { kind: "chrome", index: 0 })
  assert.deepEqual(mentionIndexAt(layout, layout.count - 1), { kind: "chrome", index: 1 })
  assert.equal(mentionIndexAt(layout, layout.count), null)
  assert.deepEqual(deriveMentionQuery("before @chr after", 11), { from: 7, query: "chr" })
  assert.equal(deriveMentionQuery("before @chr after", 17), null)
  assert.equal(deriveMentionQuery("mail@host", 9), null)

  const composer = baseComposer()
  let lists = 0
  const adapter = adapterWith(composer, {
    isPaired: () => true,
    list: () => {
      lists++
      return Promise.resolve({ tabs: [tabA, tabB] })
    },
    capture: () => Promise.reject(new Error("unused")),
    cancel: () => Promise.resolve(false),
  })
  adapter.rows()
  await drain()
  const live = adapter.rows()
  assert.equal(lists, 1)
  assert.equal(adapter.count(), live.length)
  assert.equal(createMentionLayout({ agents: 1, openFiles: 1, searchedFiles: 1, sessions: 1 }, live).count, 4 + adapter.count())
})

test("the adapter exposes exactly the installed public API", async () => {
  const adapter = createChromeMentionAdapter({})
  assert.deepEqual(Object.keys(adapter).sort(), [...ADAPTER_API].sort())
  assert.deepEqual([...ADAPTER_API], ["init", "rows", "count", "select", "isSendBlocked", "closeMenu", "cancel", "invalidate", "pair", "state", "subscribe", "getSnapshot"])
  for (const name of ADAPTER_SEAMS) assert.equal(typeof SEAM_CONTRACT[name], "object", name)
  assert.deepEqual([...ADAPTER_SEAMS], ["readComposer", "addDraft", "editRange", "removeDraft"])
  for (const name of ["send", "submit", "prompt", "autoSend"]) assert.equal(adapter[name], undefined, name)
  assert.equal(SEAM_CONTRACT.version, 1)
  assert.equal(SEAM_CONTRACT.global, "__octmNative")
})

test("adapter opens the tab menu once per open and never captures without a selection", async () => {
  const composer = baseComposer()
  const lists = []
  let captures = 0
  const adapter = adapterWith(composer, {
    isPaired: () => true,
    list: request => {
      lists.push(request)
      return Promise.resolve({ tabs: [tabA, tabB] })
    },
    capture: () => {
      captures++
      return Promise.resolve(captureResult)
    },
    cancel: () => Promise.resolve(true),
  })
  assert.deepEqual(adapter.rows().map(row => row.kind), [ROW_KIND.loading])
  assert.deepEqual(adapter.rows().map(row => row.kind), [ROW_KIND.loading])
  await drain()
  assert.equal(lists.length, 1)
  assert.deepEqual(lists[0], { kind: "list", draft })
  assert.deepEqual(adapter.rows().map(row => row.kind), [ROW_KIND.tab, ROW_KIND.tab])
  adapter.count()
  adapter.rows()
  await drain()
  assert.equal(lists.length, 1)
  assert.equal(captures, 0)
  assert.equal(adapter.isSendBlocked(), false)
  adapter.closeMenu()
  adapter.rows()
  await drain()
  assert.equal(lists.length, 2)
  assert.equal(captures, 0)
  assert.deepEqual(composer.edits, [])
})

test("adapter filters the tab rows by the live mention query", async () => {
  const composer = baseComposer({ text: "@exa", from: 0, to: 4 })
  let lists = 0
  const adapter = adapterWith(composer, {
    isPaired: () => true,
    list: () => {
      lists++
      return Promise.resolve({ tabs: [tabA, tabB] })
    },
    capture: () => Promise.reject(new Error("unused")),
    cancel: () => Promise.resolve(false),
  })
  adapter.rows()
  await drain()
  assert.deepEqual(adapter.rows().map(row => row.title), ["Example docs"])
  composer.set({ text: "@other", from: 0, to: 6 })
  assert.deepEqual(adapter.rows().map(row => row.tabRef), ["tab-b"])
  composer.set({ text: "mail@host", from: 0, to: 9 })
  assert.deepEqual(adapter.rows(), [])
  await drain()
  composer.set({ text: "@exa", from: 0, to: 4 })
  adapter.rows()
  await drain()
  assert.deepEqual(adapter.rows().map(row => row.title), ["Example docs"])
  assert.equal(lists, 2)
})

test("adapter dispatches every row kind and pauses Send during a capture", async () => {
  const composer = baseComposer()
  const gate = deferred()
  const pairing = []
  const cancels = []
  const drafts = []
  let paired = false
  let captures = 0
  const client = {
    isPaired: () => paired,
    list: () => Promise.resolve({ tabs: [tabA] }),
    capture: request => {
      captures++
      assert.equal(request.kind, "capture")
      return gate.promise
    },
    cancel: requestId => {
      cancels.push(requestId)
      return Promise.resolve(true)
    },
  }
  const adapter = createChromeMentionAdapter({
    client,
    readComposer: composer.read,
    addDraft: () => {
      drafts.push("added")
      return "draft-id"
    },
    editRange: composer.editRange,
    onRequestPairing: () => pairing.push("requested"),
  })
  const connect = adapter.rows()
  assert.deepEqual(connect.map(row => [row.kind, row.disabled]), [[ROW_KIND.connect, false]])
  assert.equal(adapter.select(connect[0]), true)
  assert.deepEqual(pairing, ["requested"])
  assert.equal(adapter.select({ kind: "unknown" }), false)
  assert.equal(adapter.select(null), false)
  paired = true
  adapter.invalidate("paired")
  const loading = adapter.rows()
  assert.deepEqual(loading.map(row => row.kind), [ROW_KIND.loading])
  assert.equal(loading[0].disabled, true)
  assert.equal(adapter.select(loading[0]), false)
  await drain()
  const rows = adapter.rows()
  assert.deepEqual(rows.map(row => row.kind), [ROW_KIND.tab])
  assert.equal(adapter.select(rows[0]), true)
  assert.equal(adapter.isSendBlocked(), true)
  const pending = adapter.rows()
  assert.deepEqual(pending.map(row => [row.kind, row.disabled]), [[ROW_KIND.pending, true], [ROW_KIND.cancel, false]])
  assert.equal(adapter.select(pending[0]), false)
  assert.equal(captures, 1)
  assert.equal(adapter.select(pending[1]), true)
  assert.equal(cancels.length, 1)
  assert.equal(adapter.isSendBlocked(), false)
  gate.resolve(captureOf(tabA))
  await drain()
  assert.deepEqual(drafts, [])
  assert.deepEqual(composer.edits, [])
  paired = true
  const failing = createChromeMentionAdapter({
    client: { isPaired: () => true, list: () => Promise.reject(Object.assign(new Error("nope"), { code: "permission-denied" })), capture: () => Promise.resolve(captureOf(tabA)), cancel: () => Promise.resolve(false) },
    readComposer: composer.read,
    addDraft: () => "draft-id",
    editRange: composer.editRange,
  })
  assert.deepEqual(failing.rows().map(row => row.kind), [ROW_KIND.loading])
  await drain()
  const error = failing.rows().find(row => row.kind === ROW_KIND.error)
  assert.equal(error.code, "permission-denied")
  assert.equal(error.description.includes("https://"), false)
  assert.equal(failing.select(error), false)
  assert.equal(adapter.state().paired, true)
})

test("adapter starts exactly one capture per selection and blocks Send until it settles", async () => {
  const composer = baseComposer()
  const gate = deferred()
  let captures = 0
  const adapter = adapterWith(composer, {
    isPaired: () => true,
    list: () => Promise.resolve({ tabs: [tabA] }),
    capture: request => {
      captures++
      return gate.promise.then(result => ({ ...result, request }))
    },
    cancel: () => Promise.resolve(false),
  })
  adapter.rows()
  await drain()
  const row = adapter.rows()[0]
  assert.equal(adapter.select(row), true)
  assert.equal(adapter.select(row), false)
  assert.equal(captures, 1)
  assert.equal(adapter.isSendBlocked(), true)
  assert.deepEqual(adapter.rows().map(item => item.kind), [ROW_KIND.pending, ROW_KIND.cancel])
  gate.resolve(captureOf(tabA))
  await drain()
  assert.equal(adapter.isSendBlocked(), false)
  assert.deepEqual(composer.edits, [[0, 1, ""]])
  assert.equal(composer.read().text, "")
  assert.equal(adapter.rows().length, 0)
  assert.equal(captures, 1)
})

test("late capture results are discarded at every identity boundary", async () => {
  const boundaries = {
    unchanged: () => {},
    runtimeKey: composer => composer.set({ runtimeKey: "other-runtime" }),
    directory: composer => composer.set({ directory: "/elsewhere" }),
    sessionId: composer => composer.set({ sessionId: "session-one" }),
    draftId: composer => composer.set({ draftId: "draft-two" }),
    text: composer => composer.set({ text: "@other after" }),
    range: composer => composer.set({ to: 3 }),
    generation: composer => composer.set({ generation: 1 }),
  }
  for (const [boundary, mutate] of Object.entries(boundaries)) {
    const composer = baseComposer()
    const gate = deferred()
    const drafts = []
    const adapter = createChromeMentionAdapter({
      client: {
        isPaired: () => true,
        list: () => Promise.resolve({ tabs: [tabA] }),
        capture: () => gate.promise,
        cancel: () => Promise.resolve(false),
      },
      readComposer: composer.read,
      addDraft: () => {
        drafts.push(boundary)
        return "draft-id"
      },
      editRange: composer.editRange,
    })
    adapter.rows()
    await drain()
    adapter.select(adapter.rows()[0])
    mutate(composer)
    gate.resolve(captureOf(tabA))
    await drain()
    const expected = boundary === "unchanged" ? 1 : 0
    assert.equal(drafts.length, expected, boundary)
    assert.equal(composer.edits.length, expected, boundary)
    assert.equal(adapter.isSendBlocked(), false, boundary)
  }
})

test("commit adds the draft first and only then clears the mention range", async () => {
  const composer = baseComposer({ text: "before @chr after", from: 7, to: 11 })
  const order = []
  const scopes = []
  const payloads = []
  const controller = createDraftController({
    client: { list: () => Promise.resolve({ tabs: [tabA] }), capture: () => Promise.resolve(captureOf(tabA)), cancel: () => Promise.resolve(false) },
    readComposer: composer.read,
    addDraft: (scope, payload) => {
      order.push("addDraft")
      scopes.push(scope)
      payloads.push(payload)
      return "capture-id"
    },
    editRange: (from, to, insert) => {
      order.push("editRange")
      composer.editRange(from, to, insert)
    },
  })
  controller.rows()
  await controller.settled()
  controller.select(controller.rows()[0])
  await controller.settled()
  assert.deepEqual(order, ["addDraft", "editRange"])
  assert.deepEqual(scopes, [{ directory: "/repo", sessionKey: "draft" }])
  assert.equal(payloads[0].source, "file")
  assert.equal(payloads[0].fileLabel, "Captured page")
  assert.equal(payloads[0].code, tabA.url)
  assert.equal(payloads[0].language, "text")
  assert.equal(payloads[0].text.includes("Page text"), true)
  assert.equal(payloads[0].text.includes("2026-10-27T20:00:00.000Z"), true)
  assert.equal(payloads[0].text.includes("Truncated: no"), true)
  assert.deepEqual(composer.edits, [[7, 11, ""]])
  assert.equal(composer.read().text, "before  after")
})

test("a null draft id or a rejected range edit leaves the composer text untouched", async () => {
  const nullId = baseComposer()
  const nullController = createDraftController({
    client: { list: () => Promise.resolve({ tabs: [tabA] }), capture: () => Promise.resolve(captureOf(tabA)), cancel: () => Promise.resolve(false) },
    readComposer: nullId.read,
    addDraft: () => null,
    editRange: nullId.editRange,
  })
  nullController.rows()
  await nullController.settled()
  nullController.select(nullController.rows()[0])
  await nullController.settled()
  assert.deepEqual(nullId.edits, [])
  assert.equal(nullId.read().text, "@")
  assert.equal(nullController.rows().find(row => row.kind === ROW_KIND.error).code, "draft-rejected")
  assert.equal(nullController.isSendBlocked(), false)

  const rejecting = baseComposer()
  const removals = []
  const rejectController = createDraftController({
    client: { list: () => Promise.resolve({ tabs: [tabA] }), capture: () => Promise.resolve(captureOf(tabA)), cancel: () => Promise.resolve(false) },
    readComposer: rejecting.read,
    addDraft: () => "capture-id",
    editRange: () => {
      throw new Error("range rejected")
    },
    removeDraft: (scope, id) => removals.push([scope, id]),
  })
  rejectController.rows()
  await rejectController.settled()
  rejectController.select(rejectController.rows()[0])
  await rejectController.settled()
  assert.deepEqual(rejecting.edits, [])
  assert.equal(rejecting.read().text, "@")
  assert.deepEqual(removals, [[{ directory: "/repo", sessionKey: "draft" }, "capture-id"]])
  assert.equal(rejectController.rows().find(row => row.kind === ROW_KIND.error).code, "draft-rejected")
})

test("capture failures surface a fixed error row and never touch the draft", async () => {
  const cases = [
    ["permission-denied", () => Promise.reject(Object.assign(new Error("denied"), { code: "permission-denied" })), "permission-denied"],
    ["navigation-changed", target => Promise.resolve({ ...captureOf(target), documentId: "other-document" }), "navigation-changed"],
    ["empty-text", target => Promise.resolve({ ...captureOf(target), text: "   " }), "empty-text"],
    ["capture-failed", target => Promise.resolve({ ...captureOf(target), capturedAt: "not-a-time" }), "capture-failed"],
    ["unknown code", () => Promise.reject(Object.assign(new Error("odd"), { code: "not-a-code" })), "unavailable"],
  ]
  for (const [name, capture, expected] of cases) {
    const composer = baseComposer()
    const drafts = []
    const adapter = createChromeMentionAdapter({
      client: { isPaired: () => true, list: () => Promise.resolve({ tabs: [tabA] }), capture: request => capture(request.target), cancel: () => Promise.resolve(false) },
      readComposer: composer.read,
      addDraft: () => {
        drafts.push(name)
        return "draft-id"
      },
      editRange: composer.editRange,
    })
    adapter.rows()
    await drain()
    adapter.select(adapter.rows()[0])
    await drain()
    assert.deepEqual(drafts, [], name)
    assert.deepEqual(composer.edits, [], name)
    assert.equal(composer.read().text, "@", name)
    assert.equal(adapter.isSendBlocked(), false, name)
    const error = adapter.rows().find(row => row.kind === ROW_KIND.error)
    assert.equal(error.code, expected, name)
    assert.equal(error.description.includes("https://"), false, name)
  }
})

test("the manifest pins ten unique ordered patches on the pristine 2.5.2 asset", async () => {
  assert.equal(PATCH_MANIFEST.version, "2.5.2")
  assert.equal(PATCH_MANIFEST.sha256, "4f288a1a01526447321b06f40adf7c2625252f570ecdd3afa1fee739ba860da6")
  assert.equal(PATCH_MANIFEST.asset, "assets/useAppFontEffects-DFJQ0O1i.js")
  assert.equal(PATCH_MANIFEST.adapterGlobal, "__octm")
  assert.equal(PATCH_MANIFEST.offsetSpace, "asset")
  assert.equal(PATCH_MANIFEST.patches.length, 10)
  const ids = new Set()
  const orders = []
  for (const patch of PATCH_MANIFEST.patches) {
    assert.equal(ids.has(patch.id), false, `duplicate patch id ${patch.id}`)
    ids.add(patch.id)
    orders.push(patch.order)
    assert.equal(["replace", "insertAfter", "insertBefore"].includes(patch.action), true, `${patch.id}: ${patch.action}`)
    assert.equal(patch.occurrences, 1, `${patch.id} is not pinned to a single marker`)
    assert.equal(typeof patch.purpose, "string")
    assert.equal(patch.purpose.length > 10, true, `${patch.id} has no purpose`)
    assert.equal(["asset", "fragment"].includes(patch.scope), true, `${patch.id}: ${patch.scope}`)
    if (patch.scope === "fragment") assert.equal(patch.fragment, "mentionHandle", patch.id)
    if (patch.scope === "asset") {
      assert.equal(Array.isArray(patch.offsets), true, patch.id)
      assert.equal(patch.offsets.length, 1, patch.id)
      assert.equal(patch.offsets[0] > 0, true, patch.id)
    }
    assert.equal(typeof patch.insert, "string")
    assert.equal(patch.insert.length > 0, true, patch.id)
    assert.equal(patch.insert.includes("__octm"), true, `${patch.id} does not reach the adapter`)
  }
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const keyboard = mentionMenuPatches.map(patch => patch.id)
  assert.equal(keyboard.includes("mention-escape"), true)
  assert.equal(keyboard.includes("mention-dispatch"), true)
  assert.equal(mentionMenuPatches.length, 3)
  assert.equal(PATCH_MANIFEST.patches.filter(patch => patch.insert.includes("globalThis.__octmNative={")).length, 1)
  assert.equal(mentionMenuPatches.every(patch => patch.fragment === "mentionHandle"), true)
})

test("patch application semantics hold on a synthetic source assembled from the markers", async () => {
  const ordered = orderedPatches()
  let source = ""
  const assembled = new Set()
  for (const patch of ordered) {
    if (source.includes(patch.marker)) continue
    source += `${patch.marker}\n`
    assembled.add(patch.id)
  }
  assert.equal(assembled.size, 9)
  assert.equal(assembled.has("composer-send-button"), false)
  for (const patch of ordered) {
    const at = source.indexOf(patch.marker)
    assert.equal(at >= 0, true, `${patch.id} marker is missing`)
    const end = at + patch.marker.length
    const expected = patch.action === "replace"
      ? source.slice(0, at) + patch.insert + source.slice(end)
      : patch.action === "insertAfter"
        ? source.slice(0, end) + patch.insert + source.slice(end)
        : source.slice(0, at) + patch.insert + source.slice(at)
    const single = applyPatch(source, patch)
    assert.equal(single, expected, patch.id)
    assert.equal(single.length - source.length, patchDelta(patch), patch.id)
    if (patch.action === "replace") assert.equal(countOccurrences(single, patch.marker), 0, `${patch.id} left its marker behind`)
  }
  const patched = applyPatches(source)
  const delta = ordered.reduce((total, patch) => total + patchDelta(patch), 0)
  assert.equal(patched.length, source.length + delta)
  assert.equal(patched.includes("__octm.isSendBlocked()"), true)
  assert.equal(patched.includes("__octm.count()"), true)
  assert.equal(patched.includes("const ie=me.length+ke.length+oe.length+ue.length+__octm.count();"), true)
  assert.equal(patched.includes("globalThis.__octmNative={"), true)
  assert.equal(patched.includes("if(J===\"Escape\"){__octm.closeMenu();r();return}"), true)
})

test("a missing marker, an ambiguous marker or a foreign asset is refused", async () => {
  const patch = PATCH_MANIFEST.patches[0]
  assert.throws(() => applyPatch("no markers here", patch), /missing patch marker/)
  assert.throws(() => applyPatch(`${patch.marker}${patch.marker}`, patch), /ambiguous patch marker/)
  assert.throws(() => applyPatch(patch.marker, { ...patch, action: "rewrite" }), /unknown patch action/)
  const foreign = verifyAssetBytes(Buffer.from("module.exports = {}\n"))
  assert.equal(foreign.refused, true)
  assert.equal(foreign.patches.length, 0)
  assert.equal(foreign.problems.some(problem => problem.includes("refusing to verify a different build")), true)
  const tampered = Buffer.concat([Buffer.from("x"), Buffer.from("y")])
  assert.equal(verifyAssetBytes(tampered).sha256.length, 64)
  assert.equal(verifyAssetBytes(tampered).sha256 !== PATCH_MANIFEST.sha256, true)
})

const servers = []
after(async () => {
  for (const { server, bridge } of servers) {
    bridge.close()
    await new Promise(resolve => server.close(resolve))
  }
})

async function bridgeFixture() {
  const bridge = createTabContextBridge({
    instanceId: "instance",
    directory: "/repo",
    adapterOrigins: [adapterOrigin],
    extensionOrigins: [extensionOrigin],
  })
  const server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/tab-context/")) {
      void bridge.handle(req, res)
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ app: "opencode-chrome-annotation", instanceId: "instance", directory: "/repo" }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  servers.push({ server, bridge })
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  function call(route, body = {}, capability, headerOrigin = adapterOrigin) {
    return new Promise((resolve, reject) => {
      const headers = { origin: headerOrigin, "content-type": "application/json" }
      if (capability) headers["x-tab-context-capability"] = capability
      const req = httpRequest({ host: "127.0.0.1", port, path: `/tab-context/v1/${route}`, method: "POST", headers }, res => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", chunk => (data += chunk))
        res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
      })
      req.on("error", reject)
      req.end(JSON.stringify({ version: 1, instanceId: "instance", ...body }))
    })
  }

  async function nextJob(connectionId, capability, kind) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await call("poll", { connectionId }, capability, extensionOrigin)
      assert.equal(polled.status, 200)
      const job = polled.body.jobs.find(item => item.kind === kind)
      if (job) return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`no ${kind} job was delivered to the extension`)
  }

  return { port, origin, call, nextJob }
}

function httpTransport(origin, log) {
  return async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) }
    log.push({ url, headers })
    const target = new URL(url)
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: init.method ?? "GET", headers: { ...headers, origin } },
        res => {
          let data = ""
          res.setEncoding("utf8")
          res.on("data", chunk => (data += chunk))
          res.on("end", () => resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: async () => (data ? JSON.parse(data) : null),
          }))
        }
      )
      req.on("error", reject)
      req.end(typeof init.body === "string" ? init.body : undefined)
    })
  }
}

test("the bridge client pairs, lists, captures and cancels against the real bridge", async () => {
  const fixture = await bridgeFixture()
  const log = []
  const client = createTabContextClient({
    baseUrl: fixture.origin,
    instanceId: "instance",
    origin: adapterOrigin,
    fetchImpl: httpTransport(adapterOrigin, log),
    pollIntervalMs: 2,
    timeoutMs: 5000,
  })
  const begin = await fixture.call("begin", {}, undefined, extensionOrigin)
  assert.equal(begin.status, 201)
  const paired = await client.pair(begin.body.code)
  assert.equal(typeof paired.connectionId, "string")
  assert.equal(client.isPaired(), true)

  const listPromise = client.listTabs(draft)
  const listJob = await fixture.nextJob(paired.connectionId, begin.body.capability, "list")
  assert.deepEqual(listJob.draft, draft)
  const listReply = await fixture.call("reply", {
    connectionId: paired.connectionId,
    requestId: listJob.requestId,
    draft,
    status: "ok",
    result: { tabs: [{ tabRef: tabA.tabRef, url: tabA.url, documentId: tabA.documentId, title: tabA.title, windowId: tabA.windowId }] },
  }, begin.body.capability, extensionOrigin)
  assert.equal(listReply.status, 200)
  const listed = await listPromise
  assert.deepEqual(listed.tabs.map(tab => tab.tabRef), [tabA.tabRef])
  assert.equal(listed.tabs[0].title, tabA.title)

  const capturePromise = client.captureTab(draft, target)
  const captureJob = await fixture.nextJob(paired.connectionId, begin.body.capability, "capture")
  assert.deepEqual(captureJob.target, target)
  const captureReply = await fixture.call("reply", {
    connectionId: paired.connectionId,
    requestId: captureJob.requestId,
    draft,
    status: "ok",
    result: captureResult,
  }, begin.body.capability, extensionOrigin)
  assert.equal(captureReply.status, 200)
  const captured = await capturePromise
  assert.equal(captured.text, "Page text")
  assert.equal(captured.truncated, false)

  const started = await client.request("list", { draft })
  assert.equal(started.status, "pending")
  const cancelledJob = await fixture.nextJob(paired.connectionId, begin.body.capability, "list")
  assert.equal(await client.cancel(cancelledJob.requestId), true)

  const capability = log.find(entry => entry.headers["x-tab-context-capability"]).headers["x-tab-context-capability"]
  assert.equal(capability.length > 20, true)
  assert.equal(log.some(entry => entry.url.includes(capability)), false)
  assert.equal(log.every(entry => !Object.keys(entry.headers).some(name => name.toLowerCase() === "origin")), true)
  assert.equal(log.every(entry => new URL(entry.url).pathname.startsWith("/tab-context/v1/")), true)
})

test("the adapter lists real bridge tabs through the bridge mention client", async () => {
  const fixture = await bridgeFixture()
  const client = createTabContextClient({
    baseUrl: fixture.origin,
    instanceId: "instance",
    origin: adapterOrigin,
    fetchImpl: httpTransport(adapterOrigin, []),
    pollIntervalMs: 2,
    timeoutMs: 5000,
  })
  const begin = await fixture.call("begin", {}, undefined, extensionOrigin)
  const paired = await client.pair(begin.body.code)
  const composer = baseComposer()
  const drafts = []
  const adapter = createChromeMentionAdapter({
    client: createBridgeMentionClient(client),
    readComposer: composer.read,
    addDraft: (scope, payload) => {
      drafts.push([scope, payload])
      return "bridge-draft"
    },
    editRange: composer.editRange,
  })
  assert.deepEqual(adapter.rows().map(row => row.kind), [ROW_KIND.loading])
  const listJob = await fixture.nextJob(paired.connectionId, begin.body.capability, "list")
  await fixture.call("reply", {
    connectionId: paired.connectionId,
    requestId: listJob.requestId,
    draft,
    status: "ok",
    result: { tabs: [{ tabRef: tabA.tabRef, url: tabA.url, documentId: tabA.documentId, title: tabA.title, windowId: tabA.windowId }] },
  }, begin.body.capability, extensionOrigin)
  await waitUntil(() => adapter.rows().some(row => row.kind === ROW_KIND.tab))
  assert.deepEqual(adapter.rows().map(row => row.title), [tabA.title])

  adapter.select(adapter.rows()[0])
  const captureJob = await fixture.nextJob(paired.connectionId, begin.body.capability, "capture")
  await fixture.call("reply", {
    connectionId: paired.connectionId,
    requestId: captureJob.requestId,
    draft,
    status: "ok",
    result: { ...captureResult, tabRef: tabA.tabRef, url: tabA.url, documentId: tabA.documentId, title: tabA.title },
  }, begin.body.capability, extensionOrigin)
  await waitUntil(() => drafts.length === 1)
  assert.equal(drafts.length, 1)
  assert.deepEqual(drafts[0][0], { directory: "/repo", sessionKey: "draft" })
  assert.deepEqual(composer.edits, [[0, 1, ""]])
  assert.equal(adapter.isSendBlocked(), false)
})

test("a foreign adapter origin is rejected as untrusted-origin", async () => {
  const fixture = await bridgeFixture()
  const client = createTabContextClient({
    baseUrl: fixture.origin,
    instanceId: "instance",
    origin: foreignOrigin,
    fetchImpl: httpTransport(foreignOrigin, []),
    pollIntervalMs: 2,
    timeoutMs: 2000,
  })
  await assert.rejects(client.pair("12345678"), error => error.code === "untrusted-origin")
  for (const origin of ["", "null", "*", "openchamber-ui://app/path", "http://127.0.0.1:5173/path"]) {
    assert.throws(() => normalizeTrustedOrigin(origin), `origin ${origin} must be rejected`)
  }
  assert.equal(normalizeTrustedOrigin(" openchamber-ui://app "), "openchamber-ui://app")
})

test("the pristine 2.5.2 asset verifies when OPENCHAMBER_ASSET_PATH is set", async t => {
  const assetPath = process.env.OPENCHAMBER_ASSET_PATH
  if (!assetPath) return t.skip("OPENCHAMBER_ASSET_PATH is not set")
  const report = verifyAssetBytes(readFileSync(assetPath), { asset: assetPath, syntax: false })
  assert.equal(report.refused, false)
  assert.deepEqual(report.problems, [])
  assert.equal(report.patches.length, 10)
  assert.equal(report.patches.every(row => row.status === "ok" && row.occurrences === 1), true)
  assert.equal(report.patchedLength - report.length, report.delta)
})

test("no OpenChamber bundle slice is vendored into the test suite", async () => {
  const fixtures = new URL("./fixtures/openchamber-2.5.2.json", import.meta.url)
  assert.throws(() => readFileSync(fixtures), error => error.code === "ENOENT")
})
