# Contributing to CAM

Thanks for improving CAM. Keep changes small, deterministic, and focused on the conflict-aware mutation contract.

## Development

CAM supports maintained Node.js LTS releases starting at Node 22.

```bash
npm ci
npm run typecheck
npm test
npm run pack:check
```

Every bug fix must include a regression test. Changes to merge semantics must cover the relevant three-way cases explicitly.

## Pull requests

- Keep one concern per PR.
- Preserve the small, headless public API.
- Do not add framework, DOM, networking, or UI dependencies to the core.
- Update documentation when observable behavior or public types change.
- Do not manually bump the package version, create normal release tags, or hand-edit generated changelog entries.

### PR title format

CAM uses squash merges, so the PR title becomes release history. Titles must follow Conventional Commits:

```text
feat: add a compatible capability
fix: correct merge behavior
perf: reduce merge allocation
docs: clarify conflict semantics
refactor: simplify traversal without changing behavior
test: extend regression coverage
ci: harden verification
chore: repository maintenance
feat!: make a breaking API change
```

Optional scopes are allowed, for example `fix(validation): reject inherited fields`.

Before v1.0.0, compatible `feat` changes bump the patch version and breaking changes bump the minor version. After v1.0.0, normal SemVer rules apply.

## Releases

Release Please owns:

- `package.json` version changes
- `.release-please-manifest.json`
- `CHANGELOG.md` release entries
- `vX.Y.Z` Git tags
- GitHub Releases

See [RELEASING.md](./RELEASING.md) for the complete release flow.

## API documentation deployment

The API docs workflow builds on pull requests and deploys from `main`. In repository Settings → Pages → Build and deployment, the source must be **GitHub Actions**. This repository setting is not available through the checks performed for this PR, so confirm it manually before relying on the first Pages deployment.
