import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { PATCH_MANIFEST, applyPatches, orderedPatches } from "../integrations/openchamber/patch-manifest.mjs"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const installerPath = join(repoRoot, "scripts", "install-openchamber-adapter.ps1")
const bootstrapDir = join(repoRoot, "integrations", "openchamber", "web")
const adapterDir = join(repoRoot, "integrations", "openchamber")

const BOOTSTRAP_FILES = ["octm-config.js", "octm-fallback.js", "octm-bootstrap.js"]
const MODULE_FILES = ["runtime.mjs", "index.mjs", "draft-controller.mjs", "mention-source.mjs", "bridge-client.mjs", "patch-manifest.mjs"]
const INDEX_TAGS = [
  '<script src="/octm-config.js"></script>',
  '<script src="/octm-fallback.js"></script>',
  '<script type="module" crossorigin src="/octm-bootstrap.js"></script>',
]
const INSTALLED_BOOTSTRAP = {
  "octm-config.js": {
    sha256: "b67f4fa0b8bd28f30fb7a1bf6745e0f10ce59fc328029c881ca9d43d26c0f45e",
    size: 109,
  },
  "octm-fallback.js": {
    sha256: "d492742e9fefeca482b0b5bc5a6121cbc0b1ffd17af88c0e75651b8f6fe015fd",
    size: 299,
  },
  "octm-bootstrap.js": {
    sha256: "2fc4f24a9203041cffdcb8977883c59d2441db4f91d75e61b27c79c70073d970",
    size: 84,
  },
}

const INDEX_HTML = [
  "<!doctype html>",
  "<html>",
  "  <head>",
  '    <meta charset="utf-8" />',
  "    <title>synthetic openchamber build</title>",
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  '    <link rel="modulepreload" crossorigin href="/assets/main-test.js">',
  '    <script type="module" crossorigin src="/assets/main-boot.js"></script>',
  "  </body>",
  "</html>",
  "",
].join("\n")

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function powershellExe() {
  if (process.platform !== "win32") return null
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" })
  if (probe.error?.code === "ENOENT") return null
  return "powershell.exe"
}

function hostileModulePaths() {
  const paths = ["C:\\nonexistent-modules"]
  const inherited = process.env.PSModulePath ?? ""
  const shadowing = inherited.split(";").find(entry => /PowerShell[\\/]7[\\/]Modules[\\/]?$/i.test(entry))
  if (shadowing) paths.push(`C:\\nonexistent-modules;${shadowing}`)
  return paths
}

const powershell = powershellExe()

function buildSyntheticAsset() {
  const lines = ["// synthetic OpenChamber asset: one line per patch marker, in manifest order"]
  for (const patch of orderedPatches(PATCH_MANIFEST.patches)) {
    if (lines.some(line => line.includes(patch.marker))) continue
    lines.push(`// ${patch.id}: ${patch.marker}`)
  }
  lines.push("export const fixture = true", "")
  return lines.join("\n")
}

function snapshot(root, skip = () => false) {
  const rows = []
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(directory, entry.name)
      if (skip(relative)) continue
      if (entry.isDirectory()) {
        rows.push(`${relative}/`)
        walk(full, relative)
      } else {
        rows.push(`${relative} ${sha256(readFileSync(full))}`)
      }
    }
  }
  walk(root, "")
  return rows.sort()
}

function countOf(haystack, needle) {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count++
    at = haystack.indexOf(needle, at + 1)
  }
  return count
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "octm-installer-"))
  const webDist = join(root, "web-dist")
  const assets = join(webDist, "assets")
  mkdirSync(assets, { recursive: true })
  const assetText = buildSyntheticAsset()
  const assetPath = join(assets, "useAppFontEffects-test.js")
  writeFileSync(assetPath, assetText, "utf8")
  writeFileSync(join(assets, "main-boot.js"), 'export const load = () => import("./main-test.js")\n', "utf8")
  writeFileSync(join(assets, "main-test.js"), "export const app = true\n", "utf8")
  writeFileSync(join(assets, "main-noise.css"), "body{margin:0}\n", "utf8")
  const indexPath = join(webDist, "index.html")
  writeFileSync(indexPath, INDEX_HTML, "utf8")
  return {
    root,
    webDist,
    assets,
    indexPath,
    assetPath,
    assetText,
    assetSha: sha256(Buffer.from(assetText, "utf8")),
    indexBytes: Buffer.from(INDEX_HTML, "utf8"),
    recordPath: join(webDist, ".octm-install.json"),
    backupRoot: join(webDist, ".octm-backups"),
  }
}

