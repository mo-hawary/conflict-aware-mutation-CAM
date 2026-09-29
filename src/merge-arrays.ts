import { CAMConfigError } from "./errors.js"
import { ABSENT, canonicalKey, isPlainObject } from "./slots.js"
import type { Slot } from "./slots.js"
import type {
  ConflictChoice,
  ExtendedChangeProvenance,
  ExtendedPathSegment,
  ItemSegment,
  JsonValue,
  RangeSegment,
} from "./types.js"

/** Callbacks into the merge engine for the array currently being merged. */
export type ArrayMergeHooks = {
  /** Merges one child (item or paired element) beneath the array path. */
  recurse(original: Slot, submitted: Slot, currentServer: Slot, segment: ExtendedPathSegment): Slot
  /**
   * Reports a collision at the array path (segment undefined) or beneath it.
   * Returns the caller's decision, or undefined after recording the conflict.
   */
  conflict(
    segment: ExtendedPathSegment | undefined,
    original: JsonValue,
    submitted: JsonValue,
    currentServer: JsonValue,
    reason?: "order",
  ): ConflictChoice | undefined
  /** Records a report entry when reporting is enabled. */
  change(
    segment: ExtendedPathSegment | undefined,
    original: JsonValue,
    submitted: JsonValue,
    currentServer: JsonValue,
    result: JsonValue,
    provenance: ExtendedChangeProvenance,
    reason?: "order",
  ): void
  /** Human-readable array location for configuration errors. */
  label: string
}

// ---------------------------------------------------------------------------
// Sequence alignment
// ---------------------------------------------------------------------------

// Regions above this many DP cells fall back to "no further matches". That is
// always safe for diff3: fewer matches only make chunks coarser, which can add
// conflicts but can never produce a wrong merge.
const MAX_DP_CELLS = 4_000_000

/**
 * Longest-common-subsequence pairs between two hashed sequences, as a map
 * from `a` index to `b` index (-1 when unmatched). Deterministic: trims common
 * prefixes/suffixes, anchors on elements unique to both sides (patience
 * diff), and solves the remaining small regions exactly.
 */
export function alignSequences(a: readonly string[], b: readonly string[]): Int32Array {
  const aToB = new Int32Array(a.length).fill(-1)
  const solve = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      aToB[aLo] = bLo
      aLo += 1
      bLo += 1
    }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi -= 1
      bHi -= 1
      aToB[aHi] = bHi
    }
    if (aLo === aHi || bLo === bHi) return

    const anchors = uniqueAnchors(a, b, aLo, aHi, bLo, bHi)
    if (anchors.length > 0) {
      let prevA = aLo
      let prevB = bLo
      for (const [anchorA, anchorB] of anchors) {
        solve(prevA, anchorA, prevB, anchorB)
        aToB[anchorA] = anchorB
        prevA = anchorA + 1
        prevB = anchorB + 1
      }
      solve(prevA, aHi, prevB, bHi)
      return
    }

    const rows = aHi - aLo
    const cols = bHi - bLo
    if (rows * cols > MAX_DP_CELLS) return
    exactLcs(a, b, aLo, aHi, bLo, bHi, aToB)
  }
  solve(0, a.length, 0, b.length)
  return aToB
}

