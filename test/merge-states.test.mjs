import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { CAMConfigError, mergeStates } from "../dist/index.js"

test("rejects null and undefined merge arguments with CAMConfigError", () => {
  for (const input of [null, undefined]) {
    assert.throws(() => mergeStates(input), CAMConfigError)
  }
})

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

const nest = (depth) => {
  const root = {}
  let current = root
  for (let level = 1; level < depth; level += 1) {
    current.child = {}
    current = current.child
  }
  return root
}

const nestAtDepth = (kind, depth, leaf) => {
  let value = leaf
  for (let index = 0; index < depth; index += 1) {
    value = kind === "object" ? { child: value } : [value]
  }
  return value
}

test("treats -0 and 0 as equal", () => {
  assert.deepEqual(
    mergeStates({
      originalState: { n: 0 },
      submittedState: { n: -0 },
      currentServerState: { n: 1 },
    }),
    { ok: true, value: { n: 1 }, conflicts: [] },
  )
})

test("sorts output keys on recursive and whole-value paths", () => {
  const recursed = mergeStates({
    originalState: { z: 1, a: 1 },
    submittedState: { z: 2, a: 1 },
    currentServerState: { z: 1, a: 2 },
  })
  const wholeValue = mergeStates({
    originalState: { z: 1, a: 1 },
    submittedState: { z: 1, a: 1 },
    currentServerState: { z: 1, a: 2, items: [{ y: 1, b: 1 }] },
  })

  assert.deepEqual(Object.keys(recursed.value), ["a", "z"])
  assert.deepEqual(Object.keys(wholeValue.value), ["a", "items", "z"])
  assert.deepEqual(Object.keys(wholeValue.value.items[0]), ["b", "y"])
})

test("rejects symbol-keyed properties", () => {
  assert.throws(
    () =>
      mergeStates({
        originalState: { a: 1 },
        submittedState: { a: 1, [Symbol("x")]: 1 },
        currentServerState: { a: 1 },
      }),
    CAMConfigError,
  )
})

test("rejects input deeper than the nesting limit with a short message", () => {
  const deep = nest(20_000)

  assert.throws(
    () => mergeStates({ originalState: deep, submittedState: deep, currentServerState: deep }),
    (error) => error instanceof CAMConfigError && error.message.length < 300,
  )
})

test("accepts input at the nesting limit", () => {
  const atLimit = nest(512)

  assert.equal(
    mergeStates({ originalState: atLimit, submittedState: atLimit, currentServerState: atLimit }).ok,
    true,
  )
})

test("counts depth from root for empty and scalar object and array leaves", () => {
  for (const [kind, leaf] of [
    ["object", {}],
    ["object", 0],
    ["array", []],
    ["array", 0],
  ]) {
    const atLimit = nestAtDepth(kind, 512, leaf)
    assert.equal(
      mergeStates({ originalState: atLimit, submittedState: atLimit, currentServerState: atLimit }).ok,
      true,
      `${kind} leaf at depth 512 should be accepted`,
    )

    const beyondLimit = nestAtDepth(kind, 513, leaf)
    assert.throws(
      () => mergeStates({ originalState: beyondLimit, submittedState: beyondLimit, currentServerState: beyondLimit }),
      CAMConfigError,
      `${kind} leaf at depth 513 should be rejected`,
    )
  }
})

test("rejects cyclic input", () => {
  const cyclic = { a: 1 }
  cyclic.self = cyclic

  assert.throws(
    () => mergeStates({ originalState: cyclic, submittedState: {}, currentServerState: {} }),
    CAMConfigError,
  )
})

test("allows shared non-cyclic references", () => {
  const shared = { city: "Cairo" }

  assert.equal(
    mergeStates({
      originalState: { billing: shared, shipping: shared },
      submittedState: { billing: shared, shipping: shared },
      currentServerState: { billing: shared, shipping: shared },
    }).ok,
    true,
  )
})

