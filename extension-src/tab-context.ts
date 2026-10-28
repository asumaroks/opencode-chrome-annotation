type Target = { tabRef: string; url: string; documentId: string }
type Metadata = Target & { title: string; windowId: string }
type Capture = Target & { title: string; text: string; capturedAt: string; truncated: boolean }
type Draft = { runtimeKey: string; directory: string; sessionId: string | null; draftId: string; generation: number }
type Job = { version: 1; instanceId: string; connectionId: string; requestId: string; kind: "list" | "capture"; draft: Draft; target?: Target; expiresAt: number; limits: { textCharacters: number; packetBytes: number; tabs: number; requestTtlMs: number } }
type CaptureLease = { expiresAt: number; isActive(): boolean }
type Context = { list(): Promise<{ tabs: Metadata[] }>; capture(target: Target, lease?: CaptureLease): Promise<Capture>; dispose(): void }
const errors = ["permission-denied", "tab-closed", "navigation-changed", "empty-text", "unavailable", "capture-failed"]

function fail(code: string): never { throw new Error(code) }
function webUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? value : null
  } catch { return null }
}
function title(value: string | undefined, url: string): string { return (value?.trim() || url).slice(0, 2048) }

export function extractDocumentText(expiresAt = Date.now() + 15000) {
  const url = location.href
  const pageTitle = document.title
  if (Date.now() >= expiresAt || !document.body) return { url, title: pageTitle, text: "", truncated: false }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let text = ""
  let node: Node | null
  let visited = 0
  const deadline = performance.now() + 1000
  while ((node = walker.nextNode())) {
    if (Date.now() >= expiresAt) return { url, title: pageTitle, text: "", truncated: false }
    if (++visited > 100000 || performance.now() > deadline) return { url, title: pageTitle, text, truncated: true }
    let element = node.parentElement
    let excluded = false
    while (element) {
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED"].includes(element.tagName) || element.hidden || element.getAttribute("aria-hidden") === "true" || element.hasAttribute("inert")) { excluded = true; break }
      if (element.tagName === "DETAILS" && !element.hasAttribute("open")) {
        const summary = Array.from(element.children).find((child) => child.tagName === "SUMMARY")
        if (!summary?.contains(node)) { excluded = true; break }
      }
      const style = getComputedStyle(element)
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || style.opacity === "0") { excluded = true; break }
      element = element.parentElement
    }
    if (excluded) continue
    const value = (node.nodeValue || "").replace(/\s+/g, " ")
    if (!value.trim()) continue
    const next = `${text ? " " : ""}${value}`
    const available = 24000 - text.length
    text += next.slice(0, available)
    if (next.length > available) return { url, title: pageTitle, text, truncated: true }
  }
  return { url, title: pageTitle, text: text.trim(), truncated: false }
}

