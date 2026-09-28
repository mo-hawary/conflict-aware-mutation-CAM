# Migrating from 0.1.x

This guide describes the breaking changes introduced by the validation and merge hardening work. Consult the [changelog](../CHANGELOG.md) for the released version containing them; the main branch may be ahead of npm.

## Catch CAM configuration errors explicitly

`CAMConfigError` extends `Error`, not `TypeError`. Replace checks that use `instanceof TypeError` to identify invalid CAM input:

```js
import { CAMConfigError, mergeStates } from "conflict-aware-mutation"

try {
  mergeStates({ originalState: {}, submittedState: { value: undefined }, currentServerState: {} })
} catch (error) {
  if (!(error instanceof CAMConfigError)) throw error
  console.error(error.code, error.message) // CAM_CONFIG_ERROR and the invalid path
}
```

Both `mergeStates()` and `matchConflictError()` also throw `CAMConfigError` when called with a missing, `undefined`, or `null` top-level argument. This concerns the options object: `null` remains a valid JSON snapshot value.

The stable discriminator is `code: "CAM_CONFIG_ERROR"`. When inspecting an unknown error by code, check that it is a non-null object first. Internal invariant failures remain distinguishable from public validation errors.

## Pass explicit JSON snapshots

Enumerable object accessors and array-index accessors are rejected without invoking them. Array subclasses, sparse arrays, non-enumerable array indices, extra enumerable non-index array properties, and symbol keys are rejected. Materialize supported data explicitly before calling CAM; do not rely on getters or custom collection behavior.

Non-enumerable object properties and non-enumerable extra array properties are ignored. This is not identical to `JSON.stringify`: CAM requires enumerable array indices and rejects values that JSON serialization might omit or transform.

## Existing merge behavior

The three input names and success/conflict result shapes are unchanged. Nested objects merge recursively; arrays remain atomic. Absence still means deletion and differs from null. Outputs do not alias inputs, and negative zero is normalized to zero.

Validate the combined result against your domain rules and retry with the latest backend version or ETag. A structurally valid merge does not guarantee a valid business operation.

## Opt in to omitting object properties set to `undefined`

Strict JSON validation remains the default. Parser output that uses an own enumerable object property with value `undefined` can be normalized explicitly:

```js
const result = mergeStates({
  originalState,
  submittedState,
  currentServerState,
  undefinedObjectProperties: "omit",
})
```

The option treats those object properties as absent in each snapshot. It still rejects root `undefined`, array elements set to `undefined`, accessors, holes, and unsupported values. The normalized TypeScript overload returns `MergeResult<JsonValue>` because an omitted property may be required by the caller's input type; validate before narrowing the result back to an application type.

## Apply explicit conflict choices

Use `applyConflictDecisions()` when an application has collected a choice for each conflict. Create a fresh session ID whenever its snapshots or draft change, and attach that ID and the exact conflict tuple to each decision. CAM recomputes the current conflicts and rejects stale, missing, duplicate, or unknown decisions instead of selecting a default side. The helper returns a full merged result or throws `CAMConfigError`; it does not mutate its inputs. `resolveConflict()` composes `matchConflictError()` and `mergeStates()` when the caller already has all three snapshots. Keep using the low-level functions separately when the latest state should be fetched only after a matching backend error.

The opt-in `undefinedObjectProperties: "omit"` mode is also accepted by `applyConflictDecisions()` and `resolveConflict()`. As with `mergeStates()`, strict behavior is the default and normalized results use `JsonValue` typing.

## Coupled paths and change reports

Pass explicit `groups` to treat related paths as one decision unit. This changes the result type to `GroupedMergeResult`; without groups, the original `MergeResult` shape is preserved. Pass `includeReport: true` when the application needs path-level provenance. Reports are opt-in and never expose a persistable partial value for unresolved conflicts. `formatConflictPath()` returns an RFC 6901 JSON Pointer for display.

## Recovery adapter import

The optional callback-based controller is imported from `conflict-aware-mutation/recovery`, not the package root. It checks the latest state before producing a review candidate and requires explicit confirmation with the fetched version by default. `autoRetry: "once"` enables one recovery write for a clean merge; it does not remove the backend version precondition.

The controller now accepts `groups` for the same coupled-path semantics used by `mergeStates()`, plus `undefinedObjectProperties: "omit"` for parser-style object properties. In normalized mode, use a broad JSON type until your application validator has re-established the domain type.

When a confirmed or automatic recovery write loses another version race, the `changed-again` outcome includes `candidate`, `currentServerState`, and `latestVersion`. Continue with that server snapshot as the new `originalState` and that version as the new `expectedVersion`; using the older editing baseline can misclassify earlier server-only changes as local edits.

Cancellation and navigation guards prevent obsolete work from starting later side effects. They do not rewrite history: if `mutate()` has already been accepted by the backend, the controller returns `saved` even if the edit session becomes obsolete before the response is processed.
