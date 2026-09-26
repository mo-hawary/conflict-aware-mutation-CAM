import type {
  ErrorMatchResult,
  ErrorOutput,
  ErrorSignal,
  MatchConflictErrorInput,
} from "./types.js"
import { normalizeErrorOutput, normalizeErrorSignal } from "./validation.js"

// Both helpers receive normalized signals: plain objects carrying only the
// validated own `code` / `text` fields.
function sameCode(actual: ErrorSignal, expected: ErrorSignal): boolean {
  if (expected.code === undefined) return true
  return actual.code === expected.code
}

function sameText(actual: ErrorSignal, expected: ErrorSignal): boolean {
  if (expected.text === undefined) return true
  return actual.text === expected.text
}

function withOutput(error: ErrorSignal, output: ErrorOutput): ErrorSignal {
  if (output === "backend") {
    return error
  }

  if (error.code !== undefined) {
    return { code: error.code, text: output.text }
  }

  return { text: output.text }
}

export function matchConflictError(
  input: MatchConflictErrorInput,
): ErrorMatchResult {
  const error = normalizeErrorSignal(input.error, "error")
  const expectedError = normalizeErrorSignal(input.expectedError, "expectedError")
  const errorOutput = normalizeErrorOutput(input.errorOutput)

  if (sameCode(error, expectedError) && sameText(error, expectedError)) {
    return { matched: true }
  }

  return {
    matched: false,
    error: withOutput(error, errorOutput),
  }
}
