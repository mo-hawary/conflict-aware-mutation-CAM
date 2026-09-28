import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const repository = 'mo-hawary/conflict-aware-mutation-CAM'
const ownerId = 94289366
const branch = 'release-please--branches--main--components--conflict-aware-mutation'
const paths = ['.release-please-manifest.json', 'CHANGELOG.md', 'package-lock.json', 'package.json']

export function validateRelease(pr, files, before, after) {
  assert.equal(pr.user.id, ownerId)
  assert.equal(pr.head.repo.full_name, repository)
  assert.equal(pr.head.ref, branch)
  assert.equal(pr.base.ref, 'main')
  assert.equal(pr.state, 'open')
  assert.equal(pr.draft, false)
  assert(pr.labels.some(label => label.name === 'autorelease: pending'))
  assert.deepEqual(files.map(file => file.filename).sort(), paths)
  assert(files.every(file => file.status === 'modified'))
  const oldPackage = JSON.parse(before['package.json'])
  const newPackage = JSON.parse(after['package.json'])
  const version = newPackage.version
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  assert(semver.test(version) && semver.test(oldPackage.version))
  const oldParts = oldPackage.version.split('.').map(BigInt)
  const newParts = version.split('.').map(BigInt)
  const first = newParts.findIndex((part, i) => part !== oldParts[i])
  assert(first >= 0 && newParts[first] > oldParts[first])
  assert.equal(pr.title, `chore(main): release ${version}`)
  for (const path of paths.filter(path => path !== 'CHANGELOG.md')) {
    const expected = JSON.parse(before[path])
    const actual = JSON.parse(after[path])
    if (path === '.release-please-manifest.json') {
      assert.equal(expected['.'], oldPackage.version)
      expected['.'] = version
    } else {
      assert.equal(expected.version, oldPackage.version)
      expected.version = version
      if (path === 'package-lock.json') {
        assert.equal(expected.packages[''].version, oldPackage.version)
        expected.packages[''].version = version
      }
    }
    assert.deepEqual(actual, expected, `Unexpected changes in ${path}`)
  }
  const oldLog = before['CHANGELOG.md']
  const split = oldLog.indexOf('\n## ')
  assert(split >= 0)
  const prefix = oldLog.slice(0, split)
  const history = oldLog.slice(split)
  const newLog = after['CHANGELOG.md']
  assert(newLog.startsWith(prefix + `\n## [${version}](`))
  assert(newLog.endsWith(history), 'Existing changelog history must be preserved')
  assert(newLog.length > oldLog.length)
  return version
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, repository)
  const token = process.env.RELEASE_PLEASE_TOKEN
  assert(token, 'RELEASE_PLEASE_TOKEN is required; the built-in token cannot use the owner review bypass')
  async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`)
    return response.json()
  }
  assert.equal((await api('/user')).id, ownerId, 'Release token must belong to the configured review-bypass owner')
  const root = `/repos/${repository}`
  const prs = await api(`${root}/pulls?state=open&base=main&head=mo-hawary:${branch}&per_page=100`)
  for (const candidate of prs) {
    const pr = await api(`${root}/pulls/${candidate.number}`)
    const runs = await api(`${root}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`)
    const latest = runs.workflow_runs.sort((a, b) => b.id - a.id)[0]
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
      console.log(`PR #${pr.number}: waiting for successful CI at ${pr.head.sha}`)
      continue
    }
    const files = await api(`${root}/pulls/${pr.number}/files?per_page=100`)
    // A fifth changed file or pagination cannot pass the exact four-file guard.
    assert.equal(pr.changed_files, 4)
    const before = {}, after = {}
    for (const path of paths) {
      for (const [ref, target] of [[pr.base.sha, before], [pr.head.sha, after]]) {
        const file = await api(`${root}/contents/${path}?ref=${ref}`)
        assert.equal(file.encoding, 'base64')
        assert.equal(file.type, 'file')
        target[path] = Buffer.from(file.content, 'base64').toString('utf8')
      }
    }
    validateRelease(pr, files, before, after)
    const current = await api(`${root}/pulls/${pr.number}`)
    assert.equal(current.head.sha, pr.head.sha, 'PR changed during validation')
    assert.equal(current.base.sha, pr.base.sha, 'Base changed during validation')
    validateRelease(current, files, before, after)
    // GitHub enforces strict required checks and all non-bypassed rules atomically.
    const result = await api(`${root}/pulls/${pr.number}/merge`, 'PUT', {
      sha: pr.head.sha, merge_method: 'squash', commit_title: `${pr.title} (#${pr.number})`,
    })
    assert.equal(result.merged, true)
    console.log(`Merged release PR #${pr.number}: ${result.sha}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
