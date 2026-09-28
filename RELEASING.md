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
4. The release PR is validated and automatically merged when eligible; otherwise it remains open for manual review.
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

## Bootstrap history

The first npm publication was the one-time interactive `0.1.1` bootstrap. It used the release tag and an explicitly approved provenance exception. That procedure is historical, not a step for future releases. The current package configuration enables provenance; normal releases use the trusted-publishing workflow above.

See [the launch record](./OPEN_SOURCE_LAUNCH.md) for the dated evidence. Verify account settings and publication results for each actual release rather than treating that snapshot as live status.

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

For the public repository, maintain these controls:

- require PRs and the observed Node 22/24 CI checks on `main`
- protect `v*` tags from update/deletion
- enable immutable GitHub Releases
- enable private vulnerability reporting
- keep squash merge as the normal merge method
- verify Release Please can create/update its release PR under the enforced rules

See `OPEN_SOURCE_LAUNCH.md` for the historical launch snapshot; it is not a live control audit.

## Revalidated references (2026-09-27)

- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- npm provenance: https://docs.npmjs.com/generating-provenance-statements/
- npm staged publishing: https://docs.npmjs.com/staged-publishing/
- GitHub `GITHUB_TOKEN` event behavior: https://docs.github.com/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow

## Artifact identity and reruns

All versions share one package-wide publication concurrency group. GitHub concurrency serializes running jobs; it does not guarantee FIFO ordering or retain every pending run. Redispatch an existing release if its pending run was superseded.

The consumer verifier retains its tested tarball outside the repository. Publication sends those exact bytes with lifecycle scripts disabled, avoiding a rebuild after validation. Both new publications and already-published reruns compare registry name, version, and SHA-512 integrity with that artifact before registry installation.

Registry verification requires npm's cryptographically verified provenance record for the exact package/version, in addition to successful signature auditing. Missing provenance is allowed only for an already-published bootstrap release whose tagged package.json explicitly sets publishConfig.provenance to false. Such a release cannot be newly published by this OIDC workflow. The exception never bypasses artifact integrity or registry signature verification.

## Documentation and breaking changes

Before merging a breaking change, include its migration instructions in the squash commit's `BREAKING CHANGE:` footer and link the migration guide. Below 1.0.0 the current configuration normally increments the minor version for a breaking change; review the generated release PR rather than promising a version in advance.

Review the generated changelog and packaged README in the release PR. A docs-only merge updates GitHub but does not itself refresh npm: npm receives the README with the next published package. Keep released changelog entries intact. Verify the published version, README, provenance, and matching immutable tag after publication.

## API documentation

The API reference deploys from `main` through `.github/workflows/docs.yml`. Configure Settings → Pages → Source as **GitHub Actions**. The docs build runs TypeDoc with isolated pinned TypeScript 6 while the project uses TypeScript 7. API docs on `main` can be ahead of the latest npm release; the npm version badge is not a source-version indicator.

## Automatic merging of release PRs

`.github/workflows/auto-merge-release.yml` merges eligible Release Please PRs after their complete CI workflow succeeds. It uses the existing `RELEASE_PLEASE_TOKEN` for `@mo-hawary` and that account's PR-only review bypass. No separate bot, approval credential, or self-approval is needed. GitHub still enforces required checks and the other protection rules.

The workflow executes only trusted code from `main`. It verifies the owner account, same-repository release branch, pending-release label, release title, and exact head SHA. Only the four generated release files are accepted: `CHANGELOG.md`, `package.json`, `package-lock.json`, and `.release-please-manifest.json`. Versions must increase consistently; package and lockfile changes must be version-only, and existing changelog history must remain intact. Source, dependency, script, and workflow changes cause validation to fail.

The existing token must belong to `@mo-hawary` and have repository Contents and Pull requests write access plus Actions read access. The workflow fails explicitly if the token is missing or belongs to another identity; it never falls back to `GITHUB_TOKEN`. It does not weaken repository protections. If a release PR already passed CI before this workflow reached `main`, manually dispatch **Auto-merge release PR**, or rerun its CI.

Merging a release PR continues the normal release pipeline: Release Please creates the tag and GitHub Release, which can trigger npm publication subject to the existing `npm` environment and publishing checks. To pause this automation, disable **Auto-merge release PR** in Actions. Unexpected diffs or failed checks leave the PR open for review.
