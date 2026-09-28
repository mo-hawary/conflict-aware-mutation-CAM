import type {
  ChangeProvenance,
  ChangeReportEntry,
  Conflict,
  ConflictChoice,
  ConflictValue,
  GroupChangeReportEntry,
  GroupConflict,
  GroupConflictSlot,
  GroupedMergeResult,
  GroupedMergeResultWithReport,
  JsonValue,
  MergeConflict,
  MergeResult,
  MergeResultWithReport,
  MergeStatesBaseInput,
  MergeStatesInput,
  MergeStatesWithOptionsInput,
  NormalizedMergeStatesInput,
  NormalizedMergeStatesWithOptionsInput,
  PathGroup,
  PathSegment,
  ReportSlot,
} from "./types.js"
import { CAMConfigError } from "./errors.js"
import { defineJsonProperty, snapshotJsonValue } from "./validation.js"

// Marks an absent object property (deletion). A symbol can never appear in a
// validated JSON snapshot, so it cannot collide with real data.
const ABSENT: unique symbol = Symbol("cam.absent")
type Slot = JsonValue | typeof ABSENT

type JsonObject = { [key: string]: JsonValue }

export type MergeStateSnapshots = Readonly<{
  originalState: JsonValue
  submittedState: JsonValue
  currentServerState: JsonValue
  groups: readonly NormalizedPathGroup[]
  grouped: boolean
  includeReport: boolean
}>

type NormalizedPathGroup = {
  id: string
  paths: PathSegment[][]
  pathKeys: string[][]
}

export type MergeDecisionSelection = {
  conflict: MergeConflict
  choice: ConflictChoice
}
type Decision = MergeDecisionSelection

type MergeComputation = {
  conflicts: MergeConflict[]
  candidate: Slot
  changes: ChangeReportEntry[] | undefined
}

const isPlainObject = (value: Slot): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Operands are canonical snapshots (see snapshotJsonValue): objects with the
// same key set enumerate keys in the same order, so no sorting is needed.
function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object") return false
  if (left === null || right === null) return false

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEqual(left[index]!, right[index]!)) return false
    }
    return true
  }

  if (Array.isArray(right)) return false

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false

  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!
    if (key !== rightKeys[index] || !jsonEqual(left[key]!, right[key]!)) {
      return false
    }
  }
  return true
}

function slotEqual(left: Slot, right: Slot): boolean {
  if (left === ABSENT || right === ABSENT) return left === right
  return jsonEqual(left, right)
}

const childSlot = (object: JsonObject, key: string): Slot =>
  Object.hasOwn(object, key) ? object[key]! : ABSENT

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  const copy: JsonObject = {}
  for (const key of Object.keys(value)) {
    defineJsonProperty(copy, key, cloneJsonValue(value[key]!))
  }
  return copy
}

const toConflictValue = (slot: Slot): ConflictValue =>
  slot === ABSENT
    ? { exists: false }
    : { exists: true, value: cloneJsonValue(slot) }

function sameKeys(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function isSorted(keys: string[]): boolean {
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1]! > keys[index]!) return false
  }
  return true
}

// Returns the sorted union of all keys. The common case (all three sides share
// one key set) skips the Set; canonical snapshots are already sorted unless
// they contain integer-like keys, which JS always enumerates first.
function unionKeys(a: JsonObject, b: JsonObject, c: JsonObject): string[] {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  const cKeys = Object.keys(c)

  if (sameKeys(aKeys, bKeys) && sameKeys(aKeys, cKeys)) {
    return isSorted(aKeys) ? aKeys : aKeys.sort()
  }

  const keys = new Set(aKeys)
  for (const key of bKeys) keys.add(key)
  for (const key of cKeys) keys.add(key)
  return Array.from(keys).sort()
}

function encodePath(path: readonly PathSegment[]): string {
  return JSON.stringify(path.map(String))
}

function clonePath(path: readonly PathSegment[]): PathSegment[] {
  return path.slice()
}

