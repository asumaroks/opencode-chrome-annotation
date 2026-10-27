import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("clean source package includes its entrypoints without lifecycle scripts", () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), "chrome-annotation-packaging-"))
  try {
    const sourceFiles = new Set(execFileSync("git", [
      "ls-files", "--cached", "--others", "--exclude-standard",
    ], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/))
    for (const file of ["package.json", "index.js", "dist/plugin.js"]) {
      mkdirSync(dirname(join(directory, file)), { recursive: true })
      cpSync(join(root, file), join(directory, file), { recursive: true })
    }
    const command = process.platform === "win32" ? "cmd.exe" : "npm"
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm pack --dry-run --ignore-scripts --json"]
      : ["pack", "--dry-run", "--ignore-scripts", "--json"]
    const output = execFileSync(command, args, { cwd: directory, encoding: "utf8" })
    const [packed] = JSON.parse(output)
    const files = new Set(packed.files.map((file) => file.path))
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
    for (const lifecycle of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) {
      assert.equal(manifest.scripts[lifecycle], undefined, `Git installation must not require npm preparation: ${lifecycle}`)
    }
    for (const entry of [manifest.main, ...Object.values(manifest.exports)]) {
      const path = entry.replace(/^\.\//, "")
      assert.ok(sourceFiles.has(path), `Entrypoint must be included in Git source: ${entry}`)
      assert.ok(files.has(path), `Missing packaged entrypoint: ${entry}`)
    }
    const fallback = readFileSync(join(directory, "index.js"), "utf8").match(/from "\.\/(.+)"/)
    assert.ok(fallback, "Root fallback must re-export the plugin")
    assert.ok(files.has(fallback[1]), `Missing fallback target: ${fallback[1]}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
