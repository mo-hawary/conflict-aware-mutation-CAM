# Releasing CAM

CAM uses SemVer, Conventional Commits, Release Please, GitHub Releases, `vX.Y.Z` tags, and npm Trusted Publishing.

## Version policy

The initial GitHub release is `v0.1.0`. It predates npm publication and must never be moved or reused.

While CAM is below `1.0.0`:

- `fix:` -> patch
- compatible `feat:` -> patch
- breaking `type!:` or `BREAKING CHANGE:` -> minor

Release Please owns normal version bumps, `.release-please-manifest.json`, `CHANGELOG.md`, tags, and GitHub Releases. Do not manually move/create a normal release tag or edit a generated release version to force publication.

## Normal release flow

1. Changes land on `main` with a Conventional Commit-compatible squash title.
2. Release Please opens or updates its release PR.
3. Required CI passes on that release PR.
4. The release PR is reviewed and merged.
5. Release Please creates the matching `vX.Y.Z` tag and GitHub Release.
6. `.github/workflows/publish-npm.yml` checks out that exact tag, verifies tag/version/release identity, runs tests and an installed-tarball consumer check, then publishes through npm Trusted Publishing with provenance.
7. If the GitHub Release was created with `GITHUB_TOKEN` and the `release` event is suppressed, manually dispatch **Publish npm** with the already-existing GitHub Release tag. The workflow performs the same release validation before publishing.

The npm workflow never publishes a pull request, branch head, or an unvalidated arbitrary ref. Publication is serialized. If the exact version already exists, the workflow does not try to overwrite it and instead proceeds to registry verification.

## Trusted Publishing configuration

The workflow uses direct publishing, not staged publishing. Configure the npm package's Trusted Publisher with:

- provider: GitHub Actions
- GitHub owner/user: `mo-hawary`
- repository: `conflict-aware-mutation-CAM`
- workflow filename: `publish-npm.yml`
- GitHub environment: `npm`
- allowed action: direct `npm publish`

Create the GitHub environment named `npm` before the first OIDC publication; a required reviewer is recommended for a deliberate release gate. The workflow grants only `contents: read` and `id-token: write`, runs on a GitHub-hosted runner, uses Node 24, and pins npm CLI `11.20.0`. Do not configure `NPM_TOKEN` for normal releases.

After Trusted Publishing works, configure npm package access to require 2FA and disallow token-based publishing where appropriate.

## First npm publication: bootstrap exception required

As of September 27, 2026, npm Trusted Publishing can only be configured for a package that already exists, and npm staged publishing also cannot create a brand-new package. That conflicts with this repository's standing rule to keep `"private": true` until Trusted Publishing is configured.

Do **not** silently bypass that rule. The owner must explicitly approve this narrowly scoped bootstrap exception:

1. Complete the pre-public secret/history review and authorize making the GitHub repository public.
2. In the owner's npm account, with 2FA enabled, confirm that the unscoped name `conflict-aware-mutation` is actually available/owned. An anonymous registry `404` is not ownership proof.
3. Explicitly approve the one-time bootstrap exception: allow removal of `"private": true` before Trusted Publishing solely to create the real package.
4. Merge a dedicated change removing `"private": true`. Do not manually bump the version. Let the existing Release Please PR update normally.
5. Merge the Release Please release PR. Given the current `v0.1.0` history and this launch-preparation `fix:` change, the intended first npm version is `0.1.1` unless subsequent merged changes cause Release Please to choose a different version. Verify the actual release PR/tag before publishing.
6. From the exact `vX.Y.Z` release tag, perform the one-time initial publish interactively using the owner's npm account + 2FA (or another npm-supported short-lived bootstrap credential explicitly approved by the owner). Do not create a long-lived automation token. This first bootstrap publish cannot use Trusted Publishing because the package does not exist yet.
7. Immediately configure the Trusted Publisher fields above for the now-existing package and create/protect the GitHub `npm` environment.
8. Future versions use `.github/workflows/publish-npm.yml` only. The first fully OIDC/provenance-backed release will therefore be the next Release Please version after the bootstrap publish unless npm changes its first-package bootstrap rules.

Do not create a dummy npm version, move `v0.1.0`, or falsify release history to avoid this sequence.

## Failed publication recovery

- **Workflow/account failure before npm accepts the version:** fix only the account/environment configuration and rerun/dispatch the same existing release tag.
- **The exact version is already on npm:** do not overwrite it. The workflow detects it and verifies the registry installation instead.
- **A code/package defect is discovered after the GitHub release:** fix it on `main` with a regression test and let Release Please create the next version. Never move/reuse the failed release tag.
- **OIDC/Trusted Publisher mismatch:** verify owner, repository, workflow filename, environment name, direct-publish permission, and that the repository/package are public; then rerun the same release only if npm has not accepted that version.

## Registry verification after an authorized publish

The publish workflow installs `name@version` from the public registry into a new temporary consumer, imports by package name, and runs `npm audit signatures`. The release report must also confirm the npm registry version and provenance/attestation shown for that exact version; a dry-run or successful OIDC setup alone is not proof of publication.

## Release Please authentication

`.github/workflows/release-please.yml` prefers the repository secret `RELEASE_PLEASE_TOKEN` and falls back to `GITHUB_TOKEN`. GitHub suppresses most downstream workflow events created with `GITHUB_TOKEN`, which is why the npm workflow includes the validated manual-dispatch fallback.

Before enforcing required checks on Release Please PRs, configure `RELEASE_PLEASE_TOKEN` as a narrowly scoped credential that can create/update release PRs and create releases, then confirm a real Release Please PR still receives all required CI checks.

## Public repository controls

After public visibility is separately authorized:

- require PRs and the observed Node 22/24 CI checks on `main`
- protect `v*` tags from update/deletion
- enable immutable GitHub Releases
- enable private vulnerability reporting
- keep squash merge as the normal merge method
- verify Release Please can create/update its release PR under the enforced rules

See `OPEN_SOURCE_LAUNCH.md` for the current verified/pending control status.

## Revalidated references (2026-09-27)

- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- npm staged publishing: https://docs.npmjs.com/staged-publishing/
- GitHub `GITHUB_TOKEN` event behavior: https://docs.github.com/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow
