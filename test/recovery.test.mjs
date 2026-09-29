import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { createRecoveryController } from "../dist/recovery/index.js"
import { CAMConfigError } from "../dist/index.js"

const error412 = Object.assign(new Error("stale write"), { status: 412 })

function makeOptions(overrides = {}) {
  const events = []
  let latest = { state: { title: "original", serverOnly: true }, etag: '"latest-2"' }
  let currentRevision = 0
  const options = {
    expectedError: { code: 412 },
    errorSignalFrom: (cause) =>
      cause && typeof cause === "object" && typeof cause.status === "number"
        ? { code: cause.status }
        : undefined,
    fetchLatest: async (entityId) => {
      events.push(["fetchLatest", entityId])
      return latest
    },
    getVersion: (record) => {
      events.push(["getVersion"])
      return record.etag
    },
    isTerminal: (state) => {
      events.push(["isTerminal"])
      return state.status === "deleted"
    },
    project: (merged) => {
      events.push(["project"])
      return merged
    },
    prepareCandidate: (candidate) => {
      events.push(["prepareCandidate"])
      return candidate
    },
    validateCandidate: (candidate) => {
      events.push(["validateCandidate"])
      return { valid: true, value: candidate }
    },
    mutate: async (candidate, write) => {
      events.push(["mutate", candidate, write])
      if (write.attempt === "initial") throw error412
      return { state: candidate, version: '"latest-3"' }
    },
    isCurrent: (identity) => identity.draftRevision === currentRevision,
    setLatest(value) {
      latest = value
    },
    setRevision(value) {
      currentRevision = value
    },
    events,
    ...overrides,
  }
  return options
}

function input(overrides = {}) {
  return {
    entityId: "order-7",
    sessionId: "edit-session-1",
    draftRevision: 0,
    expectedVersion: '"original-1"',
    originalState: { title: "original" },
    submittedState: { title: "local" },
    ...overrides,
  }
}

test("invalid expectedError configuration throws CAMConfigError", () => {
  const options = makeOptions({ expectedError: null })
  assert.throws(() => createRecoveryController(options), CAMConfigError)
})

test("malformed controller options reject accessors without reading option getters", () => {
  assert.throws(() => createRecoveryController(null), CAMConfigError)
  assert.throws(() => createRecoveryController(makeOptions({ autoRetry: "always" })), CAMConfigError)
  assert.throws(() => createRecoveryController(makeOptions({ fetchLatest: null })), CAMConfigError)

  const optionsGetter = makeOptions()
  let optionGetterCalls = 0
  Object.defineProperty(optionsGetter, "fetchLatest", {
    configurable: true,
    get() {
      optionGetterCalls += 1
      return async () => ({ state: {}, etag: "latest" })
    },
  })
  assert.throws(() => createRecoveryController(optionsGetter), CAMConfigError)
  assert.equal(optionGetterCalls, 0)

  const retryGetter = makeOptions()
  Object.defineProperty(retryGetter, "autoRetry", {
    configurable: true,
    get() {
      optionGetterCalls += 1
      return "once"
    },
  })
  assert.throws(() => createRecoveryController(retryGetter), CAMConfigError)
  assert.equal(optionGetterCalls, 0)

  const signalAccessorOptions = makeOptions()
  let signalGetterCalls = 0
  const expectedSignal = {}
  Object.defineProperty(expectedSignal, "code", {
    enumerable: true,
    get() {
      signalGetterCalls += 1
      return 412
    },
  })
  signalAccessorOptions.expectedError = expectedSignal
  assert.throws(() => createRecoveryController(signalAccessorOptions), CAMConfigError)
  assert.equal(signalGetterCalls, 2)

  const textAccessorOptions = makeOptions()
  let textGetterCalls = 0
  const textExpected = { code: 412 }
  Object.defineProperty(textExpected, "text", {
    enumerable: true,
    get() {
      textGetterCalls += 1
      return "stale"
    },
  })
  textAccessorOptions.expectedError = textExpected
  assert.throws(() => createRecoveryController(textAccessorOptions), CAMConfigError)
  assert.equal(textGetterCalls, 2)
})

test("invalid recovery groups fail when the controller is created", () => {
  const invalidGroups = [
    [{ id: "g", paths: [] }],
    [{ id: "g", paths: [[]] }],
    [{ id: "g", paths: [["item"]] }, { id: "g", paths: [["other"]] }],
    [{ id: "g1", paths: [["item"]] }, { id: "g2", paths: [["item", "child"]] }],
    [{ id: "g", paths: [["item", -1]] }],
  ]

  for (const groups of invalidGroups) {
    const options = makeOptions({ groups })
    assert.throws(() => createRecoveryController(options), CAMConfigError)
    assert.equal(options.events.length, 0)
  }
})

