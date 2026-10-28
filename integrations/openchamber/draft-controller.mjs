import {
  ROW_KIND,
  createChromeRows,
  createErrorRow,
  createLoadingRow,
  createPendingRows,
  errorText,
  filterChromeRows,
} from "./mention-source.mjs"

const MAX_TAB_TEXT = 24000
const MAX_TABS = 100

const KNOWN_CODES = new Set([
  "permission-denied",
  "tab-closed",
  "navigation-changed",
  "empty-text",
  "unavailable",
  "capture-failed",
  "draft-rejected",
  "request-expired",
  "timeout",
  "untrusted-origin",
  "unauthorized",
  "pairing-required",
  "pairing-failed",
  "rate-limited",
  "invalid-response",
])

function codeOf(error) {
  const code = error && typeof error === "object" ? error.code : null
  return KNOWN_CODES.has(code) ? code : "unavailable"
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

function parseComposer(value) {
  if (!value || typeof value !== "object") return null
  const { runtimeKey, directory, draftId, sessionKey, text, from, to } = value
  if (typeof runtimeKey !== "string" || !runtimeKey) return null
  if (typeof directory !== "string" || !directory) return null
  if (typeof draftId !== "string") return null
  if (typeof sessionKey !== "string" || !sessionKey) return null
  if (typeof text !== "string") return null
  if (!isCount(from) || !isCount(to) || to < from || to > text.length) return null
  const sessionId = value.sessionId ?? null
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) return null
  return {
    runtimeKey,
    directory,
    sessionId,
    draftId: draftId || `octm-${runtimeKey}`,
    sessionKey,
    generation: isCount(value.generation) ? value.generation : 0,
    text,
    from,
    to,
  }
}

function sameComposer(left, right) {
  return left.runtimeKey === right.runtimeKey
    && left.directory === right.directory
    && left.sessionId === right.sessionId
    && left.draftId === right.draftId
    && left.sessionKey === right.sessionKey
    && left.generation === right.generation
    && left.text === right.text
    && left.from === right.from
    && left.to === right.to
}

function draftOf(composer) {
  return {
    runtimeKey: composer.runtimeKey,
    directory: composer.directory,
    sessionId: composer.sessionId,
    draftId: composer.draftId,
    generation: composer.generation,
  }
}

function parseTabs(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.tabs)) return null
  if (value.tabs.length > MAX_TABS) return null
  const tabs = []
  for (const tab of value.tabs) {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return null
    if (typeof tab.tabRef !== "string" || !tab.tabRef) return null
    if (typeof tab.url !== "string" || !tab.url) return null
    if (typeof tab.documentId !== "string" || !tab.documentId) return null
    if (typeof tab.title !== "string" || !tab.title.trim() || tab.title.length > 2048) return null
    tabs.push({ tabRef: tab.tabRef, url: tab.url, documentId: tab.documentId, title: tab.title, windowId: typeof tab.windowId === "string" ? tab.windowId : "" })
  }
  return tabs
}

function parseCapture(value, target) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "capture-failed" }
  if (value.tabRef !== target.tabRef || value.url !== target.url || value.documentId !== target.documentId) return { error: "navigation-changed" }
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 2048) return { error: "capture-failed" }
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > MAX_TAB_TEXT) return { error: "empty-text" }
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) return { error: "capture-failed" }
  if (typeof value.truncated !== "boolean") return { error: "capture-failed" }
  return { capture: { title: value.title.trim(), url: value.url, text: value.text, capturedAt: value.capturedAt, truncated: value.truncated } }
}

function draftPayload(capture) {
  return {
    source: "file",
    fileLabel: capture.title,
    startLine: 1,
    endLine: 1,
    code: capture.url,
    language: "text",
    text: [
      `Page: ${capture.title}`,
      `URL: ${capture.url}`,
      `Captured: ${capture.capturedAt}`,
      `Truncated: ${capture.truncated ? "yes" : "no"}`,
      "",
      capture.text,
    ].join("\n"),
  }
}

