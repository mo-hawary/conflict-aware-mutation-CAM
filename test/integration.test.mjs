import assert from "node:assert/strict"
import test from "node:test"

import { matchConflictError, mergeStates } from "../dist/index.js"

test("matches the configured stale-write error before merging current server state", () => {
  const match = matchConflictError({
    error: { code: 409, text: "Order was modified" },
    expectedError: { code: 409 },
  })

  assert.deepEqual(match, { matched: true })

  const result = mergeStates({
    originalState: {
      shippingAddress: { city: "Cairo", street: "Tahrir" },
      phone: "111",
    },
    submittedState: {
      shippingAddress: { city: "Giza", street: "Tahrir" },
      phone: "111",
    },
    currentServerState: {
      shippingAddress: { city: "Cairo", street: "Corniche" },
      phone: "222",
    },
  })

  assert.deepEqual(result, {
    ok: true,
    value: {
      shippingAddress: { city: "Giza", street: "Corniche" },
      phone: "222",
    },
    conflicts: [],
  })
})

test("does not enter merge flow for an unrelated backend error", () => {
  const match = matchConflictError({
    error: { code: 500, text: "Database unavailable" },
    expectedError: { code: 409 },
  })

  assert.deepEqual(match, {
    matched: false,
    error: { code: 500, text: "Database unavailable" },
  })
})
