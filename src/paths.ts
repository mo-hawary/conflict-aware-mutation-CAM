import { CAMConfigError } from "./errors.js"
import { ABSENT, childSlot, isPlainObject } from "./slots.js"
import type { Slot } from "./slots.js"
import type {
  AnySegment,
  EachSegment,
  ExtendedPathSegment,
  ItemSegment,
  JsonValue,
  RangeSegment,
} from "./types.js"

/** Pattern wildcard: matches every item or property and links them together. */
export const ANY: AnySegment = Object.freeze({ $cam: "any" as const })

/** Pattern wildcard: matches like `ANY`, but creates one group instance per matched key. */
export const EACH: EachSegment = Object.freeze({ $cam: "each" as const })

export type PatternSegment = string | number | AnySegment | EachSegment
export type NormalizedPattern = PatternSegment[]

export const isWildcard = (segment: PatternSegment): segment is AnySegment | EachSegment =>
  typeof segment === "object"

export const isEach = (segment: PatternSegment): boolean =>
  typeof segment === "object" && segment.$cam === "each"

export const isItemSegment = (segment: ExtendedPathSegment): segment is ItemSegment =>
  typeof segment === "object" && "key" in segment

export const isRangeSegment = (segment: ExtendedPathSegment): segment is RangeSegment =>
  typeof segment === "object" && "from" in segment

/**
 * Stable string identity of a path. Primitive segments are stringified, so a
 * numeric key and its string form address the same object property, as in
 * earlier releases; item and range segments are encoded as objects and cannot
 * collide with property names.
 */
export function encodePath(path: readonly ExtendedPathSegment[]): string {
  return JSON.stringify(
    path.map((segment) =>
      typeof segment !== "object"
        ? String(segment)
        : isItemSegment(segment)
          ? { key: segment.key, value: segment.value }
          : { from: segment.from, to: segment.to },
    ),
  )
}

function segmentRank(segment: ExtendedPathSegment): number {
  if (typeof segment !== "object") return 0
  return isItemSegment(segment) ? 1 : 2
}

export function compareSegments(left: ExtendedPathSegment, right: ExtendedPathSegment): number {
  const leftRank = segmentRank(left)
  const rightRank = segmentRank(right)
  if (leftRank !== rightRank) return leftRank - rightRank
  if (leftRank === 0) {
    const leftText = String(left)
    const rightText = String(right)
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
  }
  if (leftRank === 1) {
    const leftItem = left as ItemSegment
    const rightItem = right as ItemSegment
    if (leftItem.key !== rightItem.key) return leftItem.key < rightItem.key ? -1 : 1
    const leftType = typeof leftItem.value
    const rightType = typeof rightItem.value
    if (leftType !== rightType) return leftType === "number" ? -1 : 1
    return leftItem.value < rightItem.value ? -1 : leftItem.value > rightItem.value ? 1 : 0
  }
  const leftRange = left as RangeSegment
  const rightRange = right as RangeSegment
  return leftRange.from - rightRange.from || leftRange.to - rightRange.to
}

export function comparePath(
  left: readonly ExtendedPathSegment[],
  right: readonly ExtendedPathSegment[],
): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const order = compareSegments(left[index]!, right[index]!)
    if (order !== 0) return order
  }
  return left.length - right.length
}

export function clonePath<S extends ExtendedPathSegment>(path: readonly S[]): S[] {
  return path.map((segment) =>
    typeof segment !== "object"
      ? segment
      : isItemSegment(segment)
        ? { key: segment.key, value: segment.value }
        : { from: segment.from, to: segment.to },
  ) as S[]
}

/** Validates a snapshotted pattern and returns it with canonical sentinels. */
export function normalizePattern(raw: JsonValue, label: string): NormalizedPattern {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CAMConfigError(`${label} must be a non-empty path (root paths are not allowed)`)
  }
  return raw.map((segment, index) => {
    if (typeof segment === "string") return segment
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return segment
    }
    if (isPlainObject(segment)) {
      const keys = Object.keys(segment)
      if (keys.length === 1 && keys[0] === "$cam") {
        if (segment.$cam === "any") return ANY
        if (segment.$cam === "each") return EACH
      }
    }
    throw new CAMConfigError(
      `${label}[${index}] must be a string, a non-negative safe integer, ANY, or EACH`,
    )
  })
}

export const patternHasWildcard = (pattern: readonly PatternSegment[]): boolean =>
  pattern.some(isWildcard)

