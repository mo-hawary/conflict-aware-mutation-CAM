## Summary

<!-- What changes, and why? -->

## Contract impact

- [ ] No public API or merge-semantics change
- [ ] Public API/type change
- [ ] Merge/error-matching semantics change
- [ ] Breaking change

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run pack:check` when package surface changes
- [ ] Regression test added for bug fixes
- [ ] Relevant example behavior tests and documentation updated
- [ ] Migration guidance included for breaking changes

## Release note

The PR title must follow Conventional Commits because CAM uses squash merges and Release Please.

For a breaking change, include a `BREAKING CHANGE:` footer with migration instructions in the squash commit. Release Please generates the version and changelog; do not edit released entries.
