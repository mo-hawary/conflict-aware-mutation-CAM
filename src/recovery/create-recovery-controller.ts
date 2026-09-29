import { CAMConfigError } from "../errors.js"
import { matchConflictError } from "../match-conflict-error.js"
import { mergeStates, snapshotMergeStates, snapshotPathGroups } from "../merge-states.js"
import type {
  ArrayMergeOptions,
  AutoMergePolicy,
  ErrorSignal,
  JsonValue,
  MergeRule,
  PathGroup,
  PathPattern,
} from "../types.js"
import { snapshotJsonValue } from "../validation.js"
import type {
  CandidateValidation,
  DraftRevision,
  NormalizedRecoverInput,
  NormalizedRecoveryController,
  NormalizedRecoveryControllerOptions,
  RecoverInput,
  RecoveryControllerInternalOptions,
  RecoveryControllerOptions,
  RecoveryController,
  RecoveryEntityId,
  RecoveryIdentity,
  RecoveryMutationResult,
  RecoveryOutcome,
  RecoverySessionHandle,
  RecoveryStage,
  RecoveryToken,
  RecoveryVersion,
} from "./types.js"

type Session<
  S extends JsonValue,
  T extends JsonValue,
  V extends RecoveryVersion,
  E extends RecoveryEntityId,
  L extends { readonly state: S },
> = {
  readonly generation: number
  readonly sessionId: string
  identity: RecoveryIdentity<E>
  readonly originalState: S
  readonly submittedState: T
  readonly initialExpectedVersion: V
  currentServerState: S | undefined
  latest: L | undefined
  latestVersion: V | undefined
  candidate: T | undefined
  capability: RecoveryToken | RecoverySessionHandle | undefined
}

type CapabilityRecord<
  S extends JsonValue,
  T extends JsonValue,
  V extends RecoveryVersion,
  E extends RecoveryEntityId,
  L extends { readonly state: S },
> = {
  readonly kind: "review" | "conflict"
  readonly session: Session<S, T, V, E, L>
  readonly candidate: T | undefined
  readonly entityId: E
  readonly sessionId: string
  readonly draftRevision: DraftRevision
  readonly latestVersion: V
}

type CallbackResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: unknown }
  | { readonly stopped: RecoveryOutcome }

/**
 * Creates a single-session recovery controller. The initial mutation and every
 * later write require a version precondition. Recovery is review-first unless
 * `autoRetry: "once"` is explicitly configured.
 *
 * `fetchLatest()` returns a record with an own JSON `state` property; it may
 * carry adapter metadata such as an ETag for `getVersion()` to inspect.
 * `isCurrent()` is a synchronous host guard that must return false after the
 * user navigates away, replaces the editing session, or changes its draft.
 *
 * Conflict outcomes include an opaque handle so the caller can apply explicit
 * choices with `applyConflictDecisions()` and pass the resulting candidate to
 * `reviseCandidate()`. A review token is one-use and bound to that exact
 * candidate, session, revision, entity, version, and this controller's policy.
 */
export function createRecoveryController<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue = JsonValue,
  E extends RecoveryEntityId = RecoveryEntityId,
  L extends { readonly state: S } = { readonly state: S },
>(
  options: RecoveryControllerOptions<S, V, T, E, L>,
): RecoveryController<S, V, T, E>
export function createRecoveryController<
  V extends RecoveryVersion,
  E extends RecoveryEntityId = RecoveryEntityId,
  L extends { readonly state: JsonValue } = { readonly state: JsonValue },
>(
  options: NormalizedRecoveryControllerOptions<V, E, L>,
): NormalizedRecoveryController<V, E>
export function createRecoveryController<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue = JsonValue,
  E extends RecoveryEntityId = RecoveryEntityId,
  L extends { readonly state: S } = { readonly state: S },