function uniqueAnchors(
  a: readonly string[],
  b: readonly string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): [number, number][] {
  const counts = new Map<string, { a: number; b: number; aIndex: number; bIndex: number }>()
  for (let index = aLo; index < aHi; index += 1) {
    const entry = counts.get(a[index]!)
    if (entry === undefined) counts.set(a[index]!, { a: 1, b: 0, aIndex: index, bIndex: -1 })
    else entry.a += 1
  }
  for (let index = bLo; index < bHi; index += 1) {
    const entry = counts.get(b[index]!)
    if (entry !== undefined) {
      entry.b += 1
      entry.bIndex = index
    }
  }
  const candidates: [number, number][] = []
  for (const entry of counts.values()) {
    if (entry.a === 1 && entry.b === 1) candidates.push([entry.aIndex, entry.bIndex])
  }
  if (candidates.length === 0) return []
  candidates.sort((left, right) => left[0] - right[0])

  // Longest increasing subsequence of b positions (patience sorting).
  const tails: number[] = []
  const previous = new Int32Array(candidates.length).fill(-1)
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index]![1]
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (candidates[tails[middle]!]![1] < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]!
    tails[low] = index
  }
  const result: [number, number][] = []
  for (let index = tails[tails.length - 1]!; index >= 0; index = previous[index]!) {
    result.push(candidates[index]!)
  }
  return result.reverse()
}

function exactLcs(
  a: readonly string[],
  b: readonly string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  aToB: Int32Array,
): void {
  const rows = aHi - aLo
  const cols = bHi - bLo
  const width = cols + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row * width + col] =
        a[aLo + row] === b[bLo + col]
          ? table[(row + 1) * width + col + 1]! + 1
          : Math.max(table[(row + 1) * width + col]!, table[row * width + col + 1]!)
    }
  }
  let row = 0
  let col = 0
  while (row < rows && col < cols) {
    if (a[aLo + row] === b[bLo + col]) {
      aToB[aLo + row] = bLo + col
      row += 1
      col += 1
    } else if (table[(row + 1) * width + col]! >= table[row * width + col + 1]!) {
      row += 1
    } else {
      col += 1
    }
  }
}

type Chunk = {
  stable: boolean
  oFrom: number
  oTo: number
  aFrom: number
  aTo: number
  bFrom: number
  bTo: number
}

/** Splits three sequences into diff3 stable and unstable chunks. */
export function diff3Chunks(
  original: readonly string[],
  submitted: readonly string[],
  currentServer: readonly string[],
): Chunk[] {
  const toA = alignSequences(original, submitted)
  const toB = alignSequences(original, currentServer)
  const chunks: Chunk[] = []
  let lo = 0
  let la = 0
  let lb = 0
  for (;;) {
    let run = 0
    while (
      lo + run < original.length &&
      toA[lo + run] === la + run &&
      toB[lo + run] === lb + run
    ) {
      run += 1
    }
    if (run > 0) {
      chunks.push({ stable: true, oFrom: lo, oTo: lo + run, aFrom: la, aTo: la + run, bFrom: lb, bTo: lb + run })
      lo += run
      la += run
      lb += run
      continue
    }
    let next = lo
    while (next < original.length && !(toA[next]! >= 0 && toB[next]! >= 0)) next += 1
    const aTo = next < original.length ? toA[next]! : submitted.length
    const bTo = next < original.length ? toB[next]! : currentServer.length
    if (next > lo || aTo > la || bTo > lb) {
      chunks.push({ stable: false, oFrom: lo, oTo: next, aFrom: la, aTo, bFrom: lb, bTo })
    }
    if (next >= original.length) break
    lo = next
    la = aTo
    lb = bTo
  }
  return chunks
}

/** True when no position in the region changed differently on both sides. */
function disjointInPlace(
  oKeys: readonly string[],
  oFrom: number,
  aKeys: readonly string[],
  aFrom: number,
  bKeys: readonly string[],
  bFrom: number,
  length: number,
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    const original = oKeys[oFrom + offset]
    const submitted = aKeys[aFrom + offset]
    const server = bKeys[bFrom + offset]
    if (submitted !== original && server !== original && submitted !== server) return false
  }
  return true
}

function sameSlice(
  left: readonly string[],
  leftFrom: number,
  leftTo: number,
  right: readonly string[],
  rightFrom: number,
  rightTo: number,
): boolean {
  if (leftTo - leftFrom !== rightTo - rightFrom) return false
  for (let offset = 0; offset < leftTo - leftFrom; offset += 1) {
    if (left[leftFrom + offset] !== right[rightFrom + offset]) return false
  }
  return true
}

/**
 * diff3 merge for arrays without item identity. Unchanged regions are kept; a
 * region changed on one side takes that side; a region both sides changed
 * identically is kept once. Where both changed it differently, an equal-length
 * region takes each position from the one side that changed it, provided no
 * position changed on both sides; otherwise the region is one conflict
 * addressed by an original-index range. Elements are always taken whole from
 * one side: CAM never merges inside an element without identity.
 *
 * diff3 sees a move as a delete plus an insert, so a deletion on one side can
 * be undone by the other side's move. A final per-value count check catches
 * that: if any value one side deleted ends with a count other than the
 * three-way count, the whole array is one conflict.
 */
export function mergeSequence(
  original: readonly JsonValue[],
  submitted: readonly JsonValue[],
  currentServer: readonly JsonValue[],
  hooks: ArrayMergeHooks,
): Slot {
  const oKeys = original.map(canonicalKey)
  const aKeys = submitted.map(canonicalKey)
  const bKeys = currentServer.map(canonicalKey)
  const result: JsonValue[] = []
  let complete = true
  // Report entries are buffered: the final count check may replace the
  // chunk-level outcome with one whole-array conflict.
  const changes: Parameters<ArrayMergeHooks["change"]>[] = []

  for (const chunk of diff3Chunks(oKeys, aKeys, bKeys)) {
    if (chunk.stable) {
      for (let index = chunk.bFrom; index < chunk.bTo; index += 1) result.push(currentServer[index]!)
      continue
    }
    const oSlice = original.slice(chunk.oFrom, chunk.oTo)
    const aSlice = submitted.slice(chunk.aFrom, chunk.aTo)
    const bSlice = currentServer.slice(chunk.bFrom, chunk.bTo)
    const range: RangeSegment = { from: chunk.oFrom, to: chunk.oTo }
    const aUnchanged = sameSlice(aKeys, chunk.aFrom, chunk.aTo, oKeys, chunk.oFrom, chunk.oTo)
    const bUnchanged = sameSlice(bKeys, chunk.bFrom, chunk.bTo, oKeys, chunk.oFrom, chunk.oTo)

    if (aUnchanged) {
      result.push(...bSlice)
      changes.push([range, oSlice, aSlice, bSlice, bSlice, "server-only"])
      continue
    }
    if (bUnchanged) {
      result.push(...aSlice)
      changes.push([range, oSlice, aSlice, bSlice, aSlice, "submitted-only"])
      continue
    }
    if (sameSlice(aKeys, chunk.aFrom, chunk.aTo, bKeys, chunk.bFrom, chunk.bTo)) {
      result.push(...aSlice)
      changes.push([range, oSlice, aSlice, bSlice, aSlice, "identical-both"])
      continue
    }
    if (
      oSlice.length > 0 &&
      aSlice.length === oSlice.length &&
      bSlice.length === oSlice.length &&
      disjointInPlace(oKeys, chunk.oFrom, aKeys, chunk.aFrom, bKeys, chunk.bFrom, oSlice.length)
    ) {
      // Equal lengths alone do not prove that rows correspond (one side may
      // have reordered them). Pairing by position is safe only when no
      // element changed on both sides: each position then takes the one side
      // that changed it, exactly as a one-sided change would.
      for (let offset = 0; offset < oSlice.length; offset += 1) {
        const aChanged = aKeys[chunk.aFrom + offset] !== oKeys[chunk.oFrom + offset]
        const taken = aChanged ? aSlice[offset]! : bSlice[offset]!
        result.push(taken)
        const bChanged = bKeys[chunk.bFrom + offset] !== oKeys[chunk.oFrom + offset]
        if (aChanged || bChanged) {
          changes.push([
            { from: chunk.oFrom + offset, to: chunk.oFrom + offset + 1 },
            oSlice[offset]!,
            aSlice[offset]!,
            bSlice[offset]!,
            taken,
            aChanged && bChanged ? "identical-both" : aChanged ? "submitted-only" : "server-only",
          ])
        }
      }
      continue
    }
    const choice = hooks.conflict(range, oSlice, aSlice, bSlice)
    if (choice === undefined) {
      complete = false
      continue
    }
    const chosen = choice === "submitted" ? aSlice : bSlice
    result.push(...chosen)
    changes.push([range, oSlice, aSlice, bSlice, chosen, choice === "submitted" ? "chosen-submitted" : "chosen-currentServer"])
  }
  if (complete && undoesDeletion(oKeys, aKeys, bKeys, result.map(canonicalKey))) {
    const whole: RangeSegment = { from: 0, to: original.length }
    const choice = hooks.conflict(whole, original as JsonValue, submitted as JsonValue, currentServer as JsonValue)
    if (choice === undefined) return ABSENT
    const chosen = choice === "submitted" ? submitted : currentServer
    hooks.change(whole, original as JsonValue, submitted as JsonValue, currentServer as JsonValue, chosen as JsonValue, choice === "submitted" ? "chosen-submitted" : "chosen-currentServer")
    return chosen as JsonValue
  }
  for (const entry of changes) hooks.change(...entry)
  return complete ? result : ABSENT
}

