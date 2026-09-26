import { CAMConfigError } from "./errors.js"
import type { ErrorOutput, ErrorSignal, JsonValue } from "./types.js"

const MAX_JSON_DEPTH = 512

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

function readOwn(value: object, key: string): unknown {
  return hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

function formatPath(path: string): string {
  return path.length > 120 ? `${path.slice(0, 60)}…${path.slice(-40)}` : path
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

export function assertJsonValue(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  const seen = new Set<object>()

  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new CAMConfigError(
        `${formatPath(path)} exceeds CAM's maximum JSON nesting depth of ${MAX_JSON_DEPTH}`,
      )
    }

    if (current === null) return

    switch (typeof current) {
      case "string":
      case "boolean":
        return
      case "number":
        if (!Number.isFinite(current)) {
          throw new CAMConfigError(`${path} must contain only finite numbers`)
        }
        return
      case "undefined":
      case "bigint":
      case "function":
      case "symbol":
        throw new CAMConfigError(`${path} is not JSON-compatible`)
      case "object":
        break
      default:
        throw new CAMConfigError(`${path} is not JSON-compatible`)
    }

    const objectValue = current as object
    if (seen.has(objectValue)) {
      throw new CAMConfigError(`${path} contains a cyclic reference`)
    }

    const prototype = Object.getPrototypeOf(objectValue)
    if (
      !Array.isArray(objectValue) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new CAMConfigError(`${path} must contain only plain objects and arrays`)
    }

    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw new CAMConfigError(`${path} must not contain symbol-keyed properties`)
    }

    seen.add(objectValue)

    if (Array.isArray(objectValue)) {
      for (let index = 0; index < objectValue.length; index += 1) {
        visit(objectValue[index], `${path}[${index}]`, depth + 1)
      }
    } else {
      for (const key of Object.keys(objectValue)) {
        visit(
          (objectValue as Record<string, unknown>)[key],
          `${path}.${key}`,
          depth + 1,
        )
      }
    }

    seen.delete(objectValue)
  }

  visit(value, label, 0)
}
