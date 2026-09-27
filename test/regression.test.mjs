#!/usr/bin/env node
/**
 * Regression tests for defects found in the adversarial review.
 *
 * Each case here is written to FAIL if its fix is reverted, which is the gap the
 * mutation audit found in the original suite: the happy path was well covered,
 * but the guards, the negative branches and the tool layer were not.
 *
 * Run with: node test/regression.test.mjs
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import * as core from '../lib/core.js'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-regress-'))
process.env.FAKE_GH_STORE = path.join(root, 'fake-store.json')

const fakeGh = [process.execPath, path.join(here, 'fake-gh.mjs')]
const config = { dshHome: root, ghPath: fakeGh }
const ghPath = config.ghPath

async function seed(name, files) {
  const dir = path.join(root, 'profiles', name)
  await fs.mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content, 'utf8')
  }
}

const profileDir = (name) => path.join(root, 'profiles', name)
const store = async () => JSON.parse(await fs.readFile(process.env.FAKE_GH_STORE, 'utf8'))
const freshEnv = () => {
  delete process.env.FAKE_GH_TRUNCATE
  delete process.env.FAKE_GH_RAW_BASE
  delete process.env.FAKE_GH_FAIL_GET
  delete process.env.FAKE_GH_FAIL_GET_ALL
  delete process.env.FAKE_GH_UNAUTHENTICATED
  delete process.env.FAKE_GH_LOGGED_OUT_OK
}

/* ------------------------------------------------------------- mini runner -- */

const results = []
async function check(name, fn) {
  freshEnv()
  try {
    await fn()
    results.push(true)
    console.log(`  \u001b[32mok\u001b[0m    ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}`)
    console.log(`        ${error.message.split('\n').join('\n        ')}`)
  } finally {
    freshEnv()
  }
}

console.log(`\ndsh-gist-settings regression tests\n  fixture: ${root}\n`)

/* ------------------------------------------------- the process-killing bug -- */

await check('ghRun survives a child that exits without draining a >64 KiB stdin body', async () => {
  // The real gh exits before consuming the request body when it fails early
  // (offline, bad host, expired token). Writing a body larger than the OS pipe
  // buffer then fails with EPIPE; without an error listener that is an uncaught
  // exception which kills the host process. A regression here takes this whole
  // test file down, which is the loudest possible failure.
  const stub = path.join(root, 'exit-early-gh.mjs')
  await fs.writeFile(stub, 'process.exit(1)\n', 'utf8')

  const res = await core.ghRun([process.execPath, stub], ['api', '--input', '-'], {
    input: 'x'.repeat(200_000),
  })
  assert.equal(typeof res.code, 'number', 'ghRun must resolve, never reject or crash')
  assert.notEqual(res.code, 0)
})

await check('ghRun reports a command it cannot spawn instead of rejecting', async () => {
  const res = await core.ghRun(path.join(root, 'definitely-not-here.cmd'), ['--version'])
  assert.equal(res.code, 127, 'an unspawnable command must resolve with a failure code')
  assert.match(res.stderr, /definitely-not-here\.cmd/)
})

/* ------------------------------------------- a transient failure is not 404 -- */

await check('checkAuth reports a logged-out CLI as unauthenticated', async () => {
  process.env.FAKE_GH_UNAUTHENTICATED = '1'
  const auth = await core.checkAuth(ghPath)
  assert.equal(auth.authenticated, false)
})

await check('a gh that exits 0 while logged out is still unauthenticated', async () => {
  // A real `gh auth status` says "You are not logged into any GitHub hosts" and
  // exits 0 when no host is configured. Reading the exit code alone would call
  // that ready, and every later call would fail with an authentication error.
  process.env.FAKE_GH_LOGGED_OUT_OK = '1'
  const auth = await core.checkAuth(ghPath)
  assert.equal(auth.authenticated, false, 'the message has to be read, not just the exit code')
  assert.match(auth.output, /not logged into any GitHub hosts/)
})

