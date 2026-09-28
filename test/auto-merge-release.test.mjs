import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateRelease } from '../scripts/auto-merge-release.mjs'

function fixture() {
  const paths = ['.release-please-manifest.json', 'CHANGELOG.md', 'package-lock.json', 'package.json']
  const before = Object.fromEntries(paths.map(path => [path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')]))
  const after = structuredClone(before)
  const oldVersion = JSON.parse(before['package.json']).version
  const version = oldVersion.split('.').map((part, i) => i === 2 ? Number(part) + 1 : part).join('.')
  for (const path of paths.filter(path => path !== 'CHANGELOG.md')) {
    const value = JSON.parse(after[path])
    if (path === '.release-please-manifest.json') value['.'] = version
    else {
      value.version = version
      if (path === 'package-lock.json') value.packages[''].version = version
    }
    after[path] = JSON.stringify(value)
  }
  after['CHANGELOG.md'] = before['CHANGELOG.md'].replace('\n## ', `\n## [${version}](https://example.com)\n\nRelease notes\n\n## `)
  const pr = { user: { id: 94289366 }, head: { repo: { full_name: 'mo-hawary/conflict-aware-mutation-CAM' }, ref: 'release-please--branches--main--components--conflict-aware-mutation' }, base: { ref: 'main' }, state: 'open', draft: false, labels: [{ name: 'autorelease: pending' }], title: `chore(main): release ${version}` }
  return { pr, files: paths.map(filename => ({ filename, status: 'modified' })), before, after, version }
}
function check(f) { return validateRelease(f.pr, f.files, f.before, f.after) }

test('accepts consistent version-only changes and prepended release notes', () => {
  const f = fixture()
  assert.equal(check(f), f.version)
})
for (const [name, mutate] of Object.entries({
  'foreign author': f => { f.pr.user.id = 1 },
  'fork head': f => { f.pr.head.repo.full_name = 'other/repo' },
  'wrong branch': f => { f.pr.head.ref = 'feature' },
  'missing label': f => { f.pr.labels = [] },
  'source change': f => { f.files.push({ filename: 'src/index.ts', status: 'modified' }) },
  'renamed file': f => { f.files[0].status = 'renamed' },
  'package script change': f => { const p = JSON.parse(f.after['package.json']); p.scripts.build = 'malicious'; f.after['package.json'] = JSON.stringify(p) },
  'dependency integrity change': f => { const p = JSON.parse(f.after['package-lock.json']); p.packages['node_modules/injected'] = { version: '1.0.0' }; f.after['package-lock.json'] = JSON.stringify(p) },
  'inconsistent manifest': f => { f.after['.release-please-manifest.json'] = '{".":"9.0.0"}' },
  'unchanged version': f => { f.after['package.json'] = f.before['package.json'] },
  'rewritten history': f => { f.after['CHANGELOG.md'] += '\nrewritten' },
  'wrong title': f => { f.pr.title = 'chore: release something' },
})) {
  test(`rejects ${name}`, () => {
    const f = fixture(); mutate(f)
    assert.throws(() => check(f))
  })
}
