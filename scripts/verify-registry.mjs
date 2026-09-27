import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function verifyMetadata(expected, registry) {
  assert.equal(registry.name, expected.name, "Registry package name differs")
  assert.equal(registry.version, expected.version, "Registry version differs")
  assert.match(expected.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, "Missing SHA-512 artifact integrity")
  assert.equal(registry.dist?.integrity, expected.integrity, "Registry artifact differs from tested tarball")
}

export function verifyProvenance(expected, audit, config) {
  assert.deepEqual(audit.invalid, [], "Invalid registry signatures or attestations")
  assert.deepEqual(audit.missing, [], "Missing registry signatures")
  assert.equal(config.name, expected.name)
  assert.equal(config.version, expected.version)
  // Only the explicit policy in the immutable bootstrap tag permits absence.
  if (config.publishConfig?.provenance === false) return
  const verified = audit.verified?.find(item =>
    item.name === expected.name && item.version === expected.version &&
    item.registry === "https://registry.npmjs.org/" &&
    item.attestations?.provenance?.predicateType === "https://slsa.dev/provenance/v1")
  assert(verified, "Expected cryptographically verified npm provenance is missing")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, configPath] = process.argv.slice(2)
  const read = file => JSON.parse(readFileSync(file, "utf8"))
  const expected = read(path.join(directory, "package.json"))
  if (mode === "metadata") verifyMetadata(expected, read(path.join(directory, "registry.json")))
  else if (mode === "provenance") verifyProvenance(expected, read(path.join(directory, "audit.json")), read(configPath))
  else throw Error("Expected metadata or provenance verification mode")
}
