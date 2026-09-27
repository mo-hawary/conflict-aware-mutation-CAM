# Conflict-Aware Mutation (CAM)

CAM helps a client recover when a backend rejects a stale write. It checks whether the error is the conflict you expect, then compares the user's edit with the latest server state. Independent changes merge automatically; competing changes return the paths that need a decision.

CAM is a small, headless TypeScript library with no runtime dependencies. It does not make requests, retry writes, or render a conflict UI.

## Install

```bash
npm install conflict-aware-mutation
```

CAM supports Node.js 22 and 24, ships as ESM, and includes TypeScript declarations.

## Quick start

Save this as `example.mjs` and run `node example.mjs`. The small in-memory API simulates another editor changing `status` while you change `name`.

```js
import { matchConflictError, mergeStates } from "conflict-aware-mutation"

// The record and version when editing began.
const originalState = { name: "Ada", status: "draft" }
const originalVersion = 1

// The user's attempted edit. Another editor has since changed the server record.
const submittedState = { name: "Ada Lovelace", status: "draft" }
let server = { state: { name: "Ada", status: "approved" }, version: 2 }

async function save(state, version) {
  if (version !== server.version) {
    throw { code: 409, text: "Record has changed" }
  }
  server = { state, version: version + 1 }
}

async function fetchCurrent() {
  return server
}

try {
  await save(submittedState, originalVersion)
} catch (error) {
  const match = matchConflictError({
    error,
    expectedError: { code: 409 },
  })

  if (!match.matched) {
    console.error(match.error)
    process.exitCode = 1
  } else {
    // Fetch only after confirming this is the expected stale-write error.
    const { state: currentServerState, version } = await fetchCurrent()
    const result = mergeStates({ originalState, submittedState, currentServerState })

    if (result.ok) {
      await save(result.value, version)
      console.log(server.state) // { name: 'Ada Lovelace', status: 'approved' }
    } else {
      console.log(result.conflicts) // Show these paths for human resolution.
    }
  }
}
```

With a real backend, capture `originalState` when editing begins and create `submittedState` from the attempted save. Normalize the backend error to an object with its own `code` or `text` property before calling `matchConflictError()`. Fetch the latest record and its version or ETag only after a match. A retry must use that version or ETag as a backend concurrency precondition; another write can happen between the fetch and retry.

## The three states

| Input | Meaning |
| --- | --- |
| `originalState` | Server state when editing began. |
| `submittedState` | State the user tried to save. |
| `currentServerState` | Latest server state fetched after the stale-write rejection. |

For each path, CAM keeps the side that changed. If both sides made the same change, it keeps that value. If they made different changes, it reports a conflict. Nested plain objects can merge at different paths; arrays are atomic, so two different array edits conflict at the array path.

## API

The runtime exports are `matchConflictError()`, `mergeStates()`, and `CAMConfigError`. TypeScript types are also exported.

### `matchConflictError()`

```ts
matchConflictError({
  error: { code: 409, text: "Record has changed" },
  expectedError: { code: 409 },
  errorOutput: "backend", // optional; this is the default
})
// { matched: true }
```

An unmatched error returns `{ matched: false, error }`. The returned error is a validated snapshot of the backend `code` and `text` by default. Set `errorOutput: { text: "Unable to save" }` to replace its text while retaining its code.

At least one of `code` or `text` is required in both `error` and `expectedError`. Codes use strict equality (`409` differs from `"409"`); text uses exact equality. If `expectedError` specifies both, both must match. CAM reads only own `code` and `text` properties, so normalize framework or class errors first.

### `mergeStates()`

```ts
const result = mergeStates({
  originalState: { phone: "111" },
  submittedState: {},              // User deleted phone.
  currentServerState: { phone: "222" },
})

// result:
// {
//   ok: false,
//   kind: "conflict",
//   conflicts: [{
//     path: ["phone"],
//     submitted: { exists: false },
//     currentServer: { exists: true, value: "222" },
//   }],
// }
```

On success, the result is `{ ok: true, value, conflicts: [] }`. On a conflict, it is `{ ok: false, kind: "conflict", conflicts }` and has no partial `value` to save. Conflict paths are arrays of segments, such as `["shippingAddress", "city"]`; a key containing a dot stays one segment. `exists: false` means the property was deleted, which differs from `{ exists: true, value: null }`.

CAM accepts JSON-compatible primitives, arrays, and plain objects. It rejects `undefined`, non-finite numbers, `Date`, class instances, symbols, cycles, and nesting beyond 512 levels with `CAMConfigError`. Invalid input is a programmer error; an ordinary concurrent edit returns a conflict result. CAM does not mutate its inputs. Merged object keys and conflict paths have deterministic sorted order.

## Integration responsibilities

Your application owns the backend call, error normalization, fetching the latest state, retrying with a concurrency precondition, and presenting unresolved conflicts. CAM owns error matching and the three-way merge. The backend must still enforce optimistic concurrency on every write.

## Development and community

```bash
npm ci
npm run typecheck
npm test
npm run pack:check
```

See [Contributing](./CONTRIBUTING.md) for PR guidance, [Security](./SECURITY.md) for private vulnerability reports, [Code of Conduct](./CODE_OF_CONDUCT.md), [Changelog](./CHANGELOG.md), and [Releasing](./RELEASING.md) for the release process.

MIT licensed. See [LICENSE](./LICENSE).
