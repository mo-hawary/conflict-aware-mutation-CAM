import type {
  AdvancedMergeConflict,
  ArrayMergeOptions,
  AutoMergePolicy,
  ErrorSignal,
  JsonValue,
  JsonValueWithUndefinedObjectProperties,
  MergeConflict,
  MergeRule,
  PathGroup,
  PathPattern,
  PatternPathGroup,
  RuleViolation,
} from "../types.js"

export type RecoveryVersion = string | number
export type RecoveryEntityId = string | number
export type DraftRevision = string | number

export type RecoveryAttempt = "initial" | "recovery"

export type RecoveryIdentity<E extends RecoveryEntityId = RecoveryEntityId> = {
  readonly entityId: E
  readonly sessionId: string
  readonly draftRevision: DraftRevision
}

export type RecoveryContext<
  E extends RecoveryEntityId = RecoveryEntityId,
  V extends RecoveryVersion = RecoveryVersion,
> = RecoveryIdentity<E> & {
  /** The server version used to produce this candidate. */
  readonly latestVersion: V
}

export type RecoverySnapshot<S extends JsonValue = JsonValue> = {
  readonly state: S
}

export type RecoveryMutationResult<
  T extends JsonValue = JsonValue,
  V extends RecoveryVersion = RecoveryVersion,
> = {
  readonly state: T
  readonly version: V
}

export type CandidateValidation<T extends JsonValue = JsonValue> =
  | { readonly valid: true; readonly value: T }
  | {
      readonly valid: false
      readonly candidate: JsonValue
      readonly issues: readonly unknown[]
    }

export type RecoveryStage =
  | "mutate"
  | "isStaleError"
  | "fetchLatest"
  | "getVersion"
  | "isTerminal"
  | "merge"
  | "project"
  | "prepareCandidate"
  | "validateCandidate"
  | "isCurrent"

/**
 * An opaque in-memory capability. Keep and pass back the exact token object
 * returned by a review-ready outcome; tokens are intentionally not serializable.
 */
declare const recoveryTokenBrand: unique symbol
export type RecoveryToken = { readonly [recoveryTokenBrand]: true }

/** Opaque capability for completing a conflicted session after manual choices. */
declare const recoverySessionHandleBrand: unique symbol
export type RecoverySessionHandle = { readonly [recoverySessionHandleBrand]: true }

export type RecoveryOutcome<
  T extends JsonValue = JsonValue,
  S extends JsonValue = JsonValue,
  V extends RecoveryVersion = RecoveryVersion,
  E extends RecoveryEntityId = RecoveryEntityId,
> =
  | {
      readonly kind: "review-ready"
      readonly candidate: T
      readonly latestVersion: V
      readonly sessionId: string
      readonly token: RecoveryToken
    }
  | {
      readonly kind: "conflicts"
      readonly sessionId: string
      /** Includes item, range, order and rule conflicts when those options are set. */
      readonly conflicts: (MergeConflict | AdvancedMergeConflict)[]
      readonly currentServerState: S
      readonly latestVersion: V
      readonly handle: RecoverySessionHandle
    }
  | {
      /** A configured rule is broken by the submitted or latest server state. */
      readonly kind: "invalid"
      readonly sessionId: string
      readonly violations: RuleViolation[]
      readonly conflicts: (MergeConflict | AdvancedMergeConflict)[]
      readonly currentServerState: S
      readonly latestVersion: V
      readonly handle: RecoverySessionHandle
    }
  | {
      readonly kind: "validation-failed"
      readonly sessionId: string
      readonly candidate: JsonValue
      readonly issues: readonly unknown[]
      readonly latestVersion: V
      readonly handle: RecoverySessionHandle
    }
  | {
      readonly kind: "terminal"
      readonly currentServerState: S
      readonly latestVersion: V
    }
  | {
      readonly kind: "changed-again"
      readonly candidate: T
      /**
       * Server snapshot that produced the candidate. Reuse this snapshot
       * together with latestVersion as the next recovery baseline.
       */
      readonly currentServerState: S
      /** Last version fetched; a newer version may now exist on the server. */
      readonly latestVersion: V
      readonly sessionId: string
    }
  | {
      readonly kind: "failed"
      readonly stage: RecoveryStage
      readonly cause: unknown
    }
  | { readonly kind: "cancelled" | "obsolete" | "busy" }
  | {
      readonly kind: "saved"
      readonly state: T
      readonly version: V
    }

export type RecoveryLatest<L extends RecoverySnapshot = RecoverySnapshot> = L

type RecoveryControllerBaseOptions<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue,
  E extends RecoveryEntityId,
  L extends RecoverySnapshot<S>,
