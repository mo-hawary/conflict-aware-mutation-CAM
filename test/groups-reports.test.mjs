import assert from "node:assert/strict"
import test from "node:test"

import {
  applyConflictDecisions,
  CAMConfigError,
  formatConflictPath,
  mergeStates,
  resolveConflict,
} from "../dist/index.js"

const group = {
  id: "variant-choice",
  paths: [["defaultVariantId"], ["variants"], ["coverMediaId"]],
}

const groupedConflictInputs = {
  originalState: {
    defaultVariantId: "blue",
    variants: [{ id: "blue", price: 10 }],
    coverMediaId: "blue-cover",
    title: "Draft",
  },
  submittedState: {
    defaultVariantId: "red",
    variants: [{ id: "red", price: 12 }],
    coverMediaId: "red-cover",
    title: "Edited title",
  },
  currentServerState: {
    defaultVariantId: "green",
    variants: [{ id: "green", price: 15 }],
    coverMediaId: "green-cover",
    title: "Draft",
  },
}

test("coupled paths produce one atomic group conflict while unrelated changes merge", () => {
  const result = mergeStates({ ...groupedConflictInputs, groups: [group] })
  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        kind: "group",
        groupId: "variant-choice",
        paths: [["coverMediaId"], ["defaultVariantId"], ["variants"]],
        submitted: [
          { path: ["coverMediaId"], value: { exists: true, value: "red-cover" } },
          { path: ["defaultVariantId"], value: { exists: true, value: "red" } },
          { path: ["variants"], value: { exists: true, value: [{ id: "red", price: 12 }] } },
        ],
        currentServer: [
          { path: ["coverMediaId"], value: { exists: true, value: "green-cover" } },
          { path: ["defaultVariantId"], value: { exists: true, value: "green" } },
          { path: ["variants"], value: { exists: true, value: [{ id: "green", price: 15 }] } },
        ],
      },
    ],
  })
  assert.equal("value" in result, false)
})

test("one exact group decision selects all coupled slots and retains independent changes", () => {
  const conflict = mergeStates({ ...groupedConflictInputs, groups: [group] }).conflicts[0]
  const selected = applyConflictDecisions({
    ...groupedConflictInputs,
    groups: [group],
    sessionId: "edit-4",
    decisions: [{ sessionId: "edit-4", conflict, choice: "submitted" }],
  })
  assert.deepEqual(selected, {
    ok: true,
    value: {
      defaultVariantId: "red",
      variants: [{ id: "red", price: 12 }],
      coverMediaId: "red-cover",
      title: "Edited title",
    },
    conflicts: [],
  })

  const selectedWithReport = applyConflictDecisions({
    ...groupedConflictInputs,
    groups: [group],
    sessionId: "edit-4",
    decisions: [{ sessionId: "edit-4", conflict, choice: "submitted" }],
    includeReport: true,
  })
  const groupChange = selectedWithReport.report.changes.find((change) => change.kind === "group")
  assert.equal(groupChange.provenance, "chosen-submitted")
  groupChange.result[2].value.value[0].id = "mutated report only"
  assert.equal(selectedWithReport.value.variants[0].id, "red")

  assert.throws(
    () => applyConflictDecisions({
      ...groupedConflictInputs,
      groups: [group],
      sessionId: "edit-5",
      decisions: [{ sessionId: "edit-5", conflict: { ...conflict, groupId: "stale" }, choice: "submitted" }],
    }),
    CAMConfigError,
  )
})

test("group changes follow three-way behavior and preserve absent versus null slots", () => {
  const onlyServer = mergeStates({
    originalState: { a: 1, b: "x" },
    submittedState: { a: 1, b: "x" },
    currentServerState: { a: null, b: "y" },
    groups: [{ id: "pair", paths: [["a"], ["b"]] }],
    includeReport: true,
  })
  assert.deepEqual(onlyServer, {
    ok: true,
    value: { a: null, b: "y" },
    conflicts: [],
    report: {
      changes: [
        {
          kind: "group",
          groupId: "pair",
          original: [
            { path: ["a"], value: { exists: true, value: 1 } },
            { path: ["b"], value: { exists: true, value: "x" } },
          ],
          submitted: [
            { path: ["a"], value: { exists: true, value: 1 } },
            { path: ["b"], value: { exists: true, value: "x" } },
          ],
          currentServer: [
            { path: ["a"], value: { exists: true, value: null } },
            { path: ["b"], value: { exists: true, value: "y" } },
          ],
          result: [
            { path: ["a"], value: { exists: true, value: null } },
            { path: ["b"], value: { exists: true, value: "y" } },
          ],
          provenance: "server-only",
        },
      ],
    },
  })

  const deletionConflict = mergeStates({
    originalState: { a: "old", b: "same" },
    submittedState: { b: "same" },
    currentServerState: { a: "new", b: "same" },
    groups: [{ id: "pair", paths: [["a"], ["b"]] }],
  })
  assert.equal(deletionConflict.ok, false)
  assert.deepEqual(deletionConflict.conflicts[0].submitted[0].value, { exists: false })
  assert.deepEqual(deletionConflict.conflicts[0].currentServer[0].value, {
    exists: true,
    value: "new",
  })
})

