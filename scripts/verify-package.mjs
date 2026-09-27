import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(scriptDir)
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cam-package-"))
const packDir = path.join(tempRoot, "pack")
const consumerDir = path.join(tempRoot, "consumer")

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  })

try {
  mkdirSync(packDir, { recursive: true })
  mkdirSync(consumerDir, { recursive: true })

  const dryRunJson = run(
    "npm",
    ["pack", "--dry-run", "--json"],
    { capture: true },
  )
  const dryRun = JSON.parse(dryRunJson)[0]
  assert(dryRun, "npm pack --dry-run did not return package metadata")

  const packedJson = run(
    "npm",
    ["pack", "--json", "--pack-destination", packDir],
    { capture: true },
  )
  const packed = JSON.parse(packedJson)[0]
  assert(packed, "npm pack did not return package metadata")

  const dryRunPaths = dryRun.files.map((file) => file.path).sort()
  const packedPaths = packed.files.map((file) => file.path).sort()
  assert.deepEqual(
    dryRunPaths,
    packedPaths,
    "npm pack --dry-run manifest differs from the real tarball manifest",
  )

  const tarball = path.join(packDir, packed.filename)
  assert(existsSync(tarball), `packed tarball missing: ${tarball}`)

  for (const required of ["dist/index.js", "dist/index.d.ts", "src/index.ts"]) {
    assert(packedPaths.includes(required), `required packed file missing: ${required}`)
  }
  assert(!packedPaths.some((file) => file.startsWith("test/")), "tests leaked into package")
  assert(!packedPaths.some((file) => file.startsWith(".github/")), "GitHub metadata leaked into package")

  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "cam-package-consumer", private: true, type: "module" }, null, 2),
  )
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
    { cwd: consumerDir },
  )

  const packageRoot = realpathSync(path.join(consumerDir, "node_modules", "conflict-aware-mutation"))
  assert.notEqual(packageRoot, realpathSync(repoRoot), "consumer resolved the repository instead of the tarball")
  assert(packageRoot.startsWith(realpathSync(consumerDir) + path.sep), "installed package escaped consumer directory")

  const mapFiles = packedPaths.filter((file) => file.endsWith(".map"))
  assert(mapFiles.length > 0, "expected source/declaration maps in package")
  for (const relativeMap of mapFiles) {
    const mapPath = path.join(packageRoot, relativeMap)
    const map = JSON.parse(readFileSync(mapPath, "utf8"))
    assert(Array.isArray(map.sources) && map.sources.length > 0, `${relativeMap} has no sources`)

    for (const [index, source] of map.sources.entries()) {
      const embedded = Array.isArray(map.sourcesContent) && typeof map.sourcesContent[index] === "string"
      if (embedded) continue

      const resolvedSource = path.resolve(
        path.dirname(mapPath),
        typeof map.sourceRoot === "string" ? map.sourceRoot : "",
        source,
      )
      assert(
        resolvedSource.startsWith(packageRoot + path.sep),
        `${relativeMap} resolves outside the installed package: ${source}`,
      )
      assert(existsSync(resolvedSource), `${relativeMap} points to missing source: ${source}`)
    }
  }

  const runtimeTest = `
import assert from "node:assert/strict"
import * as cam from "conflict-aware-mutation"

assert.deepEqual(Object.keys(cam).sort(), ["CAMConfigError", "matchConflictError", "mergeStates"])

assert.deepEqual(
  cam.matchConflictError({
    error: { code: 409, text: "Order was modified" },
    expectedError: { code: 409, text: "Order was modified" },
  }),
  { matched: true },
)

assert.deepEqual(
  cam.matchConflictError({
    error: { code: 409, text: "order was modified" },
    expectedError: { code: 409, text: "Order was modified" },
  }),
  { matched: false, error: { code: 409, text: "order was modified" } },
)

assert.deepEqual(
  cam.mergeStates({
    originalState: { name: "A", status: "draft" },
    submittedState: { name: "B", status: "draft" },
    currentServerState: { name: "A", status: "approved" },
  }),
  { ok: true, value: { name: "B", status: "approved" }, conflicts: [] },
)

assert.deepEqual(
  cam.mergeStates({
    originalState: { name: "A" },
    submittedState: { name: "B" },
    currentServerState: { name: "C" },
  }),
  {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["name"],
        submitted: { exists: true, value: "B" },
        currentServer: { exists: true, value: "C" },
      },
    ],
  },
)
`
  writeFileSync(path.join(consumerDir, "runtime.mjs"), runtimeTest)
  run("node", ["runtime.mjs"], { cwd: consumerDir })

  const typeConsumer = `
import { CAMConfigError, matchConflictError, mergeStates } from "conflict-aware-mutation"
import type { ErrorSignal, JsonValue, MergeResult } from "conflict-aware-mutation"

const error: ErrorSignal = { code: 409, text: "Order was modified" }
const match = matchConflictError({ error, expectedError: { code: 409 } })

const originalState = { name: "A" } satisfies JsonValue
const submittedState = { name: "B" } satisfies JsonValue
const currentServerState = { name: "A" } satisfies JsonValue
const result: MergeResult<typeof submittedState> = mergeStates({
  originalState,
  submittedState,
  currentServerState,
})

void CAMConfigError
void match
void result
`
  writeFileSync(path.join(consumerDir, "consumer.ts"), typeConsumer)
  writeFileSync(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
  )
  run(process.execPath, [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: consumerDir,
  })

  console.log("Package verification passed")
  console.log("npm pack --dry-run")
  console.log(`dry-run compressed: ${dryRun.size} bytes`)
  console.log(`dry-run unpacked: ${dryRun.unpackedSize} bytes`)
  console.log(`dry-run files: ${dryRun.files.length}`)
  for (const file of dryRunPaths) console.log(`  ${file}`)
  console.log(`tarball: ${packed.filename}`)
  console.log(`compressed: ${packed.size} bytes`)
  console.log(`unpacked: ${packed.unpackedSize} bytes`)
  console.log(`files: ${packed.files.length}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
