# Data model and merge examples

CAM compares three complete JSON snapshots. Objects recurse only when a plain object exists at the same path on all three sides. Arrays are atomic values unless an array rule opts them into keyed, sequence, set, or multiset merging. For an application-level dependency between multiple fields, use an explicit path group or a rule; CAM does not infer domain relationships.
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

### Arrays of objects are atomic by default

Without an array rule, even when objects inside the array have `id` fields, CAM does not merge different array elements independently:

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

### Merging arrays item by item

The same input with a keyed rule merges both edits:

```js
const merged = mergeStates({
  ...sameInputAsAbove,
  arrays: { rules: [{ path: ["items"], mode: "keyed", key: "id" }] },
})
// { ok: true, value: { items: [{ id: "a", qty: 2 }, { id: "b", qty: 3 }] }, conflicts: [] }
```

Keyed items match by the key value and merge recursively, so a conflict inside an item has a path such as `["items", { key: "id", value: "a" }, "qty"]`. An item deleted on one side and edited on the other conflicts at the item path. New items keep their position relative to their neighbours. Ordering compares the items both sides still hold: a one-sided reorder of original items wins, and different orderings (including both sides adding the same items in different positions) are one conflict at the array path with `reason: "order"` whose values are the key orders. Ordering changes are reported with `reason: "order"`, so `review-mixed` sees a reorder combined with the other side's edits. Keyed and set arrays are validated in all three states before merging, whichever side changed them.

Arrays without identity can use `mode: "sequence"` (or `arrays: { default: "sequence" }`). CAM aligns each edited array with the original and applies diff3: regions no side changed are kept, a region one side changed takes that side, and a region both sides changed differently conflicts at `["steps", { from, to }]`, where `from` and `to` index the original array. When every side has the same number of items in that region and no position changed differently on both sides, each position takes the side that changed it. CAM never merges inside an element both sides changed: equal lengths do not prove that rows correspond (one side may have reordered them), so such a region is a conflict. Elements in a sequence result are always taken whole from one side. Alignment is deterministic; for very large regions without unique anchors CAM stops refining, which can only produce more conflicts, never a wrong merge.

`set` arrays merge membership (an element is kept once if either or both sides added it, or if it was original and neither side removed it) and `multiset` arrays merge counts. Neither conflicts. Duplicate values in a `set` array throw `CAMConfigError`.

These merge results are structural only. Your application still owns server-side validation and must retry writes with the latest version, ETag, or equivalent optimistic-concurrency precondition.

### Coupled paths and reports

When fields must be selected together, configure a group with path-segment arrays. A conflict then contains all group slots and one submitted/current-server choice applies to the entire group. Paths must be non-root and non-overlapping; that is checked from the configuration alone, never from the state data. Missing object ancestors are supported. Some parents cannot be split key by key: one that is an array, a scalar, or `null` on any side, and an object that one side deleted while the other edited it. A group member beneath such a parent is replaced in that group by the parent path itself, so the conflict slot shows the whole parent and one choice still decides every member together. For example, if the server replaces `price` with `null` while you edit `price.currency` and `totals.amount` in one group, the conflict has slots `/price` and `/totals/amount`. This is data-driven, so it is a conflict and never a `CAMConfigError`. If two groups have members under the same such parent, the first configured group takes it and the other group keeps only its remaining members. Independent fields outside a group still merge normally.

`includeReport: true` adds opt-in provenance for changed paths and groups. Unresolved report entries omit `result`, and the conflict result still has no partial value. `formatConflictPath()` formats path segments as RFC 6901 JSON Pointer for display; it escapes `/` and `~` so keys with punctuation remain unambiguous.

Own enumerable object properties set to `undefined` are rejected by default. A parser that uses this representation for omitted captions can opt into `undefinedObjectProperties: "omit"` on `mergeStates()`, `applyConflictDecisions()`, or `resolveConflict()`. The option treats those object properties as absent while continuing to reject `undefined` at the root, in array slots, and in other unsupported positions.

Group paths may use `ANY` and `EACH`. `ANY` links every matched field into one decision. `EACH` creates one group instance per matched key (a keyed-array item or an object property); its conflicts carry `binding`. A wildcard over an array without a keyed rule links the whole array. When a matched item exists on only one side, the whole item is the group member, so a choice never rebuilds an item neither side had.

### Derived values and rules

`derived` paths are removed from all three states before merging, so they never conflict or trigger groups, and the result carries the current server value at the same location (the submitted value where the server has none). Recompute them in the application, for example in the recovery controller's `prepareCandidate`.

Rules run on the submitted state, the server state, and the merged result. A rule broken by an input is a violation of that input unless the original already broke it and that side left the rule's paths unchanged. A rule that both inputs satisfy but the merge breaks becomes a rule conflict over the rule's paths; choosing a side selects that side's values (whole items where an item exists on one side only), and the rule is checked again. Rules over derived paths are checked on the inputs only. Custom rule checks must be pure and synchronous: they receive a private copy of the state and return `true` or a message; any other return value, or a thrown error, is a `CAMConfigError`.

The Phase 7 evaluation in [`array-by-id-evaluation.md`](../bench/array-by-id-evaluation.md) is superseded: keyed arrays ship together with pattern groups, derived paths, and rules, which cover the cross-field cases that evaluation identified.


## Determinism and validation

Conflict paths use lexicographic key order. Output objects are constructed deterministically; JavaScript still enumerates integer-index keys before other string keys. Do not use JSON property order as application data.

CAM snapshots validated data before merging. Inputs and results share no object references. Shared, non-cyclic input references become independent copies; `-0` becomes `0`. Object outputs use `Object.prototype`, including when inputs have null prototypes. Keys such as `constructor`, `toString`, and `__proto__` are preserved as ordinary own data properties without changing the output prototype, including when `Object.prototype` is frozen.

Only own enumerable object properties are data. Non-enumerable object properties and non-enumerable extra array properties are ignored. Array indices must be own, enumerable data properties: holes, non-enumerable indices, and index accessors are rejected. Enumerable object accessors are rejected without invoking them. Symbol-keyed properties are rejected. Proxy traps may execute during inspection; the guarantee is that merging uses the validated private snapshot, not that each trap runs once.

The root has depth 0; each object property or array index adds one depth level, and values deeper than 512 are rejected. Values at depth 512, including empty containers and scalars, are valid. This depth bound is not a payload-size or CPU budget; applications accepting untrusted input should enforce their own request limits.

See the [supported-data table](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/README.md#supported-data-and-merge-granularity) and [migration guide](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/docs/migration.md).
