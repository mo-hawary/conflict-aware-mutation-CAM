export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type ErrorSignal =
  | { code: string | number; text?: string }
  | { code?: never; text: string }

export type ErrorOutput = "backend" | { text: string }

export type ErrorMatchResult =
  | { matched: true }
  | { matched: false; error: ErrorSignal }

export type PathSegment = string | number

export type MissingValue = { kind: "missing" }

export type ConflictValue = JsonValue | MissingValue

export type Conflict = {
  path: PathSegment[]
  submitted: ConflictValue
  currentServer: ConflictValue
}

export type MergeResult<T extends JsonValue> =
  | {
      ok: true
      value: T
      conflicts: []
    }
  | {
      ok: false
      kind: "conflict"
      conflicts: Conflict[]
    }

export type MatchConflictErrorInput = {
  error: ErrorSignal
  expectedError: ErrorSignal
  errorOutput?: ErrorOutput
}

export type MergeStatesInput<T extends JsonValue> = {
  originalState: T
  submittedState: T
  currentServerState: T
}
