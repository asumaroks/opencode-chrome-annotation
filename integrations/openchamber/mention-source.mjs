export const ROW_KIND = Object.freeze({
  tab: "tab",
  loading: "loading",
  pending: "pending",
  cancel: "cancel",
  error: "error",
  connect: "connect",
})

export const TAB_ICON = "global"

const ERROR_TEXT = Object.freeze({
  "permission-denied": "Chrome has not granted access to this site. Allow the site in the extension options.",
  "tab-closed": "The tab was closed before its content could be captured.",
  "navigation-changed": "The page changed while its content was captured. Select the tab again.",
  "empty-text": "The page has no readable text to attach.",
  unavailable: "The Chrome extension is not connected. Open its options page and pair again.",
  "capture-failed": "The page content could not be captured. Select the tab again.",
  "draft-rejected": "The draft store rejected this attachment. The message text was left unchanged.",
  "request-expired": "The capture request expired. Select the tab again.",
  timeout: "The Chrome extension did not answer in time. Select the tab again.",
  "untrusted-origin": "This adapter origin is not trusted by the plugin. Configure the exact origin and restart the plugin.",
  unauthorized: "The connection is no longer authorised. Pair the extension again.",
  "pairing-required": "Pair the Chrome extension before attaching a tab.",
  "pairing-failed": "The pairing code was rejected. Copy a fresh code from the extension options page.",
  "rate-limited": "Too many attempts in a short time. Wait a minute and try again.",
  "invalid-response": "The plugin returned an unexpected response. Update the plugin and try again.",
})

export function errorText(code) {
  return ERROR_TEXT[code] ?? ERROR_TEXT["capture-failed"]
}

export function createChromeRows(tabs = []) {
  return tabs.map(tab => {
    const title = typeof tab.title === "string" && tab.title.trim() ? tab.title.trim() : tab.url
    return Object.freeze({
      kind: ROW_KIND.tab,
      key: `chrome-${tab.tabRef}`,
      tabRef: tab.tabRef,
      url: tab.url,
      documentId: tab.documentId,
      windowId: typeof tab.windowId === "string" ? tab.windowId : "",
      title,
      description: tab.url,
      icon: TAB_ICON,
    })
  })
}

export function filterChromeRows(rows, query) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : ""
  if (!needle) return rows
  return rows.filter(row => row.title.toLowerCase().includes(needle) || row.url.toLowerCase().includes(needle))
}

function size(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function createMentionLayout(native = {}, chromeRows = []) {
  const agents = size(native.agents)
  const openFiles = size(native.openFiles)
  const searchedFiles = size(native.searchedFiles)
  const sessions = size(native.sessions)
  const nativeCount = agents + openFiles + searchedFiles + sessions
  return {
    agents,
    openFiles,
    searchedFiles,
    sessions,
    nativeCount,
    chromeStart: nativeCount,
    count: nativeCount + chromeRows.length,
  }
}

export function mentionIndexAt(layout, index) {
  if (!layout || !Number.isInteger(index) || index < 0 || index >= layout.count) return null
  if (index < layout.agents) return { kind: "agent", index }
  if (index < layout.agents + layout.openFiles) return { kind: "openFile", index: index - layout.agents }
  if (index < layout.agents + layout.openFiles + layout.searchedFiles) return { kind: "searchedFile", index: index - layout.agents - layout.openFiles }
  if (index < layout.nativeCount) return { kind: "session", index: index - layout.agents - layout.openFiles - layout.searchedFiles }
  return { kind: "chrome", index: index - layout.nativeCount }
}

export function deriveMentionQuery(text, caret) {
  if (typeof text !== "string") return null
  const position = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), text.length) : text.length
  const at = text.lastIndexOf("@", position - 1)
  if (at < 0) return null
  if (at > 0 && !/\s/.test(text[at - 1])) return null
  const query = text.slice(at + 1, position)
  if (/\s/.test(query)) return null
  return { from: at, query }
}

export function createTabRow(row) {
  return {
    kind: ROW_KIND.tab,
    key: row.key,
    tabRef: row.tabRef,
    url: row.url,
    documentId: row.documentId,
    title: row.title,
    description: row.description,
    icon: row.icon,
  }
}

export function createLoadingRow() {
  return { kind: ROW_KIND.loading, key: "chrome-loading", title: "Loading Chrome tabs…", description: "Metadata only, page content is not read", icon: TAB_ICON, disabled: true }
}

export function createPendingRows(row) {
  const title = row && typeof row.title === "string" ? row.title : "Chrome tab"
  return [
    { kind: ROW_KIND.pending, key: "chrome-pending", title: `Capturing ${title}…`, description: "Send is paused until the capture finishes", icon: TAB_ICON, disabled: true },
    { kind: ROW_KIND.cancel, key: "chrome-cancel", title: "Cancel capture", description: "Keep the message unchanged", icon: "close", disabled: false },
  ]
}

export function createErrorRow(code) {
  return { kind: ROW_KIND.error, key: `chrome-error-${code}`, title: errorText(code), description: "Select a tab to try again", icon: "alert", disabled: false, code }
}

export function createConnectRow() {
  return { kind: ROW_KIND.connect, key: "chrome-connect", title: "Connect Chrome…", description: "Pair the extension with its short-lived code", icon: TAB_ICON, disabled: false }
}
