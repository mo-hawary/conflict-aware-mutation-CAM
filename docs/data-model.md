# Data model and merge examples

CAM compares three complete JSON snapshots. Objects recurse only when a plain object exists at the same path on all three sides. Arrays are atomic values. For an application-level dependency between multiple fields, use an explicit path group; CAM does not infer domain relationships.
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

### Coupled paths and reports

When fields must be selected together, configure a group with path-segment arrays. A conflict then contains all group slots and one submitted/current-server choice applies to the entire group. Paths must be non-root and non-overlapping; that is checked from the configuration alone, never from the state data. Missing object ancestors are supported. When a group member's ancestor is an array, a scalar, or `null` on any side, the member is treated as absent on that side and the ancestor merges atomically, so a server that replaces `address` with `null` produces a conflict at `address`, not an error. An ancestor object that one side deleted while the other side edited it is also a conflict at the ancestor path; CAM never splits it into a partial object neither side had. Independent fields outside a group still merge normally.

`includeReport: true` adds opt-in provenance for changed paths and groups. Unresolved report entries omit `result`, and the conflict result still has no partial value. `formatConflictPath()` formats path segments as RFC 6901 JSON Pointer for display; it escapes `/` and `~` so keys with punctuation remain unambiguous.

Own enumerable object properties set to `undefined` are rejected by default. A parser that uses this representation for omitted captions can opt into `undefinedObjectProperties: "omit"` on `mergeStates()`, `applyConflictDecisions()`, or `resolveConflict()`. The option treats those object properties as absent while continuing to reject `undefined` at the root, in array slots, and in other unsupported positions.

Identity-aware ID-array merging remains experimental and is not exported. The Phase 7 evaluation is recorded in [`array-by-id-evaluation.md`](../bench/array-by-id-evaluation.md); arrays stay atomic in the supported API.


## Determinism and validation

Conflict paths use lexicographic key order. Output objects are constructed deterministically; JavaScript still enumerates integer-index keys before other string keys. Do not use JSON property order as application data.

CAM snapshots validated data before merging. Inputs and results share no object references. Shared, non-cyclic input references become independent copies; `-0` becomes `0`. Object outputs use `Object.prototype`, including when inputs have null prototypes. Keys such as `constructor`, `toString`, and `__proto__` are preserved as ordinary own data properties without changing the output prototype, including when `Object.prototype` is frozen.

Only own enumerable object properties are data. Non-enumerable object properties and non-enumerable extra array properties are ignored. Array indices must be own, enumerable data properties: holes, non-enumerable indices, and index accessors are rejected. Enumerable object accessors are rejected without invoking them. Symbol-keyed properties are rejected. Proxy traps may execute during inspection; the guarantee is that merging uses the validated private snapshot, not that each trap runs once.

The root has depth 0; each object property or array index adds one depth level, and values deeper than 512 are rejected. Values at depth 512, including empty containers and scalars, are valid. This depth bound is not a payload-size or CPU budget; applications accepting untrusted input should enforce their own request limits.

See the [supported-data table](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/README.md#supported-data-and-merge-granularity) and [migration guide](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/docs/migration.md).
