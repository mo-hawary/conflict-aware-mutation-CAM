# Conflict-Aware Mutation (CAM)

[![CI](https://github.com/mo-hawary/conflict-aware-mutation-CAM/actions/workflows/ci.yml/badge.svg)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/conflict-aware-mutation)](https://www.npmjs.com/package/conflict-aware-mutation)
[![bundle size](https://img.shields.io/bundlejs/size/conflict-aware-mutation)](https://bundlejs.com/?q=conflict-aware-mutation)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mo-hawary/conflict-aware-mutation-CAM/badge)](https://scorecard.dev/viewer/?uri=github.com/mo-hawary/conflict-aware-mutation-CAM)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

CAM helps a client recover when a backend rejects a stale write. It checks whether the error is the conflict you expect, then compares the user's edit with the latest server state. Independent changes merge automatically; competing changes return the paths that need a decision.

CAM is a small, headless TypeScript library with no runtime dependencies. It does not make requests, retry writes, or render a conflict UI.

## Supported data and merge granularity

CAM supports deeply nested JSON objects, including records keyed by IDs. It recursively merges independent object-field changes. Arrays are valid input but are atomic merge values: CAM does not merge array elements by index or inferred identity. Specialized JavaScript values such as `Date`, `Map`, and `Set` are unsupported.

| Data shape | Accepted? | Merge behavior |
| --- | --- | --- |
| JSON primitives (`string`, finite `number`, `boolean`, `null`) | Yes | Atomic value |
| Nested plain objects, including null-prototype objects | Yes | Recursively merges independent object-field changes; output objects use the ordinary `Object.prototype` |
| Records keyed by IDs, for example `products["p1"]` | Yes | Ordinary object-key recursion; keys act as paths |
| Arrays, including arrays of objects | Yes | Atomic at the array path; no element-by-element merge |
| Property additions and deletions | Yes | Compared per object property; absence is distinct from `null` |
| `Date`, `Map`, `Set`, class instances, `BigInt`, `undefined`, functions, symbols, non-finite numbers | No | Rejected with `CAMConfigError` |
| Sparse arrays, `Array` subclasses, arrays with extra own properties (including non-enumerable ones), and symbol-keyed properties | No | Rejected with `CAMConfigError` |
| Getter/setter (accessor) properties, including non-enumerable ones | No | Rejected with `CAMConfigError` without being invoked |
| Non-enumerable data properties on plain objects | Ignored | Only enumerable object properties are part of the JSON snapshot |
| Cyclic references | No | Rejected with `CAMConfigError` |
| Nesting deeper than 512 levels | No | Rejected with `CAMConfigError` |

**Accepted input is not the same as fine-grained merge support.** An array of complex objects is valid JSON input, but CAM treats the entire array as one value when both sides change it. By contrast, plain objects are traversed recursively.

ID-keyed records work because IDs are ordinary object keys. CAM does not inspect an `id` property inside an array and does not infer element identity. Also, when both sides add the same previously absent property with different objects, CAM reports one conflict at that property instead of recursively combining two independently created objects.

## Install

```bash
npm install conflict-aware-mutation
```

CAM supports Node.js 22 and 24, ships as ESM, and includes TypeScript declarations. CI also runs smoke tests in Deno, Bun, Chromium, Firefox, and WebKit.

Try it without installing: [open the playground on StackBlitz](https://stackblitz.com/github/mo-hawary/conflict-aware-mutation-CAM/tree/main/examples/playground).

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

## Data-shape examples

### Deeply nested objects and ID-keyed records

Independent edits inside existing nested objects merge recursively, including records whose keys are IDs:

```js
import { mergeStates } from "conflict-aware-mutation"

const result = mergeStates({
  originalState: {
    profile: {
      address: { city: "Cairo", street: "Tahrir" },
    },
    products: {
      p1: { name: "Desk", price: 100 },
      p2: { name: "Lamp", price: 40 },
    },
  },
  submittedState: {
    profile: {
      address: { city: "Giza", street: "Tahrir" },
    },
    products: {
      p1: { name: "Standing Desk", price: 100 },
      p2: { name: "Lamp", price: 40 },
    },
  },
  currentServerState: {
    profile: {
      address: { city: "Cairo", street: "Corniche" },
    },
    products: {
      p1: { name: "Desk", price: 110 },
      p2: { name: "Lamp", price: 40 },
    },
  },
})

console.log(result)
```

Expected result:

```js
{
  ok: true,
  value: {
    products: {
      p1: { name: "Standing Desk", price: 110 },
      p2: { name: "Lamp", price: 40 },
    },
    profile: {
      address: { city: "Giza", street: "Corniche" },
    },
  },
  conflicts: [],
}
```

Here `p1` and `p2` are just object keys. CAM does not require or infer a special record schema.

### Arrays of objects are atomic

Even when objects inside the array have `id` fields, CAM does not merge different array elements independently:

```js
import { mergeStates } from "conflict-aware-mutation"

const result = mergeStates({
  originalState: {
    items: [
      { id: "a", qty: 1 },
      { id: "b", qty: 1 },
    ],
  },
  submittedState: {
    items: [
      { id: "a", qty: 2 },
      { id: "b", qty: 1 },
    ],
  },
  currentServerState: {
    items: [
      { id: "a", qty: 1 },
      { id: "b", qty: 3 },
    ],
  },
})

console.log(result)
```

Expected result:

```js
{
  ok: false,
  kind: "conflict",
  conflicts: [
    {
      path: ["items"],
      submitted: {
        exists: true,
        value: [
          { id: "a", qty: 2 },
          { id: "b", qty: 1 },
        ],
      },
      currentServer: {
        exists: true,
        value: [
          { id: "a", qty: 1 },
          { id: "b", qty: 3 },
        ],
      },
    },
  ],
}
```

A one-sided array change is accepted, and identical array changes on both sides are accepted. Different changes on both sides conflict at the array path.

These merge results are structural only. Your application still owns server-side validation and must retry writes with the latest version, ETag, or equivalent optimistic-concurrency precondition.

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

CAM accepts JSON-compatible primitives, arrays, and plain objects. It rejects `undefined`, non-finite numbers, `Date`, class instances, symbols, accessors, cycles, sparse arrays, `Array` subclasses, arrays with extra own properties, and nesting beyond 512 levels with `CAMConfigError`. Invalid input is a programmer error; an ordinary concurrent edit returns a conflict result. `CAMConfigError` extends `Error` (not `TypeError`) and has `code: "CAM_CONFIG_ERROR"`.

CAM copies validated own data-property values into private snapshots before merging. The merge only sees those snapshots, so a proxy cannot change the values after validation. Proxy traps may run while CAM enumerates keys and obtains descriptors; their exact call counts are not part of the contract. CAM never mutates your inputs, and the result never shares objects with them. Merged object keys and conflict paths have deterministic sorted order, and `-0` becomes `0`.

### Migration from 0.1.x

`CAMConfigError` now extends `Error` directly instead of `TypeError`. Replace `error instanceof TypeError` checks for invalid CAM inputs with `error instanceof CAMConfigError`, or check `error.code === "CAM_CONFIG_ERROR"`. The class and code distinguish public validation failures from internal `TypeError` invariant failures.

Validation now rejects accessor properties, including hidden getters and setters, without invoking them. It also rejects `Array` subclasses, sparse arrays, and arrays with extra own properties (including non-enumerable properties). Normalize these inputs into plain JSON data before calling CAM. Hidden non-enumerable data properties on plain objects remain outside the JSON snapshot and are ignored.

### TypeScript notes

`mergeStates<T extends JsonValue>()` checks that your state type is JSON-compatible. Declare state shapes with a `type` alias rather than an `interface`; interfaces have no implicit index signature, so TypeScript rejects them as `JsonValue`.

The merged `value` is typed as `T`, but a per-field merge can combine fields that are each valid yet invalid together. For example, if the user switches `{ kind: "card", last4 }` to `{ kind: "bank", iban }` while the server adds a card-only field, the merge succeeds with a `"bank"` object that still has the card field. Validate merged values against your domain rules before saving when such invariants matter.

## Integration responsibilities

Your application owns the backend call, error normalization, fetching the latest state, retrying with a concurrency precondition, and presenting unresolved conflicts. CAM owns error matching and the three-way merge. The backend must still enforce optimistic concurrency on every write.

## Development and community

```bash
npm ci
npm run typecheck
npm test
npm run pack:check
npm run test:coverage   # suite with coverage thresholds
npm run lint:package    # publint + are-the-types-wrong
npm run size            # bundle size budget
npm run examples        # runnable end-to-end example
npm run bench           # representative mergeStates() benchmarks
npm run mutation        # Stryker mutation testing (slow)
```

Full API reference: <https://mo-hawary.github.io/conflict-aware-mutation-CAM/>. Integration examples, including fetch/REST and TanStack Query with React, are in [`examples/`](./examples/README.md). For maintainer and portfolio context, see [Mohawary.com](https://mohawary.com/open-source); library behavior and API details stay documented here and in the API reference.

See [Contributing](./CONTRIBUTING.md) for PR guidance, [Security](./SECURITY.md) for private vulnerability reports, [Code of Conduct](./CODE_OF_CONDUCT.md), [Changelog](./CHANGELOG.md), and [Releasing](./RELEASING.md) for the release process.

MIT licensed. See [LICENSE](./LICENSE).
