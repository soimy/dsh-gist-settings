#!/usr/bin/env node
/**
 * The guarantees the README makes, pinned one by one.
 *
 * Every case here covers a promise that a plausible-looking implementation gets
 * wrong: that a tracked name cannot name a file outside the profile, that a
 * failed download leaves the profile exactly as it was, that `force` does what
 * its description says, that a profile whose directory was deleted outright is
 * still recoverable, that one sync converges, and that two host processes cannot
 * interleave their state writes.
 *
 * Run with: node test/safety.test.mjs
 */

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import * as core from '../lib/core.js'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-safety-'))
process.env.FAKE_GH_STORE = path.join(root, 'fake-store.json')

const fakeGh = [process.execPath, path.join(here, 'fake-gh.mjs')]
const config = { dshHome: root, ghPath: fakeGh }
const ghPath = config.ghPath

const profileDir = (name) => path.join(root, 'profiles', name)
const stateDir = path.join(root, 'gist-settings')
const lockPath = path.join(stateDir, 'state.lock')
const store = async () => {
  try {
    return JSON.parse(await fs.readFile(process.env.FAKE_GH_STORE, 'utf8'))
  } catch {
    // No store file yet: nothing has ever been created, which is itself a result
    // these tests assert on.
    return { seq: 0, gists: {} }
  }
}
const read = (name, file) => fs.readFile(path.join(profileDir(name), file), 'utf8')

async function seed(name, files) {
  const dir = profileDir(name)
  await fs.mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

/** A pid that certainly belonged to a process which has now exited. */
function deadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    child.on('exit', () => resolve(child.pid))
  })
}

/* ------------------------------------------------------------- mini runner -- */

const results = []
const skipped = []

/**
 * Run one case. Returning a string means "skipped, and here is why" rather than
 * passing: a case that quietly does nothing on the platform we happen to be on is
 * a case that has stopped testing anything.
 */
async function check(name, fn) {
  try {
    const reason = await fn()
    if (typeof reason === 'string') {
      skipped.push(name)
      console.log(`  \u001b[33mskip\u001b[0m  ${name} (${reason})`)
      return
    }
    results.push(true)
    console.log(`  \u001b[32mok\u001b[0m    ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}`)
    console.log(`        ${error.message.split('\n').join('\n        ')}`)
  }
}

console.log(`\ndsh-gist-settings safety tests\n  fixture: ${root}\n`)

/* ------------------------------------------------- tracked name validation -- */

await check('a tracked name that could leave the profile directory is refused', async () => {
  const refused = [
    '../outside.txt',
    'a/../../outside.txt',
    '/etc/passwd',
    'C:\\Windows\\notepad.exe',
    'C:relative.txt',
    '..',
    '.',
    'nested/..',
    'a//b.yml',
    'a/./b.yml',
    'a/',
    'a\u0000b.yml',
    'file:stream',
    'trailing.',
    'trailing ',
    '',
    42,
  ]
  for (const name of refused) {
    assert.throws(
      () => core.normalizeTrackedName(name),
      /invalid tracked file name/,
      `expected ${JSON.stringify(name)} to be refused`,
    )
  }

  assert.equal(core.normalizeTrackedName('cordis.patch.yml'), 'cordis.patch.yml')
  assert.equal(core.normalizeTrackedName('config/app.yml'), 'config/app.yml')
  assert.equal(
    core.normalizeTrackedName('config\\app.yml'),
    'config/app.yml',
    'one spelling has to survive every platform, or the gist key differs by OS',
  )
})

await check('profileFiles refuses a traversal entry and two spellings of one file', async () => {
  assert.throws(
    () => core.resolveProfileFiles({ profileFiles: ['../../outside.txt'] }),
    /invalid tracked file name/,
  )
  assert.throws(
    () => core.resolveProfileFiles({ profileFiles: ['a\\b.yml', 'a/b.yml'] }),
    /duplicate tracked file name/,
  )
  assert.deepEqual(core.resolveProfileFiles({ profileFiles: ['a\\b.yml'] }), ['a/b.yml'])
  assert.deepEqual(core.resolveProfileFiles({}), ['cordis.patch.yml', 'package.json'])
})

/* -------------------------------------------------- escape via profileFiles -- */

