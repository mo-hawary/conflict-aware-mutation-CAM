import assert from "node:assert/strict"
import test from "node:test"

import { CAMConfigError, matchConflictError } from "../dist/index.js"

test("rejects null and undefined matcher arguments with CAMConfigError", () => {
  for (const input of [null, undefined]) {
    assert.throws(() => matchConflictError(input), CAMConfigError)
  }
})

test("matches by code", () => {
  assert.deepEqual(
    matchConflictError({ error: { code: 409 }, expectedError: { code: 409 } }),
    { matched: true },
  )
})

test("matches by exact text", () => {
  assert.deepEqual(
    matchConflictError({
      error: { text: "Order was modified" },
      expectedError: { text: "Order was modified" },
    }),
    { matched: true },
  )
})

test("requires both fields when both are expected", () => {
  assert.deepEqual(
    matchConflictError({
      error: { code: 409, text: "Different text" },
      expectedError: { code: 409, text: "Order was modified" },
    }),
    { matched: false, error: { code: 409, text: "Different text" } },
  )
})

test("preserves backend error by default", () => {
  assert.deepEqual(
    matchConflictError({
      error: { code: 500, text: "Database unavailable" },
      expectedError: { code: 409 },
    }),
    { matched: false, error: { code: 500, text: "Database unavailable" } },
  )
})

test("custom output text preserves backend code", () => {
  assert.deepEqual(
    matchConflictError({
      error: { code: 500, text: "Database unavailable" },
      expectedError: { code: 409 },
      errorOutput: { text: "Unable to update this order" },
    }),
    { matched: false, error: { code: 500, text: "Unable to update this order" } },
  )
})

test("rejects empty error signals", () => {
  assert.throws(
    () => matchConflictError({ error: {}, expectedError: { code: 409 } }),
    CAMConfigError,
  )
})

const withPrototype = (prototype, own) =>
  Object.assign(Object.create(prototype), own)

test("ignores an inherited actual code when matching", () => {
  assert.deepEqual(
    matchConflictError({
      error: withPrototype({ code: 409 }, { text: "boom" }),
      expectedError: { code: 409 },
    }),
    { matched: false, error: { text: "boom" } },
  )
})

test("ignores an inherited expected code when matching by text", () => {
  assert.deepEqual(
    matchConflictError({
      error: { text: "Order was modified" },
      expectedError: withPrototype({ code: 500 }, { text: "Order was modified" }),
    }),
    { matched: true },
  )
})

test("does not leak inherited fields into the unmatched output", () => {
  assert.deepEqual(
    matchConflictError({
      error: withPrototype({ code: 500 }, { text: "boom" }),
      expectedError: { code: 409 },
    }),
    { matched: false, error: { text: "boom" } },
  )
})

test("ignores class prototype getters", () => {
  class ApiError {
    constructor(status) {
      this.status = status
    }

    get code() {
      return this.status
    }
  }

  assert.throws(
    () =>
      matchConflictError({ error: new ApiError(409), expectedError: { code: 409 } }),
    CAMConfigError,
  )
})

test("ignores an inherited errorOutput text", () => {
  assert.throws(
    () =>
      matchConflictError({
        error: { code: 500 },
        expectedError: { code: 409 },
        errorOutput: withPrototype({ text: "Unable to update" }, {}),
      }),
    CAMConfigError,
  )
})

test("rejects non-finite error codes", () => {
  for (const code of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => matchConflictError({ error: { code }, expectedError: { code: 409 } }),
      CAMConfigError,
    )
    assert.throws(
      () => matchConflictError({ error: { code: 409 }, expectedError: { code } }),
      CAMConfigError,
    )
  }
})

test("returns a fresh unmatched error object", () => {
  const error = { code: 500, text: "Database unavailable", stack: "internal" }

  const backend = matchConflictError({ error, expectedError: { code: 409 } })
  assert.notEqual(backend.error, error)
  assert.deepEqual(backend.error, { code: 500, text: "Database unavailable" })

  const custom = matchConflictError({
    error,
    expectedError: { code: 409 },
    errorOutput: { text: "Unable to update this order" },
  })
  assert.notEqual(custom.error, error)
  assert.deepEqual(error, { code: 500, text: "Database unavailable", stack: "internal" })
})

test("does not match when the code matches but the expected text differs", () => {
  assert.equal(
    matchConflictError({
      error: { code: 409, text: "Other" },
      expectedError: { code: 409, text: "Order was modified" },
    }).matched,
    false,
  )
})

test("does not match expected text against a code-only error", () => {
  assert.deepEqual(
    matchConflictError({
      error: { code: 409 },
      expectedError: { text: "Order was modified" },
    }),
    { matched: false, error: { code: 409 } },
  )
})

test("matches codes by strict type", () => {
  assert.equal(
    matchConflictError({ error: { code: "409" }, expectedError: { code: 409 } }).matched,
    false,
  )
})

test("rejects invalid errorOutput values", () => {
  for (const errorOutput of ["custom", null, [], {}, { text: 1 }]) {
    assert.throws(
      () =>
        matchConflictError({ error: { code: 500 }, expectedError: { code: 409 }, errorOutput }),
      CAMConfigError,
    )
  }
})

test("rejects invalid error signal shapes", () => {
  for (const error of [null, "409", [], { code: undefined, text: undefined }, { code: {} }, { text: 1 }]) {
    assert.throws(
      () => matchConflictError({ error, expectedError: { code: 409 } }),
      CAMConfigError,
    )
  }
})