await check('an unreachable gist is not reported as deleted', async () => {
  await seed('gamma', { 'cordis.patch.yml': 'v1\n', 'package.json': '{}\n' })
  const up = await core.uploadProfile('gamma', { ghPath, config })

  process.env.FAKE_GH_FAIL_GET = up.gistId
  const status = await core.profileStatus('gamma', { ghPath, config })
  assert.equal(status.status, 'unreachable', 'a 500 must not read as a deleted gist')
  assert.match(status.error, /500/)
})

await check('an upload refuses to mint a replacement gist when the gist is unreachable', async () => {
  const before = await store()
  const gistId = before.gists[Object.keys(before.gists)[0]].id

  process.env.FAKE_GH_FAIL_GET = gistId
  await assert.rejects(
    () => core.uploadProfile('gamma', { ghPath, config }),
    /Refusing to create a replacement gist/,
  )
  freshEnv()

  const after = await store()
  assert.equal(
    Object.keys(after.gists).length,
    Object.keys(before.gists).length,
    'no new gist may be created',
  )
})

await check('sync refuses on an unreachable gist rather than recreating it', async () => {
  const before = await store()
  const gistId = before.gists[Object.keys(before.gists)[0]].id
  process.env.FAKE_GH_FAIL_GET = gistId
  await assert.rejects(() => core.syncProfile('gamma', { ghPath, config }), /Refusing to sync/)
})

/* ------------------------------------------------ pruning must not lose data -- */

await check('a tracked file missing locally is NOT deleted from the gist', async () => {
  const before = await store()
  const gistId = Object.keys(before.gists)[0]

  await fs.rm(path.join(profileDir('gamma'), 'package.json'))
  await assert.rejects(
    () => core.uploadProfile('gamma', { ghPath, config }),
    /only remaining copy/,
  )

  const after = await store()
  assert.ok('package.json' in after.gists[gistId].files, 'the gist copy must survive')
})

await check('a tracked file missing locally is reported as missing-local, not local-ahead', async () => {
  const status = await core.profileStatus('gamma', { ghPath, config })
  assert.equal(status.status, 'missing-local')
  assert.deepEqual(status.restorable, ['package.json'])
})

await check('sync restores a locally deleted tracked file without force', async () => {
  const result = await core.syncProfile('gamma', { ghPath, config })
  assert.equal(result.action, 'downloaded')
  assert.match(await fs.readFile(path.join(profileDir('gamma'), 'package.json'), 'utf8'), /\{\}/)
  const status = await core.profileStatus('gamma', { ghPath, config })
  assert.equal(status.status, 'in-sync')
})

await check('uploading still prunes files that are no longer TRACKED', async () => {
  const before = await store()
  const gistId = Object.keys(before.gists)[0]
  await core.gistPatch(ghPath, gistId, { files: { 'notes.md': 'added by hand\n' } })

  const result = await core.uploadProfile('gamma', { ghPath, config })
  assert.deepEqual(result.pruned, ['notes.md'])
  const after = await store()
  assert.equal('notes.md' in after.gists[gistId].files, false)
})

/* ------------------------------------------------------------- hashing gaps -- */

await check('hashFiles is pinned to a frozen value', async () => {
  // A golden value: every other hash assertion compared hashFiles to hashFiles,
  // so nothing pinned the framing itself.
  assert.equal(
    core.hashFiles({ 'a.yml': 'x' }),
    'f45f27fd509daa68a6fff4d43f74491b2b3765133874dcc8597c7a0c396cf68e',
  )
  assert.equal(
    core.hashFiles({}),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'the empty map must not collide with any real baseline',
  )
  assert.notEqual(core.hashFiles({ a: 'x' }), core.hashFiles({ a: 'y' }))
  assert.notEqual(core.hashFiles({ a: 'x', b: '' }), core.hashFiles({ a: 'x' }), 'file count must matter')
  assert.notEqual(core.hashFiles({ a: 'x', b: 'y' }), core.hashFiles({ a: 'xy' }), 'boundaries must matter')
  assert.equal(core.hashFiles({ a: 'x', b: 'y' }), core.hashFiles({ b: 'y', a: 'x' }), 'key order must not matter')
})

