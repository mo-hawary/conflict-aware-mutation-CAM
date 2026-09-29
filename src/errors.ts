/**
 * Thrown for invalid public input or configuration. Extends `Error` (not
 * `TypeError`) so it stays distinguishable from internal invariant failures,
 * which are thrown as plain `TypeError`.
 */
export class CAMConfigError extends Error {
  readonly code = "CAM_CONFIG_ERROR"

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CAMConfigError"
  }
}