>(
  options: RecoveryControllerInternalOptions<S, V, T, E, L>,
): RecoveryController<S, V, T, E> | NormalizedRecoveryController<V, E> {
  const config = validateOptions(options)

  // Capture the policy functions so mutating the caller's options object later
  // cannot switch the behavior underneath an already-issued capability.
  const {
    expectedError,
    errorSignalFrom,
    fetchLatest,
    getVersion,
    isTerminal,
    project,
    prepareCandidate,
    validateCandidate,
    mutate,
    isCurrent,
    autoRetry,
    groups,
    arrays,
    derived,
    rules,
    autoMerge,
    undefinedObjectProperties,
  } = config
  const expectedErrorSnapshot = snapshotErrorSignal(expectedError)
  let cancelled = false
  let busy = false
  let generation = 0
  let active: Session<S, T, V, E, L> | undefined
  const capabilities = new WeakMap<object, CapabilityRecord<S, T, V, E, L>>()

  function checkCurrent(
    session: Session<S, T, V, E, L>,
  ): RecoveryOutcome | undefined {
    if (cancelled) return { kind: "cancelled" }
    if (active !== session || generation !== session.generation) {
      return { kind: "obsolete" }
    }
    try {
      const current = isCurrent(session.identity)
      if (typeof current !== "boolean") {
        throw new CAMConfigError("isCurrent must return a boolean synchronously")
      }
      return current ? undefined : { kind: "obsolete" }
    } catch (cause) {
      if (cause instanceof CAMConfigError) throw cause
      return { kind: "failed", stage: "isCurrent", cause }
    }
  }

  async function call<TValue>(
    session: Session<S, T, V, E, L>,
    stage: RecoveryStage,
    callback: () => TValue | Promise<TValue>,
    options: { readonly checkAfterSuccess?: boolean } = {},
  ): Promise<CallbackResult<TValue>> {
    const before = checkCurrent(session)
    if (before) return { stopped: before }
    let value: TValue
    try {
      value = await callback()
    } catch (cause) {
      const afterFailure = checkCurrent(session)
      return afterFailure ? { stopped: afterFailure } : { ok: false, cause }
    }
    if (options.checkAfterSuccess === false) return { ok: true, value }
    const after = checkCurrent(session)
    return after ? { stopped: after } : { ok: true, value }
  }

  function makeCapability(
    session: Session<S, T, V, E, L>,
    kind: "review" | "conflict",
    candidate: T | undefined,
  ): RecoveryToken | RecoverySessionHandle {
    const latestVersion = session.latestVersion
    if (latestVersion === undefined) {
      throw new TypeError("Recovery capability created without a version")
    }
    const capability = Object.freeze(Object.create(null)) as object
    capabilities.set(capability, {
      kind,
      session,
      candidate,
      entityId: session.identity.entityId,
      sessionId: session.sessionId,
      draftRevision: session.identity.draftRevision,
      latestVersion,
    })
    session.capability = capability as RecoveryToken
    return capability as RecoveryToken
  }

  function invalidateCapability(session: Session<S, T, V, E, L>): void {
    if (session.capability) capabilities.delete(session.capability)
    session.capability = undefined
  }

  function requiredContext(
    session: Session<S, T, V, E, L>,
  ): { entityId: E; sessionId: string; draftRevision: DraftRevision; latestVersion: V } {
    if (session.latestVersion === undefined) {
      throw new TypeError("Recovery callback invoked without a version")
    }
    return {
      entityId: session.identity.entityId,
      sessionId: session.sessionId,
      draftRevision: session.identity.draftRevision,
      latestVersion: session.latestVersion,
    }
  }

  function validationOutcome(
    session: Session<S, T, V, E, L>,
    candidate: JsonValue,
    issues: readonly unknown[],
  ): RecoveryOutcome<T, S, V, E> {
    const latestVersion = session.latestVersion
    if (latestVersion === undefined) {
      throw new TypeError("Validation outcome created without a version")
    }
    const safeCandidate = snapshot(candidate)
    session.candidate = safeCandidate as T
    const handle = makeCapability(session, "conflict", safeCandidate as T)
    return {
      kind: "validation-failed",
      sessionId: session.sessionId,
      candidate: safeCandidate,
      issues: snapshotIssues(issues),
      latestVersion,
      handle: handle as RecoverySessionHandle,
    }
  }

  async function prepareAndValidate(
    session: Session<S, T, V, E, L>,
    candidate: JsonValue,
  ): Promise<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly outcome: RecoveryOutcome<T, S, V, E> }
  > {
    const currentServerState = session.currentServerState
    const latest = session.latest
    if (currentServerState === undefined || latest === undefined) {
      throw new TypeError("Recovery candidate prepared without latest state")
    }

    const context = requiredContext(session)
    const projected = await call(session, "project", () =>
      project(candidate, currentServerState, latest),
    )
    if ("stopped" in projected) {
      return { ok: false, outcome: projected.stopped as RecoveryOutcome<T, S, V, E> }
    }
    if (!projected.ok) {
      return {
        ok: false,
        outcome: { kind: "failed", stage: "project", cause: projected.cause },
      }
    }
    const projectedSnapshot = snapshot(projected.value)

    const prepared = await call(session, "prepareCandidate", () =>
      prepareCandidate(projectedSnapshot, context),
    )
    if ("stopped" in prepared) {
      return { ok: false, outcome: prepared.stopped as RecoveryOutcome<T, S, V, E> }
    }
    if (!prepared.ok) {
      return {
        ok: false,
        outcome: {
          kind: "failed",
          stage: "prepareCandidate",
          cause: prepared.cause,
        },
      }
    }
    const candidateSnapshot = snapshot(prepared.value) as T

    const validation = await call(session, "validateCandidate", () =>
      validateCandidate(candidateSnapshot, context),
    )
    if ("stopped" in validation) {
      return { ok: false, outcome: validation.stopped as RecoveryOutcome<T, S, V, E> }
    }
    if (!validation.ok) {
      return {
        ok: false,
        outcome: {
          kind: "failed",
          stage: "validateCandidate",
          cause: validation.cause,
        },
      }
    }

    const decision = readValidation(validation.value)
    if (!decision.valid) {
      return {
        ok: false,
        outcome: validationOutcome(session, decision.candidate, decision.issues),
      }
    }
    return { ok: true, value: snapshot(decision.value) as T }
  }

  async function writeCandidate(
    session: Session<S, T, V, E, L>,
    candidate: T,
    attempt: "initial" | "recovery",
  ): Promise<
    | { readonly kind: "saved"; readonly state: T; readonly version: V }
  | { readonly kind: "changed-again"; readonly candidate: T; readonly currentServerState: S; readonly latestVersion: V; readonly sessionId: string }
    | { readonly kind: "stale"; readonly cause: unknown }
    | { readonly kind: "stopped"; readonly outcome: RecoveryOutcome<T, S, V, E> }
    | { readonly kind: "failed"; readonly stage: RecoveryStage; readonly cause: unknown }
  > {
    const version = attempt === "initial"
      ? session.initialExpectedVersion
      : session.latestVersion
    if (version === undefined) {
      throw new TypeError("Mutation attempted without a version precondition")
    }
    const callResult = await call(
      session,
      "mutate",
      () =>
        mutate(candidate, {
          entityId: session.identity.entityId,
          expectedVersion: version,
          attempt,
        }),
      // Once the backend accepts a write, later navigation/cancellation cannot
      // undo it. Return the saved result instead of masking it as obsolete.
      { checkAfterSuccess: false },
    )
    if ("stopped" in callResult) {
      return { kind: "stopped", outcome: callResult.stopped as RecoveryOutcome<T, S, V, E> }
    }
    if (callResult.ok) {
      const normalized = readMutationResult(callResult.value)
      return { kind: "saved", state: normalized.state as T, version: normalized.version }
    }

    if (attempt === "recovery") {
      const latestVersion = session.latestVersion
      const currentServerState = session.currentServerState
      if (latestVersion === undefined || currentServerState === undefined) {
        throw new TypeError("Recovery write failed without a recovery baseline")
      }
      const classified = await call(session, "isStaleError", () =>
        errorSignalFrom(callResult.cause),
      )
      if ("stopped" in classified) {
        return { kind: "stopped", outcome: classified.stopped as RecoveryOutcome<T, S, V, E> }
      }
      if (!classified.ok) {
        return { kind: "failed", stage: "isStaleError", cause: classified.cause }
      }
      if (classified.value !== undefined) {
        const match = matchConflictError({
          error: classified.value,
          expectedError: expectedErrorSnapshot,
        })
        if (match.matched) {
          return {
            kind: "changed-again",
            candidate,
            currentServerState,
            latestVersion,
            sessionId: session.sessionId,
          }
        }
      }
      return { kind: "failed", stage: "mutate", cause: callResult.cause }
    }

    const classified = await call(session, "isStaleError", () =>
      errorSignalFrom(callResult.cause),
    )
    if ("stopped" in classified) {
      return { kind: "stopped", outcome: classified.stopped as RecoveryOutcome<T, S, V, E> }
    }
    if (!classified.ok) {
      return { kind: "failed", stage: "isStaleError", cause: classified.cause }
    }
    if (classified.value !== undefined) {
      const match = matchConflictError({
        error: classified.value,
        expectedError: expectedErrorSnapshot,
      })
      if (match.matched) {
        return { kind: "stale", cause: callResult.cause }
      }
    }
    return { kind: "failed", stage: "mutate", cause: callResult.cause }
  }

  async function recover(
    input: RecoverInput<S, T, V, E> | NormalizedRecoverInput<V, E>,
  ): Promise<RecoveryOutcome<T, S, V, E>> {
    if (cancelled) return { kind: "cancelled" }
    if (busy) return { kind: "busy" }
    const normalizedInput = readRecoverInput(input, undefinedObjectProperties)
    busy = true
    invalidateActive()
    const currentGeneration = ++generation
    const session: Session<S, T, V, E, L> = {
      generation: currentGeneration,
      sessionId: normalizedInput.sessionId,
      identity: {
        entityId: normalizedInput.entityId,
        sessionId: normalizedInput.sessionId,
        draftRevision: normalizedInput.draftRevision,
      },
      originalState: normalizedInput.originalState,
      submittedState: normalizedInput.submittedState,
      initialExpectedVersion: normalizedInput.expectedVersion,
      currentServerState: undefined,
      latest: undefined,
      latestVersion: undefined,
      candidate: undefined,
      capability: undefined,
    }
    active = session

    try {
      const initialWrite = await writeCandidate(
        session,
        normalizedInput.submittedState,
        "initial",
      )
      if (initialWrite.kind === "stopped") return initialWrite.outcome
      if (initialWrite.kind === "failed") {
        if (initialWrite.stage === "mutate") {
          // `writeCandidate` only returns a mutate failure for a non-matching
          // error, but a stale match should continue into the recovery flow.
          return { kind: "failed", stage: initialWrite.stage, cause: initialWrite.cause }
        }
        return { kind: "failed", stage: initialWrite.stage, cause: initialWrite.cause }
      }
      if (initialWrite.kind === "saved") {
        active = undefined
        return {
          kind: "saved",
          state: initialWrite.state,
          version: initialWrite.version,
        }
      }
      if (initialWrite.kind === "stale") {
        return await recoverAfterStale(session)
      }
      return initialWrite
    } finally {
      busy = false
    }
  }

  function invalidateActive(): void {
    if (active) invalidateCapability(active)
    active = undefined
  }

  async function reviseCandidate(
    capability: RecoveryToken | RecoverySessionHandle,
    candidate: JsonValue,
    draftRevision: DraftRevision,
  ): Promise<RecoveryOutcome<T, S, V, E>> {
    if (cancelled) return { kind: "cancelled" }
    if (busy) return { kind: "busy" }
    validateDraftRevision(draftRevision)
    const safeCandidate = snapshot(candidate)
    const record = capabilities.get(capability)
    if (
      !record ||
      record.session !== active ||
      active?.capability !== capability ||
      record.latestVersion !== record.session.latestVersion ||
      record.entityId !== record.session.identity.entityId ||
      record.sessionId !== record.session.sessionId ||
      record.draftRevision !== record.session.identity.draftRevision
    ) {
      return { kind: "obsolete" }
    }
    busy = true
    capabilities.delete(capability)
    record.session.capability = undefined
    record.session.identity = {
      ...record.session.identity,
      draftRevision,
    }

    try {
      const current = checkCurrent(record.session)
      if (current) return current as RecoveryOutcome<T, S, V, E>
      const prepared = await prepareAndValidate(record.session, safeCandidate)
      if (!prepared.ok) return prepared.outcome
      const session = record.session
      const latestVersion = session.latestVersion
      if (latestVersion === undefined) {
        throw new TypeError("Reviewed candidate has no latest version")
      }
      session.candidate = prepared.value
      const token = makeCapability(session, "review", prepared.value)
      return {
        kind: "review-ready",
        candidate: prepared.value,
        latestVersion,
        sessionId: session.sessionId,
        token: token as RecoveryToken,
      }
    } finally {
      busy = false
    }
  }

  async function confirm(
    token: RecoveryToken,
  ): Promise<RecoveryOutcome<T, S, V, E>> {
    if (cancelled) return { kind: "cancelled" }
    if (busy) return { kind: "busy" }
    const record = capabilities.get(token)
    if (
      !record ||
      record.kind !== "review" ||
      record.session !== active ||
      record.session.capability !== token ||
      record.candidate === undefined ||
      record.session.candidate !== record.candidate ||
      record.latestVersion !== record.session.latestVersion ||
      record.entityId !== record.session.identity.entityId ||
      record.sessionId !== record.session.sessionId ||
      record.draftRevision !== record.session.identity.draftRevision
    ) {
      return { kind: "obsolete" }
    }
    busy = true
    capabilities.delete(token)
    record.session.capability = undefined

    try {
      const write = await writeCandidate(record.session, record.candidate, "recovery")
      if (write.kind === "stopped") return write.outcome
      if (write.kind === "failed") {
        return { kind: "failed", stage: write.stage, cause: write.cause }
      }
      if (write.kind === "changed-again") return write
      if (write.kind === "stale") {
        const latestVersion = record.session.latestVersion
        if (latestVersion === undefined) {
          throw new TypeError("Recovery write raced without a known version")
        }
        const currentServerState = record.session.currentServerState
        if (currentServerState === undefined) {
          throw new TypeError("Recovery write raced without a recovery baseline")
        }
        return {
          kind: "changed-again",
          candidate: record.candidate,
          currentServerState,
          latestVersion,
          sessionId: record.session.sessionId,
        }
      }
      active = undefined
      return { kind: "saved", state: write.state, version: write.version }
    } finally {
      busy = false
    }
  }

  async function recoverAfterStale(
    session: Session<S, T, V, E, L>,
  ): Promise<RecoveryOutcome<T, S, V, E>> {
    const fetched = await call(session, "fetchLatest", () =>
      fetchLatest(session.identity.entityId),
    )
    if ("stopped" in fetched) return fetched.stopped as RecoveryOutcome<T, S, V, E>
    if (!fetched.ok) {
      return { kind: "failed", stage: "fetchLatest", cause: fetched.cause }
    }
    const latest = fetched.value
    const latestState = readLatestState<S, L>(latest)
    const currentServerState = snapshotInput(
      latestState,
      "currentServerState",
      undefinedObjectProperties,
    ) as S
    session.latest = latest
    session.currentServerState = currentServerState

    const versionResult = await call(session, "getVersion", () => getVersion(latest))
    if ("stopped" in versionResult) return versionResult.stopped as RecoveryOutcome<T, S, V, E>
    if (!versionResult.ok) {
      return { kind: "failed", stage: "getVersion", cause: versionResult.cause }
    }
    validateVersion(versionResult.value, "latest version")
    const latestVersion = normalizeVersion(versionResult.value)
    session.latestVersion = latestVersion

    const terminalResult = await call(session, "isTerminal", () =>
      isTerminal(currentServerState, latest),
    )
    if ("stopped" in terminalResult) {
      return terminalResult.stopped as RecoveryOutcome<T, S, V, E>
    }
    if (!terminalResult.ok) {
      return { kind: "failed", stage: "isTerminal", cause: terminalResult.cause }
    }
    if (typeof terminalResult.value !== "boolean") {
      throw new CAMConfigError("isTerminal must return a boolean")
    }
    if (terminalResult.value) {
      active = undefined
      return {
        kind: "terminal",
        currentServerState,
        latestVersion,
      }
    }

    let merged
    try {
      merged = mergeStates<JsonValue>({
        originalState: session.originalState as JsonValue,
        submittedState: session.submittedState as JsonValue,
        currentServerState: currentServerState as JsonValue,
        ...(groups === undefined ? {} : { groups }),
        ...(arrays === undefined ? {} : { arrays }),
        ...(derived === undefined ? {} : { derived }),
        ...(rules === undefined ? {} : { rules }),
        ...(autoMerge === undefined ? {} : { autoMerge }),
      } as never)
    } catch (cause) {
      if (cause instanceof CAMConfigError) throw cause
      return { kind: "failed", stage: "merge", cause }
    }
    const mergeResult = merged as { ok: boolean; kind?: string; value?: JsonValue; conflicts: never[]; violations?: never[] }
    if (!mergeResult.ok && mergeResult.kind === "invalid") {
      const handle = makeCapability(session, "conflict", undefined)
      return {
        kind: "invalid",
        sessionId: session.sessionId,
        violations: mergeResult.violations!,
        conflicts: mergeResult.conflicts,
        currentServerState,
        latestVersion,
        handle: handle as RecoverySessionHandle,
      }
    }
    const needsReview = !mergeResult.ok && mergeResult.kind === "review"
    if (needsReview) merged = { ok: true, value: mergeResult.value!, conflicts: [] } as never
    if (!merged.ok) {
      const handle = makeCapability(session, "conflict", undefined)
      return {
        kind: "conflicts",
        sessionId: session.sessionId,
        conflicts: merged.conflicts,
        currentServerState,
        latestVersion,
        handle: handle as RecoverySessionHandle,
      }
    }

    const prepared = await prepareAndValidate(session, merged.value)
    if (!prepared.ok) return prepared.outcome
    session.candidate = prepared.value

    if (autoRetry === "once" && !needsReview) {
      const write = await writeCandidate(session, prepared.value, "recovery")
      if (write.kind === "stopped") return write.outcome
      if (write.kind === "failed") {
        return { kind: "failed", stage: write.stage, cause: write.cause }
      }
      if (write.kind === "changed-again") return write
      if (write.kind === "stale") {
        return {
          kind: "changed-again",
          candidate: prepared.value,
          currentServerState,
          latestVersion,
          sessionId: session.sessionId,
        }
      }
      active = undefined
      return { kind: "saved", state: write.state, version: write.version }
    }

    const token = makeCapability(session, "review", prepared.value)
    return {
      kind: "review-ready",
      candidate: prepared.value,
      latestVersion,
      sessionId: session.sessionId,
      token: token as RecoveryToken,
    }
  }

  function cancel(): void {
    if (cancelled) return
    cancelled = true
    generation += 1
    invalidateActive()
  }

  return { recover, reviseCandidate, confirm, cancel } as
    | RecoveryController<S, V, T, E>
    | NormalizedRecoveryController<V, E>
}