test("reconstructs missing nested parents around grouped additions and deletions", () => {
  assert.deepEqual(
    mergeStates({
      originalState: {},
      submittedState: {},
      currentServerState: {},
      groups: [{ id: "missing-mode", paths: [["preferences", "mode"]] }],
    }),
    { ok: true, value: {}, conflicts: [] },
  )

  const addition = mergeStates({
    originalState: {},
    submittedState: { preferences: { mode: "compact", submittedOnly: true } },
    currentServerState: {},
    groups: [{ id: "mode", paths: [["preferences", "mode"]] }],
  })
  assert.deepEqual(addition, {
    ok: true,
    value: { preferences: { mode: "compact", submittedOnly: true } },
    conflicts: [],
  })

  const groupConflictInputs = {
    originalState: {},
    submittedState: { preferences: { mode: "compact", submittedOnly: true } },
    currentServerState: { preferences: { mode: "spacious", serverOnly: true } },
    groups: [{ id: "mode", paths: [["preferences", "mode"]] }],
  }
  const unresolved = mergeStates(groupConflictInputs)
  assert.equal(unresolved.ok, false)
  assert.equal(unresolved.conflicts.length, 1)
  assert.deepEqual(unresolved.conflicts[0].submitted[0].value, {
    exists: true,
    value: "compact",
  })

  const chosen = applyConflictDecisions({
    ...groupConflictInputs,
    sessionId: "nested-1",
    decisions: [{
      sessionId: "nested-1",
      conflict: unresolved.conflicts[0],
      choice: "submitted",
    }],
  })
  assert.deepEqual(chosen, {
    ok: true,
    value: {
      preferences: { mode: "compact", submittedOnly: true, serverOnly: true },
    },
    conflicts: [],
  })

  const deletion = mergeStates({
    originalState: { preferences: { mode: "compact" } },
    submittedState: {},
    currentServerState: {},
    groups: [{ id: "mode", paths: [["preferences", "mode"]] }],
  })
  assert.deepEqual(deletion, { ok: true, value: {}, conflicts: [] })
})

test("reports smallest path changes, atomic arrays, identical edits, and unresolved conflicts", () => {
  const result = mergeStates({
    originalState: { address: { city: "Cairo", street: "A" }, items: [1], state: "open" },
    submittedState: { address: { city: "Giza", street: "A" }, items: [3], state: "closed" },
    currentServerState: { address: { city: "Cairo", street: "B" }, items: [2], state: "closed" },
    includeReport: true,
  })
  assert.equal(result.ok, false)
  assert.equal("value" in result, false)
  assert.deepEqual(result.conflicts, [
    {
      path: ["items"],
      submitted: { exists: true, value: [3] },
      currentServer: { exists: true, value: [2] },
    },
  ])
  assert.deepEqual(result.report.changes, [
    {
      kind: "path",
      path: ["address", "city"],
      original: { exists: true, value: "Cairo" },
      submitted: { exists: true, value: "Giza" },
      currentServer: { exists: true, value: "Cairo" },
      result: { exists: true, value: "Giza" },
      provenance: "submitted-only",
    },
    {
      kind: "path",
      path: ["address", "street"],
      original: { exists: true, value: "A" },
      submitted: { exists: true, value: "A" },
      currentServer: { exists: true, value: "B" },
      result: { exists: true, value: "B" },
      provenance: "server-only",
    },
    {
      kind: "path",
      path: ["items"],
      original: { exists: true, value: [1] },
      submitted: { exists: true, value: [3] },
      currentServer: { exists: true, value: [2] },
      provenance: "unresolved",
    },
    {
      kind: "path",
      path: ["state"],
      original: { exists: true, value: "open" },
      submitted: { exists: true, value: "closed" },
      currentServer: { exists: true, value: "closed" },
      result: { exists: true, value: "closed" },
      provenance: "identical-both",
    },
  ])
})

