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
    arrays?: never
    derived?: never
    rules?: never
    autoMerge?: never
  }

/** Opt-in merge features for ordinary JSON-compatible inputs. */
export type MergeStatesWithOptionsInput<T extends JsonValue = JsonValue> =
  MergeStatesBaseInput<T> & {
    groups?: readonly PathGroup[]
    includeReport?: true
    arrays?: never
    derived?: never
    rules?: never
    autoMerge?: never
  }

export type NormalizedMergeStatesInput = {
  originalState: JsonValueWithUndefinedObjectProperties
  submittedState: JsonValueWithUndefinedObjectProperties
  currentServerState: JsonValueWithUndefinedObjectProperties
  undefinedObjectProperties: "omit"
    arrays?: never
  derived?: never
  rules?: never
  autoMerge?: never
}

export type NormalizedMergeStatesWithOptionsInput =
  NormalizedMergeStatesInput & {
    groups?: readonly PathGroup[]
    includeReport?: true
    arrays?: never
    derived?: never
    rules?: never
    autoMerge?: never
  }

export type ApplyConflictDecisionsInput<T extends JsonValue = JsonValue> =
  MergeStatesBaseInput<T> & {
    sessionId: string
    decisions: readonly ConflictDecision[]
    groups?: readonly PathGroup[]
    includeReport?: true
    arrays?: never
    derived?: never
    rules?: never
    autoMerge?: never
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

// ---------------------------------------------------------------------------
// Collection merging, pattern groups, derived paths, rules and review policy.
// These types appear only in results of calls that use the corresponding
// options; plain calls keep the types above.
// ---------------------------------------------------------------------------

/** An item of a keyed array, identified by the value of its key property. */
export type ItemSegment = { key: string; value: string | number }

/** A region of a sequence-merged array, in original indices (half-open). */
export type RangeSegment = { from: number; to: number }

export type ExtendedPathSegment = PathSegment | ItemSegment | RangeSegment

/** Pattern wildcard linking every matching item or property together. */
export type AnySegment = { readonly $cam: "any" }

/** Pattern wildcard binding one matched key per group instance. */
export type EachSegment = { readonly $cam: "each" }

export type PathPattern = readonly (string | number | AnySegment | EachSegment)[]

export type ArrayMergeMode = "atomic" | "sequence" | "keyed" | "set" | "multiset"

export type ArrayRule =
  | { path: PathPattern; mode: "keyed"; key: string }
  | { path: PathPattern; mode: "atomic" | "sequence" | "set" | "multiset" }

export type ArrayMergeOptions = {
  /** Mode for arrays no rule matches. Defaults to "atomic". */
  default?: "atomic" | "sequence"
  rules?: readonly ArrayRule[]
}

/** A group whose paths may use `ANY` and `EACH` wildcards. */
export type PatternPathGroup = {
  id: string
  paths: readonly PathPattern[]
}

export type BuiltInRule = {
  id: string
  path: PathPattern
  message?: string
  required?: true
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  /** A regular expression source, compiled with the `u` flag. */
  pattern?: string
  oneOf?: readonly JsonValue[]
  unique?: true
  exactlyOne?: true
  allEqual?: true
  oneOfPath?: PathPattern
  sumOf?: PathPattern
  requiredWith?: PathPattern
}

export type CustomRule = {
  id: string
  /** Paths the check reads; they scope rule conflicts and blame. */
  paths: readonly PathPattern[]
  /** Pure and synchronous: return `true`, or a message describing the violation. */
  check: (state: JsonValue) => true | string
}

export type MergeRule = BuiltInRule | CustomRule

export type AutoMergePolicy = "disjoint" | "review-mixed"

export type ExtendedConflict = {
  path: ExtendedPathSegment[]
  submitted: ConflictValue
  currentServer: ConflictValue
  /** Present for a keyed-array reorder conflict; values are key lists. */
  reason?: "order"
}

export type ExtendedGroupConflictSlot = {
  path: ExtendedPathSegment[]
  value: ConflictValue
}

export type ExtendedGroupConflict = {
  kind: "group"
  groupId: string
  /** The key an `EACH` group instance is bound to. */
  binding?: ExtendedPathSegment
  paths: ExtendedPathSegment[][]
  submitted: ExtendedGroupConflictSlot[]
  currentServer: ExtendedGroupConflictSlot[]
}

/** Both inputs satisfied the rule, but the merged result does not. */
export type RuleConflict = {
  kind: "rule"
  ruleId: string
  message: string
  paths: ExtendedPathSegment[][]
  submitted: ExtendedGroupConflictSlot[]
  currentServer: ExtendedGroupConflictSlot[]
}

export type AdvancedMergeConflict = ExtendedConflict | ExtendedGroupConflict | RuleConflict

export type RuleViolation = {
  ruleId: string
  side: "submitted" | "currentServer"
  message: string
}

export type ExtendedChangeProvenance = ChangeProvenance | "combined"

export type ExtendedReportSlot = {
  path: ExtendedPathSegment[]
  value: ConflictValue
}

export type ExtendedPathChangeReportEntry = {
  kind: "path"
  path: ExtendedPathSegment[]
  original: ConflictValue
  submitted: ConflictValue
  currentServer: ConflictValue
  result?: ConflictValue
  provenance: ExtendedChangeProvenance
  /** Present for a keyed-array ordering change; values are key lists. */
  reason?: "order"
}

export type ExtendedGroupChangeReportEntry = {
  kind: "group"
  groupId: string
  binding?: ExtendedPathSegment
  original: ExtendedReportSlot[]
  submitted: ExtendedReportSlot[]
  currentServer: ExtendedReportSlot[]
  result?: ExtendedReportSlot[]
  provenance: ExtendedChangeProvenance
}

export type AdvancedChangeReportEntry =
  | ExtendedPathChangeReportEntry
  | ExtendedGroupChangeReportEntry

export type AdvancedMergeReport = { changes: AdvancedChangeReportEntry[] }

export type AdvancedMergeResult<T extends JsonValue = JsonValue> =
  | { ok: true; value: T; conflicts: []; report?: AdvancedMergeReport }
  | { ok: false; kind: "conflict"; conflicts: AdvancedMergeConflict[]; report?: AdvancedMergeReport }
  | {
      ok: false
      kind: "invalid"
      violations: RuleViolation[]
      conflicts: AdvancedMergeConflict[]
      report?: AdvancedMergeReport
    }
  | {
      /** Complete, but combines both sides' changes; confirm before saving. */
      ok: false
      kind: "review"
      value: T
      conflicts: []
      report: AdvancedMergeReport
    }

export type AdvancedMergeOptions = {
  arrays?: ArrayMergeOptions
  derived?: readonly PathPattern[]
  rules?: readonly MergeRule[]
  autoMerge?: AutoMergePolicy
  groups?: readonly PatternPathGroup[]
  includeReport?: true
}

/** At least one option that selects the advanced merge result type. */
export type RequiresAdvancedOption =
  | { arrays: ArrayMergeOptions }
  | { derived: readonly PathPattern[] }
  | { rules: readonly MergeRule[] }
  | { autoMerge: AutoMergePolicy }
  | { groups: readonly PatternPathGroup[] }

export type AdvancedMergeStatesInput<T extends JsonValue = JsonValue> =
  MergeStatesBaseInput<T> & AdvancedMergeOptions & RequiresAdvancedOption & {
    undefinedObjectProperties?: never
  }

export type NormalizedAdvancedMergeStatesInput = {
  originalState: JsonValueWithUndefinedObjectProperties
  submittedState: JsonValueWithUndefinedObjectProperties
  currentServerState: JsonValueWithUndefinedObjectProperties
  undefinedObjectProperties: "omit"
} & AdvancedMergeOptions & RequiresAdvancedOption

export type AdvancedMergeConflictDecision = {
  sessionId: string
  conflict: AdvancedMergeConflict
  choice: ConflictChoice
}

export type AdvancedApplyConflictDecisionsInput<T extends JsonValue = JsonValue> =
  AdvancedMergeStatesInput<T> & {
    sessionId: string
    decisions: readonly (ConflictDecision | AdvancedMergeConflictDecision)[]
  }

export type NormalizedAdvancedApplyConflictDecisionsInput =
  NormalizedAdvancedMergeStatesInput & {
    sessionId: string
    decisions: readonly (ConflictDecision | AdvancedMergeConflictDecision)[]
  }

export type AdvancedResolveConflictResult<T extends JsonValue = JsonValue> =
  | { matched: false; error: ErrorSignal }
  | { matched: true; result: AdvancedMergeResult<T> }
