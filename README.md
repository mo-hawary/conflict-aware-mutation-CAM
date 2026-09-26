# CAM

**Conflict-Aware Mutation** is a headless three-way conflict resolver for CRUD mutations.

It is designed for the common case where a user edits a record, another actor changes the same record before the first user saves, and the backend rejects the stale write.

CAM works from five explicit inputs:

- `base`: the entity when editing started
- `submitted`: the state the user attempted to save
- `latest`: the newest state fetched from the server
- `error`: the actual backend error for the failed mutation
- `expectedError`: the exact conflict error CAM is allowed to handle

CAM first verifies that the actual backend error matches the caller-declared conflict error. Only then does it perform the three-way comparison.

> Status: early design / pre-alpha. The API below describes the intended v1 contract and may change before the first release.

## The problem

Imagine two admins editing the same order.

```text
Admin A loads order v7
Admin B loads order v7

Admin A changes shippingAddress.city
Admin B changes customer.phone

Admin B saves first -> order v8
Admin A tries to save v7 -> stale write rejected
```

The backend can detect that the write is stale, but the client still needs to answer:

- Is this failure actually the conflict case CAM is supposed to handle?
- What changed locally?
- What changed remotely?
- Can the changes be merged safely?
- Did both sides edit the same nested field differently?
- What exact conflicts should the UI show to the user?

CAM solves that detection + comparison problem without owning your API client, framework, or UI.

## Intended API

```ts
type BackendError = {
  code?: string | number
  text?: string
}

type ExpectedConflictError =
  | { code: string | number; text?: string }
  | { code?: never; text: string }

const result = resolveConflict({
  base,
  submitted,
  latest,
  error,
  expectedError,
})
```

### Error matching

`error` is required. Its `code` and `text` fields are individually optional because backend error shapes vary.

`expectedError` is also required and must contain at least one exact matcher:

```ts
{ code: 409 }
```

or:

```ts
{ code: "STALE_ORDER" }
```

or, when no stable code exists:

```ts
{ text: "Order was modified by another user" }
```

Prefer `code`. It is stable and machine-readable.

`text` is an exact-match fallback in v1. No substring, regex, or fuzzy matching.

If both `code` and `text` are provided, all supplied fields must match.

If the actual error does **not** match `expectedError`, CAM does not perform the merge.

## Result shape

CAM intentionally uses `ok` because it is familiar to JavaScript developers.

It does not pretend to be an HTTP `Response`; it simply follows the same ergonomic convention.

Successful resolution:

```ts
{
  ok: true,
  value: {
    // same domain shape as the input entity
  },
  conflicts: []
}
```

True conflict:

```ts
{
  ok: false,
  kind: "conflict",
  conflicts: [
    {
      path: "shippingAddress.city",
      local: "Giza",
      remote: "Alexandria"
    }
  ],
  value: {
    // optional safely merged non-conflicting parts
  }
}
```

Non-matching backend error:

```ts
{
  ok: false,
  kind: "error",
  error: {
    code: 500,
    text: "Internal server error"
  },
  conflicts: []
}
```

The caller already owns `base`, `submitted`, and `latest`, so CAM does not echo those full objects back.

## Three-way merge rules

For each value or nested path:

```text
submitted == base && latest != base
-> only the remote side changed
-> keep latest

submitted != base && latest == base
-> only the local side changed
-> keep submitted

submitted == latest
-> both sides agree
-> no conflict

submitted != base && latest != base && submitted != latest
-> true conflict
```

All three entity inputs are required. Comparing only `submitted` and `latest` cannot reliably distinguish a remote-only change from a true collision.

## Recursive conflict detection

CAM is intended to resolve nested structures by path instead of treating each top-level object as one opaque value.

For example:

```ts
base = {
  shippingAddress: {
    city: "Cairo",
    street: "Tahrir"
  }
}

submitted = {
  shippingAddress: {
    city: "Giza",
    street: "Tahrir"
  }
}

latest = {
  shippingAddress: {
    city: "Cairo",
    street: "Corniche"
  }
}
```

These edits do not actually conflict.

A shallow resolver may report `shippingAddress` as one conflict. CAM should instead understand:

```text
shippingAddress.city   -> changed locally only
shippingAddress.street -> changed remotely only
```

and merge both safely.

## Example integration

