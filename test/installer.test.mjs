import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    sha256: "fe5e7911998774b43172774f9a8c6902dc033d29bdd9bb0e8a47d50a3b6877a6",
    size: 101,
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

function adapterRev(directory) {
  const combined = [...MODULE_FILES].sort().map(name => sha256(readFileSync(join(directory, name)))).join("")
  return sha256(Buffer.from(combined, "utf8")).slice(0, 8)
}

function indexTags(rev) {
  return [
    `<script src="/octm-config.js?rev=${rev}"></script>`,
    `<script src="/octm-fallback.js?rev=${rev}"></script>`,
    `<script type="module" crossorigin src="/octm-bootstrap.js?rev=${rev}"></script>`,
  ]
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

function runInstaller(argv, envOverrides = {}, installer = installerPath) {
  const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, ...argv], {
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

test("bootstrap files are byte-identical to the audited adapter sources", () => {
  for (const name of BOOTSTRAP_FILES) {
    const bytes = readFileSync(join(bootstrapDir, name))
    const expected = INSTALLED_BOOTSTRAP[name]
    assert.equal(sha256(bytes), expected.sha256, `${name} sha256`)
    assert.equal(bytes.length, expected.size, `${name} size`)
  }
  const bootstrap = readFileSync(join(bootstrapDir, "octm-bootstrap.js"), "utf8")
  assert.equal(bootstrap.indexOf('from "./octm/runtime.mjs?rev=__OCTM_REV__"') >= 0, true)
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
      const rev = adapterRev(adapterDir)
      const expectedPatched = applyPatches(fixture.assetText)
      const result = runInstaller(applyArgs(fixture))
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /result: ok/)
      assert.match(result.output, /OVERRIDE: -ExpectedSha256/)
      assert.equal(result.output.includes(`adapter revision: ${rev}`), true)

      const verbatim = BOOTSTRAP_FILES.filter(name => name !== "octm-bootstrap.js")
      for (const name of verbatim) {
        const installed = readFileSync(join(fixture.webDist, name))
        assert.equal(sha256(installed), sha256(readFileSync(join(bootstrapDir, name))), `${name} copied verbatim`)
      }
      const installedBootstrap = readFileSync(join(fixture.webDist, "octm-bootstrap.js"), "utf8")
      assert.equal(installedBootstrap.includes(`from "./octm/runtime.mjs?rev=${rev}"`), true)
      assert.equal(installedBootstrap.includes("installBootstrap(globalThis)"), true)
      assert.equal(countOf(installedBootstrap, "__OCTM_REV__"), 0)
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

      const tags = indexTags(rev)
      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of tags) assert.equal(countOf(index, tag), 1, `${tag} appears once`)
      assert.match(index, /\?rev=[0-9a-f]{8}/)
      assert.equal(countOf(index, `?rev=${rev}`), 3, "all three tags carry the same revision")
      const sequence = `${tags.join("\n    ")}\n    <script type="module" crossorigin src="/assets/main-boot.js"></script>`
      assert.equal(index.includes(sequence), true, "tags sit immediately before the entry script")
      assert.equal(index.indexOf(tags[0]) < index.indexOf("/assets/main-boot.js"), true)

      const backupDirs = readdirSync(fixture.backupRoot)
      assert.equal(backupDirs.length, 1)
      assert.match(backupDirs[0], /^\d{8}-\d{6}(-\d+)?$/)
      const backupDir = join(fixture.backupRoot, backupDirs[0])
      assert.equal(sha256(readFileSync(join(backupDir, "index.html"))), sha256(fixture.indexBytes))
      assert.equal(sha256(readFileSync(join(backupDir, "useAppFontEffects-test.js"))), fixture.assetSha)
      const backupManifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"))
      assert.equal(backupManifest.version, PATCH_MANIFEST.version)
      assert.equal(backupManifest.rev, rev)
      assert.equal(backupManifest.pinned, PATCH_MANIFEST.sha256)
      assert.equal(backupManifest.files.length, 2)
      for (const entry of backupManifest.files) {
        assert.equal(typeof entry.size, "number")
        assert.equal(typeof entry.patchedSha256, "string")
        assert.equal(typeof entry.patchedSize, "number")
      }

      const record = JSON.parse(readFileSync(fixture.recordPath, "utf8"))
      assert.equal(record.version, PATCH_MANIFEST.version)
      assert.equal(record.rev, rev)
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
      const rev = adapterRev(adapterDir)
      const first = runInstaller(applyArgs(fixture))
      assert.equal(first.code, 0, first.output)
      const recordBefore = readFileSync(fixture.recordPath)
      const indexBefore = readFileSync(fixture.indexPath)
      const bootstrapBefore = readFileSync(join(fixture.webDist, "octm-bootstrap.js"))
      const before = snapshot(fixture.webDist)

      const second = runInstaller(applyArgs(fixture))
      assert.equal(second.code, 0, second.output)
      assert.match(second.output, /already installed \(version 2\.5\.2\)/)
      assert.match(second.output, /result: already-installed/)
      assert.equal(second.output.includes(`revision: ${rev}`), true)
      assert.deepEqual(snapshot(fixture.webDist), before)
      assert.equal(readFileSync(fixture.recordPath).equals(recordBefore), true)
      assert.equal(readFileSync(fixture.indexPath).equals(indexBefore), true)
      assert.equal(readFileSync(join(fixture.webDist, "octm-bootstrap.js")).equals(bootstrapBefore), true)
      assert.equal(JSON.parse(readFileSync(fixture.recordPath, "utf8")).rev, rev)

      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of indexTags(rev)) assert.equal(countOf(index, tag), 1, `${tag} not duplicated`)

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
      assert.equal(index.includes("?rev="), false)
      for (const tag of indexTags(adapterRev(adapterDir))) assert.equal(countOf(index, tag), 0)
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
      for (const tag of indexTags(adapterRev(adapterDir))) assert.equal(countOf(index, tag), 0)
    })

    test("apply replaces adapter tags from another revision without duplicating them", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const rev = adapterRev(adapterDir)
      const entryTag = '    <script type="module" crossorigin src="/assets/main-boot.js"></script>'
      const staleTags = indexTags("deadbeef").map(tag => `    ${tag}`).join("\n")
      const tagged = INDEX_HTML.replace(entryTag, `${staleTags}\n${entryTag}`)
      writeFileSync(fixture.indexPath, tagged, "utf8")

      const dry = runInstaller(["-WebDist", fixture.webDist, "-ExpectedSha256", fixture.assetSha])
      assert.equal(dry.code, 0, dry.output)
      assert.match(dry.output, /would add 3 adapter tags before \/assets\/main-boot\.js/)
      assert.equal(readFileSync(fixture.indexPath, "utf8"), tagged, "the dry run leaves the stale tags alone")

      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)
      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of indexTags(rev)) assert.equal(countOf(index, tag), 1)
      assert.equal(index.includes("deadbeef"), false)
      assert.equal(countOf(index, 'src="/octm-config.js'), 1)
      assert.equal(countOf(index, 'src="/octm-fallback.js'), 1)
      assert.equal(countOf(index, 'src="/octm-bootstrap.js'), 1)
    })

    test("an install whose recorded revision is not current is drift, repaired by rollback then apply", t => {
      const fixture = makeFixture()
      t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
      const rev = adapterRev(adapterDir)
      const applied = runInstaller(applyArgs(fixture))
      assert.equal(applied.code, 0, applied.output)

      const struckIndex = readFileSync(fixture.indexPath, "utf8").split(`?rev=${rev}`).join("")
      writeFileSync(fixture.indexPath, struckIndex, "utf8")
      const struckSha = sha256(Buffer.from(struckIndex, "utf8"))
      rewriteRecord(fixture, record => {
        delete record.rev
        for (const entry of record.files) {
          if (entry.path.split(sep).join("/") === fixture.indexPath.split(sep).join("/")) entry.sha256 = struckSha
        }
        record.indexHtmlSha256 = struckSha
      })
      const before = snapshot(fixture.webDist)

      const dry = runInstaller(["-WebDist", fixture.webDist])
      assert.equal(dry.code, 1, dry.output)
      assert.match(dry.output, /result: refused/)
      assert.match(dry.output, /the adapter revision drifted: recorded revision \(none\) is not [0-9a-f]{8}/)
      assert.match(dry.output, /index\.html does not reference the adapter tags for revision [0-9a-f]{8}/)
      assert.deepEqual(snapshot(fixture.webDist), before, "a refused install writes nothing")

      const rollback = runInstaller(["-WebDist", fixture.webDist, "-Rollback"])
      assert.equal(rollback.code, 0, rollback.output)
      assert.match(rollback.output, /result: rollback-complete/)
      assert.equal(readFileSync(fixture.indexPath).equals(fixture.indexBytes), true)
      assert.equal(readFileSync(fixture.indexPath, "utf8").includes("?rev="), false)
      assert.equal(existsSync(join(fixture.webDist, "octm-bootstrap.js")), false)

      const reapplied = runInstaller(applyArgs(fixture))
      assert.equal(reapplied.code, 0, reapplied.output)
      assert.equal(JSON.parse(readFileSync(fixture.recordPath, "utf8")).rev, rev)
      const index = readFileSync(fixture.indexPath, "utf8")
      for (const tag of indexTags(rev)) assert.equal(countOf(index, tag), 1)
    })

    test("changing one adapter module changes the revision in a fresh tree", t => {
      const cloneRoot = mkdtempSync(join(tmpdir(), "octm-clone-"))
      const clone = join(cloneRoot, "repo")
      mkdirSync(clone, { recursive: true })
      cpSync(join(repoRoot, "scripts"), join(clone, "scripts"), { recursive: true })
      cpSync(join(repoRoot, "integrations"), join(clone, "integrations"), { recursive: true })
      const cloneInstaller = join(clone, "scripts", "install-openchamber-adapter.ps1")
      const cloneAdapterDir = join(clone, "integrations", "openchamber")
      const first = makeFixture()
      const second = makeFixture()
      t.after(() => {
        rmSync(first.root, { recursive: true, force: true })
        rmSync(second.root, { recursive: true, force: true })
        rmSync(cloneRoot, { recursive: true, force: true })
      })

      const revBefore = adapterRev(cloneAdapterDir)
      assert.match(revBefore, /^[0-9a-f]{8}$/)
      const appliedBefore = runInstaller(applyArgs(first), {}, cloneInstaller)
      assert.equal(appliedBefore.code, 0, appliedBefore.output)
      assert.equal(JSON.parse(readFileSync(first.recordPath, "utf8")).rev, revBefore)

      const modulePath = join(cloneAdapterDir, "mention-source.mjs")
      writeFileSync(modulePath, `${readFileSync(modulePath, "utf8")}\n// fixture revision bump\n`, "utf8")
      const revAfter = adapterRev(cloneAdapterDir)
      assert.match(revAfter, /^[0-9a-f]{8}$/)
      assert.notEqual(revAfter, revBefore)

      const appliedAfter = runInstaller(applyArgs(second), {}, cloneInstaller)
      assert.equal(appliedAfter.code, 0, appliedAfter.output)
      assert.equal(JSON.parse(readFileSync(second.recordPath, "utf8")).rev, revAfter)
      const bootstrap = readFileSync(join(second.webDist, "octm-bootstrap.js"), "utf8")
      assert.equal(bootstrap.includes(`from "./octm/runtime.mjs?rev=${revAfter}"`), true)
      const index = readFileSync(second.indexPath, "utf8")
      for (const tag of indexTags(revAfter)) assert.equal(countOf(index, tag), 1)
      assert.equal(index.includes(revBefore), false)
    })
  })
}
