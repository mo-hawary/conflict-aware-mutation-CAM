import type {
  ErrorMatchResult,
  ErrorSignal,
  MatchConflictErrorInput,
} from "./types.js"
import { assertErrorOutput, assertErrorSignal } from "./validation.js"

function sameCode(actual: ErrorSignal, expected: ErrorSignal): boolean {
  if (!("code" in expected) || expected.code === undefined) return true
  return "code" in actual && actual.code === expected.code
}

function sameText(actual: ErrorSignal, expected: ErrorSignal): boolean {
  if (!("text" in expected) || expected.text === undefined) return true
  return "text" in actual && actual.text === expected.text
}

function withOutput(error: ErrorSignal, output: MatchConflictErrorInput["errorOutput"]): ErrorSignal {
  if (output === undefined || output === "backend") return error

  if ("code" in error && error.code !== undefined) {
    return { code: error.code, text: output.text }
  }

  return { text: output.text }
}

export function matchConflictError(input: MatchConflictErrorInput): ErrorMatchResult {
  assertErrorSignal(input.error, "error")
  assertErrorSignal(input.expectedError, "expectedError")
  assertErrorOutput(input.errorOutput)

  if (sameCode(input.error, input.expectedError) && sameText(input.error, input.expectedError)) {
    return { matched: true }
  }

  return {
    matched: false,
    error: withOutput(input.error, input.errorOutput),
  }
}