function validateOptions<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue,
  E extends RecoveryEntityId,
  L extends { readonly state: S },
>(options: RecoveryControllerInternalOptions<S, V, T, E, L>): RecoveryControllerInternalOptions<S, V, T, E, L> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new CAMConfigError("createRecoveryController options must be an object")
  }
  const autoRetry = readOptionalOwnData<"once">(options, "autoRetry", "autoRetry")
  const undefinedObjectProperties = readOptionalOwnData<"omit">(
    options,
    "undefinedObjectProperties",
    "undefinedObjectProperties",
  )
  const rawGroups = readOptionalOwnData<readonly PathGroup[]>(options, "groups", "groups")
  const groups = rawGroups === undefined
    ? undefined
    : deepFreeze(
        snapshotPathGroups(rawGroups) as unknown as JsonValue,
      ) as unknown as readonly PathGroup[]
  const arrays = readOptionalOwnData<ArrayMergeOptions>(options, "arrays", "arrays")
  const derived = readOptionalOwnData<readonly PathPattern[]>(options, "derived", "derived")
  const rawRules = readOptionalOwnData<readonly MergeRule[]>(options, "rules", "rules")
  const autoMerge = readOptionalOwnData<AutoMergePolicy>(options, "autoMerge", "autoMerge")
  // Validate merge-policy options once, eagerly, with a throwaway merge input.
  snapshotMergeStates({
    originalState: null,
    submittedState: null,
    currentServerState: null,
    ...(arrays === undefined ? {} : { arrays }),
    ...(derived === undefined ? {} : { derived }),
    ...(rawRules === undefined ? {} : { rules: rawRules }),
    ...(autoMerge === undefined ? {} : { autoMerge }),
  } as never)
  const frozenArrays = arrays === undefined
    ? undefined
    : deepFreeze(snapshotJsonValue(arrays, "arrays")) as unknown as ArrayMergeOptions
  const frozenDerived = derived === undefined
    ? undefined
    : deepFreeze(snapshotJsonValue(derived, "derived")) as unknown as readonly PathPattern[]
  // Deep-snapshot rule data so later caller mutations cannot change the
  // policy; custom rules keep only their check function by reference.
  const frozenRules = rawRules === undefined
    ? undefined
    : Object.freeze(rawRules.map((rule, index): MergeRule => {
        const label = `rules[${index}]`
        if (Object.getOwnPropertyDescriptor(rule, "check") !== undefined) {
          const custom = rule as { id: string; paths: unknown; check: MergeRule extends infer R ? R extends { check: infer C } ? C : never : never }
          return Object.freeze({
            id: custom.id,
            paths: deepFreeze(snapshotJsonValue(custom.paths, `${label}.paths`)),
            check: custom.check,
          }) as unknown as MergeRule
        }
        return deepFreeze(snapshotJsonValue(rule, label)) as unknown as MergeRule
      })) as readonly MergeRule[]
  const config = {
    expectedError: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["expectedError"]>(options, "expectedError", "expectedError"),
    errorSignalFrom: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["errorSignalFrom"]>(options, "errorSignalFrom", "errorSignalFrom"),
    fetchLatest: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["fetchLatest"]>(options, "fetchLatest", "fetchLatest"),
    getVersion: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["getVersion"]>(options, "getVersion", "getVersion"),
    isTerminal: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["isTerminal"]>(options, "isTerminal", "isTerminal"),
    project: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["project"]>(options, "project", "project"),
    prepareCandidate: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["prepareCandidate"]>(options, "prepareCandidate", "prepareCandidate"),
    validateCandidate: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["validateCandidate"]>(options, "validateCandidate", "validateCandidate"),
    mutate: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["mutate"]>(options, "mutate", "mutate"),
    isCurrent: readOwnData<RecoveryControllerInternalOptions<S, V, T, E, L>["isCurrent"]>(options, "isCurrent", "isCurrent"),
    ...(autoRetry === undefined ? {} : { autoRetry }),
    ...(groups === undefined ? {} : { groups }),
    ...(frozenArrays === undefined ? {} : { arrays: frozenArrays }),
    ...(frozenDerived === undefined ? {} : { derived: frozenDerived }),
    ...(frozenRules === undefined ? {} : { rules: frozenRules }),
    ...(autoMerge === undefined ? {} : { autoMerge }),
    ...(undefinedObjectProperties === undefined ? {} : { undefinedObjectProperties }),
  } as RecoveryControllerInternalOptions<S, V, T, E, L>
  const functionNames = [
    "errorSignalFrom",
    "fetchLatest",
    "getVersion",
    "isTerminal",
    "project",
    "prepareCandidate",
    "validateCandidate",
    "mutate",
    "isCurrent",
  ] as const
  for (const name of functionNames) {
    if (typeof config[name] !== "function") {
      throw new CAMConfigError(`createRecoveryController ${name} must be a function`)
    }
  }
  if (config.autoRetry !== undefined && config.autoRetry !== "once") {
    throw new CAMConfigError('createRecoveryController autoRetry must be "once"')
  }
  if (
    config.undefinedObjectProperties !== undefined &&
    config.undefinedObjectProperties !== "omit"
  ) {
    throw new CAMConfigError(
      'createRecoveryController undefinedObjectProperties must be "omit"',
    )
  }
  matchConflictError({ error: config.expectedError, expectedError: config.expectedError })
  return config
}

