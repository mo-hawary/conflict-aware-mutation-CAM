import type {
  Conflict,
  ConflictValue,
  JsonValue,
  MergeResult,
  MergeStatesInput,
  PathSegment,
} from "./types.js"
import { assertJsonValue } from "./validation.js"

type NodeState =
  | { exists: false }
  | { exists: true; value: JsonValue }

type InternalMergeResult =
  | { ok: true; state: NodeState }
  | { ok: false; conflicts: Conflict[] }

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isPlainObject = (
  value: JsonValue,
): value is { [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function defineSafeProperty(
  target: { [key: string]: JsonValue },
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item))
  }

  const clone: { [key: string]: JsonValue } = {}
  for (const key of Object.keys(value)) {
    defineSafeProperty(clone, key, cloneJson(value[key]))
  }

  return clone
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false
    }

    if (left.length !== right.length) {
      return false
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEqual(left[index], right[index])) {
        return false
      }
    }

    return true
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()

    if (leftKeys.length !== rightKeys.length) {
      return false
    }

    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index]
      if (key !== rightKeys[index] || !jsonEqual(left[key], right[key])) {
        return false
      }
    }

    return true
  }

  return false
}

function stateEqual(left: NodeState, right: NodeState): boolean {
  if (!left.exists || !right.exists) {
    return left.exists === right.exists
  }

  return jsonEqual(left.value, right.value)
}

function cloneState(state: NodeState): NodeState {
  return state.exists
    ? { exists: true, value: cloneJson(state.value) }
    : { exists: false }
}

function toConflictValue(state: NodeState): ConflictValue {
  return state.exists
    ? { exists: true, value: cloneJson(state.value) }
    : { exists: false }
}

function childState(
  object: { [key: string]: JsonValue },
  key: string,
): NodeState {
  return hasOwn(object, key)
    ? { exists: true, value: object[key] }
    : { exists: false }
}

function mergeNode(
  original: NodeState,
  submitted: NodeState,
  currentServer: NodeState,
  path: PathSegment[],
): InternalMergeResult {
  if (stateEqual(submitted, original)) {
    return { ok: true, state: cloneState(currentServer) }
  }

  if (stateEqual(currentServer, original)) {
    return { ok: true, state: cloneState(submitted) }
  }

  if (stateEqual(submitted, currentServer)) {
    return { ok: true, state: cloneState(submitted) }
  }

  if (
    original.exists &&
    submitted.exists &&
    currentServer.exists &&
    isPlainObject(original.value) &&
    isPlainObject(submitted.value) &&
    isPlainObject(currentServer.value)
  ) {
    const keys = Array.from(
      new Set([
        ...Object.keys(original.value),
        ...Object.keys(submitted.value),
        ...Object.keys(currentServer.value),
      ]),
    ).sort()

    const merged: { [key: string]: JsonValue } = {}
    const conflicts: Conflict[] = []

    for (const key of keys) {
      const result = mergeNode(
        childState(original.value, key),
        childState(submitted.value, key),
        childState(currentServer.value, key),
        [...path, key],
      )

      if (!result.ok) {
        conflicts.push(...result.conflicts)
        continue
      }

      if (result.state.exists) {
        defineSafeProperty(merged, key, result.state.value)
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }

    return { ok: true, state: { exists: true, value: merged } }
  }

  return {
    ok: false,
    conflicts: [
      {
        path: [...path],
        submitted: toConflictValue(submitted),
        currentServer: toConflictValue(currentServer),
      },
    ],
  }
}

export function mergeStates(
  input: MergeStatesInput,
): MergeResult {
  assertJsonValue(input.originalState, "originalState")
  assertJsonValue(input.submittedState, "submittedState")
  assertJsonValue(input.currentServerState, "currentServerState")

  const result = mergeNode(
    { exists: true, value: input.originalState },
    { exists: true, value: input.submittedState },
    { exists: true, value: input.currentServerState },
    [],
  )

  if (!result.ok) {
    return {
      ok: false,
      kind: "conflict",
      conflicts: result.conflicts,
    }
  }

  if (!result.state.exists) {
    throw new TypeError("CAM internal error: root merge result cannot be absent")
  }

  return {
    ok: true,
    value: result.state.value,
    conflicts: [],
  }
}
