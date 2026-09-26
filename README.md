# CAM

**Conflict-Aware Mutation** is a small, headless three-way conflict resolver for CRUD mutations.

It is designed for the common case where a user edits a record, another actor changes that record before the first user saves, and the backend rejects the stale write.

> Status: early design / pre-alpha. This README defines the intended v1 contract before implementation begins.

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
- non-finite numbers such as `NaN` and `Infinity`

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

A convenience `resolveConflict()` may compose error matching and merging for callers that already have all inputs, but the split primitives remain the underlying contract.

## Merge result

```ts
type PathSegment = string | number

type Conflict = {
  path: PathSegment[]
  submitted: JsonValue
  currentServer: JsonValue
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

The core remains framework-free.

Planned small adapters may include:

```ts
resolveConflict(...)
resolveOrThrow(...)
asResponse(...)
```

`resolveOrThrow()` can support mutation libraries that expect return-or-throw behavior.

`asResponse()` can provide Response-like `ok`, `status`, and `json()` ergonomics without putting HTTP semantics into the merge engine itself.

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

## Testing expectations

Before v1 release, cover at least:

1. error-signal validation
2. exact error matching
3. custom unmatched-error text
4. scalar merge truth table
5. recursive objects
6. missing property vs deletion
7. `null`
8. atomic arrays
9. same change on both sides
10. additions on both sides
11. deletions on one or both sides
12. deterministic path ordering
13. object keys containing dots/brackets
14. unsupported input rejection
15. cyclic-input rejection
16. property-based tests
17. fuzz tests for JSON trees
18. representative benchmarks

Any bug fix should include a regression test.

## Implementation direction

Start with a TypeScript reference implementation.

A Rust -> WebAssembly engine is an experiment, not a requirement. Only promote it if end-to-end benchmarks show a material win after initialization and JS/WASM serialization costs.

## Recommended implementation order

1. JSON value types and runtime validation
2. `ErrorSignal` validation
3. `matchConflictError()`
4. scalar merge truth table
5. recursive object traversal
6. path-array generation
7. deletion and `null` semantics
8. atomic arrays
9. deterministic ordering
10. convenience `resolveConflict()`
11. adapters
12. property/fuzz tests
13. benchmarks
14. optional WASM prototype

## Why CAM?

The goal is intentionally narrow:

> This record changed while you were editing it. Is this the conflict we expected, which changes can be merged safely, and which exact paths need human resolution?
