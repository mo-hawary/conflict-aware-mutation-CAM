export { CAMConfigError } from "./errors.js"
export { applyConflictDecisions } from "./apply-conflict-decisions.js"
export { formatConflictPath } from "./format-conflict-path.js"
export { matchConflictError } from "./match-conflict-error.js"
export { mergeStates } from "./merge-states.js"
export { resolveConflict } from "./resolve-conflict.js"

export type {
  ApplyConflictDecisionsInput,
  ChangeProvenance,
  ChangeReportEntry,
  Conflict,
  ConflictChoice,
  ConflictDecision,
  ConflictValue,
  ErrorMatchResult,
  ErrorOutput,
  ErrorSignal,
  GroupChangeReportEntry,
  GroupConflict,
  GroupConflictSlot,
  GroupedMergeResult,
  GroupedMergeResultWithReport,
  JsonPrimitive,
  JsonValue,
  JsonValueWithUndefinedObjectProperties,
  MatchConflictErrorInput,
  MergeConflict,
  MergeReport,
  MergeResult,
  MergeResultWithReport,
  MergeStatesBaseInput,
  MergeStatesInput,
  MergeStatesWithOptionsInput,
  NormalizedApplyConflictDecisionsInput,
  NormalizedMergeStatesInput,
  NormalizedMergeStatesWithOptionsInput,
  NormalizedResolveConflictInput,
  PathChangeReportEntry,
  PathGroup,
  PathSegment,
  ReportSlot,
  ResolveConflictGroupedReportedResult,
  ResolveConflictGroupedResult,
  ResolveConflictInput,
  ResolveConflictReportedResult,
  ResolveConflictResult,
} from "./types.js"