await check('editing the SECOND tracked file is detected, not just the first', async () => {
  await seed('delta', { 'cordis.patch.yml': 'aaa\n', 'package.json': 'bbb\n' })
  await core.uploadProfile('delta', { ghPath, config })

  // Only the alphabetically-later file changes. A hash that covered just the
  // first sorted entry would keep reporting in-sync here.
  await fs.writeFile(path.join(profileDir('delta'), 'package.json'), 'ccc\n', 'utf8')
  const status = await core.profileStatus('delta', { ghPath, config })
  assert.equal(status.status, 'local-ahead', 'a change to package.json must be visible')

  const result = await core.syncProfile('delta', { ghPath, config })
  assert.equal(result.action, 'uploaded')
  const gist = await core.gistGet(ghPath, result.gistId)
  assert.equal(gist.files['package.json'], 'ccc\n')
})

/* ---------------------------------------------------- truncation round trip -- */

await check('a truncated gist file is fetched whole from the raw_url the API named', async () => {
  await seed('epsilon', { 'cordis.patch.yml': 'abcdefghijklmnopqrstuvwxyz\n', 'package.json': '{}\n' })
  await core.uploadProfile('epsilon', { ghPath, config })
  const state = await core.loadState(config)
  const gistId = state.profiles.epsilon.gistId

  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  const calls = []
  // Injected rather than served by the double: the claim under test is that the
  // plugin asks the URL the API named, with `fetch`, and takes the whole body.
  // Asserting against a URL this suite also happens to serve would only prove the
  // double agrees with itself.
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    // `url` is part of the contract: the final URL is checked, so a response that
    // does not report one is refused rather than trusted.
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      text: async () => 'abcdefghijklmnopqrstuvwxyz\n',
    }
  }

  const gist = await core.gistGet(ghPath, gistId, { fetchImpl })
  assert.deepEqual(gist.truncated, ['cordis.patch.yml'])
  assert.equal(
    gist.files['cordis.patch.yml'],
    'abcdefghijklmnopqrstuvwxyz\n',
    'the raw_url fetch must return the whole file, not the 8-character prefix the API truncated to',
  )
  assert.equal(calls.length, 1, 'exactly one fetch, so the raw URL is not routed back through gh')
  assert.equal(calls[0].url, `https://gist.githubusercontent.com/testuser/${gistId}/raw/cordis.patch.yml`)
  assert.equal(calls[0].options.redirect, 'follow')
})

await check('a raw_url on a lookalike host is refused unfetched', async () => {
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  const state = await core.loadState(config)
  // The first is obviously foreign, and every variant of the check rejects it —
  // which is why it cannot be the only case. The rest are the ones a loosened
  // suffix test, or a check that validates a decoded string while handing the raw
  // one to fetch, would let through.
  const hosts = [
    'https://evil.example/collect',
    'https://evilgithubusercontent.com/collect',
    'https://githubusercontent.com.evil.example/collect',
    'https://gist.githubusercontent.com%2F@evil.example/collect',
  ]
  for (const host of hosts) {
    process.env.FAKE_GH_RAW_BASE = host
    let fetched = 0
    await assert.rejects(
      () =>
        core.gistGet(ghPath, state.profiles.epsilon.gistId, {
          fetchImpl: async () => {
            fetched += 1
            return { ok: true, status: 200, statusText: 'OK', text: async () => 'leaked' }
          },
        }),
      /not a trusted GitHub URL/,
      `${host} must not be followed`,
    )
    assert.equal(fetched, 0, `${host} must not be requested at all`)
  }
})

await check('a raw_url answering with an error status is reported, not silently truncated', async () => {
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  const state = await core.loadState(config)
  await assert.rejects(
    () =>
      core.gistGet(ghPath, state.profiles.epsilon.gistId, {
        fetchImpl: async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => '' }),
      }),
    /could not be fetched from .*HTTP 403 Forbidden/,
  )
})

