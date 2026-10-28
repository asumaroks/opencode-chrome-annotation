import { logExtension, warnExtension } from "./logger.js"
import { getActiveTab } from "./tabs.js"
import { postJson, requestSessionState } from "./server-api.js"
import {
  hideConnectionOverlay,
  injectConnectionOverlay,
  removeConnectionOverlay,
  showAnnotationError,
  showShareToast,
} from "./ui-overlays.js"
import { showSessionPicker } from "./session-picker.js"
import { runAnnotationPicker } from "./annotation-picker.js"
import { createConnectionMonitor } from "./connection-monitor.js"
import { createClaimsStore } from "./claims-store.js"
import type { AnnotationPayload, AnnotationViewport, ExtensionMessage, SessionInfo, SharePayload, TabClaim } from "./types.js"

const claimedTabs = createClaimsStore()
const extensionVersion = chrome.runtime.getManifest().version
const SHARE_MENU_ID = "share-tab-with-opencode"

const monitor = createConnectionMonitor({
  claimedTabs,
  removeConnectionOverlay,
  extensionVersion,
})

const MESSAGE_TYPE = {
  START_ANNOTATION: "start_annotation_from_overlay",
  CONNECT_TAB: "connect_tab_to_session",
  DISCONNECT_TAB: "disconnect_tab",
  REFRESH_SESSIONS: "refresh_sessions",
} as const

function isSupportedMessage(message: unknown): message is ExtensionMessage {
  const type = typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined
  return typeof type === "string" && (Object.values(MESSAGE_TYPE) as string[]).includes(type)
}

function toOriginPattern(url?: string): string | null {
  if (typeof url !== "string" || !url) return null
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return null
    return `${parsed.origin}/*`
  } catch {
    return null
  }
}

function sessionLabel(session: Pick<SessionInfo, "id" | "title">): string {
  return session?.title || session?.id
}

function claimRequestBody(tabId: number, sessionId: string) {
  return { tabId, sessionId, extensionVersion }
}

async function ensureSiteAccess(tab: chrome.tabs.Tab): Promise<void> {
  if (!chrome.permissions?.request) return

  const origin = toOriginPattern(tab?.url)
  if (!origin) {
    throw new Error("This page cannot be annotated. Open an http(s) page and try again.")
  }

  const granted = await chrome.permissions.request({ origins: [origin] })
  if (!granted) {
    throw new Error("Site access was denied for this page.")
  }
}

async function runMessageAction(message: ExtensionMessage, tab: chrome.tabs.Tab) {
  if (message.type === "connect_tab_to_session") {
    logExtension("Session picker selection received", {
      tabId: tab?.id,
      sessionId: message.session?.id,
      sessionLabel: sessionLabel(message.session),
    })
    await claimTabForSession(tab, message.session)
    if (message.thenShare) {
      await shareTab(tab, { claim: claimedTabs.get(tab.id), selectionText: message.selectionText })
    }
    return { ok: true }
  }

  if (message.type === "disconnect_tab") {
    const disconnected = await disconnectTab(tab)
    return { ok: true, disconnected }
  }

  if (message.type === "refresh_sessions") {
    const { sessions, context } = await requestSessionState()
    if (!tab.id) throw new Error("No active tab found")
    await showSessionPicker(tab.id, sessions, context, message.intent ?? "connect", message.selectionText ?? "")
    return { ok: true, sessions: sessions.length }
  }

  const result = await startAnnotationMode(tab)
  return { ok: true, cancelled: !!result?.cancelled }
}

async function handleMessage(message: ExtensionMessage, sender: chrome.runtime.MessageSender) {
  const tab = sender.tab?.id ? sender.tab : await getActiveTab()

  try {
    return await runMessageAction(message, tab)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (message.type === "connect_tab_to_session") {
      warnExtension("Failed to connect tab to OpenCode session", {
        tabId: tab?.id,
        sessionId: message.session?.id,
        error: text,
      })
    }
    if (tab?.id) {
      const shareFailure =
        (message.type === "connect_tab_to_session" && message.thenShare === true) ||
        (message.type === "refresh_sessions" && message.intent === "share")
      await showAnnotationError(tab.id, text, shareFailure ? "OpenCode tab share failed" : undefined).catch(() => {})
    }
    return { ok: false, error: text }
  }
}

