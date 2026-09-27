# Examples

| File | What it shows | Checked in CI |
| --- | --- | --- |
| [`fetch-rest.mjs`](./fetch-rest.mjs) | Full stale-write recovery against a local ETag-guarded REST server: match the error, fetch the latest state, merge, retry, and resolve a true conflict | Yes (`npm run examples`) |
| [`choose-sides.mjs`](./choose-sides.mjs) | Applying per-path "yours / theirs" decisions to an unresolved merge while keeping every non-conflicting change | Yes, through `fetch-rest.mjs`; typed by `choose-sides.d.mts` |
| [`playground/`](./playground) | Browser playground: edit three JSON states and see the `mergeStates()` result. [Open on StackBlitz](https://stackblitz.com/github/mo-hawary/conflict-aware-mutation-CAM/tree/main/examples/playground) | Built by CI with Vite; see its [dependency update notes](./playground/README.md) |
| [`react/tanstack-query-react.tsx`](./react/tanstack-query-react.tsx) | Where CAM fits in a TanStack Query mutation, plus a minimal unstyled conflict picker | Type-checked and behavior-tested in CI |

Examples are not part of the published package. CAM itself stays headless: the backend call, retry policy, and conflict UI belong to your application.

```bash
npm run examples
```
