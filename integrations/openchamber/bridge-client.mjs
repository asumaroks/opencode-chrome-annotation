const ROUTE_PREFIX = "/tab-context/v1/"
const STATUS_PATH = "/status"
const APP_ID = "opencode-chrome-annotation"
const LOOPBACK_HOST = "127.0.0.1"
const MAX_PORT_SPAN = 64

const CAPTURE_ERROR_CODES = Object.freeze(["permission-denied", "tab-closed", "navigation-changed", "empty-text", "unavailable", "capture-failed"])

export const CLIENT_ERROR_CODES = Object.freeze([...new Set([
  "untrusted-origin",
  "unauthorized",
  "pairing-required",
  "pairing-failed",
  "rate-limited",
  "timeout",
  "request-expired",
  "draft-rejected",
  "invalid-response",
  ...CAPTURE_ERROR_CODES,
])])

const SERVER_ERROR_CODES = Object.freeze({
  "untrusted-origin": "untrusted-origin",
  "untrusted-host": "untrusted-origin",
  "untrusted-header": "untrusted-origin",
  "wrong-role": "untrusted-origin",
  "invalid-code": "pairing-failed",
  "pairing-rate-limit": "rate-limited",
  "connection-limit": "rate-limited",
  "request-limit": "rate-limited",
  unauthorized: "unauthorized",
  "pairing-required": "pairing-required",
  "instance-mismatch": "unavailable",
  "project-mismatch": "draft-rejected",
  "draft-mismatch": "draft-rejected",
  "request-expired-or-consumed": "request-expired",
  "request-not-pending": "request-expired",
  "bridge-closed": "unavailable",
  "body-timeout": "timeout",
})

const STATUS_CODES = Object.freeze({
  400: "invalid-response",
  401: "unauthorized",
  403: "untrusted-origin",
  404: "unavailable",
  405: "invalid-response",
  408: "timeout",
  409: "draft-rejected",
  410: "request-expired",
  413: "invalid-response",
  415: "invalid-response",
  429: "rate-limited",
  503: "unavailable",
})

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function normalizeTrustedOrigin(value) {
  if (typeof value !== "string") throw codedError("untrusted-origin")
  const candidate = value.trim()
  if (!candidate || candidate === "null" || candidate === "*") throw codedError("untrusted-origin")
  let url
  try {
    url = new URL(candidate)
  } catch {
    throw codedError("untrusted-origin")
  }
  if (!url.host || url.username || url.password) throw codedError("untrusted-origin")
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw codedError("untrusted-origin")
  return `${url.protocol}//${url.host}`
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("baseUrl is required")
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error("baseUrl must be an absolute URL")
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.host) throw new Error("baseUrl must be http(s)")
  return `${url.protocol}//${url.host}`
}

function normalizePortRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ports must be an inclusive integer range")
  const { from, to } = value
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error("ports must be an inclusive integer range")
  if (from < 1 || to > 65535 || to < from || to - from > MAX_PORT_SPAN) throw new Error("ports must be an inclusive integer range")
  return { from, to }
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function sameDraft(left, right) {
  return left.runtimeKey === right.runtimeKey
    && left.directory === right.directory
    && left.sessionId === right.sessionId
    && left.draftId === right.draftId
    && left.generation === right.generation
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function captureErrorCode(value) {
  return CAPTURE_ERROR_CODES.includes(value) ? value : "capture-failed"
}

function parseTab(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const { tabRef, url, documentId, title, windowId } = value
  if (typeof tabRef !== "string" || !tabRef) return null
  if (typeof url !== "string" || !url) return null
  if (typeof documentId !== "string" || !documentId) return null
  if (typeof title !== "string" || !title.trim() || title.length > 2048) return null
  if (typeof windowId !== "string" || !windowId) return null
  return { tabRef, url, documentId, title: title.trim(), windowId }
}

function parseCapture(value, target) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw codedError("capture-failed")
  if (value.tabRef !== target.tabRef || value.url !== target.url || value.documentId !== target.documentId) throw codedError("navigation-changed")
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 2048) throw codedError("capture-failed")
  if (typeof value.text !== "string" || !value.text.trim()) throw codedError("empty-text")
  if (value.text.length > 24000) throw codedError("capture-failed")
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) throw codedError("capture-failed")
  if (typeof value.truncated !== "boolean") throw codedError("capture-failed")
  return {
    tabRef: value.tabRef,
    url: value.url,
    documentId: value.documentId,
    title: value.title.trim(),
    text: value.text,
    capturedAt: value.capturedAt,
    truncated: value.truncated,
  }
}

