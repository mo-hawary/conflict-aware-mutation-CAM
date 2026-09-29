import type {
  AdvancedMergeResult,
  AdvancedMergeStatesInput,
  ArrayMergeMode,
  ChangeProvenance,
  ConflictChoice,
  ExtendedChangeProvenance,
  ExtendedConflict,
  ExtendedGroupChangeReportEntry,
  ExtendedGroupConflict,
  ExtendedGroupConflictSlot,
  ExtendedPathChangeReportEntry,
  ExtendedPathSegment,
  ExtendedReportSlot,
  GroupedMergeResult,
  GroupedMergeResultWithReport,
  JsonValue,
  MergeConflict,
  MergeResult,
  MergeResultWithReport,
  MergeStatesInput,
  MergeStatesWithOptionsInput,
  NormalizedAdvancedMergeStatesInput,
  NormalizedMergeStatesInput,
  NormalizedMergeStatesWithOptionsInput,
  PathGroup,
  RuleConflict,
  RuleViolation,
} from "./types.js"
import { CAMConfigError } from "./errors.js"
import { defineJsonProperty, snapshotJsonValue } from "./validation.js"
import { ABSENT, childSlot, isPlainObject, slotEqual, toConflictValue } from "./slots.js"
import type { JsonObject, Slot } from "./slots.js"
import {
  childAt,
  clonePath,
  comparePath,
  encodePath,
  expandWritable,
  isEach,
  isItemSegment,
  isWildcard,
  matchesPattern,
  normalizePattern,
  patternHasWildcard,
  patternsOverlap,
  readMatches,
  slotAt,
} from "./paths.js"
import type { NormalizedPattern } from "./paths.js"
import { mergeCounted, mergeKeyed, mergeSequence } from "./merge-arrays.js"
import type { ArrayMergeHooks } from "./merge-arrays.js"
import { compileRules } from "./rules.js"
import type { CompiledRule } from "./rules.js"

type Path = ExtendedPathSegment[]
type AnyConflict = ExtendedConflict | ExtendedGroupConflict | RuleConflict
type AnyChange = ExtendedPathChangeReportEntry | ExtendedGroupChangeReportEntry

type CompiledArrayRule = {
  pattern: NormalizedPattern
  mode: ArrayMergeMode
  key?: string
}

type ArrayConfig = {
  defaultMode: "atomic" | "sequence"
  /** Most specific first (fewest wildcards), then configuration order. */
  rules: CompiledArrayRule[]
}

export type MergeStateSnapshots = Readonly<{
  originalState: JsonValue
  submittedState: JsonValue
  currentServerState: JsonValue
  groups: readonly NormalizedPathGroup[]
  grouped: boolean
  includeReport: boolean
  arrays: ArrayConfig | undefined
  derived: readonly NormalizedPattern[]
  rules: readonly CompiledRule[]
  autoMerge: "disjoint" | "review-mixed"
}>

type NormalizedPathGroup = {
  id: string
  /** Concrete member paths. Empty for a pattern group until expanded. */
  paths: Path[]
  /** Configured wildcard patterns, expanded against the data on each merge. */
  patterns?: NormalizedPattern[]
  /** The key an `EACH` instance is bound to. */
  binding?: ExtendedPathSegment
}

export type MergeDecisionSelection = {
  conflict: MergeConflict | AnyConflict
  choice: ConflictChoice
}
type Decision = MergeDecisionSelection

type ForcedSlot = { path: Path; slot: Slot }

type MergeComputation = {
  conflicts: AnyConflict[]
  candidate: Slot
  changes: AnyChange[] | undefined
  violations?: RuleViolation[]
  review?: boolean
}

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

function conflictRank(conflict: AnyConflict): number {
  if (!("kind" in conflict)) return 2
  return conflict.kind === "group" ? 0 : 1
}

function conflictSortPath(conflict: AnyConflict): readonly ExtendedPathSegment[] {
  return "kind" in conflict ? (conflict.paths[0] ?? []) : conflict.path
}

function compareConflicts(left: AnyConflict, right: AnyConflict): number {
  const pathOrder = comparePath(conflictSortPath(left), conflictSortPath(right))
  if (pathOrder !== 0) return pathOrder
  const rankOrder = conflictRank(left) - conflictRank(right)
  if (rankOrder !== 0) return rankOrder
  if ("kind" in left && "kind" in right) {
    const leftId = left.kind === "group" ? left.groupId : left.ruleId
    const rightId = right.kind === "group" ? right.groupId : right.ruleId
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  }
  return 0
}

function compareChanges(left: AnyChange, right: AnyChange): number {
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

function formatLabel(path: readonly ExtendedPathSegment[]): string {
  return path
    .map((segment) =>
      typeof segment !== "object"
        ? `[${JSON.stringify(segment)}]`
        : isItemSegment(segment)
          ? `[${segment.key}=${JSON.stringify(segment.value)}]`
          : `[${segment.from}..${segment.to})`,
    )
    .join("")
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

function validateGroupPaths(rawGroups: unknown): NormalizedPathGroup[] {
  const value = snapshotJsonValue(rawGroups, "groups")
  if (!Array.isArray(value)) throw new CAMConfigError("groups must be an array")

  const ids = new Set<string>()
  const allPatterns: NormalizedPattern[] = []
  const normalized: NormalizedPathGroup[] = []

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

    const patterns: NormalizedPattern[] = []
    for (let pathIndex = 0; pathIndex < group.paths.length; pathIndex += 1) {
      const pattern = normalizePattern(
        group.paths[pathIndex]!,
        `groups[${groupIndex}].paths[${pathIndex}]`,
      )
      for (const existing of allPatterns) {
        if (patternsOverlap(pattern, existing)) {
          throw new CAMConfigError(
            `path groups must not contain duplicate, overlapping, or ancestor paths (${JSON.stringify(pattern)} and ${JSON.stringify(existing)})`,
          )
        }
      }
      allPatterns.push(pattern)
      patterns.push(pattern)
    }

    const eachCounts = patterns.map((pattern) => pattern.filter(isEach).length)
    if (eachCounts.some((count) => count > 0)) {
      if (eachCounts.some((count) => count !== 1)) {
        throw new CAMConfigError(
          `groups[${groupIndex}]: when any path uses EACH, every path must use EACH exactly once`,
        )
      }
    }

    if (patterns.some(patternHasWildcard)) {
      normalized.push({ id: group.id, paths: [], patterns })
    } else {
      // Canonicalize members so group tuples and reports are deterministic
      // even when callers configured a different member order.
      const paths = (patterns as Path[]).map((path) => path.slice()).sort(comparePath)
      normalized.push({ id: group.id, paths })
    }
  }
  return normalized
}

export function snapshotPathGroups(rawGroups: unknown): PathGroup[] {
  return validateGroupPaths(rawGroups).map(({ id, paths, patterns }) => ({
    id,
    paths: (patterns ?? paths).map((path) =>
      path.map((segment) =>
        isWildcardSegment(segment) ? { $cam: segment.$cam } : segment,
      ),
    ),
  })) as unknown as PathGroup[]
}

const isWildcardSegment = (segment: unknown): segment is { $cam: "any" | "each" } =>
  typeof segment === "object" && segment !== null && "$cam" in segment

const ARRAY_MODES = new Set(["atomic", "sequence", "keyed", "set", "multiset"])

function compileArrays(raw: unknown): ArrayConfig {
  const value = snapshotJsonValue(raw, "arrays")
  if (!isPlainObject(value)) throw new CAMConfigError("arrays must be an object")
  for (const key of Object.keys(value)) {
    if (key !== "default" && key !== "rules") {
      throw new CAMConfigError(`arrays has unknown property "${key}"`)
    }
  }
  const defaultMode = value.default ?? "atomic"
  if (defaultMode !== "atomic" && defaultMode !== "sequence") {
    throw new CAMConfigError('arrays.default must be "atomic" or "sequence"')
  }
  const rawRules = value.rules ?? []
  if (!Array.isArray(rawRules)) throw new CAMConfigError("arrays.rules must be an array")
  const rules = rawRules.map((rawRule, index): CompiledArrayRule & { order: number; wildcards: number } => {
    const label = `arrays.rules[${index}]`
    if (!isPlainObject(rawRule)) throw new CAMConfigError(`${label} must be an object`)
    const mode = rawRule.mode
    if (typeof mode !== "string" || !ARRAY_MODES.has(mode)) {
      throw new CAMConfigError(`${label}.mode must be one of atomic, sequence, keyed, set, multiset`)
    }
    const allowed = mode === "keyed" ? ["path", "mode", "key"] : ["path", "mode"]
    for (const key of Object.keys(rawRule)) {
      if (!allowed.includes(key)) throw new CAMConfigError(`${label} has unexpected property "${key}"`)
    }
    const pattern = normalizePattern(rawRule.path!, `${label}.path`)
    const rule: CompiledArrayRule & { order: number; wildcards: number } = {
      pattern,
      mode: mode as ArrayMergeMode,
      order: index,
      wildcards: pattern.filter(isWildcard).length,
    }
    if (mode === "keyed") {
      if (typeof rawRule.key !== "string" || rawRule.key.length === 0) {
        throw new CAMConfigError(`${label}.key must be a non-empty string`)
      }
      rule.key = rawRule.key
    }
    return rule
  })
  rules.sort((left, right) => left.wildcards - right.wildcards || left.order - right.order)
  return { defaultMode, rules }
}

function compileDerived(raw: unknown): NormalizedPattern[] {
  const value = snapshotJsonValue(raw, "derived")
  if (!Array.isArray(value)) throw new CAMConfigError("derived must be an array of paths")
  return value.map((rawPattern, index) => {
    const pattern = normalizePattern(rawPattern, `derived[${index}]`)
    if (isWildcard(pattern[pattern.length - 1]!)) {
      throw new CAMConfigError(`derived[${index}] must end with a property name`)
    }
    return pattern
  })
}

function arrayRuleAt(config: ArrayConfig, path: readonly ExtendedPathSegment[]): { mode: ArrayMergeMode; key?: string } {
  for (const rule of config.rules) {
    if (matchesPattern(rule.pattern, path)) return rule
  }
  return { mode: config.defaultMode }
}

function keyedKeyLookup(config: ArrayConfig | undefined): (path: readonly ExtendedPathSegment[]) => string | undefined {
  return (path) => {
    if (config === undefined) return undefined
    const rule = arrayRuleAt(config, path)
    return rule.mode === "keyed" ? rule.key : undefined
  }
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
    | NormalizedMergeStatesWithOptionsInput
    | AdvancedMergeStatesInput
    | NormalizedAdvancedMergeStatesInput,
): MergeStateSnapshots {
  const record = inputRecord(input)
  const undefinedPropertiesDescriptor = Object.getOwnPropertyDescriptor(
    record,
    "undefinedObjectProperties",
  )
  const undefinedPropertiesValue = requiredOwnValue(record, "undefinedObjectProperties")
  let undefinedObjectProperties: "omit" | undefined
  if (
    undefinedPropertiesDescriptor !== undefined &&
    undefinedPropertiesValue !== undefined
  ) {
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
  if (
    includeReportDescriptor !== undefined &&
    includeReportValue !== undefined &&
    includeReportValue !== true
  ) {
    throw new CAMConfigError("includeReport must be true when provided")
  }

  const groupsDescriptor = Object.getOwnPropertyDescriptor(record, "groups")
  const groupsValue = requiredOwnValue(record, "groups")
  const grouped = groupsDescriptor !== undefined && groupsValue !== undefined
  const groups = grouped ? validateGroupPaths(groupsValue) : []

  const arraysValue = requiredOwnValue(record, "arrays")
  const arrays = arraysValue === undefined ? undefined : compileArrays(arraysValue)
  const derivedValue = requiredOwnValue(record, "derived")
  const derived = derivedValue === undefined ? [] : compileDerived(derivedValue)
  const rulesValue = requiredOwnValue(record, "rules")
  const rules = rulesValue === undefined ? [] : compileRules(rulesValue)
  const autoMergeValue = requiredOwnValue(record, "autoMerge")
  if (
    autoMergeValue !== undefined &&
    autoMergeValue !== "disjoint" &&
    autoMergeValue !== "review-mixed"
  ) {
    throw new CAMConfigError('autoMerge must be "disjoint" or "review-mixed"')
  }

  return {
    ...snapshots,
    groups,
    grouped,
    includeReport: includeReportValue === true,
    arrays,
    derived,
    rules,
    autoMerge: autoMergeValue === "review-mixed" ? "review-mixed" : "disjoint",
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type WorkingStates = {
  originalState: JsonValue
  submittedState: JsonValue
  currentServerState: JsonValue
}

type GroupEvaluation = {
  group: NormalizedPathGroup
  original: Slot[]
  submitted: Slot[]
  currentServer: Slot[]
  result?: Slot[]
  provenance: ChangeProvenance
  conflict?: ExtendedGroupConflict
}

function makeGroupSlotList(group: NormalizedPathGroup, slots: readonly Slot[]): ExtendedReportSlot[] {
  return group.paths.map((path, index) => ({
    path: clonePath(path),
    value: toConflictValue(slots[index]!),
  }))
}

function makeGroupConflict(
  group: NormalizedPathGroup,
  submitted: readonly Slot[],
  currentServer: readonly Slot[],
): ExtendedGroupConflict {
  const slots = (values: readonly Slot[]): ExtendedGroupConflictSlot[] =>
    group.paths.map((path, index) => ({
      path: clonePath(path),
      value: toConflictValue(values[index]!),
    }))
  const conflict: ExtendedGroupConflict = {
    kind: "group",
    groupId: group.id,
    paths: group.paths.map((path) => clonePath(path)),
    submitted: slots(submitted),
    currentServer: slots(currentServer),
  }
  if (group.binding !== undefined) {
    // Keep the binding next to the id so conflicts read naturally.
    return {
      kind: conflict.kind,
      groupId: conflict.groupId,
      binding: clonePath([group.binding])[0]!,
      paths: conflict.paths,
      submitted: conflict.submitted,
      currentServer: conflict.currentServer,
    }
  }
  return conflict
}

/** Identity used to match caller decisions against freshly computed conflicts. */
export function conflictKey(conflict: MergeConflict | AnyConflict): string {
  if ("kind" in conflict) {
    if (conflict.kind === "rule") {
      return JSON.stringify([
        "rule",
        conflict.ruleId,
        conflict.paths.map((path) => encodePath(path)),
        conflict.submitted.map(({ value }) => value),
        conflict.currentServer.map(({ value }) => value),
      ])
    }
    const binding = (conflict as ExtendedGroupConflict).binding
    return JSON.stringify([
      "group",
      conflict.groupId,
      binding === undefined ? null : encodePath([binding]),
      conflict.paths.map((path) => encodePath(path)),
      conflict.submitted.map(({ value }) => value),
      conflict.currentServer.map(({ value }) => value),
    ])
  }
  return JSON.stringify([
    "path",
    encodePath(conflict.path),
    conflict.submitted,
    conflict.currentServer,
    (conflict as ExtendedConflict).reason ?? null,
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
  states: WorkingStates,
  claimed: Set<string>,
): NormalizedPathGroup | undefined {
  const byKey = new Map<string, Path>()
  for (const path of group.paths) {
    let effective = path
    for (let length = 0; length < path.length; length += 1) {
      const prefix = path.slice(0, length)
      const original = slotAt(states.originalState, prefix)
      const submitted = slotAt(states.submittedState, prefix)
      const currentServer = slotAt(states.currentServerState, prefix)
      const splittable = isItemSegment(path[length]!)
        ? [original, submitted, currentServer].every((slot) => slot === ABSENT || Array.isArray(slot))
        : isSplittableGroupParent(original, submitted, currentServer)
      if (!splittable) {
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
  const result: NormalizedPathGroup = { id: group.id, paths }
  if (group.binding !== undefined) result.binding = group.binding
  return result
}

/** Expands pattern groups into concrete instances for the current data. */
function groupInstances(
  groups: readonly NormalizedPathGroup[],
  states: WorkingStates,
  arrays: ArrayConfig | undefined,
): NormalizedPathGroup[] {
  const instances: NormalizedPathGroup[] = []
  const roots: Slot[] = [states.originalState, states.submittedState, states.currentServerState]
  const keyedKeyAt = keyedKeyLookup(arrays)
  for (const group of groups) {
    if (group.patterns === undefined) {
      instances.push(group)
      continue
    }
    const buckets = new Map<string, { binding?: ExtendedPathSegment; paths: Map<string, Path> }>()
    for (const pattern of group.patterns) {
      for (const match of expandWritable(roots, pattern, keyedKeyAt)) {
        const bucketKey = match.binding === undefined ? "" : encodePath([match.binding])
        let bucket = buckets.get(bucketKey)
        if (bucket === undefined) {
          bucket = match.binding === undefined ? { paths: new Map() } : { binding: match.binding, paths: new Map() }
          buckets.set(bucketKey, bucket)
        }
        bucket.paths.set(encodePath(match.path), match.path)
      }
    }
    const ordered = Array.from(buckets.values()).sort((left, right) =>
      comparePath(left.binding === undefined ? [] : [left.binding], right.binding === undefined ? [] : [right.binding]),
    )
    for (const bucket of ordered) {
      const sorted = Array.from(bucket.paths.values()).sort(comparePath)
      const paths: Path[] = []
      for (const path of sorted) {
        const covered = paths.some(
          (existing) =>
            existing.length < path.length &&
            encodePath(existing) === encodePath(path.slice(0, existing.length)),
        )
        if (!covered) paths.push(path)
      }
      if (paths.length === 0) continue
      const instance: NormalizedPathGroup = { id: group.id, paths }
      if (bucket.binding !== undefined) instance.binding = bucket.binding
      instances.push(instance)
    }
  }
  return instances
}

function groupEvaluations(
  snapshots: MergeStateSnapshots,
  states: WorkingStates,
  decisions: ReadonlyMap<string, ConflictChoice>,
): GroupEvaluation[] {
  const claimed = new Set<string>()
  const groups: NormalizedPathGroup[] = []
  for (const configured of groupInstances(snapshots.groups, states, snapshots.arrays)) {
    const group = effectiveGroup(configured, states, claimed)
    if (group !== undefined) groups.push(group)
  }
  return groups.map((group): GroupEvaluation => {
    const original = group.paths.map((path) => slotAt(states.originalState, path))
    const submitted = group.paths.map((path) => slotAt(states.submittedState, path))
    const currentServer = group.paths.map((path) => slotAt(states.currentServerState, path))
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
  path: readonly ExtendedPathSegment[],
  original: Slot,
  submitted: Slot,
  currentServer: Slot,
  result: Slot | undefined,
  provenance: ExtendedChangeProvenance,
): AnyChange {
  const entry: ExtendedPathChangeReportEntry = {
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

function groupChange(evaluation: GroupEvaluation): AnyChange {
  const entry: ExtendedGroupChangeReportEntry = {
    kind: "group",
    groupId: evaluation.group.id,
    original: makeGroupSlotList(evaluation.group, evaluation.original),
    submitted: makeGroupSlotList(evaluation.group, evaluation.submitted),
    currentServer: makeGroupSlotList(evaluation.group, evaluation.currentServer),
    provenance: evaluation.provenance,
  }
  if (evaluation.group.binding !== undefined) {
    const { kind, groupId, ...rest } = entry
    const ordered: ExtendedGroupChangeReportEntry = {
      kind,
      groupId,
      binding: clonePath([evaluation.group.binding])[0]!,
      ...rest,
    }
    if (evaluation.result !== undefined) {
      ordered.result = makeGroupSlotList(evaluation.group, evaluation.result)
    }
    return ordered
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

// ---------------------------------------------------------------------------
// The recursive merge
// ---------------------------------------------------------------------------

type MergeContext = {
  conflicts: AnyConflict[]
  changes: AnyChange[] | undefined
  decisions: ReadonlyMap<string, ConflictChoice>
  forced: ReadonlyMap<string, Slot>
  splitPrefixes: ReadonlySet<string>
  /** Proper prefixes of forced paths: arrays there must merge item by item. */
  forcedPrefixes: ReadonlySet<string>
  arrays: ArrayConfig | undefined
}

const NOT_HANDLED: unique symbol = Symbol("cam.notHandled")

function mergeArrayNode(
  original: Slot,
  submitted: JsonValue[],
  currentServer: JsonValue[],
  path: Path,
  context: MergeContext,
  encodedPath: string | undefined,
): Slot | typeof NOT_HANDLED {
  const rule = arrayRuleAt(context.arrays!, path)
  if (rule.mode === "atomic") return NOT_HANDLED
  const forcedBeneath = encodedPath !== undefined && context.forcedPrefixes.has(encodedPath)
  // One-sided and identical changes need no item-level work, unless a forced
  // selection (group or rule decision) targets something inside the array.
  if (
    !forcedBeneath &&
    (slotEqual(submitted, original) ||
      slotEqual(currentServer, original) ||
      slotEqual(submitted, currentServer))
  ) {
    return NOT_HANDLED
  }
  const originalArray = original === ABSENT ? [] : (original as JsonValue[])
  const segmentPath = (segment: ExtendedPathSegment | undefined): Path =>
    segment === undefined ? clonePath(path) : [...clonePath(path), ...clonePath([segment])]
  const hooks: ArrayMergeHooks = {
    recurse(childOriginal, childSubmitted, childCurrent, segment) {
      path.push(segment)
      const merged = mergeSlot(childOriginal, childSubmitted, childCurrent, path, context)
      path.pop()
      return merged
    },
    conflict(segment, originalValue, submittedValue, currentValue, reason) {
      const conflict: ExtendedConflict = {
        path: segmentPath(segment),
        submitted: toConflictValue(submittedValue),
        currentServer: toConflictValue(currentValue),
      }
      if (reason !== undefined) conflict.reason = reason
      const choice = context.decisions.size > 0 ? context.decisions.get(conflictKey(conflict)) : undefined
      if (choice !== undefined) return choice
      context.conflicts.push(conflict)
      context.changes?.push(
        pathChange(conflict.path, originalValue, submittedValue, currentValue, undefined, "unresolved"),
      )
      return undefined
    },
    change(segment, originalValue, submittedValue, currentValue, result, provenance) {
      context.changes?.push(
        pathChange(segmentPath(segment), originalValue, submittedValue, currentValue, result, provenance),
      )
    },
    label: formatLabel(path),
  }
  switch (rule.mode) {
    case "sequence":
      return mergeSequence(originalArray, submitted, currentServer, hooks)
    case "keyed":
      return mergeKeyed(originalArray, submitted, currentServer, rule.key!, hooks)
    case "set":
      return mergeCounted(originalArray, submitted, currentServer, true, hooks)
    case "multiset":
      return mergeCounted(originalArray, submitted, currentServer, false, hooks)
    default:
      return NOT_HANDLED
  }
}

function mergeSlot(
  original: Slot,
  submitted: Slot,
  currentServer: Slot,
  path: Path,
  context: MergeContext,
): Slot {
  // Ungrouped merges skip path encoding entirely.
  const encodedPath = context.forced.size > 0 ? encodePath(path) : undefined
  if (encodedPath !== undefined && context.forced.has(encodedPath)) {
    return context.forced.get(encodedPath)!
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
        context,
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
    context.splitPrefixes.has(encodedPath) &&
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
        context,
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

  if (
    context.arrays !== undefined &&
    Array.isArray(submitted) &&
    Array.isArray(currentServer) &&
    (original === ABSENT || Array.isArray(original))
  ) {
    const merged = mergeArrayNode(original, submitted, currentServer, path, context, encodedPath)
    if (merged !== NOT_HANDLED) return merged
  }

  // Compare lazily: deep equality dominates merge time, and the common
  // unchanged subtree needs only the first comparison unless a report is on.
  const changes = context.changes
  if (slotEqual(submitted, original)) {
    if (changes !== undefined && !slotEqual(currentServer, original)) {
      changes.push(pathChange(path, original, submitted, currentServer, currentServer, "server-only"))
    }
    return currentServer
  }
  if (slotEqual(currentServer, original)) {
    changes?.push(pathChange(path, original, submitted, currentServer, submitted, "submitted-only"))
    return submitted
  }
  if (slotEqual(submitted, currentServer)) {
    changes?.push(pathChange(path, original, submitted, currentServer, submitted, "identical-both"))
    return submitted
  }

  const conflict: ExtendedConflict = {
    path: clonePath(path),
    submitted: toConflictValue(submitted),
    currentServer: toConflictValue(currentServer),
  }
  const choice = context.decisions.size > 0 ? context.decisions.get(conflictKey(conflict)) : undefined
  if (choice === "submitted") {
    changes?.push(pathChange(path, original, submitted, currentServer, submitted, "chosen-submitted"))
    return submitted
  }
  if (choice === "currentServer") {
    changes?.push(pathChange(path, original, submitted, currentServer, currentServer, "chosen-currentServer"))
    return currentServer
  }

  context.conflicts.push(conflict)
  changes?.push(pathChange(path, original, submitted, currentServer, undefined, "unresolved"))
  return ABSENT
}

function hasGroupChanges(evaluation: GroupEvaluation): boolean {
  return (
    !sameSlotLists(evaluation.original, evaluation.submitted) ||
    !sameSlotLists(evaluation.original, evaluation.currentServer)
  )
}

function computeCore(
  snapshots: MergeStateSnapshots,
  states: WorkingStates,
  decisionMap: ReadonlyMap<string, ConflictChoice>,
  collectChanges: boolean,
  extraForced: readonly ForcedSlot[] = [],
): MergeComputation {
  const evaluations = groupEvaluations(snapshots, states, decisionMap)
  const forced = new Map<string, Slot>()
  const splitPrefixes = new Set<string>()
  const forcedPrefixes = new Set<string>()
  const conflicts: AnyConflict[] = []
  const changes: AnyChange[] | undefined = collectChanges ? [] : undefined

  const addPrefixes = (path: Path, target: Set<string>): void => {
    for (let length = 0; length < path.length; length += 1) {
      target.add(encodePath(path.slice(0, length)))
    }
  }

  for (const evaluation of evaluations) {
    if (evaluation.conflict !== undefined) conflicts.push(evaluation.conflict)
    if (hasGroupChanges(evaluation)) {
      if (changes !== undefined) changes.push(groupChange(evaluation))
      for (const path of evaluation.group.paths) addPrefixes(path, splitPrefixes)
    }
    evaluation.group.paths.forEach((path, index) => {
      forced.set(
        encodePath(path),
        evaluation.result === undefined ? ABSENT : evaluation.result[index]!,
      )
      if (snapshots.arrays !== undefined) addPrefixes(path, forcedPrefixes)
    })
  }
  for (const { path, slot } of extraForced) {
    forced.set(encodePath(path), slot)
    addPrefixes(path, splitPrefixes)
    addPrefixes(path, forcedPrefixes)
  }

  const candidate = mergeSlot(
    states.originalState,
    states.submittedState,
    states.currentServerState,
    [],
    {
      conflicts,
      changes,
      decisions: decisionMap,
      forced,
      splitPrefixes,
      forcedPrefixes,
      arrays: snapshots.arrays,
    },
  )

  conflicts.sort(compareConflicts)
  changes?.sort(compareChanges)
  return { conflicts, candidate, changes }
}

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

function stripPattern(node: Slot, pattern: NormalizedPattern, index: number): Slot {
  if (node === ABSENT || node === null || typeof node !== "object") return node
  const segment = pattern[index]!
  const last = index === pattern.length - 1
  if (last) {
    const key = String(segment)
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return node
    const copy: JsonObject = {}
    for (const existing of Object.keys(node)) {
      if (existing !== key) defineJsonProperty(copy, existing, node[existing]!)
    }
    return copy
  }
  if (isWildcard(segment)) {
    if (Array.isArray(node)) return node.map((item) => stripPattern(item, pattern, index + 1) as JsonValue)
    const copy: JsonObject = {}
    for (const key of Object.keys(node)) {
      defineJsonProperty(copy, key, stripPattern(node[key]!, pattern, index + 1) as JsonValue)
    }
    return copy
  }
  if (Array.isArray(node)) {
    if (typeof segment !== "number" || segment >= node.length) return node
    const copy = node.slice()
    copy[segment] = stripPattern(node[segment]!, pattern, index + 1) as JsonValue
    return copy
  }
  const key = String(segment)
  if (!Object.hasOwn(node, key)) return node
  const copy: JsonObject = {}
  for (const existing of Object.keys(node)) {
    defineJsonProperty(
      copy,
      existing,
      (existing === key ? stripPattern(node[existing]!, pattern, index + 1) : node[existing]!) as JsonValue,
    )
  }
  return copy
}

function stripDerived(state: JsonValue, patterns: readonly NormalizedPattern[]): JsonValue {
  let result: Slot = state
  for (const pattern of patterns) result = stripPattern(result, pattern, 0)
  return result as JsonValue
}

/**
 * Re-fills derived values into the merged result: the current server's value
 * at the corresponding location, else the submitted value. Keyed-array items
 * correspond by key, other arrays by position.
 */
function refillPattern(
  node: Slot,
  server: Slot,
  submitted: Slot,
  pattern: NormalizedPattern,
  index: number,
  path: Path,
  keyedKeyAt: (path: readonly ExtendedPathSegment[]) => string | undefined,
): Slot {
  if (node === ABSENT || node === null || typeof node !== "object") return node
  const segment = pattern[index]!
  if (index === pattern.length - 1) {
    if (!isPlainObject(node)) return node
    const key = String(segment)
    const fromServer = childAt(server, key)
    const value = fromServer !== ABSENT ? fromServer : childAt(submitted, key)
    if (value === ABSENT) return node
    const copy: JsonObject = {}
    for (const existing of Object.keys(node)) defineJsonProperty(copy, existing, node[existing]!)
    defineJsonProperty(copy, key, value)
    return copy
  }
  const descend = (child: JsonValue, childSegment: ExtendedPathSegment, lookup: ExtendedPathSegment): JsonValue => {
    path.push(childSegment)
    const result = refillPattern(
      child,
      childAt(server, lookup, true),
      childAt(submitted, lookup, true),
      pattern,
      index + 1,
      path,
      keyedKeyAt,
    ) as JsonValue
    path.pop()
    return result
  }
  if (Array.isArray(node)) {
    const itemKey = keyedKeyAt(path)
    const visit = (item: JsonValue, position: number): JsonValue => {
      if (itemKey !== undefined && isPlainObject(item)) {
        const value = item[itemKey]
        if (typeof value === "string" || typeof value === "number") {
          return descend(item, position, { key: itemKey, value })
        }
      }
      return descend(item, position, position)
    }
    if (isWildcard(segment)) return node.map(visit)
    if (typeof segment !== "number" || segment >= node.length) return node
    const copy = node.slice()
    copy[segment] = visit(node[segment]!, segment)
    return copy
  }
  const copy: JsonObject = {}
  for (const key of Object.keys(node)) {
    const matches = isWildcard(segment) || String(segment) === key
    defineJsonProperty(copy, key, matches ? descend(node[key]!, key, key) : node[key]!)
  }
  return copy
}

function refillDerived(candidate: JsonValue, snapshots: MergeStateSnapshots): JsonValue {
  let result: Slot = candidate
  const keyedKeyAt = keyedKeyLookup(snapshots.arrays)
  for (const pattern of snapshots.derived) {
    result = refillPattern(
      result,
      snapshots.currentServerState,
      snapshots.submittedState,
      pattern,
      0,
      [],
      keyedKeyAt,
    )
  }
  return result as JsonValue
}

// ---------------------------------------------------------------------------
// Rules, review policy and orchestration
// ---------------------------------------------------------------------------

function ruleFingerprint(state: JsonValue, rule: CompiledRule): string {
  return JSON.stringify(
    rule.patterns.map((pattern) =>
      readMatches(state, pattern).map((match) => [
        encodePath(match.path),
        match.slot === ABSENT ? [0] : [1, match.slot],
      ]),
    ),
  )
}

function ruleConflictFor(
  rule: CompiledRule,
  message: string,
  states: WorkingStates,
  arrays: ArrayConfig | undefined,
): RuleConflict {
  const roots: Slot[] = [states.originalState, states.submittedState, states.currentServerState]
  const keyedKeyAt = keyedKeyLookup(arrays)
  const byKey = new Map<string, Path>()
  for (const pattern of rule.patterns) {
    for (const match of expandWritable(roots, pattern, keyedKeyAt)) {
      byKey.set(encodePath(match.path), match.path)
    }
  }
  const sorted = Array.from(byKey.values()).sort(comparePath)
  const paths: Path[] = []
  for (const path of sorted) {
    const covered = paths.some(
      (existing) =>
        existing.length < path.length &&
        encodePath(existing) === encodePath(path.slice(0, existing.length)),
    )
    if (!covered) paths.push(path)
  }
  const slots = (root: JsonValue): ExtendedGroupConflictSlot[] =>
    paths.map((path) => ({ path: clonePath(path), value: toConflictValue(slotAt(root, path)) }))
  return {
    kind: "rule",
    ruleId: rule.id,
    message,
    paths: paths.map((path) => clonePath(path)),
    submitted: slots(states.submittedState),
    currentServer: slots(states.currentServerState),
  }
}

function needsReview(changes: readonly AnyChange[]): boolean {
  let submittedSide = false
  let serverSide = false
  for (const change of changes) {
    switch (change.provenance) {
      case "combined":
        return true
      case "submitted-only":
      case "chosen-submitted":
        submittedSide = true
        break
      case "server-only":
      case "chosen-currentServer":
        serverSide = true
        break
      default:
        break
    }
    if (submittedSide && serverSide) return true
  }
  return false
}

function computeMergeSnapshots(
  snapshots: MergeStateSnapshots,
  decisions: readonly Decision[] = [],
): MergeComputation {
  const decisionMap = choicesByKey(decisions)
  const reviewMixed = snapshots.autoMerge === "review-mixed"
  const collectChanges = snapshots.includeReport || reviewMixed
  const states: WorkingStates =
    snapshots.derived.length === 0
      ? snapshots
      : {
          originalState: stripDerived(snapshots.originalState, snapshots.derived),
          submittedState: stripDerived(snapshots.submittedState, snapshots.derived),
          currentServerState: stripDerived(snapshots.currentServerState, snapshots.derived),
        }

  if (snapshots.rules.length === 0 && !reviewMixed && snapshots.derived.length === 0) {
    return computeCore(snapshots, states, decisionMap, collectChanges)
  }

  // Blame: a rule broken by an input is reported against that input, unless
  // the original already broke it and that side never touched the rule.
  const violations: RuleViolation[] = []
  const candidateRules: CompiledRule[] = []
  for (const rule of snapshots.rules) {
    const originalMessage = rule.evaluate(snapshots.originalState)
    const originalPrint = ruleFingerprint(snapshots.originalState, rule)
    const submittedChanged = ruleFingerprint(snapshots.submittedState, rule) !== originalPrint
    const serverChanged = ruleFingerprint(snapshots.currentServerState, rule) !== originalPrint
    const submittedMessage = rule.evaluate(snapshots.submittedState)
    const serverMessage = rule.evaluate(snapshots.currentServerState)
    if (submittedMessage !== undefined && (originalMessage === undefined || submittedChanged)) {
      violations.push({ ruleId: rule.id, side: "submitted", message: submittedMessage })
    }
    if (serverMessage !== undefined && (originalMessage === undefined || serverChanged)) {
      violations.push({ ruleId: rule.id, side: "currentServer", message: serverMessage })
    }
    const untouchedLegacy = originalMessage !== undefined && !submittedChanged && !serverChanged
    // Rules over derived values are checked on inputs only: the merged result
    // carries stale derived values until the application recomputes them.
    const readsDerived = rule.patterns.some((pattern) =>
      snapshots.derived.some((derived) => patternsOverlap(pattern, derived)),
    )
    if (!untouchedLegacy && !readsDerived) candidateRules.push(rule)
  }

  const forcedByRule: ForcedSlot[] = []
  const appliedRules = new Set<string>()
  for (;;) {
    const core = computeCore(snapshots, states, decisionMap, collectChanges, forcedByRule)
    if (violations.length > 0) return { ...core, violations }
    if (core.conflicts.length > 0 || core.candidate === ABSENT) return core

    const candidate = snapshots.derived.length === 0
      ? (core.candidate as JsonValue)
      : refillDerived(core.candidate as JsonValue, snapshots)

    const ruleConflicts: RuleConflict[] = []
    let reapply = false
    for (const rule of candidateRules) {
      const message = rule.evaluate(candidate)
      if (message === undefined) continue
      const conflict = ruleConflictFor(rule, message, states, snapshots.arrays)
      const choice = decisionMap.size > 0 ? decisionMap.get(conflictKey(conflict)) : undefined
      if (choice !== undefined && !appliedRules.has(rule.id)) {
        appliedRules.add(rule.id)
        const root = choice === "submitted" ? states.submittedState : states.currentServerState
        for (const path of conflict.paths) forcedByRule.push({ path, slot: slotAt(root, path) })
        reapply = true
        break
      }
      ruleConflicts.push(conflict)
    }
    if (reapply) continue
    if (ruleConflicts.length > 0) {
      ruleConflicts.sort(compareConflicts)
      return { conflicts: ruleConflicts, candidate: ABSENT, changes: core.changes }
    }
    const review = reviewMixed && needsReview(core.changes ?? [])
    return { conflicts: [], candidate, changes: core.changes, review }
  }
}

type RuntimeResult =
  | MergeResult<JsonValue>
  | GroupedMergeResult<JsonValue>
  | MergeResultWithReport<JsonValue>
  | GroupedMergeResultWithReport<JsonValue>
  | AdvancedMergeResult<JsonValue>

function resultFromComputation(
  computation: MergeComputation,
  snapshots: MergeStateSnapshots,
): RuntimeResult {
  const report = (): { report: { changes: AnyChange[] } } | Record<string, never> =>
    snapshots.includeReport ? { report: { changes: computation.changes ?? [] } } : {}

  if (computation.violations !== undefined) {
    return {
      ok: false,
      kind: "invalid",
      violations: computation.violations,
      conflicts: computation.conflicts,
      ...report(),
    } as AdvancedMergeResult<JsonValue>
  }

  if (computation.conflicts.length > 0) {
    return {
      ok: false as const,
      kind: "conflict" as const,
      conflicts: computation.conflicts,
      ...report(),
    } as RuntimeResult
  }

  if (computation.candidate === ABSENT) {
    throw new TypeError("CAM internal error: root merge result cannot be absent")
  }

  if (computation.review === true) {
    return {
      ok: false,
      kind: "review",
      value: computation.candidate,
      conflicts: [],
      report: { changes: computation.changes ?? [] },
    }
  }

  return { ok: true as const, value: computation.candidate, conflicts: [] as [], ...report() } as RuntimeResult
}

/** Internal composition point for helpers that already hold validated snapshots. */
export function mergeSnapshotResult(snapshots: MergeStateSnapshots): RuntimeResult {
  return resultFromComputation(computeMergeSnapshots(snapshots), snapshots)
}

/** Internal composition point; decisions must match current full conflict tuples. */
export function mergeSnapshotsWithChoices(
  snapshots: MergeStateSnapshots,
  decisions: readonly Decision[],
): RuntimeResult {
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
/** Collection merging, pattern groups, derived paths, rules or review policy. */
export function mergeStates<T extends JsonValue>(
  input: AdvancedMergeStatesInput<T>,
): AdvancedMergeResult<T>
export function mergeStates(
  input: NormalizedAdvancedMergeStatesInput,
): AdvancedMergeResult<JsonValue>
export function mergeStates<T extends JsonValue>(
  input:
    | MergeStatesInput<T>
    | MergeStatesWithOptionsInput<T>
    | NormalizedMergeStatesInput
    | NormalizedMergeStatesWithOptionsInput
    | AdvancedMergeStatesInput<T>
    | NormalizedAdvancedMergeStatesInput,
):
  | MergeResult<T>
  | GroupedMergeResult<T>
  | MergeResultWithReport<T>
  | GroupedMergeResultWithReport<T>
  | AdvancedMergeResult<T>
  | RuntimeResult {
  const snapshots = snapshotMergeStates(input)
  return resultFromComputation(computeMergeSnapshots(snapshots), snapshots)
}