```ts
try {
  await updateOrder(submitted)
} catch (rawError) {
  const error = {
    code: rawError.code ?? rawError.status,
    text: rawError.message,
  }

  const latest = await fetchOrder(submitted.id)

  const result = resolveConflict({
    base,
    submitted,
    latest,
    error,
    expectedError: { code: 409 },
  })

  if (result.ok) {
    await updateOrder(result.value)
    return
  }

  if (result.kind === "error") {
    throw rawError
  }

  showConflictUI(result.conflicts)
}
```

The caller decides how to normalize its backend error into `{ code?, text? }`. CAM never guesses backend semantics.

## Drop-in ergonomics

The core stays framework-free, but tiny adapters can make CAM fit existing code styles.

Planned adapters:

```ts
resolveConflict(...)
resolveOrThrow(...)
asResponse(...)
```

`resolveOrThrow()` can return the merged value when `ok === true` and throw a typed `CAMConflictError` otherwise.

`asResponse()` can expose a Response-like adapter with familiar `ok`, `status`, and `json()` semantics without putting fake HTTP concerns into the core engine.

This keeps CAM easy to use with:

- plain `fetch()`
- TanStack Query
- SWR
- Redux Toolkit Query
- Axios
- React, Vue, Angular, Svelte
- Node.js
- Web Workers

without taking a runtime dependency on any of them.

## Separation of concerns

### Your application owns

- making the backend/API call
- capturing and normalizing the actual backend error
- declaring the exact expected conflict error for that mutation
- fetching the latest record
- retrying or resubmitting mutations
- user interface and design system
- deciding how the user resolves a reported conflict

### CAM owns

- exact conflict-error matching before merge work begins
- recursive comparison
- nested path tracking
- three-way merge semantics
- safe auto-merge
- true-conflict detection
- deterministic serializable output

## Design goals

- framework-independent
- zero UI assumptions
- backend-agnostic
- explicit error matching, never inferred conflict semantics
- familiar `ok` result convention
- recursive nested-path detection
- unresolved-by-default true conflicts
- deterministic output
- JSON-friendly data model
- strong handling of missing values, deletion, and `null`
- zero or minimal runtime dependencies
- extensive unit, property-based, and fuzz testing

## Non-goals

CAM is not intended to be:

- a CRDT implementation
- a collaborative editor
- a realtime sync service
- a Git merge engine
- a React modal
- an HTTP client
- a replacement for backend optimistic concurrency control

The backend remains responsible for detecting stale writes. CAM verifies the caller-declared conflict error and helps the application recover after that failure.

## Implementation direction

The first reference implementation should be TypeScript for portability and ecosystem fit.

A Rust implementation compiled to WebAssembly may be explored later behind the same public contract. WASM will only become a default engine if benchmarks show a meaningful end-to-end advantage after JS/WASM boundary and serialization costs are included.

Representative benchmarks should cover:

- small entities: 1 to 5 KB
- medium entities: 25 to 100 KB
- large nested entities: 500 KB+
- deeply nested objects
- arrays
- zero-conflict and high-conflict cases
- cold and warm WASM execution separately

## v1 questions

Before the first stable release, CAM needs explicit semantics for:

- arrays: atomic vs identity-aware merging
- missing property vs `undefined` vs deleted property
- `null`
- reordered lists
- custom equality for domain values
- recursion depth safeguards
- prototype-pollution-safe path handling
- deterministic conflict ordering
- how `value` behaves when `kind === "conflict"`

## Roadmap

- [ ] lock the v1 data model and semantics
- [ ] implement exact `error` / `expectedError` matching
- [ ] implement the TypeScript reference engine
- [ ] recursive object merge
- [ ] precise conflict paths
- [ ] deletion and `null` semantics
- [ ] array strategy
- [ ] `resolveOrThrow()` adapter
- [ ] `asResponse()` adapter
- [ ] exhaustive unit tests
- [ ] property-based tests
- [ ] fuzz tests
- [ ] benchmarks
- [ ] publish first npm release
- [ ] evaluate Rust + WebAssembly engine

## Why CAM?

The project is intentionally small.

The goal is not to create another frontend framework. The goal is to provide one reliable primitive for a problem that many multi-user CRUD applications eventually hit:

> This record changed while you were editing it. Is this the conflict we expected, which changes are safe, and which fields truly need human resolution?
