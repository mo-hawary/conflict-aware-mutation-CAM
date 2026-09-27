// End-to-end stale-write recovery with fetch() and an ETag-guarded REST API.
// Run with `npm run examples`. Starts a throwaway local server; no network access.
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { matchConflictError, mergeStates } from "conflict-aware-mutation"

import { chooseSides } from "./choose-sides.mjs"

// --- A tiny backend with optimistic concurrency ------------------------------

let order = { status: "pending", customer: { name: "Mona", phone: "111" }, notes: "" }
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

// --- Client helpers -----------------------------------------------------------

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

// Save; on a stale write, merge with the latest server state and retry once.
async function saveWithRecovery(originalState, submittedState, etag) {
  const first = await save(submittedState, etag)
  if (first.ok) return { saved: first.state }

  const match = matchConflictError({
    error: first.error,
    expectedError: { code: "STALE_WRITE" },
    errorOutput: { text: "Unable to update this order" },
  })
  if (!match.matched) return { error: match.error }

  const latest = await load()
  const merged = mergeStates({
    originalState,
    submittedState,
    currentServerState: latest.state,
  })
  if (!merged.ok) {
    const inputs = { originalState, submittedState, currentServerState: latest.state }
    return { conflicts: merged.conflicts, inputs, etag: latest.etag }
  }

  const retry = await save(merged.value, latest.etag)
  return retry.ok ? { saved: retry.state } : { error: retry.error }
}

// --- Scenario -----------------------------------------------------------------

try {
  // User A starts editing.
  const { state: originalState, etag } = await load()

  // Meanwhile, user B changes the customer's phone.
  const other = await load()
  await save({ ...other.state, customer: { ...other.state.customer, phone: "222" } }, other.etag)

  // User A saves a different field with the stale ETag: it merges and retries.
  const clean = await saveWithRecovery(originalState, { ...originalState, notes: "Leave at the door" }, etag)
  assert.deepEqual(clean.saved, {
    customer: { name: "Mona", phone: "222" },
    notes: "Leave at the door",
    status: "pending",
  })
  console.log("independent edits merged and saved:", clean.saved)

  // User A (still on the stale copy) now changes the phone too: a true conflict.
  const conflicting = await saveWithRecovery(
    originalState,
    { ...originalState, customer: { ...originalState.customer, phone: "333" } },
    etag,
  )
  assert.deepEqual(conflicting.conflicts, [
    {
      path: ["customer", "phone"],
      submitted: { exists: true, value: "333" },
      currentServer: { exists: true, value: "222" },
    },
  ])
  console.log("competing edit needs a decision:", conflicting.conflicts)

  // User A decides to keep their own phone. Everything else still merges.
  const resolved = chooseSides(conflicting.inputs, conflicting.conflicts, ["submitted"])
  assert.equal(resolved.ok, true)
  const final = await save(resolved.value, conflicting.etag)
  assert.deepEqual(final.state, {
    customer: { name: "Mona", phone: "333" },
    notes: "Leave at the door",
    status: "pending",
  })
  console.log("resolved and saved:", final.state)
} finally {
  server.close()
}