await check('a traversal in profileFiles cannot publish a file from outside the profile', async () => {
  const outside = path.join(root, 'outside-secret.txt')
  await fs.writeFile(outside, 'SHOULD-NOT-BE-PUBLISHED\n', 'utf8')
  await seed('escape', { 'cordis.patch.yml': 'ok\n' })

  const leaky = { ...config, profileFiles: ['cordis.patch.yml', '../../outside-secret.txt'] }
  await assert.rejects(() => core.collectProfile('escape', leaky), /invalid tracked file name/)
  await assert.rejects(
    () => core.uploadProfile('escape', { ghPath, config: leaky }),
    /invalid tracked file name/,
  )

  const published = Object.values((await store()).gists).flatMap((gist) => Object.values(gist.files))
  assert.equal(
    published.some((content) => content.includes('SHOULD-NOT-BE-PUBLISHED')),
    false,
    'the file outside the profile must never reach a gist',
  )
  assert.equal(await fs.readFile(outside, 'utf8'), 'SHOULD-NOT-BE-PUBLISHED\n')
})

/* ------------------------------------------------- escape via a link at rest -- */

await check('a tracked file under a junction cannot be read or written outside the profile', async () => {
  if (process.platform !== 'win32') return 'junctions are a Windows-only construct'
  const outside = path.join(root, 'outside-dir')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'credentials.txt'), 'SHOULD-NOT-LEAK\n', 'utf8')

  await seed('junction', { 'cordis.patch.yml': 'ok\n' })
  const link = path.join(profileDir('junction'), 'linked')
  try {
    await run('cmd', ['/c', 'mklink', '/J', link, outside])
  } catch {
    return 'this environment does not allow creating a junction'
  }

  const nested = { ...config, profileFiles: ['cordis.patch.yml', 'linked/credentials.txt'] }
  await assert.rejects(
    () => core.collectProfile('junction', nested),
    /resolves outside the profiles directory/,
  )
  await assert.rejects(
    () => core.uploadProfile('junction', { ghPath, config: nested }),
    /resolves outside/,
  )

  // The write direction too: the gist is given the escaping name directly, since
  // no upload could ever have produced it.
  const uploaded = await core.uploadProfile('junction', { ghPath, config })
  await core.gistPatch(ghPath, uploaded.gistId, {
    files: { 'linked/credentials.txt': 'OVERWRITTEN\n' },
  })
  await assert.rejects(
    () => core.downloadProfile('junction', { ghPath, config: nested, force: true }),
    /resolves outside the profiles directory/,
  )
  assert.equal(
    await fs.readFile(path.join(outside, 'credentials.txt'), 'utf8'),
    'SHOULD-NOT-LEAK\n',
    'a download must not reach through the junction',
  )
})

await check('a tracked file that is itself a link out of the profile is refused', async () => {
  const outside = path.join(root, 'outside-file.txt')
  await fs.writeFile(outside, 'SHOULD-NOT-LEAK\n', 'utf8')
  await seed('filelink', { 'cordis.patch.yml': 'ok\n' })
  try {
    await fs.symlink(outside, path.join(profileDir('filelink'), 'package.json'), 'file')
  } catch (error) {
    // Windows needs developer mode or elevation for a file symlink. The last
    // segment goes through the same realpath check the junction case above covers.
    return `creating a file symlink needs a privilege this environment does not grant (${error.code})`
  }

  await assert.rejects(
    () => core.collectProfile('filelink', config),
    /resolves outside the profiles directory/,
  )
  await assert.rejects(
    () => core.uploadProfile('filelink', { ghPath, config }),
    /resolves outside/,
  )
  assert.equal(await fs.readFile(outside, 'utf8'), 'SHOULD-NOT-LEAK\n')
})

await check('a nested tracked file is still supported end to end', async () => {
  await seed('nested', { 'config/app.yml': 'nested: 1\n' })
  const nested = { ...config, profileFiles: ['config/app.yml'] }

  const uploaded = await core.uploadProfile('nested', { ghPath, config: nested })
  assert.deepEqual(uploaded.uploadedFiles, ['config/app.yml'])
  const gist = await core.gistGet(ghPath, uploaded.gistId)
  assert.deepEqual(Object.keys(gist.files), ['config/app.yml'])

  await fs.writeFile(path.join(profileDir('nested'), 'config', 'app.yml'), 'nested: LOCAL\n', 'utf8')
  await core.downloadProfile('nested', { ghPath, config: nested, force: true })
  assert.equal(await read('nested', 'config/app.yml'), 'nested: 1\n')
  assert.equal((await core.profileStatus('nested', { ghPath, config: nested })).status, 'in-sync')
})

