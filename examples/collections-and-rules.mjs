// Array merging, linked fields, derived values, rules, review, and staged
// decisions on one order record. Run with `npm run examples`.
import assert from "node:assert/strict"

import { ANY, EACH, applyConflictDecisions, formatConflictPath, mergeStates } from "conflict-aware-mutation"

// One merge policy for this record type, reused on every stale write.
const policy = {
  arrays: {
    rules: [
      { path: ["lines"], mode: "keyed", key: "sku" }, // records with identity
      { path: ["tags"], mode: "set" }, // unique labels
      { path: ["steps"], mode: "sequence" }, // ordered list without identity
    ],
  },
  // Price and currency are one decision per line.
  groups: [{ id: "line-price", paths: [["lines", EACH, "price"], ["lines", EACH, "currency"]] }],
  // Computed by the application; never merged, always recomputed.
  derived: [["total"], ["lines", ANY, "lineTotal"]],
  rules: [
    { id: "qty", path: ["lines", ANY, "qty"], min: 1, max: 100 },
    { id: "one-currency", path: ["lines", ANY, "currency"], allEqual: true },
    {
      id: "discount",
      paths: [["discount"], ["lines"]],
      check: (order) =>
        order.discount <= 0.1 || order.lines.length >= 3 || "Discounts above 10% need at least 3 lines",
    },
  ],
}

const recompute = (order) => {
  const lines = order.lines.map((line) => ({ ...line, lineTotal: line.qty * line.price }))
  return { ...order, lines, total: lines.reduce((sum, line) => sum + line.lineTotal, 0) }
}

const originalState = recompute({
  discount: 0,
  lines: [
    { sku: "mug", qty: 1, price: 10, currency: "EUR" },
    { sku: "tee", qty: 1, price: 20, currency: "EUR" },
  ],
  steps: ["pack", "label", "ship"],
  tags: ["new"],
})

// 1. Independent edits inside arrays merge.
{
  const submittedState = recompute({
    ...originalState,
    lines: [originalState.lines[0], { ...originalState.lines[1], qty: 2 }],
    steps: ["pack", "gift-wrap", "label", "ship"],
    tags: ["new", "gift"],
  })
  const currentServerState = recompute({
    ...originalState,
    lines: [{ ...originalState.lines[0], price: 12 }, originalState.lines[1], { sku: "cap", qty: 1, price: 15, currency: "EUR" }],
    steps: ["pack", "label", "ship", "notify"],
    tags: ["new", "sale"],
  })
  const result = mergeStates({ originalState, submittedState, currentServerState, ...policy })
  assert.equal(result.ok, true)
  const order = recompute(result.value)
  assert.deepEqual(order.lines.map(({ sku, qty, price }) => [sku, qty, price]), [
    ["mug", 1, 12],
    ["tee", 2, 20],
    ["cap", 1, 15],
  ])
  assert.deepEqual(order.steps, ["pack", "gift-wrap", "label", "ship", "notify"])
  assert.deepEqual(order.tags, ["new", "sale", "gift"])
  assert.equal(order.total, 12 + 40 + 15)
}

// 2. Linked fields: one decision per line, never a mixed price/currency.
{
  const submittedState = recompute({
    ...originalState,
    lines: [{ ...originalState.lines[0], price: 11 }, originalState.lines[1]],
  })
  const currentServerState = recompute({
    ...originalState,
    lines: [{ ...originalState.lines[0], currency: "USD" }, { ...originalState.lines[1], currency: "USD" }],
  })
  const result = mergeStates({ originalState, submittedState, currentServerState, ...policy })
  assert.equal(result.kind, "conflict")
  const [conflict] = result.conflicts
  assert.equal(conflict.kind, "group")
  assert.deepEqual(conflict.binding, { key: "sku", value: "mug" })
  assert.equal(formatConflictPath(conflict.paths[0]), "/lines/[sku=mug]/currency")
}

// 3. Rules: blame an invalid input, and catch a valid-plus-valid merge.
{
  const invalid = mergeStates({
    originalState,
    submittedState: recompute({ ...originalState, lines: [{ ...originalState.lines[0], qty: 0 }, originalState.lines[1]] }),
    currentServerState: originalState,
    ...policy,
  })
  assert.equal(invalid.kind, "invalid")
  assert.deepEqual(invalid.violations.map(({ ruleId, side }) => [ruleId, side]), [["qty", "submitted"]])

  // Submitted adds a 20% discount (fine with three lines); the server removes a line.
  const withThree = recompute({ ...originalState, lines: [...originalState.lines, { sku: "cap", qty: 1, price: 15, currency: "EUR" }] })
  const input = {
    originalState: withThree,
    submittedState: { ...withThree, discount: 0.2 },
    currentServerState: recompute({ ...withThree, lines: withThree.lines.slice(0, 2) }),
    ...policy,
  }
  const merged = mergeStates(input)
  assert.equal(merged.kind, "conflict")
  assert.equal(merged.conflicts[0].kind, "rule")
  assert.equal(merged.conflicts[0].message, "Discounts above 10% need at least 3 lines")

  const decided = applyConflictDecisions({
    ...input,
    sessionId: "edit-1",
    decisions: [{ sessionId: "edit-1", conflict: merged.conflicts[0], choice: "currentServer" }],
  })
  assert.equal(decided.ok, true)
  assert.equal(decided.value.discount, 0)
}

// 4. Staged decisions: rule conflicts appear after structural ones are resolved.
{
  const input = {
    originalState: { note: "", x: 0, y: 0 },
    submittedState: { note: "mine", x: 1, y: 0 },
    currentServerState: { note: "theirs", x: 0, y: 1 },
    rules: [{ id: "budget", paths: [["x"], ["y"]], check: (s) => s.x + s.y <= 1 || "x + y must stay within 1" }],
  }
  const decisions = []
  let result = mergeStates(input)
  while (result.kind === "conflict") {
    for (const conflict of result.conflicts) {
      decisions.push({ sessionId: "edit-2", conflict, choice: "submitted" })
    }
    // Pass every decision so far; CAM replays them round by round.
    result = applyConflictDecisions({ ...input, sessionId: "edit-2", decisions })
  }
  assert.deepEqual(result, { ok: true, value: { note: "mine", x: 1, y: 0 }, conflicts: [] })
}

// 5. review-mixed: a result that combines both sides needs a person to confirm it.
{
  const result = mergeStates({
    originalState,
    submittedState: { ...originalState, tags: ["new", "gift"] },
    currentServerState: { ...originalState, steps: ["pack", "ship"] },
    ...policy,
    autoMerge: "review-mixed",
  })
  assert.equal(result.kind, "review")
  assert.deepEqual(
    result.report.changes.map(({ provenance }) => provenance).sort(),
    ["server-only", "submitted-only"],
  )
}

console.log("collections-and-rules example passed")