function comparePath(
  left: readonly PathSegment[],
  right: readonly PathSegment[],
): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftSegment = String(left[index])
    const rightSegment = String(right[index])
    if (leftSegment < rightSegment) return -1
    if (leftSegment > rightSegment) return 1
  }
  return left.length - right.length
}

function conflictSortPath(conflict: MergeConflict): readonly PathSegment[] {
  return "kind" in conflict ? conflict.paths[0]! : conflict.path
}

function compareConflicts(left: MergeConflict, right: MergeConflict): number {
  const pathOrder = comparePath(conflictSortPath(left), conflictSortPath(right))
  if (pathOrder !== 0) return pathOrder
  if ("kind" in left && "kind" in right) {
    return left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0
  }
  if ("kind" in left) return -1
  if ("kind" in right) return 1
  return 0
}

function compareChanges(left: ChangeReportEntry, right: ChangeReportEntry): number {
  const leftPath = left.kind === "group" ? left.original[0]!.path : left.path
  const rightPath = right.kind === "group" ? right.original[0]!.path : right.path
  const pathOrder = comparePath(leftPath, rightPath)
  if (pathOrder !== 0) return pathOrder
  if (left.kind === "group" && right.kind === "group") {
    return left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0
  }
  return left.kind === "group" ? -1 : right.kind === "group" ? 1 : 0
}

function sameSlotLists(left: readonly Slot[], right: readonly Slot[]): boolean {
  return left.length === right.length && left.every((slot, index) => slotEqual(slot, right[index]!))
}

// A group member beneath a scalar, array, or null ancestor is unaddressable on
// that side, so it reads as absent. The ancestor itself is merged atomically
// (see isSplittableGroupParent), which keeps shape changes in the data a
// conflict instead of a configuration error.
function slotAtPath(root: JsonValue, path: readonly PathSegment[]): Slot {
  let slot: Slot = root
  for (let index = 0; index < path.length; index += 1) {
    if (!isPlainObject(slot)) return ABSENT
    slot = childSlot(slot, String(path[index]))
  }
  return slot
}

function validateGroupPaths(rawGroups: unknown): NormalizedPathGroup[] {
  const value = snapshotJsonValue(rawGroups, "groups")
  if (!Array.isArray(value)) throw new CAMConfigError("groups must be an array")

  const ids = new Set<string>()
  const allPaths: { path: PathSegment[]; key: string[] }[] = []

  for (let groupIndex = 0; groupIndex < value.length; groupIndex += 1) {
    const rawGroup = value[groupIndex]!
    if (typeof rawGroup !== "object" || rawGroup === null || Array.isArray(rawGroup)) {
      throw new CAMConfigError(`groups[${groupIndex}] must be an object`)
    }
    const group = rawGroup as Record<string, JsonValue>
    const groupKeys = Object.keys(group).sort()
    if (groupKeys.length !== 2 || groupKeys[0] !== "id" || groupKeys[1] !== "paths") {
      throw new CAMConfigError(`groups[${groupIndex}] must contain only id and paths`)
    }
    if (typeof group.id !== "string" || group.id.length === 0) {
      throw new CAMConfigError(`groups[${groupIndex}].id must be a non-empty string`)
    }
    if (ids.has(group.id)) throw new CAMConfigError(`duplicate path group id: ${group.id}`)
    ids.add(group.id)
    if (!Array.isArray(group.paths) || group.paths.length === 0) {
      throw new CAMConfigError(`groups[${groupIndex}].paths must be a non-empty array`)
    }

    for (let pathIndex = 0; pathIndex < group.paths.length; pathIndex += 1) {
      const rawPath = group.paths[pathIndex]!
      if (!Array.isArray(rawPath) || rawPath.length === 0) {
        throw new CAMConfigError(
          `groups[${groupIndex}].paths[${pathIndex}] must be a non-empty path (root paths are not allowed)`,
        )
      }
      const path: PathSegment[] = rawPath.map((segment, segmentIndex) => {
        if (typeof segment === "string") return segment
        if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
          return segment
        }
        throw new CAMConfigError(
          `groups[${groupIndex}].paths[${pathIndex}][${segmentIndex}] must be a string or non-negative safe integer`,
        )
      })
      const key = path.map(String)
      for (const existing of allPaths) {
        const commonLength = Math.min(key.length, existing.key.length)
        const isPrefix = key
          .slice(0, commonLength)
          .every((segment, index) => segment === existing.key[index])
        if (isPrefix) {
          throw new CAMConfigError(
            `path groups must not contain duplicate, overlapping, or ancestor paths (${JSON.stringify(path)} and ${JSON.stringify(existing.path)})`,
          )
        }
      }
      allPaths.push({ path, key })
    }
  }

  // Canonicalize members so group tuples and reports are deterministic even
  // when callers configured a different member order.
  const normalized: NormalizedPathGroup[] = []
  for (const group of value as unknown as { id: string; paths: PathSegment[][] }[]) {
    const paths = group.paths.map((path) => path.slice()).sort(comparePath)
    normalized.push({ id: group.id, paths, pathKeys: paths.map((path) => path.map(String)) })
  }
  return normalized
}

function requiredOwnValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor)) {
    throw new CAMConfigError(`merge input.${key} must not be an accessor property`)
  }
  return descriptor.value
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CAMConfigError("merge input must be an object")
  }
  return input as Record<string, unknown>
}

export function snapshotMergeStates(
  input:
    | MergeStatesInput
    | MergeStatesWithOptionsInput
    | NormalizedMergeStatesInput
    | NormalizedMergeStatesWithOptionsInput,
): MergeStateSnapshots {
  const record = inputRecord(input)
  const undefinedPropertiesDescriptor = Object.getOwnPropertyDescriptor(
    record,
    "undefinedObjectProperties",
  )
  const undefinedPropertiesValue = requiredOwnValue(record, "undefinedObjectProperties")
  let undefinedObjectProperties: "omit" | undefined
  if (undefinedPropertiesDescriptor !== undefined) {
    if (undefinedPropertiesValue !== "omit") {
      throw new CAMConfigError('undefinedObjectProperties must be "omit" when provided')
    }
    undefinedObjectProperties = "omit"
  }

  const snapshots = {
    originalState: snapshotJsonValue(
      requiredOwnValue(record, "originalState"),
      "originalState",
      undefinedObjectProperties,
    ),
    submittedState: snapshotJsonValue(
      requiredOwnValue(record, "submittedState"),
      "submittedState",
      undefinedObjectProperties,
    ),
    currentServerState: snapshotJsonValue(
      requiredOwnValue(record, "currentServerState"),
      "currentServerState",
      undefinedObjectProperties,
    ),
  }

  const includeReportDescriptor = Object.getOwnPropertyDescriptor(record, "includeReport")
  const includeReportValue = requiredOwnValue(record, "includeReport")
  if (includeReportDescriptor !== undefined && includeReportValue !== true) {
    throw new CAMConfigError("includeReport must be true when provided")
  }

  const groupsDescriptor = Object.getOwnPropertyDescriptor(record, "groups")
  const groupsValue = requiredOwnValue(record, "groups")
  const grouped = groupsDescriptor !== undefined
  const groups = grouped ? validateGroupPaths(groupsValue) : []

  return { ...snapshots, groups, grouped, includeReport: includeReportValue === true }
}

type GroupEvaluation = {
  group: NormalizedPathGroup
  original: Slot[]
  submitted: Slot[]
  currentServer: Slot[]
  result?: Slot[]
  provenance: ChangeProvenance
  conflict?: GroupConflict
}

function makeGroupSlotList(group: NormalizedPathGroup, slots: readonly Slot[]): ReportSlot[] {
  return group.paths.map((path, index) => ({
    path: clonePath(path),
    value: toConflictValue(slots[index]!),
  }))
}

function makeGroupConflict(
  group: NormalizedPathGroup,
  submitted: readonly Slot[],
  currentServer: readonly Slot[],
): GroupConflict {
  const slots = (values: readonly Slot[]): GroupConflictSlot[] =>
    group.paths.map((path, index) => ({
      path: clonePath(path),
      value: toConflictValue(values[index]!),
    }))
  return {
    kind: "group",
    groupId: group.id,
    paths: group.paths.map(clonePath),
    submitted: slots(submitted),
    currentServer: slots(currentServer),
  }
}