function runInstaller(argv, envOverrides = {}) {
  const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath, ...argv], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...envOverrides },
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  return { code: result.status, stdout, stderr, output: `${stdout}${stderr}` }
}

function portable(output, root) {
  return output.split(root).join("<web-dist>")
}

function portableRecord(record, root) {
  return {
    version: record.version,
    assetSha256: record.assetSha256,
    indexHtmlSha256: record.indexHtmlSha256,
    files: record.files.map(entry => [entry.path.split(root).join("<web-dist>"), entry.sha256]),
    added: record.added.map(path => path.split(root).join("<web-dist>")),
  }
}

function applyArgs(fixture, extra = []) {
  return ["-WebDist", fixture.webDist, "-Apply", "-ExpectedSha256", fixture.assetSha, ...extra]
}

function rewriteRecord(fixture, mutate) {
  const record = JSON.parse(readFileSync(fixture.recordPath, "utf8"))
  mutate(record)
  writeFileSync(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  return record
}

function foreignFile(fixture, name) {
  const directory = join(fixture.root, "plugin-package")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, `export const ${name.replace(/\W/g, "")} = true\n`, "utf8")
  return { path, sha256: sha256(readFileSync(path)) }
}

test("bootstrap files are byte-identical to the audited installed build", () => {
  for (const name of BOOTSTRAP_FILES) {
    const bytes = readFileSync(join(bootstrapDir, name))
    const expected = INSTALLED_BOOTSTRAP[name]
    assert.equal(sha256(bytes), expected.sha256, `${name} sha256`)
    assert.equal(bytes.length, expected.size, `${name} size`)
  }
  const bootstrap = readFileSync(join(bootstrapDir, "octm-bootstrap.js"), "utf8")
  assert.equal(bootstrap.indexOf('from "./octm/runtime.mjs"') >= 0, true)
  assert.equal(bootstrap.indexOf("installBootstrap(globalThis)") >= 0, true)
})

