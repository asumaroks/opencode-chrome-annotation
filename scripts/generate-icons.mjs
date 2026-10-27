import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Resvg } from "@resvg/resvg-js"

export function generateIcons(root) {
  const outputDir = join(root, "extension", "icons")
  const svg = readFileSync(join(root, "icon.svg"))
  mkdirSync(outputDir, { recursive: true })
  for (const size of [16, 48, 128]) {
    const icon = new Resvg(svg, { fitTo: { mode: "width", value: size } })
    writeFileSync(join(outputDir, `icon${size}.png`), icon.render().asPng())
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIcons(process.cwd())
}
