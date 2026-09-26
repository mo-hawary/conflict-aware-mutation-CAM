import { CAMConfigError } from "./errors.js"
import type {
  Conflict,
  ConflictValue,
  JsonValue,
  MergeResult,
  MergeStatesInput,
  PathSegment,
} from "./types.js"
import { assertJsonValue } from "./validation.js"

const MAX_DEPTH = 256
const MISSING = Symbol("CAM_MISSING")

type NodeValue = JsonValue | typeof MISSING

function isPlainObject(value: NodeValue): value is { [key: string]: JsonValue } {
  return (
    value !== MISSING &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
}

function deepEqual(left: NodeValue, right: NodeValue): boolean {
  if (left === right) return true
  if (left === MISSING || right === MISSING) return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false

    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index] as JsonValue, right[index] as JsonValue)) {
        return false
      }
    }

    return true
  }

  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false

    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()

    if (leftKeys.length !== rightKeys.length) return false

    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index]
      if (key !== rightKeys[index]) return false
      if (!deepEqual(left[key] as JsonValue, right[key] as JsonValue)) {
        return false
      }
    }

    return true
  }

  return false
}

function cloneJson(value: JsonValue, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new CAMConfigError(`state exceeds maximum supported depth of ${MAX_DEPTH}`)
  }

  if (value === null || typeof value !== "object") return value

  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item, depth + 1))
  }

  const output: { [key: string]: JsonValue } = {}

  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneJson(value[key] as JsonValue, depth + 1),
    })
  }

  return output
}

function toConflictValue(value: NodeValue): ConflictValue {
  return value === MISSING ? { kind: "missing" } : cloneJson(value)
}

function readKey(
  object: { [key: string]: JsonValue },
  key: string,
): NodeValue {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? (object[key] as JsonValue)
    : MISSING
}

function mergeNode(
  originalState: NodeValue,
  submittedState: NodeValue,
  currentServerState: NodeValue,
  path: PathSegment[],
  conflicts: Conflict[],
  depth: number,
): NodeValue {
  if (depth > MAX_DEPTH) {
    throw new CAMConfigError(`state exceeds maximum supported depth of ${MAX_DEPTH}`)
  }

  if (deepEqual(submittedState, originalState)) {
    return currentServerState === MISSING
      ? MISSING
      : cloneJson(currentServerState, depth)
  }

  if (deepEqual(currentServerState, originalState)) {
    return submittedState === MISSING
      ? MISSING
      : cloneJson(submittedState, depth)
  }

  if (deepEqual(submittedState, currentServerState)) {
    return submittedState === MISSING
      ? MISSING
      : cloneJson(submittedState, depth)
  }

  if (
    isPlainObject(originalState) &&
    isPlainObject(submittedState) &&
    isPlainObject(currentServerState)
  ) {
    const keys = new Set<string>([
      ...Object.keys(originalState),
      ...Object.keys(submittedState),
      ...Object.keys(currentServerState),
    ])
    const output: { [key: string]: JsonValue } = {}

    for (const key of [...keys].sort()) {
      const merged = mergeNode(
        readKey(originalState, key),
        readKey(submittedState, key),
        readKey(currentServerState, key),
        [...path, key],
        conflicts,
        depth + 1,
      )

      if (merged !== MISSING) {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: merged,
        })
      }
    }

    return output
  }

  conflicts.push({
    path: [...path],
    submitted: toConflictValue(submittedState),
    currentServer: toConflictValue(currentServerState),
  })

  // The value is intentionally not exposed when conflicts exist.
  // Returning server state here only lets traversal continue deterministically.
  return currentServerState === MISSING
    ? MISSING
    : cloneJson(currentServerState, depth)
}

export function mergeStates<T extends JsonValue>(
  input: MergeStatesInput<T>,
): MergeResult<T> {
  assertJsonValue(input.originalState, "originalState")
  assertJsonValue(input.submittedState, "submittedState")
  assertJsonValue(input.currentServerState, "currentServerState")

  const conflicts: Conflict[] = []
  const merged = mergeNode(
    input.originalState,
    input.submittedState,
    input.currentServerState,
    [],
    conflicts,
    0,
  )

  if (conflicts.length > 0) {
    return {
      ok: false,
      kind: "conflict",
      conflicts,
    }
  }

  if (merged === MISSING) {
    throw new CAMConfigError("root state cannot resolve to a missing value")
  }

  return {
    ok: true,
    value: merged as T,
    conflicts: [],
  }
}
