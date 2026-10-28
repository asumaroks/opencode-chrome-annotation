import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PATCH_MANIFEST,
  applyPatch,
  applyPatches,
  orderedPatches,
} from "../integrations/openchamber/patch-manifest.mjs"

const DEFAULT_WEB_DIST = process.env.OPENCHAMBER_WEB_DIST || "C:/Users/Alex/AppData/Local/Programs/@openchamberelectron/resources/web-dist"
const PATCH_ACTIONS = new Set(["replace", "insertAfter", "insertBefore"])

export { DEFAULT_WEB_DIST }

export function countOccurrences(source, marker) {
  let count = 0
  let at = source.indexOf(marker)
  while (at >= 0) {
    count++
    at = source.indexOf(marker, at + 1)
  }
  return count
}

export function patchDelta(patch) {
  return patch.insert.length - (patch.action === "replace" ? patch.marker.length : 0)
}

export function inspectPatches(source, manifest = PATCH_MANIFEST) {
  const rows = []
  const problems = []
  let current = source
  for (const [index, patch] of orderedPatches(manifest.patches).entries()) {
    const offset = source.indexOf(patch.marker)
    const occurrences = countOccurrences(current, patch.marker)
    const recordedOffset = Array.isArray(patch.offsets) ? patch.offsets[0] ?? null : null
    const row = {
      position: index + 1,
      id: patch.id,
      action: patch.action,
      offset,
      recordedOffset,
      occurrences,
      delta: patchDelta(patch),
      status: "ok",
    }
    if (!PATCH_ACTIONS.has(patch.action)) {
      row.status = "invalid-action"
      problems.push(`${patch.id}: unknown action ${patch.action}`)
    } else if (offset < 0) {
      row.status = "missing"
      problems.push(`${patch.id}: marker is missing from the pinned asset`)
    } else if (occurrences !== 1) {
      row.status = "ambiguous"
      problems.push(`${patch.id}: marker occurs ${occurrences} times after earlier patches`)
    } else if (recordedOffset !== offset) {
      row.status = "offset-mismatch"
      problems.push(`${patch.id}: recorded offset ${recordedOffset} does not match indexOf ${offset}`)
    } else if (patch.occurrences !== 1) {
      row.status = "occurrences-unrecorded"
      problems.push(`${patch.id}: recorded occurrences is ${patch.occurrences} instead of 1`)
    } else {
      try {
        current = applyPatch(current, patch)
      } catch (error) {
        row.status = "failed"
        problems.push(`${patch.id}: ${error.message}`)
      }
    }
    rows.push(row)
  }
  return { rows, problems, patched: current === source ? null : current }
}

export function verifyAssetSource(source, manifest = PATCH_MANIFEST) {
  const inspected = inspectPatches(source, manifest)
  const problems = [...inspected.problems]
  for (const patch of orderedPatches(manifest.patches)) {
    let single
    try {
      single = applyPatch(source, patch)
    } catch {
      continue
    }
    if (single === source) {
      problems.push(`${patch.id}: patch changed nothing`)
    } else if (patch.action === "replace") {
      if (countOccurrences(single, patch.marker) !== 0) problems.push(`${patch.id}: marker survived the replacement`)
      if (!single.includes(patch.insert)) problems.push(`${patch.id}: inserted text is missing`)
    } else if (patch.action === "insertAfter") {
      if (!single.includes(`${patch.marker}${patch.insert}`)) problems.push(`${patch.id}: inserted text is not directly after the marker`)
    } else if (patch.action === "insertBefore") {
      if (!single.includes(`${patch.insert}${patch.marker}`)) problems.push(`${patch.id}: inserted text is not directly before the marker`)
    }
  }
  let patched = inspected.patched
  if (!patched) {
    try {
      patched = applyPatches(source, manifest.patches)
    } catch (error) {
      problems.push(`patched asset could not be produced: ${error.message}`)
      return { rows: inspected.rows, problems, patched: null, length: null, delta: null }
    }
  }
  const delta = orderedPatches(manifest.patches).reduce((total, patch) => total + patchDelta(patch), 0)
  if (patched.length !== source.length + delta) {
    problems.push(`patched length ${patched.length} does not match the expected ${source.length + delta}`)
  }
  return { rows: inspected.rows, problems, patched, length: source.length, delta }
}