test("malformed recover inputs fail before the mutation callback", async () => {
  const cases = [
    null,
    {},
    input({ entityId: undefined }),
    input({ sessionId: "" }),
    input({ draftRevision: Number.NaN }),
    input({ expectedVersion: Number.POSITIVE_INFINITY }),
  ]

  for (const value of cases) {
    const options = makeOptions()
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(value), CAMConfigError)
    assert.equal(options.events.some(([name]) => name === "mutate"), false)
  }

  const options = makeOptions()
  const controller = createRecoveryController(options)
  const malformed = input()
  let getterCalls = 0
  Object.defineProperty(malformed, "submittedState", {
    configurable: true,
    get() {
      getterCalls += 1
      return { title: "would invoke getter" }
    },
  })
  await assert.rejects(controller.recover(malformed), CAMConfigError)
  assert.equal(getterCalls, 0)
  assert.equal(options.events.some(([name]) => name === "mutate"), false)
})

test("initial mutation may save directly with its submitted version precondition", async () => {
  const options = makeOptions({
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      return { state: candidate, version: '"saved-2"' }
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "saved")
  assert.deepEqual(
    options.events.filter(([name]) => name === "mutate").map(([, , write]) => write),
    [{ entityId: "order-7", expectedVersion: '"original-1"', attempt: "initial" }],
  )
  assert.equal(options.events.some(([name]) => name === "fetchLatest"), false)
})

test("isCurrent must be synchronous and its thrown errors keep the guard stage", async () => {
  const asyncOptions = makeOptions({ isCurrent: () => Promise.resolve(true) })
  const asyncController = createRecoveryController(asyncOptions)
  await assert.rejects(asyncController.recover(input()), CAMConfigError)
  assert.equal(asyncOptions.events.some(([name]) => name === "mutate"), false)

  const failure = new Error("session check failed")
  const throwingOptions = makeOptions({
    isCurrent() {
      throw failure
    },
  })
  const throwingController = createRecoveryController(throwingOptions)
  const outcome = await throwingController.recover(input())
  assert.equal(outcome.kind, "failed")
  if (outcome.kind === "failed") {
    assert.equal(outcome.stage, "isCurrent")
    assert.equal(outcome.cause, failure)
  }
  assert.equal(throwingOptions.events.some(([name]) => name === "mutate"), false)
})

test("non-boolean terminal checks are rejected as configuration errors", async () => {
  const options = makeOptions({ isTerminal: () => "no" })
  const controller = createRecoveryController(options)
  await assert.rejects(controller.recover(input()), CAMConfigError)
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 1)
})

test("navigation during terminal-state checking stops before merge", async () => {
  let releaseTerminal
  const gate = new Promise((resolve) => {
    releaseTerminal = resolve
  })
  const options = makeOptions({
    isTerminal: async () => {
      options.events.push(["isTerminal"])
      await gate
      return false
    },
  })
  const controller = createRecoveryController(options)
  const recovering = controller.recover(input())
  await delay(0)
  options.setRevision(4)
  releaseTerminal()

  assert.equal((await recovering).kind, "obsolete")
  assert.equal(options.events.some(([name]) => name === "project"), false)
})

test("review mode does not write the recovered candidate before confirm", async () => {
  const options = makeOptions()
  const controller = createRecoveryController(options)

  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "review-ready")
  if (outcome.kind !== "review-ready") return
  assert.deepEqual(outcome.candidate, { title: "local", serverOnly: true })
  assert.deepEqual(
    options.events.filter(([name]) => name === "mutate").map(([, , write]) => write),
    [{ entityId: "order-7", expectedVersion: '"original-1"', attempt: "initial" }],
  )
  assert.deepEqual(options.events.map(([name]) => name), [
    "mutate",
    "fetchLatest",
    "getVersion",
    "isTerminal",
    "project",
    "prepareCandidate",
    "validateCandidate",
  ])

  const saved = await controller.confirm(outcome.token)
  assert.equal(saved.kind, "saved")
  assert.deepEqual(
    options.events.filter(([name]) => name === "mutate").map(([, , write]) => write),
    [
      { entityId: "order-7", expectedVersion: '"original-1"', attempt: "initial" },
      { entityId: "order-7", expectedVersion: '"latest-2"', attempt: "recovery" },
    ],
  )
})

test("revising invalidates the previous token and re-runs preparation and validation", async () => {
  const options = makeOptions()
  const controller = createRecoveryController(options)
  const first = await controller.recover(input())
  assert.equal(first.kind, "review-ready")
  if (first.kind !== "review-ready") return

  options.setRevision(1)
  const revised = await controller.reviseCandidate(
    first.token,
    { title: "edited after review", serverOnly: true },
    1,
  )
  assert.equal(revised.kind, "review-ready")
  assert.equal(options.events.filter(([name]) => name === "prepareCandidate").length, 2)
  assert.equal(options.events.filter(([name]) => name === "validateCandidate").length, 2)

  assert.equal((await controller.confirm(first.token)).kind, "obsolete")
  if (revised.kind !== "review-ready") return
  assert.equal((await controller.confirm(revised.token)).kind, "saved")
  assert.equal((await controller.confirm(revised.token)).kind, "obsolete")
})

