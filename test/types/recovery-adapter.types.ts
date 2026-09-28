import {
  createRecoveryController,
  type CandidateValidation,
  type RecoveryControllerOptions,
  type RecoveryOutcome,
  type RecoveryToken,
} from "../../src/recovery/index.js"
import type { JsonValue } from "../../src/types.js"

type State = { title: string }
type Latest = { state: State; etag: string }

const options: RecoveryControllerOptions<State, string, State, string, Latest> = {
  expectedError: { code: 412 },
  errorSignalFrom: (cause) =>
    cause !== null && typeof cause === "object" && "status" in cause
      ? { code: Number(cause.status) }
      : undefined,
  fetchLatest: async () => ({ state: { title: "server" }, etag: '"v2"' }),
  getVersion: (latest) => latest.etag,
  isTerminal: (state) => state.title === "deleted",
  project: (merged) => merged,
  prepareCandidate: (candidate) => candidate as State,
  validateCandidate: (candidate): CandidateValidation<State> => ({
    valid: true,
    value: candidate,
  }),
  mutate: async (candidate, { expectedVersion }) => ({
    state: candidate,
    version: expectedVersion,
  }),
  isCurrent: () => true,
}

const controller = createRecoveryController<State, string, State, string, Latest>(options)
const pending = controller.recover({
  entityId: "order-1",
  sessionId: "session-1",
  draftRevision: 0,
  expectedVersion: '"v1"',
  originalState: { title: "original" },
  submittedState: { title: "local" },
})

async function consumeOutcome(): Promise<void> {
  const outcome = await pending
  if (outcome.kind === "review-ready") {
    const token: RecoveryToken = outcome.token
    const confirmed: RecoveryOutcome<State, State, string, string> =
      await controller.confirm(token)
    void confirmed
    await controller.reviseCandidate(token, { title: "edited" }, 1)
  } else if (outcome.kind === "conflicts") {
    await controller.reviseCandidate(outcome.handle, { title: "chosen" }, 1)
  }
}

void consumeOutcome
const jsonCandidate: JsonValue = { title: "candidate" }
void jsonCandidate

// @ts-expect-error confirmation tokens are opaque objects, not strings
controller.confirm("forged-token")
// @ts-expect-error a token must come from a review-ready outcome
controller.confirm({})
