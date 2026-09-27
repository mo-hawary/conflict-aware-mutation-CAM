# CAM playground

The playground depends on `file:../..`, so local builds and CI always bundle the CAM checkout being reviewed instead of a fixed published version. After changing the root package `name`, `version`, or entry points, refresh this example's lockfile from the repository root with:

```sh
npm install --package-lock-only --prefix examples/playground
```

Then verify it with `npm ci --prefix examples/playground && npm run build --prefix examples/playground`.
