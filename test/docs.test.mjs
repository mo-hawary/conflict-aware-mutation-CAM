import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("documents the root-zero JSON depth boundary", () => {
  const dataModel = readFileSync(new URL("../docs/data-model.md", import.meta.url), "utf8")

  assert.match(
    dataModel,
    /The root has depth 0; each object property or array index adds one depth level, and values deeper than 512 are rejected\./,
  )
})
