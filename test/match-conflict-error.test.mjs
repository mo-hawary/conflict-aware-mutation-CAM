import assert from "node:assert/strict"
import test from "node:test"

import { CAMConfigError, matchConflictError } from "../dist/index.js"

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
