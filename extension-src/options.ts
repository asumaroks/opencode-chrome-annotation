import { discoverInstances } from "./server-api.js"
import { createChromeContext, createContextConnection } from "./tab-context.js"

type Endpoint = { baseUrl: string; instanceId: string }
type Connection = ReturnType<typeof createContextConnection>

const instance = document.getElementById("instance") as HTMLSelectElement
const site = document.getElementById("site") as HTMLSelectElement
const connect = document.getElementById("connect") as HTMLButtonElement
const disconnect = document.getElementById("disconnect") as HTMLButtonElement
const grant = document.getElementById("grant") as HTMLButtonElement
const refresh = document.getElementById("refresh") as HTMLButtonElement
const code = document.getElementById("code") as HTMLOutputElement
const status = document.getElementById("status") as HTMLElement

let endpoints = new Map<string, Endpoint>()
let origins = new Set<string>()
let connection: Connection | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let busy = false

function stop() {
  if (timer) clearTimeout(timer)
  connection?.stop()
  connection = null
  code.textContent = ""
  disconnect.disabled = true
  connect.disabled = !endpoints.size
  instance.disabled = false
  refresh.disabled = false
}

function option(value: string, label: string) {
  const item = document.createElement("option")
  item.value = value
  item.textContent = label
  return item
}

async function discover() {
  refresh.disabled = true
  const metadata = createChromeContext()
  try {
    const [instances, result] = await Promise.all([discoverInstances(), metadata.list()])
    endpoints = new Map(instances.filter((item) => typeof item.status.instanceId === "string").map((item) => [item.baseUrl, { baseUrl: item.baseUrl, instanceId: item.status.instanceId as string }]))
    instance.replaceChildren(...instances.filter((item) => endpoints.has(item.baseUrl)).map((item) => option(item.baseUrl, `${String(item.status.directory || "Local instance")} · ${item.baseUrl}`)))
    origins = new Set(result.tabs.map((tab) => `${new URL(tab.url).origin}/*`))
    site.replaceChildren(...[...origins].map((origin) => option(origin, origin)))
    connect.disabled = !!connection || busy || !endpoints.size
    grant.disabled = !origins.size
    status.textContent = endpoints.size ? "Choose an instance and get a pairing code. Site permission is a separate action." : "No local instance available. Start OpenCode with the plugin, then refresh."
  } catch {
    status.textContent = "Discovery unavailable. Refresh to try again."
  } finally {
    metadata.dispose()
    refresh.disabled = !!connection || busy
  }
}

async function poll(current: Connection) {
  if (connection !== current) return
  try {
    const result = await current.tick()
    if (connection !== current) return
    if (result?.paired) {
      code.textContent = ""
      status.textContent = "Connected. Select a Chrome tab in the composer to capture its text."
    }
    timer = setTimeout(() => { poll(current) }, 500)
  } catch {
    if (connection !== current) return
    stop()
    refresh.disabled = false
    status.textContent = "Disconnected or expired. Get a new pairing code to reconnect."
  }
}

connect.addEventListener("click", async () => {
  const endpoint = endpoints.get(instance.value)
  if (!endpoint || busy || connection) return
  busy = true
  connect.disabled = true
  refresh.disabled = true
  instance.disabled = true
  const current = createContextConnection(endpoint, createChromeContext())
  connection = current
  disconnect.disabled = false
  try {
    const pairing = await current.begin()
    if (connection !== current) return
    code.textContent = pairing.code
    status.textContent = "Waiting for pairing. Enter the code in the composer within 60 seconds."
    poll(current)
  } catch {
    if (connection !== current) return
    stop()
    refresh.disabled = false
    status.textContent = "Pairing unavailable. Confirm the trusted extension Origin is configured for this instance, then reconnect."
  } finally {
    busy = false
    if (!connection) connect.disabled = !endpoints.size
  }
})

disconnect.addEventListener("click", () => {
  stop()
  refresh.disabled = false
  status.textContent = "Disconnected. No context is shared."
})

grant.addEventListener("click", async () => {
  const origin = site.value
  if (!origins.has(origin)) return
  grant.disabled = true
  try {
    const allowed = await chrome.permissions.request({ origins: [origin] })
    status.textContent = allowed ? "Site permission granted. Text is captured only after a composer selection." : "Site permission denied. Capture remains blocked for this site."
  } catch {
    status.textContent = "Site permission unavailable. Try again using this button."
  } finally {
    grant.disabled = !origins.size
  }
})

refresh.addEventListener("click", () => {
  if (!connection && !busy) return discover()
})

window.addEventListener("pagehide", stop)

discover()
