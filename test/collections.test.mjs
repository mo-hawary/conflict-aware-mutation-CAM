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

test("sequence pairs same-shape edits by position and merges them field by field", () => {
  const input = {
    originalState: { rows: [{ n: 1, t: "a" }, { n: 2, t: "b" }, { n: 3, t: "c" }] },
    submittedState: { rows: [{ n: 1, t: "A" }, { n: 2, t: "b" }, { n: 3, t: "C" }] },
    currentServerState: { rows: [{ n: 9, t: "a" }, { n: 2, t: "b" }, { n: 3, t: "Z" }] },
    ...sequence,
  }
  const result = mergeStates(input)
  assert.deepEqual(result.conflicts, [{
    path: ["rows", { from: 2, to: 3 }, "t"],
    submitted: { exists: true, value: "C" },
    currentServer: { exists: true, value: "Z" },
  }])
  assert.deepEqual(resolveAll(input, "submitted").value.rows, [{ n: 9, t: "A" }, { n: 2, t: "b" }, { n: 3, t: "C" }])
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
  assert.deepEqual(result.report.changes.map(({ provenance }) => provenance), ["combined"])
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
        const run = (submittedState, currentServerState) =>
          mergeStates({ originalState: { x: original }, submittedState: { x: submittedState }, currentServerState: { x: currentServerState }, arrays })
        assert.deepEqual(run(edited, original).value, { x: edited })
        assert.deepEqual(run(original, edited).value, { x: edited })
        assert.deepEqual(run(edited, edited).value, { x: edited })
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
