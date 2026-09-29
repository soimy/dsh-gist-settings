#!/usr/bin/env node
/**
 * Exercise the release-notes script, which is a release critical path.
 *
 * `scripts/release-notes.ts` decides what a published GitHub release says, and it
 * is the one script here that normally runs for the first time on a tag push — the
 * worst moment to discover it refuses a good tag, or accepts a bad one. So the
 * success path and every way it is meant to refuse are checked on every push
 * instead.
 *
 * Each case builds its own miniature package in a temporary directory: a
 * `package.json` and a `CHANGELOG.md`, because the script reads both.
 *
 * Run with: node test/release.test.ts  (also part of `npm test`)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'release-notes.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-release-'))

interface ReleaseOptions {
  version?: string
  changelog: string
}

interface ExecFailure {
  code?: number | string | null
  stdout?: string
  stderr?: string
}

/**
 * Run the script against a synthetic package and report everything it did.
 *
 * The distinction that matters is stdout versus stderr: the release job pipes
 * stdout into `notes.md`, so a refusal has to leave it empty or a failed run would
 * publish the error text as the release notes.
 */
async function release(tag: string, { version = '1.0.0', changelog }: ReleaseOptions) {
  const dir = await fs.mkdtemp(path.join(root, 'case-'))
  await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'x', version }, null, 2)}\n`)
  await fs.writeFile(path.join(dir, 'CHANGELOG.md'), changelog)
  const target = path.join(dir, 'scripts')
  await fs.mkdir(target, { recursive: true })
  await fs.copyFile(script, path.join(target, 'release-notes.ts'))
  try {
    const { stdout, stderr } = await run(process.execPath, ['scripts/release-notes.ts', tag], { cwd: dir })
    return { code: 0, stdout, stderr }
  } catch (error) {
    // `run` rejects with the failure object `execFile` builds for the child process.
    const failure = error as ExecFailure
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const WITH_LINKS = (sectionBody: string) => `# Changelog

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-01-02
${sectionBody}
[Unreleased]: https://example.test/compare/v1.0.0...HEAD
[1.0.0]: https://example.test/releases/tag/v1.0.0
`

/* ------------------------------------------------------------- mini runner -- */

const results: boolean[] = []
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push(true)
    console.log(`  \u001b[32mok\u001b[0m    ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}`)
    // A `catch` binding is `unknown`; every failure here is an `Error` (`assert` and the
    // runtime both throw them), so this cast names what is already true, and is erased.
    const failure = error as Error
    console.log(`        ${failure.message.split('\n').join('\n        ')}`)
  }
}

/* ------------------------------------------------------------------ cases -- */

await check('a matching tag prints the section body and nothing else', async () => {
  const result = await release('v1.0.0', {
    changelog: WITH_LINKS('\n### Added\n\n- A thing that happened.\n'),
  })
  assert.equal(result.code, 0, `expected success, got ${result.code}: ${result.stderr}`)
  assert.match(result.stdout, /A thing that happened\./)
  assert.doesNotMatch(result.stdout, /^## /m, 'the heading is the release title, not part of the body')
  assert.doesNotMatch(result.stdout, /example\.test/, 'link definitions are not release notes')
})

await check('an empty section is refused even when link definitions follow it', async () => {
  // The bypass this pins: extraction used to run to the end of the file when the
  // tagged version was the last section, so the link definitions made an otherwise
  // empty section look non-empty and were published as the release notes.
  const result = await release('v1.0.0', { changelog: WITH_LINKS('\n') })
  assert.equal(result.code, 1, 'an empty section must not produce a release')
  assert.equal(result.stdout, '', 'a refusal must leave stdout empty, or notes.md is not empty')
  assert.match(result.stderr, /empty/)
})

await check('a tag that disagrees with package.json is refused', async () => {
  const result = await release('v2.0.0', { changelog: WITH_LINKS('\n- Something.\n') })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /package\.json says 1\.0\.0/)
})

await check('a version with no changelog section is refused', async () => {
  const result = await release('v1.0.0', {
    changelog: '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n',
  })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /no dated/)
})

await check('a tag that is not vMAJOR.MINOR.PATCH is refused', async () => {
  for (const tag of ['1.0.0', 'v1.0', 'release-1.0.0', '']) {
    const result = await release(tag, { changelog: WITH_LINKS('\n- Something.\n') })
    assert.equal(result.code, 1, `${JSON.stringify(tag)} must be refused`)
    assert.equal(result.stdout, '')
  }
})

await check('a pre-release tag is refused rather than published as a release', async () => {
  const result = await release('v1.0.0-rc.1', { changelog: WITH_LINKS('\n- Something.\n') })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })