export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * JSON-shaped input that may also contain `undefined` in own object
 * properties. Roots and array slots remain JSON values; use only with the
 * explicit `undefinedObjectProperties: "omit"` option.
 */
export type JsonValueWithUndefinedObjectProperties =
  | JsonPrimitive
  | JsonValueWithUndefinedObjectProperties[]
  | { [key: string]: JsonValueWithUndefinedObjectProperties | undefined }

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

export type PathGroup = {
  id: string
  /** Object-property paths; absent object ancestors are treated as absent slots. */
  paths: PathSegment[][]
}

export type GroupConflictSlot = {
  path: PathSegment[]
  value: ConflictValue
}

export type GroupConflict = {
  kind: "group"
  groupId: string
  paths: PathSegment[][]
  submitted: GroupConflictSlot[]
  currentServer: GroupConflictSlot[]
}

/** A path collision or one atomic conflict across a coupled path group. */
export type MergeConflict = Conflict | GroupConflict

export type ConflictChoice = "submitted" | "currentServer"

export type ConflictDecision = {
  sessionId: string
  conflict: MergeConflict
  choice: ConflictChoice
}

export type MergeResult<T extends JsonValue = JsonValue> =
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

export type GroupedMergeResult<T extends JsonValue = JsonValue> =
  | {
      ok: true
      value: T
      conflicts: []
    }
  | {
      ok: false
      kind: "conflict"
      conflicts: MergeConflict[]
    }

export type ChangeProvenance =
  | "submitted-only"
  | "server-only"
  | "identical-both"
  | "chosen-submitted"
  | "chosen-currentServer"
  | "unresolved"

export type ReportSlot = {
  path: PathSegment[]
  value: ConflictValue
}

export type PathChangeReportEntry = {
  kind: "path"
  path: PathSegment[]
  original: ConflictValue
  submitted: ConflictValue
  currentServer: ConflictValue
  result?: ConflictValue
  provenance: ChangeProvenance
}

export type GroupChangeReportEntry = {
  kind: "group"
  groupId: string
  original: ReportSlot[]
  submitted: ReportSlot[]
  currentServer: ReportSlot[]
  result?: ReportSlot[]
  provenance: ChangeProvenance
}

export type ChangeReportEntry = PathChangeReportEntry | GroupChangeReportEntry

export type MergeReport = {
  changes: ChangeReportEntry[]
}

export type MergeResultWithReport<T extends JsonValue = JsonValue> =
  | {
      ok: true
      value: T
      conflicts: []
      report: MergeReport
    }
  | {
      ok: false
      kind: "conflict"
      conflicts: Conflict[]
      report: MergeReport
    }

export type GroupedMergeResultWithReport<T extends JsonValue = JsonValue> =
  | {
      ok: true
      value: T
      conflicts: []
      report: MergeReport
    }
  | {
      ok: false
      kind: "conflict"
      conflicts: MergeConflict[]
      report: MergeReport
    }

export type MatchConflictErrorInput = {
  error: ErrorSignal
  expectedError: ErrorSignal
  errorOutput?: ErrorOutput
}

export type MergeStatesBaseInput<T extends JsonValue = JsonValue> = {
  originalState: T
  submittedState: T
  currentServerState: T
}

/** Strict, unchanged v1 input shape. */
export type MergeStatesInput<T extends JsonValue = JsonValue> =
  MergeStatesBaseInput<T> & {
    groups?: never
    includeReport?: never
  }

/** Opt-in merge features for ordinary JSON-compatible inputs. */
export type MergeStatesWithOptionsInput<T extends JsonValue = JsonValue> =
  MergeStatesBaseInput<T> & {
    groups?: readonly PathGroup[]
    includeReport?: true
  }

export type NormalizedMergeStatesInput = {
  originalState: JsonValueWithUndefinedObjectProperties
  submittedState: JsonValueWithUndefinedObjectProperties
  currentServerState: JsonValueWithUndefinedObjectProperties
  undefinedObjectProperties: "omit"
}

export type NormalizedMergeStatesWithOptionsInput =
  NormalizedMergeStatesInput & {
    groups?: readonly PathGroup[]
    includeReport?: true
  }

export type ApplyConflictDecisionsInput<T extends JsonValue = JsonValue> =
  MergeStatesBaseInput<T> & {
    sessionId: string
    decisions: readonly ConflictDecision[]
    groups?: readonly PathGroup[]
    includeReport?: true
  }

export type NormalizedApplyConflictDecisionsInput =
  NormalizedMergeStatesWithOptionsInput & {
    sessionId: string
    decisions: readonly ConflictDecision[]
  }

export type ResolveConflictInput<T extends JsonValue = JsonValue> =
  MatchConflictErrorInput & MergeStatesWithOptionsInput<T>

export type NormalizedResolveConflictInput = MatchConflictErrorInput &
  NormalizedMergeStatesWithOptionsInput

export type ResolveConflictResult<T extends JsonValue = JsonValue> =
  | { matched: false; error: ErrorSignal }
  | { matched: true; result: MergeResult<T> }

export type ResolveConflictGroupedResult<T extends JsonValue = JsonValue> =
  | { matched: false; error: ErrorSignal }
  | { matched: true; result: GroupedMergeResult<T> }

export type ResolveConflictReportedResult<T extends JsonValue = JsonValue> =
  | { matched: false; error: ErrorSignal }
  | { matched: true; result: MergeResultWithReport<T> }

export type ResolveConflictGroupedReportedResult<T extends JsonValue = JsonValue> =
  | { matched: false; error: ErrorSignal }
  | { matched: true; result: GroupedMergeResultWithReport<T> }

export type ResolveRuntimeResult<T extends JsonValue = JsonValue> =
  | ResolveConflictResult<T>
  | ResolveConflictGroupedResult<T>
  | ResolveConflictReportedResult<T>
  | ResolveConflictGroupedReportedResult<T>