test("manual path decisions add chosen provenance without exposing partial values", () => {
  const inputs = {
    originalState: { status: "open", phone: "111" },
    submittedState: { status: "cancelled", phone: "111" },
    currentServerState: { status: "paid", phone: "222" },
  }
  const conflict = mergeStates(inputs).conflicts[0]
  const applied = applyConflictDecisions({
    ...inputs,
    sessionId: "review-1",
    decisions: [{ sessionId: "review-1", conflict, choice: "currentServer" }],
    includeReport: true,
  })
  assert.deepEqual(applied, {
    ok: true,
    value: { status: "paid", phone: "222" },
    conflicts: [],
    report: {
      changes: [
        {
          kind: "path",
          path: ["phone"],
          original: { exists: true, value: "111" },
          submitted: { exists: true, value: "111" },
          currentServer: { exists: true, value: "222" },
          result: { exists: true, value: "222" },
          provenance: "server-only",
        },
        {
          kind: "path",
          path: ["status"],
          original: { exists: true, value: "open" },
          submitted: { exists: true, value: "cancelled" },
          currentServer: { exists: true, value: "paid" },
          result: { exists: true, value: "paid" },
          provenance: "chosen-currentServer",
        },
      ],
    },
  })
  const clonedReport = mergeStates({
    originalState: {},
    submittedState: {},
    currentServerState: { profile: { phone: "222" } },
    includeReport: true,
  })
  clonedReport.report.changes[0].result.value.phone = "mutated"
  assert.equal(clonedReport.value.profile.phone, "222")
})

test("validates group IDs, path uniqueness, overlap, and root paths", () => {
  const base = {
    originalState: { item: { child: 1, sibling: 2 }, rows: [{ id: 1 }] },
    submittedState: { item: { child: 1, sibling: 2 }, rows: [{ id: 1 }] },
    currentServerState: { item: { child: 1, sibling: 2 }, rows: [{ id: 1 }] },
  }
  const badGroups = [
    [{ id: "", paths: [["item", "child"]] }],
    [{ id: "g", paths: [] }],
    [{ id: "g", paths: [[]] }],
    [{ id: "g", paths: [["item", "child"], ["item", "child"]] }],
    [{ id: "g", paths: [["item"], ["item", "child"]] }],
    [{ id: "g", paths: [["item", "child"]] }, { id: "g", paths: [["item", "sibling"]] }],
    [{ id: "g1", paths: [["item", "child"]] }, { id: "g2", paths: [["item"]] }],
  ]
  for (const groups of badGroups) {
    assert.throws(() => mergeStates({ ...base, groups }), CAMConfigError)
  }

  assert.throws(
    () => mergeStates({ ...base, groups: [{ id: "g", paths: [["item", "child"]] }], includeReport: false }),
    CAMConfigError,
  )
})

test("explicit undefined optional merge flags behave like omission", () => {
  const clean = {
    originalState: { title: "old", serverOnly: false },
    submittedState: { title: "local", serverOnly: false },
    currentServerState: { title: "old", serverOnly: true },
  }

  assert.deepEqual(
    mergeStates({ ...clean, groups: undefined, includeReport: undefined }),
    { ok: true, value: { serverOnly: true, title: "local" }, conflicts: [] },
  )

  const conflicting = {
    originalState: { status: "pending" },
    submittedState: { status: "cancelled" },
    currentServerState: { status: "paid" },
  }
  const conflict = mergeStates(conflicting).conflicts[0]

  assert.deepEqual(
    applyConflictDecisions({
      ...conflicting,
      groups: undefined,
      includeReport: undefined,
      sessionId: "undefined-options",
      decisions: [{
        sessionId: "undefined-options",
        conflict,
        choice: "currentServer",
      }],
    }),
    { ok: true, value: { status: "paid" }, conflicts: [] },
  )

  assert.deepEqual(
    resolveConflict({
      error: { code: 409 },
      expectedError: { code: 409 },
      ...clean,
      groups: undefined,
      includeReport: undefined,
    }),
    {
      matched: true,
      result: { ok: true, value: { serverOnly: true, title: "local" }, conflicts: [] },
    },
  )
})

