import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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

  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/recovery/index.js",
    "dist/recovery/index.d.ts",
    "src/index.ts",
    "src/recovery/index.ts",
  ]) {
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
import * as recovery from "conflict-aware-mutation/recovery"

assert.deepEqual(Object.keys(cam).sort(), [
  "CAMConfigError",
  "applyConflictDecisions",
  "formatConflictPath",
  "matchConflictError",
  "mergeStates",
  "resolveConflict",
])
assert.deepEqual(Object.keys(recovery).sort(), ["createRecoveryController"])

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

assert.deepEqual(
  cam.mergeStates({
    originalState: { name: "A", serverOnly: false },
    submittedState: { name: "B", serverOnly: false },
    currentServerState: { name: "A", serverOnly: true },
    groups: undefined,
    includeReport: undefined,
  }),
  { ok: true, value: { name: "B", serverOnly: true }, conflicts: [] },
)

const conflict = cam.mergeStates({
  originalState: { status: "pending" },
  submittedState: { status: "cancelled" },
  currentServerState: { status: "paid" },
}).conflicts[0]
assert.deepEqual(
  cam.applyConflictDecisions({
    sessionId: "package-smoke",
    originalState: { status: "pending" },
    submittedState: { status: "cancelled" },
    currentServerState: { status: "paid" },
    decisions: [{ sessionId: "package-smoke", conflict, choice: "currentServer" }],
  }),
  { ok: true, value: { status: "paid" }, conflicts: [] },
)
assert.equal(cam.formatConflictPath(["a/b", "x~y"]), "/a~1b/x~0y")
assert.deepEqual(
  cam.mergeStates({
    originalState: { note: "old" },
    submittedState: { note: undefined },
    currentServerState: { note: "old" },
    undefinedObjectProperties: "omit",
  }),
  { ok: true, value: {}, conflicts: [] },
)
`
  writeFileSync(path.join(consumerDir, "runtime.mjs"), runtimeTest)
  run("node", ["runtime.mjs"], { cwd: consumerDir })

  // CommonJS consumers load the ESM entries through require(esm) (Node 22.12+).
  const requireTest = `
const assert = require("node:assert/strict")
const cam = require("conflict-aware-mutation")
const recovery = require("conflict-aware-mutation/recovery")

assert.deepEqual(Object.keys(cam).sort(), [
  "CAMConfigError",
  "applyConflictDecisions",
  "formatConflictPath",
  "matchConflictError",
  "mergeStates",
  "resolveConflict",
])
assert.deepEqual(Object.keys(recovery).sort(), ["createRecoveryController"])
assert.deepEqual(
  cam.mergeStates({ originalState: { a: 1 }, submittedState: { a: 2 }, currentServerState: { a: 1 } }),
  { ok: true, value: { a: 2 }, conflicts: [] },
)

import("conflict-aware-mutation").then((esm) => {
  assert.equal(esm.CAMConfigError, cam.CAMConfigError, "require and import must share one module instance")
})
`
  writeFileSync(path.join(consumerDir, "require.cjs"), requireTest)
  run("node", ["require.cjs"], { cwd: consumerDir })

  const typeConsumer = `
import { CAMConfigError, applyConflictDecisions, formatConflictPath, matchConflictError, mergeStates, resolveConflict } from "conflict-aware-mutation"
import type { ErrorSignal, JsonValue, MergeResult, PathGroup } from "conflict-aware-mutation"
import { createRecoveryController } from "conflict-aware-mutation/recovery"
import type { NormalizedRecoveryControllerOptions, RecoveryController, RecoveryOutcome } from "conflict-aware-mutation/recovery"

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

const optionalUndefinedResult: MergeResult<typeof submittedState> = mergeStates({
  originalState,
  submittedState,
  currentServerState,
  groups: undefined,
  includeReport: undefined,
})

void CAMConfigError
void match
void result
void optionalUndefinedResult
void (null as unknown as NormalizedRecoveryControllerOptions<string>)
void applyConflictDecisions
void formatConflictPath
void resolveConflict
void createRecoveryController
void (null as unknown as PathGroup)
const outcome = null as unknown as RecoveryOutcome
const controller = null as unknown as RecoveryController<JsonValue, string>
void outcome
void controller
`
  writeFileSync(path.join(consumerDir, "consumer.ts"), typeConsumer)
  const commonJsTypeConsumer = `
import cam = require("conflict-aware-mutation")
import recovery = require("conflict-aware-mutation/recovery")

const result: cam.MergeResult<{ name: string }> = cam.mergeStates({
  originalState: { name: "A" },
  submittedState: { name: "B" },
  currentServerState: { name: "A" },
})
void result
void recovery.createRecoveryController
`
  writeFileSync(path.join(consumerDir, "consumer-commonjs.cts"), commonJsTypeConsumer)
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
        include: ["consumer.ts", "consumer-commonjs.cts"],
      },
      null,
      2,
    ),
  )
  run(process.execPath, [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: consumerDir,
  })

  // Retain only the artifact that passed the isolated consumer checks.
  if (process.env.CAM_RELEASE_DIR) {
    const destination = path.resolve(process.env.CAM_RELEASE_DIR)
    mkdirSync(destination, { recursive: true })
    copyFileSync(tarball, path.join(destination, "package.tgz"))
    writeFileSync(path.join(destination, "package.json"), JSON.stringify({
      name: packed.name, version: packed.version, integrity: packed.integrity,
    }))
  }

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
