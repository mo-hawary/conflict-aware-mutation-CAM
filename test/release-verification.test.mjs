import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { verifyMetadata, verifyProvenance } from "../scripts/verify-registry.mjs"

const expected = { name: "conflict-aware-mutation", version: "0.1.1", integrity: "sha512-YWJj" }
const config = { ...expected, publishConfig: { provenance: true } }
const record = { name: expected.name, version: expected.version, registry: "https://registry.npmjs.org/", attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } }
const audit = { invalid: [], missing: [], verified: [record] }

test("registry must contain the exact tested artifact, including on reruns", () => {
  verifyMetadata(expected, { ...expected, dist: { integrity: expected.integrity } })
  for (const change of [{ name: "other" }, { version: "0.1.2" }, { dist: { integrity: "sha512-ZGVm" } }, { dist: {} }]) {
    assert.throws(() => verifyMetadata(expected, { ...expected, dist: { integrity: expected.integrity }, ...change }))
  }
})

test("signed package without matching verified provenance fails", () => {
  verifyProvenance(expected, audit, config)
  for (const verified of [[], [{ ...record, version: "0.1.0" }], [{ ...record, name: "other" }], [{ ...record, attestations: {} }]]) {
    assert.throws(() => verifyProvenance(expected, { ...audit, verified }, config))
  }
  assert.throws(() => verifyProvenance(expected, { ...audit, invalid: [{}] }, config))
})

test("explicit bootstrap exemption still requires valid registry signatures", () => {
  const bootstrap = { ...config, publishConfig: { provenance: false } }
  verifyProvenance(expected, { ...audit, verified: [] }, bootstrap)
  assert.throws(() => verifyProvenance(expected, { ...audit, missing: [{}] }, bootstrap))
  assert.throws(() => verifyProvenance(expected, { ...audit, verified: [] }, { ...config, publishConfig: {} }))
})

test("all release versions share the publication lock and publish the retained tarball", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8")
  assert.match(workflow, /group: npm-publish-conflict-aware-mutation\n/)
  assert.match(workflow, /npm publish "\$RUNNER_TEMP\/cam-release\/package.tgz" --ignore-scripts/)
})
