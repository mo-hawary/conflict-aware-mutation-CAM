# Public launch and release status

Status snapshot: **September 27, 2026**

Reviewed `main`: `810dab212d2fb9e3af754f76c9eff720badbcef2`

Repository: [mo-hawary/conflict-aware-mutation-CAM](https://github.com/mo-hawary/conflict-aware-mutation-CAM)

**Launch status: complete.** The public repository, release controls, npm package, Trusted Publishing, and published developer README have all been verified.

## Source and history review

- Before the repository became public, Gitleaks 8.18.4 was checksum-verified and smoke-tested with a synthetic GitHub token fixture.
- The scan covered mirrored remote refs and GitHub pull-request heads at the exposure snapshot (`5a96faf23680bf00dc2e10322afef51207fef66e`): 70 history diffs plus six commits reachable only from pull-request refs. It found no secrets. Secret values were not printed or stored in the repository.
- The scan did not cover unreachable Git objects or unpushed local-only branches.
- The repository is MIT licensed. Maintainer metadata in `package.json` was intentionally included in the public launch.

## Repository controls

| Control | Verified status |
| --- | --- |
| Visibility | Public. |
| `main` protection | Active ruleset requires PRs, squash merges, strict checks `pr-title`, `test (22)`, `test (24)`, `package (22)`, and `package (24)`. No bypass actors. |
| `v*` tag protection | Active ruleset blocks tag updates and deletions; Release Please can create tags. No bypass actors. |
| Immutable releases | Enabled. Releases `v0.1.1` and `v0.1.2` were published after this setting was enabled. |
| Vulnerability reporting | Private vulnerability reporting is enabled. |
| Actions PR creation | Enabled. Workflow token permissions remain read-only by default; the repository allows workflows to create and approve PRs. |
| `npm` environment | Used by `publish-npm.yml`; Trusted Publishing for this repository and workflow was verified by the successful OIDC publication of `0.1.2`. |
| Release Please credential | Repository Actions secret `RELEASE_PLEASE_TOKEN` is configured. The repository-only fine-grained token expires January 1, 2027; rotate it before expiry. |

## Releases and npm publication

### `0.1.1`: documented first-publication bootstrap

- Release Please created its own release PR (#14), and all five required checks passed before merge.
- Release Please created tag [`v0.1.1`](https://github.com/mo-hawary/conflict-aware-mutation-CAM/releases/tag/v0.1.1) at `cbe1df7140841397465a6a9cfc06a5621ef67d6b`. No release version or tag was created manually.
- [`conflict-aware-mutation@0.1.1`](https://www.npmjs.com/package/conflict-aware-mutation/v/0.1.1) was published from that exact tag using the documented one-time interactive npm bootstrap with 2FA.
- Typecheck, all 53 tests, package dry-run, exact consumer-tarball verification, runtime imports, and a TypeScript consumer passed. Registry integrity matched the verified release artifact, and `npm audit signatures` passed.
- This one-time bootstrap used `publishConfig.provenance: false`, as documented. The absence of an npm provenance attestation for `0.1.1` is the expected bootstrap exception. Provenance was restored to `true` in checked PR #16 before the next release.

### `0.1.2`: normal OIDC publication

- The README cleanup merged in PR #15 without a release. The package description correction in PR #17 was followed by Release Please's own patch release PR #18; its required checks passed.
- Release Please created tag [`v0.1.2`](https://github.com/mo-hawary/conflict-aware-mutation-CAM/releases/tag/v0.1.2) at `4a85f83a9bc5fb654686d71b89567729a1a07aa6`. The version was not manually bumped and the tag was not moved.
- [`conflict-aware-mutation@0.1.2`](https://www.npmjs.com/package/conflict-aware-mutation/v/0.1.2) was published from that exact tag by GitHub Actions using npm Trusted Publishing and OIDC. npm reports a registry signature and SLSA provenance attestation.
- The initial publish step succeeded, but its immediate metadata lookup received E404 while npm was processing the new version. CI-only PR #19 added a bounded retry for that post-publication lookup. The rerun against the existing `v0.1.2` release detected the version, skipped publication, and passed the exact-tag typecheck, all tests, tarball verification, registry metadata/integrity check, signature and provenance verification, and runtime import check.
- A clean consumer installed `0.1.2`; the Quick start copied from the published README ran successfully, a TypeScript consumer compiled against the published declarations, and `npm audit signatures` passed. The installed README matches `README.md` at the exact `v0.1.2` tag and contains no stale pre-publication claim or unrelated private reference.

## Launch references

- [README](./README.md) — installation, runnable quick start, API behavior, and development commands.
- [Release guide](./RELEASING.md)
- [Security policy](./SECURITY.md)
- [Contribution guide](./CONTRIBUTING.md)
