# Safer integration roadmap: implementation record

**Status:** Approved on 2026-09-28; Phases 0–7 implemented. Local verification and limits are recorded below.
**Baseline source:** `main` at `01e631028c72a8f4c50f3ef66d188debf96abc07` (`v0.2.1`), current with `origin/main` on 2026-09-28.
**Scope:** CAM repository only. This does not authorize changes to ALORA, publishing, releases, commits, pushes, or deployments.

## Baseline at the reviewed source revision

The root package exports `mergeStates()`, `matchConflictError()`, and `CAMConfigError`. `mergeStates()` snapshots strict JSON, merges plain objects recursively, treats arrays atomically, and returns no candidate when conflicts remain. Those defaults are specified in `AGENTS.md` and documented in the README.

`examples/choose-sides.mjs` currently applies index-based choices to caller-supplied conflict paths and silently defaults unknown choices to the server side. `examples/fetch-rest.mjs` and the React example retry structurally merged candidates without a review or domain-validation step. The React example already blocks duplicate actions and detects some draft revisions. It does not cover terminal records, derived values, cancellation, navigation, or editor-replacement invalidation.

Existing GitHub issues need coordination:

- [#23 `resolveConflict()`](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/23) is a matcher-plus-merge convenience composition, not manual conflict resolution.
- [#24 `resolveOrThrow()` / `asResponse()`](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/24) is deferred until a real consumer needs those adapters.
- [#25 `formatConflictPath()`](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/25) covers display-only path formatting.
- [#27 backend examples](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/27) adds a server example, which is adjacent to but outside these phases.
- [#28 benchmark scenarios](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/28) adds ID-keyed records, string-heavy payloads, and deletion-heavy edits.
- [#26 WASM evaluation](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/26) requires end-to-end initialization and serialization evidence and is outside this roadmap.

The integration review cited by the roadmap identifies parser-produced own `undefined` captions, derived variant media, invalid draft defaults, deletion before field choices, and adapter failures that must remain visible. The source PR was reverted; its marketplace code and business rules stay outside CAM.

## Approved contracts and implementation

### 1. Manual choices and session validation

Implement `applyConflictDecisions()` as a distinct helper; keep `resolveConflict()` reserved for issue #23's error-matching composition.

```ts
type ConflictChoice = "submitted" | "currentServer"

type ConflictDecision = {
  sessionId: string
  conflict: MergeConflict
  choice: ConflictChoice
}

applyConflictDecisions({
  sessionId,
  originalState,
  submittedState,
  currentServerState,
  decisions,
})
```

The caller creates a new `sessionId` whenever any of the three snapshots or the editing draft changes. Every decision carries that ID. The helper requires every decision ID to match, recomputes the current merge, and accepts a decision only when its full conflict tuple (path and both existence-aware side values) equals a current conflict. It rejects stale, unknown, duplicate, or missing choices with `CAMConfigError`; it never guesses a side. Choices may select only the submitted or current-server side. Root conflicts, atomic arrays, absence versus `null`, and prototype-shadowing keys use the existing `PathSegment[]` and `ConflictValue` contract. The result has the existing all-or-nothing `MergeResult` shape. The helper copies its output and does not mutate inputs, choices, or conflict records.

This binds choices to an application-defined conflict session without hidden module state, object-identity requirements, or a hash. Applications must not reuse an ID after changing the snapshots or draft. It does not replace adapter approval binding: the adapter binds confirmation to entity, server version, draft revision, candidate, and policy configuration.

Issue #23's `resolveConflict()` composition is implemented. It accepts the error matcher inputs and all three snapshots, calls `matchConflictError()` first, and calls `mergeStates()` only for a matched error. Its unmatched arm returns the configured backend error. Both low-level functions remain public.

```ts
type ResolveConflictResult<T extends JsonValue> =
  | { matched: false; error: ErrorSignal }
  | { matched: true; result: MergeResult<T> }
```

### 2. Opt-in normalization of own object properties set to `undefined`

Keep strict JSON rejection as the default. Add one explicit `undefinedObjectProperties: "omit"` option to each state-consuming primitive that supports normalization, including merge and manual resolution. In that mode, omit only own enumerable object data properties whose descriptor value is `undefined`; omission means deletion in a complete snapshot. Continue rejecting root `undefined`, array elements set to `undefined`, holes, accessors, unsupported types, symbols, cycles, and excessive depth. `null` remains a value. Read descriptors once and never invoke getters.

Expose `JsonValueWithUndefinedObjectProperties` for this opt-in input:

```ts
type JsonValueWithUndefinedObjectProperties =
  | JsonPrimitive
  | JsonValueWithUndefinedObjectProperties[]
  | { [key: string]: JsonValueWithUndefinedObjectProperties | undefined }
```

Its root and array slots remain JSON-only, while object property values also allow `undefined`. Keep the current `MergeStatesInput<T extends JsonValue>` for strict calls, and add a separate normalized input type that requires `undefinedObjectProperties: "omit"`. Strict calls keep returning `MergeResult<T>`. Normalized calls return `MergeResult<JsonValue>` because omission can remove a property that the caller typed as required. A caller can recover a domain type only after a runtime validator succeeds. For example, a parser type `{ caption: string | undefined }` cannot be returned as that same type after normalization removes `caption`.

Apply this option to `mergeStates()`, `applyConflictDecisions()`, and the `resolveConflict()` composition. `resolveConflict()` forwards the option to `mergeStates()` after matching the error. Tests and examples must pass the same option for all three snapshots.

### 3. Domain preparation, validation, and review

Keep domain schemas and derived-field rules in callbacks/examples, not in the JSON merge engine. Structural success remains a candidate. A runtime type guard or assertion may establish a domain type only after it succeeds. The recommended order is:

1. Attempt the user's version-checked mutation.
2. On a confirmed stale error, fetch the latest state and version.
3. Check whether the latest record is terminal.
4. Structurally merge or apply explicit choices.
5. Project and prepare derived fields from authoritative editable inputs.
6. Validate the full candidate.
7. Show the candidate and validation details for review or editing.
8. After an edit or manual choice, prepare and validate again. Show material changes before confirmation.
9. Save only after explicit confirmation, with the latest version precondition.

Invalid candidates and user edits remain available for repair. A changed server version invalidates prior confirmation. Reuse the existing React example layout; do not add a new UI surface.

### 4. Coupled paths

Use explicit group IDs with arrays of path-segment arrays:

```ts
type PathGroup = { id: string; paths: PathSegment[][] }
type GroupMergeInput<T extends JsonValue> = MergeStatesWithOptionsInput<T> & {
  groups: PathGroup[]
}

type GroupConflictSlot = { path: PathSegment[]; value: ConflictValue }
type GroupConflict = {
  kind: "group"
  groupId: string
  paths: PathSegment[][]
  submitted: GroupConflictSlot[]
  currentServer: GroupConflictSlot[]
}
type MergeConflict = Conflict | GroupConflict
```

Group members form one decision unit: one-sided changes are retained, identical two-sided changes agree, and different two-sided group changes require one group choice. Preserve independent changes outside groups. A missing object ancestor is treated as absent and reconstructed when selected grouped values and independent sibling edits require it. When a configured member sits beneath an ancestor that cannot be split safely (an array, scalar, `null`, or an edit/delete parent collision), that whole ancestor becomes the effective group member instead of turning data shape into a configuration error.

Start conservatively: reject empty groups, duplicate paths within or across groups, duplicate IDs, ancestor/overlapping paths within or across groups, and root paths. These checks use the configuration only; a member beneath an ancestor that cannot be split (an array, scalar, or `null`, or an object deleted on one side and edited on the other) is replaced in its group by that ancestor path. Grouped calls use a separate `GroupedMergeResult<T>` whose conflict arm contains `MergeConflict[]`. The default `MergeResult<T>` remains unchanged. Report a group collision as one discriminated `GroupConflict` carrying deterministic `{ path, value }` slots for each member. Each slot uses `ConflictValue`, so absence stays distinct from `null`. Do not invent a dotted or synthetic path. Manual resolution uses one `ConflictDecision` for the `groupId` and selects the submitted or current-server slots for every member. Keep the existing `mergeStates()` result and default behavior unchanged when no groups are configured.

```ts
type GroupedMergeResult<T extends JsonValue> =
  | { ok: true; value: T; conflicts: [] }
  | { ok: false; kind: "conflict"; conflicts: MergeConflict[] }
```

For example, group `variant-choice` can contain `[["defaultVariantId"], ["variants"], ["coverMediaId"]]`. A conflict reports all three submitted and current-server slots under that `groupId`. A caller makes one choice for the full group. Fields outside those paths still merge independently.

### 5. Optional change reports

Add `includeReport: true` as an opt-in to `mergeStates()`, `applyConflictDecisions()`, and `resolveConflict()`. Both success and conflict results then include `report: { changes: ChangeReportEntry[] }`; calls without the option keep the existing result shape. Each entry describes the smallest merge unit (leaf object field, atomic array, object add/delete, or whole coupled group) with original, submitted, current-server, and result existence-aware slots and provenance. Use `submitted-only`, `server-only`, and `identical-both` for structural results. An applied manual choice uses `chosen-submitted` or `chosen-currentServer`. Use `unresolved` when the merge needs a decision. Unresolved entries have no result slot. A report never exposes a saveable entity on a conflict result.

For path entries, `original`, `submitted`, `currentServer`, and `result` are `ConflictValue`. For group entries, each side is a path-sorted list of `{ path, value: ConflictValue }`. An unresolved entry omits `result`; an applied manual decision records the selected source as its provenance. An object addition or deletion produces one entry at the added or deleted path. An atomic array produces one entry at the array path.

```ts
type ReportSlot = { path: PathSegment[]; value: ConflictValue }
type ChangeProvenance =
  | "submitted-only"
  | "server-only"
  | "identical-both"
  | "chosen-submitted"
  | "chosen-currentServer"
  | "unresolved"

type ChangeReportEntry =
  | {
      kind: "path"
      path: PathSegment[]
      original: ConflictValue
      submitted: ConflictValue
      currentServer: ConflictValue
      result?: ConflictValue
      provenance: ChangeProvenance
    }
  | {
      kind: "group"
      groupId: string
      original: ReportSlot[]
      submitted: ReportSlot[]
      currentServer: ReportSlot[]
      result?: ReportSlot[]
      provenance: ChangeProvenance
    }
```

Sort entries by lexicographic path/group ordering, copy all slots into the report, include identical changes, and do not log report data. Measure allocations and package size with reporting disabled/enabled. Adapt the current React conflict picker to consume the report; format segments unambiguously.

Implement issue #25's `formatConflictPath()` as a display helper alongside the report. JSON Pointer is the stable string form; any human-readable rendering remains explicitly for display.

For example, `formatConflictPath(["shippingAddress", "city"])` returns `/shippingAddress/city`; the root path returns the empty JSON Pointer string. Keys containing `/` and `~` use RFC 6901 escaping. A report entry for `status` can return `{ kind: "path", path: ["status"], original: { exists: true, value: "draft" }, submitted: { exists: true, value: "draft" }, currentServer: { exists: true, value: "approved" }, result: { exists: true, value: "approved" }, provenance: "server-only" }`.

### 6. Optional recovery adapter

`createRecoveryController()` is implemented in the dependency-free `conflict-aware-mutation/recovery` subpath; the root entry point does not load adapter code. The default is review mode; one automatic recovery retry requires `autoRetry: "once"`. The controller exposes `recover()`, `reviseCandidate()`, `confirm()`, and `cancel()`. A review-ready outcome carries an opaque in-memory token object. The controller binds that token to the entity, latest version, draft revision, candidate, and captured policy configuration. A candidate edit runs projection, preparation, and validation again and produces a new token.

```ts
type CandidateValidation<T> =
  | { valid: true; value: T }
  | { valid: false; candidate: JsonValue; issues: readonly unknown[] }

type RecoveryStage =
  | "mutate"
  | "isStaleError"
  | "fetchLatest"
  | "getVersion"
  | "isTerminal"
  | "merge"
  | "project"
  | "prepareCandidate"
  | "validateCandidate"
  | "isCurrent"

type RecoveryOutcome<T, S, V> =
  | { kind: "review-ready"; candidate: T; latestVersion: V; sessionId: string; token: RecoveryToken }
  | { kind: "conflicts"; sessionId: string; conflicts: Conflict[]; currentServerState: S; latestVersion: V; handle: RecoverySessionHandle }
  | { kind: "validation-failed"; sessionId: string; candidate: JsonValue; issues: readonly unknown[]; latestVersion: V; handle: RecoverySessionHandle }
  | { kind: "terminal"; currentServerState: S; latestVersion: V }
  | { kind: "changed-again"; candidate: T; currentServerState: S; latestVersion: V; sessionId: string }
  | { kind: "failed"; stage: RecoveryStage; cause: unknown }
  | { kind: "cancelled" | "obsolete" | "busy" }
  | { kind: "saved"; state: T; version: V }
```

The adapter accepts callbacks for mutation, latest-state fetch, stale-error classification, projection, candidate preparation, candidate validation, terminal-state checks, version extraction, and cancellation/session currency. It also accepts the core merge-policy options `groups` and `undefinedObjectProperties: "omit"`, so recovery does not silently fall back to weaker merge semantics than direct `mergeStates()` calls. `CAMConfigError` remains a thrown configuration error. Structural conflicts and expected validation failures are typed outcomes. An unexpected callback exception becomes `failed` with its original cause and stage. A stale-write result becomes a race outcome instead of a generic failure. A known-stale version is never written. Check cancellation and session currency before every side-effecting callback. Block duplicate actions synchronously, then check currency after every awaited callback before another side effect. For a successful mutation, return the accepted saved result even if navigation or cancellation happens while its response is in flight; those guards cannot undo a server write. One second race yields `changed-again` with the rebased intent plus the exact server snapshot/version baseline that produced it. Cancellation does not claim to undo an accepted write.

The ordinary submission first calls `mutate()` with its required initial version. After a configured stale error, review mode fetches the latest state and does no recovery write until explicit confirmation. The examples prove the callback contract for ETags with `412` and an explicit version field with `409`.

### 7. Arrays by ID

Treat Phase 7 as evaluation only. Keep arrays atomic by default and do not implement identity-aware merging in this roadmap pass. Compare the cited variant/media cases with ID-keyed object records and coupled-path groups; record what remains unsolved. Any future prototype needs a separately approved contract for identity, duplicates/missing IDs, reorders, additions, deletion-versus-edit, and item-level conflicts.

## Regression fixtures to build

These are generic JSON fixtures, not imported application policy:

1. Parser-like nested object properties with `caption: undefined`: strict rejection; opt-in normalization drops the key consistently from all three snapshots, with zero getter invocation and no mutation.
2. Local default-variant change versus server variant/media change: coupled group decision or domain preparation recomputes the dependent media value.
3. Draft selects an inactive default variant: candidate remains editable after validation failure.
4. Local publish intent versus latest server deletion: terminal outcome before field conflict decisions.
5. Invalid manual group/field choice preserves choices and candidate details for repair.
6. Valid but sensitive combined edit remains review-only until explicit confirmation.
7. Version changes after review: reject the version-guarded write and invalidate prior approval.
8. Navigation, cancellation, or a newer draft during async work: obsolete results cannot update state or start another write.
9. Deletion versus `null`, root conflict, dotted/bracket keys, and `__proto__`: correct choice application without unsafe writes.
10. Existing arrays remain atomic in strict/default mode.

## Implementation and verification record

- Phases 0–2: the approved API contracts, exact-tuple manual decisions, strict-by-default object `undefined` omission, and match-first `resolveConflict()` composition are implemented.
- Phases 3–4: fetch and React examples use review-first recovery with candidate preparation/validation; explicit coupled-path groups, optional change reports, and RFC 6901 formatting are implemented. The React example's baseline automatic retry after a clean merge is now a review candidate plus a separate explicit Confirm action. These are repository examples rather than a production consumer integration, so no consumer line-removal count is claimed.
- Phase 5: the optional recovery controller is exported only through `conflict-aware-mutation/recovery`. Both ETag/412 and version/409 examples are included. The controller defaults to review mode, requires a version precondition for every mutation, forwards configured coupled-path groups, supports opt-in object-`undefined` omission, preserves the baseline needed after a second race, and never masks an already accepted write as cancelled/obsolete.
- Phase 6: representative merge benchmarks compare report-disabled and report-enabled paths and measure retained output heap. On local Node `v24.21.0`, the clean order-form scenario measured 59.4 μs/op without reports and 57.9 μs/op with reports in a short run; retaining 2,000 results measured 431.6 versus 2,519.1 bytes/result. The timing difference is within short-run noise; the retained output shows the report data cost. Package verification exercises isolated runtime and type consumers; package checks include a packed tarball dry-run.
- Coverage gates keep the core at 95% lines, branches, and functions. The optional recovery subpath has separate 93% line, 90% branch, and 100% function thresholds; the focused recovery suite exercises its public state machine, including eager policy validation and strict-versus-normalized typing. Remaining uncovered branches are internal invariant fallbacks that are unreachable through the public API.
- Phase 7: evaluation result is **no-go** for shipped ID-array merging. See [`bench/array-by-id-evaluation.md`](../bench/array-by-id-evaluation.md) for semantics, gaps, tests, and measurements. Arrays remain atomic in the public API.
- Baseline: `01e631028c72a8f4c50f3ef66d188debf96abc07`, package version `0.2.1`; implementation is tracked in PR #35.
- Package verification includes isolated packed-consumer runtime and type checks, including consumer semantics with `exactOptionalPropertyTypes` disabled.
- Compatibility is enforced in CI on the supported Node LTS matrix; package/runtime checks remain authoritative for the current PR head.
- The React example's dedicated type-check and interaction suite was not run locally because `examples/react` dependencies are not installed; the changed example is selected by the existing CI workflow, which installs and runs both checks.
- Bundle budgets are explicit for both public entry points: 5 kB Brotli for the root entry and 10 kB Brotli for the optional recovery entry. The previous 2 kB root-only budget predated the new public APIs and was intentionally replaced rather than silently bypassed. CI is authoritative for the measured bundle sizes.
- No external roadmap or issue tracker was edited.

For Phase 7, collect concrete cases that atomic arrays and ID-keyed objects do not handle acceptably. Specify string IDs, missing and duplicate IDs, ID changes, ordering and reordering, concurrent additions, deletion versus edit, and conflicts within an element. Build a non-exported prototype behind per-path opt-in only if the collected evidence supports evaluation. Compare its semantics, tests, and package cost with atomic arrays, then record a go/no-go decision. “Remain atomic” is a valid outcome.

The owner approved this design baseline on 2026-09-28. The `resolveConflict()` composition and `formatConflictPath()` align with open issues #23 and #25. The Phase 7 no-go decision keeps existing array defaults unchanged.
