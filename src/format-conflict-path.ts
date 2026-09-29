import { CAMConfigError } from "./errors.js"
import { snapshotJsonValue } from "./validation.js"
import type { ExtendedPathSegment, PathSegment } from "./types.js"

const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1")

/**
 * Formats path segments as an RFC 6901 JSON Pointer; the root path is "".
 * Item segments of keyed arrays render as `[key=value]` and sequence ranges
 * as `[from..to)`. Those two token forms are display-only extensions and are
 * not part of RFC 6901.
 */
export function formatConflictPath(path: readonly PathSegment[]): string
export function formatConflictPath(path: readonly ExtendedPathSegment[]): string
export function formatConflictPath(path: readonly ExtendedPathSegment[]): string {
  const snapshot = snapshotJsonValue(path, "path")
  if (!Array.isArray(snapshot)) throw new CAMConfigError("path must be an array")

  const segments = snapshot.map((segment, index) => {
    if (typeof segment === "string") return escapeToken(segment)
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return String(segment)
    }
    if (typeof segment === "object" && segment !== null && !Array.isArray(segment)) {
      const keys = Object.keys(segment).sort()
      if (
        keys.length === 2 && keys[0] === "key" && keys[1] === "value" &&
        typeof segment.key === "string" &&
        (typeof segment.value === "string" ||
          (typeof segment.value === "number" && Number.isFinite(segment.value)))
      ) {
        return escapeToken(`[${segment.key}=${String(segment.value)}]`)
      }
      if (
        keys.length === 2 && keys[0] === "from" && keys[1] === "to" &&
        Number.isSafeInteger(segment.from) && Number.isSafeInteger(segment.to) &&
        (segment.from as number) >= 0 && (segment.to as number) >= (segment.from as number)
      ) {
        return `[${segment.from}..${segment.to})`
      }
    }
    throw new CAMConfigError(
      `path[${index}] must be a string, non-negative safe integer, item segment, or range segment`,
    )
  })

  return segments.length === 0 ? "" : `/${segments.join("/")}`
}
