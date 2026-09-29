import type { ConflictValue, JsonValue } from "./types.js"
import { defineJsonProperty } from "./validation.js"

// Marks an absent object property (deletion). A symbol can never appear in a
// validated JSON snapshot, so it cannot collide with real data.
export const ABSENT: unique symbol = Symbol("cam.absent")
export type Slot = JsonValue | typeof ABSENT

export type JsonObject = { [key: string]: JsonValue }

export const isPlainObject = (value: Slot): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Operands are canonical snapshots (see snapshotJsonValue): objects with the
// same key set enumerate keys in the same order, so no sorting is needed.
export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
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

export function slotEqual(left: Slot, right: Slot): boolean {
  if (left === ABSENT || right === ABSENT) return left === right
  return jsonEqual(left, right)
}

export const childSlot = (object: JsonObject, key: string): Slot =>
  Object.hasOwn(object, key) ? object[key]! : ABSENT

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  const copy: JsonObject = {}
  for (const key of Object.keys(value)) {
    defineJsonProperty(copy, key, cloneJsonValue(value[key]!))
  }
  return copy
}

export const toConflictValue = (slot: Slot): ConflictValue =>
  slot === ABSENT
    ? { exists: false }
    : { exists: true, value: cloneJsonValue(slot) }

/**
 * A string identity for a canonical snapshot: structurally equal values map to
 * the same string. Used to hash array items for sequence, set and multiset
 * merges.
 */
export function canonicalKey(value: JsonValue): string {
  return JSON.stringify(value)
}
