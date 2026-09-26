# CAM

**Conflict-Aware Mutation** is a small, headless three-way conflict resolver for CRUD mutations.

It is designed for the common case where a user edits a record, another actor changes that record before the first user saves, and the backend rejects the stale write.

> Status: active pre-release implementation. The TypeScript v1 core is implemented on `main`; the package is still private and versioned `0.0.0-development`. `matchConflictError()` and `mergeStates()` are the current public primitives. Convenience adapters, property/fuzz testing, benchmarks, and Rust/WASM work remain roadmap items.

## The problem

Imagine two admins editing the same order:

```text
Admin A loads order v7
Admin B loads order v7

Admin A changes shippingAddress.city
Admin B changes customer.phone

Admin B saves first -> order v8
Admin A tries to save v7 -> stale write rejected
```

The backend can detect the stale write. The client still needs to answer:

- Is this actually the conflict error CAM is supposed to handle?
- What changed in the user's submitted state?
- What changed on the server?
- Can the changes be merged safely?
- Which exact paths require human resolution?

CAM handles the error matching and three-way comparison without owning networking, fetching, retries, or UI.

## Current implementation

The core implementation is now on `main` (merged in PR #2 on September 26, 2026).

Implemented today:

- `CAMConfigError` for configuration/input failures
- `matchConflictError()` with exact, type-strict matching
- `mergeStates()` with deterministic three-way merge semantics
- JSON-only runtime validation with a 512-level nesting limit
- own-property-only error-signal handling; inherited getters/fields are ignored
- finite numeric error codes only
- recursive plain-object merging
- property absence vs explicit `null`
- `ConflictValue` wrappers so deletion is representable without ambiguity
- atomic arrays in v1
- deterministic sorted object output and conflict ordering
- signed-zero normalization (`-0` and `0` compare equal)
- safe handling of keys such as `__proto__`
- caller-input immutability through cloned output
- unit, integration, regression, and type-level contract tests
- CI on Node 24 using `npm ci`, typecheck, build-through-test, and Node's test runner

Current public runtime exports:

```ts
CAMConfigError
matchConflictError
mergeStates
```

The package is not published yet (`private: true`). `resolveConflict()`, `resolveOrThrow()`, `asResponse()`, property/fuzz suites, representative benchmarks, and any Rust/WASM engine are not part of the current implementation.

## Naming

CAM uses explicit state names at call sites:

- `originalState`: the server entity captured when editing started
- `submittedState`: the state the user attempted to save
- `currentServerState`: the newest server entity fetched after the stale-write failure

The names are intentionally descriptive. `originalState` is the common ancestor used to determine which side changed each path.

## v1 input domain

CAM v1 accepts **JSON-compatible values only**:

```ts
type JsonPrimitive = string | number | boolean | null

type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }
```

Unsupported in v1:

- `undefined`
- `Date`
- `Map`
- `Set`
- `BigInt`
- functions
- symbols
- class instances
- cyclic references
- symbol-keyed properties
- non-finite numbers such as `NaN` and `Infinity`
- nesting deeper than 512 levels

`-0` and `0` are treated as equal, matching their JSON serialization.

For object properties, **property absence represents deletion**. CAM distinguishes a missing property from a property whose value is `null`.

Invalid or unsupported inputs are programmer/configuration errors and should throw `CAMConfigError` or `TypeError`. They are not normal conflict results.

## Error signals

CAM never guesses whether an arbitrary backend failure is a concurrency conflict.

```ts
/**
 * At least one of `code` or `text` is required.
 * Prefer `code` when the backend exposes a stable machine-readable value.
 */
type ErrorSignal =
  | { code: string | number; text?: string }
  | { code?: never; text: string }

type ErrorOutput =
  | "backend"
  | { text: string }
```

Valid signals:

```ts
{ code: 409 }
{ code: "STALE_ORDER" }
{ text: "Order was modified by another user" }
{ code: 409, text: "Order was modified by another user" }
```

Invalid:

```ts
{}
{ code: undefined, text: undefined }
```

Matching rules:

- `error` and `expectedError` must each contain at least `code` or `text`.
- Prefer `code` because it is stable and machine-readable.
- `text` is exact-match only in v1.
- No substring, regex, or fuzzy matching in v1.
- If both expected `code` and `text` are provided, both must match.
- `code` matching is strict: `409` does not match `"409"`.
- Only **own** `code` and `text` properties are read. Inherited fields, including prototype getters on class instances, are ignored. Normalize backend errors into plain objects before matching.
- Numeric codes must be finite.

## Split error matching from merging

Error detection and merge calculation are separate primitives.

This matters because the caller should not fetch `currentServerState` until CAM has confirmed that the backend error is actually the expected conflict.

### 1. Match the backend error

```ts
const match = matchConflictError({
  error,
  expectedError: { code: 409 },
  errorOutput: "backend",
})
```

Result:

```ts
type ErrorMatchResult =
  | { matched: true }
  | {
      matched: false
      error: ErrorSignal
    }
```

`errorOutput` is optional and defaults to `"backend"`.

```ts
errorOutput: "backend"
```

returns the normalized backend error unchanged when it does not match.

A caller can instead override the returned text:

```ts
errorOutput: {
  text: "Unable to update this order"
}
```

If the backend error has a `code`, CAM preserves it and replaces only the returned `text`.

### 2. Fetch only after a match

```ts
if (!match.matched) {
  showError(match.error)
  return
}

const currentServerState = await fetchOrder(submittedState.id)
```

### 3. Run the three-way merge

```ts
const result = mergeStates({
  originalState,
  submittedState,
  currentServerState,
})
```

`resolveConflict()` is not part of the current public API. A future convenience composition may wrap error matching and merging for callers that already have all inputs, but the split primitives remain the underlying contract.

## Merge result

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

There is deliberately **no partially merged `value` on a conflict result in v1**. A caller should never be able to accidentally persist an unresolved draft as if it were safe.

Each side of a conflict is wrapped in a `ConflictValue`, because a raw `JsonValue` cannot tell a deleted property apart from one set to `null`:

```ts
mergeStates({
  originalState: { phone: "111" },
  submittedState: {},                    // user deleted phone
  currentServerState: { phone: "222" },  // server changed phone
})

// {
//   ok: false,
//   kind: "conflict",
//   conflicts: [
//     {
//       path: ["phone"],
//       submitted: { exists: false },
//       currentServer: { exists: true, value: "222" },
//     },
//   ],
// }
```

Had the server set `phone: null` instead, `currentServer` would be `{ exists: true, value: null }`.

`ok` intentionally follows the familiar JavaScript/Fetch convention without making CAM an HTTP abstraction.

## Conflict paths

CAM v1 uses path arrays instead of dotted strings:

```ts
["shippingAddress", "city"]
["customer", "phone"]
```

This avoids ambiguity for real object keys that contain dots, brackets, or other punctuation.

A formatter can later convert paths to JSON Pointer or human-readable strings for display, but the core representation stays unambiguous.

## Three-way merge rules

For each object path:

```text
submittedState == originalState
currentServerState != originalState
-> server-only change
-> keep currentServerState

submittedState != originalState
currentServerState == originalState
-> submitted-only change
-> keep submittedState

submittedState == currentServerState
-> both sides agree
-> no conflict

submittedState != originalState
currentServerState != originalState
submittedState != currentServerState
-> true conflict
```

This is why all three states are required. Comparing only `submittedState` and `currentServerState` cannot distinguish a server-only update from a true collision.

## Recursive object behavior

Nested objects are resolved by path, not treated as opaque top-level values.

```ts
const originalState = {
  shippingAddress: {
    city: "Cairo",
    street: "Tahrir",
  },
}

const submittedState = {
  shippingAddress: {
    city: "Giza",
    street: "Tahrir",
  },
}

const currentServerState = {
  shippingAddress: {
    city: "Cairo",
    street: "Corniche",
  },
}
```

These changes do not conflict:

```text
["shippingAddress", "city"]   -> submitted-only
["shippingAddress", "street"] -> server-only
```

CAM should safely merge both.

CAM only recurses into an object when it exists on all three sides. If both sides add the same key with **different** objects (for example `{}` → `{ addr: { city } }` vs `{ addr: { street } }`), there is no original object to merge against, so CAM reports one conflict at `["addr"]` rather than merging field by field. The same applies when the original value was a scalar, `null`, or an array.

## Arrays in v1

Arrays are **atomic values in v1**.

CAM does not attempt identity-aware item merging or reorder reconciliation.

Rules:

- one side changes the array and the other does not -> keep the changed array
- both sides produce the same changed array -> safe
- both sides change the same array differently -> conflict at the array path

Example conflict path:

```ts
["items"]
```

Identity-aware arrays can be added later behind explicit configuration without changing the conservative v1 behavior.

## Deletion and null

For object properties:

- key present with `null` -> explicit `null`
- key absent -> deletion

These are not equivalent.

`undefined` is outside the v1 data model and should be rejected rather than silently converted into deletion.

## Deterministic output

Merged objects always have their keys **sorted**, including objects nested inside arrays. Input key order is not preserved. Conflicts are listed in the same sorted path order. The same inputs always produce the same serialized output.

## Example integration

```ts
try {
  await updateOrder(submittedState)
} catch (rawError) {
  const error: ErrorSignal = rawError.code ?? rawError.status
    ? {
        code: rawError.code ?? rawError.status,
        text: rawError.message,
      }
    : {
        text: rawError.message ?? "Unknown backend error",
      }

  const match = matchConflictError({
    error,
    expectedError: { code: 409 },
    errorOutput: {
      text: "Unable to update this order",
    },
  })

  if (!match.matched) {
    showError(match.error)
    return
  }

  const currentServerState = await fetchOrder(submittedState.id)

  const result = mergeStates({
    originalState,
    submittedState,
    currentServerState,
  })

  if (result.ok) {
    await updateOrder(result.value)
    return
  }

  showConflictUI(result.conflicts)
}
```

The caller owns backend error normalization, fetching, retrying, and UI. CAM owns exact error matching and deterministic merge semantics.

## Programmer errors vs domain results

CAM distinguishes invalid usage from real application conflicts.

Throw for programmer/configuration errors such as:

- empty `ErrorSignal`
- unsupported state value types
- cyclic input
- `undefined` inside the state tree
- invalid options

Return `{ ok: false, kind: "conflict" }` only for valid inputs where both sides genuinely changed the same path differently.

This keeps normal domain control flow separate from API misuse.

## Drop-in ergonomics

The implemented core is framework-free and currently exposes only the matcher and merge primitives.

Future adapters may include:

```ts
resolveConflict(...)
resolveOrThrow(...)
asResponse(...)
```

These are roadmap items, not current exports. They must remain thin adapters over the same matcher/merge semantics.

CAM should work cleanly around:

- plain `fetch()`
- TanStack Query
- SWR
- Redux Toolkit Query
- Axios
- React, Vue, Angular, Svelte
- Node.js
- Web Workers

with no runtime dependency on any of them.

## Separation of concerns

### Application owns

- making the backend/API call
- normalizing the backend error into `ErrorSignal`
- declaring the expected conflict error
- choosing backend pass-through or custom unmatched-error text
- fetching `currentServerState` after the conflict match succeeds
- retry/resubmit behavior
- UI and user decisions

### CAM owns

- validating public inputs
- exact error matching
- unmatched-error output policy
- recursive object comparison
- path tracking
- three-way merge semantics
- atomic-array behavior
- safe auto-merge
- true-conflict detection
- deterministic serializable output

## Design goals

- framework-independent
- backend-agnostic
- UI-agnostic
- network-free core
- JSON-compatible v1 data model
- explicit conflict matching
- unambiguous path representation
- conservative array semantics
- no unresolved partial value exposed as safe data
- deterministic output
- no mutation of caller inputs
- zero or minimal runtime dependencies
- exhaustive tests around semantics

## Non-goals

CAM is not:

- a CRDT
- a collaborative editor
- a realtime sync service
- a Git merge engine
- an HTTP client
- a UI component library
- a replacement for backend optimistic concurrency control

## Test coverage

The current suite covers the implemented v1 core, including:

- error-signal validation and exact matching
- custom unmatched-error text
- strict code-type matching and finite numeric codes
- inherited error fields/getters being ignored
- scalar merge truth-table behavior
- recursive object merging
- additions, deletions, and `null`
- deletion-vs-change conflicts through `ConflictValue`
- atomic arrays and identical-array changes
- root-level and nested conflicts
- deterministic key/path ordering
- `-0` vs `0` equality
- dotted/bracketed object keys
- `__proto__` safety
- unsupported values, sparse arrays, cycles, and depth-limit rejection
- generic `MergeResult<T>` typing and the absence of `value` on conflict results
- an integration flow that combines error matching with merging

Still planned before a stable v1 release:

1. property-based tests
2. fuzz tests over JSON trees
3. representative benchmarks
4. release/package compatibility validation

Any bug fix should include a regression test.

## Implementation direction

The TypeScript reference implementation is now the source of truth for v1 semantics.

A Rust -> WebAssembly engine remains an experiment, not a requirement. Only promote it if end-to-end benchmarks show a material win after initialization and JS/WASM serialization costs.

## Current roadmap

Completed on `main`:

1. JSON value types and runtime validation
2. `ErrorSignal` validation and normalization
3. `matchConflictError()`
4. scalar three-way truth table
5. recursive object traversal
6. path-array generation
7. deletion and `null` semantics
8. atomic arrays
9. deterministic ordering and cloned output
10. regression, integration, and type-contract coverage
11. reproducible CI with lockfile installs

Next:

1. decide public package/release shape and versioning
2. add an optional convenience `resolveConflict()` only if it improves integration ergonomics
3. add thin adapters such as `resolveOrThrow()` / `asResponse()` if justified by real consumers
4. add property-based and fuzz testing
5. benchmark realistic payloads and conflict shapes
6. prototype Rust/WASM only if benchmarks justify the extra boundary and serialization cost

## Development

The repository currently targets Node 24 in CI.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` builds `dist/`, typechecks the test fixtures, and runs the Node test suite.

## Why CAM?

The goal is intentionally narrow:

> This record changed while you were editing it. Is this the conflict we expected, which changes can be merged safely, and which exact paths need human resolution?
