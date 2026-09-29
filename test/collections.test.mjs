import assert from "node:assert/strict"
import test from "node:test"

import fc from "fast-check"

import {
  ANY,
  CAMConfigError,
  EACH,
  applyConflictDecisions,
  formatConflictPath,
  mergeStates,
  resolveConflict,
} from "../dist/index.js"

const keyed = (path = ["items"], key = "id") => ({ arrays: { rules: [{ path, mode: "keyed", key }] } })
const sequence = { arrays: { default: "sequence" } }
const item = (id) => ({ key: "id", value: id })

function resolveAll(input, choice) {
  const first = mergeStates(input)
  assert.equal(first.ok, false)
  return applyConflictDecisions({
    ...input,
    sessionId: "s1",
    decisions: first.conflicts.map((conflict) => ({ sessionId: "s1", conflict, choice })),
  })
}

// ---------------------------------------------------------------------------
// Defaults and compatibility
// ---------------------------------------------------------------------------

test("arrays stay atomic unless an array option is configured", () => {
  const input = {
    originalState: { list: [1, 2, 3] },
    submittedState: { list: [0, 1, 2, 3] },
    currentServerState: { list: [1, 2, 3, 4] },
  }
  assert.deepEqual(mergeStates(input).conflicts[0].path, ["list"])
  assert.deepEqual(mergeStates({ ...input, arrays: {} }).conflicts[0].path, ["list"])
  assert.deepEqual(mergeStates({ ...input, arrays: { default: "atomic" } }).conflicts[0].path, ["list"])
  assert.deepEqual(mergeStates({ ...input, ...sequence }).value, { list: [0, 1, 2, 3, 4] })
})

test("an atomic rule overrides the sequence default for a path", () => {
  const result = mergeStates({
    originalState: { a: [1], b: [1] },
    submittedState: { a: [0, 1], b: [0, 1] },
    currentServerState: { a: [1, 2], b: [1, 2] },
    arrays: { default: "sequence", rules: [{ path: ["b"], mode: "atomic" }] },
  })
  assert.deepEqual(result.conflicts.map((conflict) => conflict.path), [["b"]])
})

test("the most specific array rule wins over wildcard rules", () => {
  const result = mergeStates({
    originalState: { lists: { x: ["a"], y: ["a"] } },
    submittedState: { lists: { x: ["a", "b"], y: ["a", "b"] } },
    currentServerState: { lists: { x: ["c"], y: ["c"] } },
    arrays: { rules: [{ path: ["lists", ANY], mode: "set" }, { path: ["lists", "y"], mode: "atomic" }] },
  })
  assert.deepEqual(result.conflicts.map((conflict) => conflict.path), [["lists", "y"]])
})

test("one-sided and identical array changes take the fast path", () => {
  const base = { originalState: { items: [{ id: "a" }] }, ...keyed() }
  assert.deepEqual(
    mergeStates({ ...base, submittedState: { items: [] }, currentServerState: { items: [{ id: "a" }] } }).value,
    { items: [] },
  )
  assert.deepEqual(
    mergeStates({ ...base, submittedState: { items: [{ id: "b" }] }, currentServerState: { items: [{ id: "b" }] } }).value,
    { items: [{ id: "b" }] },
  )
})

test("array options validate their shape", () => {
  const input = { originalState: {}, submittedState: {}, currentServerState: {} }
  assert.throws(() => mergeStates({ ...input, arrays: [] }), /arrays must be an object/)
  assert.throws(() => mergeStates({ ...input, arrays: { extra: 1 } }), /unknown property "extra"/)
  assert.throws(() => mergeStates({ ...input, arrays: { default: "keyed" } }), /arrays.default/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: {} } }), /arrays.rules must be an array/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [1] } }), /must be an object/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [{ path: ["a"], mode: "zip" }] } }), /mode must be one of/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [{ path: ["a"], mode: "keyed" }] } }), /key must be a non-empty string/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [{ path: ["a"], mode: "set", key: "id" }] } }), /unexpected property "key"/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [{ path: [], mode: "set" }] } }), /non-empty path/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [{ path: [{ $cam: "all" }], mode: "set" }] } }), /ANY, or EACH/)
  assert.throws(() => mergeStates({ ...input, arrays: { rules: [{ path: [-1], mode: "set" }] } }), CAMConfigError)
})

// ---------------------------------------------------------------------------
// Keyed arrays
// ---------------------------------------------------------------------------

test("keyed arrays merge independent item edits, additions and deletions", () => {
  const result = mergeStates({
    originalState: { items: [{ id: "a", qty: 1, price: 10 }, { id: "b", qty: 1 }, { id: "c", qty: 1 }] },
    submittedState: { items: [{ id: "a", qty: 2, price: 10 }, { id: "b", qty: 1 }, { id: "c", qty: 1 }, { id: "n", qty: 5 }] },
    currentServerState: { items: [{ id: "a", qty: 1, price: 12 }, { id: "c", qty: 1 }] },
    ...keyed(),
  })
  assert.deepEqual(result, {
    ok: true,
    value: { items: [{ id: "a", price: 12, qty: 2 }, { id: "c", qty: 1 }, { id: "n", qty: 5 }] },
    conflicts: [],
  })
})

test("keyed arrays report field conflicts inside the item", () => {
  const result = mergeStates({
    originalState: { items: [{ id: 7, qty: 1 }] },
    submittedState: { items: [{ id: 7, qty: 2 }] },
    currentServerState: { items: [{ id: 7, qty: 3 }] },
    ...keyed(),
  })
  assert.deepEqual(result.conflicts, [
    { path: ["items", { key: "id", value: 7 }, "qty"], submitted: { exists: true, value: 2 }, currentServer: { exists: true, value: 3 } },
  ])
  assert.equal(formatConflictPath(result.conflicts[0].path), "/items/[id=7]/qty")
})

