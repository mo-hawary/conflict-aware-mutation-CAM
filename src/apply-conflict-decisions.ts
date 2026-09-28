import { CAMConfigError } from "./errors.js"
import {
  mergeSnapshotResult,
  mergeSnapshotsWithChoices,
  snapshotMergeStates,
} from "./merge-states.js"
import type { MergeDecisionSelection } from "./merge-states.js"
import { snapshotJsonValue } from "./validation.js"
import type {
  ApplyConflictDecisionsInput,
  Conflict,
  ConflictChoice,
  ConflictValue,
  GroupConflict,
  GroupConflictSlot,
  GroupedMergeResult,
  GroupedMergeResultWithReport,
  JsonValue,
  MergeConflict,
  MergeResult,
  MergeResultWithReport,
  NormalizedApplyConflictDecisionsInput,
  PathGroup,
  PathSegment,
} from "./types.js"

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

function normalizePath(value: unknown, label: string): PathSegment[] {
  const path = snapshotJsonValue(value, label)
  if (!Array.isArray(path)) throw new CAMConfigError(`${label} must be an array`)
  return path.map((segment, index) => {
    if (typeof segment !== "string" && typeof segment !== "number") {
      throw new CAMConfigError(`${label}[${index}] must be a string or number`)
    }
    return segment
  })
}

function normalizeGroupConflictSlots(
  value: unknown,
  label: string,
): GroupConflictSlot[] {
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

function normalizeConflict(value: unknown, label: string): MergeConflict {
  const record = asRecord(value, label)
  if (record.kind === "group") {
    assertExactKeys(record, ["kind", "groupId", "paths", "submitted", "currentServer"], label)
    if (typeof record.groupId !== "string" || record.groupId.length === 0) {
      throw new CAMConfigError(`${label}.groupId must be a non-empty string`)
    }
    const pathsValue = snapshotJsonValue(record.paths, `${label}.paths`)
    if (!Array.isArray(pathsValue) || pathsValue.length === 0) {
      throw new CAMConfigError(`${label}.paths must be a non-empty array`)
    }
    const conflict: GroupConflict = {
      kind: "group",
      groupId: record.groupId,
      paths: pathsValue.map((path, index) => normalizePath(path, `${label}.paths[${index}]`)),
      submitted: normalizeGroupConflictSlots(record.submitted, `${label}.submitted`),
      currentServer: normalizeGroupConflictSlots(record.currentServer, `${label}.currentServer`),
    }
    return conflict
  }

  assertExactKeys(record, ["path", "submitted", "currentServer"], label)
  const conflict: Conflict = {
    path: normalizePath(record.path, `${label}.path`),
    submitted: normalizeConflictValue(record.submitted, `${label}.submitted`),
    currentServer: normalizeConflictValue(
      record.currentServer,
      `${label}.currentServer`,
    ),
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

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object") return false
  if (left === null || right === null) return false

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameJsonValue(value, right[index]!))
  }
  if (Array.isArray(right)) return false

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && sameJsonValue(left[key]!, right[key]!),
  )
}

function sameConflictValue(left: ConflictValue, right: ConflictValue): boolean {
  if (left.exists !== right.exists) return false
  return left.exists && right.exists ? sameJsonValue(left.value, right.value) : true
}

function samePath(left: readonly PathSegment[], right: readonly PathSegment[]): boolean {
  return left.length === right.length && left.every(
    (segment, index) => segment === right[index],
  )
}

function sameConflict(left: MergeConflict, right: MergeConflict): boolean {
  if ("kind" in left || "kind" in right) {
    if (!("kind" in left) || !("kind" in right)) return false
    return (
      left.kind === "group" &&
      right.kind === "group" &&
      left.groupId === right.groupId &&
      left.paths.length === right.paths.length &&
      left.paths.every((path, index) => samePath(path, right.paths[index]!)) &&
      left.submitted.length === right.submitted.length &&
      left.submitted.every((slot, index) =>
        samePath(slot.path, right.submitted[index]!.path) &&
        sameConflictValue(slot.value, right.submitted[index]!.value),
      ) &&
      left.currentServer.length === right.currentServer.length &&
      left.currentServer.every((slot, index) =>
        samePath(slot.path, right.currentServer[index]!.path) &&
        sameConflictValue(slot.value, right.currentServer[index]!.value),
      )
    )
  }
  return (
    left.path.length === right.path.length &&
    samePath(left.path, right.path) &&
    sameConflictValue(left.submitted, right.submitted) &&
    sameConflictValue(left.currentServer, right.currentServer)
  )
}

function applyDecisions(
  input: ApplyConflictDecisionsInput | NormalizedApplyConflictDecisionsInput,
):
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue> {
  const snapshots = snapshotMergeStates(input)
  const record = asRecord(input, "applyConflictDecisions input")
  const sessionId = requiredOwnData(record, "sessionId")
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new CAMConfigError("sessionId must be a non-empty string")
  }
  const decisions = normalizeDecisions(requiredOwnData(record, "decisions"))
  const current = mergeSnapshotResult(snapshots)

  if (current.ok) {
    if (decisions.length !== 0) {
      throw new CAMConfigError("decisions are stale because the current merge has no conflicts")
    }
    return current
  }

  const currentConflicts = current.conflicts
  if (decisions.length !== currentConflicts.length) {
    throw new CAMConfigError(
      "decisions must contain exactly one choice for every current conflict",
    )
  }

  const assigned = new Array<boolean>(currentConflicts.length).fill(false)
  for (const decision of decisions) {
    if ((decision as MergeDecisionSelection & { sessionId: string }).sessionId !== sessionId) {
      throw new CAMConfigError("decision sessionId does not match the current session")
    }

    const index = currentConflicts.findIndex((conflict) => sameConflict(conflict, decision.conflict))
    if (index < 0) {
      throw new CAMConfigError("decision conflict is stale or does not match a current conflict")
    }
    if (assigned[index]) throw new CAMConfigError("duplicate decision for a current conflict")
    assigned[index] = true
  }

  return mergeSnapshotsWithChoices(
    snapshots,
    decisions.map(({ conflict, choice }) => ({ conflict, choice })),
  )
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
  input: ApplyConflictDecisionsInput<T> | NormalizedApplyConflictDecisionsInput,
):
  | MergeResult<T>
  | GroupedMergeResult<T>
  | MergeResultWithReport<T>
  | GroupedMergeResultWithReport<T>
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue> {
  return applyDecisions(input)
}
