import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_WEB_DIST } from "./verify-openchamber-patch-manifest.mjs"

const APP_ID = "opencode-chrome-annotation"
const ADAPTER_ORIGIN = "openchamber-ui://app"
const UNTRUSTED_ORIGIN = "https://evil.test"
const UNTRUSTED_HOST = "evil.test"
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`
const DEFAULT_PORTS = "39240-39260"
const DEFAULT_TIMEOUT_MS = 1500
const PORT_PATTERN = /^(\d{1,5})-(\d{1,5})$/
const EIGHT_DIGITS = /^\d{8}$/
const SECRET_KEYS = ["capability", "tabref", "documentid"]
const RECORD_NAME = ".octm-install.json"
const MODULE_DIR_NAME = "octm"
const ADAPTER_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "integrations", "openchamber")

const USAGE = [
  "Usage: node scripts/verify-tab-context-live.mjs [options]",
  "",
  "Live, read-only acceptance check of the Chrome tab-context bridge and the installed OpenChamber adapter.",
  "",
  "  --ports <from>-<to>  localhost ports to probe (default: 39240-39260)",
  "  --web-dist <path>    installed web-dist root (default: the local OpenChamber install)",
  "  --probe-extension    also request a pairing code through /tab-context/v1/begin",
  "  --timeout <ms>       timeout for a single probe (default: 1500)",
  "  --json               print the report as JSON",
  "  --help               show this help",
].join("\n")

function parsePortRange(value) {
  const match = PORT_PATTERN.exec(String(value ?? "").trim())
  if (!match) throw new Error(`--ports must look like <from>-<to>, got ${value === undefined ? "nothing" : value}`)
  const start = Number(match[1])
  const end = Number(match[2])
  if (start < 1 || end > 65535 || start > end) {
    throw new Error(`--ports range is invalid: ${value} (expected 1 <= from <= to <= 65535)`)
  }
  return { start, end }
}

function parseTimeout(value) {
  const text = String(value ?? "").trim()
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new Error(`--timeout must be a positive integer in milliseconds, got ${value === undefined ? "nothing" : value}`)
  }
  return Number(text)
}

export function parseArgs(argv) {
  const options = {
    ports: DEFAULT_PORTS,
    webDist: DEFAULT_WEB_DIST,
    probeExtension: false,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--ports") options.ports = argv[++index]
    else if (argument === "--web-dist") options.webDist = argv[++index]
    else if (argument === "--timeout") options.timeoutMs = argv[++index]
    else if (argument === "--probe-extension") options.probeExtension = true
    else if (argument === "--json") options.json = true
    else if (argument === "--help") options.help = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  const range = parsePortRange(options.ports)
  const timeoutMs = parseTimeout(options.timeoutMs)
  if (options.webDist === undefined || String(options.webDist).trim() === "") {
    throw new Error("--web-dist needs a directory path")
  }
  return {
    ports: `${range.start}-${range.end}`,
    range,
    webDist: resolve(String(options.webDist)),
    probeExtension: options.probeExtension,
    json: options.json,
    timeoutMs,
    help: options.help,
  }
}

export function run({ port, path, method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise(resolveRun => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolveRun(value)
    }
    const requestHeaders = { connection: "close", ...headers }
    if (body !== undefined) requestHeaders["content-length"] = Buffer.byteLength(body)
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: requestHeaders, timeout: timeoutMs },
      response => {
        let data = ""
        response.setEncoding("utf8")
        response.on("data", chunk => (data += chunk))
        response.on("end", () => {
          let payload = null
          try {
            payload = data ? JSON.parse(data) : null
          } catch {
            payload = null
          }
          finish({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            payload,
          })
        })
      }
    )
    request.on("timeout", () => {
      request.destroy()
      finish({ ok: false, status: 0, payload: null, error: `no response within ${timeoutMs} ms` })
    })
    request.on("error", error => finish({ ok: false, status: 0, payload: null, error: error.code || error.message }))
    request.end(body)
  })
}

function optionalString(value) {
  return typeof value === "string" ? value : null
}

function projectInstance(instance) {
  return {
    port: instance.port,
    version: instance.version,
    instanceId: instance.instanceId,
    directory: instance.directory,
    serverStatus: instance.serverStatus,
  }
}

export async function discoverInstances(options) {
  const ports = []
  for (let port = options.range.start; port <= options.range.end; port++) ports.push(port)
  const responses = await Promise.all(ports.map(port => run({ port, path: "/status", timeoutMs: options.timeoutMs })))
  const instances = []
  for (const [index, response] of responses.entries()) {
    const payload = response.payload
    if (!payload || payload.app !== APP_ID) continue
    instances.push({
      port: ports[index],
      version: optionalString(payload.version),
      instanceId: optionalString(payload.instanceId),
      directory: optionalString(payload.directory),
      serverStatus: optionalString(payload.server && payload.server.status),
    })
  }
  return instances
}

export function createCollector() {
  const results = []
  const collector = {
    results,
    add(result) {
      results.push(result)
      return result
    },
    async check(name, fn, context = {}) {
      let outcome
      try {
        outcome = await fn()
      } catch (error) {
        outcome = { status: "fail", detail: error && error.message ? error.message : "check failed" }
      }
      return collector.add({ name, ...context, status: outcome.status, detail: outcome.detail })
    },
  }
  return collector
}

function expectResponse(response, status, error) {
  const actual = response.status ? `${response.status} ${response.payload?.error ?? ""}`.trim() : String(response.error)
  const errorMatches = error === undefined || response.payload?.error === error
  if (response.status === status && errorMatches) return { status: "pass", detail: actual }
  const expected = `${status}${error ? ` ${error}` : ""}`
  return { status: "fail", detail: `expected ${expected}, got ${actual}` }
}

export function scanStatusPayload(payload) {
  const problems = []
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (!value || typeof value !== "object") {
      if ((typeof value === "string" || typeof value === "number") && EIGHT_DIGITS.test(String(value))) {
        problems.push(`${path || "status"} holds an 8-digit value`)
      }
      return
    }
    for (const [key, child] of Object.entries(value)) {
      const where = path ? `${path}.${key}` : key
      if (SECRET_KEYS.some(secret => key.toLowerCase().includes(secret))) problems.push(where)
      walk(child, where)
    }
  }
  walk(payload, "")
  return problems
}

async function beginProbe(instance, headers, body, timeoutMs) {
  const response = await run({
    port: instance.port,
    path: "/tab-context/v1/begin",
    method: "POST",
    headers: { ...headers, origin: EXTENSION_ORIGIN },
    body,
    timeoutMs,
  })
  if (response.status !== 201) return { status: "fail", detail: `expected 201, got ${response.status || response.error}` }
  if (!/^\d{8}$/.test(String(response.payload?.code))) {
    return { status: "fail", detail: "201 without an 8-digit pairing code" }
  }
  const expiresAt = response.payload?.expiresAt
  return {
    status: "pass",
    detail: `201 code: ****${Number.isFinite(expiresAt) ? ` expiresAt: ${expiresAt}` : ""}`,
  }
}

export async function checkInstance(instance, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const collector = createCollector()
  const context = { port: instance.port }
  const body = JSON.stringify({ version: 1, instanceId: instance.instanceId })
  const headers = { origin: ADAPTER_ORIGIN, "content-type": "application/json" }
  const bridgePath = "/tab-context/v1/request"

  await collector.check(
    "request without capability",
    async () => {
      const response = await run({ port: instance.port, path: bridgePath, method: "POST", headers, body, timeoutMs })
      if (response.status === 404) {
        return {
          status: "fail",
          detail: "404: this plugin build has no tab-context bridge; restart the host with the new plugin, then reload the extension",
        }
      }
      return expectResponse(response, 401, "unauthorized")
    },
    context
  )

  await collector.check(
    "untrusted origin",
    async () => {
      const response = await run({
        port: instance.port,
        path: bridgePath,
        method: "POST",
        headers: { ...headers, origin: UNTRUSTED_ORIGIN },
        body,
        timeoutMs,
      })
      return expectResponse(response, 403, "untrusted-origin")
    },
    context
  )

  await collector.check(
    "untrusted host",
    async () => {
      const response = await run({
        port: instance.port,
        path: bridgePath,
        method: "POST",
        headers: { ...headers, host: UNTRUSTED_HOST },
        body,
        timeoutMs,
      })
      if (response.status === 401) {
        return { status: "skip", detail: "node sent its own Host header, so an untrusted host cannot be simulated" }
      }
      if (response.status !== 403) {
        return { status: "fail", detail: `expected 403, got ${response.status || response.error}` }
      }
      return { status: "pass", detail: `403 ${response.payload?.error ?? ""}`.trim() }
    },
    context
  )

  await collector.check(
    "pair preflight",
    async () => {
      const response = await run({
        port: instance.port,
        path: "/tab-context/v1/pair",
        method: "OPTIONS",
        headers: {
          origin: ADAPTER_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-tab-context-capability",
        },
        timeoutMs,
      })
      return expectResponse(response, 200)
    },
    context
  )

  await collector.check(
    "status has no secrets",
    async () => {
      const response = await run({ port: instance.port, path: "/status", timeoutMs })
      if (response.status !== 200 || !response.payload) {
        return { status: "fail", detail: `/status answered ${response.status || response.error}` }
      }
      const problems = scanStatusPayload(response.payload)
      if (problems.length) return { status: "fail", detail: `status exposes ${problems.slice(0, 5).join(", ")}` }
      return { status: "pass", detail: "key scan clean" }
    },
    context
  )

  await collector.check(
    "begin probe",
    async () => {
      if (!options.probeExtension) return { status: "skip", detail: "pass --probe-extension to request a pairing code" }
      return await beginProbe(instance, headers, body, timeoutMs)
    },
    context
  )

  return collector.results
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function isInside(root, target) {
  const rootFull = resolve(root)
  const targetFull = resolve(target)
  const prefix = rootFull.endsWith("\\") || rootFull.endsWith("/") ? rootFull : `${rootFull}${rootFull.includes("\\") ? "\\" : "/"}`
  return targetFull.toLowerCase().startsWith(prefix.toLowerCase())
}

export function compareAdapterFiles(options = {}) {
  const webDist = options.webDist ?? DEFAULT_WEB_DIST
  const sourceDir = options.sourceDir ?? ADAPTER_SOURCE_DIR
  const moduleDir = join(webDist, MODULE_DIR_NAME)
  const names = readdirSync(sourceDir)
    .filter(name => name.endsWith(".mjs"))
    .sort()
  const files = names.map(name => {
    const sourceSha = sha256File(join(sourceDir, name))
    const installedPath = join(moduleDir, name)
    if (!existsSync(installedPath)) return { name, status: "missing", sourceSha, installedSha: null }
    const installedSha = sha256File(installedPath)
    return { name, status: installedSha === sourceSha ? "match" : "drift", sourceSha, installedSha }
  })
  const recordPath = join(webDist, RECORD_NAME)
  const record = { exists: existsSync(recordPath), recorded: 0, outside: 0, parsed: false }
  if (record.exists) {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(recordPath, "utf8"))
      record.parsed = true
    } catch {
      parsed = null
    }
    const paths = []
    if (parsed && Array.isArray(parsed.files)) {
      for (const entry of parsed.files) if (entry && typeof entry.path === "string") paths.push(entry.path)
    }
    if (parsed && Array.isArray(parsed.added)) {
      for (const entry of parsed.added) if (typeof entry === "string") paths.push(entry)
    }
    record.recorded = paths.length
    record.outside = paths.filter(path => !isInside(webDist, path)).length
  }
  return { webDist, installed: existsSync(webDist), moduleDir, files, record }
}

function adapterOutcome(adapter) {
  const drifted = adapter.files.filter(file => file.status !== "match")
  const details = []
  if (drifted.length) details.push(drifted.map(file => `${file.name} ${file.status}`).join(", "))
  if (!adapter.record.exists) details.push(`${RECORD_NAME} is missing; re-run the adapter install with -Apply`)
  else if (!adapter.record.parsed) details.push(`${RECORD_NAME} is not valid JSON`)
  else if (adapter.record.outside) details.push(`${adapter.record.outside} recorded path(s) fall outside ${adapter.webDist}`)
  return {
    name: "adapter drift",
    status: details.length ? "fail" : "pass",
    detail: details.length ? details.join("; ") : `${adapter.files.length} module(s) match, install record inside ${adapter.webDist}`,
  }
}

export function buildReport({ options, instances, checks, adapter }) {
  const failed = checks.filter(result => result.status === "fail").length
  return {
    ok: failed === 0,
    result: failed === 0 ? "ok" : `failed (${failed})`,
    failed,
    ports: options.ports,
    timeoutMs: options.timeoutMs,
    probeExtension: Boolean(options.probeExtension),
    webDist: options.webDist,
    instances: instances.map(projectInstance),
    checks: checks.map(result => ({
      port: result.port ?? null,
      name: result.name,
      status: result.status,
      detail: result.detail,
    })),
    adapter: adapter
      ? {
          webDist: adapter.webDist,
          files: adapter.files.map(file => ({ name: file.name, status: file.status })),
          record: adapter.record,
        }
      : null,
  }
}

function pad(value, width) {
  return String(value === null || value === undefined ? "-" : value).padEnd(width)
}

function columnWidth(rows, read) {
  return rows.reduce((width, row) => Math.max(width, String(read(row)).length), 0)
}

function renderText(report) {
  const lines = []
  lines.push(`ports: ${report.ports}  timeout: ${report.timeoutMs} ms  probe-extension: ${report.probeExtension ? "on" : "off"}`)
  if (report.instances.length) {
    const portWidth = Math.max(4, columnWidth(report.instances, row => row.port))
    const versionWidth = Math.max(7, columnWidth(report.instances, row => row.version))
    const idWidth = Math.max(10, columnWidth(report.instances, row => row.instanceId))
    const statusWidth = Math.max(13, columnWidth(report.instances, row => row.serverStatus))
    lines.push("")
    lines.push(`${pad("port", portWidth)}  ${pad("version", versionWidth)}  ${pad("instanceId", idWidth)}  ${pad("server.status", statusWidth)}  directory`)
    for (const instance of report.instances) {
      lines.push(
        `${pad(instance.port, portWidth)}  ${pad(instance.version, versionWidth)}  ${pad(instance.instanceId, idWidth)}  ${pad(instance.serverStatus, statusWidth)}  ${instance.directory ?? "-"}`
      )
    }
  }
  lines.push("")
  lines.push("checks")
  const nameWidth = Math.max(6, columnWidth(report.checks, row => row.name))
  const portWidth = Math.max(4, columnWidth(report.checks, row => row.port ?? "-"))
  const resultWidth = Math.max(6, columnWidth(report.checks, row => row.status))
  lines.push(`${pad("port", portWidth)}  ${pad("check", nameWidth)}  ${pad("result", resultWidth)}  detail`)
  for (const row of report.checks) {
    lines.push(`${pad(row.port ?? "-", portWidth)}  ${pad(row.name, nameWidth)}  ${pad(row.status, resultWidth)}  ${row.detail ?? ""}`)
  }
  if (report.adapter) {
    lines.push("")
    lines.push(`adapter: ${report.adapter.webDist}`)
    const fileWidth = Math.max(6, columnWidth(report.adapter.files, file => file.name))
    for (const file of report.adapter.files) lines.push(`  ${pad(file.name, fileWidth)}  ${file.status}`)
    const record = report.adapter.record
    const state = record.exists ? (record.parsed ? "present" : "unreadable") : "missing"
    lines.push(`  install record: ${state}, ${record.recorded} path(s) recorded, ${record.outside} outside the web-dist`)
  }
  lines.push("")
  lines.push(`result: ${report.result}`)
  return lines.join("\n")
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.stdout.write("result: failed (1)\n")
    return 1
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const collector = createCollector()
  const instances = await discoverInstances(options)
  await collector.check("discovery", () => {
    if (!instances.length) {
      return {
        status: "fail",
        detail: `no instance answered /status with app=${APP_ID} on ports ${options.ports}; start OpenCode with this plugin installed`,
      }
    }
    return { status: "pass", detail: `${instances.length} instance(s) on ports ${options.ports}` }
  })

  for (const instance of instances) {
    for (const result of await checkInstance(instance, options)) collector.add(result)
  }

  let adapter = null
  if (existsSync(options.webDist)) {
    adapter = compareAdapterFiles({ webDist: options.webDist })
    collector.add(adapterOutcome(adapter))
  } else {
    collector.add({ name: "adapter drift", status: "skip", detail: `${options.webDist} is not present` })
  }

  const report = buildReport({ options, instances, checks: collector.results, adapter })
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${renderText(report)}\n`)
  return report.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2))
