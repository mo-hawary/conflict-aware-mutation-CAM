import assert from "node:assert/strict"
import test from "node:test"

import { ANY, CAMConfigError, applyConflictDecisions, mergeStates } from "../dist/index.js"

const keyed = { arrays: { rules: [{ path: ["items"], mode: "keyed", key: "id" }] } }

function states(original, submitted, currentServer) {
  return { originalState: original, submittedState: submitted, currentServerState: currentServer }
}

function resolveAll(input, choice) {
  const first = mergeStates(input)
  return applyConflictDecisions({
    ...input,
    sessionId: "s",
    decisions: first.conflicts.map((conflict) => ({ sessionId: "s", conflict, choice })),
  })
}

// ---------------------------------------------------------------------------
// Who broke the rule
// ---------------------------------------------------------------------------

test("a rule broken by the submitted state is reported against it", () => {
  const result = mergeStates({
    ...states({ discount: 0.1 }, { discount: 0.5 }, { discount: 0.1 }),
    rules: [{ id: "cap", path: ["discount"], max: 0.3 }],
  })
  assert.deepEqual(result, {
    ok: false,
    kind: "invalid",
    violations: [{ ruleId: "cap", side: "submitted", message: "/discount must be at most 0.3" }],
    conflicts: [],
  })
})

test("a rule broken by the server state is reported against the server", () => {
  const result = mergeStates({
    ...states({ discount: 0.1, a: 1 }, { discount: 0.1, a: 2 }, { discount: 0.9, a: 1 }),
    rules: [{ id: "cap", path: ["discount"], max: 0.3, message: "Discount too high" }],
    includeReport: true,
  })
  assert.equal(result.kind, "invalid")
  assert.deepEqual(result.violations, [{ ruleId: "cap", side: "currentServer", message: "Discount too high" }])
  assert.ok(Array.isArray(result.report.changes))
})

test("pre-existing violations nobody touched are ignored", () => {
  const result = mergeStates({
    ...states({ discount: 0.9, title: "a" }, { discount: 0.9, title: "b" }, { discount: 0.9, title: "a" }),
    rules: [{ id: "cap", path: ["discount"], max: 0.3 }],
  })
  assert.deepEqual(result, { ok: true, value: { discount: 0.9, title: "b" }, conflicts: [] })
})

test("a side that edits a legacy-invalid value must make it valid", () => {
  const result = mergeStates({
    ...states({ discount: 0.9 }, { discount: 0.8 }, { discount: 0.9 }),
    rules: [{ id: "cap", path: ["discount"], max: 0.3 }],
  })
  assert.equal(result.kind, "invalid")
})

test("rule conflicts appear when valid inputs merge into an invalid result", () => {
  const input = {
    ...states({ price: 100, discount: 0.1 }, { price: 100, discount: 0.3 }, { price: 50, discount: 0.1 }),
    rules: [{
      id: "approval",
      paths: [["price"], ["discount"]],
      check: (state) => state.discount <= 0.2 || state.price >= 100 || "Large discounts need price >= 100",
    }],
  }
  const first = mergeStates(input)
  assert.deepEqual(first.conflicts, [{
    kind: "rule",
    ruleId: "approval",
    message: "Large discounts need price >= 100",
    paths: [["discount"], ["price"]],
    submitted: [
      { path: ["discount"], value: { exists: true, value: 0.3 } },
      { path: ["price"], value: { exists: true, value: 100 } },
    ],
    currentServer: [
      { path: ["discount"], value: { exists: true, value: 0.1 } },
      { path: ["price"], value: { exists: true, value: 50 } },
    ],
  }])
  assert.deepEqual(resolveAll(input, "submitted").value, { discount: 0.3, price: 100 })
  assert.deepEqual(resolveAll(input, "currentServer").value, { discount: 0.1, price: 50 })
})

test("rule decisions take a side's whole item, never a rebuilt one", () => {
  const input = {
    ...states(
      { defaultItemId: "a", items: [{ id: "a", on: true }, { id: "b", on: false }] },
      { defaultItemId: "b", items: [{ id: "a", on: true }, { id: "b", on: false }] },
      { defaultItemId: "a", items: [{ id: "a", on: true }] },
    ),
    ...keyed,
    rules: [{ id: "default-exists", path: ["defaultItemId"], oneOfPath: ["items", ANY, "id"] }],
  }
  const first = mergeStates(input)
  assert.equal(first.conflicts[0].message, "/defaultItemId must match a value at /items/*/id")
  assert.deepEqual(resolveAll(input, "submitted").value, input.submittedState)
  assert.deepEqual(resolveAll(input, "currentServer").value, input.currentServerState)
})