export function createChromeContext(api: typeof chrome = chrome): Context {
  const references = new Map<string, { tabId: number; url: string; documentId: string; revision: number }>()
  const revisions = new Map<number, number>()
  let disposed = false
  const updated = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (!change.url && change.status !== "loading") return
    revisions.set(tabId, (revisions.get(tabId) || 0) + 1)
    for (const [ref, value] of references) if (value.tabId === tabId) references.delete(ref)
  }
  api.tabs.onUpdated.addListener(updated)
  const revision = (tabId: number) => revisions.get(tabId) || 0
  async function frame(tabId: number) {
    try {
      const value = await api.webNavigation.getFrame({ tabId, frameId: 0 })
      if (!value?.documentId || !webUrl(value.url) || value.documentLifecycle !== "active") fail("unavailable")
      return value
    } catch { return fail("unavailable") }
  }
  async function getTab(tabId: number) {
    try { return await api.tabs.get(tabId) } catch { return fail("tab-closed") }
  }
  async function check(tabId: number, expected: Target, expectedRevision: number) {
    const tab = await getTab(tabId)
    if (disposed) fail("unavailable")
    if (tab.incognito || !webUrl(tab.url)) fail("unavailable")
    if (tab.url !== expected.url || tab.pendingUrl || tab.status === "loading" || revision(tabId) !== expectedRevision) fail("navigation-changed")
    if (!await api.permissions.contains({ origins: [`${new URL(expected.url).origin}/*`] })) fail("permission-denied")
    const current = await frame(tabId)
    if (current.documentId !== expected.documentId || current.url !== expected.url || revision(tabId) !== expectedRevision) fail("navigation-changed")
    return tab
  }
  return {
    async list() {
      if (disposed) fail("unavailable")
      const tabs: Metadata[] = []
      const nextReferences = new Map<string, { tabId: number; url: string; documentId: string; revision: number }>()
      for (const tab of await api.tabs.query({})) {
        if (tabs.length >= 100) break
        if (tab.incognito || tab.id === undefined || !webUrl(tab.url) || tab.pendingUrl || tab.status === "loading") continue
        const startRevision = revision(tab.id)
        try {
          const document = await frame(tab.id)
          if (disposed) fail("unavailable")
          if (document.url !== tab.url || revision(tab.id) !== startRevision) continue
          const existing = [...references].find(([, value]) => value.tabId === tab.id && value.documentId === document.documentId && value.url === tab.url && value.revision === startRevision)
          const tabRef = existing?.[0] || crypto.randomUUID()
          const url = tab.url!
          nextReferences.set(tabRef, { tabId: tab.id, url, documentId: document.documentId, revision: startRevision })
          tabs.push({ tabRef, url, documentId: document.documentId, title: title(tab.title, url), windowId: String(tab.windowId) })
        } catch { continue }
      }
      if (disposed) fail("unavailable")
      references.clear()
      for (const [ref, value] of nextReferences) references.set(ref, value)
      return { tabs }
    },
    async capture(target, lease) {
      const active = () => !disposed && (!lease || (lease.isActive() && Date.now() < lease.expiresAt))
      if (!active()) fail("unavailable")
      if (disposed) fail("unavailable")
      const ref = references.get(target.tabRef)
      if (!ref) fail("unavailable")
      if (target.url !== ref.url || target.documentId !== ref.documentId) fail("navigation-changed")
      await check(ref.tabId, target, ref.revision)
      if (!active()) fail("unavailable")
      let results: chrome.scripting.InjectionResult<ReturnType<typeof extractDocumentText>>[]
      try {
        results = await api.scripting.executeScript({ target: { tabId: ref.tabId, documentIds: [target.documentId] }, world: "ISOLATED", func: extractDocumentText, args: [lease?.expiresAt ?? Date.now() + 15000] })
      } catch {
        await check(ref.tabId, target, ref.revision)
        return fail("capture-failed")
      }
      await check(ref.tabId, target, ref.revision)
      if (!active()) fail("unavailable")
      const result = results[0]
      if (results.length !== 1 || result.frameId !== 0 || result.documentId !== target.documentId || result.result?.url !== target.url) fail("navigation-changed")
      const data = result.result
      if (!data || typeof data.text !== "string" || !data.text.trim()) fail("empty-text")
      if (data.text.length > 24000 || typeof data.truncated !== "boolean") fail("capture-failed")
      return { tabRef: target.tabRef, url: target.url, documentId: target.documentId, title: title(data.title, target.url), text: data.text, capturedAt: new Date().toISOString(), truncated: data.truncated }
    },
    dispose() { disposed = true; references.clear(); revisions.clear(); api.tabs.onUpdated.removeListener(updated) },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("unavailable")
  return value as Record<string, unknown>
}
function id(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.length <= 512 }
function parseJob(value: unknown, instanceId: string, connectionId: string, now: number): Job {
  const job = record(value), draft = record(job.draft), limits = record(job.limits)
  if (job.version !== 1 || job.instanceId !== instanceId || job.connectionId !== connectionId || !id(job.requestId) || !["list", "capture"].includes(job.kind as string) || typeof job.expiresAt !== "number" || job.expiresAt <= now || job.expiresAt > now + 15000) fail("unavailable")
  if (!id(draft.runtimeKey) || typeof draft.directory !== "string" || !draft.directory.trim() || draft.directory.length > 4096 || !(draft.sessionId === null || id(draft.sessionId)) || !id(draft.draftId) || !Number.isSafeInteger(draft.generation) || (draft.generation as number) < 0) fail("unavailable")
  if (limits.textCharacters !== 24000 || limits.packetBytes !== 131072 || limits.tabs !== 100 || limits.requestTtlMs !== 15000) fail("unavailable")
  if (job.kind === "capture") {
    const target = record(job.target)
    if (!id(target.tabRef) || !webUrl(target.url) || !id(target.documentId)) fail("unavailable")
  }
  return job as unknown as Job
}