async function claimTabForSession(tab: chrome.tabs.Tab, session: SessionInfo): Promise<void> {
  if (!tab.id) throw new Error("No active tab found")
  logExtension("Connecting tab to OpenCode session", {
    tabId: tab?.id,
    sessionId: session?.id,
    sessionLabel: sessionLabel(session),
    baseUrl: session?.baseUrl,
  })

  await postJson(session.baseUrl, "/claim", claimRequestBody(tab.id, session.id))

  claimedTabs.set(tab.id, {
    sessionId: session.id,
    sessionLabel: sessionLabel(session),
    baseUrl: session.baseUrl,
    origin: toOriginPattern(tab.url),
    extensionVersion,
  })

  await injectConnectionOverlay(tab.id)
  monitor.ensure()

  logExtension("Connected tab to OpenCode session", {
    tabId: tab?.id,
    sessionId: session?.id,
    sessionLabel: sessionLabel(session),
    baseUrl: session?.baseUrl,
  })
}

async function resolveShareTarget(tab: chrome.tabs.Tab, selectionText = ""): Promise<TabClaim | null> {
  if (!tab.id) throw new Error("No active tab found")

  const existing = claimedTabs.get(tab.id)
  if (existing) return existing

  const { sessions, context } = await requestSessionState()
  if (sessions.length === 1) {
    await claimTabForSession(tab, sessions[0])
    return claimedTabs.get(tab.id) ?? null
  }

  await showSessionPicker(tab.id, sessions, context, "share", selectionText)
  return null
}

