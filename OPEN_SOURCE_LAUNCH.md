# Public launch and release status

Status snapshot: **September 27, 2026**

Reviewed `main`: `cbe1df7140841397465a6a9cfc06a5621ef67d6b`

Repository: [mo-hawary/conflict-aware-mutation-CAM](https://github.com/mo-hawary/conflict-aware-mutation-CAM)

## Source and history review

- Before the repository was made public, Gitleaks 8.18.4 was checksum-verified and smoke-tested against a synthetic GitHub token fixture.
- The scan covered the mirrored remote refs and GitHub pull-request heads at the exposure snapshot (`5a96faf23680bf00dc2e10322afef51207fef66e`): 70 history diffs plus six commits reachable only from pull-request refs. It found no secrets. Secret values were not printed or stored in the repository.
- The scan does not cover unreachable Git objects or unpushed local-only branches.
- The repository includes an MIT license. Maintainer metadata in `package.json` was intentionally public as part of the launch authorization.

## Repository controls

| Control | Verified status |
| --- | --- |
| Visibility | Public. |
| `main` protection | Active ruleset requires PRs, squash merges, strict checks `pr-title`, `test (22)`, `test (24)`, `package (22)`, and `package (24)`. No bypass actors. |
| `v*` tag protection | Active ruleset blocks tag updates and deletions; Release Please can create tags. No bypass actors. |
| Immutable releases | Enabled. The `v0.1.1` GitHub release is immutable; it was published after this setting was enabled. |
| Vulnerability reporting | Private vulnerability reporting is enabled. |
| Actions PR creation | Enabled. Workflow token permissions remain read-only by default; the repository allows workflows to create and approve PRs. |
| `npm` environment | Exists and is used by `publish-npm.yml`; no reviewer gate is configured. |
| Release Please credential | `RELEASE_PLEASE_TOKEN` is configured as a repository Actions secret. The fine-grained token expires January 1, 2027. |

## Release and npm publication

- Release Please created its own `0.1.1` release PR (#14). All five required checks passed before it was merged.
- Release Please created tag [`v0.1.1`](https://github.com/mo-hawary/conflict-aware-mutation-CAM/releases/tag/v0.1.1) at `cbe1df7140841397465a6a9cfc06a5621ef67d6b`; no release version or tag was created manually.
- [`conflict-aware-mutation@0.1.1`](https://www.npmjs.com/package/conflict-aware-mutation/v/0.1.1) was published from that exact tag through the documented one-time interactive bootstrap with npm 2FA.
- Validation from the release tag passed: typecheck, all 53 tests, tarball dry-run, and exact consumer-tarball verification.
- A clean consumer installed the registry package. Runtime imports and a merge example passed; an independent TypeScript consumer compiled against its declarations.
- The registry integrity matches the locally verified release artifact. `npm audit signatures` verified the package's registry signature. The registry has no provenance attestation for this one-time bootstrap publication; `publishConfig.provenance: false` was the documented exception.

## Remaining work

- **npm Trusted Publishing:** configuration is not yet verified. Required values are owner `mo-hawary`, repository `conflict-aware-mutation-CAM`, workflow `publish-npm.yml`, and environment `npm`. npm rejected the current setup attempt with `EOTP`; it needs account-owner 2FA authorization.
- **Provenance for normal releases:** restore `publishConfig.provenance: true` in a checked PR before the next release, then verify the trusted-publishing workflow against the registry.
- **Published README:** the v0.1.1 npm page still displays the stale README from its release tag. The README cleanup PR updates GitHub and is intentionally docs-only, so it will not create a release. npm displays the README from a published package version; a separate Release Please-generated patch release is required to refresh the npm page. Verify that page after publication.

## Launch references

- [README](./README.md) — installation, runnable quick start, API behavior, and development commands.
- [Release guide](./RELEASING.md)
- [Security policy](./SECURITY.md)
- [Contribution guide](./CONTRIBUTING.md)