export function createDraftController(seams = {}) {
  const inflight = new Set()
  const listeners = new Set()
  let revision = 0
  let tabs = []
  let opened = false
  let loading = false
  let errorCode = null
  let pending = null
  let listToken = 0
  let captureToken = 0

  function emit() {
    revision++
    for (const listener of [...listeners]) listener()
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new Error("a listener function is required")
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function getSnapshot() {
    return revision
  }

  function track(promise) {
    inflight.add(promise)
    const drop = () => inflight.delete(promise)
    promise.then(drop, drop)
    return promise
  }

  function readComposer() {
    if (typeof seams.readComposer !== "function") return null
    try {
      return parseComposer(seams.readComposer())
    } catch {
      return null
    }
  }

  function openMenu() {
    if (opened) return
    opened = true
    errorCode = null
    const client = seams.client
    if (!client || typeof client.list !== "function") {
      errorCode = "unavailable"
      emit()
      return
    }
    const composer = readComposer()
    if (!composer) {
      errorCode = "unavailable"
      emit()
      return
    }
    const token = ++listToken
    loading = true
    let work
    try {
      work = client.list({ kind: "list", draft: draftOf(composer) })
    } catch (error) {
      loading = false
      errorCode = codeOf(error)
      emit()
      return
    }
    emit()
    track(Promise.resolve(work).then(result => {
      if (token !== listToken) return
      const parsed = parseTabs(result)
      if (!parsed) {
        errorCode = "invalid-response"
        return
      }
      tabs = createChromeRows(parsed)
    }, error => {
      if (token === listToken) errorCode = codeOf(error)
    }).then(() => {
      if (token === listToken) {
        loading = false
        emit()
      }
    }))
  }

  function rows(query) {
    if (pending) return createPendingRows(pending.row)
    if (!opened) openMenu()
    if (loading) return [createLoadingRow()]
    const visible = filterChromeRows(tabs, query)
    if (errorCode) return [createErrorRow(errorCode), ...visible]
    return visible
  }

  function count(query) {
    return rows(query).length
  }

  function isSendBlocked() {
    return pending !== null
  }

  function cancel() {
    if (!pending) return false
    const requestId = pending.request.requestId
    pending = null
    captureToken++
    emit()
    const client = seams.client
    if (client && typeof client.cancel === "function") {
      try {
        Promise.resolve(client.cancel(requestId)).catch(() => {})
      } catch {
        return true
      }
    }
    return true
  }

  function invalidate() {
    const requestId = pending ? pending.request.requestId : null
    const changed = opened || loading || pending !== null || tabs.length > 0 || errorCode !== null
    listToken++
    captureToken++
    pending = null
    loading = false
    opened = false
    tabs = []
    errorCode = null
    if (changed) emit()
    const client = seams.client
    if (requestId && client && typeof client.cancel === "function") {
      try {
        Promise.resolve(client.cancel(requestId)).catch(() => {})
      } catch {
        return true
      }
    }
    return true
  }

  function closeMenu() {
    const changed = opened || loading
    opened = false
    loading = false
    listToken++
    if (changed) emit()
  }

  function commit(composer, capture) {
    const addDraft = seams.addDraft
    const editRange = seams.editRange
    if (typeof addDraft !== "function" || typeof editRange !== "function") {
      errorCode = "draft-rejected"
      return false
    }
    let id
    try {
      id = addDraft({ directory: composer.directory, sessionKey: composer.sessionKey }, draftPayload(capture))
    } catch {
      errorCode = "draft-rejected"
      return false
    }
    if (!id) {
      errorCode = "draft-rejected"
      return false
    }
    try {
      editRange(composer.from, composer.to, "")
    } catch {
      removeCommittedDraft(composer, id)
      errorCode = "draft-rejected"
      return false
    }
    return true
  }

  function removeCommittedDraft(composer, id) {
    const removeDraft = seams.removeDraft
    if (typeof removeDraft !== "function") return false
    try {
      removeDraft({ directory: composer.directory, sessionKey: composer.sessionKey }, id)
      return true
    } catch {
      return false
    }
  }

  function startCapture(row) {
    const composer = readComposer()
    if (!composer) {
      errorCode = "unavailable"
      emit()
      return false
    }
    const client = seams.client
    if (!client || typeof client.capture !== "function") {
      errorCode = "unavailable"
      emit()
      return false
    }
    const token = ++captureToken
    const request = {
      kind: "capture",
      requestId: `capture-${token}`,
      draft: draftOf(composer),
      target: { tabRef: row.tabRef, url: row.url, documentId: row.documentId },
    }
    pending = { token, row, request }
    errorCode = null
    emit()
    track(runCapture(token, composer, request))
    return true
  }

  async function runCapture(token, composer, request) {
    let failure = null
    try {
      const result = await seams.client.capture(request)
      if (token !== captureToken) return
      const current = readComposer()
      if (current && sameComposer(current, composer)) {
        const parsed = parseCapture(result, request.target)
        if (parsed.error) failure = parsed.error
        else if (!commit(current, parsed.capture)) failure = errorCode
      }
    } catch (error) {
      failure = codeOf(error)
    }
    if (token !== captureToken) return
    pending = null
    if (failure) errorCode = failure
    emit()
  }

  function select(row) {
    if (!row || typeof row !== "object") return false
    if (row.kind === ROW_KIND.cancel) return cancel()
    if (row.kind === ROW_KIND.connect) {
      if (typeof seams.onRequestPairing === "function") seams.onRequestPairing()
      return true
    }
    if (row.kind !== ROW_KIND.tab) return false
    if (pending) return false
    return startCapture(row)
  }

  function state() {
    return {
      opened,
      loading,
      pending: pending !== null,
      error: errorCode,
      errorText: errorCode ? errorText(errorCode) : null,
      tabs: tabs.length,
    }
  }

  async function settled() {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }

  return { rows, count, select, cancel, invalidate, closeMenu, isSendBlocked, state, settled, subscribe, getSnapshot }
}
