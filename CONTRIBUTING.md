# Contributing to CAM

CAM solves stale-write recovery for JSON records. Good contributions make that contract easier to trust, understand, or integrate. Read [AGENTS.md](./AGENTS.md) for the detailed implementation contract and the [roadmap](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/29) for planned work.

## Start locally

Use Node 24 LTS; CI also tests Node 22. Clone the repository, then run:

```bash
npm ci
npm run typecheck
npm test
npm run examples
```

The core has no runtime dependencies. Keep React, networking, UI, and backend policy in examples or consumer applications.

## Find the right place

| Location | Purpose |
| --- | --- |
| `src/merge-states.ts` | Three-way merge and conflict paths |
| `src/validation.ts` | JSON snapshots and error-signal validation |
| `src/types.ts` | Public input/result types |
| `test/` | Unit, property, fuzz, package/release and runtime checks |
| `examples/` | REST, React, conflict decisions, and browser playground |
| `docs/` | Data semantics and migration guidance |

For a bug, include the package version, runtime, all three states, and expected/actual results. Remove private data. Report suspected vulnerabilities through [SECURITY.md](./SECURITY.md), not a public issue.

## Verify your change

Every bug fix needs a regression test that fails before the fix. For merge changes, cover relevant one-sided changes, agreement, collision, deletion/null, and array cases. Integration fixes need behavior tests, not only type checks.

| Change | Additional checks |
| --- | --- |
| Core or public types | `npm run test:coverage`, `npm run package:verify`, `npm run lint:package`, `npm run size` |
| REST or choice helper | `npm run examples` |
| React example | Build the root, then `npm ci --prefix examples/react`, `npm run typecheck --prefix examples/react`, `npm test --prefix examples/react` |
| Playground | Build the root, then `npm ci --prefix examples/playground`, `npm run build --prefix examples/playground` |
| README/API docs | `npx --yes -p typescript@6.0.3 -p typedoc@0.28.20 typedoc` |
| Runtime-sensitive behavior | `npm run build`, then `node test/runtime/run.mjs`; the CI runtime job also checks Deno, Bun, and browsers |
| Performance | `npm run bench`; compare identical workloads and report environment/revisions |

`npm run mutation` runs the slower Stryker checks. Benchmark comparisons are report-only because shared runners are noisy. Avoid treating one timing sample as a performance guarantee.

## Pull requests and releases

Keep changes focused and preserve existing user work. Explain the problem, observable behavior, regression evidence, and any compatibility impact. Update examples and docs alongside contract changes. Keep README links usable on npm by using absolute repository URLs for supporting files.

Use a Conventional Commit title, since PRs are squash-merged:

```text
fix(merge): preserve a server-only deletion
feat: add a compatible capability
docs: clarify array semantics
fix!: change input validation
```

For breaking changes, include a `BREAKING CHANGE:` footer with migration instructions in the squash commit. Before 1.0.0, compatible features and fixes bump the patch version; breaking changes bump the minor version. Review the generated release PR for the actual next version.

Release Please owns version bumps, the release manifest, generated changelog entries, tags, and GitHub Releases. Do not manually bump a version or move a release tag. See [RELEASING.md](./RELEASING.md).

Contributors follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Contributions are covered by the repository's MIT license.
