#!/usr/bin/env node
/**
 * Live smoke test against real GitHub, driven by the authenticated `gh` CLI.
 *
 * Unlike the other suites, this one is opt-in because it creates a real secret
 * gist on the authenticated account:
 *
 *   bash:        DSH_GIST_LIVE_TEST=1 node test/live.test.mjs
 *   PowerShell:  $env:DSH_GIST_LIVE_TEST='1'; node test/live.test.mjs
 *
 * It works entirely inside a throwaway DSH_HOME under the OS temp directory, so
 * no real profile is read or written, and it deletes the gist it created even
 * when an assertion fails.
 *
 * What it proves that the fake-gh suites cannot: `gh api` really accepts our
 * POST/PATCH/DELETE bodies, that a PATCH with a null file value deletes the
 * file, that content survives a real round trip byte for byte, and that a file
 * big enough for the API to truncate really does come back whole from the
 * `raw_url` it names.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as core from '../lib/core.js'

if (process.env.DSH_GIST_LIVE_TEST !== '1') {
  console.log('\nSKIP: set DSH_GIST_LIVE_TEST=1 to run the live GitHub suite (creates and deletes a gist).\n')
  process.exit(0)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-live-'))
const config = { dshHome: root }
const profileDir = path.join(root, 'profiles', 'verify')

await fs.mkdir(profileDir, { recursive: true })
const write = (name, text) => fs.writeFile(path.join(profileDir, name), text, 'utf8')
const read = (name) => fs.readFile(path.join(profileDir, name), 'utf8')
await write('cordis.patch.yml', '- id: verify\nvalue: 1\n')
await write('package.json', '{\n  "name": "verify"\n}\n')

const resolved = await core.resolveGh(config)
assert.ok(resolved.path, `gh not found: ${resolved.reason}`)
const ghPath = resolved.path
const auth = await core.checkAuth(ghPath)
assert.ok(auth.authenticated, 'gh must be authenticated to run the live suite')
console.log(`\ndsh-gist-settings live suite\n  gh:      ${resolved.version}`)
console.log(`  account: ${auth.account}`)
console.log(`  fixture: ${root}\n`)

const results = []
let gistId = null
let bigGistId = null

/**
 * Read the gist until `predicate` holds.
 *
 * A gist PATCH is not always immediately visible to the following GET, so a
 * single read makes this suite flaky for reasons that have nothing to do with
 * the plugin. Observed once in three runs before this retry was added.
 */
async function readGistUntil(predicate, { attempts = 12, delayMs = 500 } = {}) {
  let gist
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    gist = await core.gistGet(ghPath, gistId)
    if (predicate(gist)) return gist
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return gist
}

async function check(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`  \u001b[32mok\u001b[0m    ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}`)
    console.log(`        ${error.message.split('\n').join('\n        ')}`)
  }
}