test("keyed delete versus edit conflicts on the item and resolves either way", () => {
  const input = {
    originalState: { items: [{ id: "a", qty: 1 }] },
    submittedState: { items: [] },
    currentServerState: { items: [{ id: "a", qty: 3 }] },
    ...keyed(),
  }
  const first = mergeStates(input)
  assert.deepEqual(first.conflicts[0].path, ["items", item("a")])
  assert.deepEqual(first.conflicts[0].submitted, { exists: false })
  assert.deepEqual(resolveAll(input, "submitted").value, { items: [] })
  assert.deepEqual(resolveAll(input, "currentServer").value, { items: [{ id: "a", qty: 3 }] })
})

test("keyed concurrent additions agree when equal and conflict when different", () => {
  const base = { originalState: { items: [] }, ...keyed() }
  assert.deepEqual(
    mergeStates({ ...base, submittedState: { items: [{ id: "x", v: 1 }] }, currentServerState: { items: [{ id: "x", v: 1 }, { id: "y" }] } }).value,
    { items: [{ id: "x", v: 1 }, { id: "y" }] },
  )
  const conflict = mergeStates({ ...base, submittedState: { items: [{ id: "x", v: 1 }] }, currentServerState: { items: [{ id: "x", v: 2 }, { id: "y" }] } })
  assert.deepEqual(conflict.conflicts.map((entry) => entry.path), [["items", item("x")]])
})

test("keyed arrays treat an absent original array as empty", () => {
  const result = mergeStates({
    originalState: {},
    submittedState: { items: [{ id: "a" }] },
    currentServerState: { items: [{ id: "b" }] },
    ...keyed(),
  })
  // Each side inserted at the start of the list; additions keep their position
  // relative to neighbours, so the submitted insertion stays first.
  assert.deepEqual(result.value, { items: [{ id: "a" }, { id: "b" }] })
})

test("keyed order: one-sided reorders win and additions follow their predecessor", () => {
  const base = { originalState: { items: [{ id: "a" }, { id: "b" }, { id: "c" }] }, ...keyed() }
  assert.deepEqual(
    mergeStates({
      ...base,
      submittedState: { items: [{ id: "c" }, { id: "a" }, { id: "b" }] },
      currentServerState: { items: [{ id: "a" }, { id: "x" }, { id: "b" }, { id: "c" }] },
    }).value.items.map(({ id }) => id),
    ["c", "a", "x", "b"],
  )
  assert.deepEqual(
    mergeStates({
      ...base,
      submittedState: { items: [{ id: "z" }, { id: "a" }, { id: "b" }, { id: "c" }] },
      currentServerState: { items: [{ id: "b" }, { id: "a" }, { id: "c" }] },
    }).value.items.map(({ id }) => id),
    ["z", "b", "a", "c"],
  )
})

