import { CAMConfigError } from "./errors.js"
import {
  conflictKey,
  mergeSnapshotResult,
  mergeSnapshotsWithChoices,
  snapshotMergeStates,
} from "./merge-states.js"
import type { MergeDecisionSelection } from "./merge-states.js"
import { snapshotJsonValue } from "./validation.js"
import type {
  AdvancedApplyConflictDecisionsInput,
  AdvancedMergeResult,
  ApplyConflictDecisionsInput,
  ConflictChoice,
  ConflictValue,
  ExtendedConflict,
  ExtendedGroupConflict,
  ExtendedGroupConflictSlot,
  ExtendedPathSegment,
  GroupedMergeResult,
  GroupedMergeResultWithReport,
  JsonValue,
  MergeConflict,
  MergeResult,
  MergeResultWithReport,
  NormalizedAdvancedApplyConflictDecisionsInput,
  NormalizedApplyConflictDecisionsInput,
  PathGroup,
  RuleConflict,
} from "./types.js"

type AnyConflict = MergeConflict | ExtendedConflict | ExtendedGroupConflict | RuleConflict

function requiredOwnData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) {
    throw new CAMConfigError(`applyConflictDecisions input must define own ${key}`)
  }
  if (!("value" in descriptor)) {
    throw new CAMConfigError(
      `applyConflictDecisions input.${key} must not be an accessor property`,
    )
  }
  return descriptor.value
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = expected.slice().sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new CAMConfigError(`${label} has an invalid shape`)
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CAMConfigError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function normalizeConflictValue(value: unknown, label: string): ConflictValue {
  const record = asRecord(value, label)
  const exists = record.exists
  if (exists === false) {
    assertExactKeys(record, ["exists"], label)
    return { exists: false }
  }
  if (exists !== true) {
    throw new CAMConfigError(`${label}.exists must be a boolean`)
  }
  assertExactKeys(record, ["exists", "value"], label)
  return {
    exists: true,
    value: snapshotJsonValue(record.value, `${label}.value`),
  }
}

function normalizeSegment(segment: JsonValue, label: string): ExtendedPathSegment {
  if (typeof segment === "string" || typeof segment === "number") return segment
  if (typeof segment === "object" && segment !== null && !Array.isArray(segment)) {
    const record = segment as Record<string, JsonValue>
    const keys = Object.keys(record).sort()
    if (
      keys.length === 2 && keys[0] === "key" && keys[1] === "value" &&
      typeof record.key === "string" &&
      (typeof record.value === "string" || typeof record.value === "number")
    ) {
      return { key: record.key, value: record.value }
    }
    if (
      keys.length === 2 && keys[0] === "from" && keys[1] === "to" &&
      typeof record.from === "number" && typeof record.to === "number"
    ) {
      return { from: record.from, to: record.to }
    }
  }
  throw new CAMConfigError(`${label} must be a string, number, item segment, or range segment`)
}

function normalizePath(value: unknown, label: string): ExtendedPathSegment[] {
  const path = snapshotJsonValue(value, label)
  if (!Array.isArray(path)) throw new CAMConfigError(`${label} must be an array`)
  return path.map((segment, index) => normalizeSegment(segment, `${label}[${index}]`))
}

function normalizeGroupConflictSlots(
  value: unknown,
  label: string,
): ExtendedGroupConflictSlot[] {
  const slots = snapshotJsonValue(value, label)
  if (!Array.isArray(slots)) throw new CAMConfigError(`${label} must be an array`)
  return slots.map((slot, index) => {
    const slotLabel = `${label}[${index}]`
    const record = asRecord(slot, slotLabel)
    assertExactKeys(record, ["path", "value"], slotLabel)
    return {
      path: normalizePath(record.path, `${slotLabel}.path`),
      value: normalizeConflictValue(record.value, `${slotLabel}.value`),
    }
  })
}

function normalizePaths(value: unknown, label: string): ExtendedPathSegment[][] {
  const pathsValue = snapshotJsonValue(value, label)
  if (!Array.isArray(pathsValue)) throw new CAMConfigError(`${label} must be an array`)
  return pathsValue.map((path, index) => normalizePath(path, `${label}[${index}]`))
}