function readOwnData<T>(record: object, key: string, label: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !("value" in descriptor)) {
    throw new CAMConfigError(`${label} must be an own data property`)
  }
  return descriptor.value as T
}

function readOptionalOwnData<T>(
  record: object,
  key: string,
  label: string,
): T | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !("value" in descriptor)) {
    throw new CAMConfigError(`${label} must be an own data property`)
  }
  return descriptor.value as T | undefined
}

function snapshotErrorSignal(signal: ErrorSignal): ErrorSignal {
  const code = Object.getOwnPropertyDescriptor(signal, "code")
  const text = Object.getOwnPropertyDescriptor(signal, "text")
  if (code && !("value" in code)) {
    throw new CAMConfigError("expectedError.code must be an own data property")
  }
  if (text && !("value" in text)) {
    throw new CAMConfigError("expectedError.text must be an own data property")
  }
  const result: { code?: string | number; text?: string } = {}
  if (code && code.value !== undefined) result.code = code.value as string | number
  if (text && text.value !== undefined) result.text = text.value as string
  return Object.freeze(result) as ErrorSignal
}

function snapshot<T extends JsonValue>(value: T): T {
  return deepFreeze(snapshotJsonValue(value)) as T
}

function snapshotInput(
  value: unknown,
  label: string,
  undefinedObjectProperties?: "omit",
): JsonValue {
  return deepFreeze(snapshotJsonValue(value, label, undefinedObjectProperties))
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key] as JsonValue)
    }
  }
  return Object.freeze(value)
}