if (!powershell) {
  test("installer suite skipped", { skip: "powershell.exe is not installed (non-Windows, or the binary is missing)" }, () => {})
} else {
  describe("install-openchamber-adapter.ps1", () => {
    test("hashing works without cmdlet-module autoload", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const source = readFileSync(installerPath, "utf8")
      for (const cmdlet of ["Get-FileHash", "Test-Json", "Compress-Archive"]) {
        assert.equal(source.includes(cmdlet), false, `${cmdlet} must not be used by the installer`)
      }

      const dry = runInstaller(["-WebDist", fixture.webDist, "-ExpectedSha256", fixture.assetSha])
      assert.equal(dry.code, 0, dry.output)
      assert.equal(
        dry.output.includes(`asset sha256: ${fixture.assetSha}`),
        true,
        "the asset digest matches node:crypto",
      )

      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)

      const tampered = join(fixture.webDist, "octm-config.js")
      writeFileSync(tampered, "// tampered after the install\n", "utf8")
      const tamperedSha = sha256(readFileSync(tampered))
      const drift = runInstaller(["-WebDist", fixture.webDist])
      assert.equal(drift.code, 1, drift.output)
      assert.match(drift.output, /changed since then/)
      assert.equal(drift.output.includes(tamperedSha), true, "the file digest matches node:crypto")
    })

    test("dry run changes nothing", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const before = snapshot(fixture.webDist)
      const result = runInstaller(["-WebDist", fixture.webDist, "-ExpectedSha256", fixture.assetSha])
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /result: ok/)
      assert.match(result.output, /dry run: nothing was written/)
      assert.match(result.output, /would patch: /)
      assert.match(result.output, /would add 3 adapter tags before \/assets\/main-boot\.js/)
      assert.deepEqual(snapshot(fixture.webDist), before)
      assert.equal(existsSync(join(fixture.webDist, "octm")), false)
      assert.equal(existsSync(fixture.recordPath), false)
      assert.equal(existsSync(fixture.backupRoot), false)
    })

    test("a broken PSModulePath changes neither the dry run nor the apply result", t => {
      for (const poison of hostileModulePaths()) {
        const control = makeFixture()
        const exposed = makeFixture()
        t.after(() => {
          rmSync(control.root, { recursive: true, force: true })
          rmSync(exposed.root, { recursive: true, force: true })
        })

        const controlDry = runInstaller(["-WebDist", control.webDist, "-ExpectedSha256", control.assetSha])
        const exposedDry = runInstaller(["-WebDist", exposed.webDist, "-ExpectedSha256", exposed.assetSha], { PSModulePath: poison })
        assert.equal(controlDry.code, 0, controlDry.output)
        assert.equal(exposedDry.code, 0, `${poison}\n${exposedDry.output}`)
        assert.match(exposedDry.output, /result: ok/)
        assert.equal(portable(exposedDry.output, exposed.webDist), portable(controlDry.output, control.webDist), poison)

        const controlApply = runInstaller(applyArgs(control))
        const exposedApply = runInstaller(applyArgs(exposed), { PSModulePath: poison })
        assert.equal(controlApply.code, 0, controlApply.output)
        assert.equal(exposedApply.code, 0, `${poison}\n${exposedApply.output}`)
        assert.match(exposedApply.output, /verified: 11 written file\(s\) match the install record/)
        assert.match(exposedApply.output, /result: ok/)

        const ignoreVolatile = relative => relative === ".octm-install.json" || relative.startsWith(".octm-backups/")
        assert.deepEqual(
          snapshot(exposed.webDist, ignoreVolatile),
          snapshot(control.webDist, ignoreVolatile),
          `installed tree differs under ${poison}`,
        )

        const exposedRecord = JSON.parse(readFileSync(exposed.recordPath, "utf8"))
        const controlRecord = JSON.parse(readFileSync(control.recordPath, "utf8"))
        assert.deepEqual(
          portableRecord(exposedRecord, exposed.webDist),
          portableRecord(controlRecord, control.webDist),
          `install record differs under ${poison}`,
        )

        const reverified = runInstaller(["-WebDist", exposed.webDist], { PSModulePath: poison })
        assert.equal(reverified.code, 0, reverified.output)
        assert.match(reverified.output, /result: already-installed/)
      }
    })

    test("apply installs bootstrap files, modules, patched asset, index tags, backup and record", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const expectedPatched = applyPatches(fixture.assetText)
      const result = runInstaller(applyArgs(fixture))
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /result: ok/)
      assert.match(result.output, /OVERRIDE: -ExpectedSha256/)

      for (const name of BOOTSTRAP_FILES) {
        const installed = readFileSync(join(fixture.webDist, name))
        assert.equal(sha256(installed), sha256(readFileSync(join(bootstrapDir, name))), `${name} copied verbatim`)
      }
      for (const name of MODULE_FILES) {
        const installed = readFileSync(join(fixture.webDist, "octm", name))
        assert.equal(sha256(installed), sha256(readFileSync(join(adapterDir, name))), `${name} copied verbatim`)
      }
      const moduleEntries = readdirSync(join(fixture.webDist, "octm")).sort()
      assert.deepEqual(moduleEntries, [...MODULE_FILES].sort())

      const patchedBytes = readFileSync(fixture.assetPath)
      assert.notEqual(sha256(patchedBytes), fixture.assetSha)
      assert.equal(patchedBytes.toString("utf8"), expectedPatched, "patched asset is the manifest output")
      assert.equal(patchedBytes.includes("__octm"), true)

      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of INDEX_TAGS) assert.equal(countOf(index, tag), 1, `${tag} appears once`)
      const sequence = `${INDEX_TAGS.join("\n    ")}\n    <script type="module" crossorigin src="/assets/main-boot.js"></script>`
      assert.equal(index.includes(sequence), true, "tags sit immediately before the entry script")
      assert.equal(index.indexOf(INDEX_TAGS[0]) < index.indexOf("/assets/main-boot.js"), true)

      const backupDirs = readdirSync(fixture.backupRoot)
      assert.equal(backupDirs.length, 1)
      assert.match(backupDirs[0], /^\d{8}-\d{6}(-\d+)?$/)
      const backupDir = join(fixture.backupRoot, backupDirs[0])
      assert.equal(sha256(readFileSync(join(backupDir, "index.html"))), sha256(fixture.indexBytes))
      assert.equal(sha256(readFileSync(join(backupDir, "useAppFontEffects-test.js"))), fixture.assetSha)
      const backupManifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"))
      assert.equal(backupManifest.version, PATCH_MANIFEST.version)
      assert.equal(backupManifest.pinned, PATCH_MANIFEST.sha256)
      assert.equal(backupManifest.files.length, 2)
      for (const entry of backupManifest.files) {
        assert.equal(typeof entry.size, "number")
        assert.equal(typeof entry.patchedSha256, "string")
        assert.equal(typeof entry.patchedSize, "number")
      }

      const record = JSON.parse(readFileSync(fixture.recordPath, "utf8"))
      assert.equal(record.version, PATCH_MANIFEST.version)
      assert.equal(Number.isNaN(Date.parse(record.installedAt)), false)
      assert.equal(record.assetSha256, sha256(patchedBytes))
      assert.equal(record.backupDir, backupDir)
      assert.equal(record.files.length, 11)
      assert.equal(record.added.length, 9)
      assert.equal(record.indexHtmlSha256, sha256(Buffer.from(index, "utf8")))
      for (const entry of record.files) {
        assert.equal(sha256(readFileSync(entry.path)), entry.sha256, `${entry.path} recorded hash`)
      }
      const addedSet = new Set(record.added.map(path => path.split(sep).join("/")))
      for (const name of BOOTSTRAP_FILES) {
        assert.equal(addedSet.has(join(fixture.webDist, name).split(sep).join("/")), true)
      }
      for (const name of MODULE_FILES) {
        assert.equal(addedSet.has(join(fixture.webDist, "octm", name).split(sep).join("/")), true)
      }
      assert.equal(result.output.includes("__octm-config"), false)
    })

    test("a second apply is a no-op that reports already-installed", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const first = runInstaller(applyArgs(fixture))
      assert.equal(first.code, 0, first.output)
      const recordBefore = readFileSync(fixture.recordPath)
      const indexBefore = readFileSync(fixture.indexPath)
      const before = snapshot(fixture.webDist)

      const second = runInstaller(applyArgs(fixture))
      assert.equal(second.code, 0, second.output)
      assert.match(second.output, /already installed \(version 2\.5\.2\)/)
      assert.match(second.output, /result: already-installed/)
      assert.deepEqual(snapshot(fixture.webDist), before)
      assert.equal(readFileSync(fixture.recordPath).equals(recordBefore), true)
      assert.equal(readFileSync(fixture.indexPath).equals(indexBefore), true)

      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of INDEX_TAGS) assert.equal(countOf(index, tag), 1, `${tag} not duplicated`)

      const dry = runInstaller(["-WebDist", fixture.webDist])
      assert.equal(dry.code, 0, dry.output)
      assert.match(dry.output, /already-installed/)
      assert.match(dry.output, /dry run: nothing was written/)
      assert.deepEqual(snapshot(fixture.webDist), before)
    })

    test("rollback restores the originals and removes only added files", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)
      const unrelated = join(fixture.assets, "unrelated.js")
      writeFileSync(unrelated, "export const keep = true\n", "utf8")
      const unrelatedSha = sha256(readFileSync(unrelated))

      const result = runInstaller(["-WebDist", fixture.webDist, "-Rollback"])
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /result: rollback-complete/)
      assert.equal(readFileSync(fixture.indexPath).equals(fixture.indexBytes), true)
      assert.equal(sha256(readFileSync(fixture.assetPath)), fixture.assetSha)
      for (const name of BOOTSTRAP_FILES) {
        assert.equal(existsSync(join(fixture.webDist, name)), false, `${name} removed`)
      }
      for (const name of MODULE_FILES) {
        assert.equal(existsSync(join(fixture.webDist, "octm", name)), false, `${name} removed`)
      }
      assert.equal(existsSync(fixture.recordPath), false)
      assert.equal(existsSync(unrelated), true)
      assert.equal(sha256(readFileSync(unrelated)), unrelatedSha)
      assert.equal(existsSync(join(fixture.assets, "main-boot.js")), true)
      assert.equal(existsSync(join(fixture.assets, "main-test.js")), true)

      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of INDEX_TAGS) assert.equal(countOf(index, tag), 0)
    })

    test("recorded paths outside the install root are ignored by drift and apply", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)

      const outside = foreignFile(fixture, "plugin.js")
      rewriteRecord(fixture, record => {
        record.files.push({ path: outside.path, sha256: "0".repeat(64) })
        record.added.push(outside.path)
      })
      const recordBefore = readFileSync(fixture.recordPath)
      const before = snapshot(fixture.webDist)

      const dry = runInstaller(["-WebDist", fixture.webDist])
      assert.equal(dry.code, 0, dry.output)
      assert.match(dry.output, /already installed \(version 2\.5\.2\)/)
      assert.match(dry.output, /result: already-installed/)
      assert.equal(countOf(dry.output, "note: ignored "), 1, dry.output)
      assert.match(dry.output, /note: ignored 1 recorded path\(s\) outside .*web-dist/)
      assert.equal(dry.output.includes(outside.path), false, "the ignored path itself is not printed")
      assert.deepEqual(snapshot(fixture.webDist), before)

      const reapplied = runInstaller(["-WebDist", fixture.webDist, "-Apply"])
      assert.equal(reapplied.code, 0, reapplied.output)
      assert.match(reapplied.output, /result: already-installed/)
      assert.equal(countOf(reapplied.output, "note: ignored "), 1, reapplied.output)
      assert.deepEqual(snapshot(fixture.webDist), before)
      assert.equal(readFileSync(fixture.recordPath).equals(recordBefore), true)
      assert.equal(sha256(readFileSync(outside.path)), outside.sha256)
    })

    test("rollback leaves recorded paths outside the install root untouched", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)

      const outsideAdded = foreignFile(fixture, "plugin.js")
      const outsideOther = foreignFile(fixture, "index.js")
      rewriteRecord(fixture, record => {
        record.files.push({ path: outsideAdded.path, sha256: outsideAdded.sha256 })
        record.files.push({ path: outsideOther.path, sha256: "0".repeat(64) })
        record.added.push(outsideAdded.path)
        record.added.push(outsideOther.path)
      })

      const result = runInstaller(["-WebDist", fixture.webDist, "-Rollback"])
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /result: rollback-complete/)
      assert.equal(countOf(result.output, "note: ignored "), 1, result.output)
      assert.match(result.output, /note: ignored 2 recorded path\(s\) outside .*; they are left untouched/)
      assert.equal(result.output.includes(outsideAdded.path), false, "no outside path is printed")

      assert.equal(existsSync(outsideAdded.path), true)
      assert.equal(existsSync(outsideOther.path), true)
      assert.equal(sha256(readFileSync(outsideAdded.path)), outsideAdded.sha256)
      assert.equal(sha256(readFileSync(outsideOther.path)), outsideOther.sha256)

      assert.equal(readFileSync(fixture.indexPath).equals(fixture.indexBytes), true)
      assert.equal(sha256(readFileSync(fixture.assetPath)), fixture.assetSha)
      for (const name of BOOTSTRAP_FILES) {
        assert.equal(existsSync(join(fixture.webDist, name)), false, `${name} removed`)
      }
      for (const name of MODULE_FILES) {
        assert.equal(existsSync(join(fixture.webDist, "octm", name)), false, `${name} removed`)
      }
      assert.equal(existsSync(fixture.recordPath), false)
    })

    test("a recorded path that escapes the root with .. is skipped, not followed", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)

      const escaped = join(fixture.root, "escaped.js")
      writeFileSync(escaped, "export const escaped = true\n", "utf8")
      const escapedSha = sha256(readFileSync(escaped))
      const traversal = join(fixture.webDist, "..", "escaped.js")
      rewriteRecord(fixture, record => {
        record.files.push({ path: traversal, sha256: "0".repeat(64) })
      })

      const dry = runInstaller(["-WebDist", fixture.webDist])
      assert.equal(dry.code, 0, dry.output)
      assert.match(dry.output, /result: already-installed/)
      assert.equal(countOf(dry.output, "note: ignored "), 1, dry.output)
      assert.match(dry.output, /note: ignored 1 recorded path\(s\) outside .*web-dist/)
      assert.equal(dry.output.includes(traversal), false, "the traversal path itself is not printed")
      assert.equal(sha256(readFileSync(escaped)), escapedSha)

      const rollback = runInstaller(["-WebDist", fixture.webDist, "-Rollback"])
      assert.equal(rollback.code, 0, rollback.output)
      assert.equal(existsSync(escaped), true)
      assert.equal(sha256(readFileSync(escaped)), escapedSha)
      assert.equal(readFileSync(fixture.indexPath).equals(fixture.indexBytes), true)
    })

    test("a wrong expected hash is refused before anything is written", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const before = snapshot(fixture.webDist)
      const result = runInstaller(["-WebDist", fixture.webDist, "-Apply", "-ExpectedSha256", "0".repeat(64)])
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /result: refused/)
      assert.match(result.output, /does not match the expected/)
      assert.deepEqual(snapshot(fixture.webDist), before)
      assert.equal(existsSync(fixture.recordPath), false)
      assert.equal(existsSync(join(fixture.webDist, "octm")), false)
      assert.equal(existsSync(fixture.backupRoot), false)
    })

    test("a foreign file at a target path is refused without -Force", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const foreignPath = join(fixture.webDist, "octm-config.js")
      writeFileSync(foreignPath, "// not written by the installer\n", "utf8")
      const before = snapshot(fixture.webDist)
      const result = runInstaller(applyArgs(fixture))
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /result: refused/)
      assert.match(result.output, /did not create/)
      assert.deepEqual(snapshot(fixture.webDist), before)
      assert.equal(existsSync(fixture.recordPath), false)
      assert.equal(existsSync(join(fixture.webDist, "octm-fallback.js")), false)
      assert.equal(existsSync(join(fixture.webDist, "octm")), false)
      assert.equal(existsSync(fixture.backupRoot), false)
      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of INDEX_TAGS) assert.equal(countOf(index, tag), 0)
    })
  })
}