function normalizeConflict(value: unknown, label: string): AnyConflict {
  const record = asRecord(value, label)
  if (record.kind === "group") {
    const hasBinding = Object.hasOwn(record, "binding")
    assertExactKeys(
      record,
      hasBinding
        ? ["kind", "groupId", "binding", "paths", "submitted", "currentServer"]
        : ["kind", "groupId", "paths", "submitted", "currentServer"],
      label,
    )
    if (typeof record.groupId !== "string" || record.groupId.length === 0) {
      throw new CAMConfigError(`${label}.groupId must be a non-empty string`)
    }
    const paths = normalizePaths(record.paths, `${label}.paths`)
    if (paths.length === 0) throw new CAMConfigError(`${label}.paths must be a non-empty array`)
    const conflict: ExtendedGroupConflict = { kind: "group", groupId: record.groupId, paths, submitted: [], currentServer: [] }
    if (hasBinding) {
      conflict.binding = normalizeSegment(snapshotJsonValue(record.binding, `${label}.binding`), `${label}.binding`)
    }
    conflict.submitted = normalizeGroupConflictSlots(record.submitted, `${label}.submitted`)
    conflict.currentServer = normalizeGroupConflictSlots(record.currentServer, `${label}.currentServer`)
    return conflict
  }
  if (record.kind === "rule") {
    assertExactKeys(record, ["kind", "ruleId", "message", "paths", "submitted", "currentServer"], label)
    if (typeof record.ruleId !== "string" || record.ruleId.length === 0) {
      throw new CAMConfigError(`${label}.ruleId must be a non-empty string`)
    }
    if (typeof record.message !== "string") throw new CAMConfigError(`${label}.message must be a string`)
    const conflict: RuleConflict = {
      kind: "rule",
      ruleId: record.ruleId,
      message: record.message,
      paths: normalizePaths(record.paths, `${label}.paths`),
      submitted: normalizeGroupConflictSlots(record.submitted, `${label}.submitted`),
      currentServer: normalizeGroupConflictSlots(record.currentServer, `${label}.currentServer`),
    }
    return conflict
  }

  const hasReason = Object.hasOwn(record, "reason")
  assertExactKeys(
    record,
    hasReason ? ["path", "submitted", "currentServer", "reason"] : ["path", "submitted", "currentServer"],
    label,
  )
  const conflict: ExtendedConflict = {
    path: normalizePath(record.path, `${label}.path`),
    submitted: normalizeConflictValue(record.submitted, `${label}.submitted`),
    currentServer: normalizeConflictValue(
      record.currentServer,
      `${label}.currentServer`,
    ),
  }
  if (hasReason) {
    if (record.reason !== "order") throw new CAMConfigError(`${label}.reason must be "order"`)
    conflict.reason = "order"
  }
  return conflict
}

function normalizeDecisions(value: unknown): MergeDecisionSelection[] {
  const snapshot = snapshotJsonValue(value, "decisions")
  if (!Array.isArray(snapshot)) {
    throw new CAMConfigError("decisions must be an array")
  }

  return snapshot.map((item, index) => {
    const label = `decisions[${index}]`
    const record = asRecord(item, label)
    assertExactKeys(record, ["sessionId", "conflict", "choice"], label)
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
      throw new CAMConfigError(`${label}.sessionId must be a non-empty string`)
    }
    if (record.choice !== "submitted" && record.choice !== "currentServer") {
      throw new CAMConfigError(
        `${label}.choice must be "submitted" or "currentServer"`,
      )
    }

    return {
      conflict: normalizeConflict(record.conflict, `${label}.conflict`),
      choice: record.choice as ConflictChoice,
      // Session IDs are checked against the call-level session below. Keep the
      // validated value attached without trusting caller-owned objects.
      sessionId: record.sessionId,
    } as MergeDecisionSelection & { sessionId: string }
  })
}

// Paths compare strictly: a decision for property "0" must not bind to a
// conflict at numeric segment 0 (or the reverse).
function strictPaths(conflict: AnyConflict): string {
  const paths = "kind" in conflict
    ? [
        conflict.paths,
        conflict.submitted.map(({ path }) => path),
        conflict.currentServer.map(({ path }) => path),
        conflict.kind === "group" ? (conflict as ExtendedGroupConflict).binding ?? null : null,
      ]
    : conflict.path
  return JSON.stringify(paths)
}

function sameConflict(left: AnyConflict, right: AnyConflict): boolean {
  return conflictKey(left) === conflictKey(right) && strictPaths(left) === strictPaths(right)
}

type RuntimeResult = ReturnType<typeof mergeSnapshotResult>