function readRecoverInput<
  S extends JsonValue,
  T extends JsonValue,
  V extends RecoveryVersion,
  E extends RecoveryEntityId,
>(
  input: RecoverInput<S, T, V, E> | NormalizedRecoverInput<V, E>,
  undefinedObjectProperties?: "omit",
): Omit<RecoverInput<S, T, V, E>, "originalState" | "submittedState"> & {
  readonly originalState: S
  readonly submittedState: T
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CAMConfigError("recover input must be an object")
  }
  const entityId = readOwnData<E>(input, "entityId", "entityId")
  const sessionId = readOwnData<string>(input, "sessionId", "sessionId")
  const draftRevision = readOwnData<DraftRevision>(input, "draftRevision", "draftRevision")
  const expectedVersion = readOwnData<V>(input, "expectedVersion", "expectedVersion")
  const originalState = readOwnData<S>(input, "originalState", "originalState")
  const submittedState = readOwnData<T>(input, "submittedState", "submittedState")
  validateEntityId(entityId)
  validateSessionId(sessionId)
  validateDraftRevision(draftRevision)
  validateVersion(expectedVersion, "expectedVersion")
  return {
    entityId,
    sessionId,
    draftRevision,
    expectedVersion: normalizeVersion(expectedVersion),
    originalState: snapshotInput(
      originalState,
      "originalState",
      undefinedObjectProperties,
    ) as S,
    submittedState: snapshotInput(
      submittedState,
      "submittedState",
      undefinedObjectProperties,
    ) as T,
  }
}

