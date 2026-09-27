import { CAMConfigError } from "./errors.js"
import type { ErrorOutput, ErrorSignal, JsonValue, PathSegment } from "./types.js"

const MAX_JSON_DEPTH = 512

function readOwn(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

// Formats a validation path for error messages only. String segments are
// JSON-quoted so keys containing dots or brackets stay unambiguous.
function formatPath(label: string, path: readonly PathSegment[]): string {
  let formatted = label
  for (const segment of path) {
    formatted +=
      typeof segment === "number" ? `[${segment}]` : `[${JSON.stringify(segment)}]`
  }
  return formatted.length > 120
    ? `${formatted.slice(0, 60)}…${formatted.slice(-40)}`
    : formatted
}

/**
 * Validates an error signal and returns a plain snapshot of its own `code`
 * and `text` properties. Inherited properties (including prototype getters on
 * class instances) are ignored so that matching and output only ever use the
 * fields that were validated.
 */
export function normalizeErrorSignal(
  value: unknown,
  label = "error signal",
): ErrorSignal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CAMConfigError(`${label} must be an object`)
  }

  const code = readOwn(value, "code")
  const text = readOwn(value, "text")

  if (code === undefined && text === undefined) {
    throw new CAMConfigError(
      `${label} must define at least one own property: code or text`,
    )
  }

  if (code !== undefined && typeof code !== "string" && typeof code !== "number") {
    throw new CAMConfigError(`${label}.code must be a string or number`)
  }

  if (typeof code === "number" && !Number.isFinite(code)) {
    throw new CAMConfigError(`${label}.code must be a finite number`)
  }

  if (text !== undefined && typeof text !== "string") {
    throw new CAMConfigError(`${label}.text must be a string`)
  }

  if (code === undefined) {
    return { text: text as string }
  }

  return text === undefined ? { code } : { code, text }
}

/**
 * Validates `errorOutput` and returns a plain snapshot. Only an own `text`
 * property is honored for the custom-text form.
 */
export function normalizeErrorOutput(value: unknown): ErrorOutput {
  if (value === undefined || value === "backend") {
    return "backend"
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const text = readOwn(value, "text")
    if (typeof text === "string") {
      return { text }
    }
  }

  throw new CAMConfigError(
    'errorOutput must be "backend" or an object with an own text string',
  )
}

/**
 * Validates `value` as CAM v1 JSON and returns a private deep copy.
 *
 * Every property is read exactly once, through its own data descriptor, so
 * the merge never observes a value that differs from what was validated.
 * The copy is canonical: object keys are inserted in sorted order and `-0`
 * becomes `0`. Callers may therefore rely on two snapshots with the same key
 * set enumerating keys in the same order.
 */
export function snapshotJsonValue(value: unknown, label = "value"): JsonValue {
  const ancestors = new Set<object>()
  const path: PathSegment[] = []

  const fail = (reason: string): never => {
    throw new CAMConfigError(`${formatPath(label, path)} ${reason}`)
  }

  const readData = (source: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) {
      // Only reachable for array holes; object keys come from Object.keys().
      return fail("is not JSON-compatible (sparse array)")
    }
    if (!("value" in descriptor)) {
      return fail("must not be an accessor (getter/setter) property")
    }
    return descriptor.value
  }

  const visit = (current: unknown, depth: number): JsonValue => {
    if (depth > MAX_JSON_DEPTH) {
      fail(`exceeds CAM's maximum JSON nesting depth of ${MAX_JSON_DEPTH}`)
    }

    if (current === null) return null

    switch (typeof current) {
      case "string":
      case "boolean":
        return current
      case "number":
        if (!Number.isFinite(current)) {
          fail("must contain only finite numbers")
        }
        return current === 0 ? 0 : current
      case "object":
        break
      default:
        return fail("is not JSON-compatible")
    }

    const source = current as object
    if (ancestors.has(source)) {
      fail("contains a cyclic reference")
    }

    const isArray = Array.isArray(source)
    const prototype = Object.getPrototypeOf(source)
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail("must contain only plain objects and arrays")
    }

    if (Object.getOwnPropertySymbols(source).length > 0) {
      fail("must not contain symbol-keyed properties")
    }

    const keys = Object.keys(source)
    ancestors.add(source)

    let copy: JsonValue
    if (isArray) {
      const length = (source as unknown[]).length
      if (keys.length !== length) {
        fail("must be an array without holes or extra properties")
      }
      const items: JsonValue[] = new Array(length)
      for (let index = 0; index < length; index += 1) {
        path.push(index)
        items[index] = visit(readData(source, String(index)), depth + 1)
        path.pop()
      }
      copy = items
    } else {
      keys.sort()
      const object: { [key: string]: JsonValue } = {}
      for (const key of keys) {
        path.push(key)
        defineJsonProperty(object, key, visit(readData(source, key), depth + 1))
        path.pop()
      }
      copy = object
    }

    ancestors.delete(source)
    return copy
  }

  return visit(value, 0)
}

/**
 * Adds an own enumerable property. Plain assignment is used for every key
 * except `__proto__`, which would otherwise invoke the prototype setter.
 */
export function defineJsonProperty(
  target: { [key: string]: JsonValue },
  key: string,
  value: JsonValue,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    })
  } else {
    target[key] = value
  }
}
