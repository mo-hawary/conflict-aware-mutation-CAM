// Recovery-controller example using an explicit integer version and HTTP 409.
// Run with `npm run examples`; this starts only an in-process local server.
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { createRecoveryController } from "conflict-aware-mutation/recovery"

const initialOrder = { status: "draft", title: "Initial", notes: "" }
let order = structuredClone(initialOrder)
let version = 1
const writes = []

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }

  if (request.method === "GET") return send(200, { state: order, version })
  if (request.method === "PUT") {
    let body = ""
    for await (const chunk of request) body += chunk
    const update = JSON.parse(body)
    if (update.expectedVersion !== version) {
      return send(409, { code: "VERSION_MISMATCH", text: "Order version changed" })
    }
    order = update.state
    version += 1
    return send(200, { state: order, version })
  }
  return send(405, { code: "METHOD_NOT_ALLOWED" })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}/orders/1`

async function fetchLatest(entityId) {
  assert.equal(entityId, "order-1")
  const response = await fetch(url)
  return response.json()
}

async function mutate(candidate, { entityId, expectedVersion, attempt }) {
  assert.equal(entityId, "order-1")
  writes.push({ attempt, expectedVersion, state: structuredClone(candidate) })
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: candidate, expectedVersion }),
  })
  const body = await response.json()
  if (!response.ok) {
    throw Object.assign(new Error(body.text ?? "Request failed"), {
      code: body.code,
      text: body.text,
    })
  }
  return body
}

let currentSession = { entityId: "order-1", sessionId: "edit-1", draftRevision: 1 }
const controller = createRecoveryController({
  expectedError: { code: "VERSION_MISMATCH" },
  errorSignalFrom(cause) {
    if (typeof cause !== "object" || cause === null || typeof cause.code !== "string") return undefined
    return { code: cause.code, ...(typeof cause.text === "string" ? { text: cause.text } : {}) }
  },
  fetchLatest,
  getVersion: (latest) => latest.version,
  isTerminal: (state) => state.status === "cancelled",
  project: (merged) => merged,
  prepareCandidate: (candidate) => candidate,
  validateCandidate: (candidate) => ({ valid: true, value: candidate }),
  mutate,
  isCurrent(identity) {
    return identity.entityId === currentSession.entityId &&
      identity.sessionId === currentSession.sessionId &&
      identity.draftRevision === currentSession.draftRevision
  },
})

try {
  // Another writer advances the integer version before the user's first save.
  const baseline = await fetchLatest("order-1")
  order = { ...order, status: "approved" }
  version += 1

  const recovery = await controller.recover({
    entityId: "order-1",
    sessionId: currentSession.sessionId,
    draftRevision: currentSession.draftRevision,
    expectedVersion: baseline.version,
    originalState: baseline.state,
    submittedState: { ...baseline.state, notes: "Call before delivery" },
  })

  assert.equal(recovery.kind, "review-ready")
  assert.deepEqual(recovery.candidate, {
    notes: "Call before delivery",
    status: "approved",
    title: "Initial",
  })
  assert.deepEqual(writes.map(({ attempt, expectedVersion }) => ({ attempt, expectedVersion })), [
    { attempt: "initial", expectedVersion: 1 },
  ])
  console.log("409 recovery produced a review candidate without another write:", recovery.candidate)

  // Confirmation is the only recovery write and carries the fetched version.
  const saved = await controller.confirm(recovery.token)
  assert.equal(saved.kind, "saved")
  assert.deepEqual(writes.map(({ attempt, expectedVersion }) => ({ attempt, expectedVersion })), [
    { attempt: "initial", expectedVersion: 1 },
    { attempt: "recovery", expectedVersion: 2 },
  ])
  console.log("confirmed with explicit version 2:", saved)
} finally {
  controller.cancel()
  server.close()
}