test("conflict handles can be revised after external explicit choices", async () => {
  const options = makeOptions()
  options.setLatest({ state: { title: "server" }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "conflicts")
  if (outcome.kind !== "conflicts") return
  assert.equal("candidate" in outcome, false)
  assert.equal("token" in outcome, false)
  assert.equal(outcome.conflicts.length, 1)

  const reviewed = await controller.reviseCandidate(
    outcome.handle,
    { title: "local" },
    0,
  )
  assert.equal(reviewed.kind, "review-ready")
  if (reviewed.kind === "review-ready") {
    assert.deepEqual(reviewed.candidate, { title: "local" })
  }
  assert.equal(
    (await controller.reviseCandidate(outcome.handle, { title: "reused" }, 1)).kind,
    "obsolete",
  )
})

test("a second stale result is returned as changed-again with the candidate intact", async () => {
  const options = makeOptions({
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      throw error412
    },
  })
  const controller = createRecoveryController(options)
  const ready = await controller.recover(input())
  assert.equal(ready.kind, "review-ready")
  if (ready.kind !== "review-ready") return

  const raced = await controller.confirm(ready.token)
  assert.equal(raced.kind, "changed-again")
  if (raced.kind !== "changed-again") return
  assert.deepEqual(raced.candidate, { title: "local", serverOnly: true })
  assert.equal(raced.latestVersion, '"latest-2"')
  assert.deepEqual(
    options.events.filter(([name]) => name === "mutate").map(([, , write]) => write.expectedVersion),
    ['"original-1"', '"latest-2"'],
  )
})

test("terminal latest state stops before merge or candidate callbacks", async () => {
  const options = makeOptions()
  options.setLatest({ state: { status: "deleted" }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)

  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "terminal")
  assert.equal(options.events.some(([name]) => name === "project"), false)
  assert.equal(options.events.some(([name]) => name === "prepareCandidate"), false)
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 1)
})

test("validation failures preserve the repair candidate and issue details", async () => {
  let invalid = true
  const options = makeOptions({
    validateCandidate: (candidate) => {
      options.events.push(["validateCandidate"])
      return invalid
        ? { valid: false, candidate, issues: [{ path: ["title"], message: "Required" }] }
        : { valid: true, value: candidate }
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "validation-failed")
  if (outcome.kind !== "validation-failed") return
  assert.deepEqual(outcome.candidate, { title: "local", serverOnly: true })
  assert.deepEqual(outcome.issues, [{ path: ["title"], message: "Required" }])
  assert.equal(Object.isFrozen(outcome.candidate), true)
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 1)

  options.setRevision(1)
  invalid = false
  const repaired = await controller.reviseCandidate(
    outcome.handle,
    { title: "repaired", serverOnly: true },
    1,
  )
  assert.equal(repaired.kind, "review-ready")
})

test("cancellation while fetch is pending prevents later version reads and writes", async () => {
  let releaseFetch
  const gate = new Promise((resolve) => {
    releaseFetch = resolve
  })
  const options = makeOptions({
    fetchLatest: async () => {
      options.events.push(["fetchLatest"])
      await gate
      return { state: { title: "original" }, etag: '"latest-2"' }
    },
  })
  const controller = createRecoveryController(options)
  const recovering = controller.recover(input())
  await delay(0)
  controller.cancel()
  releaseFetch()

  assert.equal((await recovering).kind, "cancelled")
  assert.equal(options.events.some(([name]) => name === "getVersion"), false)
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 1)
})

test("cancellation during an accepted write does not claim to undo that write", async () => {
  let acceptWrite
  const accepted = new Promise((resolve) => {
    acceptWrite = resolve
  })
  const options = makeOptions({
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      if (write.attempt === "initial") throw error412
      return accepted
    },
  })
  const controller = createRecoveryController(options)
  const ready = await controller.recover(input())
  assert.equal(ready.kind, "review-ready")
  if (ready.kind !== "review-ready") return

  const confirming = controller.confirm(ready.token)
  await delay(0)
  controller.cancel()
  acceptWrite({ state: ready.candidate, version: '"saved"' })

  const outcome = await confirming
  assert.equal(outcome.kind, "saved")
  if (outcome.kind === "saved") {
    assert.deepEqual(outcome.state, ready.candidate)
    assert.equal(outcome.version, '"saved"')
  }
  assert.equal(
    options.events.filter(([name]) => name === "mutate").length,
    2,
    "the already-started write was invoked and cancellation did not claim to undo it",
  )
})