> = {
  /** Exact stale-error matcher. `errorSignalFrom` may return undefined for other errors. */
  readonly expectedError: ErrorSignal
  readonly errorSignalFrom: (
    cause: unknown,
  ) => ErrorSignal | undefined | Promise<ErrorSignal | undefined>
  /** The latest record can carry opaque adapter metadata such as an ETag. */
  readonly fetchLatest: (entityId: E) => L | Promise<L>
  readonly getVersion: (latest: L) => V | Promise<V>
  readonly isTerminal: (state: S, latest: L) => boolean | Promise<boolean>
  readonly project: (
    merged: JsonValue,
    currentServerState: S,
    latest: L,
  ) => JsonValue | Promise<JsonValue>
  readonly prepareCandidate: (
    candidate: JsonValue,
    context: RecoveryContext<E, V>,
  ) => T | Promise<T>
  readonly validateCandidate: (
    candidate: T,
    context: RecoveryContext<E, V>,
  ) => CandidateValidation<T> | Promise<CandidateValidation<T>>
  /** Every invocation receives a required version precondition. */
  readonly mutate: (
    candidate: T,
    options: {
      readonly entityId: E
      readonly expectedVersion: V
      readonly attempt: RecoveryAttempt
    },
  ) => RecoveryMutationResult<T, V> | Promise<RecoveryMutationResult<T, V>>
  /** Synchronous host guard for navigation, replacement sessions, and edits. */
  readonly isCurrent: (identity: RecoveryIdentity<E>) => boolean
  /** Omission means review-first. "once" allows one automatic recovery write. */
  readonly autoRetry?: "once"
  /** Coupled paths (optionally with ANY/EACH patterns) forwarded to the recovery merge. */
  readonly groups?: readonly (PathGroup | PatternPathGroup)[]
  /** Array merge modes forwarded to the recovery merge. */
  readonly arrays?: ArrayMergeOptions
  /** Computed paths excluded from merging; recompute them in prepareCandidate. */
  readonly derived?: readonly PathPattern[]
  /** Rules checked against both inputs and the merged candidate. */
  readonly rules?: readonly MergeRule[]
  /**
   * "review-mixed" never auto-writes a candidate that combines both sides'
   * changes, even with autoRetry: "once".
   */
  readonly autoMerge?: AutoMergePolicy
}

/**
 * Strict recovery controller configuration. Inputs and callback values remain
 * typed as the caller's JSON-compatible domain types.
 */
export type RecoveryControllerOptions<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue = JsonValue,
  E extends RecoveryEntityId = RecoveryEntityId,
  L extends RecoverySnapshot<S> = RecoverySnapshot<S>,
> = RecoveryControllerBaseOptions<S, V, T, E, L> & {
  readonly undefinedObjectProperties?: never
}

/**
 * Normalized recovery configuration. Because omitting `undefined` object
 * properties can remove fields that a domain type marks as required, the
 * controller intentionally exposes normalized state and mutation values as
 * broad `JsonValue` until application validation narrows them again.
 */
export type NormalizedRecoveryControllerOptions<
  V extends RecoveryVersion,
  E extends RecoveryEntityId = RecoveryEntityId,
  L extends RecoverySnapshot<JsonValue> = RecoverySnapshot<JsonValue>,
> = RecoveryControllerBaseOptions<JsonValue, V, JsonValue, E, L> & {
  readonly undefinedObjectProperties: "omit"
}

/** Internal implementation shape shared by strict and normalized overloads. */
export type RecoveryControllerInternalOptions<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue,
  E extends RecoveryEntityId,
  L extends RecoverySnapshot<S>,
> = RecoveryControllerBaseOptions<S, V, T, E, L> & {
  readonly undefinedObjectProperties?: "omit"
}

export type RecoverInput<
  S extends JsonValue,
  T extends JsonValue,
  V extends RecoveryVersion,
  E extends RecoveryEntityId,
> = {
  readonly entityId: E
  readonly sessionId: string
  readonly draftRevision: DraftRevision
  readonly expectedVersion: V
  readonly originalState: S
  readonly submittedState: T
}

export type NormalizedRecoverInput<
  V extends RecoveryVersion,
  E extends RecoveryEntityId,
> = {
  readonly entityId: E
  readonly sessionId: string
  readonly draftRevision: DraftRevision
  readonly expectedVersion: V
  readonly originalState: JsonValueWithUndefinedObjectProperties
  readonly submittedState: JsonValueWithUndefinedObjectProperties
}

export type ReviseCandidateInput = {
  readonly sessionId: string
  readonly candidate: JsonValue
  readonly draftRevision: DraftRevision
}

export type RecoveryController<
  S extends JsonValue,
  V extends RecoveryVersion,
  T extends JsonValue = JsonValue,
  E extends RecoveryEntityId = RecoveryEntityId,
> = {
  recover(input: RecoverInput<S, T, V, E>): Promise<RecoveryOutcome<T, S, V, E>>
  reviseCandidate(
    capability: RecoveryToken | RecoverySessionHandle,
    candidate: JsonValue,
    draftRevision: DraftRevision,
  ): Promise<RecoveryOutcome<T, S, V, E>>
  confirm(token: RecoveryToken): Promise<RecoveryOutcome<T, S, V, E>>
  cancel(): void
}

export type NormalizedRecoveryController<
  V extends RecoveryVersion,
  E extends RecoveryEntityId = RecoveryEntityId,
> = {
  recover(
    input: NormalizedRecoverInput<V, E>,
  ): Promise<RecoveryOutcome<JsonValue, JsonValue, V, E>>
  reviseCandidate(
    capability: RecoveryToken | RecoverySessionHandle,
    candidate: JsonValue,
    draftRevision: DraftRevision,
  ): Promise<RecoveryOutcome<JsonValue, JsonValue, V, E>>
  confirm(
    token: RecoveryToken,
  ): Promise<RecoveryOutcome<JsonValue, JsonValue, V, E>>
  cancel(): void
}