export function createContextConnection(endpoint: { baseUrl: string; instanceId: string }, context: Context, request: typeof fetch = fetch, now = Date.now) {
  const parsed = new URL(endpoint.baseUrl)
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || Number(parsed.port) < 39240 || Number(parsed.port) > 39260 || parsed.origin !== endpoint.baseUrl || !id(endpoint.instanceId)) fail("unavailable")
  let connectionId = "", capability = "", expiresAt = 0, closed = false, polling = false
  let begun = false
  const active = new Map<string, { cancelled: boolean; promise?: Promise<void> }>()
  const stop = () => {
    closed = true
    capability = ""
    for (const item of active.values()) item.cancelled = true
    active.clear()
    context.dispose()
  }
  async function call(route: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    if (closed) fail("unavailable")
    const body = JSON.stringify({ version: 1, instanceId: endpoint.instanceId, ...(connectionId ? { connectionId } : {}), ...fields })
    if (new TextEncoder().encode(body).length > 131072) fail("capture-failed")
    const response = await request(`${endpoint.baseUrl}/tab-context/v1/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(capability ? { "X-Tab-Context-Capability": capability } : {}) }, body, signal: AbortSignal.timeout(5000), credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" })
    const data = record(await response.json())
    if (closed || data.version !== 1 || data.instanceId !== endpoint.instanceId) fail("unavailable")
    if (!response.ok) {
      if (route === "poll" && response.status === 409) return null
      if (route === "reply" && response.status === 410) return null
      fail("unavailable")
    }
    return data
  }
  async function execute(job: Job, state: { cancelled: boolean }) {
    let reply: Record<string, unknown>
    try {
      const result = job.kind === "list" ? await context.list() : await context.capture(job.target!, { expiresAt: job.expiresAt, isActive: () => !closed && !state.cancelled && now() < job.expiresAt && now() < expiresAt })
      reply = { status: "ok", result }
    } catch (error) {
      const code = error instanceof Error && errors.includes(error.message) ? error.message : "capture-failed"
      reply = { status: "error", error: code }
    }
    if (closed || state.cancelled || now() >= job.expiresAt || now() >= expiresAt) return
    const fields: Record<string, unknown> = { requestId: job.requestId, draft: job.draft, ...reply }
    const packet = JSON.stringify({ version: 1, instanceId: endpoint.instanceId, connectionId, ...fields })
    if (new TextEncoder().encode(packet).length > 131072) { delete fields.result; fields.status = "error"; fields.error = "capture-failed" }
    try { await call("reply", fields) } catch { stop() }
  }
  return {
    async begin() {
      if (begun || closed) fail("unavailable")
      begun = true
      const data = await call("begin")
      if (!data || !id(data.connectionId) || !id(data.capability) || typeof data.code !== "string" || !/^\d{8}$/.test(data.code) || typeof data.expiresAt !== "number" || data.expiresAt <= now() || data.expiresAt > now() + 60000) { stop(); return fail("unavailable") }
      connectionId = data.connectionId
      capability = data.capability
      expiresAt = data.expiresAt
      return { code: data.code, expiresAt, connectionId }
    },
    async tick() {
      if (closed || !connectionId || now() >= expiresAt) { stop(); fail("unavailable") }
      if (polling) return
      polling = true
      try {
        const data = await call("poll")
        if (!data) return { paired: false, expiresAt }
        if (data.connectionId !== connectionId || typeof data.expiresAt !== "number" || data.expiresAt <= now() || data.expiresAt > now() + 300000 || !Array.isArray(data.cancelled) || data.cancelled.length > 32 || !data.cancelled.every(id) || !Array.isArray(data.jobs) || data.jobs.length > 1) fail("unavailable")
        expiresAt = data.expiresAt
        for (const requestId of data.cancelled) { const state = active.get(requestId); if (state) state.cancelled = true }
        for (const jobValue of data.jobs) {
          const job = parseJob(jobValue, endpoint.instanceId, connectionId, now())
          if (active.has(job.requestId) || active.size >= 32 || job.expiresAt > expiresAt) fail("unavailable")
          const state: { cancelled: boolean; promise?: Promise<void> } = { cancelled: false }
          active.set(job.requestId, state)
          state.promise = execute(job, state).finally(() => active.delete(job.requestId))
        }
        return { paired: true, expiresAt }
      } catch { stop(); return fail("unavailable") }
      finally { polling = false }
    },
    async settle() { await Promise.all([...active.values()].map(item => item.promise)) },
    stop,
  }
}