test("rejects undefined, NaN, and infinite values", () => {
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => mergeStates({ originalState: { a: 1 }, submittedState: { a: bad }, currentServerState: { a: 1 } }),
      CAMConfigError,
    )
  }

  assert.throws(
    () => mergeStates({ originalState: [1, , 3], submittedState: [], currentServerState: [] }),
    CAMConfigError,
  )
})

test("keeps keys containing dots and brackets as single path segments", () => {
  const result = mergeStates({
    originalState: { "a.b": 1, "x[0]": 1 },
    submittedState: { "a.b": 2, "x[0]": 2 },
    currentServerState: { "a.b": 3, "x[0]": 3 },
  })

  assert.deepEqual(
    result.conflicts.map((conflict) => conflict.path),
    [["a.b"], ["x[0]"]],
  )
})

test("copies a __proto__ key as an own property without polluting prototypes", () => {
  const submittedState = JSON.parse('{"__proto__":{"polluted":true},"a":1}')

  const result = mergeStates({
    originalState: { a: 1 },
    submittedState,
    currentServerState: { a: 1 },
  })

  assert.equal(result.ok, true)
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.ok(Object.prototype.hasOwnProperty.call(result.value, "__proto__"))
  assert.deepEqual(result.value.__proto__, { polluted: true })
  assert.equal({}.polluted, undefined)
})

test("creates valid output keys when Object.prototype is frozen", () => {
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href
  const source = `
    import { mergeStates } from ${JSON.stringify(moduleUrl)}
    Object.freeze(Object.prototype)
    const submittedState = JSON.parse('{"constructor":"ctor","toString":"stringifier","hasOwnProperty":"own"}')
    const result = mergeStates({ originalState: {}, submittedState, currentServerState: {} })
    if (!result.ok) throw new Error("expected a successful merge")
    if (Object.getPrototypeOf(result.value) !== Object.prototype) throw new Error("output prototype changed")
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      if (!Object.hasOwn(result.value, key)) throw new Error("missing own " + key)
    }
    if (JSON.stringify(result.value) !== '{"constructor":"ctor","hasOwnProperty":"own","toString":"stringifier"}') {
      throw new Error("valid keys changed during merge")
    }
    if ({}.polluted !== undefined) throw new Error("Object.prototype was polluted")
  `
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
  })

  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
})

test("merges additions of different keys on both sides", () => {
  assert.deepEqual(
    mergeStates({
      originalState: {},
      submittedState: { note: "a" },
      currentServerState: { tag: "b" },
    }),
    { ok: true, value: { note: "a", tag: "b" }, conflicts: [] },
  )
})

test("reports both sides adding the same key with different objects at the parent path", () => {
  assert.deepEqual(
    mergeStates({
      originalState: {},
      submittedState: { addr: { city: "Giza" } },
      currentServerState: { addr: { street: "Corniche" } },
    }).conflicts,
    [
      {
        path: ["addr"],
        submitted: { exists: true, value: { city: "Giza" } },
        currentServer: { exists: true, value: { street: "Corniche" } },
      },
    ],
  )
})

test("accepts the same deletion on both sides", () => {
  assert.deepEqual(
    mergeStates({
      originalState: { phone: "111", status: "pending" },
      submittedState: { status: "pending" },
      currentServerState: { status: "pending" },
    }),
    { ok: true, value: { status: "pending" }, conflicts: [] },
  )
})

test("applies a server-only deletion", () => {
  assert.deepEqual(
    mergeStates({
      originalState: { phone: "111", status: "pending" },
      submittedState: { phone: "111", status: "paid" },
      currentServerState: { status: "pending" },
    }),
    { ok: true, value: { status: "paid" }, conflicts: [] },
  )
})

test("reports conflicting type changes atomically", () => {
  assert.deepEqual(
    mergeStates({
      originalState: { value: { a: 1 } },
      submittedState: { value: "scalar" },
      currentServerState: { value: [1] },
    }).conflicts,
    [
      {
        path: ["value"],
        submitted: { exists: true, value: "scalar" },
        currentServer: { exists: true, value: [1] },
      },
    ],
  )
})