function conflictKey(conflict: MergeConflict): string {
  return "kind" in conflict
    ? JSON.stringify([
        "group",
        conflict.groupId,
        conflict.paths.map((path) => path.map(String)),
        conflict.submitted.map(({ value }) => value),
        conflict.currentServer.map(({ value }) => value),
      ])
    : JSON.stringify([
        "path",
        conflict.path.map(String),
        conflict.submitted,
        conflict.currentServer,
      ])
}

function choicesByKey(decisions: readonly Decision[]): Map<string, ConflictChoice> {
  return new Map(decisions.map(({ conflict, choice }) => [conflictKey(conflict), choice]))
}

// A member beneath an ancestor that must merge atomically (see
// isSplittableGroupParent) cannot be selected on its own. The group then
// couples that whole ancestor instead, so one choice decides every member and
// the parent never raises a second, separate conflict. An ancestor already
// claimed by an earlier group stays with that group.
function effectiveGroup(
  group: NormalizedPathGroup,
  snapshots: MergeStateSnapshots,
  claimed: Set<string>,
): NormalizedPathGroup | undefined {
  const byKey = new Map<string, PathSegment[]>()
  for (const path of group.paths) {
    let effective = path
    for (let length = 0; length < path.length; length += 1) {
      const prefix = path.slice(0, length)
      if (!isSplittableGroupParent(
        slotAtPath(snapshots.originalState, prefix),
        slotAtPath(snapshots.submittedState, prefix),
        slotAtPath(snapshots.currentServerState, prefix),
      )) {
        effective = prefix
        break
      }
    }
    const key = encodePath(effective)
    if (effective !== path && claimed.has(key)) continue
    byKey.set(key, effective)
  }
  for (const key of byKey.keys()) claimed.add(key)
  if (byKey.size === 0) return undefined
  const paths = Array.from(byKey.values()).sort(comparePath)
  return { id: group.id, paths, pathKeys: paths.map((path) => path.map(String)) }
}

function groupEvaluations(
  snapshots: MergeStateSnapshots,
  decisions: ReadonlyMap<string, ConflictChoice>,
): GroupEvaluation[] {
  const claimed = new Set<string>()
  const groups: NormalizedPathGroup[] = []
  for (const configured of snapshots.groups) {
    const group = effectiveGroup(configured, snapshots, claimed)
    if (group !== undefined) groups.push(group)
  }
  return groups.map((group): GroupEvaluation => {
    const original = group.paths.map((path) => slotAtPath(snapshots.originalState, path))
    const submitted = group.paths.map((path) => slotAtPath(snapshots.submittedState, path))
    const currentServer = group.paths.map((path) => slotAtPath(snapshots.currentServerState, path))
    const submittedOriginal = sameSlotLists(submitted, original)
    const currentOriginal = sameSlotLists(currentServer, original)
    const submittedCurrent = sameSlotLists(submitted, currentServer)

    if (submittedOriginal && currentOriginal) {
      return { group, original, submitted, currentServer, result: currentServer, provenance: "identical-both" }
    }
    if (submittedOriginal) {
      return { group, original, submitted, currentServer, result: currentServer, provenance: "server-only" }
    }
    if (currentOriginal) {
      return { group, original, submitted, currentServer, result: submitted, provenance: "submitted-only" }
    }
    if (submittedCurrent) {
      return { group, original, submitted, currentServer, result: submitted, provenance: "identical-both" }
    }

    const conflict = makeGroupConflict(group, submitted, currentServer)
    const choice = decisions.size > 0 ? decisions.get(conflictKey(conflict)) : undefined
    if (choice === "submitted") {
      return { group, original, submitted, currentServer, result: submitted, provenance: "chosen-submitted" }
    }
    if (choice === "currentServer") {
      return { group, original, submitted, currentServer, result: currentServer, provenance: "chosen-currentServer" }
    }
    return { group, original, submitted, currentServer, provenance: "unresolved", conflict }
  })
}