function readMutationResult<
  T extends JsonValue,
  V extends RecoveryVersion,
>(value: RecoveryMutationResult<T, V>): RecoveryMutationResult<T, V> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CAMConfigError("mutate must return an object with state and version")
  }
  const state = Object.getOwnPropertyDescriptor(value, "state")
  const version = Object.getOwnPropertyDescriptor(value, "version")
  if (!state || !("value" in state) || !version || !("value" in version)) {
    throw new CAMConfigError("mutate result state and version must be own data properties")
  }
  validateVersion(version.value as RecoveryVersion, "mutation version")
  return {
    state: snapshot(state.value as T),
    version: normalizeVersion(version.value as V),
  }
}

function readValidation<T extends JsonValue>(
  value: CandidateValidation<T>,
): CandidateValidation<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CAMConfigError("validateCandidate must return a validation result object")
  }
  const valid = Object.getOwnPropertyDescriptor(value, "valid")
  if (!valid || !("value" in valid) || typeof valid.value !== "boolean") {
    throw new CAMConfigError("validation result must have an own boolean valid property")
  }
  if (valid.value) {
    const result = Object.getOwnPropertyDescriptor(value, "value")
    if (!result || !("value" in result)) {
      throw new CAMConfigError("valid result must have an own value property")
    }
    return { valid: true, value: result.value as T }
  }
  const candidate = Object.getOwnPropertyDescriptor(value, "candidate")
  const issues = Object.getOwnPropertyDescriptor(value, "issues")
  if (
    !candidate || !("value" in candidate) ||
    !issues || !("value" in issues) || !Array.isArray(issues.value)
  ) {
    throw new CAMConfigError("invalid result must have candidate and issues properties")
  }
  return {
    valid: false,
    candidate: candidate.value as JsonValue,
    issues: snapshotIssues(issues.value as readonly unknown[]),
  }
}