function applyDecisions(
  input:
    | ApplyConflictDecisionsInput
    | NormalizedApplyConflictDecisionsInput
    | AdvancedApplyConflictDecisionsInput
    | NormalizedAdvancedApplyConflictDecisionsInput,
): RuntimeResult {
  const snapshots = snapshotMergeStates(input)
  const record = asRecord(input, "applyConflictDecisions input")
  const sessionId = requiredOwnData(record, "sessionId")
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new CAMConfigError("sessionId must be a non-empty string")
  }
  const decisions = normalizeDecisions(requiredOwnData(record, "decisions"))
  for (const decision of decisions) {
    if ((decision as MergeDecisionSelection & { sessionId: string }).sessionId !== sessionId) {
      throw new CAMConfigError("decision sessionId does not match the current session")
    }
  }

  // Decisions may accumulate across rounds: rule conflicts are revealed only
  // once structural conflicts are resolved. Replay them round by round, always
  // against conflicts recomputed from these same snapshots. Every round must be
  // covered completely, and every decision must match some round.
  let pending = decisions.map(({ conflict, choice }): MergeDecisionSelection => ({ conflict, choice }))
  const accepted: MergeDecisionSelection[] = []
  let current = mergeSnapshotResult(snapshots)
  for (let round = 0; ; round += 1) {
    if (current.ok || current.kind === "review") {
      if (pending.length !== 0) {
        throw new CAMConfigError(
          round === 0
            ? "decisions are stale because the current merge has no conflicts"
            : "decision conflict is stale or does not match a current conflict",
        )
      }
      return current
    }
    const currentConflicts: readonly AnyConflict[] = current.conflicts
    if (pending.length === 0) {
      if (round === 0 && currentConflicts.length > 0) {
        throw new CAMConfigError(
          "decisions must contain exactly one choice for every current conflict",
        )
      }
      // Either an invalid result with nothing to decide, or conflicts newly
      // revealed by this round's choices: return them for the next round.
      return current
    }
    if (currentConflicts.length === 0) {
      throw new CAMConfigError("decision conflict is stale or does not match a current conflict")
    }

    const assigned = new Array<boolean>(currentConflicts.length).fill(false)
    const matched: MergeDecisionSelection[] = []
    const rest: MergeDecisionSelection[] = []
    for (const decision of pending) {
      const index = currentConflicts.findIndex((conflict) => sameConflict(conflict, decision.conflict as AnyConflict))
      if (index < 0) {
        rest.push(decision)
        continue
      }
      if (assigned[index]) throw new CAMConfigError("duplicate decision for a current conflict")
      assigned[index] = true
      matched.push(decision)
    }
    if (matched.length < currentConflicts.length) {
      throw new CAMConfigError(
        matched.length === 0 || rest.length > 0
          ? "decision conflict is stale or does not match a current conflict"
          : "decisions must contain exactly one choice for every current conflict",
      )
    }
    for (const decision of matched) accepted.push(decision)
    pending = rest
    current = mergeSnapshotsWithChoices(snapshots, accepted)
  }
}

export function applyConflictDecisions<T extends JsonValue>(
  input: ApplyConflictDecisionsInput<T> & { groups: readonly PathGroup[]; includeReport: true },
): GroupedMergeResultWithReport<T>
export function applyConflictDecisions<T extends JsonValue>(
  input: ApplyConflictDecisionsInput<T> & { groups: readonly PathGroup[]; includeReport?: never },
): GroupedMergeResult<T>
export function applyConflictDecisions<T extends JsonValue>(
  input: ApplyConflictDecisionsInput<T> & { groups?: never; includeReport: true },
): MergeResultWithReport<T>
export function applyConflictDecisions<T extends JsonValue>(
  input: ApplyConflictDecisionsInput<T> & { groups?: never; includeReport?: never },
): MergeResult<T>
export function applyConflictDecisions<T extends JsonValue>(
  input: ApplyConflictDecisionsInput<T>,
):
  | MergeResult<T>
  | GroupedMergeResult<T>
  | MergeResultWithReport<T>
  | GroupedMergeResultWithReport<T>
export function applyConflictDecisions(
  input: NormalizedApplyConflictDecisionsInput & { groups: readonly PathGroup[]; includeReport: true },
): GroupedMergeResultWithReport<JsonValue>
export function applyConflictDecisions(
  input: NormalizedApplyConflictDecisionsInput & { groups: readonly PathGroup[]; includeReport?: never },
): GroupedMergeResult<JsonValue>
export function applyConflictDecisions(
  input: NormalizedApplyConflictDecisionsInput & { groups?: never; includeReport: true },
): MergeResultWithReport<JsonValue>
export function applyConflictDecisions(
  input: NormalizedApplyConflictDecisionsInput & { groups?: never; includeReport?: never },
): MergeResult<JsonValue>
export function applyConflictDecisions(
  input: NormalizedApplyConflictDecisionsInput,
):
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue>
export function applyConflictDecisions<T extends JsonValue>(
  input: AdvancedApplyConflictDecisionsInput<T>,
): AdvancedMergeResult<T>
export function applyConflictDecisions(
  input: NormalizedAdvancedApplyConflictDecisionsInput,
): AdvancedMergeResult<JsonValue>
export function applyConflictDecisions<T extends JsonValue>(
  input:
    | ApplyConflictDecisionsInput<T>
    | NormalizedApplyConflictDecisionsInput
    | AdvancedApplyConflictDecisionsInput<T>
    | NormalizedAdvancedApplyConflictDecisionsInput,
):
  | MergeResult<T>
  | GroupedMergeResult<T>
  | MergeResultWithReport<T>
  | GroupedMergeResultWithReport<T>
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue>
  | AdvancedMergeResult<T>
  | AdvancedMergeResult<JsonValue> {
  return applyDecisions(input) as AdvancedMergeResult<T>
}
