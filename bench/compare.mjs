// Compares two CAM_BENCH_JSON result files and prints a Markdown table.
// Usage: node bench/compare.mjs base.json head.json [threshold=0.25]
// Exits 0 always: shared CI runners are too noisy for a hard gate, so
// regressions beyond the threshold are flagged in the table and as warnings.
import { readFileSync } from "node:fs"

const [basePath, headPath, thresholdArg = "0.25"] = process.argv.slice(2)
const base = JSON.parse(readFileSync(basePath, "utf8"))
const head = JSON.parse(readFileSync(headPath, "utf8"))
const threshold = Number(thresholdArg)

const format = (ms) => (ms === undefined ? "—" : ms < 1 ? `${(ms * 1000).toFixed(1)} µs` : `${ms.toFixed(2)} ms`)

const lines = ["| Benchmark | Base | Head | Change |", "| --- | ---: | ---: | ---: |"]
for (const name of Object.keys(head)) {
  const before = base[name]
  const after = head[name]
  let change = "new"
  if (before !== undefined) {
    const ratio = after / before - 1
    change = `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`
    if (ratio > threshold) {
      change += " ⚠️"
      console.error(`::warning title=Benchmark regression::${name} is ${change} slower than base`)
    }
  }
  lines.push(`| ${name} | ${format(before)} | ${format(after)} | ${change} |`)
}
console.log(lines.join("\n"))
