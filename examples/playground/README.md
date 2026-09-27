# CAM browser playground

Edit the original, submitted, and current server JSON snapshots and inspect the merge result. Arrays are atomic; objects merge recursively.

From the repository root:

```bash
npm ci
npm run build
npm ci --prefix examples/playground
npm run dev --prefix examples/playground
```

Open the local URL printed by Vite. For a production build, run `npm run build --prefix examples/playground`.

The playground depends on `file:../..`, so it uses the built repository checkout rather than a pinned npm release. Rebuild the root after core changes. An online sandbox must include the repository root and run the root build; importing only this subdirectory is insufficient.

After changing the root package name, version, or entry points, refresh the example lockfile with `npm install --package-lock-only --prefix examples/playground`, then verify a clean install and build.