/* ------------------------------------------------------ download containment -- */

await check('a download never writes a gist file that is not tracked', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.epsilon.gistId
  await core.gistPatch(ghPath, gistId, { files: { 'evil.js': 'process.exit(1)\n' } })

  await fs.rm(path.join(profileDir('epsilon'), 'cordis.patch.yml'))
  const result = await core.downloadProfile('epsilon', { ghPath, config })
  const onDisk = await fs.readdir(profileDir('epsilon'))
  assert.equal(onDisk.includes('evil.js'), false, 'an untracked gist file must not be written')
  assert.deepEqual(result.written, ['cordis.patch.yml', 'package.json'])
})

await check('a download writes every tracked file, not just the first', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.epsilon.gistId
  await core.gistPatch(ghPath, gistId, {
    files: { 'cordis.patch.yml': 'REMOTE-A\n', 'package.json': 'REMOTE-B\n' },
  })

  await core.downloadProfile('epsilon', { ghPath, config, force: true })
  assert.equal(await fs.readFile(path.join(profileDir('epsilon'), 'cordis.patch.yml'), 'utf8'), 'REMOTE-A\n')
  assert.equal(await fs.readFile(path.join(profileDir('epsilon'), 'package.json'), 'utf8'), 'REMOTE-B\n')
})

await check('a gist holding none of the tracked files names the way out', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.epsilon.gistId
  await core.gistPatch(ghPath, gistId, { files: { 'cordis.patch.yml': null, 'package.json': null } })
  await assert.rejects(() => core.downloadProfile('epsilon', { ghPath, config }), /gist_upload/)
})

/* --------------------------------------------------------------- state file -- */

await check('a state file with a non-object profiles section is rejected clearly', async () => {
  const target = path.join(root, 'gist-settings', 'state.json')
  const good = await fs.readFile(target, 'utf8')
  for (const bad of ['{"profiles":[]}', '{"profiles":null}', 'not json at all']) {
    await fs.writeFile(target, bad, 'utf8')
    await assert.rejects(() => core.loadState(config), /invalid "profiles"|not valid JSON/)
  }
  await fs.writeFile(target, good, 'utf8')
})

await check('a state file with a malformed gistId is rejected before it reaches gh', async () => {
  const target = path.join(root, 'gist-settings', 'state.json')
  const good = await fs.readFile(target, 'utf8')
  for (const bad of ['--help', '../../user', 'a/b']) {
    await fs.writeFile(
      target,
      JSON.stringify({ version: 1, profiles: { x: { gistId: bad } } }),
      'utf8',
    )
    await assert.rejects(() => core.loadState(config), /invalid gistId/)
  }
  await fs.writeFile(target, good, 'utf8')
})

await check('two concurrent uploads both survive in the state file', async () => {
  await seed('one', { 'cordis.patch.yml': 'one\n' })
  await seed('two', { 'cordis.patch.yml': 'two\n' })

  await Promise.all([
    core.uploadProfile('one', { ghPath, config }),
    core.uploadProfile('two', { ghPath, config }),
  ])

  const state = await core.loadState(config)
  assert.ok(state.profiles.one?.gistId, 'profile "one" lost its record to a concurrent write')
  assert.ok(state.profiles.two?.gistId, 'profile "two" lost its record to a concurrent write')
  assert.notEqual(state.profiles.one.gistId, state.profiles.two.gistId)
})

await check('a stale in-sync baseline is repaired instead of causing a false divergence', async () => {
  const target = path.join(root, 'gist-settings', 'state.json')
  const state = JSON.parse(await fs.readFile(target, 'utf8'))
  // Both sides already agree, but the recorded baseline describes an older revision.
  state.profiles.delta.lastSyncedHash = 'stale-baseline-value'
  await fs.writeFile(target, JSON.stringify(state, null, 2), 'utf8')

  const status = await core.profileStatus('delta', { ghPath, config })
  assert.equal(status.status, 'in-sync')

  const repaired = await core.loadState(config)
  assert.notEqual(repaired.profiles.delta.lastSyncedHash, 'stale-baseline-value')

  // With the baseline repaired, the next ordinary edit is a normal upload.
  await fs.writeFile(path.join(profileDir('delta'), 'package.json'), 'ddd\n', 'utf8')
  assert.equal((await core.profileStatus('delta', { ghPath, config })).status, 'local-ahead')
})

