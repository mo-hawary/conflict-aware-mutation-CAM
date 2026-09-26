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

export type ConflictValue =
  | { exists: false }
  | { exists: true; value: JsonValue }

export type Conflict = {
  path: PathSegment[]
  submitted: ConflictValue
  currentServer: ConflictValue
}

export type MergeResult =
  | {
      ok: true
      value: JsonValue
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

export type MergeStatesInput<
  TOriginal extends JsonValue = JsonValue,
  TSubmitted extends JsonValue = JsonValue,
  TCurrentServer extends JsonValue = JsonValue,
> = {
  originalState: TOriginal
  submittedState: TSubmitted
  currentServerState: TCurrentServer
}