function pathChange(
  path: readonly PathSegment[],
  original: Slot,
  submitted: Slot,
  currentServer: Slot,
  result: Slot | undefined,
  provenance: ChangeProvenance,
): ChangeReportEntry {
  const entry: ChangeReportEntry = {
    kind: "path",
    path: clonePath(path),
    original: toConflictValue(original),
    submitted: toConflictValue(submitted),
    currentServer: toConflictValue(currentServer),
    provenance,
  }
  if (result !== undefined) entry.result = toConflictValue(result)
  return entry
}

function groupChange(evaluation: GroupEvaluation): GroupChangeReportEntry {
  const entry: GroupChangeReportEntry = {
    kind: "group",
    groupId: evaluation.group.id,
    original: makeGroupSlotList(evaluation.group, evaluation.original),
    submitted: makeGroupSlotList(evaluation.group, evaluation.submitted),
    currentServer: makeGroupSlotList(evaluation.group, evaluation.currentServer),
    provenance: evaluation.provenance,
  }
  if (evaluation.result !== undefined) {
    entry.result = makeGroupSlotList(evaluation.group, evaluation.result)
  }
  return entry
}

// Splitting a group parent key by key is safe only when every side holds a
// plain object or is absent, and the parent was not deleted on one side while
// edited on the other. An edit/delete collision must stay a conflict at the
// parent path: splitting it would rebuild an object neither side had.
function isSplittableGroupParent(original: Slot, submitted: Slot, currentServer: Slot): boolean {
  const sides: Slot[] = [original, submitted, currentServer]
  for (const value of sides) {
    if (value !== ABSENT && !isPlainObject(value)) return false
  }
  if (original === ABSENT) return true
  if (submitted === ABSENT) return currentServer === ABSENT || slotEqual(currentServer, original)
  if (currentServer === ABSENT) return slotEqual(submitted, original)
  return true
}

function mergeSlot(
  original: Slot,
  submitted: Slot,
  currentServer: Slot,
  path: PathSegment[],
  conflicts: MergeConflict[],
  changes: ChangeReportEntry[] | undefined,
  decisions: ReadonlyMap<string, ConflictChoice>,
  forcedGroupSlots: ReadonlyMap<string, Slot>,
  changedGroupPrefixes: ReadonlySet<string>,
): Slot {
  // Ungrouped merges skip path encoding entirely.
  const encodedPath = forcedGroupSlots.size > 0 ? encodePath(path) : undefined
  if (encodedPath !== undefined && forcedGroupSlots.has(encodedPath)) {
    return forcedGroupSlots.get(encodedPath)!
  }

  // When all three sides are objects, recursing directly is equivalent to the
  // whole-value checks below and avoids comparing each subtree twice.
  if (isPlainObject(original) && isPlainObject(submitted) && isPlainObject(currentServer)) {
    const merged: JsonObject = {}
    for (const key of unionKeys(original, submitted, currentServer)) {
      path.push(key)
      const child = mergeSlot(
        childSlot(original, key),
        childSlot(submitted, key),
        childSlot(currentServer, key),
        path,
        conflicts,
        changes,
        decisions,
        forcedGroupSlots,
        changedGroupPrefixes,
      )
      path.pop()
      if (child !== ABSENT) defineJsonProperty(merged, key, child)
    }
    return merged
  }

  // A configured group can point beneath a parent object that was added or
  // removed on one side. Split that parent only when a group member changed
  // and splitting cannot hide a parent-level collision; otherwise the
  // ordinary atomic add/delete behavior remains in force.
  if (
    encodedPath !== undefined &&
    changedGroupPrefixes.has(encodedPath) &&
    isSplittableGroupParent(original, submitted, currentServer)
  ) {
    const originalObject = isPlainObject(original) ? original : {}
    const submittedObject = isPlainObject(submitted) ? submitted : {}
    const currentServerObject = isPlainObject(currentServer) ? currentServer : {}

    if (original === ABSENT && submitted === ABSENT && currentServer === ABSENT) {
      return ABSENT
    }

    const merged: JsonObject = {}
    for (const key of unionKeys(originalObject, submittedObject, currentServerObject)) {
      path.push(key)
      const child = mergeSlot(
        childSlot(originalObject, key),
        childSlot(submittedObject, key),
        childSlot(currentServerObject, key),
        path,
        conflicts,
        changes,
        decisions,
        forcedGroupSlots,
        changedGroupPrefixes,
      )
      path.pop()
      if (child !== ABSENT) defineJsonProperty(merged, key, child)
    }
    if (Object.keys(merged).length > 0) return merged

    // Preserve a selected empty-object addition, but don't recreate a parent
    // whose fields were all deleted or whose only grouped slots were removed.
    const fallback = slotEqual(submitted, original)
      ? currentServer
      : slotEqual(currentServer, original)
        ? submitted
        : slotEqual(submitted, currentServer)
          ? submitted
          : ABSENT
    if (fallback !== ABSENT && isPlainObject(fallback) && Object.keys(fallback).length === 0) {
      return fallback
    }
    return ABSENT
  }

  const submittedOriginal = slotEqual(submitted, original)
  const currentOriginal = slotEqual(currentServer, original)
  const submittedCurrent = slotEqual(submitted, currentServer)

  if (submittedOriginal && currentOriginal) return currentServer
  if (submittedOriginal) {
    changes?.push(pathChange(path, original, submitted, currentServer, currentServer, "server-only"))
    return currentServer
  }
  if (currentOriginal) {
    changes?.push(pathChange(path, original, submitted, currentServer, submitted, "submitted-only"))
    return submitted
  }
  if (submittedCurrent) {
    changes?.push(pathChange(path, original, submitted, currentServer, submitted, "identical-both"))
    return submitted
  }

  const conflict: Conflict = {
    path: clonePath(path),
    submitted: toConflictValue(submitted),
    currentServer: toConflictValue(currentServer),
  }
  const choice = decisions.size > 0 ? decisions.get(conflictKey(conflict)) : undefined
  if (choice === "submitted") {
    changes?.push(pathChange(path, original, submitted, currentServer, submitted, "chosen-submitted"))
    return submitted
  }
  if (choice === "currentServer") {
    changes?.push(pathChange(path, original, submitted, currentServer, currentServer, "chosen-currentServer"))
    return currentServer
  }

  conflicts.push(conflict)
  changes?.push(pathChange(path, original, submitted, currentServer, undefined, "unresolved"))
  return ABSENT
}

function hasGroupChanges(evaluation: GroupEvaluation): boolean {
  return (
    !sameSlotLists(evaluation.original, evaluation.submitted) ||
    !sameSlotLists(evaluation.original, evaluation.currentServer)
  )
}

function computeMergeSnapshots(
  snapshots: MergeStateSnapshots,
  decisions: readonly Decision[] = [],
): MergeComputation {
  const decisionMap = choicesByKey(decisions)
  const evaluations = groupEvaluations(snapshots, decisionMap)
  const forcedGroupSlots = new Map<string, Slot>()
  const changedGroupPrefixes = new Set<string>()
  const conflicts: MergeConflict[] = []
  const changes: ChangeReportEntry[] | undefined = snapshots.includeReport ? [] : undefined

  for (const evaluation of evaluations) {
    if (evaluation.conflict !== undefined) conflicts.push(evaluation.conflict)
    if (hasGroupChanges(evaluation)) {
      if (changes !== undefined) changes.push(groupChange(evaluation))
      for (const path of evaluation.group.paths) {
        for (let length = 0; length < path.length; length += 1) {
          changedGroupPrefixes.add(encodePath(path.slice(0, length)))
        }
      }
    }
    evaluation.group.paths.forEach((path, index) => {
      forcedGroupSlots.set(
        encodePath(path),
        evaluation.result === undefined ? ABSENT : evaluation.result[index]!,
      )
    })
  }

  const candidate = mergeSlot(
    snapshots.originalState,
    snapshots.submittedState,
    snapshots.currentServerState,
    [],
    conflicts,
    changes,
    decisionMap,
    forcedGroupSlots,
    changedGroupPrefixes,
  )

  conflicts.sort(compareConflicts)
  changes?.sort(compareChanges)
  return { conflicts, candidate, changes }
}

function resultFromComputation(
  computation: MergeComputation,
  snapshots: MergeStateSnapshots,
):
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue> {
  if (computation.conflicts.length > 0) {
    const result = {
      ok: false as const,
      kind: "conflict" as const,
      conflicts: computation.conflicts,
    }
    if (snapshots.includeReport) {
      const withReport = { ...result, report: { changes: computation.changes ?? [] } }
      return snapshots.grouped
        ? withReport as GroupedMergeResultWithReport<JsonValue>
        : withReport as MergeResultWithReport<JsonValue>
    }
    return snapshots.grouped
      ? result as GroupedMergeResult<JsonValue>
      : result as MergeResult<JsonValue>
  }

  if (computation.candidate === ABSENT) {
    throw new TypeError("CAM internal error: root merge result cannot be absent")
  }

  const result = { ok: true as const, value: computation.candidate, conflicts: [] as [] }
  if (snapshots.includeReport) {
    return { ...result, report: { changes: computation.changes ?? [] } }
  }
  return result
}

/** Internal composition point for helpers that already hold validated snapshots. */
export function mergeSnapshotResult(
  snapshots: MergeStateSnapshots,
):
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue> {
  return resultFromComputation(computeMergeSnapshots(snapshots), snapshots)
}

/** Internal composition point; decisions must match current full conflict tuples. */
export function mergeSnapshotsWithChoices(
  snapshots: MergeStateSnapshots,
  decisions: readonly Decision[],
):
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue> {
  return resultFromComputation(computeMergeSnapshots(snapshots, decisions), snapshots)
}

export function mergeStates<T extends JsonValue>(
  input: MergeStatesInput<T>,
): MergeResult<T>
export function mergeStates<T extends JsonValue>(
  input: MergeStatesWithOptionsInput<T> & { groups: readonly PathGroup[]; includeReport: true },
): GroupedMergeResultWithReport<T>
export function mergeStates<T extends JsonValue>(
  input: MergeStatesWithOptionsInput<T> & { groups: readonly PathGroup[]; includeReport?: never },
): GroupedMergeResult<T>
export function mergeStates<T extends JsonValue>(
  input: MergeStatesWithOptionsInput<T> & { groups?: never; includeReport: true },
): MergeResultWithReport<T>
export function mergeStates<T extends JsonValue>(
  input: MergeStatesWithOptionsInput<T>,
):
  | MergeResult<T>
  | GroupedMergeResult<T>
  | MergeResultWithReport<T>
  | GroupedMergeResultWithReport<T>
export function mergeStates<T extends JsonValue>(
  input: NormalizedMergeStatesWithOptionsInput & { groups: readonly PathGroup[]; includeReport: true },
): GroupedMergeResultWithReport<JsonValue>
export function mergeStates<T extends JsonValue>(
  input: NormalizedMergeStatesWithOptionsInput & { groups: readonly PathGroup[]; includeReport?: never },
): GroupedMergeResult<JsonValue>
export function mergeStates<T extends JsonValue>(
  input: NormalizedMergeStatesWithOptionsInput & { groups?: never; includeReport: true },
): MergeResultWithReport<JsonValue>
export function mergeStates(
  input: NormalizedMergeStatesInput,
): MergeResult<JsonValue>
export function mergeStates(
  input: NormalizedMergeStatesWithOptionsInput,
):
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue>
export function mergeStates<T extends JsonValue>(
  input:
    | MergeStatesInput<T>
    | MergeStatesWithOptionsInput<T>
    | NormalizedMergeStatesInput
    | NormalizedMergeStatesWithOptionsInput,
):
  | MergeResult<T>
  | GroupedMergeResult<T>
  | MergeResultWithReport<T>
  | GroupedMergeResultWithReport<T>
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue> {
  const snapshots = snapshotMergeStates(input)
  return resultFromComputation(computeMergeSnapshots(snapshots), snapshots)
}
