import type { Conflict, JsonValue, MergeResult } from "conflict-aware-mutation"

export type Side = "submitted" | "currentServer"

/** Applies one side per conflict (by index) and merges again. See choose-sides.mjs. */
export declare function chooseSides<T extends JsonValue>(
  inputs: { originalState: T; submittedState: T; currentServerState: T },
  conflicts: Conflict[],
  choices: Side[],
): MergeResult<T>
