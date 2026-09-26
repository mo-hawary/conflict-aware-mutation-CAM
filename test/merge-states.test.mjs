import assert from "node:assert/strict"
import test from "node:test"

import { CAMConfigError, mergeStates } from "../dist/index.js"

test("keeps a server-only change", () => {
  const result = mergeStates({
    originalState: { status: "pending", phone: "111" },
    submittedState: { status: "pending", phone: "111" },
    currentServerState: { status: "pending", phone: "222" },
  })

  assert.deepEqual(result, {
    ok: true,
    value: { status: "pending", phone: "222" },
    conflicts: [],
  })
})

test("keeps a submitted-only change", () => {
  const result = mergeStates({
    originalState: { status: "pending" },
    submittedState: { status: "paid" },
    currentServerState: { status: "pending" },
  })

  assert.deepEqual(result, {
    ok: true,
    value: { status: "paid" },
    conflicts: [],
  })
})

test("accepts the same change on both sides", () => {
  const result = mergeStates({
    originalState: { status: "pending" },
    submittedState: { status: "paid" },
    currentServerState: { status: "paid" },
  })

  assert.deepEqual(result, {
    ok: true,
    value: { status: "paid" },
    conflicts: [],
  })
})

test("reports a scalar conflict", () => {
  const result = mergeStates({
    originalState: { status: "pending" },
    submittedState: { status: "cancelled" },
    currentServerState: { status: "paid" },
  })

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["status"],
        submitted: { exists: true, value: "cancelled" },
        currentServer: { exists: true, value: "paid" },
      },
    ],
  })
})

test("recursively merges non-overlapping object changes", () => {
  const result = mergeStates({
    originalState: {
      shippingAddress: { city: "Cairo", street: "Tahrir" },
    },
    submittedState: {
      shippingAddress: { city: "Giza", street: "Tahrir" },
    },
    currentServerState: {
      shippingAddress: { city: "Cairo", street: "Corniche" },
    },
  })

  assert.deepEqual(result, {
    ok: true,
    value: {
      shippingAddress: { city: "Giza", street: "Corniche" },
    },
    conflicts: [],
  })
})

test("treats arrays atomically", () => {
  const result = mergeStates({
    originalState: { items: [1, 2] },
    submittedState: { items: [1, 3] },
    currentServerState: { items: [1, 4] },
  })

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["items"],
        submitted: { exists: true, value: [1, 3] },
        currentServer: { exists: true, value: [1, 4] },
      },
    ],
  })
})

test("distinguishes deletion from null", () => {
  const result = mergeStates({
    originalState: { phone: "111" },
    submittedState: {},
    currentServerState: { phone: null },
  })

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["phone"],
        submitted: { exists: false },
        currentServer: { exists: true, value: null },
      },
    ],
  })
})

test("applies a safe deletion when the server is unchanged", () => {
  const result = mergeStates({
    originalState: { phone: "111", status: "pending" },
    submittedState: { status: "pending" },
    currentServerState: { phone: "111", status: "pending" },
  })

  assert.deepEqual(result, {
    ok: true,
    value: { status: "pending" },
    conflicts: [],
  })
})

test("reports delete-vs-change explicitly", () => {
  const result = mergeStates({
    originalState: { phone: "111" },
    submittedState: {},
    currentServerState: { phone: "222" },
  })

  assert.deepEqual(result, {
    ok: false,
    kind: "conflict",
    conflicts: [
      {
        path: ["phone"],
        submitted: { exists: false },
        currentServer: { exists: true, value: "222" },
      },
    ],
  })
})

test("orders conflicts deterministically by path", () => {
  const result = mergeStates({
    originalState: { z: 0, a: 0 },
    submittedState: { z: 1, a: 1 },
    currentServerState: { z: 2, a: 2 },
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.conflicts.map((conflict) => conflict.path),
    [["a"], ["z"]],
  )
})

test("does not mutate or alias caller inputs", () => {
  const originalState = { nested: { value: 1 } }
  const submittedState = { nested: { value: 2 } }
  const currentServerState = { nested: { value: 1 } }
  const before = JSON.stringify({ originalState, submittedState, currentServerState })

  const result = mergeStates({ originalState, submittedState, currentServerState })

  assert.equal(result.ok, true)
  assert.equal(
    JSON.stringify({ originalState, submittedState, currentServerState }),
    before,
  )
  assert.notEqual(result.value, submittedState)
  assert.notEqual(result.value.nested, submittedState.nested)

  result.value.nested.value = 99
  assert.equal(submittedState.nested.value, 2)
})

test("rejects unsupported state values", () => {
  assert.throws(
    () =>
      mergeStates({
        originalState: { when: new Date() },
        submittedState: {},
        currentServerState: {},
      }),
    CAMConfigError,
  )
})