/* ---------------------------------------------------- transactional download -- */

await check('a download that fails part way leaves every file as it was', async () => {
  await seed('atomic', { 'a.yml': 'A1\n', 'sub/b.yml': 'B1\n' })
  const atomic = { ...config, profileFiles: ['a.yml', 'sub/b.yml'] }
  const uploaded = await core.uploadProfile('atomic', { ghPath, config: atomic })

  // A newer remote revision...
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'a.yml': 'A2\n' } })
  // ...and a local tree that cannot accept it: `sub` is now a regular file, so the
  // second rename must fail after the first has already succeeded.
  await fs.rm(path.join(profileDir('atomic'), 'sub'), { recursive: true })
  await fs.writeFile(path.join(profileDir('atomic'), 'sub'), 'not a directory\n', 'utf8')

  await assert.rejects(
    () => core.downloadProfile('atomic', { ghPath, config: atomic, force: true }),
    /put back exactly as it was/,
  )
  assert.equal(
    await read('atomic', 'a.yml'),
    'A1\n',
    'the file replaced before the failure must be rolled back, not left at the new revision',
  )
  assert.equal(await read('atomic', 'sub'), 'not a directory\n')

  const leftovers = (await fs.readdir(profileDir('atomic'))).filter((name) =>
    name.startsWith('.dsh-gist-settings-staging-'),
  )
  assert.deepEqual(leftovers, [], 'the staging directory must be cleaned up even when the commit fails')
})

await check('a download that fails on its first file changes nothing at all', async () => {
  await seed('atomic2', { 'a.yml': 'A1\n', 'sub/b.yml': 'B1\n' })
  const atomic = { ...config, profileFiles: ['sub/b.yml', 'a.yml'] }
  const uploaded = await core.uploadProfile('atomic2', { ghPath, config: atomic })

  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'a.yml': 'A2\n' } })
  await fs.rm(path.join(profileDir('atomic2'), 'sub'), { recursive: true })
  await fs.writeFile(path.join(profileDir('atomic2'), 'sub'), 'not a directory\n', 'utf8')

  await assert.rejects(
    () => core.downloadProfile('atomic2', { ghPath, config: atomic, force: true }),
    /put back exactly as it was/,
  )
  assert.equal(await read('atomic2', 'a.yml'), 'A1\n', 'a file staged but never renamed must be untouched')
})

/* ----------------------------------------------------------- forced deletion -- */

await check('gist_upload with force really deletes the tracked file it is missing locally', async () => {
  await seed('forceful', { 'cordis.patch.yml': 'keep\n', 'package.json': '{"name":"forceful"}\n' })
  const uploaded = await core.uploadProfile('forceful', { ghPath, config })

  await fs.rm(path.join(profileDir('forceful'), 'package.json'))
  await assert.rejects(
    () => core.uploadProfile('forceful', { ghPath, config }),
    /refusing to upload/,
    'without force the upload must refuse to discard the only remaining copy',
  )
  const before = await core.gistGet(ghPath, uploaded.gistId)
  assert.ok('package.json' in before.files, 'the refusal must not have deleted anything')

  const forced = await core.uploadProfile('forceful', { ghPath, config, force: true })
  assert.deepEqual(forced.dropped, ['package.json'])
  const after = await core.gistGet(ghPath, uploaded.gistId)
  assert.deepEqual(Object.keys(after.files), ['cordis.patch.yml'], 'force must actually remove it')
  assert.equal(
    (await core.profileStatus('forceful', { ghPath, config })).status,
    'in-sync',
    'the deletion has to leave the profile converged rather than permanently local-ahead',
  )
})

/* ------------------------------------------------------- bulk discovery ---- */

