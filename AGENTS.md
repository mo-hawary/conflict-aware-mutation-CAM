# AGENTS.md

## Mission

Build CAM as a small, headless, framework-independent conflict-aware mutation library for ordinary CRUD/admin applications.

The core problem is deterministic recovery after a stale mutation.

CAM works with three explicit state snapshots:

- `originalState`: server state captured when editing started
- `submittedState`: state the user attempted to save
- `currentServerState`: newest server state fetched after a confirmed stale-write conflict

Do not revert these names to `base`, `submitted`, or `latest` in the public API.

## Core architectural rule

**Error matching and three-way merging are separate primitives.**

A caller should be able to check whether a backend error matches the configured conflict condition before fetching `currentServerState`.

Target flow:

```text
mutation fails
    -> normalize backend error
    -> matchConflictError()
        -> not matched: return/display configured error
        -> matched: fetch currentServerState
            -> mergeStates()
```

A convenience `resolveConflict()` may compose both concerns for callers that already have all inputs, but it must not replace the low-level split primitives.

## v1 data domain

v1 is JSON-compatible only.

For the consumer-facing capability matrix and runnable data-shape examples, see [Supported data and merge granularity](./README.md#supported-data-and-merge-granularity) in the README. This file remains the contract; keep the README summary in sync with it.

```ts
type JsonPrimitive = string | number | boolean | null

type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }
```

Reject in v1:

- `undefined`
- `Date`
- `Map`
- `Set`
- `BigInt`
- functions
- symbols
- class instances
- cyclic references
- `NaN`
- `Infinity` / `-Infinity`
- enumerable object accessors and array-index accessors, rejected without invoking them
- `Array` subclasses, sparse arrays, and arrays with extra enumerable non-index properties

Non-enumerable own object properties are ignored, as with `JSON.stringify`, and their getters are never invoked. Array indices must be enumerable: CAM rejects non-enumerable array indices even though `JSON.stringify` serializes array slots by position. Non-enumerable extra array properties are ignored.

Validation reads every included property exactly once, through its own data descriptor, into a private snapshot. Merging operates only on that snapshot, so a proxy or getter cannot make the merged value differ from the validated value.

Migration note: `CAMConfigError` now extends `Error` directly rather than `TypeError`. Consumers should use `instanceof CAMConfigError` or `error.code === "CAM_CONFIG_ERROR"` to detect invalid CAM inputs. Validation rejects enumerable object accessors and array-index accessors, `Array` subclasses, sparse arrays, non-enumerable array indices, and arrays with extra enumerable non-index properties; callers should normalize those values to plain JSON data first.

Null-prototype objects are accepted; output objects always use `Object.prototype`. Shared (non-cyclic) references are treated as independent copies, as `JSON.stringify` would.

Property absence represents deletion. Property absence and `null` are distinct states.

Unsupported values are programmer/config errors, not conflict results.

## Error contract

```ts
/** At least one of `code` or `text` is required. Prefer `code`. */
type ErrorSignal =
  | { code: string | number; text?: string }
  | { code?: never; text: string }

type ErrorOutput =
  | "backend"
  | { text: string }
```

Rules:

- `error` must contain at least one of `code` or `text`.
- `expectedError` must contain at least one of `code` or exact `text`.
- `{}` and `{ code: undefined, text: undefined }` are invalid.
- Prefer `code`.
- `text` matching is exact only in v1.
- If both expected fields are supplied, both must match.
- `code` matching is strict (`409` does not match `"409"`); numeric codes must be finite.
- Read only **own** `code`/`text` properties. Validation, matching, and output must all use the same validated snapshot; never read inherited fields or prototype getters.
- Invalid matcher configuration throws.

### `matchConflictError()`

Target shape:

```ts
matchConflictError({
  error,
  expectedError,
  errorOutput,
}): ErrorMatchResult
```

```ts
type ErrorMatchResult =
  | { matched: true }
  | {
      matched: false
      error: ErrorSignal
    }
```

`errorOutput` defaults to `"backend"`.

When custom text is configured:

```ts
errorOutput: { text: "Unable to update this order" }
```

preserve the backend code when present and replace only the returned text.

## Merge contract

Target primitive:

```ts
mergeStates<T extends JsonValue>({
  originalState,
  submittedState,
  currentServerState,
}): MergeResult<T>
```

Result:

```ts
type PathSegment = string | number

/** `exists: false` means the property is absent (deleted) on that side. */
type ConflictValue =
  | { exists: false }
  | { exists: true; value: JsonValue }

type Conflict = {
  path: PathSegment[]
  submitted: ConflictValue
  currentServer: ConflictValue
}

type MergeResult<T extends JsonValue> =
  | {
      ok: true
      value: T
      conflicts: []
    }
  | {
      ok: false
      kind: "conflict"
      conflicts: Conflict[]
    }
```

Do **not** expose `value?: T` on a conflict result in v1. An unresolved partial merge must never look persistable.

Conflict sides use `ConflictValue`, not raw `JsonValue`, so deletion (`{ exists: false }`) stays distinct from explicit `null` (`{ exists: true, value: null }`). Example: original `{ phone: "111" }`, submitted `{}`, current server `{ phone: "222" }` produces a conflict at `["phone"]` with `submitted: { exists: false }` and `currentServer: { exists: true, value: "222" }`.

`ok` is intentionally familiar to JavaScript developers, but the merge core is not an HTTP `Response`.

## Three-way semantics

For each path:

```text
submittedState == originalState
currentServerState != originalState
=> server-only change
=> keep currentServerState

submittedState != originalState
currentServerState == originalState
=> submitted-only change
=> keep submittedState

submittedState == currentServerState
=> both agree
=> no conflict

submittedState != originalState
currentServerState != originalState
submittedState != currentServerState
=> true conflict
```

## Recursive objects

Nested objects must be traversed recursively.

Example:

```text
submittedState changes shippingAddress.city
currentServerState changes shippingAddress.street
```

This is not a conflict. Merge both safely.

## Path representation

Use arrays of path segments:

```ts
["shippingAddress", "city"]
["customer", "phone"]
```

Do not use dotted strings as the canonical core representation. Real keys may contain dots or brackets.

A formatting helper may later expose JSON Pointer or human-readable strings.

## Arrays

Arrays are atomic by default. Without array options:

- only submitted side changes array -> keep submitted array
- only server side changes array -> keep server array
- both change to same array -> safe
- both change differently -> conflict at the array path

Opt-in array rules (`arrays`) select `keyed`, `sequence` (diff3), `set`, or `multiset` merging per path. They never change the result of a call that does not configure them. Keyed items are addressed by `{ key, value }` path segments and sequence regions by `{ from, to }` segments in original indices; these segments appear only in results of calls that use array rules. Any array strategy may add conflicts when alignment is uncertain but must never silently combine incompatible edits. In particular:

- `sequence` results contain only elements taken whole from one side; never merge inside an element both sides changed, because equal lengths do not prove that rows correspond
- a value one side deleted must never come back through the other side's move (checked with per-value three-way counts over the changed regions)
- `multiset` counts follow the three-way rule per value: identical changes agree
- `set` results never contain duplicates, and set/multiset change detection compares membership or counts, never array order
- keyed and set invariants are validated in all three states, independent of merge fast paths
- every change that shapes the result, including keyed ordering, is reported, so `autoMerge: "review-mixed"` only auto-accepts a result one side wrote

Pattern groups (`ANY`, `EACH`), `derived` paths, `rules`, and `autoMerge: "review-mixed"` are likewise opt-in. They exist so that cross-field domain constraints are declared explicitly; CAM still never infers them.

Recurse into an object only when it exists as a plain object on all three sides. Both sides adding the same key with different objects is a conflict at that key's path.

## Deletion/null semantics

For object properties:

- absent key = deletion
- key with `null` = explicit null

They are different.

`undefined` is invalid input and must not be silently treated as deletion.

## Programmer errors vs domain results

Throw for invalid usage/configuration:

- invalid/empty `ErrorSignal`
- unsupported value type
- cycle in state tree
- `undefined`
- invalid option value
- malformed path/config object

Public validation/configuration failures use `CAMConfigError`, which extends `Error` (not `TypeError`) and carries `code: "CAM_CONFIG_ERROR"`. Reserve `TypeError` for internal invariant failures so the two stay distinguishable.

Return `ok: false, kind: "conflict"` only for valid state inputs with a genuine concurrent path collision.

## Core constraints

The core must remain:

- headless
- framework-independent
- backend-agnostic
- UI-agnostic
- network-free
- deterministic
- JSON-only in v1
- immutable with respect to caller inputs
- zero or minimal runtime dependencies

Do not add React, Vue, Angular, TanStack Query, Axios, Fetch, DOM, or UI dependencies to core.

## Convenience API and adapters

Possible public surfaces:

```ts
matchConflictError(...)
mergeStates(...)
resolveConflict(...) // convenience composition
resolveOrThrow(...)
asResponse(...)
```

`resolveConflict()` should compose existing primitives rather than duplicate semantics.

`resolveOrThrow()` may support libraries that expect return-or-throw behavior.

`asResponse()` may provide familiar `ok`, `status`, and `json()` ergonomics without contaminating core merge semantics with HTTP behavior.

## Testing expectations

Minimum v1 coverage:

1. ErrorSignal validation
2. exact code matching
3. exact text matching
4. combined code+text matching
5. unmatched error pass-through
6. custom unmatched-error text
7. scalar merge truth table
8. recursive object merge
9. missing key / deletion semantics
10. null semantics
11. atomic arrays
12. same array on both sides
13. conflicting arrays
14. additions on both sides
15. deletions on one or both sides
16. keys containing dots/brackets
17. deterministic path ordering
18. caller-input immutability
19. unsupported-type rejection
20. cyclic-input rejection
21. property-based tests over JSON trees
22. fuzz tests
23. representative benchmarks

Collection, rule, and review features additionally require:

24. keyed arrays: field merges, additions, deletions, delete versus edit, ordering, order conflicts, and invalid keys in any state
25. sequence arrays: separated edits, range conflicts, reorder versus edit conflicts, and the whole-element property
26. set and multiset arrays: membership, counts, and no duplicate set members
27. pattern groups (`ANY`, `EACH`) and derived paths
28. built-in and custom rules: blame per side, pre-existing violations, rule conflicts, and staged decisions across rounds
29. `review-mixed`: the property that only a result one side wrote is auto-accepted, and the recovery controller never auto-writes a mixed candidate

Every bug fix must include a regression test.

## Security/correctness

- Be prototype-pollution-safe when traversing or constructing objects.
- Never mutate `originalState`, `submittedState`, or `currentServerState`.
- Keep output deterministic: construct object keys in sorted order (JavaScript still enumerates integer-index keys first), and emit conflicts in lexicographic path order.
- Treat `-0` and `0` as equal. Output contains `0`, never `-0`.
- Reject symbol-keyed properties.
- Depth strategy for v1: validation rejects nesting deeper than 512 levels with `CAMConfigError`, which bounds all recursive traversal.

## Performance

Correctness first.

Implement TypeScript first.

Rust -> WebAssembly is optional and experimental. Do not make it default without end-to-end benchmark evidence that includes initialization and JS/WASM serialization overhead.

## Implementation order

1. public JSON types
2. runtime JSON validation
3. `CAMConfigError`
4. `ErrorSignal` validation
5. `matchConflictError()`
6. scalar merge truth table
7. recursive object traversal
8. path arrays
9. deletion/null semantics
10. atomic arrays
11. deterministic ordering
12. `resolveConflict()` convenience composition
13. adapters
14. property/fuzz tests
15. benchmarks
16. optional WASM prototype

## Scope control

CAM is not:

- a CRDT
- a realtime sync engine
- a collaborative editor
- a Git merge engine
- an HTTP client
- a UI component library
- a replacement for backend optimistic concurrency control

Avoid scope expansion unless it directly improves the small conflict-aware mutation primitive.

## Release discipline

- PR titles must follow Conventional Commits because the repository uses squash merges.
- Release Please owns normal package version bumps, `.release-please-manifest.json`, generated `CHANGELOG.md` release entries, `vX.Y.Z` tags, and GitHub Releases.
- Do not manually create or move release tags.
- Do not bypass the release PR to force a version.
- The initial npm bootstrap is complete. Keep normal publishing on the validated release-tag workflow with provenance enabled; do not repeat the bootstrap exception.
- Do not add long-lived npm publish tokens when OIDC trusted publishing is available.
- CI must verify supported Node LTS versions and run a package tarball dry-run.

## Repository discipline

- Keep the public API small.
- Prefer pure functions.
- Avoid hidden global state.
- Preserve caller input immutability.
- Keep outputs serializable.
- Document every semantic choice that could surprise consumers.
- Do not copy competitor implementation code. Build from the CAM contract and tests.