test("invalid results also list structural conflicts; rule conflicts wait for them", () => {
  const invalid = mergeStates({
    ...states({ a: 1, b: 0 }, { a: 2, b: 5 }, { a: 3, b: 0 }),
    rules: [{ id: "r", path: ["b"], max: 0 }],
  })
  assert.equal(invalid.kind, "invalid")
  assert.deepEqual(invalid.conflicts.map(({ path }) => path), [["a"]])
  const structural = mergeStates({
    ...states({ a: 1, b: 0, c: 0 }, { a: 2, b: 1, c: 0 }, { a: 3, b: 0, c: 1 }),
    rules: [{ id: "r", paths: [["b"], ["c"]], check: (state) => state.b + state.c < 2 || "b + c must stay below 2" }],
  })
  assert.equal(structural.kind, "conflict")
  assert.deepEqual(structural.conflicts.map((conflict) => "kind" in conflict), [false])
})

test("pre-existing missing values are not blamed on a side", () => {
  const result = mergeStates({ ...states({ a: 1 }, { a: 2 }, { a: 1 }), rules: [{ id: "r", path: ["a", "t"], required: true }] })
  assert.deepEqual(result.value, { a: 2 })
  const removed = mergeStates({ ...states({ a: { t: 1 } }, { a: 1 }, { a: { t: 1 } }), rules: [{ id: "r", path: ["a", "t"], required: true }] })
  assert.deepEqual(removed.violations, [{ ruleId: "r", side: "submitted", message: "/a/t is required" }])
})

test("a rule decision that cannot satisfy the rule leaves the conflict open", () => {
  const input = {
    ...states({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }),
    rules: [{ id: "not-both", paths: [["a"]], check: (state) => !(state.a === 2 && state.b === 2) || "a and b cannot both be 2" }],
  }
  const first = mergeStates(input)
  assert.equal(first.conflicts[0].kind, "rule")
  const again = resolveAll(input, "submitted")
  assert.equal(again.ok, false)
  assert.equal(again.conflicts[0].kind, "rule")
})

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

function check(rule, state) {
  const result = mergeStates({ ...states({}, state, {}), rules: [{ id: "r", ...rule }] })
  return result.kind === "invalid" ? result.violations[0].message : "ok"
}

test("built-in presence and value rules", () => {
  assert.equal(check({ path: ["t"], required: true }, { t: "x" }), "ok")
  assert.equal(check({ path: ["t"], required: true }, { t: "" }), "/t is required")
  assert.equal(check({ path: ["t"], required: true }, { t: null }), "/t is required")
  assert.equal(check({ path: ["n"], min: 1, max: 3 }, { n: 0 }), "/n must be at least 1")
  assert.equal(check({ path: ["n"], min: 1 }, { n: "2" }), "/n must be a number")
  assert.equal(check({ path: ["n"], max: 3 }, { n: null }), "ok")
  assert.equal(check({ path: ["s"], minLength: 2 }, { s: "é" }), "/s must have at least 2 items or characters")
  assert.equal(check({ path: ["s"], maxLength: 1 }, { s: [1, 2] }), "/s must have at most 1 items or characters")
  assert.equal(check({ path: ["s"], maxLength: 1 }, { s: 5 }), "/s must be a string or an array")
  assert.equal(check({ path: ["s"], pattern: "^[a-z]+$" }, { s: "abc" }), "ok")
  assert.equal(check({ path: ["s"], pattern: "^[a-z]+$" }, { s: "A" }), "/s must match ^[a-z]+$")
  assert.equal(check({ path: ["s"], oneOf: ["a", { b: 1 }] }, { s: { b: 1 } }), "ok")
  assert.equal(check({ path: ["s"], oneOf: ["a"] }, { s: "b" }), "/s is not an allowed value")
})