test("group paths beneath scalar, null, or array parents merge the parent atomically", () => {
  const rows = { rows: [{ id: 1 }] }
  assert.deepEqual(
    mergeStates({
      originalState: rows,
      submittedState: rows,
      currentServerState: rows,
      groups: [{ id: "g", paths: [["rows", 0, "id"]] }],
    }),
    { ok: true, value: rows, conflicts: [] },
  )
  assert.deepEqual(
    mergeStates({
      originalState: { item: 1 },
      submittedState: { item: 1 },
      currentServerState: { item: 1 },
      groups: [{ id: "g", paths: [["item", "child"]] }],
    }),
    { ok: true, value: { item: 1 }, conflicts: [] },
  )

  // Regression: a server-side shape change is data, not a config error.
  const replaced = mergeStates({
    originalState: { a: { x: 1 } },
    submittedState: { a: { x: 2 } },
    currentServerState: { a: null },
    groups: [{ id: "g", paths: [["a", "x"]] }],
  })
  assert.equal(replaced.ok, false)
  assert.equal("value" in replaced, false)
  assert.deepEqual(replaced.conflicts, [{
    kind: "group",
    groupId: "g",
    paths: [["a"]],
    submitted: [{ path: ["a"], value: { exists: true, value: { x: 2 } } }],
    currentServer: [{ path: ["a"], value: { exists: true, value: null } }],
  }])

  assert.deepEqual(
    mergeStates({
      originalState: { a: { x: 1 } },
      submittedState: { a: { x: 1 } },
      currentServerState: { a: null },
      groups: [{ id: "g", paths: [["a", "x"]] }],
    }),
    { ok: true, value: { a: null }, conflicts: [] },
  )
})

test("group parents deleted on one side and edited on the other conflict at the parent", () => {
  // Regression: splitting this parent rebuilt { a: { y: 5 } }, which neither side had.
  const result = mergeStates({
    originalState: { a: { x: 1 } },
    submittedState: { a: { x: 1, y: 5 } },
    currentServerState: {},
    groups: [{ id: "g", paths: [["a", "x"]] }],
  })
  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [{
      kind: "group",
      groupId: "g",
      paths: [["a"]],
      submitted: [{ path: ["a"], value: { exists: true, value: { x: 1, y: 5 } } }],
      currentServer: [{ path: ["a"], value: { exists: false } }],
    }],
  })

  const mirrored = mergeStates({
    originalState: { a: { x: 1 } },
    submittedState: {},
    currentServerState: { a: { x: 1, y: 5 } },
    groups: [{ id: "g", paths: [["a", "x"]] }],
  })
  assert.equal(mirrored.ok, false)
  assert.deepEqual(mirrored.conflicts.map((conflict) => conflict.paths), [[["a"]]])

  // Regression: a changed member under an edit/delete parent used to add a
  // second, separate parent conflict that could be answered inconsistently.
  const single = mergeStates({
    originalState: { a: { x: 1 } },
    submittedState: { a: { x: 2 } },
    currentServerState: {},
    groups: [{ id: "g", paths: [["a", "x"]] }],
  })
  assert.equal(single.conflicts.length, 1)
  assert.deepEqual(single.conflicts[0].paths, [["a"]])

  // One-sided deletion of an unchanged parent still merges.
  assert.deepEqual(
    mergeStates({
      originalState: { a: { x: 1 }, b: 1 },
      submittedState: { b: 2 },
      currentServerState: { a: { x: 1 }, b: 1 },
      groups: [{ id: "g", paths: [["a", "x"]] }],
    }),
    { ok: true, value: { b: 2 }, conflicts: [] },
  )
})

test("a group keeps members coupled when one member's parent merges atomically", () => {
  const inputs = {
    originalState: { price: { currency: "USD" }, totals: { amount: 10 } },
    submittedState: { price: { currency: "EUR" }, totals: { amount: 20 } },
    currentServerState: { price: null, totals: { amount: 10 } },
    groups: [{ id: "money", paths: [["price", "currency"], ["totals", "amount"]] }],
  }
  const result = mergeStates(inputs)
  assert.equal(result.ok, false)
  assert.deepEqual(result.conflicts.map((conflict) => conflict.paths), [[["price"], ["totals", "amount"]]])

  for (const [choice, expected] of [
    ["submitted", inputs.submittedState],
    ["currentServer", inputs.currentServerState],
  ]) {
    const resolved = applyConflictDecisions({
      ...inputs,
      sessionId: "money",
      decisions: [{ sessionId: "money", conflict: result.conflicts[0], choice }],
    })
    assert.deepEqual(resolved, { ok: true, value: expected, conflicts: [] })
  }

  // Two groups collapsing onto the same atomic parent: the first group owns it.
  const shared = mergeStates({
    originalState: { a: { x: 1, y: 1 } },
    submittedState: { a: { x: 2, y: 2 } },
    currentServerState: { a: null },
    groups: [{ id: "g1", paths: [["a", "x"]] }, { id: "g2", paths: [["a", "y"]] }],
  })
  assert.deepEqual(shared.conflicts.map((conflict) => conflict.groupId), ["g1"])
})

