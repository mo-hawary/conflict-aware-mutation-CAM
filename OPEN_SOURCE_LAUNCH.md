# Open-source launch checklist

Status snapshot: **September 27, 2026**

Reviewed main SHA: `5a96faf23680bf00dc2e10322afef51207fef66e`.

## Source and history review

- **Verified:** the repository is public after an all-refs secret-history review.
- **Verified:** official Gitleaks 8.18.4 was checksum-verified and detected a synthetic GitHub token fixture before scanning.
- **Verified:** the mirrored remote contained 23 refs and 72 unique reachable commits, including GitHub pull-request head refs. Gitleaks 8.18.4 scanned the full `--all` history (70 commit diffs) and reported zero findings; the six commits reachable only from pull-request refs were also scanned individually with zero findings. No secret values were emitted or stored in this repository.
- **Scope:** this scan covered current remote branches and tags. It does not cover unreachable Git objects or unpushed local-only branches.
- **Verified:** MIT license is present. The owner authorized exposing the repository contents, including the maintainer and contact metadata already in `package.json`.

## Repository controls

| Control | Status | Evidence |
| --- | --- | --- |
| Repository visibility | **Complete** | GitHub reports the repository public. |
| `main` protection | **Complete** | Active ruleset requires pull requests, squash merges, and all five CI checks listed below. No bypass actor is configured. |
| `v*` tag protection | **Complete** | Active ruleset blocks updates and deletions; tag creation remains available to Release Please. No bypass actor is configured. |
| Immutable releases | **Complete for future releases** | Repository setting is enabled. GitHub applies immutability to releases created after the setting is enabled; existing `v0.1.0` remains non-immutable. |
| Private vulnerability reporting | **Complete** | GitHub API reports enabled. |
| Actions PR creation | **Complete** | Workflow permissions remain read-only by default; the repository setting now allows Actions to create and approve PRs as needed. |
| npm environment | **Complete** | Environment `npm` exists and is used by `publish-npm.yml`; it has no required reviewer rule. |
| Release Please credential | **Pending** | `RELEASE_PLEASE_TOKEN` is not yet configured. Add a fine-grained token limited to this repository with Contents, Issues, and Pull requests read/write so generated PRs trigger CI. |
| Release Please release PR | **Pending** | No open release PR exists yet. Rerun after the token is configured, then require its CI checks before merging. |
| npm Trusted Publisher | **Pending** | Requires the real npm package to exist; configure after the bootstrap publish. |

## CI checks to require

PR #12 CI run `36342318735` passed all of the following checks, now required on `main`:

- `pr-title`
- `test (22)`
- `test (24)`
- `package (22)`
- `package (24)`

The package jobs install and exercise the packed tarball. Reconfirm the names if the workflow job names change.

## Publication gates

- **Verified:** main's `package.json` has no `private` flag and sets `publishConfig.provenance` to `false` for the documented one-time bootstrap exception.
- **Verified:** authenticated npm account is `mo-hawary`; two-factor authentication is enabled for authentication and writes.
- **Registry check:** `conflict-aware-mutation` has no package record visible in the authenticated npm session (`npm view` returned `E404`). The first real publish remains the definitive check that the unscoped name can be claimed.
- **Pending:** Release Please must create its own release PR. The release PR and resulting tag determine the exact version; `0.1.1` remains the current expectation, not a manual version instruction.
- **Pending:** run tests and package verification from the exact generated release tag, then perform the one-time interactive public npm publish with 2FA. A dry-run is not publication evidence.
- **Pending:** configure npm Trusted Publishing for `mo-hawary/conflict-aware-mutation-CAM`, workflow `publish-npm.yml`, environment `npm`.
- **Pending:** restore `publishConfig.provenance: true` through a checked PR before the next normal release.
- **Pending:** verify the published package by clean consumer install, imports/types, registry integrity and signatures, and the documented bootstrap provenance exception.