/* ----------------------------------------------- secret gists and file sets -- */

await check('every created gist is secret', async () => {
  const data = await store()
  const gists = Object.values(data.gists)
  assert.ok(gists.length > 0, 'expected at least one gist from earlier cases')
  for (const gist of gists) {
    assert.equal(gist.public, false, `gist ${gist.id} was created public`)
  }
})

await check('profileFiles config decides what is tracked', async () => {
  await seed('zeta', { 'cordis.patch.yml': 'z1\n', 'package.json': '{"name":"zeta"}\n' })
  const narrow = { ...config, profileFiles: ['package.json'] }
  const result = await core.uploadProfile('zeta', { ghPath, config: narrow })
  assert.deepEqual(result.uploadedFiles, ['package.json'])
  const gist = await core.gistGet(ghPath, result.gistId)
  assert.deepEqual(Object.keys(gist.files), ['package.json'])
})

/* ------------------------------------------------- case-insensitive aliasing -- */

await check('a name differing only in case cannot create a second gist', async () => {
  // Windows and macOS treat `CASECHECK` and `casecheck` as one directory, so
  // accepting both would back one profile up twice and let the copies diverge.
  await seed('casecheck', { 'cordis.patch.yml': 'c\n' })
  const before = Object.keys((await store()).gists).length

  const first = await core.uploadProfile('casecheck', { ghPath, config })
  assert.ok(first.gistId)

  await assert.rejects(
    () => core.uploadProfile('CASECHECK', { ghPath, config }),
    /differs only in case/,
  )
  await assert.rejects(
    () => core.downloadProfile('CASECHECK', { ghPath, config }),
    /differs only in case/,
  )

  const after = Object.keys((await store()).gists).length
  assert.equal(after, before + 1, 'exactly one gist may exist for the one directory')

  const state = await core.loadState(config)
  const variants = Object.keys(state.profiles).filter((key) => key.toLowerCase() === 'casecheck')
  assert.deepEqual(variants, ['casecheck'], 'only the exact name may be recorded')
})

await check('a profile tracked under one case stays readable under that exact name', async () => {
  const status = await core.profileStatus('casecheck', { ghPath, config })
  assert.equal(status.status, 'in-sync')
})

/* ------------------------------------------------------- gh discovery paths -- */

await check('health() still reports paths when gh cannot be found', async () => {
  const h = await core.health({ dshHome: root, ghPath: path.join(root, 'no-such-gh.exe') })
  assert.equal(h.gh.found, false)
  assert.equal(h.dshHome, root, 'paths must survive so status can still show what is tracked')
  assert.ok(h.statePath)
})

await check('resolveGh returns a reason rather than throwing for an unusable path', async () => {
  const resolved = await core.resolveGh({ ghPath: path.join(root, 'nope.exe') })
  assert.equal(resolved.path, null)
  assert.match(resolved.reason, /does not exist/)
})

/* ----------------------------------------------------- directory containment -- */

await check('a junction under profiles/ cannot escape the profiles directory', async () => {
  if (process.platform !== 'win32') return
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'package.json'), '{"token":"SHOULD-NOT-LEAK"}\n', 'utf8')

  const link = path.join(root, 'profiles', 'linked')
  try {
    await run('cmd', ['/c', 'mklink', '/J', link, outside])
  } catch {
    return // junctions unavailable in this environment; nothing to assert
  }

  await assert.rejects(
    () => core.collectProfile('linked', config),
    /resolves outside the profiles directory/,
  )
  await assert.rejects(() => core.uploadProfile('linked', { ghPath, config }), /resolves outside/)
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })