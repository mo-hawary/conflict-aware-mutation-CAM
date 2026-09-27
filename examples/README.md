# Examples

| File | What it shows | Checked in CI |
| --- | --- | --- |
| [`fetch-rest.mjs`](./fetch-rest.mjs) | Full stale-write recovery against a local ETag-guarded REST server: match the error, fetch the latest state, merge, retry, and resolve a true conflict | Yes (`npm run examples`) |
| [`choose-sides.mjs`](./choose-sides.mjs) | Applying per-path "yours / theirs" decisions to an unresolved merge while keeping every non-conflicting change | Yes, through `fetch-rest.mjs`; typed by `choose-sides.d.mts` |
| [`playground/`](./playground) | Browser playground: edit three JSON states and see the `mergeStates()` result. | Built by CI with Vite; see its [dependency update notes](./playground/README.md) |
| [`react/tanstack-query-react.tsx`](./react/tanstack-query-react.tsx) | Where CAM fits in a TanStack Query mutation, plus a minimal unstyled conflict picker | Type-checked and behavior-tested in CI |

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

The React example exports `OrderEditor` and an `OrderApi` interface for your backend implementation. It is a tested integration sketch, not a standalone app. Only notes are editable. The editor handles saves as follows:

- **Ordinary save:** typing stays enabled. When the request succeeds, the draft preserves notes typed during the request and adopts the other fields from the saved response.
- **Apply conflict choices:** the draft immediately displays the chosen state, including “Theirs.” Notes editing pauses until the resolution request finishes. If the request fails, the chosen draft and conflict picker remain available for retry.
- **Changed draft:** if you edit after a conflict was detected, save again to refresh the choices before applying them.
- **Cache update:** immediately before writing a successful response to the cache, the mutation awaits cancellation of the exact `['order', id]` query. This prevents an already-running refetch, including one started during the save, from overwriting that saved response with stale data.

If you add editable fields, extend the draft reconciliation and its behavior tests. Query cancellation protects the client cache; every write still needs the backend's concurrency precondition.

Keep the original state and ETag paired for an editing session. Preserve the backend precondition on each write, handle another stale rejection, and validate merged values against your domain rules.
