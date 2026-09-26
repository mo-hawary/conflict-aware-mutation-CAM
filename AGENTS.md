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

Do **not** expose `value?: T` on a conflict result in v1. An unresolved partial merge must never look persistable.

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

## Arrays in v1

Arrays are atomic values.

Do not implement identity-aware array merging in v1.

Rules:

- only submitted side changes array -> keep submitted array
- only server side changes array -> keep server array
- both change to same array -> safe
- both change differently -> conflict at the array path

Do not recurse into array indexes for merge semantics in v1.

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

Use `CAMConfigError` or `TypeError` consistently.

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

Every bug fix must include a regression test.

## Security/correctness

- Be prototype-pollution-safe when traversing or constructing objects.
- Never mutate `originalState`, `submittedState`, or `currentServerState`.
- Keep output deterministic.
- Avoid recursion patterns that can trivially exhaust the stack; define a depth strategy before stable release.

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

## Repository discipline

- Keep the public API small.
- Prefer pure functions.
- Avoid hidden global state.
- Preserve caller input immutability.
- Keep outputs serializable.
- Document every semantic choice that could surprise consumers.
- Do not copy competitor implementation code. Build from the CAM contract and tests.
