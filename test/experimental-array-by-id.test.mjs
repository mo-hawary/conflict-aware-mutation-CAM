import assert from "node:assert/strict"
import test from "node:test"

import { CAMConfigError, mergeStates } from "../dist/index.js"
import { mergeArrayById } from "../bench/prototypes/array-by-id.mjs"

const merge = (originalState, submittedState, currentServerState) =>
  mergeArrayById({ originalState, submittedState, currentServerState })

test("merges sparse edits to different fields of the same ID-keyed record", () => {
  const result = merge(
    [{ id: "item-1", qty: 1, price: 10, metadata: { label: "old" } }],
    [{ id: "item-1", qty: 2, price: 10, metadata: { label: "old" } }],
    [{ id: "item-1", qty: 1, price: 12, metadata: { label: "old" } }],
  )

  assert.deepEqual(result, {
    ok: true,
    value: [{ id: "item-1", qty: 2, price: 12, metadata: { label: "old" } }],
    conflicts: [],
  })
})

test("uses mergeStates field semantics and prefixes conflicts with the string ID", () => {
  const result = merge(
    [{ id: "variant-a", name: "Draft", details: { color: "blue" } }],
    [{ id: "variant-a", name: "Local", details: { color: "blue" } }],
    [{ id: "variant-a", name: "Server", details: { color: "blue" } }],
  )

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["variant-a", "name"],
        submitted: { exists: true, value: "Local" },
        currentServer: { exists: true, value: "Server" },
      },
    ],
  })
})

test("shows where atomic-array merging conflicts on the same sparse record edits", () => {
  const originalItems = [{ id: "sku-a", qty: 1, price: 10 }]
  const submittedItems = [{ id: "sku-a", qty: 2, price: 10 }]
  const currentItems = [{ id: "sku-a", qty: 1, price: 12 }]

  const atomic = mergeStates({
    originalState: { items: originalItems },
    submittedState: { items: submittedItems },
    currentServerState: { items: currentItems },
  })
  const byId = merge(originalItems, submittedItems, currentItems)

  assert.equal(atomic.ok, false)
  assert.deepEqual(atomic.conflicts.map(({ path }) => path), [["items"]])
  assert.equal(byId.ok, true)
  assert.deepEqual(byId.value, [{ id: "sku-a", qty: 2, price: 12 }])
})

test("accepts deletion when the other side left an item unchanged", () => {
  assert.deepEqual(merge([{ id: "a", value: 1 }], [], [{ id: "a", value: 1 }]), {
    ok: true,
    value: [],
    conflicts: [],
  })
})

test("accepts the same deletion on both sides", () => {
  assert.deepEqual(merge([{ id: "a", value: 1 }], [], []), {
    ok: true,
    value: [],
    conflicts: [],
  })
})

test("reports delete-versus-edit conflicts with both sides represented", () => {
  const submittedDeletion = merge(
    [{ id: "a", value: 1 }],
    [],
    [{ id: "a", value: 2 }],
  )
  assert.deepEqual(submittedDeletion, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["a"],
        submitted: { exists: false },
        currentServer: { exists: true, value: { id: "a", value: 2 } },
      },
    ],
  })

  const serverDeletion = merge(
    [{ id: "a", value: 1 }],
    [{ id: "a", value: 2 }],
    [],
  )
  assert.equal(serverDeletion.ok, false)
  assert.deepEqual(serverDeletion.conflicts[0], {
    path: ["a"],
    submitted: { exists: true, value: { id: "a", value: 2 } },
    currentServer: { exists: false },
  })
})

test("treats an ID change as deleting the old ID and adding the new ID", () => {
  assert.deepEqual(
    merge(
      [{ id: "old", value: "before" }],
      [{ id: "new", value: "after" }],
      [{ id: "old", value: "before" }],
    ),
    { ok: true, value: [{ id: "new", value: "after" }], conflicts: [] },
  )
})

