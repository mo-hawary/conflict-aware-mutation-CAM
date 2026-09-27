# Data model and merge examples

CAM compares three complete JSON snapshots. Objects recurse only when a plain object exists at the same path on all three sides. Arrays are atomic values.


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


## Determinism and validation

Conflict paths use lexicographic key order. Output objects are constructed deterministically; JavaScript still enumerates integer-index keys before other string keys. Do not use JSON property order as application data.

CAM snapshots validated data before merging. Inputs and results share no object references. Shared, non-cyclic input references become independent copies; `-0` becomes `0`. Object outputs use `Object.prototype`, including when inputs have null prototypes.

Only own enumerable object properties are data. Non-enumerable object properties and non-enumerable extra array properties are ignored. Array indices must be own, enumerable data properties: holes, non-enumerable indices, and index accessors are rejected. Enumerable object accessors are rejected without invoking them. Symbol-keyed properties are rejected. Proxy traps may execute during inspection; the guarantee is that merging uses the validated private snapshot, not that each trap runs once.

The root has depth 0; each object property or array index adds one depth level, and values deeper than 512 are rejected. Values at depth 512, including empty containers and scalars, are valid. This depth bound is not a payload-size or CPU budget; applications accepting untrusted input should enforce their own request limits.

See the [supported-data table](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/README.md#supported-data-and-merge-granularity) and [migration guide](https://github.com/mo-hawary/conflict-aware-mutation-CAM/blob/main/docs/migration.md).