export function syntaxCheck(source) {
  const directory = mkdtempSync(join(tmpdir(), "octm-verify-"))
  const file = join(directory, "patched.mjs")
  try {
    writeFileSync(file, source)
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })
    return []
  } catch (error) {
    const output = error && error.stderr ? error.stderr.toString().trim() : "syntax check failed"
    return [output.split("\n").slice(0, 4).join(" ")]
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function verifyAssetBytes(bytes, options = {}) {
  const manifest = options.manifest ?? PATCH_MANIFEST
  const asset = options.asset ?? "memory"
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const base = {
    asset,
    version: manifest.version,
    sha256,
    pinned: manifest.sha256,
    bytes: bytes.length,
    length: bytes.length,
    patchedLength: null,
    delta: null,
    patches: [],
    syntax: null,
    refused: false,
    problems: [],
  }
  if (sha256 !== manifest.sha256) {
    return {
      ...base,
      refused: true,
      problems: [`asset sha256 ${sha256} does not match the pinned pristine ${manifest.sha256}; refusing to verify a different build`],
    }
  }
  const verified = verifyAssetSource(bytes.toString("utf8"), manifest)
  const problems = [...verified.problems]
  let syntax = null
  if (options.syntax && verified.patched) {
    const failures = syntaxCheck(verified.patched)
    syntax = failures.length === 0 ? "ok" : "failed"
    problems.push(...failures)
  }
  return {
    ...base,
    patchedLength: verified.patched ? verified.patched.length : null,
    delta: verified.delta,
    patches: verified.rows,
    syntax,
    problems,
  }
}

export function verifyAssetFile(assetPath, options = {}) {
  return verifyAssetBytes(readFileSync(assetPath), { ...options, asset: assetPath })
}

export function resolveAssetPath(webDist = DEFAULT_WEB_DIST) {
  const path = join(webDist, PATCH_MANIFEST.asset)
  if (!existsSync(path)) throw new Error(`asset is not installed at ${path}`)
  return path
}

function parseArguments(argv) {
  const options = { asset: null, webDist: null, syntax: false, json: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--asset") options.asset = argv[++index]
    else if (argument === "--web-dist") options.webDist = argv[++index]
    else if (argument === "--syntax") options.syntax = true
    else if (argument === "--json") options.json = true
    else if (argument === "--help") options.help = true
    else options.unknown = argument
  }
  return options
}

const USAGE = [
  "Usage: node scripts/verify-openchamber-patch-manifest.mjs [options]",
  "",
  "Read-only verification of an installed OpenChamber asset against the pinned patch manifest.",
  "",
  "  --web-dist <path>  installed web-dist root (default: the local OpenChamber 2.5.2 install)",
  "  --asset <path>     verify this file instead of the manifest asset under --web-dist",
  "  --syntax           write the patched module to a temp directory and run node --check on it",
  "  --json             print the report as JSON",
  "  --help             show this help",
].join("\n")

function printReport(report) {
  const lines = [
    `asset: ${report.asset}`,
    `version: ${report.version}`,
    `sha256: ${report.sha256}`,
    `pinned: ${report.pinned}`,
    `length: ${report.length}`,
    `patches: ${report.patches.length}`,
  ]
  const width = report.patches.reduce((max, row) => Math.max(max, row.id.length), 0)
  for (const row of report.patches) {
    lines.push(
      `  ${String(row.position).padStart(2)} ${row.id.padEnd(width)} ${row.action.padEnd(11)} offset=${String(row.offset).padStart(8)} recorded=${String(row.recordedOffset).padStart(8)} occurrences=${row.occurrences} delta=${row.delta >= 0 ? "+" : ""}${row.delta} ${row.status}`
    )
  }
  if (report.patchedLength !== null) {
    lines.push(`patched length: ${report.patchedLength} (${report.delta >= 0 ? "+" : ""}${report.patchedLength - report.length})`)
  }
  if (report.syntax) lines.push(`syntax: ${report.syntax}`)
  if (report.refused) lines.push("refused: the asset is not the pinned pristine 2.5.2 build; an app update invalidates the manifest")
  for (const problem of report.problems) lines.push(`problem: ${problem}`)
  lines.push(report.problems.length === 0 ? "result: ok" : "result: failed")
  process.stdout.write(`${lines.join("\n")}\n`)
}

function main(argv) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (options.unknown) {
    process.stderr.write(`unknown argument: ${options.unknown}\n`)
    return 2
  }
  if (options.asset && options.webDist) {
    process.stderr.write("--asset and --web-dist cannot be combined\n")
    return 2
  }
  let report
  try {
    const assetPath = options.asset ? resolve(options.asset) : resolveAssetPath(options.webDist ?? DEFAULT_WEB_DIST)
    report = verifyAssetFile(assetPath, { syntax: options.syntax })
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : "verification failed"}\n`)
    return 1
  }
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: report.problems.length === 0, ...report }, null, 2)}\n`)
  else printReport(report)
  return report.problems.length === 0 ? 0 : 1
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
