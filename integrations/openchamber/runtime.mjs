import { createChromeMentionAdapter } from "./index.mjs"
import { createBridgeMentionClient, createPairingDialog, createTabContextClient } from "./bridge-client.mjs"
import { deriveMentionQuery } from "./mention-source.mjs"
import { ADAPTER_SEAMS, SEAM_CONTRACT } from "./patch-manifest.mjs"

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function forwardedPairingFailure(error) {
  if (isObject(error) || typeof error !== "string" || !error.trim()) return error
  const code = error.trim()
  return Object.assign(new Error(code), { code })
}

function parseNativeComposer(value) {
  if (!isObject(value)) return null
  const { runtimeKey, directory, draftId, sessionKey, text, caret, generation } = value
  if (typeof runtimeKey !== "string" || !runtimeKey) return null
  if (typeof directory !== "string" || !directory) return null
  if (typeof draftId !== "string") return null
  if (typeof sessionKey !== "string" || !sessionKey) return null
  if (typeof text !== "string") return null
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null
  const sessionId = value.sessionId ?? null
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) return null
  const query = deriveMentionQuery(text, caret)
  return {
    runtimeKey,
    directory,
    sessionId,
    draftId: draftId || `octm-${runtimeKey}`,
    sessionKey,
    generation: Number.isInteger(generation) ? generation : 0,
    text,
    from: query ? query.from : caret,
    to: caret,
  }
}

export function createConfiguredClient(config) {
  if (!isObject(config)) return null
  if (isObject(config.client)) return config.client
  if (typeof config.origin !== "string") return null
  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl : undefined
  const ports = isObject(config.ports) ? config.ports : undefined
  if (!baseUrl && !ports) return null
  try {
    return createBridgeMentionClient(createTabContextClient({
      baseUrl,
      ports,
      origin: config.origin,
      instanceId: typeof config.instanceId === "string" ? config.instanceId : undefined,
      fetchImpl: config.fetchImpl,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs: config.timeoutMs,
    }))
  } catch {
    return null
  }
}

export function createAdapterRuntime(options = {}) {
  const getNative = typeof options.getNative === "function" ? options.getNative : () => null
  let failure = null

  function readComposer() {
    const native = getNative()
    if (!isObject(native) || typeof native.readComposer !== "function") return null
    let value
    try {
      value = native.readComposer()
    } catch {
      failure = "readComposer"
      return null
    }
    return parseNativeComposer(value)
  }

  function callSeam(name, args) {
    const native = getNative()
    const handle = isObject(native) ? native[name] : null
    if (typeof handle !== "function") throw new Error(`missing native seam: ${name}`)
    return handle(...args)
  }

  const seams = {
    readComposer,
    addDraft: (scope, payload) => callSeam("addDraft", [scope, payload]),
    editRange: (from, to, insert) => callSeam("editRange", [from, to, insert]),
    removeDraft: (scope, id) => callSeam("removeDraft", [scope, id]),
  }
  if (isObject(options.client)) seams.client = options.client
  if (typeof options.onRequestPairing === "function") seams.onRequestPairing = options.onRequestPairing

  const adapter = createChromeMentionAdapter(seams)

  function status() {
    const native = getNative()
    const missingSeams = ADAPTER_SEAMS.filter(name => !(isObject(native) && typeof native[name] === "function"))
    return {
      ready: missingSeams.length === 0 && failure === null,
      missingSeams,
      failure,
      client: Boolean(seams.client),
      paired: Boolean(adapter.state().paired),
    }
  }

  return { adapter, status, seams, contract: SEAM_CONTRACT }
}

export function createDefaultPairing(options = {}) {
  const document = options.document
  const origin = options.origin
  const pair = options.pair
  let dialog = null

  async function onPair(code) {
    let result
    try {
      result = await pair(code)
    } catch (error) {
      throw forwardedPairingFailure(error)
    }
    dialog.close()
    return result
  }

  return function onRequestPairing() {
    if (!dialog) {
      dialog = createPairingDialog({ document, origin, onPair })
      document.body.append(dialog.element)
    }
    dialog.open()
    return dialog
  }
}

export function installAdapterRuntime(scope = globalThis, options = {}) {
  if (!isObject(scope)) throw new Error("a global scope is required")
  if (isObject(scope.__octmRuntime)) return scope.__octmRuntime
  if (scope.__octm && !scope.__octm.__octmInert) throw new Error("__octm is already provided by another adapter")
  const config = isObject(options.config) ? options.config : isObject(scope.__octmConfig) ? scope.__octmConfig : {}
  const client = options.client ?? createConfiguredClient(config)
  const origin = typeof config.origin === "string" ? config.origin : ""
  let onRequestPairing = options.onRequestPairing
  if (typeof onRequestPairing !== "function" && isObject(scope.document) && origin && client && typeof client.pair === "function") {
    onRequestPairing = createDefaultPairing({ document: scope.document, origin, pair: code => client.pair(code) })
  }
  const runtime = createAdapterRuntime({
    getNative: typeof options.getNative === "function" ? options.getNative : () => scope.__octmNative,
    client,
    onRequestPairing,
  })
  scope.__octm = runtime.adapter
  scope.__octmRuntime = runtime
  return runtime
}

export function createInertAdapter() {
  return {
    __octmInert: true,
    init() {},
    rows: () => [],
    count: () => 0,
    select() {},
    isSendBlocked: () => false,
    closeMenu() {},
    cancel() {},
    invalidate() {},
    pair() {},
    state: () => ({}),
    subscribe: () => () => {},
    getSnapshot: () => 0,
  }
}

export function installBootstrap(scope = globalThis, install = installAdapterRuntime) {
  if (!isObject(scope)) throw new Error("a global scope is required")
  try {
    install(scope)
  } catch (error) {
    scope.__octmInstallError = error && error.message ? error.message : "bootstrap failed"
  }
  if (!isObject(scope.__octm)) scope.__octm = createInertAdapter()
  return scope.__octm
}