test("built-in cross-item and cross-field rules", () => {
  assert.equal(check({ path: ["l", ANY, "id"], unique: true }, { l: [{ id: 1 }, { id: 1 }] }), "/l/1/id must be unique")
  assert.equal(check({ path: ["l", ANY, "d"], exactlyOne: true }, { l: [{ d: true }, { d: true }] }), "/l/0 must have exactly one true value (found 2)")
  assert.equal(check({ path: ["l", ANY, "d"], exactlyOne: true }, { l: [] }), "ok")
  assert.equal(check({ path: ["l", ANY, "c"], allEqual: true }, { l: [{ c: "a" }, { c: "b" }] }), "/l/1/c must equal the other matched values")
  assert.equal(check({ path: ["l", ANY, "c"], allEqual: true }, { l: [{ c: "a" }, { c: "a" }] }), "ok")
  assert.equal(check({ path: ["t"], sumOf: ["l", ANY, "v"] }, { t: 3, l: [{ v: 1 }, { v: 2 }] }), "ok")
  assert.equal(check({ path: ["t"], sumOf: ["l", ANY, "v"] }, { t: 4, l: [{ v: 1 }, { v: 2 }] }), "/t must equal the sum 3")
  assert.equal(check({ path: ["t"], sumOf: ["l", ANY, "v"] }, { t: 0.3, l: [{ v: 0.1 }, { v: 0.2 }] }), "ok")
  assert.equal(check({ path: ["t"], sumOf: ["l", ANY, "v"] }, { t: 1, l: [{ v: "1" }] }), "/l/0/v must be a number (summed)")
  assert.equal(check({ path: ["a"], requiredWith: ["b"] }, { a: 1 }), "/a requires a value at /b")
  assert.equal(check({ path: ["a"], requiredWith: ["b"] }, { a: 1, b: 0 }), "ok")
  assert.equal(check({ path: ["o", ANY], max: 1 }, { o: { x: 1, y: 2 } }), "/o/y must be at most 1")
})

test("rule configuration is validated", () => {
  const run = (rules) => () => mergeStates({ ...states({}, {}, {}), rules })
  assert.throws(run({}), /rules must be an array/)
  assert.throws(run([1]), /rules\[0\] must be an object/)
  assert.throws(run([{ path: ["a"], max: 1 }]), /id must be a non-empty string/)
  assert.throws(run([{ id: "a", path: ["a"], max: 1 }, { id: "a", path: ["b"], max: 1 }]), /duplicate rule id/)
  assert.throws(run([{ id: "a", path: ["a"] }]), /at least one constraint/)
  assert.throws(run([{ id: "a", path: ["a"], max: 1, extra: 1 }]), /unknown property "extra"/)
  assert.throws(run([{ id: "a", path: ["a"], required: false }]), /required must be true/)
  assert.throws(run([{ id: "a", path: ["a"], max: "1" }]), /max must be a finite number/)
  assert.throws(run([{ id: "a", path: ["a"], minLength: 1.5 }]), /non-negative integer/)
  assert.throws(run([{ id: "a", path: ["a"], pattern: 1 }]), /pattern must be a string/)
  assert.throws(run([{ id: "a", path: ["a"], pattern: "(" }]), /not a valid regular expression/)
  assert.throws(run([{ id: "a", path: ["a"], oneOf: "x" }]), /oneOf must be an array/)
  assert.throws(run([{ id: "a", path: ["a"], max: 1, message: "" }]), /message must be a non-empty string/)
  assert.throws(run([{ id: "a", path: [], max: 1 }]), /non-empty path/)
  assert.throws(run([{ id: "a", paths: [["a"]], check: 1 }]), /check must be a function/)
  assert.throws(run([{ id: "a", paths: [], check: () => true }]), /non-empty array of paths/)
  assert.throws(run([{ id: "a", paths: [["a"]], check: () => true, max: 1 }]), /unknown property "max"/)
  const accessor = { id: "a", paths: [["a"]] }
  Object.defineProperty(accessor, "check", { get: () => () => true, enumerable: true })
  assert.throws(run([accessor]), /must not be an accessor/)
})

test("custom checks must return true or a message, and their errors are wrapped", () => {
  const run = (check) => () => mergeStates({ ...states({ a: 1 }, { a: 2 }, { a: 1 }), rules: [{ id: "c", paths: [["a"]], check }] })
  assert.throws(run(() => false), /must return true or a non-empty message/)
  assert.throws(run(() => ""), /must return true or a non-empty message/)
  const cause = new Error("boom")
  assert.throws(run(() => { throw cause }), (error) => error instanceof CAMConfigError && error.cause === cause)
})

