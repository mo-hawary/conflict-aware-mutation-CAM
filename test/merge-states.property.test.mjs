import assert from "node:assert/strict"
import test from "node:test"

import fc from "fast-check"

import { CAMConfigError, matchConflictError, mergeStates } from "../dist/index.js"

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// A tiny key/value domain makes equal values on different sides common, which
// is what exercises the interesting branches of the three-way truth table.
// Integer-like keys are excluded here because JS always enumerates them first;
// their ordering is covered by a dedicated unit test.
const key = fc.constantFrom("a", "b", "c", "", "x.y", "[0]", "__proto__")
const primitive = fc.constantFrom(null, true, false, 0, 1, "", "s")

// fast-check builds objects holding a `__proto__` key with a null prototype.
// Rebuild them as ordinary objects so strict deep-equality compares data only.
function plain(value) {
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value !== "object" || value === null) return value
  const result = {}
  for (const k of Object.keys(value)) define(result, k, plain(value[k]))
  return result
}

const { tree: rawTree } = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    primitive,
    fc.array(tie("tree"), { maxLength: 3 }),
    fc.dictionary(key, tie("tree"), { maxKeys: 4 }),
  ),
}))
const tree = rawTree.map(plain)

const DELETE = Symbol("delete")

// Derives a variant of `value`: keep it, replace it, or edit object children.
function variant(value) {
  const options = [fc.constant(value), tree]
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value)
    options.push(
      fc
        .tuple(
          fc.tuple(...keys.map((k) => fc.oneof(variant(value[k]), fc.constant(DELETE)))),
          fc.dictionary(key, tree, { maxKeys: 2 }),
        )
        .map(([children, added]) => {
          const result = {}
          keys.forEach((k, index) => {
            if (children[index] !== DELETE) define(result, k, children[index])
          })
          for (const k of Object.keys(added)) {
            if (!Object.hasOwn(result, k)) define(result, k, added[k])
          }
          return result
        }),
    )
  }
  return fc.oneof(...options)
}

const triple = tree.chain((original) =>
  fc.tuple(fc.constant(original), variant(original), variant(original)),
)

// ---------------------------------------------------------------------------
// Reference oracle: a direct, unoptimized transcription of the contract.
// ---------------------------------------------------------------------------

const MISSING = Symbol("missing")

