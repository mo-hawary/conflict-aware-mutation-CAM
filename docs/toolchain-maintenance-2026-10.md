# CI and development tooling — October 2026

This page records the repository tooling baseline consolidated from Dependabot pull requests [#41](https://github.com/mo-hawary/conflict-aware-mutation-CAM/pull/41), [#42](https://github.com/mo-hawary/conflict-aware-mutation-CAM/pull/42), [#43](https://github.com/mo-hawary/conflict-aware-mutation-CAM/pull/43), [#44](https://github.com/mo-hawary/conflict-aware-mutation-CAM/pull/44), and [#45](https://github.com/mo-hawary/conflict-aware-mutation-CAM/pull/45).

## Exact direct updates

| Tool | Previous | Current | Purpose and effect |
| --- | --- | --- | --- |
| `actions/setup-node` | v7.0.0 | v7.1.0 | Adds support for `mise.toml` and absolute `node-version-file` paths, plus Node-version validation and manifest-fetch retry handling. |
| `actions/upload-artifact` | v7.0.1 | v7.0.2 | Improves artifact download retries on HTTP 429 (including `Retry-After` support) and includes `@actions/artifact` 6.3.1. |
| `size-limit` | 14.1.0 | 14.2.0 | Updates the CLI used by `npm run size`; fixes default `exports` resolution without `main`, avoids lowering process listener limits for small checks, and supplies plugin types. |
| `@size-limit/preset-small-lib` | 14.1.0 | 14.2.0 | Keeps the preset and `size-limit` on the same 14.2.0 release, along with `@size-limit/file` and `@size-limit/rolldown`. |
| `publint` | 0.3.24 | 0.3.25 | Improves detection of invalid `.ctsx` JSX extensions and skips inappropriate existence checks for `browser` entries pointing to other packages. |

The GitHub Actions references remain **pinned by full commit SHA**:

- `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` in `auto-merge-release.yml`, `bench.yml`, `ci.yml`, `docs.yml`, `mutation.yml`, and `publish-npm.yml` (10 uses total).
- `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9` in `mutation.yml` and `scorecard.yml` (2 uses total).

Both action versions replace the older pinned SHAs; permissions, triggers, release gates, and workflow logic remain unchanged.

## Lockfile and transitive changes

`package.json` pins the two size-limit packages to 14.2.0 and `publint` to 0.3.25. `package-lock.json` reflects that combined state rather than two independent, mixed-version Dependabot lockfiles.

- `@size-limit/file` and `@size-limit/rolldown` resolve to 14.2.0.
- The underlying `rolldown` resolves from 1.2.11 to 1.2.13, including its platform-specific optional bindings.
- `@oxc-project/types` resolves from 0.151.0 to 0.153.0.
- The `size-limit` CLI, preset, and preset plugins share the 14.2.0 dependency graph rather than keeping 14.1.0 nested copies.

These are **development and CI dependencies only**. CAM's production runtime dependencies, exported API, three-way merge semantics, supported Node engines, and root/recovery size budgets do not change.

## Verification

The relevant checks are `npm ci`, `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run package:verify`, `npm run lint:package`, `npm run size`, and `npm run examples`. PR CI executes its required test and package checks under Node.js 22 and 24. CI additionally runs scoped runtime, React, and playground checks. The TypeDoc workflow and CodeQL check cover the workflow and README changes.

Individual Dependabot branches passing CI is not sufficient evidence of the **combined** dependency tree: the consolidated PR's checks must also pass.

## Release and npm versioning

This maintenance set is integrated as **one squash-merged `fix(ci):` commit**. It does not directly change the package version, release manifest, or generated `CHANGELOG.md`. Release Please uses the commit on `main` to prepare **one patch-version release PR** under the repository's pre-1.0 version policy, where it generates the version and changelog entry together. Publishing can occur only after the release PR and tag validation through the normal npm trusted-publishing workflow.

The release PR is a separate automated artifact of CAM's existing publishing process, not a second dependency-upgrade PR. The exact next version is determined by Release Please, not this documentation. The bundled PR itself never publishes to npm.
