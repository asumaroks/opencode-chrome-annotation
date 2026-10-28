import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PATCH_MANIFEST, applyPatch, orderedPatches } from "../integrations/openchamber/patch-manifest.mjs"

export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function applyManifestPatches(source, patches = PATCH_MANIFEST.patches) {
  const rows = []
  let current = source
  for (const patch of orderedPatches(patches)) {
    const offset = source.indexOf(patch.marker)
    const applied = applyPatch(current, patch)
    rows.push({ id: patch.id, offset, action: patch.action })
    current = applied
  }
  return { patched: current, rows }
}

function parseArguments(argv) {
  const options = { asset: null, out: null, allowHash: null, help: false, unknown: null }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--asset") options.asset = argv[++index]
    else if (argument === "--out") options.out = argv[++index]
    else if (argument === "--allow-hash") options.allowHash = argv[++index]
    else if (argument === "--help" || argument === "-h") options.help = true
    else options.unknown = argument
  }
  return options
}

const USAGE = [
  "Usage: node scripts/apply-openchamber-patch.mjs --asset <in> --out <out> [--allow-hash <sha256>]",
  "",
  "Applies every patch from integrations/openchamber/patch-manifest.mjs, in order, to a copy of the asset.",
  "The source hash is checked against the pinned pristine hash before anything is written; the source file",
  "is never modified. The JSON report goes to stdout.",
  "",
  "  --asset <path>        pristine asset to read (never written)",
  "  --out <path>          patched copy to create",
  "  --allow-hash <hash>   test-only override for the expected source hash; printed as an override",
  "  --help                show this help",
].join("\n")

function fail(base, error) {
  return { ...base, ok: false, error }
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
  if (!options.asset || !options.out) {
    process.stderr.write("--asset and --out are required\n")
    return 2
  }
  const assetPath = resolve(options.asset)
  const outPath = resolve(options.out)
  if (assetPath.toLowerCase() === outPath.toLowerCase()) {
    process.stderr.write("--out must differ from --asset: the source asset is never patched in place\n")
    return 2
  }
  const expected = (options.allowHash ?? PATCH_MANIFEST.sha256).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    process.stderr.write("the expected hash must be a 64 character hex sha256\n")
    return 2
  }

  let source
  try {
    source = readFileSync(assetPath)
  } catch (error) {
    process.stdout.write(`${JSON.stringify(fail({ sourceSha256: null, length: null, patchedLength: null, patches: [] }, `cannot read the asset: ${error.message}`))}\n`)
    return 1
  }
  const sourceSha256 = sha256Of(source)
  const base = { sourceSha256, length: source.length, patchedLength: null, patches: [] }
  if (options.allowHash) {
    base.override = {
      allowHash: expected,
      pinned: PATCH_MANIFEST.sha256,
      note: "test-only override: the source hash was checked against --allow-hash instead of the pinned pristine hash",
    }
  }
  if (sourceSha256 !== expected) {
    process.stdout.write(`${JSON.stringify(fail(base, `source sha256 ${sourceSha256} does not match the expected ${expected}`))}\n`)
    return 1
  }

  let result
  try {
    result = applyManifestPatches(source.toString("utf8"))
  } catch (error) {
    process.stdout.write(`${JSON.stringify(fail(base, error.message))}\n`)
    return 1
  }
  const patchedLength = Buffer.byteLength(result.patched, "utf8")
  try {
    writeFileSync(outPath, result.patched, "utf8")
  } catch (error) {
    process.stdout.write(`${JSON.stringify(fail({ ...base, patches: result.rows, patchedLength }, `cannot write the patched copy: ${error.message}`))}\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify({ ok: true, sourceSha256, length: source.length, patchedLength, patches: result.rows, ...(base.override ? { override: base.override } : {}) })}\n`)
  return 0
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