export function createTabContextClient(options = {}) {
  const origin = normalizeTrustedOrigin(options.origin)
  const staticBaseUrl = typeof options.baseUrl === "string" && options.baseUrl.trim() ? normalizeBaseUrl(options.baseUrl) : null
  const staticInstanceId = typeof options.instanceId === "string" && options.instanceId.trim() ? options.instanceId.trim() : null
  const ports = options.ports === undefined || options.ports === null ? null : normalizePortRange(options.ports)
  if (!staticBaseUrl && !ports) throw new Error("baseUrl or ports is required")
  if (staticInstanceId && !staticBaseUrl) throw new Error("instanceId requires baseUrl")
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs > 0 ? options.pollIntervalMs : 250
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000

  const connections = new Map()
  const requests = new Map()
  let staticTarget = staticBaseUrl && staticInstanceId ? { baseUrl: staticBaseUrl, instanceId: staticInstanceId } : null
  let pendingCaptureId = null
  let epoch = 0

  async function readPayload(response) {
    try {
      const payload = await response.json()
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null
    } catch {
      return null
    }
  }

  function protocolError(status, payload) {
    const serverCode = payload && typeof payload.error === "string" ? SERVER_ERROR_CODES[payload.error] : undefined
    return codedError(serverCode ?? STATUS_CODES[status] ?? "unavailable")
  }

  function portCandidates() {
    if (!ports) return []
    const list = []
    for (let port = ports.from; port <= ports.to; port++) list.push(port)
    return list
  }

  async function readStatus(baseUrl) {
    let response
    try {
      response = await fetchImpl(`${baseUrl}${STATUS_PATH}`, { method: "GET", credentials: "omit", cache: "no-store" })
    } catch {
      return null
    }
    if (!response || response.ok !== true) return null
    const payload = await readPayload(response)
    if (!payload || payload.app !== APP_ID) return null
    if (typeof payload.instanceId !== "string" || !payload.instanceId) return null
    if (typeof payload.directory !== "string" || !payload.directory) return null
    return { baseUrl, instanceId: payload.instanceId, directory: payload.directory }
  }

  async function resolveStatic() {
    if (staticTarget) return staticTarget
    const status = await readStatus(staticBaseUrl)
    if (!status) throw codedError("unavailable")
    staticTarget = { baseUrl: status.baseUrl, instanceId: status.instanceId }
    return staticTarget
  }

  async function discoverAll() {
    const candidates = portCandidates().map(port => readStatus(`http://${LOOPBACK_HOST}:${port}`))
    const settled = await Promise.all(candidates)
    const unique = new Map()
    for (const item of settled) {
      if (item && !unique.has(item.baseUrl)) unique.set(item.baseUrl, item)
    }
    return [...unique.values()]
  }

  async function resolveFor(directory) {
    if (staticBaseUrl) return resolveStatic()
    const discovered = await discoverAll()
    const matching = discovered.filter(item => item.directory === directory)
    if (matching.length === 0) throw codedError("unavailable")
    const paired = matching.filter(item => isPairedAt(item.baseUrl))
    const pool = paired.length > 0 ? paired : matching
    return pool.sort((left, right) => left.baseUrl.localeCompare(right.baseUrl))[0]
  }

  function isPairedAt(baseUrl) {
    const connection = connections.get(baseUrl)
    return Boolean(connection && connection.connectionId && connection.capability && connection.expiresAt > Date.now())
  }

  async function post(target, route, body, capability) {
    const headers = { "content-type": "application/json" }
    if (capability) headers["x-tab-context-capability"] = capability
    let response
    try {
      response = await fetchImpl(`${target.baseUrl}${ROUTE_PREFIX}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ version: 1, instanceId: target.instanceId, ...body }),
        credentials: "omit",
        cache: "no-store",
      })
    } catch {
      throw codedError("unavailable")
    }
    const payload = await readPayload(response)
    if (!response.ok) throw protocolError(response.status, payload)
    if (!payload) throw codedError("invalid-response")
    if (payload.version !== 1 || payload.instanceId !== target.instanceId) throw codedError("invalid-response")
    return payload
  }

  function isPaired() {
    for (const baseUrl of connections.keys()) if (isPairedAt(baseUrl)) return true
    return false
  }

  function requireConnection(target) {
    const connection = connections.get(target.baseUrl)
    if (!connection || !isPairedAt(target.baseUrl)) throw codedError("pairing-required")
    return connection
  }

  async function pair(code) {
    const value = typeof code === "string" ? code.trim() : ""
    if (!/^\d{8}$/.test(value)) throw codedError("pairing-failed")
    const targets = staticBaseUrl ? [await resolveStatic()] : await discoverAll()
    if (targets.length === 0) throw codedError("unavailable")
    let failure = null
    for (const target of targets) {
      try {
        const payload = await post(target, "pair", { code: value })
        const connection = {
          instanceId: target.instanceId,
          connectionId: requiredText(payload.connectionId, "connectionId"),
          capability: requiredText(payload.capability, "capability"),
          expiresAt: Number(payload.expiresAt) || 0,
        }
        connections.set(target.baseUrl, connection)
        return { connectionId: connection.connectionId, expiresAt: connection.expiresAt }
      } catch (error) {
        failure = error
        if (error && error.code === "pairing-failed") continue
        throw error
      }
    }
    throw failure ?? codedError("pairing-failed")
  }

  async function request(kind, { draft, target } = {}) {
    if (kind !== "list" && kind !== "capture") throw new Error(`unsupported request kind: ${kind}`)
    if (kind === "capture" && !target) throw new Error("capture requires a target")
    const instance = await resolveFor(draft.directory)
    const connection = requireConnection(instance)
    const payload = await post(instance, "request", { connectionId: connection.connectionId, kind, draft, ...(target ? { target } : {}) }, connection.capability)
    const requestId = requiredText(payload.requestId, "requestId")
    requests.set(requestId, { kind, draft, instance })
    return { status: "pending", requestId, expiresAt: payload.expiresAt, limits: payload.limits }
  }

  async function result(requestId, token = epoch) {
    const known = requests.get(requestId)
    if (!known) throw codedError("request-expired")
    const connection = requireConnection(known.instance)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (token !== epoch) throw codedError("request-expired")
      const payload = await post(known.instance, "result", { connectionId: connection.connectionId, requestId }, connection.capability)
      if (token !== epoch) throw codedError("request-expired")
      if (payload.requestId !== requestId) throw codedError("invalid-response")
      if (payload.status !== "pending") {
        requests.delete(requestId)
        if (payload.draft && !sameDraft(payload.draft, known.draft)) throw codedError("draft-rejected")
        if (payload.status === "error") throw codedError(captureErrorCode(payload.error))
        if (payload.status !== "ok") throw codedError("invalid-response")
        return payload
      }
      if (Date.now() >= deadline) throw codedError("timeout")
      await delay(pollIntervalMs)
    }
  }

  async function cancel(requestId) {
    const known = requests.get(requestId)
    requests.delete(requestId)
    if (!known) return false
    const connection = connections.get(known.instance.baseUrl)
    if (!connection || !connection.connectionId || !connection.capability) return false
    try {
      await post(known.instance, "cancel", { connectionId: connection.connectionId, requestId }, connection.capability)
      return true
    } catch {
      return false
    }
  }

  async function listTabs(draft) {
    const started = await request("list", { draft })
    const settled = await result(started.requestId)
    if (!settled.result || !Array.isArray(settled.result.tabs)) throw codedError("invalid-response")
    if (settled.result.tabs.length > 100) throw codedError("invalid-response")
    const tabs = settled.result.tabs.map(parseTab)
    if (tabs.some(tab => tab === null)) throw codedError("invalid-response")
    return { tabs }
  }

  async function captureTab(draft, target) {
    const started = await request("capture", { draft, target })
    const token = epoch
    pendingCaptureId = started.requestId
    try {
      const settled = await result(started.requestId, token)
      return parseCapture(settled.result, target)
    } finally {
      if (pendingCaptureId === started.requestId) pendingCaptureId = null
    }
  }

  function cancelCapture() {
    const requestId = pendingCaptureId
    pendingCaptureId = null
    epoch++
    if (!requestId) return Promise.resolve(false)
    return cancel(requestId)
  }

  function close() {
    epoch++
    pendingCaptureId = null
    requests.clear()
    connections.clear()
    staticTarget = staticBaseUrl && staticInstanceId ? { baseUrl: staticBaseUrl, instanceId: staticInstanceId } : null
  }

  return { origin, instanceId: staticInstanceId, pair, request, result, cancel, cancelCapture, listTabs, captureTab, isPaired, close }
}

export function createBridgeMentionClient(client) {
  if (!client || typeof client.listTabs !== "function" || typeof client.captureTab !== "function") throw new Error("a tab context client is required")
  return {
    isPaired: () => client.isPaired(),
    pair: code => client.pair(code),
    list: request => client.listTabs(request.draft),
    capture: request => client.captureTab(request.draft, request.target),
    cancel: () => client.cancelCapture(),
  }
}

export function createPairingDialog(options = {}) {
  const document = options.document
  if (!document || typeof document.createElement !== "function") throw new Error("a document is required")
  const origin = normalizeTrustedOrigin(options.origin)
  const onPair = options.onPair
  if (typeof onPair !== "function") throw new Error("onPair is required")

  const element = document.createElement("dialog")
  element.className = "octm-pairing-dialog"
  element.setAttribute("aria-labelledby", "octm-pairing-title")

  const heading = document.createElement("h2")
  heading.setAttribute("id", "octm-pairing-title")
  heading.textContent = "Connect Chrome tabs"

  const instructions = document.createElement("p")
  instructions.textContent = `Open the Chrome extension options page, choose this OpenChamber instance, and copy the 8-digit pairing code. The adapter origin ${origin} must already be trusted by the plugin.`

  const label = document.createElement("label")
  label.setAttribute("for", "octm-pairing-code")
  label.textContent = "Pairing code"

  const input = document.createElement("input")
  input.setAttribute("id", "octm-pairing-code")
  input.setAttribute("name", "octm-pairing-code")
  input.setAttribute("type", "text")
  input.setAttribute("inputmode", "numeric")
  input.setAttribute("autocomplete", "one-time-code")
  input.setAttribute("maxlength", "8")

  const message = document.createElement("p")
  message.setAttribute("role", "alert")

  const submitButton = document.createElement("button")
  submitButton.setAttribute("type", "submit")
  submitButton.textContent = "Pair"

  const cancelButton = document.createElement("button")
  cancelButton.setAttribute("type", "button")
  cancelButton.textContent = "Cancel"

  element.append(heading, instructions, label, input, message, submitButton, cancelButton)

  function close() {
    element.close()
  }

  function submit(value) {
    const code = typeof value === "string" ? value.trim() : ""
    if (!/^\d{8}$/.test(code)) {
      message.textContent = "Enter the 8-digit code shown in the extension options page."
      return { ok: false }
    }
    message.textContent = ""
    let pending
    try {
      pending = onPair(code)
    } catch {
      message.textContent = "Pairing failed. Check the code and the plugin origin, then try again."
      return { ok: true }
    }
    Promise.resolve(pending).catch(() => {
      message.textContent = "Pairing failed. Check the code and the plugin origin, then try again."
    })
    return { ok: true }
  }

  submitButton.addEventListener("click", () => submit(input.value))
  cancelButton.addEventListener("click", () => close())
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    submit(input.value)
  })
  element.addEventListener("cancel", event => {
    event.preventDefault()
    close()
  })

  return { element, open: () => element.showModal(), close, submit }
}
