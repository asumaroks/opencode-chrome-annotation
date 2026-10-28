import { createDraftController } from "./draft-controller.mjs"
import { createConnectRow, deriveMentionQuery } from "./mention-source.mjs"

function readComposer(seams) {
  if (typeof seams.readComposer !== "function") return null
  try {
    const value = seams.readComposer()
    return value && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

export function createChromeMentionAdapter(seams = {}) {
  const options = { ...seams }
  const controller = createDraftController(options)

  function isPaired() {
    const client = options.client
    if (!client) return false
    if (typeof client.isPaired !== "function") return true
    try {
      return Boolean(client.isPaired())
    } catch {
      return false
    }
  }

  function rows() {
    if (!isPaired()) return [createConnectRow()]
    const composer = readComposer(options)
    if (!composer || typeof composer.text !== "string") {
      controller.closeMenu()
      return []
    }
    const query = deriveMentionQuery(composer.text, composer.to)
    if (!query) {
      controller.closeMenu()
      return []
    }
    return controller.rows(query.query)
  }

  function count() {
    return rows().length
  }

  function select(row) {
    return controller.select(row)
  }

  function isSendBlocked() {
    return controller.isSendBlocked()
  }

  function closeMenu() {
    controller.closeMenu()
  }

  function cancel() {
    return controller.cancel()
  }

  function invalidate(reason) {
    return controller.invalidate(reason)
  }

  function state() {
    return { ...controller.state(), paired: isPaired() }
  }

  const subscribe = controller.subscribe
  const getSnapshot = controller.getSnapshot

  async function pair(code) {
    if (!options.client || typeof options.client.pair !== "function") throw new Error("pairing is unavailable")
    const result = await options.client.pair(code)
    controller.invalidate("pairing")
    return result
  }

  function init(next = {}) {
    Object.assign(options, next)
    controller.invalidate("init")
    return api
  }

  const api = { init, rows, count, select, isSendBlocked, closeMenu, cancel, invalidate, pair, state, subscribe, getSnapshot }
  return api
}