test("accepts identical same-ID additions and orders additions server-first", () => {
  const result = merge(
    [],
    [
      { id: "shared", value: 1 },
      { id: "submitted-only", value: 2 },
    ],
    [
      { id: "server-only", value: 3 },
      { id: "shared", value: 1 },
    ],
  )

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.value.map((item) => item.id),
    ["server-only", "shared", "submitted-only"],
  )
})

test("conflicts when two sides add different objects under the same ID", () => {
  const result = merge([], [{ id: "new", label: "local" }], [{ id: "new", label: "server" }])

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["new"],
        submitted: { exists: true, value: { id: "new", label: "local" } },
        currentServer: { exists: true, value: { id: "new", label: "server" } },
      },
    ],
  })
})

test("retains a one-sided submitted reorder", () => {
  const original = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const submitted = [{ id: "b" }, { id: "a" }, { id: "c" }]
  const currentServer = [{ id: "a" }, { id: "b" }, { id: "c" }]

  assert.deepEqual(
    merge(original, submitted, currentServer).value.map((item) => item.id),
    ["b", "a", "c"],
  )
})

test("retains a one-sided server reorder and accepts the same reorder on both sides", () => {
  const original = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const reordered = [{ id: "c" }, { id: "a" }, { id: "b" }]

  assert.deepEqual(
    merge(original, original, reordered).value.map((item) => item.id),
    ["c", "a", "b"],
  )
  assert.deepEqual(
    merge(original, reordered, reordered).value.map((item) => item.id),
    ["c", "a", "b"],
  )
})

test("conflicts when both sides reorder original IDs differently", () => {
  const result = merge(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [{ id: "b" }, { id: "a" }, { id: "c" }],
    [{ id: "a" }, { id: "c" }, { id: "b" }],
  )

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: [],
        submitted: { exists: true, value: ["b", "a", "c"] },
        currentServer: { exists: true, value: ["a", "c", "b"] },
      },
    ],
  })
})

test("ignores a deleted ID while comparing original-item order", () => {
  const result = merge(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [{ id: "b" }, { id: "a" }, { id: "c" }],
    [{ id: "c" }, { id: "b" }],
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.map((item) => item.id), ["c", "b"])
})

test("rejects missing, non-string, or duplicate IDs and non-object items", () => {
  for (const invalidItems of [
    [{ value: 1 }],
    [{ id: 1 }],
    [{ id: "same" }, { id: "same" }],
    ["not-an-object"],
    [null],
  ]) {
    assert.throws(
      () => merge(invalidItems, invalidItems, invalidItems),
      CAMConfigError,
    )
  }
})

test("does not apply ID merging to bare string arrays", () => {
  assert.throws(() => merge(["draft"], ["local"], ["server"]), CAMConfigError)
  const atomic = mergeStates({
    originalState: ["draft"],
    submittedState: ["local"],
    currentServerState: ["server"],
  })
  assert.equal(atomic.ok, false)
  assert.deepEqual(atomic.conflicts[0].path, [])
})

test("uses Map-safe string IDs such as __proto__ without changing object prototypes", () => {
  const result = merge(
    [{ id: "__proto__", qty: 1, price: 10 }],
    [{ id: "__proto__", qty: 2, price: 10 }],
    [{ id: "__proto__", qty: 1, price: 11 }],
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, [{ id: "__proto__", qty: 2, price: 11 }])
  assert.equal(Object.getPrototypeOf(result.value[0]), Object.prototype)
  assert.equal(Object.hasOwn(Object.prototype, "qty"), false)
})

test("copies inputs and returns data independent of caller objects", () => {
  const originalState = [{ id: "a", nested: { value: 1 } }]
  const submittedState = [{ id: "a", nested: { value: 2 } }]
  const currentServerState = [{ id: "a", nested: { value: 1 } }]
  const before = JSON.stringify({ originalState, submittedState, currentServerState })

  const result = merge(originalState, submittedState, currentServerState)

  assert.equal(JSON.stringify({ originalState, submittedState, currentServerState }), before)
  assert.equal(result.ok, true)
  assert.notEqual(result.value[0], submittedState[0])
  result.value[0].nested.value = 99
  assert.equal(submittedState[0].nested.value, 2)
})
