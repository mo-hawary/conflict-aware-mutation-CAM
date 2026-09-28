import type { Conflict, JsonValue, MergeResult } from "conflict-aware-mutation"

export type Side = "submitted" | "currentServer"

/** Applies one session-bound side choice per conflict. See choose-sides.mjs. */
export declare function chooseSides<T extends JsonValue>(
  inputs: { originalState: T; submittedState: T; currentServerState: T },
  sessionId: string,
  conflicts: Conflict[],
  choices: Side[],
): MergeResult<T>