test("custom checks receive a private copy of the state", () => {
  let seen
  const result = mergeStates({
    ...states({ a: 1 }, { a: 2 }, { a: 1 }),
    rules: [{ id: "c", paths: [["a"]], check: (state) => { seen = state; state.a = 99; return true } }],
  })
  assert.deepEqual(result.value, { a: 2 })
  assert.equal(seen.a, 99)
})

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

test("derived paths never conflict and take the server value", () => {
  const result = mergeStates({
    ...states(
      { items: [{ id: "a", q: 1, t: 10 }], total: 10 },
      { items: [{ id: "a", q: 2, t: 20 }], total: 20 },
      { items: [{ id: "a", q: 1, t: 10 }, { id: "b", q: 1, t: 5 }], total: 15 },
    ),
    ...keyed,
    derived: [["total"], ["items", ANY, "t"]],
  })
  assert.deepEqual(result, {
    ok: true,
    value: { items: [{ id: "a", q: 2, t: 10 }, { id: "b", q: 1, t: 5 }], total: 15 },
    conflicts: [],
  })
})

test("derived values fall back to the submitted value for new items", () => {
  const result = mergeStates({
    ...states({ items: [], total: 0 }, { items: [{ id: "n", t: 7 }], total: 7 }, { items: [], total: 0 }),
    ...keyed,
    derived: [["items", ANY, "t"]],
  })
  assert.deepEqual(result.value, { items: [{ id: "n", t: 7 }], total: 7 })
})

test("derived paths inside sequence arrays and objects", () => {
  const result = mergeStates({
    ...states(
      { rows: [{ v: 1, d: 1 }], meta: { d: 1, x: 1 } },
      { rows: [{ v: 2, d: 2 }], meta: { d: 2, x: 1 } },
      { rows: [{ v: 1, d: 5 }], meta: { d: 3, x: 2 } },
    ),
    arrays: { default: "sequence" },
    derived: [["rows", ANY, "d"], ["meta", "d"], ["rows", 0, "d"], ["missing", "d"]],
  })
  assert.deepEqual(result.value, { meta: { d: 3, x: 2 }, rows: [{ d: 5, v: 2 }] })
})

test("rules over derived values are checked on inputs only", () => {
  const result = mergeStates({
    ...states({ total: 1, q: 1 }, { total: 2, q: 2 }, { total: 1, q: 1 }),
    derived: [["total"]],
    rules: [{ id: "total-matches", path: ["total"], sumOf: ["q"] }],
  })
  assert.deepEqual(result.value, { q: 2, total: 1 })
})

test("derived configuration is validated", () => {
  const run = (derived) => () => mergeStates({ ...states({}, {}, {}), derived })
  assert.throws(run({}), /derived must be an array/)
  assert.throws(run([["a", ANY]]), /must end with a property name/)
  assert.throws(run([[]]), /non-empty path/)
})

// ---------------------------------------------------------------------------
// review-mixed
// ---------------------------------------------------------------------------

test("review-mixed flags results that combine both sides' changes", () => {
  const result = mergeStates({ ...states({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }), autoMerge: "review-mixed" })
  assert.equal(result.ok, false)
  assert.equal(result.kind, "review")
  assert.deepEqual(result.value, { a: 2, b: 2 })
  assert.deepEqual(result.report.changes.map(({ provenance }) => provenance), ["submitted-only", "server-only"])
})

test("review-mixed accepts one-sided and identical results", () => {
  assert.equal(mergeStates({ ...states({ a: 1 }, { a: 2 }, { a: 1 }), autoMerge: "review-mixed" }).ok, true)
  assert.equal(mergeStates({ ...states({ a: 1 }, { a: 2 }, { a: 2 }), autoMerge: "review-mixed" }).ok, true)
  assert.equal(mergeStates({ ...states({ a: 1 }, { a: 1 }, { a: 1 }), autoMerge: "disjoint" }).ok, true)
  assert.throws(() => mergeStates({ ...states({}, {}, {}), autoMerge: "always" }), /autoMerge must be/)
})