test("reports root-level scalar and array conflicts at the empty path", () => {
  for (const [originalState, submittedState, currentServerState] of [
    [1, 2, 3],
    [[1], [2], [3]],
  ]) {
    assert.deepEqual(
      mergeStates({ originalState, submittedState, currentServerState }).conflicts,
      [
        {
          path: [],
          submitted: { exists: true, value: submittedState },
          currentServer: { exists: true, value: currentServerState },
        },
      ],
    )
  }
})

test("accepts identical array changes on both sides", () => {
  assert.deepEqual(
    mergeStates({
      originalState: { items: [1] },
      submittedState: { items: [1, 2] },
      currentServerState: { items: [1, 2] },
    }),
    { ok: true, value: { items: [1, 2] }, conflicts: [] },
  )
})

test("rejects accessor properties without invoking them", () => {
  let reads = 0
  const withGetter = { a: 0 }
  Object.defineProperty(withGetter, "b", {
    enumerable: true,
    get: () => {
      reads += 1
      return 1
    },
  })

  assert.throws(
    () => mergeStates({ originalState: { a: 0 }, submittedState: withGetter, currentServerState: { a: 0 } }),
    (error) => error instanceof CAMConfigError && /accessor/.test(error.message),
  )
  assert.equal(reads, 0)
})

test("ignores non-enumerable properties without invoking them", () => {
  // For ordinary object properties, CAM matches JSON.stringify: non-enumerables are not part of the data.
  let reads = 0
  const withHidden = { a: 0 }
  Object.defineProperty(withHidden, "getter", {
    get: () => {
      reads += 1
      return 1
    },
  })
  Object.defineProperty(withHidden, "data", { value: "hidden" })

  assert.deepEqual(
    mergeStates({ originalState: { a: 0 }, submittedState: withHidden, currentServerState: { a: 0 } }),
    { ok: true, value: { a: 0 }, conflicts: [] },
  )
  assert.equal(reads, 0)
})

test("rejects accessor array elements", () => {
  const items = [1, 2]
  Object.defineProperty(items, 0, { enumerable: true, get: () => 1 })

  assert.throws(
    () => mergeStates({ originalState: { items: [1, 2] }, submittedState: { items }, currentServerState: { items: [1, 2] } }),
    CAMConfigError,
  )
})

test("merges exactly the value it validated", () => {
  // A proxy can change what it reports between descriptor lookups. The merge
  // must use the private value captured and validated by this call.
  let descriptorReads = 0
  let propertyReads = 0
  const proxy = new Proxy(
    { a: 0 },
    {
      getOwnPropertyDescriptor(object, key) {
        descriptorReads += 1
        return { ...Reflect.getOwnPropertyDescriptor(object, key), value: `captured-${descriptorReads}` }
      },
      get: () => {
        propertyReads += 1
        return "read-through-proxy"
      },
    },
  )

  const result = mergeStates({ originalState: { a: 0 }, submittedState: proxy, currentServerState: { a: 0 } })

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.a, `captured-${descriptorReads}`)
  assert.ok(descriptorReads > 0)
  assert.equal(propertyReads, 0)
})

test("rejects a proxy property that disappears after key enumeration", () => {
  let lookups = 0
  const proxy = new Proxy({ a: 0 }, {
    getOwnPropertyDescriptor(target, key) {
      lookups += 1
      return lookups === 1 ? Reflect.getOwnPropertyDescriptor(target, key) : undefined
    },
  })

  assert.throws(
    () => mergeStates({ originalState: {}, submittedState: proxy, currentServerState: {} }),
    (error) =>
      error instanceof CAMConfigError &&
      error.message === 'submittedState["a"] changed during validation',
  )
})

test("rejects Array subclasses and arrays with extra properties", () => {
  class TaggedArray extends Array {}
  const extra = [1]
  extra.label = "x"

  for (const items of [TaggedArray.from([1]), extra]) {
    assert.throws(
      () => mergeStates({ originalState: { items: [1] }, submittedState: { items }, currentServerState: { items: [1] } }),
      CAMConfigError,
    )
  }
})

