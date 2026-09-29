# Design: array merging, linked fields, derived values, rules, and review

**Status:** implemented. This records the design and the decisions behind it.

## Problem

Two gaps limited CAM on ordinary records:

1. **Arrays were all-or-nothing.** If both sides touched the same array, the whole array conflicted, even when one person edited item A and the other edited item B.
2. **Fields depend on each other.** Once arrays merge by item, independent merging can combine two valid edits into a result nobody wrote: a new default item with a stale list, a discount too large for the new price, a stale total. The Phase 7 evaluation rejected ID-keyed arrays on their own for this reason.

The design ships item-level array merging **together with** declared couplings (pattern groups), derived values, rules, and a review policy, so the second gap is addressed wherever an application can state its constraints.

## Principles

1. **No partial result after a conflict.** Unchanged.
2. **Deterministic.** Identical inputs and options give identical output, including array order.
3. **JSON only**, with the same validation and zero runtime dependencies.
4. **A problem in the data is a conflict; a bad setting throws `CAMConfigError`.** Keyed arrays with missing or duplicate keys, and duplicate values in a set, are treated as settings errors: the declared rule does not fit the data.
5. **Opt-in.** Calls without the new options return identical results and types.

## Path model

- Keyed-array items: `{ key, value }` segments. A plain string or number would be ambiguous with property names and positions, which also shift between states.
- Sequence regions: `{ from, to }` segments in original indices (half-open). Paired elements use one-element ranges.
- Patterns (`PathPattern`) accept the exported `ANY` and `EACH` sentinels, encoded as `{ "$cam": "any" | "each" }`, so a real property named `"*"` stays unambiguous.
- `formatConflictPath()` renders `[id=a]` and `[1..3)` tokens. These are display-only extensions of RFC 6901.

## Arrays

Rules match concrete paths; fewer wildcards win, then configuration order. `arrays.default` covers unmatched arrays.

- **Keyed.** Items are matched by key and merged recursively through the ordinary engine, so groups, decisions, and reports work inside items. Delete versus edit conflicts on the item. Concurrent additions agree when equal and conflict otherwise. Order compares the items both edited sides hold: a one-sided reorder of original items wins; different orderings, including shared additions placed differently, produce one `reason: "order"` conflict. Ordering changes are reported (with `reason: "order"`) so the review policy sees them. Keyed and set invariants are validated in all three states before merging, independent of fast paths. Items missing from the winning order are placed right after their nearest predecessor in their own side's order.
- **Sequence.** diff3 (Smith 1988; formalized by Khanna, Kunal and Pierce, FSTTCS 2007). Items compare by canonical JSON. Alignment trims common prefixes and suffixes, anchors on elements unique to both sides (patience diff), and solves remaining regions with an exact LCS up to a size budget; beyond it, no further matches are assumed. Fewer matches only coarsen chunks, which can add conflicts but never produces a wrong merge. Unstable chunks resolve one-sided, identical, per position (equal lengths and no position changed differently on both sides), or as a range conflict. CAM never merges inside an element both sides changed: equal lengths do not establish row correspondence, so such regions conflict, and every result element is taken whole from one side. Moves are a delete plus an insert, so a move against an edit conflicts.
- **Set / multiset.** Membership (capped at one member) or counts (`max(0, submitted + currentServer - original)`); never conflict.

The engine only runs an array strategy when all three sides changed the array differently, or when a group or rule decision targets something inside it. Otherwise the existing one-sided and identical rules apply unchanged.

## Linked fields

Group patterns are expanded against the three states on every merge. `ANY` links all matches; `EACH` creates one instance per bound key, and its conflicts carry `binding`. A wildcard over an array without a keyed rule, or over a scalar, stops at that node, which becomes the member. A node present on some sides but absent on others is selected whole, so choosing a side never rebuilds a partial object. Overlap validation treats wildcards as matching any segment.

## Derived paths

Derived paths are stripped from all three states before merging, so they cannot conflict, trigger groups, or disturb sequence alignment. The result is re-filled from the current server at the corresponding location (keyed items by key, other arrays by position), else from the submitted state. Applications recompute them.

## Rules

Built-in rules are JSON data; custom rules are pure synchronous functions with declared `paths`. Each rule is evaluated on the original, submitted, server, and merged states:

| Situation | Result |
| --- | --- |
| An input breaks it, and either the original satisfied it or that side changed the rule's paths | `kind: "invalid"` violation for that side |
| The original already broke it and neither side touched its paths | Ignored (pre-existing) |
| Both inputs satisfy it, the merge does not | `kind: "rule"` conflict over the rule's expanded paths |

A rule decision forces the chosen side's values at those paths and merges again; the rule is then re-checked. `applyConflictDecisions()` accepts decisions accumulated across rounds and replays them round by round against conflicts recomputed from the same snapshots; each round must be covered completely and every decision must match a round. Rules that target a derived value (or a path inside one) are checked on inputs only, because merged derived values are stale until recomputed; rules on an ancestor of a derived path still check the merged result. Structural conflicts are reported first; rule conflicts appear once structural conflicts are resolved.

## Review policy

`autoMerge: "review-mixed"` returns `kind: "review"` with the complete value and a report when the result mixes submitted-side and server-side changes (or a set/multiset combined both). The value is complete, so the no-partial-result principle holds; the recovery controller routes it to review even with `autoRetry: "once"`.

Semantic conflict detection is undecidable in general, so no merge engine can detect every unintended combination. The guarantee instead: every saved result is something one side wrote, something declared groups and rules accept, or something a person confirmed.

## Compatibility

- Existing results and types are unchanged without the new options (verified by the full existing suite).
- Plain calls show no measurable slowdown in interleaved A/B benchmarks.
- The root bundle grows from about 5 kB to about 11 kB (minified and brotli-compressed), because array strategies and rules share the merge engine. The size budget reflects that.
- The recovery controller's `conflicts` outcome is typed to include the new conflict kinds, and it gains an `invalid` outcome.

## Out of scope

- Arrays without identity whose items are edited and moved at the same time are handled conservatively by diff3 (conflicts rather than guesses).
- Rules CAM is not told about are not enforced; `review-mixed` exists for that.
- An optional Rust/WASM engine remains evidence-gated (issue #26).
