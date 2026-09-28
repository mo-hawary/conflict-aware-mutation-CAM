import {
  createRecoveryController,
  type CandidateValidation,
  type NormalizedRecoveryControllerOptions,
  type RecoveryControllerOptions,
  type RecoveryOutcome,
  type RecoveryToken,
} from "../../src/recovery/index.js"
import type {
  JsonValue,
  JsonValueWithUndefinedObjectProperties,
} from "../../src/types.js"

type State = { title: string }
type Latest = { state: State; etag: string }

const strictOptions: RecoveryControllerOptions<State, string, State, string, Latest> = {
  expectedError: { code: 412 },
  errorSignalFrom: (cause) =>
    cause !== null && typeof cause === "object" && "status" in cause
      ? { code: Number(cause.status) }
      : undefined,
  fetchLatest: async () => ({ state: { title: "server" }, etag: '"v2"' }),
  getVersion: (latest) => latest.etag,
  isTerminal: () => false,
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

const strictController = createRecoveryController(strictOptions)
void strictController.recover({
  entityId: "order-1",
  sessionId: "strict-session",
  draftRevision: 0,
  expectedVersion: '"v1"',
  originalState: { title: "original" },
  submittedState: { title: "local" },
})

declare const parserState: JsonValueWithUndefinedObjectProperties
// @ts-expect-error strict recovery accepts only the declared strict state type
strictController.recover({
  entityId: "order-1",
  sessionId: "strict-session",
  draftRevision: 0,
  expectedVersion: '"v1"',
  originalState: parserState,
  submittedState: parserState,
})

const normalizedOptions: NormalizedRecoveryControllerOptions<string, string, Latest> = {
  expectedError: { code: 412 },
  errorSignalFrom: (cause) =>
    cause !== null && typeof cause === "object" && "status" in cause
      ? { code: Number(cause.status) }
      : undefined,
  fetchLatest: async () => ({ state: { title: "server" }, etag: '"v2"' }),
  getVersion: (latest) => latest.etag,
  isTerminal: () => false,
  project: (merged) => merged,
  prepareCandidate: (candidate) => candidate,
  validateCandidate: (candidate): CandidateValidation<JsonValue> => ({
    valid: true,
    value: candidate,
  }),
  mutate: async (candidate, { expectedVersion }) => ({
    state: candidate,
    version: expectedVersion,
  }),
  isCurrent: () => true,
  groups: [{ id: "title", paths: [["title"]] }],
  undefinedObjectProperties: "omit",
}

const controller = createRecoveryController(normalizedOptions)
const pending = controller.recover({
  entityId: "order-1",
  sessionId: "session-1",
  draftRevision: 0,
  expectedVersion: '"v1"',
  originalState: { title: "original", caption: undefined },
  submittedState: { title: "local", caption: undefined },
})

async function consumeOutcome(): Promise<void> {
  const outcome = await pending
  const broad: RecoveryOutcome<JsonValue, JsonValue, string, string> = outcome
  void broad

  if (outcome.kind === "review-ready") {
    const token: RecoveryToken = outcome.token
    outcome.candidate satisfies JsonValue
    const confirmed = await controller.confirm(token)
    if (confirmed.kind === "saved") confirmed.state satisfies JsonValue
    await controller.reviseCandidate(token, { title: "edited" }, 1)
  } else if (outcome.kind === "conflicts") {
    outcome.currentServerState satisfies JsonValue
    await controller.reviseCandidate(outcome.handle, { title: "chosen" }, 1)
  } else if (outcome.kind === "changed-again") {
    outcome.currentServerState satisfies JsonValue
    outcome.latestVersion satisfies string
  }
}

void consumeOutcome
const jsonCandidate: JsonValue = { title: "candidate" }
void jsonCandidate

// @ts-expect-error confirmation tokens are opaque objects, not strings
controller.confirm("forged-token")
// @ts-expect-error a token must come from a review-ready outcome
controller.confirm({})
