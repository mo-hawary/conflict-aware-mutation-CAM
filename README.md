# Conflict-Aware Mutation

**Keep independent edits. Surface real conflicts.**

[![npm version](https://img.shields.io/npm/v/conflict-aware-mutation)](https://www.npmjs.com/package/conflict-aware-mutation)
[![CI](https://github.com/mo-hawary/conflict-aware-mutation-CAM/actions/workflows/ci.yml/badge.svg)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/LICENSE)
[![ESM](https://img.shields.io/badge/module-ESM-blue)](https://www.npmjs.com/package/conflict-aware-mutation)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/src/types.ts)

A user edits an order. Someone else updates its shipping address. The first save is rejected as stale. **CAM helps preserve both changes** with a deterministic three-way merge of JSON snapshots.

Small, headless, and zero runtime dependencies. Use it in forms, admin panels, CMS editors, and other applications whose backend already enforces optimistic concurrency.

- **Field-level merging** of nested JSON, with precise, existence-aware conflicts and never a partial result to save by accident.
- **Array merging when you want it**: by ID, as sets or multisets, or with diff3 for ordered lists. Arrays stay atomic unless configured.
- **Linked fields and derived values**: fields that must change together are one decision; computed values are never merged stale.
- **Rules you define**: limits and cross-field checks CAM enforces on every merge, with clear blame when an input breaks one.
- **Review when it matters**: optionally route any result that combines both people's changes to a person before it is saved.

[API reference](https://mo-hawary.github.io/conflict-aware-mutation-CAM/) · [Examples](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/README.md) · [Changelog](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CHANGELOG.md) · [Contributing](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CONTRIBUTING.md)

## Install

```bash
npm install conflict-aware-mutation
```

ESM with TypeScript declarations. Node.js 22 and 24 are tested in CI; browser, Deno, and Bun smoke tests verify the framework-independent core. CommonJS code can load both entry points with `require()` on Node.js 22.12 or later, which supports `require()` of ES modules; `import` and `require()` share one module instance.

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
| Check declared rules and flag results that need review | CAM: `rules`, `autoMerge` (optional) |
| Validate and review the combined result, resolve conflicts, and save with the latest version | Your application and backend |

The root merge functions perform no network requests or UI rendering. An optional `conflict-aware-mutation/recovery` adapter coordinates caller-supplied callbacks; review is the default, and one automatic recovery retry requires explicit opt-in. A second writer can race confirmation, so **every write must retain the backend concurrency precondition**.

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
| Arrays, including arrays of objects | Atomic by default. Opt in per path to [keyed, sequence (diff3), set, or multiset merging](#array-merging) |
| Missing object property | Deletion; distinct from explicit `null` |
| Null-prototype objects | Accepted; outputs use `Object.prototype` |
| Shared non-cyclic references | Copied independently; outputs do not alias inputs |
| `Date`, `Map`, `Set`, class instances, `BigInt`, functions, non-finite numbers | Rejected with `CAMConfigError` |
| `undefined` | Rejected by default; own enumerable object properties may be treated as absent with `undefinedObjectProperties: "omit"` |
| Symbols, symbol keys, cycles, nesting beyond 512 levels | Rejected with `CAMConfigError` |
| Enumerable object accessors; array-index accessors | Rejected without invoking getters |
| Array subclasses, holes, non-enumerable indices, extra enumerable non-index array properties | Rejected with `CAMConfigError` |
| Non-enumerable object properties and extra non-enumerable array properties | Ignored |

Depth starts at the root value (0). Each object property or array index adds one level; values at depth 512 are valid, and values at depth 513 are rejected. Empty containers and scalar leaves follow the same boundary.

By default an `id` inside an array does not enable element-level merging; configure an [array rule](#array-merging) for that. ID-keyed **objects** always use ordinary object-key recursion. See [nested object and array examples](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/docs/data-model.md) for the distinction.

CAM validates into private snapshots and merges those snapshots. Results are deterministic, inputs remain unchanged, and `-0` becomes `0`. Conflict paths are lexicographically ordered; JavaScript's integer-key enumeration rules still apply to output objects.

## API

The root entry exports `mergeStates`, `matchConflictError`, `resolveConflict`, `applyConflictDecisions`, `formatConflictPath`, `CAMConfigError`, and the `ANY` and `EACH` path wildcards. Public TypeScript types are exported alongside them. The recovery adapter has a separate import so the root entry remains independent of recovery code:

```js
import { createRecoveryController } from "conflict-aware-mutation/recovery"
```

### `mergeStates({ originalState, submittedState, currentServerState })`

| Result | Meaning |
| --- | --- |
| `{ ok: true, value, conflicts: [] }` | Structurally merged value |
| `{ ok: false, kind: "conflict", conflicts }` | Decisions required; no `value` |
| `{ ok: false, kind: "invalid", violations, conflicts }` | Only with `rules`: an input breaks a rule (see [rules](#user-defined-rules)) |
| `{ ok: false, kind: "review", value, report }` | Only with `autoMerge: "review-mixed"`: complete, but combines both sides' changes |

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

### `resolveConflict()` and `applyConflictDecisions()`

`resolveConflict()` composes error matching and merging when all three snapshots are already available. It matches the backend error first; an unmatched error is returned without merging. Use `matchConflictError()` separately when the application should fetch `currentServerState` only after a match.

Use `applyConflictDecisions()` after presenting current conflicts. Each choice includes the exact conflict tuple and a `sessionId`; create a new session ID when the draft or snapshots change. CAM recomputes conflicts and rejects stale, missing, duplicate, or mismatched choices. It never selects a side implicitly. Rule conflicts appear only after structural conflicts are resolved, so resolution can take more than one round: pass the decisions from every round so far, and CAM replays them round by round against conflicts recomputed from the same snapshots.

Object properties set to `undefined` remain invalid by default. The explicit `undefinedObjectProperties: "omit"` option is available to `mergeStates()`, `applyConflictDecisions()`, and `resolveConflict()` for parser output where own enumerable object properties with value `undefined` should mean absence. Root values, array entries, and other unsupported values remain strict.

### Coupled paths, reports, and path formatting

For domain values whose fields must be chosen together, pass `groups: [{ id, paths }]` to `mergeStates()`. Grouped calls return a discriminated group conflict with an existence-aware slot for every path; one manual choice selects the whole group. Grouped results have their own `GroupedMergeResult` type. Group paths are validated from the configuration alone. If a member's parent was replaced with `null`, a scalar, or an array, or was deleted on one side while edited on the other, the group couples that whole parent instead, so its slot path is the parent path (see [Coupled paths and reports](./docs/data-model.md#coupled-paths-and-reports)).

Pass `includeReport: true` to include optional change provenance on success and conflict results. Unresolved changes have no result slot, and a conflict still has no persistable partial value. `formatConflictPath()` returns an RFC 6901 JSON Pointer for display, including escaped `/` and `~` keys.

### Array merging

Arrays are atomic unless configured. Rules apply per path; `ANY` matches any key or item, and the most specific rule wins:

```js
import { ANY, mergeStates } from "conflict-aware-mutation"

const result = mergeStates({
  originalState: { items: [{ id: "a", qty: 1, price: 10 }], tags: ["new"] },
  submittedState: { items: [{ id: "a", qty: 2, price: 10 }], tags: ["new", "gift"] },
  currentServerState: { items: [{ id: "a", qty: 1, price: 12 }, { id: "b", qty: 1, price: 5 }], tags: ["sale"] },
  arrays: {
    rules: [
      { path: ["items"], mode: "keyed", key: "id" },
      { path: ["tags"], mode: "set" },
    ],
  },
})
// { ok: true, value: { items: [{ id: "a", price: 12, qty: 2 }, { id: "b", price: 5, qty: 1 }], tags: ["sale", "gift"] }, conflicts: [] }
```

| Mode | For | Behavior |
| --- | --- | --- |
| `atomic` (default) | Values that only make sense whole | Different edits on both sides conflict at the array path |
| `keyed` | Records with a stable ID (`key`) | Items matched by key and merged field by field. Additions and deletions merge; delete versus edit conflicts on the item; different orderings of the items both sides hold are one `reason: "order"` conflict. Missing or duplicate keys throw `CAMConfigError` in any state, even when only one side changed the array |
| `sequence` | Ordered lists without identity | diff3, the algorithm behind git merges: unchanged regions are kept, a region changed on one side takes that side, and only regions both sides changed differently conflict. Elements are always taken whole from one side; CAM never merges inside an element both sides changed, because without identity it cannot prove they are the same row |
| `set` | Unique values (tags, roles) | Membership merges; a member added on both sides appears once. Order is not a change: when only one side changed membership, its array is kept as written. Never conflicts |
| `multiset` | Values that may repeat | Each value's count becomes `submitted + currentServer - original`. Order is not a change. Never conflicts |

`arrays: { default: "sequence" }` applies diff3 to every array without a rule. Conflicts inside arrays use extra path segments: `{ key: "id", value: "a" }` for a keyed item and `{ from, to }` (original indices) for a sequence region. `formatConflictPath()` displays them as `/items/[id=a]/qty` and `/steps/[1..3)`. Adjacent edits in a sequence can conflict even when they do not overlap; that errs toward a conflict, never a wrong merge. Use `keyed` where items have identity.

### Linked fields and derived values

Group paths accept wildcards. `ANY` links every match into one decision; `EACH` creates one decision per matched key:

```js
groups: [
  { id: "default-item", paths: [["defaultItemId"], ["items"]] },
  { id: "line-price", paths: [["items", EACH, "price"], ["items", EACH, "currency"]] },
]
```

An `EACH` conflict carries a `binding` such as `{ key: "id", value: "a" }`. Mark computed values with `derived: [["total"], ["items", ANY, "lineTotal"]]`: they are excluded from merging and conflicts, and the result carries the latest server value (or the submitted value for new items). Recompute them before saving.

### User-defined rules

Rules state limits CAM enforces on every merge. Built-in rules are plain data: `required`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `oneOf`, `unique`, `exactlyOne`, `allEqual`, `oneOfPath`, `sumOf`, and `requiredWith`. Custom rules are pure functions:

```js
rules: [
  { id: "discount-cap", path: ["discount"], max: 0.3 },
  { id: "default-exists", path: ["defaultItemId"], oneOfPath: ["items", ANY, "id"] },
  {
    id: "approval",
    paths: [["price"], ["discount"]],
    check: (state) => state.discount <= 0.2 || state.price >= 100 || "Large discounts need price >= 100",
  },
]
```

CAM evaluates each rule on both inputs and on the merged result, and reports who broke it:

- An input that breaks a rule returns `kind: "invalid"` with `violations: [{ ruleId, side, message }]`. A pre-existing violation that neither side touched is not blamed on anyone.
- If both inputs satisfy a rule but the merge does not, the result has a `kind: "rule"` conflict on the rule's paths. Choosing a side takes that side's values (or whole items) for those paths.

Rules that target a `derived` value (or a path inside one) are checked on the inputs only, because merged derived values are recomputed later. Rules on an ancestor, such as a whole array of lines, still check the merged result.

### Review policy

`autoMerge: "review-mixed"` returns `kind: "review"` with the complete `value` and a `report` whenever a result combines changes from both sides, so a person confirms it before it is saved. Results that one side wrote, or that both sides agree on, stay `ok`. CAM cannot know business rules nobody states; rules check what is stated, and review covers the rest.

### Recovery adapter

`createRecoveryController()` lives at `conflict-aware-mutation/recovery`. It accepts the application's versioned mutation, fetch, preparation, validation, and terminal-state callbacks. A stale mutation fetches the newest state and returns a review candidate or conflicts. Configure `groups`, `arrays`, `derived`, `rules`, and `autoMerge` to use the same merge policy inside the controller; invalid policy is rejected when the controller is created rather than waiting for a stale-write path. A rule violation returns an `invalid` outcome, and with `autoMerge: "review-mixed"` a combined candidate always goes to review, even with `autoRetry: "once"`. Use `undefinedObjectProperties: "omit"` when parser-style own object properties set to `undefined` should mean absence. In TypeScript this normalized mode intentionally exposes input/output state as broad `JsonValue` because omission can remove a property that a domain type marked as required; narrow it again only after application validation. The recovery write requires an explicit one-use confirmation token and the latest version. `autoRetry: "once"` is an opt-in for one clean automatic recovery write.

If that recovery write loses another version race, `changed-again` returns both the preserved candidate and the exact `currentServerState` / `latestVersion` baseline that produced it. Use that pair as the next `originalState` / `expectedVersion` when continuing recovery; this prevents server-only changes from being reclassified as user edits. A mutation that the backend already accepted is reported as `saved` even if navigation or cancellation happens while its response is in flight—cancellation cannot undo an accepted write.

### `CAMConfigError`

Invalid supported-API inputs throw `CAMConfigError`, an `Error` with `code: "CAM_CONFIG_ERROR"`. Ordinary concurrent edits return a conflict result instead. Catch the exported class explicitly; it does not extend `TypeError`.

### TypeScript and domain validation

Use JSON-compatible `type` aliases for state shapes. Interfaces lack the implicit index signature required by `JsonValue`.

`mergeStates<T>()` returns a value typed as `T`, but does not validate your schema. Combining individually valid edits can violate cross-field constraints or discriminated unions: state those constraints as [rules](#user-defined-rules), validate the combined result before saving, and keep server-side validation authoritative. Calls that use the array, derived, rule, review, or wildcard-group options return `AdvancedMergeResult<T>`.

## Examples and playground

- [Fetch + REST](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/fetch-rest.mjs): executable ETag conflict, terminal-state guard, candidate validation, review, manual resolution, and explicit confirmation.
- [Versioned recovery controller](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/versioned-rest-recovery.mjs): explicit integer version with HTTP 409 and confirmation using the fetched version.
- [Arrays, linked fields, and rules](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/collections-and-rules.mjs): keyed lines, sets, diff3 steps, per-line price groups, derived totals, rule blame and rule conflicts, staged decisions, and `review-mixed` on one order record.
- [React + TanStack Query](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/react/tanstack-query-react.tsx): candidate review, validation, session-bound conflict choices, and confirmation before recovery writes.
- [Browser playground](https://github.com/mo-hawary/conflict-aware-mutation-CAM/tree/main/examples/playground): edit all three snapshots and inspect the result. [Run locally](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/examples/playground/README.md).

Examples are application code, not extra runtime exports. Their dependencies do not enter the core package.

## Scope and quality

CAM targets stale CRUD writes: customer profiles, inventory metadata, settings, and content records. It is not a CRDT, collaborative text editor, mutation-testing tool, or replacement for backend concurrency checks.

CI exercises the merge truth table, deletion and array semantics, property-based comparison against a reference implementation, input immutability, depth boundaries, and large conflict sets. Property tests also check the collection guarantees: sequence results only contain elements taken whole from one side, set results never contain duplicates, and `review-mixed` only auto-accepts a result one side wrote. It also checks the installed package, types, coverage, explicit root/recovery bundle budgets, and integration examples. Benchmarks are report-only; runtime smoke tests are not a claim of exhaustive production coverage.

## Contribute

Start with the [contribution guide](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CONTRIBUTING.md), [roadmap](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/29), or [good first issues](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22). Small reproductions with all three states are especially helpful.

[Security policy](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/SECURITY.md) · [Code of conduct](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/CODE_OF_CONDUCT.md) · [Release process](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/RELEASING.md)

Created by [Mo Hawary](https://mohawary.com). Released under the [MIT license](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/LICENSE).
