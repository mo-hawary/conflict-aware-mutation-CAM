import { CAMConfigError } from "./errors.js"
import type { ErrorOutput, ErrorSignal, JsonValue } from "./types.js"

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

export function assertErrorSignal(
  value: unknown,
  label = "error signal",
): asserts value is ErrorSignal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CAMConfigError(`${label} must be an object`)
  }

  const candidate = value as Record<string, unknown>
  const hasCode = hasOwn(candidate, "code") && candidate.code !== undefined
  const hasText = hasOwn(candidate, "text") && candidate.text !== undefined

  if (!hasCode && !hasText) {
    throw new CAMConfigError(`${label} must define at least one of code or text`)
  }

  if (
    hasCode &&
    typeof candidate.code !== "string" &&
    typeof candidate.code !== "number"
  ) {
    throw new CAMConfigError(`${label}.code must be a string or number`)
  }

  if (hasText && typeof candidate.text !== "string") {
    throw new CAMConfigError(`${label}.text must be a string`)
  }
}

export function assertErrorOutput(
  value: unknown,
): asserts value is ErrorOutput {
  if (value === undefined || value === "backend") {
    return
  }

  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).text === "string"
  ) {
    return
  }

  throw new CAMConfigError(
    'errorOutput must be "backend" or an object with a text string',
  )
}

export function assertJsonValue(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  const seen = new Set<object>()

  const visit = (current: unknown, path: string): void => {
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
    if (!Array.isArray(objectValue) && prototype !== Object.prototype && prototype !== null) {
      throw new CAMConfigError(`${path} must contain only plain objects and arrays`)
    }

    seen.add(objectValue)

    if (Array.isArray(objectValue)) {
      for (let index = 0; index < objectValue.length; index += 1) {
        visit(objectValue[index], `${path}[${index}]`)
      }
    } else {
      for (const key of Object.keys(objectValue)) {
        visit((objectValue as Record<string, unknown>)[key], `${path}.${key}`)
      }
    }

    seen.delete(objectValue)
  }

  visit(value, label)
}