await check('a profile whose directory was deleted outright is still discovered and restored', async () => {
  await seed('gone', { 'cordis.patch.yml': 'gone: 1\n', 'package.json': '{"name":"gone"}\n' })
  await core.uploadProfile('gone', { ghPath, config })

  await fs.rm(profileDir('gone'), { recursive: true, force: true })
  assert.equal((await core.listProfiles(config)).includes('gone'), false, 'the directory really is gone')
  assert.ok((await core.listKnownProfiles(config)).includes('gone'), 'but the state file still knows it')

  const { profiles } = await core.statusAll({ ghPath, config })
  const row = profiles.find((entry) => entry.profile === 'gone')
  assert.ok(row, 'bulk status must still report a profile whose directory is gone')
  assert.equal(row.status, 'missing-local')

  const settled = (await core.syncAll({ ghPath, config })).find((entry) => entry.profile === 'gone')
  assert.ok(settled?.ok, `bulk sync must restore it: ${JSON.stringify(settled)}`)
  assert.equal(await read('gone', 'cordis.patch.yml'), 'gone: 1\n')
  assert.equal(await read('gone', 'package.json'), '{"name":"gone"}\n')
  assert.equal((await core.profileStatus('gone', { ghPath, config })).status, 'in-sync')
})

await check('bulk discovery invents nothing when there is neither a directory nor a record', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-empty-'))
  try {
    assert.deepEqual(await core.listKnownProfiles({ dshHome: empty, ghPath: fakeGh }), [])
  } finally {
    await fs.rm(empty, { recursive: true, force: true })
  }
})

/* ------------------------------------------------- deletion convergence ---- */

await check('one sync repairs a tracked file the gist dropped, instead of needing two', async () => {
  await seed('dropped', { 'cordis.patch.yml': 'd: 1\n', 'package.json': '{"name":"dropped"}\n' })
  const uploaded = await core.uploadProfile('dropped', { ghPath, config })

  // Delete package.json from the gist the way the web UI would.
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'package.json': null } })
  assert.equal((await core.profileStatus('dropped', { ghPath, config })).status, 'remote-ahead')

  const result = await core.syncProfile('dropped', { ghPath, config })
  assert.equal(result.action, 'restored')
  assert.deepEqual(result.republished, ['package.json'])
  assert.equal(
    await read('dropped', 'package.json'),
    '{"name":"dropped"}\n',
    'the only remaining copy must survive a remote deletion',
  )
  assert.equal(
    (await core.profileStatus('dropped', { ghPath, config })).status,
    'in-sync',
    'one sync must reach the state its policy implies',
  )
  const gist = await core.gistGet(ghPath, uploaded.gistId)
  assert.deepEqual(Object.keys(gist.files).sort(), ['cordis.patch.yml', 'package.json'])
  assert.equal((await core.syncProfile('dropped', { ghPath, config })).action, 'noop')
})

/* --------------------------------------------------- cross-process locking -- */

await check('two processes sharing a state directory cannot interleave their critical sections', async () => {
  const logPath = path.join(root, 'lock-order.log')
  const worker = path.join(here, 'lock-worker.mjs')
  const start = (tag) => run(process.execPath, [worker, logPath, tag, '250', root])

  await Promise.all([start('a'), start('b')])
  const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n')
  const first = lines[0].slice(0, 1)
  assert.deepEqual(
    lines,
    [`${first}:in`, `${first}:out`, `${first === 'a' ? 'b' : 'a'}:in`, `${first === 'a' ? 'b' : 'a'}:out`],
    `the two critical sections must not interleave; got ${lines.join(' ')}`,
  )
})

await check('a lock left behind by a dead process is reclaimed instead of blocking for the timeout', async () => {
  const pid = await deadPid()
  await fs.mkdir(stateDir, { recursive: true })
  await fs.writeFile(lockPath, `${pid} ${os.hostname()}\n`, 'utf8')

  const started = Date.now()
  let ran = false
  await core.withStateLock(async () => {
    ran = true
  }, config)
  assert.equal(ran, true, 'the critical section must actually run')
  assert.ok(Date.now() - started < 5000, 'a stale lock has to be reclaimed at once, not waited out')
  await assert.rejects(() => fs.access(lockPath), 'and released afterwards')
})

await check('the lock is released when the work throws, and a nested call is refused', async () => {
  await assert.rejects(
    () =>
      core.withStateLock(async () => {
        throw new Error('boom')
      }, config),
    /boom/,
  )
  await assert.rejects(() => fs.access(lockPath), 'the lock file must not survive a failed call')

  await assert.rejects(
    () => core.withStateLock(() => core.withStateLock(async () => {}, config), config),
    /not reentrant/,
  )
  await assert.rejects(() => fs.access(lockPath), 'the outer lock must still be released')
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
const skipNote = skipped.length ? `, ${skipped.length} skipped` : ''
console.log(`\n${results.length - failed}/${results.length} passed${skipNote}\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })