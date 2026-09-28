// Experimental Phase 7 evaluator. This module is deliberately outside src/ and
// is not exported by the package. Arrays remain atomic in CAM's shipped API.
import { CAMConfigError, mergeStates } from "../../dist/index.js"

const hasOwn = (value, key) => Object.hasOwn(value, key)

function readInput(input, key) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CAMConfigError("array-by-id input must be an object")
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new CAMConfigError(`array-by-id input.${key} must be an own data property`)
  }
  return descriptor.value
}

function snapshotArray(value, name) {
  if (!Array.isArray(value)) {
    throw new CAMConfigError(`${name} must be an array`)
  }

  // Use CAM's normal validator to reject unsupported JSON values and to make
  // an isolated, canonical copy before inspecting IDs or constructing output.
  const result = mergeStates({
    originalState: value,
    submittedState: value,
    currentServerState: value,
  })
  if (!result.ok || !Array.isArray(result.value)) {
    throw new TypeError("CAM internal error: identical array snapshots did not merge")
  }

  const seen = new Set()
  for (const item of result.value) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      Object.getPrototypeOf(item) !== Object.prototype
    ) {
      throw new CAMConfigError(`${name} items must be plain objects`)
    }
    if (!hasOwn(item, "id") || typeof item.id !== "string") {
      throw new CAMConfigError(`${name} items must have an own string id`)
    }
    if (seen.has(item.id)) {
      throw new CAMConfigError(`${name} contains duplicate id ${JSON.stringify(item.id)}`)
    }
    seen.add(item.id)
  }

  return result.value
}

function indexById(items) {
  return new Map(items.map((item) => [item.id, item]))
}

function sameJson(left, right) {
  // Each operand is already a private canonical JSON snapshot from mergeStates.
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function comparePaths(left, right) {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    return String(a) < String(b) ? -1 : 1
  }
  return left.length - right.length
}

function compareConflicts(left, right) {
  return comparePaths(left.path, right.path)
}

function conflictValue(value) {
  return { exists: true, value }
}

function addedIds(items, originalIds, alsoPresent) {
  return items
    .map((item) => item.id)
    .filter((id) => !originalIds.has(id) && !alsoPresent.has(id))
}

/**
 * Experimental identity-aware merge for arrays of JSON objects with string
 * `id` fields. See bench/array-by-id-evaluation.md for its intentionally
 * conservative contract. This is not a package API.
 *
 * Item conflicts are rooted at the string ID, followed by the nested field
 * path. An ordering conflict is reported at the root path `[]`.
 */
export function mergeArrayById(input) {
  const originalState = snapshotArray(readInput(input, "originalState"), "originalState")
  const submittedState = snapshotArray(readInput(input, "submittedState"), "submittedState")
  const currentServerState = snapshotArray(
    readInput(input, "currentServerState"),
    "currentServerState",
  )

  const originalById = indexById(originalState)
  const submittedById = indexById(submittedState)
  const currentServerById = indexById(currentServerState)
  const originalIds = new Set(originalById.keys())
  const mergedById = new Map()
  const conflicts = []

  for (const [id, originalItem] of originalById) {
    const hasSubmitted = submittedById.has(id)
    const hasCurrentServer = currentServerById.has(id)

    if (!hasSubmitted && !hasCurrentServer) continue

    if (!hasSubmitted || !hasCurrentServer) {
      const presentSide = hasSubmitted ? submittedById.get(id) : currentServerById.get(id)
      if (sameJson(presentSide, originalItem)) {
        // One side deleted while the other left the item unchanged.
        continue
      }

      conflicts.push({
        path: [id],
        submitted: hasSubmitted
          ? conflictValue(submittedById.get(id))
          : { exists: false },
        currentServer: hasCurrentServer
          ? conflictValue(currentServerById.get(id))
          : { exists: false },
      })
      continue
    }

    const itemResult = mergeStates({
      originalState: originalItem,
      submittedState: submittedById.get(id),
      currentServerState: currentServerById.get(id),
    })
    if (itemResult.ok) {
      mergedById.set(id, itemResult.value)
    } else {
      for (const conflict of itemResult.conflicts) {
        conflicts.push({ ...conflict, path: [id, ...conflict.path] })
      }
    }
  }

  // New IDs are additions. Two sides adding the same ID must submit identical
  // canonical objects; a shared ID does not imply that their edits can merge.
  for (const [id, submittedItem] of submittedById) {
    if (originalIds.has(id)) continue
    if (!currentServerById.has(id)) {
      mergedById.set(id, submittedItem)
      continue
    }

    const currentServerItem = currentServerById.get(id)
    if (sameJson(submittedItem, currentServerItem)) {
      mergedById.set(id, currentServerItem)
    } else {
      conflicts.push({
        path: [id],
        submitted: conflictValue(submittedItem),
        currentServer: conflictValue(currentServerItem),
      })
    }
  }

  for (const [id, currentServerItem] of currentServerById) {
    if (!originalIds.has(id) && !submittedById.has(id)) {
      mergedById.set(id, currentServerItem)
    }
  }

  // Compare original-item ordering only where both sides retain the item, so
  // ordinary deletions do not masquerade as reorders.
  const commonOriginalIds = new Set(
    [...originalById.keys()].filter(
      (id) => submittedById.has(id) && currentServerById.has(id),
    ),
  )
  const originalOrder = originalState
    .map((item) => item.id)
    .filter((id) => commonOriginalIds.has(id))
  const submittedOrder = submittedState
    .map((item) => item.id)
    .filter((id) => commonOriginalIds.has(id))
  const currentServerOrder = currentServerState
    .map((item) => item.id)
    .filter((id) => commonOriginalIds.has(id))

  let chosenOriginalOrder
  if (sameOrder(submittedOrder, currentServerOrder)) {
    chosenOriginalOrder = submittedOrder
  } else if (sameOrder(submittedOrder, originalOrder)) {
    chosenOriginalOrder = currentServerOrder
  } else if (sameOrder(currentServerOrder, originalOrder)) {
    chosenOriginalOrder = submittedOrder
  } else {
    conflicts.push({
      path: [],
      submitted: conflictValue(submittedOrder),
      currentServer: conflictValue(currentServerOrder),
    })
    chosenOriginalOrder = originalOrder
  }

  if (conflicts.length > 0) {
    conflicts.sort(compareConflicts)
    return { ok: false, kind: "conflict", conflicts }
  }

  const orderedIds = []
  const includedIds = new Set()
  const append = (id) => {
    if (mergedById.has(id) && !includedIds.has(id)) {
      includedIds.add(id)
      orderedIds.push(id)
    }
  }

  for (const id of chosenOriginalOrder) append(id)
  // With a successful delete/edit check, every surviving original ID appears
  // in both side sequences. This fallback keeps output deterministic if that
  // invariant changes during future prototype experiments.
  for (const item of originalState) append(item.id)

  // Preserve current-server addition order first, then submitted-only order.
  const serverOnlyOrSharedAdditions = currentServerState
    .map((item) => item.id)
    .filter((id) => !originalIds.has(id))
  for (const id of serverOnlyOrSharedAdditions) append(id)
  for (const id of addedIds(submittedState, originalIds, currentServerById)) append(id)
  for (const id of [...mergedById.keys()].sort()) append(id)

  return {
    ok: true,
    value: orderedIds.map((id) => mergedById.get(id)),
    conflicts: [],
  }
}