test("keyed order: different reorders on both sides are one order conflict", () => {
  const input = {
    originalState: { items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    submittedState: { items: [{ id: "b" }, { id: "a" }, { id: "c" }] },
    currentServerState: { items: [{ id: "a" }, { id: "c" }, { id: "b" }, { id: "d" }] },
    ...keyed(),
  }
  const first = mergeStates(input)
  assert.deepEqual(first.conflicts, [{
    path: ["items"],
    submitted: { exists: true, value: ["b", "a", "c"] },
    currentServer: { exists: true, value: ["a", "c", "b"] },
    reason: "order",
  }])
  assert.deepEqual(resolveAll(input, "submitted").value.items.map(({ id }) => id), ["b", "d", "a", "c"])
  assert.deepEqual(resolveAll(input, "currentServer").value.items.map(({ id }) => id), ["a", "c", "b", "d"])
})

test("keyed arrays reject missing, invalid and duplicate keys", () => {
  const run = (items) => () =>
    mergeStates({ originalState: { items: [] }, submittedState: { items }, currentServerState: { items: [{ id: "z" }] }, ...keyed() })
  assert.throws(run([{ name: "a" }]), /submittedState\["items"\]\[0\] must be an object with a "id" property/)
  assert.throws(run(["a"]), /must be an object/)
  assert.throws(run([{ id: true }]), /must be a string or finite number/)
  assert.throws(run([{ id: "a" }, { id: "a" }]), /duplicate key "a"/)
})

test("nested keyed arrays merge through wildcard rules", () => {
  const result = mergeStates({
    originalState: { sections: [{ id: "s", fields: [{ name: "a", v: 1 }, { name: "b", v: 1 }] }] },
    submittedState: { sections: [{ id: "s", fields: [{ name: "a", v: 2 }, { name: "b", v: 1 }] }] },
    currentServerState: { sections: [{ id: "s", fields: [{ name: "a", v: 1 }, { name: "b", v: 3 }, { name: "c", v: 1 }] }] },
    arrays: {
      rules: [
        { path: ["sections"], mode: "keyed", key: "id" },
        { path: ["sections", ANY, "fields"], mode: "keyed", key: "name" },
      ],
    },
  })
  assert.deepEqual(result.value, {
    sections: [{ fields: [{ name: "a", v: 2 }, { name: "b", v: 3 }, { name: "c", v: 1 }], id: "s" }],
  })
})

// ---------------------------------------------------------------------------
// Sequence (diff3)
// ---------------------------------------------------------------------------

test("sequence merges separated edits on both sides", () => {
  const result = mergeStates({
    originalState: ["a", "b", "c", "d", "e"],
    submittedState: ["a", "B", "c", "d", "e"],
    currentServerState: ["a", "b", "c", "d", "E", "f"],
    ...sequence,
  })
  assert.deepEqual(result.value, ["a", "B", "c", "d", "E", "f"])
})

test("sequence keeps deletions and identical changes", () => {
  assert.deepEqual(
    mergeStates({ originalState: [1, 2, 3, 4], submittedState: [1, 3, 4], currentServerState: [1, 2, 3, 4, 5], ...sequence }).value,
    [1, 3, 4, 5],
  )
  assert.deepEqual(
    mergeStates({ originalState: [1, 2, 3], submittedState: [1, 9, 3, 4], currentServerState: [1, 9, 3, 5], ...sequence }).conflicts[0].path,
    [{ from: 3, to: 3 }],
  )
  assert.deepEqual(
    mergeStates({ originalState: [1, 2, 3], submittedState: [1, 9, 3], currentServerState: [0, 1, 9, 3], ...sequence }).value,
    [0, 1, 9, 3],
  )
})

test("sequence reports only the clashing range and resolves it", () => {
  const input = {
    originalState: { steps: ["a", "b", "c", "d"] },
    submittedState: { steps: ["a", "x", "y", "c", "d"] },
    currentServerState: { steps: ["a", "z", "c", "D"] },
    ...sequence,
  }
  const first = mergeStates({ ...input, includeReport: true })
  assert.deepEqual(first.conflicts, [{
    path: ["steps", { from: 1, to: 2 }],
    submitted: { exists: true, value: ["x", "y"] },
    currentServer: { exists: true, value: ["z"] },
  }])
  assert.equal(formatConflictPath(first.conflicts[0].path), "/steps/[1..2)")
  assert.deepEqual(first.report.changes.map(({ path, provenance }) => [path, provenance]), [
    [["steps", { from: 1, to: 2 }], "unresolved"],
    [["steps", { from: 3, to: 4 }], "server-only"],
  ])
  assert.deepEqual(resolveAll(input, "submitted").value, { steps: ["a", "x", "y", "c", "D"] })
  assert.deepEqual(resolveAll(input, "currentServer").value, { steps: ["a", "z", "c", "D"] })
})

test("sequence pairs equal-length regions only where each element changed on one side", () => {
  const input = {
    originalState: { rows: [{ n: 1, t: "a" }, { n: 2, t: "b" }, { n: 3, t: "c" }] },
    submittedState: { rows: [{ n: 1, t: "A" }, { n: 2, t: "b" }, { n: 3, t: "c" }] },
    currentServerState: { rows: [{ n: 1, t: "a" }, { n: 2, t: "b" }, { n: 3, t: "Z" }] },
    ...sequence,
  }
  assert.deepEqual(mergeStates(input).value.rows, [{ n: 1, t: "A" }, { n: 2, t: "b" }, { n: 3, t: "Z" }])
})

test("sequence never merges inside a row both sides changed", () => {
  // Without identity, CAM cannot prove two edited rows are the same row.
  const input = {
    originalState: { rows: [{ n: 1, t: "a" }, { n: 2, t: "b" }] },
    submittedState: { rows: [{ n: 1, t: "A" }, { n: 2, t: "B" }] },
    currentServerState: { rows: [{ n: 9, t: "a" }, { n: 2, t: "b" }] },
    ...sequence,
  }
  const result = mergeStates(input)
  assert.deepEqual(result.conflicts.map(({ path }) => path), [["rows", { from: 0, to: 2 }]])
  assert.deepEqual(resolveAll(input, "submitted").value, input.submittedState)
  assert.deepEqual(resolveAll(input, "currentServer").value, input.currentServerState)
})

test("sequence reorder against edit conflicts instead of attaching values to the wrong rows", () => {
  const result = mergeStates({
    originalState: [{ name: "A", qty: 0 }, { name: "B", qty: 0 }],
    submittedState: [{ name: "B", qty: 0 }, { name: "A", qty: 0 }],
    currentServerState: [{ name: "A", qty: 10 }, { name: "B", qty: 20 }],
    ...sequence,
  })
  assert.equal(result.ok, false)
  assert.equal(result.conflicts.length, 1)
})

test("sequence moves conflict with edits instead of losing them", () => {
  const result = mergeStates({
    originalState: ["a", "b", "c"],
    submittedState: ["b", "c", "a"],
    currentServerState: ["A", "b", "c"],
    ...sequence,
  })
  assert.equal(result.ok, false)
})

test("sequence handles duplicates, empty arrays and large inputs deterministically", () => {
  assert.deepEqual(
    mergeStates({ originalState: [1, 1, 1], submittedState: [1, 1, 1, 1], currentServerState: [0, 1, 1, 1], ...sequence }).value,
    [0, 1, 1, 1, 1],
  )
  assert.deepEqual(mergeStates({ originalState: [], submittedState: [1], currentServerState: [], ...sequence }).value, [1])
  const big = Array.from({ length: 3000 }, (_, index) => index % 50)
  const submitted = big.slice()
  submitted[10] = "s"
  const server = big.slice()
  server[2990] = "c"
  const merged = mergeStates({ originalState: big, submittedState: submitted, currentServerState: server, ...sequence })
  assert.equal(merged.value[10], "s")
  assert.equal(merged.value[2990], "c")
  assert.equal(merged.value.length, 3000)
})

test("sequence stays safe when alignment regions are too large to solve exactly", () => {
  // No unique anchors and a region above the exact-LCS budget: the merge must
  // still never combine incompatible edits (it may only add conflicts).
  const original = Array.from({ length: 2100 }, (_, index) => index % 2)
  const submitted = [...original.slice(0, 1000).reverse(), ...original.slice(1000)]
  const server = [...original.slice(0, 2099), 7]
  const result = mergeStates({ originalState: original, submittedState: submitted, currentServerState: server, ...sequence })
  if (result.ok) {
    assert.equal(result.value.length, original.length)
  } else {
    assert.equal(result.kind, "conflict")
  }
})

test("sequence treats an absent original as an empty sequence", () => {
  const result = mergeStates({ originalState: {}, submittedState: { l: [1] }, currentServerState: { l: [2] }, ...sequence })
  assert.deepEqual(result.conflicts[0].path, ["l", { from: 0, to: 0 }])
})

// ---------------------------------------------------------------------------
// Sets and multisets
// ---------------------------------------------------------------------------

test("set arrays merge membership and never conflict", () => {
  const result = mergeStates({
    originalState: { tags: ["x", "y"] },
    submittedState: { tags: ["x", "y", "z"] },
    currentServerState: { tags: ["y", "w"] },
    arrays: { rules: [{ path: ["tags"], mode: "set" }] },
    includeReport: true,
  })
  assert.deepEqual(result.value, { tags: ["y", "w", "z"] })
  assert.deepEqual(result.report.changes.map(({ provenance }) => provenance), ["combined"])
})

test("set arrays compare objects structurally and reject duplicates", () => {
  const rules = { arrays: { rules: [{ path: ["s"], mode: "set" }] } }
  assert.deepEqual(
    mergeStates({ originalState: { s: [{ a: 1 }] }, submittedState: { s: [] }, currentServerState: { s: [{ a: 1 }, { b: 2 }] }, ...rules }).value,
    { s: [{ b: 2 }] },
  )
  assert.throws(
    () => mergeStates({ originalState: { s: [1, 1] }, submittedState: { s: [2] }, currentServerState: { s: [3] }, ...rules }),
    /originalState\["s"\] contains a duplicate value/,
  )
})

test("multiset arrays merge counts", () => {
  const result = mergeStates({
    originalState: { v: [1, 1, 2] },
    submittedState: { v: [1, 1, 1, 2] },
    currentServerState: { v: [1, 2, 2] },
    arrays: { rules: [{ path: ["v"], mode: "multiset" }] },
  })
  assert.deepEqual(result.value, { v: [1, 2, 2, 1] })
})

test("set reports identical changes on both sides", () => {
  const result = mergeStates({
    originalState: { t: [1] },
    submittedState: { t: [1, 2] },
    currentServerState: { t: [2, 1] },
    arrays: { rules: [{ path: ["t"], mode: "set" }] },
    includeReport: true,
  })
  // Same membership on both sides; only the order differs, which is not a change.
  assert.deepEqual(result.report.changes.map(({ provenance }) => provenance), ["identical-both"])
  const identical = mergeStates({
    originalState: { t: [1] },
    submittedState: { t: [1, 2] },
    currentServerState: { t: [1, 2] },
    arrays: { rules: [{ path: ["t"], mode: "set" }] },
    groups: [{ id: "g", paths: [["t"]] }],
    includeReport: true,
  })
  assert.equal(identical.ok, true)
})

// ---------------------------------------------------------------------------
// Pattern groups
// ---------------------------------------------------------------------------

test("EACH groups link fields within one item and decide per item", () => {
  const input = {
    originalState: { items: [{ id: "a", price: 1, currency: "USD" }, { id: "b", price: 1, currency: "USD" }] },
    submittedState: { items: [{ id: "a", price: 2, currency: "USD" }, { id: "b", price: 1, currency: "USD" }] },
    currentServerState: { items: [{ id: "a", price: 1, currency: "EUR" }, { id: "b", price: 1, currency: "EUR" }] },
    ...keyed(),
    groups: [{ id: "money", paths: [["items", EACH, "price"], ["items", EACH, "currency"]] }],
  }
  const first = mergeStates({ ...input, includeReport: true })
  assert.equal(first.conflicts.length, 1)
  assert.equal(first.conflicts[0].kind, "group")
  assert.deepEqual(first.conflicts[0].binding, item("a"))
  assert.deepEqual(first.conflicts[0].paths, [["items", item("a"), "currency"], ["items", item("a"), "price"]])
  assert.ok(first.report.changes.some((change) => change.kind === "group" && change.binding?.value === "b"))
  assert.deepEqual(resolveAll(input, "submitted").value.items, [
    { currency: "USD", id: "a", price: 2 },
    { currency: "EUR", id: "b", price: 1 },
  ])
})

test("ANY groups link every matched field into one decision", () => {
  const result = mergeStates({
    originalState: { totals: { net: 1 }, lines: { a: { q: 1 }, b: { q: 1 } } },
    submittedState: { totals: { net: 2 }, lines: { a: { q: 1 }, b: { q: 1 } } },
    currentServerState: { totals: { net: 1 }, lines: { a: { q: 1 }, b: { q: 5 } } },
    groups: [{ id: "totals", paths: [["totals", "net"], ["lines", ANY, "q"]] }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].kind, "group")
  assert.equal(result.conflicts[0].binding, undefined)
})

test("EACH over object records binds the property name", () => {
  const result = mergeStates({
    originalState: { prices: { a: 1 }, stock: { a: 1 } },
    submittedState: { prices: { a: 2 }, stock: { a: 1 } },
    currentServerState: { prices: { a: 1 }, stock: { a: 0 } },
    groups: [{ id: "p", paths: [["prices", EACH], ["stock", EACH]] }],
  })
  assert.equal(result.conflicts[0].binding, "a")
})

test("pattern groups over non-keyed arrays link the whole array", () => {
  const result = mergeStates({
    originalState: { list: [{ v: 1 }], note: "a" },
    submittedState: { list: [{ v: 2 }], note: "a" },
    currentServerState: { list: [{ v: 1 }], note: "b" },
    groups: [{ id: "g", paths: [["list", ANY, "v"], ["note"]] }],
  })
  assert.deepEqual(result.conflicts[0].paths, [["list"], ["note"]])
})

test("pattern group validation rejects overlaps and mixed EACH usage", () => {
  const input = { originalState: {}, submittedState: {}, currentServerState: {} }
  assert.throws(
    () => mergeStates({ ...input, groups: [{ id: "a", paths: [["x", ANY]] }, { id: "b", paths: [["x", "y"]] }] }),
    /overlapping/,
  )
  assert.throws(
    () => mergeStates({ ...input, groups: [{ id: "a", paths: [["x", EACH], ["y"]] }] }),
    /every path must use EACH exactly once/,
  )
  assert.throws(
    () => mergeStates({ ...input, groups: [{ id: "a", paths: [["x", EACH, "z", EACH]] }] }),
    /exactly once/,
  )
})

test("pattern groups skip data they do not match", () => {
  const result = mergeStates({
    originalState: { a: 1 },
    submittedState: { a: 2 },
    currentServerState: { a: 1 },
    groups: [{ id: "g", paths: [["missing", ANY, "x"]] }],
  })
  assert.deepEqual(result.value, { a: 2 })
})

// ---------------------------------------------------------------------------
// Decisions and formatting
// ---------------------------------------------------------------------------

test("decisions validate item, range and order conflict shapes", () => {
  const input = {
    originalState: { items: [{ id: "a", q: 1 }] },
    submittedState: { items: [{ id: "a", q: 2 }] },
    currentServerState: { items: [{ id: "a", q: 3 }] },
    ...keyed(),
  }
  const [conflict] = mergeStates(input).conflicts
  const decide = (bad) =>
    applyConflictDecisions({ ...input, sessionId: "s", decisions: [{ sessionId: "s", conflict: bad, choice: "submitted" }] })
  assert.throws(() => decide({ ...conflict, path: ["items", { key: "id" }, "q"] }), /item segment, or range segment/)
  assert.throws(() => decide({ ...conflict, path: ["items", { key: "id", value: "b" }, "q"] }), /stale/)
  assert.throws(() => decide({ ...conflict, reason: "shuffle" }), /reason must be "order"/)
  assert.throws(() => decide({ ...conflict, path: ["items", { from: 0, to: 1 }, "q"] }), /stale/)
  assert.deepEqual(decide(conflict).value, { items: [{ id: "a", q: 2 }] })
})

test("decisions validate EACH bindings", () => {
  const input = {
    originalState: { p: { a: 1 }, s: { a: 1 } },
    submittedState: { p: { a: 2 }, s: { a: 1 } },
    currentServerState: { p: { a: 1 }, s: { a: 0 } },
    groups: [{ id: "g", paths: [["p", EACH], ["s", EACH]] }],
  }
  const [conflict] = mergeStates(input).conflicts
  assert.throws(
    () => applyConflictDecisions({ ...input, sessionId: "s", decisions: [{ sessionId: "s", conflict: { ...conflict, binding: "b" }, choice: "submitted" }] }),
    /stale/,
  )
  assert.deepEqual(
    applyConflictDecisions({ ...input, sessionId: "s", decisions: [{ sessionId: "s", conflict, choice: "currentServer" }] }).value,
    { p: { a: 1 }, s: { a: 0 } },
  )
})

test("formatConflictPath renders item and range segments", () => {
  assert.equal(formatConflictPath(["items", { key: "id", value: "a/b" }, "qty"]), "/items/[id=a~1b]/qty")
  assert.equal(formatConflictPath(["steps", { from: 2, to: 4 }]), "/steps/[2..4)")
  assert.throws(() => formatConflictPath([{ from: 3, to: 1 }]), CAMConfigError)
  assert.throws(() => formatConflictPath([{ key: 1, value: 1 }]), CAMConfigError)
  assert.throws(() => formatConflictPath([{ key: "id", value: Number.NaN }]), CAMConfigError)
})

test("resolveConflict forwards collection options", () => {
  const result = resolveConflict({
    error: { code: 409 },
    expectedError: { code: 409 },
    originalState: { tags: ["a"] },
    submittedState: { tags: ["a", "b"] },
    currentServerState: { tags: ["a", "c"] },
    arrays: { rules: [{ path: ["tags"], mode: "set" }] },
  })
  assert.deepEqual(result, { matched: true, result: { ok: true, value: { tags: ["a", "c", "b"] }, conflicts: [] } })
})

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const small = fc.array(fc.constantFrom("a", "b", "c", "d", 1, 2), { maxLength: 8 })
const records = fc
  .uniqueArray(fc.record({ id: fc.constantFrom("p", "q", "r", "s", "t"), v: fc.constantFrom(0, 1, 2) }), {
    selector: (record) => record.id,
    maxLength: 5,
  })
  .map((list) => list.map((record) => ({ id: record.id, v: record.v })))

for (const [name, arbitrary, mode] of [
  ["sequence", small, "sequence"],
  ["keyed", records, "keyed"],
  ["set", fc.uniqueArray(fc.constantFrom("a", "b", "c", 1, 2)), "set"],
  ["multiset", small, "multiset"],
]) {
  test(`${name}: unchanged sides and identical edits resolve without conflicts`, () => {
    const arrays = { rules: [mode === "keyed" ? { path: ["x"], mode, key: "id" } : { path: ["x"], mode }] }
    fc.assert(
      fc.property(arbitrary, arbitrary, (original, edited) => {
        // Sets and multisets are unordered: compare them by contents.
        const unordered = mode === "set" || mode === "multiset"
        const view = (list) => (unordered ? [...list].map((v) => JSON.stringify(v)).sort() : list)
        const run = (submittedState, currentServerState) =>
          view(mergeStates({ originalState: { x: original }, submittedState: { x: submittedState }, currentServerState: { x: currentServerState }, arrays }).value.x)
        assert.deepEqual(run(edited, original), view(edited))
        assert.deepEqual(run(original, edited), view(edited))
        assert.deepEqual(run(edited, edited), view(edited))
      }),
    )
  })
}

test("keyed and sequence merges are deterministic and never lose one-sided edits", () => {
  fc.assert(
    fc.property(records, records, records, (original, submitted, server) => {
      const input = { originalState: { items: original }, submittedState: { items: submitted }, currentServerState: { items: server }, ...keyed() }
      const first = mergeStates(input)
      assert.deepEqual(mergeStates(input), first)
      if (!first.ok) return
      const byId = new Map(first.value.items.map((record) => [record.id, record]))
      for (const record of submitted) {
        const before = original.find(({ id }) => id === record.id)
        const after = server.find(({ id }) => id === record.id)
        if (before !== undefined && after !== undefined && JSON.stringify(before) === JSON.stringify(after)) {
          assert.deepEqual(byId.get(record.id), record)
        }
      }
    }),
  )
  fc.assert(
    fc.property(small, small, small, (original, submitted, server) => {
      const input = { originalState: original, submittedState: submitted, currentServerState: server, ...sequence }
      assert.deepEqual(mergeStates(input), mergeStates(input))
    }),
  )
})

test("swapping sides mirrors sequence conflicts", () => {
  fc.assert(
    fc.property(small, small, small, (original, submitted, server) => {
      const forward = mergeStates({ originalState: original, submittedState: submitted, currentServerState: server, ...sequence })
      const backward = mergeStates({ originalState: original, submittedState: server, currentServerState: submitted, ...sequence })
      assert.equal(forward.ok, backward.ok)
      if (!forward.ok) assert.equal(forward.conflicts.length, backward.conflicts.length)
    }),
  )
})

// ---------------------------------------------------------------------------
// Review regressions and safety invariants
// ---------------------------------------------------------------------------

test("set merges never duplicate a member both sides added", () => {
  const rules = { arrays: { rules: [{ path: ["t"], mode: "set" }] } }
  assert.deepEqual(
    mergeStates({ originalState: { t: [] }, submittedState: { t: ["shared", "mine"] }, currentServerState: { t: ["shared", "server"] }, ...rules }).value,
    { t: ["shared", "server", "mine"] },
  )
  assert.deepEqual(
    mergeStates({ originalState: { t: [] }, submittedState: { t: [{ a: 1, b: 2 }] }, currentServerState: { t: [{ b: 2, a: 1 }] }, ...rules }).value,
    { t: [{ a: 1, b: 2 }] },
  )
})

test("keyed reorders are reported, so review-mixed sees them combined with edits", () => {
  const input = {
    originalState: { items: [{ id: "a", qty: 1 }, { id: "b", qty: 1 }] },
    submittedState: { items: [{ id: "b", qty: 1 }, { id: "a", qty: 1 }] },
    currentServerState: { items: [{ id: "a", qty: 5 }, { id: "b", qty: 1 }] },
    ...keyed(),
  }
  const reported = mergeStates({ ...input, includeReport: true })
  const order = reported.report.changes.find((change) => change.reason === "order")
  assert.deepEqual(order.path, ["items"])
  assert.equal(order.provenance, "submitted-only")
  assert.deepEqual(order.result, { exists: true, value: ["b", "a"] })
  const review = mergeStates({ ...input, autoMerge: "review-mixed" })
  assert.equal(review.kind, "review")
  assert.deepEqual(review.value, { items: [{ id: "b", qty: 1 }, { id: "a", qty: 5 }] })
})

test("keyed order reports agreement and decided reorders", () => {
  const both = mergeStates({
    originalState: { items: [{ id: "a" }, { id: "b" }] },
    submittedState: { items: [{ id: "b" }, { id: "a" }] },
    currentServerState: { items: [{ id: "b" }, { id: "a" }, { id: "c" }] },
    ...keyed(),
    includeReport: true,
  })
  assert.equal(both.report.changes.find((change) => change.reason === "order").provenance, "identical-both")
  const input = {
    originalState: { items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    submittedState: { items: [{ id: "b" }, { id: "a" }, { id: "c" }] },
    currentServerState: { items: [{ id: "a" }, { id: "c" }, { id: "b" }] },
    ...keyed(),
    includeReport: true,
  }
  const decided = resolveAll(input, "currentServer")
  assert.equal(decided.report.changes.find((change) => change.reason === "order").provenance, "chosen-currentServer")
})

test("configured collection invariants hold even when only one side changed", () => {
  const keyedRule = keyed()
  assert.throws(
    () => mergeStates({ originalState: { items: [] }, submittedState: { items: [{ id: "a" }, { id: "a" }] }, currentServerState: { items: [] }, ...keyedRule }),
    /submittedState\["items"\] contains duplicate key "a"/,
  )
  assert.throws(
    () => mergeStates({ originalState: { items: [] }, submittedState: { items: [] }, currentServerState: { items: [{ name: "x" }] }, ...keyedRule }),
    /currentServerState\["items"\]\[0\] must be an object with a "id" property/,
  )
  assert.throws(
    () => mergeStates({ originalState: {}, submittedState: { t: [1, 1] }, currentServerState: {}, arrays: { rules: [{ path: ["t"], mode: "set" }] } }),
    /submittedState\["t"\] contains a duplicate value/,
  )
  assert.throws(
    () => mergeStates({
      originalState: { sections: [{ id: "s", fields: [] }] },
      submittedState: { sections: [{ id: "s", fields: [{ name: "a" }, { name: "a" }] }] },
      currentServerState: { sections: [{ id: "s", fields: [] }] },
      arrays: { rules: [{ path: ["sections"], mode: "keyed", key: "id" }, { path: ["sections", ANY, "fields"], mode: "keyed", key: "name" }] },
    }),
    /duplicate key "a"/,
  )
  // Items of atomic and sequence arrays are never merged inside, so nested rules do not apply there.
  assert.deepEqual(
    mergeStates({
      originalState: { rows: [{ items: [] }] },
      submittedState: { rows: [{ items: [{ id: "a" }, { id: "a" }] }] },
      currentServerState: { rows: [{ items: [] }] },
      arrays: { rules: [{ path: ["rows", ANY, "items"], mode: "keyed", key: "id" }] },
    }).value,
    { rows: [{ items: [{ id: "a" }, { id: "a" }] }] },
  )
})

const rows = fc
  .array(fc.record({ name: fc.constantFrom("A", "B", "C"), qty: fc.constantFrom(0, 1, 2) }), { maxLength: 5 })
  .map((list) => list.map((row) => ({ name: row.name, qty: row.qty })))

test("sequence results only contain rows taken whole from one side", () => {
  fc.assert(
    fc.property(rows, rows, rows, (original, submitted, server) => {
      const result = mergeStates({ originalState: original, submittedState: submitted, currentServerState: server, ...sequence })
      if (!result.ok) return
      const written = new Set([...submitted, ...server].map((row) => JSON.stringify(row)))
      for (const row of result.value) assert.ok(written.has(JSON.stringify(row)), `synthesized row ${JSON.stringify(row)}`)
    }),
    { numRuns: 500 },
  )
})

test("set results are sets with the three-way membership rule", () => {
  const members = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", 1, 2))
  fc.assert(
    fc.property(members, members, members, (original, submitted, server) => {
      const result = mergeStates({
        originalState: { t: original },
        submittedState: { t: submitted },
        currentServerState: { t: server },
        arrays: { rules: [{ path: ["t"], mode: "set" }] },
      })
      const merged = result.value.t
      assert.equal(new Set(merged).size, merged.length)
      for (const member of new Set([...original, ...submitted, ...server])) {
        const inO = original.includes(member)
        const expected = inO ? submitted.includes(member) && server.includes(member) : submitted.includes(member) || server.includes(member)
        assert.equal(merged.includes(member), expected)
      }
    }),
    { numRuns: 500 },
  )
})

test("review-mixed never returns ok for a keyed result that combines both sides", () => {
  const records = fc
    .uniqueArray(fc.record({ id: fc.constantFrom("p", "q", "r"), v: fc.constantFrom(0, 1) }), { selector: (r) => r.id, maxLength: 3 })
    .map((list) => list.map((record) => ({ id: record.id, v: record.v })))
  fc.assert(
    fc.property(records, records, records, (original, submitted, server) => {
      const result = mergeStates({
        originalState: { items: original },
        submittedState: { items: submitted },
        currentServerState: { items: server },
        ...keyed(),
        autoMerge: "review-mixed",
      })
      if (result.ok) {
        const value = JSON.stringify(result.value.items)
        assert.ok(value === JSON.stringify(submitted) || value === JSON.stringify(server), `mixed result auto-accepted: ${value}`)
      }
    }),
    { numRuns: 500 },
  )
})

test("review-mixed only auto-accepts results that one side wrote, across every array mode", () => {
  const record = fc
    .record({
      title: fc.constantFrom("a", "b"),
      meta: fc.record({ x: fc.constantFrom(0, 1), y: fc.constantFrom(0, 1) }),
      items: fc.uniqueArray(fc.record({ id: fc.constantFrom("p", "q", "r"), v: fc.constantFrom(0, 1) }), { selector: (r) => r.id, maxLength: 3 }),
      steps: fc.array(fc.constantFrom("s1", "s2", "s3"), { maxLength: 4 }),
      tags: fc.uniqueArray(fc.constantFrom("t1", "t2", "t3")),
      votes: fc.array(fc.constantFrom(1, 2), { maxLength: 4 }),
    })
    .map((value) => JSON.parse(JSON.stringify(value)))
  const arrays = {
    default: "sequence",
    rules: [{ path: ["items"], mode: "keyed", key: "id" }, { path: ["tags"], mode: "set" }, { path: ["votes"], mode: "multiset" }],
  }
  // Sets and multisets are unordered: compare them by contents.
  const normalize = (value) => JSON.stringify({ ...value, tags: [...value.tags].sort(), votes: [...value.votes].sort() })
  const canonical = (state) =>
    normalize(mergeStates({ originalState: state, submittedState: state, currentServerState: state, arrays }).value)
  fc.assert(
    fc.property(record, record, record, (original, submitted, server) => {
      const result = mergeStates({ originalState: original, submittedState: submitted, currentServerState: server, arrays, autoMerge: "review-mixed" })
      if (!result.ok) return
      const value = normalize(result.value)
      assert.ok(value === canonical(submitted) || value === canonical(server), `mixed result auto-accepted: ${value}`)
    }),
    { numRuns: 1000 },
  )
})

test("set and multiset order-only changes are not changes", () => {
  const arrays = { rules: [{ path: ["tags"], mode: "set" }, { path: ["votes"], mode: "multiset" }] }
  const input = {
    originalState: { tags: ["a", "b"], votes: [1, 1, 2], title: "old" },
    submittedState: { tags: ["b", "a"], votes: [2, 1, 1], title: "old" },
    currentServerState: { tags: ["a", "b"], votes: [1, 1, 2], title: "new" },
    arrays,
  }
  // The result is exactly what the server wrote, so it needs no review.
  assert.deepEqual(mergeStates({ ...input, autoMerge: "review-mixed" }), {
    ok: true,
    value: { tags: ["a", "b"], title: "new", votes: [1, 1, 2] },
    conflicts: [],
  })
  const report = mergeStates({ ...input, includeReport: true }).report.changes
  assert.deepEqual(report.map(({ path, provenance }) => [path, provenance]), [[["title"], "server-only"]])
  // Order-only on both sides, and order-only against a real membership change.
  assert.deepEqual(
    mergeStates({ ...input, currentServerState: { tags: ["b", "a", "c"], votes: [1, 2, 1, 2], title: "old" }, autoMerge: "review-mixed" }),
    { ok: true, value: { tags: ["b", "a", "c"], title: "old", votes: [1, 2, 1, 2] }, conflicts: [] },
  )
})

test("an order-only set or multiset change never sends a one-sided result to review", () => {
  const arrays = { rules: [{ path: ["tags"], mode: "set" }, { path: ["votes"], mode: "multiset" }] }
  const base = fc
    .record({
      title: fc.constantFrom("a", "b"),
      tags: fc.uniqueArray(fc.constantFrom("t1", "t2", "t3", "t4")),
      votes: fc.array(fc.constantFrom(1, 2, 3), { maxLength: 5 }),
    })
    .map((value) => JSON.parse(JSON.stringify(value)))
  const view = (value) => ({ title: value.title, tags: [...value.tags].sort(), votes: [...value.votes].sort() })
  fc.assert(
    fc.property(base, fc.nat(20), fc.boolean(), (original, seed, flip) => {
      const shuffle = (list) =>
        list.map((value, index) => [((index + 1) * (seed + 7)) % 13, value]).sort((a, b) => a[0] - b[0]).map(([, value]) => value)
      const reordered = { ...original, tags: shuffle(original.tags), votes: shuffle(original.votes) }
      const edited = { ...original, title: original.title === "a" ? "b" : "a" }
      const [submittedState, currentServerState] = flip ? [reordered, edited] : [edited, reordered]
      const result = mergeStates({ originalState: original, submittedState, currentServerState, arrays, autoMerge: "review-mixed" })
      assert.equal(result.ok, true)
      assert.deepEqual(view(result.value), view(edited))
    }),
    { numRuns: 1000 },
  )
})

// ---------------------------------------------------------------------------
// Second review round
// ---------------------------------------------------------------------------

test("large keyed appends do not overflow the stack", () => {
  const added = Array.from({ length: 30_000 }, (_, index) => ({ id: index + 1 }))
  const result = mergeStates({
    originalState: { l: [{ id: 0, v: 0 }] },
    submittedState: { l: [{ id: 0, v: 0 }, ...added] },
    currentServerState: { l: [{ id: 0, v: 1 }] },
    ...keyed(["l"]),
  })
  assert.equal(result.value.l.length, 30_001)
  assert.deepEqual(result.value.l[0], { id: 0, v: 1 })
  assert.deepEqual(result.value.l.at(-1), { id: 30_000 })
})

test("set order inside keyed items is not a change", () => {
  const input = {
    originalState: { items: [{ id: "a", tags: ["a", "b"], note: 1 }] },
    submittedState: { items: [{ id: "a", tags: ["b", "a"], note: 1 }] },
    currentServerState: { items: [{ id: "a", tags: ["a", "b"], note: 2 }] },
    arrays: { rules: [{ path: ["items"], mode: "keyed", key: "id" }, { path: ["items", ANY, "tags"], mode: "set" }] },
  }
  assert.deepEqual(mergeStates({ ...input, autoMerge: "review-mixed" }), {
    ok: true,
    value: { items: [{ id: "a", note: 2, tags: ["a", "b"] }] },
    conflicts: [],
  })
  const report = mergeStates({ ...input, includeReport: true }).report.changes
  assert.deepEqual(report.map(({ path, provenance }) => [path, provenance]), [[["items"], "server-only"]])
})

test("sequence: a move on one side never undoes a deletion on the other", () => {
  const input = { originalState: ["e0", "e1"], submittedState: ["e1"], currentServerState: ["e1", "e0"], ...sequence }
  const first = mergeStates(input)
  assert.deepEqual(first.conflicts, [{
    path: [{ from: 0, to: 2 }],
    submitted: { exists: true, value: ["e1"] },
    currentServer: { exists: true, value: ["e1", "e0"] },
  }])
  assert.deepEqual(resolveAll(input, "submitted").value, ["e1"])
  assert.deepEqual(resolveAll(input, "currentServer").value, ["e1", "e0"])
})

test("sequence: copies neither side touched survive other copies' deletions", () => {
  // Submitted deletes three copies of "x"; the server deletes one of the same
  // copies. The last copy is untouched by both, so it stays.
  const result = mergeStates({
    originalState: ["x", "a", "x", "b", "x", "c", "x"],
    submittedState: ["a", "b", "c", "x"],
    currentServerState: ["a", "x", "b", "x", "c", "x"],
    ...sequence,
  })
  assert.deepEqual(result, { ok: true, value: ["a", "b", "c", "x"], conflicts: [] })
})

test("sequence never lets one side's move undo the other side's deletion", () => {
  const list = fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 6 })
  const threeWay = (o, s, c) => (s === o ? c : c === o || s === c ? s : Math.max(0, s + c - o))
  const count = (values, value) => values.filter((entry) => entry === value).length
  fc.assert(
    fc.property(list, list, list, (original, submitted, server) => {
      const result = mergeStates({ originalState: original, submittedState: submitted, currentServerState: server, ...sequence })
      if (!result.ok) return
      for (const value of new Set(original)) {
        const o = count(original, value)
        const s = count(submitted, value)
        const c = count(server, value)
        // Copies neither side touched are in both inputs (at most min(s, c));
        // beyond those, a deleted value never exceeds its three-way count.
        // When one side kept every copy, the bound is the three-way count.
        if (s < o || c < o) {
          assert.ok(count(result.value, value) <= Math.max(threeWay(o, s, c), Math.min(s, c)), `value ${value}`)
        }
      }
    }),
    { numRuns: 2000 },
  )
})

test("multiset counts: identical changes agree, different changes combine", () => {
  const rules = { arrays: { rules: [{ path: ["v"], mode: "multiset" }] } }
  const run = (o, s, c) => mergeStates({ originalState: { v: o }, submittedState: { v: s }, currentServerState: { v: c }, ...rules }).value.v
  // Both sides removed one copy: one copy is removed.
  assert.deepEqual(run(["x", "x"], ["x", "y"], ["x"]), ["x", "y"])
  // Different changes combine their deltas.
  assert.deepEqual(run(["x"], ["x", "x"], ["x", "x", "x"]).filter((v) => v === "x").length, 4)
  assert.deepEqual(run(["x", "x", "x"], ["x"], ["x", "x"]).filter((v) => v === "x").length, 0)
})

test("EACH expansion over keyed arrays stays linear", () => {
  const base = Array.from({ length: 8_000 }, (_, index) => ({ id: `i${index}`, price: 1, currency: "EUR" }))
  const started = performance.now()
  const result = mergeStates({
    originalState: { items: base },
    submittedState: { items: base.map((item, index) => (index === 5 ? { ...item, price: 2 } : item)) },
    currentServerState: { items: base.map((item, index) => (index === 7_995 ? { ...item, currency: "USD" } : item)) },
    ...keyed(),
    groups: [{ id: "money", paths: [["items", EACH, "price"], ["items", EACH, "currency"]] }],
  })
  assert.equal(result.ok, true)
  // Quadratic expansion took seconds here; linear expansion takes well under one.
  assert.ok(performance.now() - started < 3_000)
})
