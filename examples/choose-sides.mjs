// Convenience example that binds each choice to a caller-created session ID.
// CAM validates the complete conflict tuple before applying the decisions.
import { applyConflictDecisions } from "conflict-aware-mutation"

export function chooseSides(
  { originalState, submittedState, currentServerState },
  sessionId,
  conflicts,
  choices,
) {
  if (choices.length !== conflicts.length) {
    throw new RangeError("Provide exactly one side choice for every conflict")
  }

  return applyConflictDecisions({
    sessionId,
    originalState,
    submittedState,
    currentServerState,
    decisions: conflicts.map((conflict, index) => ({
      sessionId,
      conflict,
      choice: choices[index],
    })),
  })
}