/**
 * True when a value one side deleted ends with a count other than its
 * three-way count, which happens when diff3 combines one side's deletion with
 * the other side's move of the same element.
 */
function undoesDeletion(
  oKeys: readonly string[],
  aKeys: readonly string[],
  bKeys: readonly string[],
  resultKeys: readonly string[],
): boolean {
  const tally = (keys: readonly string[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1)
    return map
  }
  const o = tally(oKeys)
  const a = tally(aKeys)
  const b = tally(bKeys)
  const r = tally(resultKeys)
  for (const [key, originalCount] of o) {
    const submittedCount = a.get(key) ?? 0
    const serverCount = b.get(key) ?? 0
    if (submittedCount >= originalCount && serverCount >= originalCount) continue
    if ((r.get(key) ?? 0) !== threeWayCount(originalCount, submittedCount, serverCount)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Keyed arrays
// ---------------------------------------------------------------------------

type KeyedSide = { order: string[]; items: Map<string, JsonValue>; values: Map<string, string | number> }

export function readKeyedSide(items: readonly JsonValue[], key: string, label: string, side: string): KeyedSide {
  const order: string[] = []
  const byKey = new Map<string, JsonValue>()
  const values = new Map<string, string | number>()
  items.forEach((item, index) => {
    if (!isPlainObject(item) || !Object.hasOwn(item, key)) {
      throw new CAMConfigError(
        `${side}${label}[${index}] must be an object with a "${key}" property (keyed array)`,
      )
    }
    const value = item[key]
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
      throw new CAMConfigError(
        `${side}${label}[${index}].${key} must be a string or finite number (keyed array)`,
      )
    }
    const identity = JSON.stringify(value)
    if (byKey.has(identity)) {
      throw new CAMConfigError(
        `${side}${label} contains duplicate key ${identity} (keyed array)`,
      )
    }
    order.push(identity)
    byKey.set(identity, item)
    values.set(identity, value)
  })
  return { order, items: byKey, values }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** Places keys absent from the base order right after their nearest predecessor. */
function weave(base: readonly string[], sides: readonly (readonly string[])[], keep: ReadonlySet<string>): string[] {
  const placed = new Set<string>()
  const children = new Map<string, string[]>()
  const HEAD = "\u0000head"
  for (const key of base) if (keep.has(key)) placed.add(key)
  for (const side of sides) {
    let anchor = HEAD
    for (const key of side) {
      if (!keep.has(key)) continue
      if (placed.has(key)) {
        anchor = key
        continue
      }
      placed.add(key)
      const list = children.get(anchor)
      if (list === undefined) children.set(anchor, [key])
      else list.push(key)
      anchor = key
    }
  }
  // Emit depth-first with an explicit stack: a long run of additions forms a
  // deep chain, which recursion would turn into a stack overflow.
  const output: string[] = []
  const roots = [...(children.get(HEAD) ?? []), ...base.filter((key) => keep.has(key))]
  const stack = roots.reverse()
  while (stack.length > 0) {
    const key = stack.pop()!
    output.push(key)
    const next = children.get(key)
    if (next !== undefined) for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!)
  }
  return output
}

/** Merges arrays of records matched by a key property. */
export function mergeKeyed(
  original: readonly JsonValue[],
  submitted: readonly JsonValue[],
  currentServer: readonly JsonValue[],
  key: string,
  hooks: ArrayMergeHooks,
): Slot {
  const o = readKeyedSide(original, key, hooks.label, "originalState")
  const s = readKeyedSide(submitted, key, hooks.label, "submittedState")
  const c = readKeyedSide(currentServer, key, hooks.label, "currentServerState")

  const identities = new Set<string>([...c.order, ...s.order, ...o.order])
  const merged = new Map<string, JsonValue>()
  for (const identity of identities) {
    const value = o.values.get(identity) ?? s.values.get(identity) ?? c.values.get(identity)!
    const segment: ItemSegment = { key, value }
    const item = hooks.recurse(
      o.items.get(identity) ?? ABSENT,
      s.items.get(identity) ?? ABSENT,
      c.items.get(identity) ?? ABSENT,
      segment,
    )
    if (item === ABSENT) {
      // Deleted, or an unresolved item conflict (already recorded).
      continue
    }
    merged.set(identity, item)
  }

  // Order: compare the items both edited sides still have. Among original
  // items, a one-sided reorder wins; when both sides hold newly added items
  // in different relative positions, neither side's placement can be
  // attributed, so that is an order conflict too.
  const inBoth = (identity: string): boolean => s.items.has(identity) && c.items.has(identity)
  const oShared = o.order.filter(inBoth)
  const sShared = s.order.filter(inBoth)
  const cShared = c.order.filter(inBoth)
  const addedByBoth = sShared.some((identity) => !o.items.has(identity))
  const keysOf = (order: readonly string[], side: KeyedSide): JsonValue[] =>
    order.map((identity) => side.values.get(identity)!)
  const originalOnly = (order: readonly string[]): string[] => order.filter((identity) => o.items.has(identity))
  let base: "submitted" | "currentServer"
  let provenance: ExtendedChangeProvenance | undefined
  if (sameOrder(sShared, cShared)) {
    base = "currentServer"
    if (!sameOrder(originalOnly(sShared), oShared)) provenance = "identical-both"
  } else if (!addedByBoth && sameOrder(sShared, oShared)) {
    base = "currentServer"
    provenance = "server-only"
  } else if (!addedByBoth && sameOrder(cShared, oShared)) {
    base = "submitted"
    provenance = "submitted-only"
  } else {
    const choice = hooks.conflict(undefined, keysOf(oShared, o), keysOf(sShared, s), keysOf(cShared, c), "order")
    if (choice === undefined) return ABSENT
    base = choice
    provenance = choice === "submitted" ? "chosen-submitted" : "chosen-currentServer"
  }
  // Ordering is a change in its own right: report it so review policies see
  // one side's reorder combined with the other side's edits.
  if (provenance !== undefined) {
    hooks.change(
      undefined,
      keysOf(oShared, o),
      keysOf(sShared, s),
      keysOf(cShared, c),
      keysOf(base === "submitted" ? sShared : cShared, base === "submitted" ? s : c),
      provenance,
      "order",
    )
  }
  const keep = new Set(merged.keys())
  const baseOrder = base === "submitted" ? s.order : c.order
  const otherOrder = base === "submitted" ? c.order : s.order
  return weave(baseOrder, [otherOrder, o.order], keep).map((identity) => merged.get(identity)!)
}

// ---------------------------------------------------------------------------
// Sets and multisets
// ---------------------------------------------------------------------------

function counts(values: readonly JsonValue[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const value of values) {
    const identity = canonicalKey(value)
    map.set(identity, (map.get(identity) ?? 0) + 1)
  }
  return map
}

export function assertUnique(values: readonly JsonValue[], side: string, label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    const identity = canonicalKey(value)
    if (seen.has(identity)) {
      throw new CAMConfigError(`${side}${label} contains a duplicate value (set array)`)
    }
    seen.add(identity)
  }
}

/**
 * Three-way count for one value: identical changes agree (both sides removing
 * one copy removes one copy); only different changes combine their deltas.
 */
export function threeWayCount(original: number, submitted: number, currentServer: number): number {
  if (submitted === original) return currentServer
  if (currentServer === original || submitted === currentServer) return submitted
  return Math.max(0, submitted + currentServer - original)
}

function sameCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false
  for (const [identity, count] of left) if (right.get(identity) !== count) return false
  return true
}

