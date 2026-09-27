# Open-source launch checklist

Status snapshot: **September 27, 2026**

Reviewed main SHA: `9447778c722f028936338349d5ff563acb709a87`.

This file records preparation evidence only. It does not authorize changing repository visibility, merging a release, moving tags, or publishing npm.

## Source and history review

- **Verified:** the tracked main tree contains no `.env` file.
- **Verified (bounded scan):** all 44 commits reachable from `main` were inspected through their GitHub commit diffs for common credential signatures: PEM private keys, AWS access-key IDs, GitHub tokens, npm tokens, OpenAI-style API keys, Slack tokens, and basic-auth URLs. No matches were found.
- **Limitation:** this is not an entropy-based secret audit and does not inspect unreachable Git objects, deleted refs, or every non-main branch. Before visibility changes, run a dedicated full-history scanner such as Gitleaks/TruffleHog locally with secret values redacted from reports.
- **Verified:** MIT license is present. `package.json` identifies maintainer `Mo Hawary` and the existing public contact metadata; owner should confirm those are intended to be public.

## Repository controls

| Control | Status | Evidence / next action |
| --- | --- | --- |
| Repository visibility | Pending owner action | Repository is currently private. Make public only after the bootstrap/name/secret review is approved. |
| `main` protection | Unavailable to verify through current integration | GitHub branch-protection read returned `Resource not accessible by integration`. After public visibility, configure protection and verify against the check names observed on this PR. |
| Repository rulesets | Blocked while private on current plan | GitHub returned `Upgrade to GitHub Pro or make this repository public to enable this feature.` |
| `v*` tag update/deletion protection | Pending | Configure after public visibility/rulesets are available. Do not move existing `v0.1.0`. |
| Immutable releases | Pending | Existing `v0.1.0` is currently reported by GitHub with `immutable: false`. Enable immutable releases when available. |
| Private vulnerability reporting | Pending | Enable after the repository is public and verify the setting in GitHub. |
| Release Please | Source configuration verified | Workflow is present. Before enforcing PR checks, configure/verify `RELEASE_PLEASE_TOKEN` as documented in `RELEASING.md`, then confirm a real release PR passes required checks. |
| npm Trusted Publisher | Pending npm owner action | Requires an existing npm package; follow the explicit bootstrap sequence in `RELEASING.md`. |

## CI checks to require

PR #9 CI run `36325690855` completed these observed checks successfully:

- `pr-title`
- `test (22)`
- `test (24)`
- `package (22)`
- `package (24)`

The package jobs install and exercise the real packed tarball, not workspace source paths. Configure `main` protection to require these observed checks and a pull request before merge. Re-confirm the names if the workflow job names change later.

## Publication gates

- `package.json` intentionally remains `"private": true` in this preparation PR.
- npm package-name availability/ownership is **not verified** by an authenticated owner session.
- npm Trusted Publishing is **not configured/verified**.
- No npm publication has been attempted by this preparation work.
- The exact first npm version must come from Release Please. Based on current history, `0.1.1` is intended, but the release PR/tag is authoritative.
