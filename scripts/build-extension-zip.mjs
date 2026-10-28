import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { zipSync } from "fflate"

const root = resolve(process.cwd())
const extensionDir = join(root, "extension")
const outDir = join(root, "release")
const zipPath = join(outDir, "opencode-chrome-annotation-extension.zip")

const build = spawnSync(process.execPath, [join(root, "scripts", "build-extension.mjs")], {
  cwd: root,
  stdio: "inherit",
})

if (build.error) throw build.error
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

mkdirSync(outDir, { recursive: true })
const assets = [
  "manifest.json",
  "background.js",
  "injected/dom.js",
  "options.html",
  "options.css",
  "options.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
]
const files = Object.fromEntries([
  ...assets.map((file) => [file, readFileSync(join(extensionDir, file))]),
  ...["LICENSE", "MODIFICATIONS.json"].map((file) => [file, readFileSync(join(root, file))]),
])
writeFileSync(zipPath, zipSync(files, { level: 9, mtime: new Date(1980, 0, 1) }))
console.log(`Created ${zipPath}`)
