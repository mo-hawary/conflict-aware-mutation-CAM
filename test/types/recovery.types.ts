import {
  applyConflictDecisions,
  mergeStates,
  resolveConflict,
  type Conflict,
  type ConflictDecision,
  type JsonValue,
  type JsonValueWithUndefinedObjectProperties,
  type MergeResult,
  type ResolveConflictResult,
} from "../../src/index.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <T extends true>(): T => true as T

type Order = { id: string; status: string }
declare const order: Order
declare const conflict: Conflict
declare const decisions: readonly ConflictDecision[]

const strictMerge = mergeStates({
  originalState: order,
  submittedState: order,
  currentServerState: order,
})
assertType<Equal<typeof strictMerge, MergeResult<Order>>>()

const strictApply = applyConflictDecisions({
  originalState: order,
  submittedState: order,
  currentServerState: order,
  sessionId: "session-1",
  decisions,
})
assertType<Equal<typeof strictApply, MergeResult<Order>>>()

declare const parsed: JsonValueWithUndefinedObjectProperties
const normalizedMerge = mergeStates({
  originalState: parsed,
  submittedState: parsed,
  currentServerState: parsed,
  undefinedObjectProperties: "omit",
})
assertType<Equal<typeof normalizedMerge, MergeResult<JsonValue>>>()

const normalizedApply = applyConflictDecisions({
  originalState: parsed,
  submittedState: parsed,
  currentServerState: parsed,
  undefinedObjectProperties: "omit",
  sessionId: "session-1",
  decisions,
})
assertType<Equal<typeof normalizedApply, MergeResult<JsonValue>>>()

const normalizedResolve = resolveConflict({
  error: { code: 409 },
  expectedError: { code: 409 },
  originalState: parsed,
  submittedState: parsed,
  currentServerState: parsed,
  undefinedObjectProperties: "omit",
})
assertType<Equal<typeof normalizedResolve, ResolveConflictResult<JsonValue>>>()

const strictResolve = resolveConflict({
  error: { code: 409 },
  expectedError: { code: 409 },
  originalState: order,
  submittedState: order,
  currentServerState: order,
})
assertType<Equal<typeof strictResolve, ResolveConflictResult<Order>>>()

// Explicitly opting into omission is required for undefined object values.
const parserOutput = { caption: undefined, title: "Order" }
// @ts-expect-error strict calls accept JSON only
mergeStates({ originalState: parserOutput, submittedState: parserOutput, currentServerState: parserOutput })