async function shareTab(
  tab: chrome.tabs.Tab,
  options: { claim?: TabClaim; selectionText?: string } = {}
): Promise<void> {
  if (!tab.id || !tab.windowId) throw new Error("No active tab found")

  const selectionText = (options.selectionText ?? "").trim()
  const claim = options.claim || (await resolveShareTarget(tab, selectionText))
  if (!claim) return

  const current = await chrome.tabs.get(tab.id)
  if (!current?.active || current.windowId !== tab.windowId) {
    throw new Error("The shared tab is no longer the active tab. Switch back to it and share again.")
  }
  if (toOriginPattern(current.url) !== toOriginPattern(tab.url)) {
    throw new Error("The shared tab is no longer the active tab. Switch back to it and share again.")
  }

  logExtension("Capturing shared tab screenshot", { tabId: tab.id, windowId: current.windowId })
  try {
    await hideConnectionOverlay(tab.id)
  } catch (error) {
    warnExtension("Failed to hide page overlays before tab capture", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const screenshot = await chrome.tabs.captureVisibleTab(current.windowId, { format: "png" })
  logExtension("Captured shared tab screenshot", {
    tabId: tab.id,
    bytesApprox: Math.round((screenshot.length * 3) / 4),
  })

  if (claimedTabs.get(tab.id)) {
    try {
      await injectConnectionOverlay(tab.id)
    } catch (error) {
      warnExtension("Failed to restore connection overlay after tab capture", {
        tabId: tab.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  let viewport: AnnotationViewport | undefined
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    })
    viewport = (injection?.result as AnnotationViewport | undefined) || undefined
  } catch (error) {
    warnExtension("Failed to read viewport for tab share", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const share: SharePayload = {
    page: {
      url: current.url || "",
      title: current.title || "",
    },
    ...(selectionText ? { selectionText } : {}),
    ...(viewport ? { viewport } : {}),
    screenshot: {
      mime: "image/png",
      dataUrl: screenshot,
    },
  }

  try {
    await postJson(claim.baseUrl, "/share", { ...claimRequestBody(tab.id, claim.sessionId), share })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (text === "status 404") {
      throw new Error("Update the OpenCode plugin: this version does not support tab sharing")
    }
    throw error
  }

  await showShareToast(tab.id, claim.sessionLabel || "").catch((error) => {
    warnExtension("Failed to show share toast", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

async function disconnectTab(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.id) return false
  const claim = claimedTabs.get(tab?.id)
  if (!claim) return false

  if (claim?.baseUrl && claim?.sessionId) {
    try {
      await postJson(claim.baseUrl, "/unclaim", claimRequestBody(tab.id, claim.sessionId))
    } catch (error) {
      warnExtension("Failed to clear upstream tab claim", {
        tabId: tab?.id,
        sessionId: claim?.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  claimedTabs.delete(tab.id)
  await removeConnectionOverlay(tab.id)
  if (!claimedTabs.size()) monitor.stop()

  logExtension("Disconnected tab from OpenCode session", {
    tabId: tab?.id,
    sessionId: claim?.sessionId,
  })

  return true
}

async function startAnnotationMode(tabOverride?: chrome.tabs.Tab): Promise<{ cancelled: boolean }> {
  const tab = tabOverride?.id ? tabOverride : await getActiveTab()
  if (!tab?.id || !tab.windowId) throw new Error("No active tab found")

  logExtension("Starting annotation mode", {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
  })

  const picked = await runAnnotationPicker(tab.id)
  if (!picked || picked.cancelled === true) return { cancelled: true }

  try {
    await hideConnectionOverlay(tab.id)
  } catch (error) {
    warnExtension("Failed to hide page overlays before annotation capture", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  logExtension("Capturing annotation screenshot", { tabId: tab.id, windowId: tab.windowId })
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  logExtension("Captured annotation screenshot", {
    tabId: tab.id,
    bytesApprox: Math.round((screenshot.length * 3) / 4),
  })
  try {
    await injectConnectionOverlay(tab.id)
  } catch (error) {
    warnExtension("Failed to restore connection overlay after annotation capture", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const annotationPayload: AnnotationPayload = {
    comment: picked.comment || "",
    page: {
      url: tab.url || "",
      title: tab.title || "",
    },
    element: picked.element,
    viewport: picked.viewport,
    screenshot: {
      mime: "image/png",
      dataUrl: screenshot,
    },
  }

  logExtension("Sending annotation upstream", {
    tabId: tab.id,
    selector: picked.element?.selector,
    commentLength: annotationPayload.comment.length,
  })

  const claim = claimedTabs.get(tab.id)
  if (!claim?.baseUrl || !claim?.sessionId) {
    throw new Error("Tab is not connected to an OpenCode instance")
  }

  const annotationResponse = await postJson(claim.baseUrl, "/annotation", {
    ...claimRequestBody(tab.id, claim.sessionId),
    annotation: annotationPayload,
  })

  logExtension("Annotation delivered to OpenCode instance", { tabId: tab.id, baseUrl: claim.baseUrl })
  logExtension("Annotation accepted by OpenCode plugin", {
    tabId: tab.id,
    sessionId: annotationResponse?.sessionId,
  })

  return { cancelled: false }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  claimedTabs.delete(tabId)
  if (!claimedTabs.size()) monitor.stop()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return
  const claim = claimedTabs.get(tabId)
  if (!claim) return

  const nextOrigin = toOriginPattern(tab?.url)
  if (nextOrigin && claim.origin && nextOrigin !== claim.origin) {
    disconnectTab({ ...tab, id: tabId }).catch(() => {})
    return
  }

  injectConnectionOverlay(tabId)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const claim = claimedTabs.get(tabId)
  if (claim) injectConnectionOverlay(tabId)
})

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError
    chrome.contextMenus.create(
      {
        id: SHARE_MENU_ID,
        title: "Share this tab with OpenCode",
        contexts: ["page", "selection"],
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      },
      () => {
        void chrome.runtime.lastError
      }
    )
  })
}

chrome.runtime.onInstalled.addListener(() => registerContextMenus())
chrome.runtime.onStartup.addListener(() => registerContextMenus())

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== SHARE_MENU_ID) return

  try {
    const target = tab?.id ? tab : await getActiveTab()
    await shareTab(target, { selectionText: info.selectionText })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    warnExtension("Failed to share tab", { error: text })
    const target = tab?.id ? tab : await getActiveTab().catch((): null => null)
    if (target?.id) {
      await showAnnotationError(target.id, text, "OpenCode tab share failed").catch(() => {})
    }
  }
})

async function restoreClaimState() {
  await claimedTabs.restore()

  for (const [tabId, claim] of Array.from(claimedTabs.entries())) {
    try {
      const tab = await chrome.tabs.get(tabId)
      const nextOrigin = toOriginPattern(tab?.url)
      if (!nextOrigin || (claim.origin && nextOrigin !== claim.origin)) {
        claimedTabs.delete(tabId)
        continue
      }
      await injectConnectionOverlay(tabId)
    } catch {
      claimedTabs.delete(tabId)
    }
  }

  if (claimedTabs.size()) monitor.ensure()
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isSupportedMessage(message)) return false

  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })

  return true
})

chrome.action.onClicked.addListener(async (clickedTab) => {
  try {
    const tab = clickedTab?.id ? clickedTab : await getActiveTab()
    if (!tab.id) throw new Error("No active tab found")
    await ensureSiteAccess(tab)
    const { sessions, context } = await requestSessionState()
    await showSessionPicker(tab.id, sessions, context)
    logExtension(sessions.length ? "Session picker shown" : "OpenCode setup help shown", undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnExtension("Failed to show session picker", { error: message })
    const tab = await getActiveTab().catch((): null => null)
    if (tab?.id) await showAnnotationError(tab.id, message).catch(() => {})
  }
})

restoreClaimState().catch((error) => {
  warnExtension("Failed to restore tab claims", { error: error instanceof Error ? error.message : String(error) })
})
