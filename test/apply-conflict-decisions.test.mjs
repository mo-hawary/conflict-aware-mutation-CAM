import assert from "node:assert/strict"
import test from "node:test"

import {
  applyConflictDecisions,
  CAMConfigError,
  matchConflictError,
  mergeStates,
  resolveConflict,
} from "../dist/index.js"

const conflictFor = (originalState, submittedState, currentServerState) => {
  const result = mergeStates({ originalState, submittedState, currentServerState })
  assert.equal(result.ok, false)
  return result.conflicts
}

const decision = (conflict, choice = "submitted", sessionId = "edit-1") => ({
  sessionId,
  conflict,
  choice,
})

test("applies an exact field conflict choice and keeps non-conflicting changes", () => {
  const originalState = { status: "pending", phone: "111", address: { city: "Cairo" } }
  const submittedState = { status: "cancelled", phone: "111", address: { city: "Giza" } }
  const currentServerState = { status: "paid", phone: "222", address: { city: "Cairo" } }
  const [statusConflict] = conflictFor(originalState, submittedState, currentServerState)

  assert.deepEqual(
    applyConflictDecisions({
      sessionId: "edit-1",
      originalState,
      submittedState,
      currentServerState,
      decisions: [decision(statusConflict)],
    }),
    {
      ok: true,
      value: { status: "cancelled", phone: "222", address: { city: "Giza" } },
      conflicts: [],
    },
  )
})

test("supports root conflicts, atomic arrays, deletion, null, and __proto__ paths", () => {
  const rootConflict = conflictFor(1, 2, 3)[0]
  assert.deepEqual(
    applyConflictDecisions({
      sessionId: "edit-1",
      originalState: 1,
      submittedState: 2,
      currentServerState: 3,
      decisions: [decision(rootConflict, "currentServer")],
    }),
    { ok: true, value: 3, conflicts: [] },
  )

  const arrayInputs = {
    originalState: { items: [1] },
    submittedState: { items: [2] },
    currentServerState: { items: [3] },
  }
  const [arrayConflict] = conflictFor(
    arrayInputs.originalState,
    arrayInputs.submittedState,
    arrayInputs.currentServerState,
  )
  assert.deepEqual(
    applyConflictDecisions({
      sessionId: "edit-1",
      ...arrayInputs,
      decisions: [decision(arrayConflict, "currentServer")],
    }),
    { ok: true, value: { items: [3] }, conflicts: [] },
  )

  const deletionInputs = {
    originalState: { phone: "111" },
    submittedState: {},
    currentServerState: { phone: "222" },
  }
  const [deletionConflict] = conflictFor(
    deletionInputs.originalState,
    deletionInputs.submittedState,
    deletionInputs.currentServerState,
  )
  assert.deepEqual(
    applyConflictDecisions({
      sessionId: "edit-1",
      ...deletionInputs,
      decisions: [decision(deletionConflict)],
    }),
    { ok: true, value: {}, conflicts: [] },
  )

  const nullInputs = {
    originalState: { phone: "111" },
    submittedState: { phone: null },
    currentServerState: { phone: "222" },
  }
  const [nullConflict] = conflictFor(
    nullInputs.originalState,
    nullInputs.submittedState,
    nullInputs.currentServerState,
  )
  assert.deepEqual(
    applyConflictDecisions({
      sessionId: "edit-1",
      ...nullInputs,
      decisions: [decision(nullConflict, "currentServer")],
    }),
    { ok: true, value: { phone: "222" }, conflicts: [] },
  )

  const originalProto = JSON.parse('{"__proto__":{"value":0}}')
  const submittedProto = JSON.parse('{"__proto__":{"value":1}}')
  const serverProto = JSON.parse('{"__proto__":{"value":2}}')
  const [protoConflict] = conflictFor(originalProto, submittedProto, serverProto)
  const protoResult = applyConflictDecisions({
    sessionId: "edit-1",
    originalState: originalProto,
    submittedState: submittedProto,
    currentServerState: serverProto,
    decisions: [decision(protoConflict, "currentServer")],
  })
  assert.equal(protoResult.ok, true)
  assert.equal(Object.getPrototypeOf(protoResult.value), Object.prototype)
  assert.deepEqual(protoResult.value.__proto__, { value: 2 })
  assert.equal({}.value, undefined)
})

test("requires complete, unique, current decisions and matching sessions", () => {
  const inputs = {
    originalState: { a: 0, b: 0 },
    submittedState: { a: 1, b: 1 },
    currentServerState: { a: 2, b: 2 },
  }
  const conflicts = conflictFor(
    inputs.originalState,
    inputs.submittedState,
    inputs.currentServerState,
  )
  const apply = (decisions, sessionId = "edit-1", overrides = {}) =>
    applyConflictDecisions({ ...inputs, sessionId, decisions, ...overrides })

  assert.throws(() => apply([]), CAMConfigError)
  assert.throws(() => apply([decision(conflicts[0])]), CAMConfigError)
  assert.throws(
    () => apply([decision(conflicts[0]), decision(conflicts[0])]),
    CAMConfigError,
  )
  assert.throws(
    () => apply([decision(conflicts[0]), decision(conflicts[1], "currentServer", "old-edit")]),
    CAMConfigError,
  )
  assert.throws(() => apply([decision({ ...conflicts[0], path: ["stale"] }), decision(conflicts[1])]), CAMConfigError)
  assert.throws(() => apply([decision(conflicts[0], "server"), decision(conflicts[1])]), CAMConfigError)
  assert.throws(() => apply([decision(conflicts[0]), decision(conflicts[1])], ""), CAMConfigError)

  const noConflicts = {
    originalState: { a: 0 },
    submittedState: { a: 1 },
    currentServerState: { a: 0 },
  }
  assert.deepEqual(
    applyConflictDecisions({
      ...noConflicts,
      sessionId: "edit-1",
      decisions: [],
    }),
    { ok: true, value: { a: 1 }, conflicts: [] },
  )
  assert.throws(
    () => applyConflictDecisions({ ...noConflicts, sessionId: "edit-1", decisions: [decision(conflicts[0])] }),
    CAMConfigError,
  )
})

test("rejects malformed decisions without invoking accessors or mutating caller data", () => {
  const inputs = {
    originalState: { a: 0 },
    submittedState: { a: 1 },
    currentServerState: { a: 2 },
  }
  const [currentConflict] = conflictFor(
    inputs.originalState,
    inputs.submittedState,
    inputs.currentServerState,
  )
  const choice = decision(currentConflict)
  const before = JSON.stringify(choice)
  let reads = 0
  const accessorChoice = { sessionId: "edit-1", conflict: currentConflict }
  Object.defineProperty(accessorChoice, "choice", {
    enumerable: true,
    get() {
      reads += 1
      return "submitted"
    },
  })

  assert.throws(
    () =>
      applyConflictDecisions({
        ...inputs,
        sessionId: "edit-1",
        decisions: [accessorChoice],
      }),
    CAMConfigError,
  )
  assert.equal(reads, 0)

  const result = applyConflictDecisions({
    ...inputs,
    sessionId: "edit-1",
    decisions: [choice],
  })
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(choice), before)
  assert.deepEqual(currentConflict.path, ["a"])
  result.value.a = 99
  assert.equal(inputs.submittedState.a, 1)
  assert.equal(inputs.currentServerState.a, 2)
})

test("rejects malformed call and conflict shapes without guessing a choice", () => {
  const inputs = {
    originalState: { a: 0 },
    submittedState: { a: 1 },
    currentServerState: { a: 2 },
  }
  const currentConflict = conflictFor(
    inputs.originalState,
    inputs.submittedState,
    inputs.currentServerState,
  )[0]
  const call = (decisions, overrides = {}) =>
    applyConflictDecisions({
      ...inputs,
      sessionId: "edit-1",
      decisions,
      ...overrides,
    })

  assert.throws(() => applyConflictDecisions(null), CAMConfigError)
  assert.throws(() => applyConflictDecisions({ ...inputs, decisions: [] }), CAMConfigError)
  assert.throws(() => applyConflictDecisions({ ...inputs, sessionId: "edit-1" }), CAMConfigError)
  assert.throws(() => call({}), CAMConfigError)
  assert.throws(() => call([null]), CAMConfigError)
  assert.throws(() => call([{ sessionId: "", conflict: currentConflict, choice: "submitted" }]), CAMConfigError)
  assert.throws(() => call([{ sessionId: "edit-1", conflict: currentConflict, choice: "submitted", extra: true }]), CAMConfigError)
  assert.throws(() => call([{ sessionId: "edit-1", conflict: currentConflict, choice: "submitted" }], { decisions: "not-an-array" }), CAMConfigError)

  const malformedConflicts = [
    { ...currentConflict, extra: true },
    { ...currentConflict, path: "not-an-array" },
    { ...currentConflict, path: [false] },
    { ...currentConflict, path: [0] },
    { ...currentConflict, submitted: { exists: "yes" } },
    { ...currentConflict, submitted: { exists: true } },
    { ...currentConflict, submitted: { exists: false, value: 1 } },
  ]
  for (const conflict of malformedConflicts) {
    assert.throws(
      () => call([{ sessionId: "edit-1", conflict, choice: "submitted" }]),
      CAMConfigError,
    )
  }

  const accessorConflict = { path: ["a"], submitted: currentConflict.submitted }
  Object.defineProperty(accessorConflict, "currentServer", {
    enumerable: true,
    get() {
      throw new Error("must not run")
    },
  })
  assert.throws(
    () => call([{ sessionId: "edit-1", conflict: accessorConflict, choice: "submitted" }]),
    CAMConfigError,
  )
})