try {
  let created
  await check('gist_upload creates a real secret gist', async () => {
    created = await core.uploadProfile('verify', { ghPath, config })
    gistId = created.gistId
    assert.equal(created.created, true)
    assert.match(created.gistUrl, /^https:\/\/gist\.github\.com\//)
  })

  await check('the real gist is secret and holds both files', async () => {
    const gist = await core.gistGet(ghPath, gistId)
    assert.deepEqual(Object.keys(gist.files).sort(), ['cordis.patch.yml', 'package.json'])
    const listed = await core.ghRun(ghPath, ['api', `/gists/${gistId}`, '--jq', '.public'])
    assert.equal(listed.stdout.trim(), 'false', 'gist must be secret')
  })

  await check('a real round trip preserves content byte for byte', async () => {
    const gist = await core.gistGet(ghPath, gistId)
    assert.equal(gist.files['cordis.patch.yml'], await read('cordis.patch.yml'))
    assert.equal(gist.files['package.json'], await read('package.json'))
  })

  await check('a local edit is reported as local-ahead', async () => {
    await write('cordis.patch.yml', '- id: verify\nvalue: 2\n')
    const status = await core.profileStatus('verify', { ghPath, config })
    assert.equal(status.status, 'local-ahead')
  })

  await check('gist_upload updates the same gist rather than creating another', async () => {
    const updated = await core.uploadProfile('verify', { ghPath, config })
    assert.equal(updated.created, false, 'expected an update, not a new gist')
    assert.equal(updated.gistId, gistId)
    const gist = await readGistUntil((g) => /value: 2/.test(g.files['cordis.patch.yml'] ?? ''))
    assert.match(gist.files['cordis.patch.yml'], /value: 2/)
  })

  await check('a PATCH with a null file value really deletes the remote file', async () => {
    await core.gistPatch(ghPath, gistId, { files: { 'stale.yml': 'temporary\n' } })
    const withStale = await readGistUntil((g) => 'stale.yml' in g.files)
    assert.ok('stale.yml' in withStale.files, 'setup failed: stale.yml was not added')

    const pruned = await core.uploadProfile('verify', { ghPath, config })
    assert.equal(pruned.created, false)
    const after = await readGistUntil((g) => !('stale.yml' in g.files))
    assert.equal('stale.yml' in after.files, false, 'stale.yml should have been pruned')
  })

  await check('a real download restores local files and backs up the old ones', async () => {
    await write('cordis.patch.yml', 'LOCAL GARBAGE\n')
    const result = await core.downloadProfile('verify', { ghPath, config, force: true })
    assert.match(await read('cordis.patch.yml'), /value: 2/)
    assert.ok(result.backupDir, 'expected a backup directory')
    const backedUp = await fs.readFile(path.join(result.backupDir, 'cordis.patch.yml'), 'utf8')
    assert.match(backedUp, /LOCAL GARBAGE/, 'backup should hold the pre-download content')
  })

  await check('a real divergence is detected and an unforced sync refuses', async () => {
    await write('cordis.patch.yml', 'LOCAL WINS?\n')
    await core.gistPatch(ghPath, gistId, { files: { 'cordis.patch.yml': 'REMOTE WINS?\n' } })
    const status = await core.profileStatus('verify', { ghPath, config })
    assert.equal(status.status, 'diverged')
    await assert.rejects(() => core.syncProfile('verify', { ghPath, config }), /diverged/)
  })

  await check('a forced sync resolves the divergence on the real remote', async () => {
    const result = await core.syncProfile('verify', { ghPath, config, force: true })
    assert.equal(result.action, 'forced-upload')
    const gist = await readGistUntil((g) => /LOCAL WINS\?/.test(g.files['cordis.patch.yml'] ?? ''))
    assert.match(gist.files['cordis.patch.yml'], /LOCAL WINS\?/)
  })

  await check('a following sync is a no-op', async () => {
    const gist = await core.gistGet(ghPath, gistId)
    const result = await core.syncProfile('verify', { ghPath, config })
    assert.equal(result.action, 'noop')
    assert.equal(result.gistUrl, gist.url)
  })

  await check('a file above the truncation threshold round-trips through raw_url', async () => {
    // The API truncates a file's `content` once it passes 1 MB and offers the rest
    // at `raw_url`. Only real GitHub can prove that fetching that URL — rather
    // than asking `gh api` for it — returns the whole file, so this case lives
    // here and not in the fake-gh suites.
    const body = `# big\n${'x'.repeat(1500 * 1024)}\n`
    const bigDir = path.join(root, 'profiles', 'big')
    await fs.mkdir(bigDir, { recursive: true })
    await fs.writeFile(path.join(bigDir, 'big.yml'), body, 'utf8')
    const bigConfig = { ...config, profileFiles: ['big.yml'] }

    const created = await core.uploadProfile('big', { ghPath, config: bigConfig })
    bigGistId = created.gistId
    assert.deepEqual(created.uploadedFiles, ['big.yml'])

    const gist = await core.gistGet(ghPath, bigGistId)
    assert.equal(
      gist.truncated.includes('big.yml'),
      true,
      'expected GitHub to truncate a 1.5 MB file; if this fails the API threshold has moved',
    )
    assert.equal(gist.files['big.yml'].length, body.length, 'the raw_url fetch must return the whole file')
    assert.equal(gist.files['big.yml'], body, 'and return it byte for byte')

    await fs.writeFile(path.join(bigDir, 'big.yml'), 'clobbered\n', 'utf8')
    await core.downloadProfile('big', { ghPath, config: bigConfig, force: true })
    assert.equal(await fs.readFile(path.join(bigDir, 'big.yml'), 'utf8'), body)
  })
} finally {
  for (const id of [gistId, bigGistId].filter(Boolean)) {
    try {
      await core.gistDelete(ghPath, id)
      console.log(`\n  cleaned up gist ${id}`)
    } catch (error) {
      console.log(`\n  WARNING: could not delete gist ${id}: ${error.message}`)
    }
  }
  await fs.rm(root, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1