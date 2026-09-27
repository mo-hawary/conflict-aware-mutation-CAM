import type {
  Conflict,
  ConflictValue,
  JsonValue,
  MergeResult,
  MergeStatesInput,
  PathSegment,
} from "./types.js"
import { CAMConfigError } from "./errors.js"
import { defineJsonProperty, snapshotJsonValue } from "./validation.js"

// Marks an absent object property (deletion). A symbol can never appear in a
// validated JSON snapshot, so it cannot collide with real data.
const ABSENT: unique symbol = Symbol("cam.absent")
type Slot = JsonValue | typeof ABSENT

type JsonObject = { [key: string]: JsonValue }

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

const toConflictValue = (slot: Slot): ConflictValue =>
  slot === ABSENT ? { exists: false } : { exists: true, value: slot }

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

/**
 * Merges one path. Returns the merged slot; on a true conflict it records the
 * conflict and returns ABSENT (the caller discards the whole result whenever
 * any conflict was recorded).
 *
 * Inputs are private snapshots, so returned subtrees are used as-is without
 * cloning. Each snapshot node is placed in the output at most once.
 */
function mergeSlot(
  original: Slot,
  submitted: Slot,
  currentServer: Slot,
  path: PathSegment[],
  conflicts: Conflict[],
): Slot {
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
      )
      path.pop()
      if (child !== ABSENT) defineJsonProperty(merged, key, child)
    }
    return merged
  }

  if (slotEqual(submitted, original)) return currentServer
  if (slotEqual(currentServer, original)) return submitted
  if (slotEqual(submitted, currentServer)) return submitted

  conflicts.push({
    path: path.slice(),
    submitted: toConflictValue(submitted),
    currentServer: toConflictValue(currentServer),
  })
  return ABSENT
}

export function mergeStates<T extends JsonValue>(
  input: MergeStatesInput<T>,
): MergeResult<T> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CAMConfigError("mergeStates input must be an object")
  }

  const originalState = snapshotJsonValue(input.originalState, "originalState")
  const submittedState = snapshotJsonValue(input.submittedState, "submittedState")
  const currentServerState = snapshotJsonValue(
    input.currentServerState,
    "currentServerState",
  )

  const conflicts: Conflict[] = []
  const merged = mergeSlot(originalState, submittedState, currentServerState, [], conflicts)

  if (conflicts.length > 0) {
    return { ok: false, kind: "conflict", conflicts }
  }

  if (merged === ABSENT) {
    throw new TypeError("CAM internal error: root merge result cannot be absent")
  }

  return { ok: true, value: merged as T, conflicts: [] }
}