test("navigation during an awaited preparation returns obsolete and does not write", async () => {
  let releasePrepare
  const gate = new Promise((resolve) => {
    releasePrepare = resolve
  })
  const options = makeOptions({
    prepareCandidate: async (candidate) => {
      options.events.push(["prepareCandidate"])
      await gate
      return candidate
    },
  })
  const controller = createRecoveryController(options)
  const recovering = controller.recover(input())
  await delay(0)
  options.setRevision(2)
  releasePrepare()

  assert.equal((await recovering).kind, "obsolete")
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 1)
  assert.equal(options.events.some(([name]) => name === "validateCandidate"), false)
})

test("callback exceptions retain their stage and original cause", async () => {
  const fetchFailure = new Error("offline")
  const options = makeOptions({
    fetchLatest: async () => {
      throw fetchFailure
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "failed")
  if (outcome.kind === "failed") {
    assert.equal(outcome.stage, "fetchLatest")
    assert.equal(outcome.cause, fetchFailure)
  }
})

test("a non-matching backend error is returned without fetching latest", async () => {
  const nonStale = Object.assign(new Error("forbidden"), { status: 403 })
  const options = makeOptions({
    mutate: async () => {
      throw nonStale
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "failed")
  if (outcome.kind === "failed") {
    assert.equal(outcome.stage, "mutate")
    assert.equal(outcome.cause, nonStale)
  }
  assert.equal(options.events.some(([name]) => name === "fetchLatest"), false)
})

test("a throwing stale classifier preserves its stage and cause", async () => {
  const classifierFailure = new Error("error adapter failed")
  const options = makeOptions({
    errorSignalFrom() {
      throw classifierFailure
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "failed")
  if (outcome.kind === "failed") {
    assert.equal(outcome.stage, "isStaleError")
    assert.equal(outcome.cause, classifierFailure)
  }
  assert.equal(options.events.some(([name]) => name === "fetchLatest"), false)
})

test("cancellation while stale classification is pending prevents latest fetch", async () => {
  let releaseClassifier
  const classifierGate = new Promise((resolve) => {
    releaseClassifier = resolve
  })
  const options = makeOptions({
    errorSignalFrom: async (cause) => {
      options.events.push(["errorSignalFrom"])
      await classifierGate
      return { code: cause.status }
    },
  })
  const controller = createRecoveryController(options)
  const recovering = controller.recover(input())
  await delay(0)
  controller.cancel()
  releaseClassifier()

  assert.equal((await recovering).kind, "cancelled")
  assert.equal(options.events.some(([name]) => name === "fetchLatest"), false)
})

test("cancellation while recovery stale classification is pending returns cancelled", async () => {
  let releaseClassifier
  const classifierGate = new Promise((resolve) => {
    releaseClassifier = resolve
  })
  let classifierCalls = 0
  const options = makeOptions({
    errorSignalFrom: async (cause) => {
      classifierCalls += 1
      if (classifierCalls > 1) await classifierGate
      return { code: cause.status }
    },
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      throw error412
    },
  })
  const controller = createRecoveryController(options)
  const ready = await controller.recover(input())
  assert.equal(ready.kind, "review-ready")
  if (ready.kind !== "review-ready") return

  const confirming = controller.confirm(ready.token)
  await delay(0)
  controller.cancel()
  releaseClassifier()
  assert.equal((await confirming).kind, "cancelled")
})

test("a recovery stale-classifier exception retains its stage and cause", async () => {
  const failure = new Error("recovery error adapter failed")
  let classifierCalls = 0
  const options = makeOptions({
    errorSignalFrom: (cause) => {
      classifierCalls += 1
      if (classifierCalls > 1) throw failure
      return { code: cause.status }
    },
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      throw error412
    },
  })
  const controller = createRecoveryController(options)
  const ready = await controller.recover(input())
  assert.equal(ready.kind, "review-ready")
  if (ready.kind !== "review-ready") return

  const outcome = await controller.confirm(ready.token)
  assert.equal(outcome.kind, "failed")
  if (outcome.kind === "failed") {
    assert.equal(outcome.stage, "isStaleError")
    assert.equal(outcome.cause, failure)
  }
})

test("each recovery callback failure reports its own stage and cause", async (t) => {
  const callbacks = [
    ["getVersion", "getVersion", (failure) => ({ getVersion() { throw failure } })],
    ["isTerminal", "isTerminal", (failure) => ({ isTerminal() { throw failure } })],
    ["project", "project", (failure) => ({ project() { throw failure } })],
    ["prepareCandidate", "prepareCandidate", (failure) => ({ prepareCandidate() { throw failure } })],
    ["validateCandidate", "validateCandidate", (failure) => ({ validateCandidate() { throw failure } })],
  ]

  for (const [name, expectedStage, createOverride] of callbacks) {
    await t.test(name, async () => {
      const failure = new Error(`${name} failed`)
      const options = makeOptions(createOverride(failure))
      const controller = createRecoveryController(options)
      const outcome = await controller.recover(input())

      assert.equal(outcome.kind, "failed")
      if (outcome.kind === "failed") {
        assert.equal(outcome.stage, expectedStage)
        assert.equal(outcome.cause, failure)
      }
    })
  }

  await t.test("recovery mutate", async () => {
    const failure = new Error("recovery mutation failed")
    let calls = 0
    const options = makeOptions({
      mutate: async (candidate, write) => {
        options.events.push(["mutate", candidate, write])
        calls += 1
        if (calls === 1) throw error412
        throw failure
      },
    })
    const controller = createRecoveryController(options)
    const ready = await controller.recover(input())
    assert.equal(ready.kind, "review-ready")
    if (ready.kind !== "review-ready") return

    const outcome = await controller.confirm(ready.token)
    assert.equal(outcome.kind, "failed")
    if (outcome.kind === "failed") {
      assert.equal(outcome.stage, "mutate")
      assert.equal(outcome.cause, failure)
    }
  })
})

test("the opt-in automatic retry returns callback failures with their stage", async () => {
  const failure = new Error("automatic retry failed")
  let calls = 0
  const options = makeOptions({
    autoRetry: "once",
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      calls += 1
      if (calls === 1) throw error412
      throw failure
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "failed")
  if (outcome.kind === "failed") {
    assert.equal(outcome.stage, "mutate")
    assert.equal(outcome.cause, failure)
  }
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 2)
})

test("malformed latest snapshots throw CAMConfigError without invoking accessors", async () => {
  const nullOptions = makeOptions({ fetchLatest: async () => null })
  const nullController = createRecoveryController(nullOptions)
  await assert.rejects(nullController.recover(input()), CAMConfigError)

  const options = makeOptions({
    fetchLatest: async () => ({ etag: '"latest-2"' }),
  })
  const controller = createRecoveryController(options)
  await assert.rejects(controller.recover(input()), CAMConfigError)

  let stateGetterCalls = 0
  const getterOptions = makeOptions({
    fetchLatest: async () => {
      const result = { etag: '"latest-2"' }
      Object.defineProperty(result, "state", {
        get() {
          stateGetterCalls += 1
          return { title: "server" }
        },
      })
      return result
    },
  })
  const getterController = createRecoveryController(getterOptions)
  await assert.rejects(getterController.recover(input()), CAMConfigError)
  assert.equal(stateGetterCalls, 0)
})

test("malformed mutation and validation results throw CAMConfigError", async (t) => {
  await t.test("mutation result is null", async () => {
    const options = makeOptions({ mutate: async () => null })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("mutation result without a version", async () => {
    const options = makeOptions({
      mutate: async () => ({ state: { title: "saved" } }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("mutation result accessor", async () => {
    let stateGetterCalls = 0
    const options = makeOptions({
      mutate: async () => {
        const result = { version: "v2" }
        Object.defineProperty(result, "state", {
          get() {
            stateGetterCalls += 1
            return { title: "saved" }
          },
        })
        return result
      },
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
    assert.equal(stateGetterCalls, 0)
  })

  await t.test("validation result missing own value", async () => {
    const options = makeOptions({
      validateCandidate: () => ({ valid: true }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("validation result is null", async () => {
    const options = makeOptions({ validateCandidate: () => null })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("validation result has non-boolean valid property", async () => {
    const options = makeOptions({
      validateCandidate: (candidate) => ({ valid: "yes", value: candidate }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("invalid result is missing issues", async () => {
    const options = makeOptions({
      validateCandidate: (candidate) => ({ valid: false, candidate }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("invalid result issues are not an array", async () => {
    const options = makeOptions({
      validateCandidate: (candidate) => ({ valid: false, candidate, issues: "bad" }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("sparse issues array", async () => {
    const issues = new Array(1)
    const options = makeOptions({
      validateCandidate: (candidate) => ({ valid: false, candidate, issues }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
  })

  await t.test("issues accessor is not invoked", async () => {
    let issueGetterCalls = 0
    const issues = []
    Object.defineProperty(issues, "0", {
      configurable: true,
      get() {
        issueGetterCalls += 1
        return "invalid"
      },
    })
    issues.length = 1
    const options = makeOptions({
      validateCandidate: (candidate) => ({ valid: false, candidate, issues }),
    })
    const controller = createRecoveryController(options)
    await assert.rejects(controller.recover(input()), CAMConfigError)
    assert.equal(issueGetterCalls, 0)
  })
})

test("duplicate actions are blocked synchronously while callbacks are pending", async () => {
  let releaseMutation
  const gate = new Promise((resolve) => {
    releaseMutation = resolve
  })
  const options = makeOptions({
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      await gate
      if (write.attempt === "initial") throw error412
      return { state: candidate, version: '"saved"' }
    },
  })
  const controller = createRecoveryController(options)
  const first = controller.recover(input())
  assert.equal((await controller.recover(input({ sessionId: "other" }))).kind, "busy")
  releaseMutation()
  assert.equal((await first).kind, "review-ready")
})

test("duplicate confirm and revise actions are blocked while the first action waits", async (t) => {
  await t.test("confirm", async () => {
    let acceptWrite
    const gate = new Promise((resolve) => {
      acceptWrite = resolve
    })
    const options = makeOptions({
      mutate: async (candidate, write) => {
        options.events.push(["mutate", candidate, write])
        if (write.attempt === "initial") throw error412
        return gate
      },
    })
    const controller = createRecoveryController(options)
    const ready = await controller.recover(input())
    assert.equal(ready.kind, "review-ready")
    if (ready.kind !== "review-ready") return

    const firstConfirm = controller.confirm(ready.token)
    await delay(0)
    assert.equal((await controller.confirm(ready.token)).kind, "busy")
    assert.equal(
      (await controller.reviseCandidate(ready.token, { title: "edit" }, 0)).kind,
      "busy",
    )
    acceptWrite({ state: ready.candidate, version: '"saved"' })
    assert.equal((await firstConfirm).kind, "saved")
  })

  await t.test("reviseCandidate", async () => {
    let releasePrepare
    let holdPrepare = false
    const gate = new Promise((resolve) => {
      releasePrepare = resolve
    })
    const options = makeOptions({
      prepareCandidate: async (candidate) => {
        options.events.push(["prepareCandidate"])
        if (holdPrepare) await gate
        return candidate
      },
    })
    const controller = createRecoveryController(options)
    const ready = await controller.recover(input())
    assert.equal(ready.kind, "review-ready")
    if (ready.kind !== "review-ready") return
    options.setRevision(1)
    holdPrepare = true

    const firstRevise = controller.reviseCandidate(
      ready.token,
      { title: "edited" },
      1,
    )
    await delay(0)
    assert.equal(
      (await controller.reviseCandidate(ready.token, { title: "duplicate" }, 1)).kind,
      "busy",
    )
    releasePrepare()
    assert.equal((await firstRevise).kind, "review-ready")
  })
})

test("obsolete project and validation callbacks cannot continue the recovery flow", async (t) => {
  await t.test("project", async () => {
    let releaseProject
    const gate = new Promise((resolve) => {
      releaseProject = resolve
    })
    const options = makeOptions({
      project: async (candidate) => {
        options.events.push(["project"])
        await gate
        return candidate
      },
    })
    const controller = createRecoveryController(options)
    const recovering = controller.recover(input())
    await delay(0)
    options.setRevision(5)
    releaseProject()
    assert.equal((await recovering).kind, "obsolete")
    assert.equal(options.events.some(([name]) => name === "prepareCandidate"), false)
  })

  await t.test("validateCandidate", async () => {
    let releaseValidation
    const gate = new Promise((resolve) => {
      releaseValidation = resolve
    })
    const options = makeOptions({
      validateCandidate: async (candidate) => {
        options.events.push(["validateCandidate"])
        await gate
        return { valid: true, value: candidate }
      },
    })
    const controller = createRecoveryController(options)
    const recovering = controller.recover(input())
    await delay(0)
    options.setRevision(5)
    releaseValidation()
    assert.equal((await recovering).kind, "obsolete")
    assert.equal(
      options.events.filter(([, , write]) => write?.attempt === "recovery").length,
      0,
    )
  })
})

test("array candidates are deep-frozen before they leave the controller", async () => {
  const options = makeOptions()
  options.setLatest({ state: [{ title: "server" }], etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: [{ title: "original" }],
    submittedState: [{ title: "original" }],
  }))

  assert.equal(outcome.kind, "review-ready")
  if (outcome.kind !== "review-ready") return
  assert.deepEqual(outcome.candidate, [{ title: "server" }])
  assert.equal(Object.isFrozen(outcome.candidate), true)
  assert.equal(Object.isFrozen(outcome.candidate[0]), true)
})

test("autoRetry returns changed-again after its single retry also goes stale", async () => {
  const options = makeOptions({
    autoRetry: "once",
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      throw error412
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "changed-again")
  if (outcome.kind === "changed-again") {
    assert.deepEqual(outcome.candidate, { title: "local", serverOnly: true })
    assert.deepEqual(outcome.currentServerState, {
      title: "original",
      serverOnly: true,
    })

    const nextOptions = makeOptions()
    nextOptions.setLatest({
      state: { title: "original", serverOnly: false },
      etag: '"latest-3"',
    })
    const nextController = createRecoveryController(nextOptions)
    const continued = await nextController.recover(input({
      expectedVersion: outcome.latestVersion,
      originalState: outcome.currentServerState,
      submittedState: outcome.candidate,
    }))
    assert.equal(continued.kind, "review-ready")
    if (continued.kind === "review-ready") {
      assert.deepEqual(continued.candidate, {
        title: "local",
        serverOnly: false,
      })
    }
  }
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 2)
})

test("recovery merge honors configured coupled path groups", async () => {
  const options = makeOptions({
    groups: [{
      id: "variant-media",
      paths: [["defaultVariantId"], ["coverMediaId"]],
    }],
  })
  options.setLatest({
    state: { defaultVariantId: "a", coverMediaId: "server-media" },
    etag: '"latest-2"',
  })
  const controller = createRecoveryController(options)

  const outcome = await controller.recover(input({
    originalState: { defaultVariantId: "a", coverMediaId: "original-media" },
    submittedState: { defaultVariantId: "b", coverMediaId: "original-media" },
  }))

  assert.equal(outcome.kind, "conflicts")
  if (outcome.kind === "conflicts") {
    assert.equal(outcome.conflicts.length, 1)
    assert.equal(outcome.conflicts[0].kind, "group")
    assert.equal(outcome.conflicts[0].groupId, "variant-media")
  }
})

test("recovery controller can omit parser-style undefined object properties", async () => {
  const strictOptions = makeOptions()
  const strictController = createRecoveryController(strictOptions)
  await assert.rejects(
    strictController.recover(input({
      originalState: { title: "original", caption: undefined },
      submittedState: { title: "local", caption: undefined },
    })),
    CAMConfigError,
  )
  assert.equal(strictOptions.events.some(([name]) => name === "mutate"), false)

  const options = makeOptions({
    undefinedObjectProperties: "omit",
    mutate: async (candidate, write) => {
      options.events.push(["mutate", candidate, write])
      return { state: candidate, version: '"saved-2"' }
    },
  })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: { title: "original", caption: undefined },
    submittedState: { title: "local", caption: undefined },
  }))

  assert.equal(outcome.kind, "saved")
  const mutation = options.events.find(([name]) => name === "mutate")
  assert.deepEqual(mutation[1], { title: "local" })
  assert.equal(Object.hasOwn(mutation[1], "caption"), false)
})

test("an accepted mutation is not masked by later navigation or cancellation", async (t) => {
  await t.test("draft becomes obsolete while the request is in flight", async () => {
    let releaseMutation
    const gate = new Promise((resolve) => {
      releaseMutation = resolve
    })
    const options = makeOptions({
      mutate: async (candidate, write) => {
        options.events.push(["mutate", candidate, write])
        await gate
        return { state: candidate, version: '"saved-2"' }
      },
    })
    const controller = createRecoveryController(options)
    const pending = controller.recover(input())

    await delay(0)
    options.setRevision(1)
    releaseMutation()

    const outcome = await pending
    assert.equal(outcome.kind, "saved")
  })

  await t.test("controller is cancelled while the request is in flight", async () => {
    let releaseMutation
    const gate = new Promise((resolve) => {
      releaseMutation = resolve
    })
    const options = makeOptions({
      mutate: async (candidate, write) => {
        options.events.push(["mutate", candidate, write])
        await gate
        return { state: candidate, version: '"saved-2"' }
      },
    })
    const controller = createRecoveryController(options)
    const pending = controller.recover(input())

    await delay(0)
    controller.cancel()
    releaseMutation()

    const outcome = await pending
    assert.equal(outcome.kind, "saved")
  })
})

test("cancelled and replaced sessions invalidate outstanding capabilities", async () => {
  const cancelledOptions = makeOptions()
  const cancelledController = createRecoveryController(cancelledOptions)
  const cancelledReview = await cancelledController.recover(input())
  assert.equal(cancelledReview.kind, "review-ready")
  if (cancelledReview.kind !== "review-ready") return
  cancelledController.cancel()
  assert.equal((await cancelledController.confirm(cancelledReview.token)).kind, "cancelled")
  assert.equal(
    (await cancelledController.reviseCandidate(
      cancelledReview.token,
      { title: "edited" },
      1,
    )).kind,
    "cancelled",
  )

  const replacedOptions = makeOptions()
  const replacedController = createRecoveryController(replacedOptions)
  const oldReview = await replacedController.recover(input())
  assert.equal(oldReview.kind, "review-ready")
  if (oldReview.kind !== "review-ready") return
  const newReview = await replacedController.recover(input({ sessionId: "new-session" }))
  assert.equal(newReview.kind, "review-ready")
  assert.equal((await replacedController.confirm(oldReview.token)).kind, "obsolete")
})

test("autoRetry once uses the fetched version and performs exactly one recovery write", async () => {
  const options = makeOptions({ autoRetry: "once" })
  const controller = createRecoveryController(options)

  const outcome = await controller.recover(input())

  assert.equal(outcome.kind, "saved")
  const writes = options.events.filter(([name]) => name === "mutate")
  assert.equal(writes.length, 2)
  assert.deepEqual(writes.map(([, , write]) => write.expectedVersion), [
    '"original-1"',
    '"latest-2"',
  ])
})

test("recovery forwards collection options and merges keyed items", async () => {
  const options = makeOptions({
    arrays: { rules: [{ path: ["items"], mode: "keyed", key: "id" }] },
  })
  options.setLatest({ state: { items: [{ id: "a", q: 1, note: "server" }] }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: { items: [{ id: "a", q: 1 }] },
    submittedState: { items: [{ id: "a", q: 2 }] },
  }))
  assert.equal(outcome.kind, "review-ready")
  assert.deepEqual(outcome.candidate, { items: [{ id: "a", note: "server", q: 2 }] })
})

test("recovery reports rule violations as an invalid outcome", async () => {
  const options = makeOptions({ rules: [{ id: "cap", path: ["discount"], max: 0.3 }] })
  options.setLatest({ state: { discount: 0.1 }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: { discount: 0.1 },
    submittedState: { discount: 0.9 },
  }))
  assert.equal(outcome.kind, "invalid")
  assert.deepEqual(outcome.violations, [
    { ruleId: "cap", side: "submitted", message: "/discount must be at most 0.3" },
  ])
  assert.deepEqual(outcome.currentServerState, { discount: 0.1 })
})

test("review-mixed recovery never auto-writes a combined candidate", async () => {
  const options = makeOptions({ autoRetry: "once", autoMerge: "review-mixed" })
  options.setLatest({ state: { title: "original", serverOnly: false }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: { title: "original", serverOnly: true },
    submittedState: { title: "local", serverOnly: true },
  }))
  assert.equal(outcome.kind, "review-ready")
  assert.deepEqual(outcome.candidate, { serverOnly: false, title: "local" })
  assert.equal(options.events.filter(([name]) => name === "mutate").length, 1)
})

test("recovery validates merge-policy options when the controller is created", () => {
  assert.throws(() => createRecoveryController(makeOptions({ arrays: { default: "zip" } })), CAMConfigError)
  assert.throws(() => createRecoveryController(makeOptions({ rules: [{ id: "x" }] })), CAMConfigError)
  assert.throws(() => createRecoveryController(makeOptions({ derived: [["a", { $cam: "any" }]] })), CAMConfigError)
  assert.throws(() => createRecoveryController(makeOptions({ autoMerge: "sometimes" })), CAMConfigError)
})

test("recovery accepts derived paths and custom rules", async () => {
  const options = makeOptions({
    derived: [["total"]],
    rules: [{ id: "custom", paths: [["title"]], check: (state) => state.title !== "forbidden" || "no" }],
  })
  options.setLatest({ state: { title: "original", total: 5 }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: { title: "original", total: 1 },
    submittedState: { title: "local", total: 2 },
  }))
  assert.equal(outcome.kind, "review-ready")
  assert.deepEqual(outcome.candidate, { title: "local", total: 5 })
})

test("review-mixed recovery routes a keyed reorder combined with a server edit to review", async () => {
  const options = makeOptions({
    autoRetry: "once",
    autoMerge: "review-mixed",
    arrays: { rules: [{ path: ["items"], mode: "keyed", key: "id" }] },
  })
  options.setLatest({ state: { items: [{ id: "a", qty: 5 }, { id: "b", qty: 1 }] }, etag: '"latest-2"' })
  const controller = createRecoveryController(options)
  const outcome = await controller.recover(input({
    originalState: { items: [{ id: "a", qty: 1 }, { id: "b", qty: 1 }] },
    submittedState: { items: [{ id: "b", qty: 1 }, { id: "a", qty: 1 }] },
  }))
  assert.equal(outcome.kind, "review-ready")
  assert.deepEqual(outcome.candidate, { items: [{ id: "b", qty: 1 }, { id: "a", qty: 5 }] })
  // Only the initial write happened; no automatic recovery mutation.
  assert.deepEqual(
    options.events.filter(([name]) => name === "mutate").map(([, , write]) => write.attempt),
    ["initial"],
  )
})

test("recovery rules are snapshotted: mutating the caller's rule data later has no effect", async () => {
  const allowed = ["draft"]
  const paths = [["title"]]
  const options = makeOptions({
    rules: [
      { id: "status", path: ["status"], oneOf: allowed },
      { id: "custom", paths, check: (state) => state.title !== "forbidden" || "no" },
    ],
  })
  const controller = createRecoveryController(options)
  allowed.push("published")
  paths[0][0] = "status"
  options.setLatest({ state: { status: "draft", title: "original" }, etag: '"latest-2"' })
  const outcome = await controller.recover(input({
    originalState: { status: "draft", title: "original" },
    submittedState: { status: "published", title: "local" },
  }))
  assert.equal(outcome.kind, "invalid")
  assert.deepEqual(outcome.violations.map(({ ruleId }) => ruleId), ["status"])
})