function snapshotIssues(issues: readonly unknown[]): readonly unknown[] {
  if (!Array.isArray(issues)) {
    throw new CAMConfigError("validation issues must be an array")
  }
  const copied: unknown[] = []
  for (let index = 0; index < issues.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(issues, String(index))
    if (!descriptor || !("value" in descriptor)) {
      throw new CAMConfigError("validation issues must be a dense array of data properties")
    }
    copied.push(descriptor.value)
  }
  return Object.freeze(copied)
}

function validateEntityId(value: unknown): asserts value is RecoveryEntityId {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new CAMConfigError("entityId must be a string or finite number")
  }
}

function validateSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CAMConfigError("sessionId must be a non-empty string")
  }
}

function validateDraftRevision(value: unknown): asserts value is DraftRevision {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new CAMConfigError("draftRevision must be a string or finite number")
  }
}

function validateVersion(value: unknown, label: string): asserts value is RecoveryVersion {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new CAMConfigError(`${label} must be a string or finite number`)
  }
}

function normalizeVersion<V extends RecoveryVersion>(version: V): V {
  return (typeof version === "number" && Object.is(version, -0) ? 0 : version) as V
}

function readLatestState<
  S extends JsonValue,
  L extends { readonly state: S },
>(latest: L): S {
  if (typeof latest !== "object" || latest === null || Array.isArray(latest)) {
    throw new CAMConfigError("fetchLatest must return an object with state")
  }
  const state = Object.getOwnPropertyDescriptor(latest, "state")
  if (!state || !("value" in state)) {
    throw new CAMConfigError("fetchLatest state must be an own data property")
  }
  return state.value as S
}