/** True when the pattern's segments could address the same path or an ancestor of it. */
export function patternsOverlap(
  left: readonly PatternSegment[],
  right: readonly PatternSegment[],
): boolean {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (isWildcard(a) || isWildcard(b)) continue
    if (String(a) !== String(b)) return false
  }
  return true
}

/** Whether a concrete path matches a pattern of the same length. */
export function matchesPattern(
  pattern: readonly PatternSegment[],
  path: readonly ExtendedPathSegment[],
): boolean {
  if (pattern.length !== path.length) return false
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!
    if (isWildcard(expected)) continue
    const actual = path[index]!
    if (typeof actual === "object" || String(expected) !== String(actual)) return false
  }
  return true
}

const itemIdentity = (value: string | number): string => (typeof value === "number" ? `n${value}` : `s${value}`)

// Merge snapshots are private and never mutated, so an index built once per
// array object stays valid. Without it, expanding a pattern over n keyed
// items costs n linear scans.
const keyedIndexes = new WeakMap<readonly JsonValue[], Map<string, Map<string, JsonValue>>>()

function keyedIndex(array: readonly JsonValue[], key: string): Map<string, JsonValue> {
  let byKey = keyedIndexes.get(array)
  if (byKey === undefined) {
    byKey = new Map()
    keyedIndexes.set(array, byKey)
  }
  let index = byKey.get(key)
  if (index === undefined) {
    index = new Map()
    for (const item of array) {
      if (!isPlainObject(item) || !Object.hasOwn(item, key)) continue
      const value = item[key]
      if (typeof value !== "string" && typeof value !== "number") continue
      const identity = itemIdentity(value)
      if (!index.has(identity)) index.set(identity, item)
    }
    byKey.set(key, index)
  }
  return index
}

/** Removes paths beneath another kept path with the same group label. */
export function dropCovered<T extends { path: ExtendedPathSegment[] }>(
  entries: readonly T[],
  label: (entry: T) => string = () => "",
): T[] {
  const sorted = entries.slice().sort((a, b) => comparePath(a.path, b.path) || a.path.length - b.path.length)
  const kept: T[] = []
  const keptKeys = new Set<string>()
  for (const entry of sorted) {
    const prefix = label(entry)
    let covered = false
    for (let length = 1; length < entry.path.length && !covered; length += 1) {
      covered = keptKeys.has(prefix + encodePath(entry.path.slice(0, length)))
    }
    if (covered) continue
    kept.push(entry)
    keptKeys.add(prefix + encodePath(entry.path))
  }
  return kept
}

/**
 * Navigates one segment. Object properties are addressed by primitive
 * segments, keyed-array items by item segments, and (only when `indexArrays`
 * is set) plain array elements by numeric segments.
 */
export function childAt(
  slot: Slot,
  segment: ExtendedPathSegment,
  indexArrays = false,
): Slot {
  if (typeof segment === "object") {
    if (!isItemSegment(segment) || !Array.isArray(slot)) return ABSENT
    return keyedIndex(slot, segment.key).get(itemIdentity(segment.value)) ?? ABSENT
  }
  if (isPlainObject(slot)) return childSlot(slot, String(segment))
  if (
    indexArrays &&
    Array.isArray(slot) &&
    typeof segment === "number" &&
    segment < slot.length
  ) {
    return slot[segment]!
  }
  return ABSENT
}

export function slotAt(
  root: Slot,
  path: readonly ExtendedPathSegment[],
  indexArrays = false,
): Slot {
  let slot = root
  for (const segment of path) {
    if (slot === ABSENT) return ABSENT
    slot = childAt(slot, segment, indexArrays)
  }
  return slot
}

export type ReadMatch = { path: ExtendedPathSegment[]; slot: Slot }

/**
 * Reads every location a pattern addresses in one state. A missing final
 * property under an existing parent is reported as an absent slot, so
 * presence rules can see it; wildcards visit object properties and array
 * elements (by index).
 */