test("review-mixed treats combined set merges and decided conflicts as mixed", () => {
  const combined = mergeStates({
    ...states({ t: [1] }, { t: [1, 2] }, { t: [1, 3] }),
    arrays: { rules: [{ path: ["t"], mode: "set" }] },
    autoMerge: "review-mixed",
  })
  assert.equal(combined.kind, "review")
  const input = { ...states({ a: 1, b: 1 }, { a: 2, b: 2 }, { a: 3, b: 1 }), autoMerge: "review-mixed" }
  const decided = resolveAll(input, "currentServer")
  assert.equal(decided.kind, "review")
  assert.throws(
    () => applyConflictDecisions({ ...states({ a: 1 }, { a: 2 }, { a: 3 }), autoMerge: "review-mixed", sessionId: "s", decisions: [] }),
    /exactly one choice/,
  )
  assert.throws(
    () => applyConflictDecisions({ ...states({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }), autoMerge: "review-mixed", sessionId: "s", decisions: [{ sessionId: "s", conflict: { path: ["a"], submitted: { exists: false }, currentServer: { exists: false } }, choice: "submitted" }] }),
    /stale/,
  )
})

test("staged resolution: accumulated decisions replay structural and then rule rounds", () => {
  const input = {
    ...states({ note: 0, x: 0, y: 0 }, { note: 1, x: 1, y: 0 }, { note: 2, x: 0, y: 1 }),
    rules: [{ id: "sum", paths: [["x"], ["y"]], check: (state) => state.x + state.y <= 1 || "x + y must be <= 1" }],
  }
  const decide = (conflicts, choice) => conflicts.map((conflict) => ({ sessionId: "s", conflict, choice }))
  const first = mergeStates(input)
  assert.deepEqual(first.conflicts.map(({ path }) => path), [["note"]])
  const noteDecisions = decide(first.conflicts, "submitted")

  const second = applyConflictDecisions({ ...input, sessionId: "s", decisions: noteDecisions })
  assert.equal(second.kind, "conflict")
  assert.equal(second.conflicts[0].kind, "rule")
  const ruleDecisions = decide(second.conflicts, "currentServer")

  const done = applyConflictDecisions({ ...input, sessionId: "s", decisions: [...noteDecisions, ...ruleDecisions] })
  assert.deepEqual(done, { ok: true, value: { note: 1, x: 0, y: 1 }, conflicts: [] })
  // Order of accumulated decisions does not matter.
  assert.deepEqual(applyConflictDecisions({ ...input, sessionId: "s", decisions: [...ruleDecisions, ...noteDecisions] }), done)

  // A later round's decision alone is stale for the first round.
  assert.throws(() => applyConflictDecisions({ ...input, sessionId: "s", decisions: ruleDecisions }), /stale/)
  // A decision that matches no round is rejected, even alongside valid ones.
  const bogus = decide([{ path: ["x"], submitted: { exists: true, value: 9 }, currentServer: { exists: true, value: 0 } }], "submitted")
  assert.throws(() => applyConflictDecisions({ ...input, sessionId: "s", decisions: [...noteDecisions, ...ruleDecisions, ...bogus] }), /stale/)
  // Decisions stay bound to their session.
  assert.throws(
    () => applyConflictDecisions({ ...input, sessionId: "other", decisions: [...noteDecisions, ...ruleDecisions] }),
    /sessionId does not match/,
  )
  // Changed snapshots invalidate earlier rounds' decisions.
  assert.throws(
    () => applyConflictDecisions({ ...input, submittedState: { note: 3, x: 1, y: 0 }, sessionId: "s", decisions: [...noteDecisions, ...ruleDecisions] }),
    /stale/,
  )
})

test("rules on an ancestor of a derived path still check the merged result", () => {
  const result = mergeStates({
    ...states(
      { discount: 0, lines: [{ id: "a", t: 1 }, { id: "b", t: 1 }, { id: "c", t: 1 }] },
      { discount: 0.2, lines: [{ id: "a", t: 1 }, { id: "b", t: 1 }, { id: "c", t: 1 }] },
      { discount: 0, lines: [{ id: "a", t: 1 }, { id: "b", t: 1 }] },
    ),
    arrays: { rules: [{ path: ["lines"], mode: "keyed", key: "id" }] },
    derived: [["lines", ANY, "t"]],
    rules: [{ id: "d", paths: [["discount"], ["lines"]], check: (s) => s.discount <= 0.1 || s.lines.length >= 3 || "needs 3 lines" }],
  })
  assert.equal(result.kind, "conflict")
  assert.equal(result.conflicts[0].kind, "rule")
})
