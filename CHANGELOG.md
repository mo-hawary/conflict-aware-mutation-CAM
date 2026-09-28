# Changelog

Release Please maintains the versioned entries below. Source on `main` may be ahead of the latest release. See the [migration guide](./docs/migration.md) for the validation/error changes following 0.1.x and [RELEASING.md](./RELEASING.md) for versioning policy.

## [0.2.2](https://github.com/mo-hawary/conflict-aware-mutation-CAM/compare/v0.2.1...v0.2.2) (2026-09-28)


### Features

* add safer integration recovery APIs ([#35](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/35)) ([fbc6a0a](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/fbc6a0a838773b596e9b4cc5438b0f2570537e3e))

## [0.2.1](https://github.com/mo-hawary/conflict-aware-mutation-CAM/compare/v0.2.0...v0.2.1) (2026-09-28)


### Bug Fixes

* address merge and React concurrency regressions ([#32](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/32)) ([37d4c78](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/37d4c78fb041aa4b7d510da94acff6074a35cd2d))

## [0.2.0](https://github.com/mo-hawary/conflict-aware-mutation-CAM/compare/v0.1.2...v0.2.0) (2026-09-27)


### ⚠ BREAKING CHANGES

* CAMConfigError extends Error instead of TypeError. Catch CAMConfigError or use code CAM_CONFIG_ERROR. Enumerable object accessors, array-index accessors, Array subclasses, sparse arrays, non-enumerable array indices and extra enumerable non-index array properties are rejected. Non-enumerable object properties and non-enumerable extra array properties are ignored. See docs/migration.md.

### Bug Fixes

* harden merge validation, speed up mergeStates, and expand docs, examples, and CI ([#30](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/30)) ([168bf8c](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/168bf8c1e87ca9a585ad75365dfcb958224d988b))

## [0.1.2](https://github.com/mo-hawary/conflict-aware-mutation-CAM/compare/v0.1.1...v0.1.2) (2026-09-27)


### Bug Fixes

* **npm:** correct the public package summary ([#17](https://github.com/mo-hawary/conflict-aware-mutation-CAM/issues/17)) ([629601e](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/629601e69ac7262cb9789e83c608f315bcf273f7))

## [0.1.1](https://github.com/mo-hawary/conflict-aware-mutation-CAM/compare/v0.1.0...v0.1.1) (2026-09-27)


### Bug Fixes

* keep package verification cross-platform ([cd0ade4](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/cd0ade494c2a76740b1e7f4e2f68723f182ce5c4))
* prepare CAM for npm launch ([7cc9245](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/7cc9245c05bd06aeb86f1718293a7f865a44c485))
* prepare npm launch ([68b74c4](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/68b74c4b4d7542e3a8df8457d8ba113675118ad4))
* restore prerelease version until Release Please can tag ([5a96faf](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/5a96faf23680bf00dc2e10322afef51207fef66e))
* verify published artifact identity and serialize npm releases ([3765f96](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/3765f96ba7b0468ebdde3b9f4d2b61b55b1c6a73))

## 0.1.0 (2026-09-26)


### Features

* add CAMConfigError ([4ee9ea5](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/4ee9ea5bd8d45158bfbd3e7481722fc7dde7680a))
* add runtime validation helpers ([d730d72](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/d730d72f30141ea978a28ea39574f5695accbca9))
* add three-way merge engine ([9232847](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/9232847059acd7c5c78d998a1cfc996284e844ba))
* export mergeStates ([3607682](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/36076821d25a3187842f978049b87f1aa837668f))
* export validation and error matching APIs ([70d708d](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/70d708d242cf9d32385b39502055858d2babe675))
* implement exact conflict error matching ([cfe20df](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/cfe20dfbd3c53a6f6c7ba14068678f467efda93e))
* implement three-way merge engine ([023ec91](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/023ec91bee9d1763168a8e529bf0fc0cd77caafd))
* model merge conflicts and flexible state snapshots ([ff3449c](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/ff3449c755f0f5abc1e62af0f9c3e38f82fcafa2))


### Bug Fixes

* harden runtime validation ([cb67b70](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/cb67b7024e707f0f32b9b96bebea13505cd46aa9))
* keep validation helpers internal ([5c648df](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/5c648dffae461a08d16c2da8e7904c8ccdbb576d))
* match error signals on validated own properties only ([9b516ef](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/9b516ef5ce995b93d41e9266b3f18b7a22d58108))
* normalize merge equality and output ordering ([1838b1b](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/1838b1ba0177c5f6d975f37d3ddfd9bb6d43da1b))
* restore generic merge result contract ([a0d79ef](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/a0d79ef342c62803931dc8b588de80adf793a2ce))
* return fresh unmatched error objects ([2fffd8d](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/2fffd8da93845e9249bc0154f7bb8e91e1752e9f))
* satisfy strict indexed access in merge engine ([761db83](https://github.com/mo-hawary/conflict-aware-mutation-CAM/commit/761db834ac24b3716b5b894df2cd1c6226970be9))
