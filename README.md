# Conflict-Aware Mutation

**Keep independent edits. Surface real conflicts.**

[![npm version](https://img.shields.io/npm/v/conflict-aware-mutation)](https://www.npmjs.com/package/conflict-aware-mutation)
[![CI](https://github.com/mo-hawary/conflict-aware-mutation-CAM/actions/workflows/ci.yml/badge.svg)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/LICENSE)
[![ESM](https://img.shields.io/badge/module-ESM-blue)](https://www.npmjs.com/package/conflict-aware-mutation)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/src/types.ts)

A user edits an order. Someone else updates its shipping address. The first save is rejected as stale. **CAM helps preserve both changes** with a deterministic three-way merge of JSON snapshots.

Small, headless, and zero runtime dependencies. Use it in forms, admin panels, CMS editors, and other applications whose backend already enforces optimistic concurrency.

[API reference](https://mo-hawary.github.io/conflict-aware-mutation-CAM/) · [Examples](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/README.md) · [Changelog](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CHANGELOG.md) · [Contributing](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CONTRIBUTING.md)

## Install

```bash
npm install conflict-aware-mutation
```

ESM with TypeScript declarations. Node.js 22 and 24 are tested in CI; browser, Deno, and Bun smoke tests verify the framework-independent core. No CommonJS entry point is provided.

> The GitHub `main` README describes the current source. The npm README describes its published version. Upgrading from 0.1.x? Read the [migration guide](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/docs/migration.md).

## Two edits. One safe structural merge.

Save this as `example.mjs` and run `node example.mjs` after installing:

```js
import { mergeStates } from "conflict-aware-mutation"

const result = mergeStates({
  originalState:     { name: "Ada",          status: "draft" },
  submittedState:    { name: "Ada Lovelace", status: "draft" },
  currentServerState: { name: "Ada",         status: "approved" },
})

console.log(result)
// {
//   ok: true,
//   value: { name: "Ada Lovelace", status: "approved" },
//   conflicts: []
// }
```

The user changed `name`; the server changed `status`. CAM keeps both. If they change the same field differently, CAM returns the exact path and both choices:

```js
import { mergeStates } from "conflict-aware-mutation"

const result = mergeStates({
  originalState: { customer: { phone: "111" } },
  submittedState: { customer: { phone: "333" } },
  currentServerState: { customer: { phone: "222" } },
})

console.log(result)
// {
//   ok: false,
//   kind: "conflict",
//   conflicts: [{
//     path: ["customer", "phone"],
//     submitted: { exists: true, value: "333" },
//     currentServer: { exists: true, value: "222" }
//   }]
// }
```

**An unresolved result has no partial `value` to accidentally save.** Your application can present those choices and apply the user's decision.

## Where CAM fits

| Step | Responsibility |
| --- | --- |
| Capture the record and its version when editing starts | Your application |
| Reject a stale write using a version or `If-Match` precondition | Your backend |
| Recognize the expected conflict error | CAM: `matchConflictError()` |
| Fetch the latest record and its version | Your application |
| Merge independent changes or report conflicting paths | CAM: `mergeStates()` |
| Validate the combined result, resolve conflicts, and save with the latest version | Your application and backend |

CAM performs no network requests, automatic retries, or UI rendering. A second writer can race your retry, so **every write must retain the backend concurrency precondition**.

Keep the original snapshot and its version together throughout editing. A background refetch must not attach a new version to an old draft. See the tested [REST and React examples](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/README.md) for the complete lifecycle.

## The three states

| Input | Meaning |
| --- | --- |
| `originalState` | Server state captured when editing began |
| `submittedState` | Complete state the user attempted to save |
| `currentServerState` | Latest server state fetched after the stale-write rejection |

Pass complete snapshots, not PATCH payloads: a missing property means deletion.

For each path, one-sided changes are kept, identical changes agree, and different changes on both sides conflict. Objects recurse only when a plain object exists on all three sides. If both sides add the same previously absent key with different objects, the conflict stays at that key.

## Supported data and merge granularity

**Complex nested JSON is supported. Specialized JavaScript collections are not.**

| Data | Behavior |
| --- | --- |
| Strings, finite numbers, booleans, `null` | Atomic values |
| Nested plain objects; records keyed by IDs | Recursive field-level merging |
| Arrays, including arrays of objects | Accepted but atomic: different edits conflict at the array path |
| Missing object property | Deletion; distinct from explicit `null` |
| Null-prototype objects | Accepted; outputs use `Object.prototype` |
| Shared non-cyclic references | Copied independently; outputs do not alias inputs |
| `Date`, `Map`, `Set`, class instances, `BigInt`, functions, `undefined`, non-finite numbers | Rejected with `CAMConfigError` |
| Symbols, symbol keys, cycles, nesting beyond 512 levels | Rejected with `CAMConfigError` |
| Enumerable object accessors; array-index accessors | Rejected without invoking getters |
| Array subclasses, holes, non-enumerable indices, extra enumerable non-index array properties | Rejected with `CAMConfigError` |
| Non-enumerable object properties and extra non-enumerable array properties | Ignored |

An `id` inside an array does not enable element-level merging. ID-keyed **objects** use ordinary object-key recursion. See [nested object and array examples](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/docs/data-model.md) for the distinction.

CAM validates into private snapshots and merges those snapshots. Results are deterministic, inputs remain unchanged, and `-0` becomes `0`. Conflict paths are lexicographically ordered; JavaScript's integer-key enumeration rules still apply to output objects.

## API

Three runtime exports: `mergeStates`, `matchConflictError`, and `CAMConfigError`. Public TypeScript types are exported alongside them.

### `mergeStates({ originalState, submittedState, currentServerState })`

| Result | Meaning |
| --- | --- |
| `{ ok: true, value, conflicts: [] }` | Structurally merged value |
| `{ ok: false, kind: "conflict", conflicts }` | Decisions required; no `value` |

Each conflict has a `path` array and two sides, `submitted` and `currentServer`. A side is `{ exists: true, value }` or `{ exists: false }` for deletion. A key containing dots remains a single path segment; a root-level conflict has path `[]`.

### `matchConflictError({ error, expectedError, errorOutput? })`

```js
import { matchConflictError } from "conflict-aware-mutation"

const result = matchConflictError({
  error: { code: "STALE_WRITE", text: "Order changed" },
  expectedError: { code: "STALE_WRITE" },
})
console.log(result) // { matched: true }
```

Normalize backend errors into own `code` and/or `text` properties first. Each signal needs at least one field. Codes compare strictly (`409` differs from `"409"`); text matches exactly. If both expected fields are supplied, both must match. Numeric codes must be finite.

An unmatched result is `{ matched: false, error }`. By default, `error` contains the validated backend fields. Set `errorOutput: { text: "Unable to save" }` to replace the text while retaining any backend code. Arbitrary network exceptions are not valid signals: handle or rethrow them before calling CAM.

### `CAMConfigError`

Invalid supported-API inputs throw `CAMConfigError`, an `Error` with `code: "CAM_CONFIG_ERROR"`. Ordinary concurrent edits return a conflict result instead. Catch the exported class explicitly; it does not extend `TypeError`.

### TypeScript and domain validation

Use JSON-compatible `type` aliases for state shapes. Interfaces lack the implicit index signature required by `JsonValue`.

`mergeStates<T>()` returns a value typed as `T`, but does not validate your business rules or schema. Combining individually valid edits can violate cross-field constraints or discriminated unions. Validate the combined result before saving, and keep server-side validation authoritative.

## Examples and playground

- [Fetch + REST](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/fetch-rest.mjs): executable ETag conflict, merge, retry, and manual resolution.
- [React + TanStack Query](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/react/tanstack-query-react.tsx): editing baseline, conflict picker, bounded retry, and preservation of edits during saves.
- [Browser playground](https://github.com/mo-hawary/conflict-aware-mutation-CAM/tree/main/examples/playground): edit all three snapshots and inspect the result. [Run locally](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/playground/README.md).

Examples are application code, not extra runtime exports. Their dependencies do not enter the core package.

## Scope and quality

CAM targets stale CRUD writes: customer profiles, inventory metadata, settings, and content records. It is not a CRDT, collaborative text editor, mutation-testing tool, or replacement for backend concurrency checks.

CI exercises the merge truth table, deletion and array semantics, property-based comparison against a reference implementation, input immutability, depth boundaries, and large conflict sets. It also checks the installed package, types, coverage, bundle budget, and integration examples. Benchmarks are report-only; runtime smoke tests are not a claim of exhaustive production coverage.

## Contribute

Start with the [contribution guide](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CONTRIBUTING.md), [roadmap](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/29), or [good first issues](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22). Small reproductions with all three states are especially helpful.

[Security policy](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/SECURITY.md) · [Code of conduct](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CODE_OF_CONDUCT.md) · [Release process](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/RELEASING.md)

Created by [Mo Hawary](https://mohawary.com). Released under the [MIT license](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/LICENSE).
