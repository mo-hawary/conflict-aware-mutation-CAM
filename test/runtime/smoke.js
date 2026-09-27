// Runtime-agnostic smoke checks for the built package. No test framework and
// no Node built-ins, so the same file runs in Node, Deno, Bun, and browsers.
// `cam` is the module namespace imported from dist/index.js.
export function runSmoke(cam) {
  const { CAMConfigError, matchConflictError, mergeStates } = cam
  const results = []

  const check = (name, fn) => {
    try {
      fn()
      results.push({ name, ok: true })
    } catch (error) {
      results.push({ name, ok: false, error: String(error && error.stack ? error.stack : error) })
    }
  }
  const equal = (actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`expected ${e}, got ${a}`)
  }
  const throwsConfigError = (fn) => {
    try {
      fn()
    } catch (error) {
      if (error instanceof CAMConfigError && error.code === "CAM_CONFIG_ERROR") return
      throw new Error(`expected CAMConfigError, got ${error}`)
    }
    throw new Error("expected CAMConfigError, nothing was thrown")
  }

  check("exports", () => equal(Object.keys(cam).sort(), ["CAMConfigError", "matchConflictError", "mergeStates"]))

  check("clean nested merge", () =>
    equal(
      mergeStates({
        originalState: { a: { x: 1, y: 1 }, list: [1] },
        submittedState: { a: { x: 2, y: 1 }, list: [1] },
        currentServerState: { a: { x: 1, y: 2 }, list: [1, 2] },
      }),
      { ok: true, value: { a: { x: 2, y: 2 }, list: [1, 2] }, conflicts: [] },
    ),
  )

  check("conflict with deletion", () =>
    equal(
      mergeStates({
        originalState: { phone: "111" },
        submittedState: {},
        currentServerState: { phone: "222" },
      }),
      {
        ok: false,
        kind: "conflict",
        conflicts: [{ path: ["phone"], submitted: { exists: false }, currentServer: { exists: true, value: "222" } }],
      },
    ),
  )

  check("__proto__ key stays data", () => {
    const submittedState = JSON.parse('{"__proto__":{"polluted":true}}')
    const result = mergeStates({ originalState: {}, submittedState, currentServerState: {} })
    if (Object.getPrototypeOf(result.value) !== Object.prototype) throw new Error("prototype changed")
    if ({}.polluted !== undefined) throw new Error("Object.prototype polluted")
  })

  check("error matching", () => {
    equal(matchConflictError({ error: { code: 409 }, expectedError: { code: 409 } }), { matched: true })
    equal(
      matchConflictError({ error: { code: 500, text: "boom" }, expectedError: { code: 409 }, errorOutput: { text: "Try again" } }),
      { matched: false, error: { code: 500, text: "Try again" } },
    )
  })

  check("rejects unsupported values", () => {
    throwsConfigError(() => mergeStates({ originalState: new Date(0), submittedState: {}, currentServerState: {} }))
    throwsConfigError(() => mergeStates({ originalState: { n: NaN }, submittedState: {}, currentServerState: {} }))
    throwsConfigError(() => matchConflictError({ error: {}, expectedError: { code: 409 } }))
  })

  const nested = (kind, levels) => {
    let value = 0
    for (let index = 0; index < levels; index += 1) {
      value = kind === "array" ? [value] : { child: value }
    }
    return value
  }
  const assertDepthAccepted = (state) => {
    const result = mergeStates({ originalState: state, submittedState: state, currentServerState: state })
    if (!result.ok) throw new Error("unchanged state at the nesting limit should merge")
  }

  check("accepts 512 nested object levels", () => assertDepthAccepted(nested("object", 512)))
  check("rejects 513 nested object levels", () =>
    throwsConfigError(() => {
      const state = nested("object", 513)
      mergeStates({ originalState: state, submittedState: state, currentServerState: state })
    }),
  )
  check("accepts 512 nested array levels", () => assertDepthAccepted(nested("array", 512)))
  check("rejects 513 nested array levels", () =>
    throwsConfigError(() => {
      const state = nested("array", 513)
      mergeStates({ originalState: state, submittedState: state, currentServerState: state })
    }),
  )

  return results
}

// Prints results and returns true when every check passed.
export function report(runtime, results) {
  for (const result of results) {
    console.log(`${result.ok ? "ok" : "not ok"} - [${runtime}] ${result.name}${result.ok ? "" : `\n${result.error}`}`)
  }
  return results.every((result) => result.ok)
}
