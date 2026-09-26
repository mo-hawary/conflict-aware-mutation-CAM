export class CAMConfigError extends TypeError {
  readonly code = "CAM_CONFIG_ERROR"

  constructor(message: string) {
    super(message)
    this.name = "CAMConfigError"
  }
}