function define(target, k, value) {
  Object.defineProperty(target, k, { value, enumerable: true, writable: true, configurable: true })
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

function equal(left, right) {
  if (left === MISSING || right === MISSING) return left === right
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function canonical(value) {
  if (Array.isArray(value)) return { array: value.map(canonical) }
  if (!isObject(value)) return value
  return {
    object: Object.keys(value)
      .sort()
      .map((k) => [k, canonical(value[k])]),
  }
}

const get = (object, k) => (Object.hasOwn(object, k) ? object[k] : MISSING)
const wrap = (value) => (value === MISSING ? { exists: false } : { exists: true, value })

function oracleNode(o, s, c, path, conflicts) {
  if (equal(s, o)) return c
  if (equal(c, o)) return s
  if (equal(s, c)) return s
  if (isObject(o) && isObject(s) && isObject(c)) {
    const keys = [...new Set([...Object.keys(o), ...Object.keys(s), ...Object.keys(c)])].sort()
    const merged = {}
    for (const k of keys) {
      const child = oracleNode(get(o, k), get(s, k), get(c, k), [...path, k], conflicts)
      if (child !== MISSING) define(merged, k, child)
    }
    return merged
  }
  conflicts.push({ path, submitted: wrap(s), currentServer: wrap(c) })
  return MISSING
}

function oracle(o, s, c) {
  const conflicts = []
  const value = oracleNode(o, s, c, [], conflicts)
  return conflicts.length > 0
    ? { ok: false, kind: "conflict", conflicts }
    : { ok: true, value, conflicts: [] }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const merge = (o, s, c) =>
  mergeStates({ originalState: o, submittedState: s, currentServerState: c })

function collectObjects(value, into = new Set()) {
  if (typeof value === "object" && value !== null) {
    into.add(value)
    for (const child of Object.values(value)) collectObjects(child, into)
  }
  return into
}

function assertKeysSorted(value) {
  if (typeof value !== "object" || value === null) return
  if (!Array.isArray(value)) {
    const keys = Object.keys(value)
    assert.deepEqual(keys, [...keys].sort())
  }
  for (const child of Object.values(value)) assertKeysSorted(child)
}

function comparePaths(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = String(left[index])
    const b = String(right[index])
    if (a !== b) return a < b ? -1 : 1
  }
  return left.length - right.length
}

function lookup(root, path) {
  let current = root
  for (const segment of path) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return { exists: false }
    current = current[segment]
  }
  return { exists: true, value: current }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test("property: matches the reference oracle", () => {
  fc.assert(
    fc.property(triple, ([o, s, c]) => {
      assert.deepStrictEqual(merge(o, s, c), oracle(o, s, c))
    }),
    { numRuns: 2_000 },
  )
})

test("property: identity laws", () => {
  fc.assert(
    fc.property(tree, tree, (o, x) => {
      assert.deepStrictEqual(merge(o, o, o), { ok: true, value: o, conflicts: [] })
      assert.deepStrictEqual(merge(o, x, o), { ok: true, value: x, conflicts: [] })
      assert.deepStrictEqual(merge(o, o, x), { ok: true, value: x, conflicts: [] })
      assert.deepStrictEqual(merge(o, x, x), { ok: true, value: x, conflicts: [] })
    }),
  )
})

test("property: swapping submitted and currentServer swaps conflict sides only", () => {
  fc.assert(
    fc.property(triple, ([o, s, c]) => {
      const forward = merge(o, s, c)
      const backward = merge(o, c, s)

      assert.equal(forward.ok, backward.ok)
      if (forward.ok) {
        assert.deepStrictEqual(forward.value, backward.value)
      } else {
        assert.deepStrictEqual(
          forward.conflicts,
          backward.conflicts.map(({ path, submitted, currentServer }) => ({
            path,
            submitted: currentServer,
            currentServer: submitted,
          })),
        )
      }
    }),
    { numRuns: 1_000 },
  )
})

test("property: never mutates or aliases inputs", () => {
  fc.assert(
    fc.property(triple, ([o, s, c]) => {
      const before = plain([o, s, c])
      const result = merge(o, s, c)
      assert.deepStrictEqual([o, s, c], before)

      const inputObjects = collectObjects([o, s, c])
      for (const object of collectObjects(result)) {
        assert.equal(inputObjects.has(object), false)
      }
    }),
    { numRuns: 1_000 },
  )
})

test("property: output keys and conflict paths are sorted and consistent", () => {
  fc.assert(
    fc.property(triple, ([o, s, c]) => {
      const result = merge(o, s, c)
      if (result.ok) {
        assertKeysSorted(result.value)
        return
      }

      for (let index = 1; index < result.conflicts.length; index += 1) {
        const previous = result.conflicts[index - 1].path
        const current = result.conflicts[index].path
        assert.ok(comparePaths(previous, current) < 0, "conflicts must be strictly ordered")
        assert.ok(
          previous.length > current.length ||
            previous.some((segment, i) => segment !== current[i]),
          "no conflict may be nested inside another",
        )
      }

      for (const conflict of result.conflicts) {
        assert.deepStrictEqual(conflict.submitted, lookup(s, conflict.path))
        assert.deepStrictEqual(conflict.currentServer, lookup(c, conflict.path))
      }
    }),
    { numRuns: 1_000 },
  )
})

test("property: validated output equals a JSON round-trip of the input", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const result = merge(value, value, value)
      assert.deepStrictEqual(result.value, JSON.parse(JSON.stringify(value)))
    }),
  )
})

// ---------------------------------------------------------------------------
// Fuzz: arbitrary (mostly invalid) inputs may only succeed or throw CAMConfigError.
// ---------------------------------------------------------------------------

const anything = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withSparseArray: true,
  withTypedArray: true,
  withObjectString: true,
})

const onlyConfigErrors = (run) => {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof CAMConfigError, `unexpected ${error?.constructor?.name}: ${error}`)
  }
}

test("fuzz: mergeStates only ever throws CAMConfigError", () => {
  fc.assert(
    fc.property(anything, anything, anything, (o, s, c) => {
      onlyConfigErrors(() => merge(o, s, c))
    }),
    { numRuns: 2_000 },
  )
})

test("fuzz: matchConflictError only ever throws CAMConfigError", () => {
  const signal = fc.oneof(
    anything,
    fc.record(
      { code: fc.oneof(fc.string(), fc.double(), anything), text: fc.oneof(fc.string(), anything) },
      { requiredKeys: [] },
    ),
  )

  fc.assert(
    fc.property(signal, signal, fc.oneof(fc.constant("backend"), fc.record({ text: fc.string() }), anything), (error, expectedError, errorOutput) => {
      onlyConfigErrors(() => matchConflictError({ error, expectedError, errorOutput }))
    }),
    { numRuns: 2_000 },
  )
})
