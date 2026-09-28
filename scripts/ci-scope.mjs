import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

export function scope(files, read) {
  const meaningful = files.filter(path => {
    if (path.endsWith('.md') || path === '.release-please-manifest.json') return false
    if (path !== 'package.json' && path !== 'package-lock.json') return true
    try {
      const a = JSON.parse(read('base', path)), b = JSON.parse(read('head', path))
      delete a.version; delete b.version
      if (path === 'package-lock.json') { delete a.packages[''].version; delete b.packages[''].version }
      return !isDeepStrictEqual(a, b)
    } catch { return true }
  })
  const shared = meaningful.some(p => /^(src\/|test\/runtime\/|package(?:-lock)?\.json$|tsconfig.*\.json$|scripts\/ci-scope\.mjs$|\.github\/workflows\/ci\.yml$)/.test(p))
  return {
    runtimes: shared,
    react: shared || meaningful.some(p => p.startsWith('examples/react/') || /^examples\/choose-sides\./.test(p)),
    playground: shared || meaningful.some(p => p.startsWith('examples/playground/')),
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result = { runtimes: true, react: true, playground: true }
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const base = process.env.PR_BASE_SHA, head = process.env.PR_HEAD_SHA
    for (const sha of [base, head]) if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Invalid commit SHA')
    const files = execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean)
    result = scope(files, (side, path) => execFileSync('git', ['show', `${side === 'base' ? base : head}:${path}`], { encoding: 'utf8' }))
  }
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k,v]) => `${k}=${v}\n`).join(''))
  console.log(result)
}
