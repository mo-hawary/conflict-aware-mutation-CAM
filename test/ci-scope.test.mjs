import test from 'node:test'
import assert from 'node:assert/strict'
import { scope } from '../scripts/ci-scope.mjs'
const none = {runtimes:false,react:false,playground:false}
const all = {runtimes:true,react:true,playground:true}
test('documentation skips optional integration jobs', () => assert.deepEqual(scope(['README.md','docs/data-model.md']), none))
test('core and workflow changes run every integration', () => {
  for (const p of ['src/index.ts','.github/workflows/ci.yml','scripts/ci-scope.mjs']) assert.deepEqual(scope([p]), all)
})
test('example changes select their own integration', () => assert.deepEqual(scope(['examples/react/editor.tsx']), {...none,react:true}))
test('version-only release skips optional integrations but dependency changes do not', () => {
  const read = (side, path) => { const version = side === 'base' ? '0.2.0' : '0.2.1'; return JSON.stringify({version, ...(path === 'package-lock.json' ? {packages:{'':{version}}} : {})}) }
  assert.deepEqual(scope(['package.json','package-lock.json','CHANGELOG.md','.release-please-manifest.json'],read),none)
  assert.deepEqual(scope(['package.json'],side=>JSON.stringify({dependencies:{x:side}})),all)
})
test('unreadable package metadata fails conservatively', () => assert.deepEqual(scope(['package.json'],()=>{throw Error('missing')}),all))
