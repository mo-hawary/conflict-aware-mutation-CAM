# Phase 7: Array-by-ID evaluation

## Decision

**No-go for adding identity-aware array merging to the shipped CAM API in this roadmap pass.** Keep `mergeStates()` arrays atomic. The prototype demonstrates a real capability gap for sparse edits to separate records in the same array, but the cited ALORA variant/media case is a cross-field domain invariant. ID matching does not know which media must follow a default-variant change, so it cannot resolve that case safely. Existing ID-keyed object records and coupled-path groups address those needs with less new merge policy.

The prototype remains an evaluation artifact at `bench/prototypes/array-by-id.mjs`. It is not in `src/`, is not exported, and adds no package runtime dependency. The new benchmark is part of the existing developer-only bench script.

## Prototype contract

The evaluator accepts three arrays of plain JSON objects. Every item must have an own `id` property whose value is a string. Empty strings are allowed; missing, non-string, or duplicate IDs and non-object items are rejected. CAM's existing JSON validation still rejects unsupported values. No input is mutated.

For IDs present in the original array, matching items are passed through `mergeStates()` and inherit its object, deletion, null, array, and nested conflict semantics. The resulting rules are:

- Different fields of the same item can merge. Nested objects recurse; an array-valued field remains atomic.
- If one side deletes an original item and the other leaves it unchanged, the deletion is kept. Deleting on both sides also succeeds.
- Deleting an item against an edit to that item conflicts at `[id]`. The conflict sides distinguish absence from the surviving item.
- Changing an item's ID is a deletion of the old ID plus an addition of the new ID. A concurrent edit to the old ID can therefore conflict with its deletion.
- A one-sided new ID is kept. Both sides adding the same ID agree only when the complete normalized objects are identical; different objects conflict at `[id]`.
- Existing-item order is compared after filtering to original IDs present on both sides. Equal orders are accepted. If one side retains the filtered original order, the other side's reorder is kept. Different two-sided reorders conflict at the root path `[]`.
- New IDs are appended in `currentServerState` order first (including shared additions), followed by submitted-only IDs in `submittedState` order. Reorder conflicts have no partial `value`.

Item conflict paths start with the string ID, followed by any nested object path, for example `['variant-a', 'details', 'color']`. This is a prototype-specific path convention; it does not claim that array IDs are JSON Pointer path segments in the public API.

## Representative scenarios

### Sparse record edits

Original: `[{ id: 'sku-a', qty: 1, price: 10 }]`.

Submitted changes `qty` to `2`; the server changes `price` to `12`. Atomic arrays report a conflict at `['items']`; the prototype produces `[{ id: 'sku-a', qty: 2, price: 12 }]`. This is a genuine case where ID merging is more convenient if callers must retain an array representation.

String IDs are accepted, as in `id: 'sku-a'`. A list of bare strings such as `['draft', 'published']` has no identity field and is rejected by this prototype; ordinary CAM continues to accept it as an atomic JSON array and safely conflicts when both sides change it differently.

### Deletions

Deleting `{ id: 'a', value: 1 }` while the server still has that unchanged object produces an empty result. If the server changed it to `{ id: 'a', value: 2 }`, the result is a conflict at `['a']` with `submitted: { exists: false }` and `currentServer: { exists: true, value: ... }`. The reverse-side deletion is symmetric.

### ALORA variant/media case

The cited roadmap scenario changes the local default variant while the server changes variant/media data. That is a relationship between fields: choosing a default may require recomputing or changing dependent media. By-ID array merging would only merge matching item fields; it would not know this dependency and could combine a new default with stale media.

For that scenario, keep the domain rule in the application: represent variants as an object keyed by ID when independent per-variant field merging is useful, and use a coupled-path group or candidate preparation to review/recompute the default-plus-media change as one decision. If the backend's array order is meaningful, keep order as an explicit value and let the current atomic-array rule report concurrent order edits. ID merging is justified only if a concrete workflow also needs automatic field merging across separate array items and cannot reasonably use ID-keyed records.

## Cost and measurements

The evaluator source is 8,241 bytes and its focused test file is 8,082 bytes. These are repository evaluation files only; the package's `files` allowlist ships `dist` and `src`, so this adds zero bytes and zero runtime dependencies to consumers. The prototype validates/copies input arrays through CAM and invokes `mergeStates()` per existing ID, which keeps semantics aligned but has visible per-item overhead.

On local Node `v24.21.0`, `npm run bench` measured a 200-item sparse-edit case at 1.31 ms/op for the prototype and 324.3 µs/op for the atomic baseline (about 4.0× the time). The baseline returns an array conflict while the prototype merges the two non-overlapping item edits, so this is an execution-cost comparison, not equivalent output work. This is one local benchmark run, not a cross-runtime performance claim.

The focused evaluation suite contains 17 cases covering sparse record edits, string IDs and bare strings, item-level conflicts, deletion behavior, ID changes, same-ID additions, ordering, invalid IDs/items, immutability, prototype-safe IDs, and the atomic baseline. All 17 passed in the local run.

## Remaining gaps

The prototype requires stable unique string IDs and treats ID changes as delete-plus-add. It does not infer identity for primitive arrays, resolve different concurrent reorders, preserve a partial merge after any conflict, or enforce application-specific relationships between items and fields. These extra rules and the measured per-item overhead do not justify a shipped feature for the cited ALORA case.
