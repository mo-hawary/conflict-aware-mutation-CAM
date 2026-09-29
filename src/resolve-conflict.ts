import { matchConflictError } from "./match-conflict-error.js"
import { mergeStates } from "./merge-states.js"
import type {
  AdvancedMergeResult,
  AdvancedMergeStatesInput,
  AdvancedResolveConflictResult,
  NormalizedAdvancedMergeStatesInput,
  GroupedMergeResult,
  GroupedMergeResultWithReport,
  JsonValue,
  MatchConflictErrorInput,
  MergeResult,
  MergeResultWithReport,
  MergeStatesBaseInput,
  MergeStatesInput,
  MergeStatesWithOptionsInput,
  NormalizedMergeStatesInput,
  NormalizedMergeStatesWithOptionsInput,
  NormalizedResolveConflictInput,
  PathGroup,
  ResolveConflictGroupedReportedResult,
  ResolveConflictGroupedResult,
  ResolveConflictInput,
  ResolveConflictReportedResult,
  ResolveConflictResult,
  ResolveRuntimeResult,
} from "./types.js"

/**
 * Matches a backend error first, then composes the three-way merge only when
 * that error is the configured conflict. The low-level matcher and merge
 * functions remain available for callers that fetch the latest state later.
 */
export function resolveConflict<T extends JsonValue>(
  input: MatchConflictErrorInput & MergeStatesInput<T>,
): ResolveConflictResult<T>
export function resolveConflict<T extends JsonValue>(
  input: ResolveConflictInput<T> & { groups: readonly PathGroup[]; includeReport: true },
): ResolveConflictGroupedReportedResult<T>
export function resolveConflict<T extends JsonValue>(
  input: ResolveConflictInput<T> & { groups: readonly PathGroup[]; includeReport?: never },
): ResolveConflictGroupedResult<T>
export function resolveConflict<T extends JsonValue>(
  input: ResolveConflictInput<T> & { groups?: never; includeReport: true },
): ResolveConflictReportedResult<T>
export function resolveConflict<T extends JsonValue>(
  input: ResolveConflictInput<T>,
): ResolveRuntimeResult<T>
export function resolveConflict(
  input: MatchConflictErrorInput & NormalizedMergeStatesWithOptionsInput & { groups: readonly PathGroup[]; includeReport: true },
): ResolveConflictGroupedReportedResult<JsonValue>
export function resolveConflict(
  input: MatchConflictErrorInput & NormalizedMergeStatesWithOptionsInput & { groups: readonly PathGroup[]; includeReport?: never },
): ResolveConflictGroupedResult<JsonValue>
export function resolveConflict(
  input: MatchConflictErrorInput & NormalizedMergeStatesWithOptionsInput & { groups?: never; includeReport: true },
): ResolveConflictReportedResult<JsonValue>
export function resolveConflict(
  input: MatchConflictErrorInput & NormalizedMergeStatesInput,
): ResolveConflictResult<JsonValue>
export function resolveConflict(
  input: MatchConflictErrorInput & NormalizedMergeStatesWithOptionsInput & { groups?: never; includeReport?: never },
): ResolveConflictResult<JsonValue>
export function resolveConflict(
  input: NormalizedResolveConflictInput,
): ResolveRuntimeResult<JsonValue>
export function resolveConflict<T extends JsonValue>(
  input: MatchConflictErrorInput & AdvancedMergeStatesInput<T>,
): AdvancedResolveConflictResult<T>
export function resolveConflict(
  input: MatchConflictErrorInput & NormalizedAdvancedMergeStatesInput,
): AdvancedResolveConflictResult<JsonValue>
export function resolveConflict<T extends JsonValue>(
  input:
    | ResolveConflictInput<T>
    | (MatchConflictErrorInput & NormalizedMergeStatesWithOptionsInput)
    | (MatchConflictErrorInput & AdvancedMergeStatesInput<T>)
    | (MatchConflictErrorInput & NormalizedAdvancedMergeStatesInput),
):
  | ResolveRuntimeResult<T>
  | ResolveRuntimeResult<JsonValue>
  | AdvancedResolveConflictResult<T>
  | AdvancedResolveConflictResult<JsonValue> {
  const match = matchConflictError(input)
  if (!match.matched) return match

  const merged = mergeStates(input as never) as
    | MergeResult<T>
    | GroupedMergeResult<T>
    | MergeResultWithReport<T>
    | GroupedMergeResultWithReport<T>
    | MergeResult<JsonValue>
    | GroupedMergeResult<JsonValue>
    | MergeResultWithReport<JsonValue>
    | GroupedMergeResultWithReport<JsonValue>
    | AdvancedMergeResult<T>

  return { matched: true, result: merged } as ResolveRuntimeResult<T> | AdvancedResolveConflictResult<T>
}