test("ignores non-enumerable extra array properties", () => {
  const items = [1, 2]
  Object.defineProperty(items, "label", { value: "hidden" })

  assert.deepEqual(
    mergeStates({ originalState: { items: [1] }, submittedState: { items }, currentServerState: { items: [1] } }),
    { ok: true, value: { items: [1, 2] }, conflicts: [] },
  )
})

test("rejects non-enumerable array indices even though JSON.stringify serializes them", () => {
  const items = [1]
  Object.defineProperty(items, "0", { enumerable: false })

  assert.equal(JSON.stringify(items), "[1]")
  assert.throws(
    () => mergeStates({ originalState: { items: [1] }, submittedState: { items }, currentServerState: { items: [1] } }),
    (error) => error instanceof CAMConfigError && /without holes or extra properties/.test(error.message),
  )
})

test("rejects sparse arrays without relying on enumerable keys", () => {
  const items = new Array(1)

  assert.throws(
    () => mergeStates({ originalState: { items: [] }, submittedState: { items }, currentServerState: { items: [] } }),
    (error) => error instanceof CAMConfigError && /holes/.test(error.message),
  )
})

test("accepts null-prototype objects", () => {
  const submittedState = Object.assign(Object.create(null), { a: 2 })

  assert.deepEqual(
    mergeStates({ originalState: { a: 1 }, submittedState, currentServerState: { a: 1 } }),
    { ok: true, value: { a: 2 }, conflicts: [] },
  )
})

test("reports a very large number of conflicts without overflowing the stack", () => {
  const size = 200_000
  const build = (value) => {
    const object = {}
    for (let index = 0; index < size; index += 1) object[`k${index}`] = value(index)
    return object
  }

  const result = mergeStates({
    originalState: { nested: build((index) => index) },
    submittedState: { nested: build((index) => -index - 1) },
    currentServerState: { nested: build((index) => index + 1e6) },
  })

  assert.equal(result.ok, false)
  assert.equal(result.conflicts.length, size)
})

test("normalizes -0 to 0 in merged output", () => {
  const result = mergeStates({
    originalState: { n: 1 },
    submittedState: { n: -0 },
    currentServerState: { n: 1 },
  })

  assert.ok(Object.is(result.value.n, 0))
})

test("formats validation paths unambiguously for keys with dots", () => {
  assert.throws(
    () => mergeStates({ originalState: { "a.b": [1, undefined] }, submittedState: {}, currentServerState: {} }),
    (error) =>
      error instanceof CAMConfigError &&
      error.message.startsWith('originalState["a.b"][1] '),
  )
})

test("sorts conflicts lexicographically even for integer-like keys", () => {
  const result = mergeStates({
    originalState: { 10: 0, 9: 0, a: 0 },
    submittedState: { 10: 1, 9: 1, a: 1 },
    currentServerState: { 10: 2, 9: 2, a: 2 },
  })

  assert.deepEqual(result.conflicts.map((conflict) => conflict.path), [["10"], ["9"], ["a"]])
})

test("CAMConfigError is an Error but not a TypeError", () => {
  const error = new CAMConfigError("bad input")

  assert.ok(error instanceof Error)
  assert.equal(error instanceof TypeError, false)
  assert.equal(error.name, "CAMConfigError")
  assert.equal(error.code, "CAM_CONFIG_ERROR")
})

test("rejects a sparse array whose extra property hides the hole count", () => {
  const items = [1, , 3] // eslint-disable-line no-sparse-arrays
  items.extra = 1

  assert.throws(
    () => mergeStates({ originalState: { items: [1, 2, 3] }, submittedState: { items }, currentServerState: { items: [1, 2, 3] } }),
    (error) => error instanceof CAMConfigError && error.message.startsWith('submittedState["items"][1] ') && /holes/.test(error.message),
  )
})
