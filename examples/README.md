# Examples

| File | What it shows | Checked in CI |
| --- | --- | --- |
| [`fetch-rest.mjs`](./fetch-rest.mjs) | Review-first stale-write recovery against a local ETag-guarded REST server: match the error, check terminal state, merge, validate, resolve exact conflicts, and confirm with the latest ETag | Yes (`npm run examples`) |
| [`versioned-rest-recovery.mjs`](./versioned-rest-recovery.mjs) | Recovery controller with an explicit integer version and HTTP 409; only explicit confirmation writes with the fetched version | Yes (`npm run examples`) |
| [`choose-sides.mjs`](./choose-sides.mjs) | Applying session-bound "yours / theirs" decisions to current conflicts while keeping every non-conflicting change | Yes, through `fetch-rest.mjs`; typed by `choose-sides.d.mts` |
| [`playground/`](./playground) | Browser playground: edit three JSON states and see the `mergeStates()` result. | Built by CI with Vite; see its [dependency update notes](./playground/README.md) |
| [`react/tanstack-query-react.tsx`](./react/tanstack-query-react.tsx) | Review-first TanStack Query recovery with candidate validation, terminal checks, session-bound choices, explicit confirmation, and ETag retention | Type-checked and behavior-tested in CI |

Examples are not part of the published package. CAM itself stays headless: the backend call, retry policy, and conflict UI belong to your application.

```bash
npm run examples
```

## Run the examples

From the repository root, use Node 24 LTS:

```bash
npm ci
npm run build
npm run examples
npm ci --prefix examples/react
npm run typecheck --prefix examples/react
npm test --prefix examples/react
npm ci --prefix examples/playground
npm run dev --prefix examples/playground
```

The React example exports `OrderEditor` and an `OrderApi` interface for your backend implementation. It is a tested integration sketch, not a standalone app. Only notes are editable. The editor handles recovery as follows:

- **Ordinary save:** typing stays enabled. When the request succeeds, the draft preserves notes typed during the request and adopts the other fields from the saved response.
- **Stale write:** the editor fetches the latest state, stops for terminal records, and presents a structurally merged candidate for review. Candidates pass through the supplied preparation and validation callbacks.
- **Conflict choices:** each choice is bound to the displayed session and exact conflict tuple. Applying choices updates the candidate; it does not write it. Invalid candidates remain editable, and only explicit confirmation starts a version-guarded request.
- **Changed draft:** typing during review edits and revalidates the displayed candidate. A later stale confirmation returns to recovery and requires another review.
- **Cache update:** immediately before writing a successful response to the cache, the mutation awaits cancellation of the exact `['order', id]` query. This prevents an already-running refetch, including one started during the save, from overwriting that saved response with stale data.

If you add editable fields, extend the draft reconciliation and its behavior tests. Query cancellation protects the client cache; every write still needs the backend's concurrency precondition.

Keep the original state and ETag paired for an editing session. Preserve the backend precondition on each write, handle another stale rejection, and validate merged values against your domain rules.
