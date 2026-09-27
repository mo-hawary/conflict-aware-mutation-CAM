// Runs the smoke checks in headless Chromium, Firefox, and WebKit via Playwright.
// CI installs Playwright on demand; it is not a project dependency.
// Usage: node test/runtime/browser.mjs (after `npm run build`)
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

import { chromium, firefox, webkit } from "playwright"

const root = fileURLToPath(new URL("../../", import.meta.url))
const types = { ".js": "text/javascript", ".html": "text/html" }
const page = `<!doctype html><script type="module">
import * as cam from "/dist/index.js"
import { runSmoke } from "/test/runtime/smoke.js"
window.__results = runSmoke(cam)
</script>`

const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname))
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html" })
    return response.end(page)
  }
  if (!path.startsWith("/dist/") && !path.startsWith("/test/runtime/")) {
    response.writeHead(404)
    return response.end()
  }
  try {
    const body = await readFile(join(root, path))
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const { report } = await import("./smoke.js")
let passed = true
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch()
    try {
      const tab = await browser.newPage()
      await tab.goto(url)
      const results = await tab.waitForFunction(() => window.__results, null, { timeout: 10_000 })
      passed = report(name, await results.jsonValue()) && passed
    } finally {
      await browser.close()
    }
  }
} finally {
  server.close()
}
if (!passed) process.exit(1)
