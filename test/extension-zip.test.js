import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("extension ZIP builds without npm or zip executables and excludes stale output", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), "annotation zip with spaces "))
  try {
    for (const file of ["scripts", "extension-src", "icon.svg", "LICENSE"]) {
      cpSync(join(root, file), join(directory, file), { recursive: true })
    }
    writeFileSync(join(directory, "MODIFICATIONS.json"), JSON.stringify({ license: "GPL-3.0-only" }))
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    mkdirSync(join(directory, "extension", "node_modules"), { recursive: true })
    for (const file of ["stale.js.map", ".env", "unrelated.txt", "node_modules/private.js"]) {
      writeFileSync(join(directory, "extension", file), "must not ship")
    }
    const bin = join(directory, "bin")
    mkdirSync(bin)
    const bun = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["bun"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0]
    cpSync(bun, join(bin, process.platform === "win32" ? "bun.exe" : "bun"))
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key]
    }
    env.PATH = bin
    const result = spawnSync(process.execPath, [join(directory, "scripts", "build-extension-zip.mjs")], {
      cwd: directory, env, encoding: "utf8",
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const { unzipSync } = await import("fflate")
    const files = unzipSync(readFileSync(join(directory, "release", "opencode-chrome-annotation-extension.zip")))
    assert.deepEqual(Object.keys(files).sort(), [
      "LICENSE", "MODIFICATIONS.json", "background.js", "icons/icon128.png", "icons/icon16.png", "icons/icon48.png", "injected/dom.js", "manifest.json",
    ].sort())
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString())
    assert.equal(manifest.manifest_version, 3)
    assert.equal(manifest.version, JSON.parse(readFileSync(join(root, "extension-src", "manifest.json"))).version)
    for (const file of [manifest.background.service_worker, ...Object.values(manifest.icons), ...manifest.web_accessible_resources.flatMap((entry) => entry.resources)]) {
      assert.ok(files[file]?.length > 0, `Missing manifest asset: ${file}`)
    }
    assert.deepEqual(Buffer.from(files.LICENSE), readFileSync(join(root, "LICENSE")))
    for (const size of [16, 48, 128]) {
      const png = Buffer.from(files[`icons/icon${size}.png`])
      assert.equal(png.readUInt32BE(16), size)
      assert.equal(png.readUInt32BE(20), size)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