/** Provenance by membership (sets) or counts (multisets); array order is not a change. */
function collectionProvenance(
  original: ReadonlyMap<string, number>,
  submitted: ReadonlyMap<string, number>,
  currentServer: ReadonlyMap<string, number>,
): ExtendedChangeProvenance | undefined {
  const submittedChanged = !sameCounts(submitted, original)
  const serverChanged = !sameCounts(currentServer, original)
  if (!submittedChanged && !serverChanged) return undefined
  if (!serverChanged) return "submitted-only"
  if (!submittedChanged) return "server-only"
  return sameCounts(submitted, currentServer) ? "identical-both" : "combined"
}

/**
 * Merges arrays as multisets: each value's count merges three-way (see
 * threeWayCount). With `unique`, inputs must not
 * repeat values, and the result is a set. Order: server elements first, then
 * submitted additions. Never conflicts.
 */
export function mergeCounted(
  original: readonly JsonValue[],
  submitted: readonly JsonValue[],
  currentServer: readonly JsonValue[],
  unique: boolean,
  hooks: ArrayMergeHooks,
): Slot {
  if (unique) {
    assertUnique(original, "originalState", hooks.label)
    assertUnique(submitted, "submittedState", hooks.label)
    assertUnique(currentServer, "currentServerState", hooks.label)
  }
  const o = counts(original)
  const s = counts(submitted)
  const c = counts(currentServer)
  // Order is not a change. When at most one side changed membership (or
  // counts), keep that side's array exactly as written.
  const provenance = collectionProvenance(o, s, c)
  if (provenance !== "combined") {
    const kept = provenance === "submitted-only" ? submitted : currentServer
    if (provenance !== undefined) {
      hooks.change(undefined, original as JsonValue, submitted as JsonValue, currentServer as JsonValue, kept as JsonValue, provenance)
    }
    return kept as JsonValue
  }
  const budget = new Map<string, number>()
  for (const identity of new Set([...o.keys(), ...s.keys(), ...c.keys()])) {
    const count = threeWayCount(o.get(identity) ?? 0, s.get(identity) ?? 0, c.get(identity) ?? 0)
    // A set member added on both sides is still one member.
    budget.set(identity, unique ? Math.min(count, 1) : count)
  }
  const result: JsonValue[] = []
  for (const source of [currentServer, submitted]) {
    for (const value of source) {
      const identity = canonicalKey(value)
      const remaining = budget.get(identity)!
      if (remaining > 0) {
        result.push(value)
        budget.set(identity, remaining - 1)
      }
    }
  }
  hooks.change(undefined, original as JsonValue, submitted as JsonValue, currentServer as JsonValue, result, "combined")
  return result
}
