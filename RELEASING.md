# Releasing CAM

CAM uses SemVer, Conventional Commits, Release Please, GitHub Releases, and `vX.Y.Z` tags.

## Version policy

The first public release is intended to be `0.1.0`.

While CAM is below `1.0.0`:

- `fix:` -> patch
- compatible `feat:` -> patch
- breaking `type!:` or `BREAKING CHANGE:` -> minor

At and after `1.0.0`, standard SemVer applies: breaking -> major, feature -> minor, fix -> patch.

## Automated release flow

1. Normal work lands on `main` using Conventional Commit-compatible squash titles.
2. Release Please updates or opens a release PR.
3. The release PR contains the proposed version and generated `CHANGELOG.md`.
4. Review the release PR like normal code.
5. Merging the release PR creates the `vX.Y.Z` tag and GitHub Release.

Do not manually create a normal release tag or edit the generated version/changelog to bypass this flow.

## Release Please token

The workflow can fall back to GitHub's built-in `GITHUB_TOKEN`, but GitHub does not trigger additional workflows from events created by that token.

Before required CI checks are enforced on Release Please PRs, configure a repository secret named `RELEASE_PLEASE_TOKEN` containing a narrowly scoped token that can create release PRs and releases. The workflow automatically prefers it when present.

## npm publishing

npm publishing is intentionally disabled while the repository/package is private.

Before the first npm publication:

1. make the GitHub repository public
2. create or claim the npm package
3. configure npm Trusted Publishing for this GitHub repository/workflow
4. remove `"private": true` from `package.json`
5. add the OIDC npm publish workflow with provenance
6. verify `npm pack --dry-run` and the release tarball
7. publish the first release

Do not introduce a long-lived `NPM_TOKEN` if trusted publishing is available.

## Repository settings before public launch

Enable these GitHub settings before announcing the repository:

- branch/ruleset protection for `main` with CI required
- tag rules protecting `v*` from update/deletion
- immutable GitHub Releases
- private vulnerability reporting
- squash merge as the normal merge method

These are repository-side controls rather than source files.