test("group validation rejects accessors without invoking them", () => {
  let reads = 0
  const pathGroup = { paths: [["a"]] }
  Object.defineProperty(pathGroup, "id", {
    enumerable: true,
    get() {
      reads += 1
      return "group"
    },
  })
  assert.throws(
    () => mergeStates({ originalState: { a: 0 }, submittedState: { a: 1 }, currentServerState: { a: 0 }, groups: [pathGroup] }),
    CAMConfigError,
  )
  assert.equal(reads, 0)
})

test("rejects malformed group containers and path segments", () => {
  const base = {
    originalState: { item: { child: 1 } },
    submittedState: { item: { child: 1 } },
    currentServerState: { item: { child: 1 } },
  }
  for (const groups of [null, {}, [null], [{ id: "g", paths: [["item", "child"]], extra: true }], [{ id: 1, paths: [["item", "child"]] }], [{ id: "g", paths: [["item", true]] }], [{ id: "g", paths: [["item", -1]] }], [{ id: "g", paths: [["item", Number.NaN]] }]]) {
    assert.throws(() => mergeStates({ ...base, groups }), CAMConfigError)
  }
})

test("resolveConflict composes matching with grouped reports", () => {
  const result = resolveConflict({
    error: { code: 412 },
    expectedError: { code: 412 },
    ...groupedConflictInputs,
    groups: [group],
    includeReport: true,
  })
  assert.equal(result.matched, true)
  assert.equal(result.result.ok, false)
  assert.equal(result.result.conflicts[0].kind, "group")
  assert.equal(result.result.report.changes[0].kind, "group")
  assert.equal(result.result.report.changes[0].provenance, "unresolved")
  assert.equal("value" in result.result, false)
})

test("rejects malformed group conflict tuples before applying a choice", () => {
  const inputs = {
    ...groupedConflictInputs,
    groups: [group],
  }
  const currentConflict = mergeStates(inputs).conflicts[0]
  const malformed = [
    { ...currentConflict, paths: [] },
    { ...currentConflict, paths: "not-an-array" },
    { ...currentConflict, submitted: "not-an-array" },
    { ...currentConflict, currentServer: "not-an-array" },
    { ...currentConflict, submitted: [{ path: "not-an-array", value: { exists: false } }] },
  ]
  for (const conflict of malformed) {
    assert.throws(
      () => applyConflictDecisions({
        ...inputs,
        sessionId: "group-review",
        decisions: [{ sessionId: "group-review", conflict, choice: "submitted" }],
      }),
      CAMConfigError,
    )
  }
})

test("RFC 6901 formatter escapes slash and tilde and treats empty path as root", () => {
  assert.equal(formatConflictPath([]), "")
  assert.equal(formatConflictPath(["shippingAddress", "city"]), "/shippingAddress/city")
  assert.equal(formatConflictPath(["a/b", "x~y", "dot.key", "[brackets]", 3]), "/a~1b/x~0y/dot.key/[brackets]/3")
  assert.equal(formatConflictPath([""]), "/")
  assert.equal(formatConflictPath(["", ""]), "//")
  assert.equal(formatConflictPath(["__proto__", "constructor"]), "/__proto__/constructor")
  assert.throws(() => formatConflictPath([Number.NaN]), CAMConfigError)
  assert.throws(() => formatConflictPath([1.5]), CAMConfigError)
  assert.throws(() => formatConflictPath([-1]), CAMConfigError)
})

test("default results stay unchanged and opted-in empty groups retain grouped result type", () => {
  const input = {
    originalState: { a: 0 },
    submittedState: { a: 1 },
    currentServerState: { a: 2 },
  }
  assert.deepEqual(mergeStates(input), {
    ok: false,
    kind: "conflict",
    conflicts: [{ path: ["a"], submitted: { exists: true, value: 1 }, currentServer: { exists: true, value: 2 } }],
  })
  assert.deepEqual(mergeStates({ ...input, groups: [] }), {
    ok: false,
    kind: "conflict",
    conflicts: [{ path: ["a"], submitted: { exists: true, value: 1 }, currentServer: { exists: true, value: 2 } }],
  })
})
