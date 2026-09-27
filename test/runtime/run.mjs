// Runs the smoke checks in the current server-side runtime (Node, Deno, or Bun).
// Usage: node|bun test/runtime/run.mjs, or deno run --allow-read test/runtime/run.mjs
import * as cam from "../../dist/index.js"
import { report, runSmoke } from "./smoke.js"

const runtime = globalThis.Deno ? "deno" : globalThis.Bun ? "bun" : "node"
if (!report(runtime, runSmoke(cam))) {
  if (globalThis.Deno) globalThis.Deno.exit(1)
  else globalThis.process.exit(1)
}
