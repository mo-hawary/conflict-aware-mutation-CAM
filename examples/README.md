# Examples

| File | What it shows | Checked in CI |
| --- | --- | --- |
| [`fetch-rest.mjs`](./fetch-rest.mjs) | Full stale-write recovery against a local ETag-guarded REST server: match the error, fetch the latest state, merge, retry, and resolve a true conflict | Yes (`npm run examples`) |
| [`choose-sides.mjs`](./choose-sides.mjs) | Applying per-path "yours / theirs" decisions to an unresolved merge while keeping every non-conflicting change | Yes, through `fetch-rest.mjs` |
| [`tanstack-query-react.tsx`](./tanstack-query-react.tsx) | Where CAM fits in a TanStack Query mutation, plus a minimal unstyled conflict picker | No, reference only |

Examples are not part of the published package. CAM itself stays headless: the backend call, retry policy, and conflict UI belong to your application.

```bash
npm run examples
```
