// Mutation testing. Run with `npm run mutation` (slow; CI runs it weekly).
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: { command: "npm run build --silent && node --test test/*.test.mjs" },
  mutate: ["src/**/*.ts", "!src/index.ts", "!src/types.ts"],
  coverageAnalysis: "off",
  concurrency: 4,
  timeoutMS: 60_000,
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  thresholds: { high: 90, low: 75, break: null },
  tempDirName: ".stryker-tmp",
  // Stryker rewrites tsconfig paths through the TypeScript JS API, which
  // TypeScript 7 no longer ships. Our tsconfig has no `extends` or project
  // references to rewrite, so point the option at a missing file to skip it.
  tsconfigFile: "tsconfig.stryker-skip.json",
}
