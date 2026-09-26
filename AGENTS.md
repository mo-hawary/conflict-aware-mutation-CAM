# AGENTS.md

## Mission

Build CAM as a small, headless, framework-independent conflict-aware mutation library for ordinary CRUD/admin applications.

The core problem is not HTTP transport or UI. The core problem is deterministic recovery after a stale mutation by combining:

- `base`: entity when editing started
- `submitted`: entity the user attempted to save
- `latest`: newest entity fetched after the failure
- `error`: actual backend error normalized by the caller
- `expectedError`: exact conflict matcher declared by the caller
- optional `errorOutput`: unmatched-error output policy

CAM must only attempt a three-way merge when `error` matches `expectedError`.

## Non-negotiable v1 contract

Target API:

```ts
/** At least one of `code` or `text` is required. Prefer `code`. */
type ErrorSignal =
  | { code: string | number; text?: string }
  | { code?: never; text: string }

type BackendError = ErrorSignal
type ExpectedConflictError = ErrorSignal

type ErrorOutput =
  | "backend"
  | { text: string }

resolveConflict<T>({
  base,
  submitted,
  latest,
  error,
  expectedError,
  errorOutput,
}): Resolution<T>
```

### Error signal invariant

- `error` is required.
- `error` must contain at least `code` or `text`.
- `expectedError` is required.
- `expectedError` must contain at least `code` or exact `text`.
- `{}` and `{ code: undefined, text: undefined }` are invalid public inputs.
- Prefer `code` because it is stable and machine-readable.
- `text` is exact-match only in v1.
- If both expected `code` and `text` are provided, both must match.
- If the error does not match, do not perform merge work.

### Returned unmatched-error policy

`errorOutput` is optional and defaults to `"backend"`.

```ts
errorOutput: "backend"
```

returns the normalized backend error unchanged.

```ts
errorOutput: { text: "Unable to update this order" }
```

preserves any backend `code` and overrides only the returned `text`.

Example:

```ts
error = {
  code: 500,
  text: "Internal database exception",
}

errorOutput = {
  text: "Unable to update this order",
}

// returned error
{
  code: 500,
  text: "Unable to update this order",
}
```

This policy applies only to `kind: "error"`. It must not rewrite true field conflicts.

Expected non-match result:

```ts
{
  ok: false,
  kind: "error",
  error: BackendError,
  conflicts: [],
}
```

## Result model

Success:

```ts
{
  ok: true,
  value: T,
  conflicts: [],
}
```

True conflict:

```ts
{
  ok: false,
  kind: "conflict",
  conflicts: Conflict[],
  value?: T,
}
```

`ok` is intentionally familiar to Fetch users, but CAM core is not an HTTP `Response` and must not depend on Fetch.

## Three-way merge semantics

For each path:

```text
submitted == base && latest != base
=> remote-only change
=> keep latest

submitted != base && latest == base
=> local-only change
=> keep submitted

submitted == latest
=> both agree
=> no conflict

submitted != base && latest != base && submitted != latest
=> true conflict
```

## Recursive behavior

Do not treat nested objects as opaque top-level values.

Example:

```text
submitted changes shippingAddress.city
latest changes shippingAddress.street
```

This is not a conflict. CAM should recurse and safely merge both paths.

Conflict paths should be precise and deterministic, e.g.:

```text
shippingAddress.city
customer.phone
items[3].quantity
```

## Core design constraints

The core must remain:

- headless
- framework-independent
- backend-agnostic
- UI-agnostic
- network-free
- deterministic
- JSON-friendly
- zero or minimal runtime dependencies

Do not add React, Vue, Angular, TanStack Query, Axios, Fetch, or DOM dependencies to core.

Adapters may be added separately later.

## Planned adapters

Keep these outside core semantics:

- `resolveOrThrow()`
- `asResponse()`

`resolveOrThrow()` may support mutation libraries that expect return-or-throw behavior.

`asResponse()` may provide familiar `ok`, `status`, and `json()` ergonomics without changing core results.

## Important v1 edge cases

Before calling v1 stable, define and test:

- nested objects
- missing property vs deletion
- `undefined`
- `null`
- arrays
- reordered arrays
- primitive type changes
- same change on both sides
- additions on both sides
- deletions on one or both sides
- deep recursion limits
- prototype-pollution-safe path handling
- deterministic conflict ordering
- custom equality hooks, if supported

Do not silently invent array semantics. If identity-aware arrays are not ready, prefer explicit conservative behavior.

## Testing expectations

Conflict resolution code should be tested more heavily than typical utility code.

Minimum target:

1. exhaustive unit cases for merge truth table
2. nested-path tests
3. deletion/null/missing-value tests
4. error-signal type/runtime validation tests
5. error-matcher tests
6. unmatched-error pass-through tests
7. custom returned-error-text tests
8. property-based tests
9. fuzz tests for JSON-compatible trees
10. deterministic-output tests
11. benchmarks for representative payload sizes

Any bug fix should include a regression test.

## Performance

Correctness first.

Start in TypeScript.

A Rust -> WebAssembly engine is an experiment, not an architectural requirement. Do not make WASM the default unless end-to-end benchmarks show material wins after initialization and JS/WASM serialization costs.

Benchmark at least:

- 1-5 KB
- 25-100 KB
- 500 KB+
- shallow and deeply nested data
- few and many conflicts

## Scope control

CAM is not:

- a CRDT
- a realtime sync engine
- a collaborative editor
- a Git merge tool
- an HTTP client
- a UI component library
- a replacement for backend optimistic concurrency control

Avoid expanding scope unless it directly improves the small conflict-aware mutation primitive.

## Implementation order

Recommended order:

1. `ErrorSignal`, result, and public contract
2. exact error matcher
3. unmatched-error output policy (`backend` or custom text)
4. scalar three-way merge
5. recursive object traversal
6. precise conflict path generation
7. deletion/null/missing semantics
8. arrays
9. adapters
10. benchmarks
11. optional WASM prototype

## Repository discipline

- Keep public API small.
- Prefer pure functions.
- Avoid hidden global state.
- Avoid mutation of caller inputs.
- Keep output serializable.
- Preserve backend `code` when custom error text is requested.
- Do not let custom error text alter merge-conflict results.
- Document every semantic choice that could surprise consumers.
- Do not copy implementation code from competing libraries; implement from the CAM contract and tests.
