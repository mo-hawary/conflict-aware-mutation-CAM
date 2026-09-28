// Review-first stale-write recovery with fetch() and an ETag-guarded REST API.
// Run with `npm run examples`. Starts a throwaway local server; no network access.
import assert from "node:assert/strict"
import { createServer } from "node:http"

import {
  matchConflictError,
  mergeStates,
} from "conflict-aware-mutation"
import { chooseSides } from "./choose-sides.mjs"

const initialOrder = {
  status: "pending",
  customer: { name: "Mona", phone: "111" },
  displayName: "Mona",
  notes: "",
}
let order = structuredClone(initialOrder)
let version = 1

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json", etag: `"${version}"` })
    response.end(JSON.stringify(body))
  }

  if (request.method === "GET") return send(200, order)

  if (request.method === "PUT") {
    if (request.headers["if-match"] !== `"${version}"`) {
      return send(412, { code: "STALE_WRITE", text: "Order was changed by someone else" })
    }
    let body = ""
    for await (const chunk of request) body += chunk
    order = JSON.parse(body)
    version += 1
    return send(200, order)
  }

  send(405, { code: "METHOD_NOT_ALLOWED" })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}/orders/1`

async function load() {
  const response = await fetch(url)
  return { state: await response.json(), etag: response.headers.get("etag") }
}

async function save(state, etag) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": etag },
    body: JSON.stringify(state),
  })
  const body = await response.json()
  return response.ok ? { ok: true, state: body } : { ok: false, error: body }
}

function isTerminal(orderState) {
  return orderState.status === "cancelled"
}

// Preparation and domain validation stay in the application. The structural
// merge is only a candidate; it is never written before review and confirmation.
function prepareOrderCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate

  const prepared = { ...candidate }
  const customer = candidate.customer
  if (customer && typeof customer === "object" && !Array.isArray(customer)) {
    prepared.customer = { ...customer }
    if (typeof customer.name === "string") prepared.displayName = customer.name.trim()
  }
  return prepared
}

function validateOrderCandidate(candidate) {
  const issues = []
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { valid: false, issues: ["Order must be an object"] }
  }
  const customer = candidate.customer
  if (!customer || typeof customer !== "object" || Array.isArray(customer) || typeof customer.name !== "string") {
    issues.push("Customer name must be text")
  } else if (customer.name.trim().length === 0) {
    issues.push("Customer name is required")
  }
  if (!customer || typeof customer !== "object" || Array.isArray(customer) || typeof customer.phone !== "string") {
    issues.push("Customer phone must be text")
  }
  if (!new Set(["pending", "processing", "cancelled"]).has(candidate.status)) {
    issues.push("Status is not supported")
  }
  if (typeof candidate.notes !== "string") issues.push("Notes must be text")
  return issues.length === 0 ? { valid: true } : { valid: false, issues }
}

function prepareAndValidate(candidate) {
  const prepared = prepareOrderCandidate(candidate)
  const validation = validateOrderCandidate(prepared)
  return validation.valid
    ? { valid: true, candidate: prepared }
    : { valid: false, candidate: prepared, issues: validation.issues }
}

// The stale error is matched before fetching currentServerState. A latest
// terminal record stops recovery before conflicts or candidate choices appear.
async function startRecovery({ originalState, submittedState, etag, sessionId }) {
  const first = await save(submittedState, etag)
  if (first.ok) return { kind: "saved", state: first.state }

  const match = matchConflictError({
    error: first.error,
    expectedError: { code: "STALE_WRITE" },
    errorOutput: { text: "Unable to update this order" },
  })
  if (!match.matched) return { kind: "failed", error: match.error }

  const latest = await load()
  if (isTerminal(latest.state)) {
    return { kind: "terminal", currentServerState: latest.state, etag: latest.etag }
  }

  const inputs = { originalState, submittedState, currentServerState: latest.state }
  const merged = mergeStates(inputs)
  if (!merged.ok) {
    return {
      kind: "conflicts",
      conflicts: merged.conflicts,
      inputs,
      etag: latest.etag,
      sessionId,
    }
  }

  const prepared = prepareAndValidate(merged.value)
  if (!prepared.valid) {
    return { kind: "validation-failed", candidate: prepared.candidate, issues: prepared.issues }
  }

  return {
    kind: "review-ready",
    candidate: prepared.candidate,
    etag: latest.etag,
    sessionId,
  }
}

async function confirmReview(review) {
  // This explicit call is the user's confirmation boundary. The latest ETag
  // remains attached to this candidate, so a newer server write is rejected.
  return save(review.candidate, review.etag)
}

try {
  // A server-only phone edit and a submitted notes edit merge into a candidate.
  const { state: originalState, etag } = await load()
  const other = await load()
  const changedPhone = {
    ...other.state,
    customer: { ...other.state.customer, phone: "222" },
  }
  assert.equal((await save(changedPhone, other.etag)).ok, true)

  const clean = await startRecovery({
    originalState,
    submittedState: { ...originalState, notes: "Leave at the door" },
    etag,
    sessionId: "order-1-edit-1",
  })
  assert.equal(clean.kind, "review-ready")
  assert.deepEqual(clean.candidate, {
    customer: { name: "Mona", phone: "222" },
    displayName: "Mona",
    notes: "Leave at the door",
    status: "pending",
  })
  console.log("review the merged candidate before saving:", clean.candidate)

  const cleanSave = await confirmReview(clean)
  assert.equal(cleanSave.ok, true)
  console.log("confirmed candidate saved with its ETag:", cleanSave.state)

  // Two edits to the same field return the conflicts and the exact snapshots
  // needed by applyConflictDecisions(). No side is selected by default.
  const conflicting = await startRecovery({
    originalState,
    submittedState: {
      ...originalState,
      customer: { ...originalState.customer, phone: "333" },
    },
    etag,
    sessionId: "order-1-edit-2",
  })
  assert.equal(conflicting.kind, "conflicts")
  assert.deepEqual(conflicting.conflicts.map(({ path }) => path), [["customer", "phone"]])

  const chosen = chooseSides(
    conflicting.inputs,
    conflicting.sessionId,
    conflicting.conflicts,
    conflicting.conflicts.map(() => "submitted"),
  )
  assert.equal(chosen.ok, true)

  // Manual choices still pass through application preparation and validation,
  // then remain review-only until the caller explicitly confirms them.
  const chosenReview = prepareAndValidate(chosen.value)
  assert.equal(chosenReview.valid, true)
  const resolved = {
    kind: "review-ready",
    candidate: chosenReview.candidate,
    etag: conflicting.etag,
  }
  console.log("review the chosen candidate before saving:", resolved.candidate)

  const resolvedSave = await confirmReview(resolved)
  assert.equal(resolvedSave.ok, true)
  assert.equal(resolvedSave.state.customer.phone, "333")
  console.log("confirmed conflict choice saved:", resolvedSave.state)

  // A structurally valid candidate that fails the application schema remains
  // available for correction and is not sent to the backend.
  const invalidBaseline = await load()
  const otherNotes = {
    ...invalidBaseline.state,
    notes: "A server note",
  }
  assert.equal((await save(otherNotes, invalidBaseline.etag)).ok, true)
  const invalid = await startRecovery({
    originalState: invalidBaseline.state,
    submittedState: {
      ...invalidBaseline.state,
      customer: { ...invalidBaseline.state.customer, name: " " },
    },
    etag: invalidBaseline.etag,
    sessionId: "order-1-edit-3",
  })
  assert.equal(invalid.kind, "validation-failed")
  assert.equal(invalid.candidate.customer.name, " ")
  assert.deepEqual(invalid.issues, ["Customer name is required"])
  const repaired = prepareAndValidate({
    ...invalid.candidate,
    customer: { ...invalid.candidate.customer, name: "Mona Adel" },
  })
  assert.equal(repaired.valid, true)
  assert.equal(repaired.candidate.displayName, "Mona Adel")
  console.log("invalid candidate preserved for repair:", invalid.issues)

  // Terminal state is checked before attempting a merge or showing field choices.
  const terminalBaseline = await load()
  const serverCancelled = { ...terminalBaseline.state, status: "cancelled" }
  assert.equal((await save(serverCancelled, terminalBaseline.etag)).ok, true)
  const terminal = await startRecovery({
    originalState: terminalBaseline.state,
    submittedState: { ...terminalBaseline.state, status: "processing" },
    etag: terminalBaseline.etag,
    sessionId: "order-1-edit-4",
  })
  assert.equal(terminal.kind, "terminal")
  console.log("terminal latest state stopped recovery:", terminal.currentServerState.status)
} finally {
  server.close()
}