test("rejects call-level accessors without invoking them", () => {
  const inputs = {
    originalState: { a: 0 },
    submittedState: { a: 1 },
    currentServerState: { a: 2 },
    decisions: [],
  }
  let reads = 0
  const accessorInput = { ...inputs }
  Object.defineProperty(accessorInput, "sessionId", {
    enumerable: true,
    get() {
      reads += 1
      return "edit-1"
    },
  })
  assert.throws(() => applyConflictDecisions(accessorInput), CAMConfigError)
  assert.equal(reads, 0)

  const accessorDecisions = { ...inputs, sessionId: "edit-1" }
  Object.defineProperty(accessorDecisions, "decisions", {
    enumerable: true,
    get() {
      reads += 1
      return []
    },
  })
  assert.throws(() => applyConflictDecisions(accessorDecisions), CAMConfigError)
  assert.equal(reads, 0)
})

test("keeps numeric and string path segments distinct when binding choices", () => {
  const snapshots = {
    originalState: { "0": "old" },
    submittedState: { "0": "submitted" },
    currentServerState: { "0": "server" },
  }
  const [conflict] = conflictFor(
    snapshots.originalState,
    snapshots.submittedState,
    snapshots.currentServerState,
  )
  assert.deepEqual(conflict.path, ["0"])
  assert.throws(
    () => applyConflictDecisions({
      ...snapshots,
      sessionId: "edit-1",
      decisions: [{
        sessionId: "edit-1",
        conflict: { ...conflict, path: [0] },
        choice: "submitted",
      }],
    }),
    CAMConfigError,
  )
})

test("omits only enumerable object undefined values when explicitly enabled", () => {
  const parser = { nested: { caption: undefined, label: "Order" }, rows: [{ note: undefined }] }
  let getterReads = 0
  Object.defineProperty(parser.nested, "ignored", {
    enumerable: false,
    get() {
      getterReads += 1
      return undefined
    },
  })
  const originalState = structuredClone({ nested: { caption: "old", label: "Order" }, rows: [{ note: "old" }] })
  const submittedState = parser
  const currentServerState = { nested: { caption: "server", label: "Order" }, rows: [{ note: "old" }] }

  assert.throws(
    () => mergeStates({ originalState, submittedState, currentServerState }),
    CAMConfigError,
  )
  assert.deepEqual(
    mergeStates({
      originalState,
      submittedState,
      currentServerState,
      undefinedObjectProperties: "omit",
    }),
    {
      ok: false,
      kind: "conflict",
      conflicts: [
        {
          path: ["nested", "caption"],
          submitted: { exists: false },
          currentServer: { exists: true, value: "server" },
        },
      ],
    },
  )
  assert.equal(getterReads, 0)
  assert.equal(Object.hasOwn(parser.nested, "caption"), true)
  assert.equal(Object.hasOwn(parser.rows[0], "note"), true)

  for (const badRootOrArray of [
    undefined,
    [undefined],
    { items: [undefined] },
  ]) {
    assert.throws(
      () =>
        mergeStates({
          originalState: {},
          submittedState: badRootOrArray,
          currentServerState: {},
          undefinedObjectProperties: "omit",
        }),
      CAMConfigError,
    )
  }

  const accessor = {}
  Object.defineProperty(accessor, "caption", {
    enumerable: true,
    get() {
      getterReads += 1
      return undefined
    },
  })
  assert.throws(
    () =>
      mergeStates({
        originalState: {},
        submittedState: accessor,
        currentServerState: {},
        undefinedObjectProperties: "omit",
      }),
    CAMConfigError,
  )
  assert.equal(getterReads, 0)
})

test("applies choices and composes matching with normalized merge snapshots", () => {
  const snapshots = {
    originalState: { caption: undefined, status: "pending" },
    submittedState: { caption: undefined, status: "cancelled" },
    currentServerState: { caption: undefined, status: "paid" },
    undefinedObjectProperties: "omit",
  }
  const [statusConflict] = conflictFor(
    { status: "pending" },
    { status: "cancelled" },
    { status: "paid" },
  )
  const applied = applyConflictDecisions({
    ...snapshots,
    sessionId: "edit-1",
    decisions: [decision(statusConflict, "currentServer")],
  })
  assert.deepEqual(applied, { ok: true, value: { status: "paid" }, conflicts: [] })

  assert.deepEqual(
    resolveConflict({
      error: { code: 409, text: "stale" },
      expectedError: { code: 409 },
      ...snapshots,
    }),
    {
      matched: true,
      result: {
        ok: false,
        kind: "conflict",
        conflicts: [
          {
            path: ["status"],
            submitted: { exists: true, value: "cancelled" },
            currentServer: { exists: true, value: "paid" },
          },
        ],
      },
    },
  )
})

test("resolveConflict returns the configured unmatched error before reading state", () => {
  let stateReads = 0
  const input = {
    error: { code: 500, text: "database unavailable" },
    expectedError: { code: 409 },
    errorOutput: { text: "Unable to update" },
    get originalState() {
      stateReads += 1
      return {}
    },
    submittedState: {},
    currentServerState: {},
  }

  assert.deepEqual(resolveConflict(input), {
    matched: false,
    error: { code: 500, text: "Unable to update" },
  })
  assert.deepEqual(
    matchConflictError({ error: input.error, expectedError: input.expectedError }),
    { matched: false, error: { code: 500, text: "database unavailable" } },
  )
  assert.equal(stateReads, 0)
})
