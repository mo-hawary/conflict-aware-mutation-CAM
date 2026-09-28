import { CAMConfigError } from "./errors.js"
import { snapshotJsonValue } from "./validation.js"
import type { PathSegment } from "./types.js"

/** Formats path segments as an RFC 6901 JSON Pointer; the root path is "". */
export function formatConflictPath(path: readonly PathSegment[]): string {
  const snapshot = snapshotJsonValue(path, "path")
  if (!Array.isArray(snapshot)) throw new CAMConfigError("path must be an array")

  const segments = snapshot.map((segment, index) => {
    if (typeof segment === "string") return segment
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return String(segment)
    }
    throw new CAMConfigError(
      `path[${index}] must be a string or non-negative safe integer`,
    )
  })

  return segments.length === 0
    ? ""
    : `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
}