export function readMatches(root: JsonValue, pattern: readonly PatternSegment[]): ReadMatch[] {
  const matches: ReadMatch[] = []
  const path: ExtendedPathSegment[] = []
  const walk = (slot: Slot, index: number): void => {
    if (index === pattern.length) {
      matches.push({ path: path.slice(), slot })
      return
    }
    const segment = pattern[index]!
    if (isWildcard(segment)) {
      if (isPlainObject(slot)) {
        for (const key of Object.keys(slot).sort()) {
          path.push(key)
          walk(slot[key]!, index + 1)
          path.pop()
        }
      } else if (Array.isArray(slot)) {
        slot.forEach((item, position) => {
          path.push(position)
          walk(item, index + 1)
          path.pop()
        })
      }
      return
    }
    if (slot === ABSENT || (!isPlainObject(slot) && !Array.isArray(slot))) {
      // A missing ancestor still counts as one absent slot when no wildcard
      // follows, so a required top-level field that was removed is visible.
      if (!pattern.slice(index).some(isWildcard)) {
        matches.push({ path: [...path, ...(pattern.slice(index) as (string | number)[])], slot: ABSENT })
      }
      return
    }
    path.push(segment as string | number)
    walk(childAt(slot, segment as string | number, true), index + 1)
    path.pop()
  }
  walk(root, 0)
  return matches
}

export type WritableMatch = { path: ExtendedPathSegment[]; binding?: ExtendedPathSegment }

/**
 * Expands a pattern into the concrete paths a merge can write, across all
 * three states. Wildcards visit object properties and the items of keyed
 * arrays; a wildcard over any other array, or over a scalar, stops at that
 * node, which is then merged as one value. `EACH` records the matched key.
 */
export function expandWritable(
  roots: readonly Slot[],
  pattern: readonly PatternSegment[],
  keyedKeyAt: (path: readonly ExtendedPathSegment[]) => string | undefined,
): WritableMatch[] {
  const results = new Map<string, WritableMatch>()
  const path: ExtendedPathSegment[] = []
  const emit = (binding: ExtendedPathSegment | undefined): void => {
    const match: WritableMatch = { path: path.slice() }
    if (binding !== undefined) match.binding = binding
    results.set(encodePath(match.path) + JSON.stringify(binding ?? null), match)
  }
  const walk = (nodes: Slot[], index: number, binding: ExtendedPathSegment | undefined): void => {
    if (index === pattern.length) {
      emit(binding)
      return
    }
    if (nodes.every((node) => node === ABSENT)) {
      if (!pattern.slice(index).some(isWildcard)) {
        for (const segment of pattern.slice(index)) path.push(segment as string | number)
        emit(binding)
        path.length -= pattern.length - index
      }
      return
    }
    // A node present on some sides but absent on others is selected whole:
    // choosing a side then takes that side's entire value (or its absence),
    // never a partially rebuilt object.
    if (index > 0 && nodes.some((node) => node === ABSENT)) {
      emit(binding)
      return
    }
    const segment = pattern[index]!
    const present = nodes.filter((node) => node !== ABSENT)
    if (!isWildcard(segment)) {
      if (present.some((node) => !isPlainObject(node))) {
        // An array or scalar cannot be split by property; merge it whole.
        emit(binding)
        return
      }
      path.push(segment)
      walk(nodes.map((node) => childAt(node, segment)), index + 1, binding)
      path.pop()
      return
    }
    if (present.every(isPlainObject)) {
      const keys = new Set<string>()
      for (const node of present) for (const key of Object.keys(node as object)) keys.add(key)
      for (const key of Array.from(keys).sort()) {
        path.push(key)
        walk(nodes.map((node) => childAt(node, key)), index + 1, isEach(segment) ? key : binding)
        path.pop()
      }
      return
    }
    const itemKey = present.every(Array.isArray) ? keyedKeyAt(path) : undefined
    if (itemKey === undefined) {
      emit(binding)
      return
    }
    const values = new Map<string, string | number>()
    for (const node of present) {
      for (const item of node as JsonValue[]) {
        if (isPlainObject(item) && Object.hasOwn(item, itemKey)) {
          const value = item[itemKey]
          if (typeof value === "string" || typeof value === "number") {
            values.set(JSON.stringify(value), value)
          }
        }
      }
    }
    const segments = Array.from(values.values())
      .map((value): ItemSegment => ({ key: itemKey, value }))
      .sort(compareSegments)
    for (const item of segments) {
      path.push(item)
      walk(nodes.map((node) => childAt(node, item)), index + 1, isEach(segment) ? item : binding)
      path.pop()
    }
  }
  walk(roots.slice(), 0, undefined)
  // Drop paths beneath an emitted ancestor: the ancestor already covers them.
  return dropCovered(Array.from(results.values()), (match) => JSON.stringify(match.binding ?? null))
}
