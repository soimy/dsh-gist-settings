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
import { execFile, execFileSync, spawn } from 'node:child_process'
import fsSync from 'node:fs'
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
  } catch (error) {
    // Only "no store yet" is a valid empty answer. Swallowing every error would let
    // a "nothing leaked" assertion pass with no evidence behind it at all.
    if (error.code === 'ENOENT') return { seq: 0, gists: {} }
    throw error
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
    // Anything with a separator, which is what every traversal needs. GitHub
    // answers a gist filename containing a slash with HTTP 422 (the live suite
    // pins that), so a separator cannot be the gist's key either way.
    '../outside.txt',
    'a/../../outside.txt',
    '/etc/passwd',
    'C:\\Windows\\notepad.exe',
    'nested/..',
    'a//b.yml',
    'a/./b.yml',
    'a/',
    'config/app.yml',
    'config\\app.yml',
    // And the names that are dangerous or rejected without any separator.
    '..',
    '.',
    'C:relative.txt',
    'a\u0000b.yml',
    'file:stream',
    // Reserved for devices on Windows, with or without an extension.
    'NUL',
    'nul.txt',
    'COM1.yml',
    'aux',
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
  assert.equal(core.normalizeTrackedName('my file.yml'), 'my file.yml')
  assert.throws(
    () => core.normalizeTrackedName('config/app.yml'),
    /a gist cannot hold a directory/,
    'the reason has to name the real constraint, not a generic invalidity',
  )
})

await check('profileFiles refuses a traversal entry and two spellings of one file', async () => {
  assert.throws(
    () => core.resolveProfileFiles({ profileFiles: ['../../outside.txt'] }),
    /invalid tracked file name/,
  )
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.throws(
      () => core.resolveProfileFiles({ profileFiles: ['a.yml', 'A.yml'] }),
      /duplicate tracked file name/,
    )
  }
  assert.deepEqual(core.resolveProfileFiles({ profileFiles: ['a.yml'] }), ['a.yml'])
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

await check('a tracked entry that is a junction out of the profile cannot be read or written', async () => {
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

  // The tracked name is a single segment, and that segment is the junction.
  const linked = { ...config, profileFiles: ['cordis.patch.yml', 'linked'] }
  await assert.rejects(
    () => core.collectProfile('junction', linked),
    /resolves outside the profile directory/,
  )
  await assert.rejects(
    () => core.uploadProfile('junction', { ghPath, config: linked }),
    /resolves outside/,
  )

  // The write direction too: a gist file claiming that name must not be written
  // through the link.
  const uploaded = await core.uploadProfile('junction', { ghPath, config })
  await core.gistPatch(ghPath, uploaded.gistId, { files: { linked: 'OVERWRITTEN\n' } })
  await assert.rejects(
    () => core.downloadProfile('junction', { ghPath, config: linked, force: true }),
    /resolves outside the profile directory/,
  )
  assert.equal(
    await fs.readFile(path.join(outside, 'credentials.txt'), 'utf8'),
    'SHOULD-NOT-LEAK\n',
    'a download must not reach through the junction',
  )
})

await check('a tracked entry that IS the link out of the profile is refused', async () => {
  // The last path component gets its own case: the junction above links an
  // *intermediate* segment, so an off-by-one that left the final component
  // unchecked would slip past it. A junction cannot point at a file, so where a
  // file symlink needs a privilege this environment does not grant, the same check
  // is exercised with a junction that points at a directory.
  const outsideFile = path.join(root, 'outside-file.txt')
  const outsideDir = path.join(root, 'outside-final')
  await fs.writeFile(outsideFile, 'SHOULD-NOT-LEAK\n', 'utf8')
  await fs.mkdir(outsideDir, { recursive: true })
  await fs.writeFile(path.join(outsideDir, 'credentials.txt'), 'SHOULD-NOT-LEAK\n', 'utf8')

  await seed('filelink', { 'cordis.patch.yml': 'ok\n' })
  const esc = path.join(profileDir('filelink'), 'esc')
  // `esc` is the tracked name in both branches: a symlink to a file, or a
  // junction to a directory. Tracking a name that does not exist would resolve
  // without throwing and the case would fail for the wrong reason.
  const tracked = 'esc'
  try {
    await fs.symlink(outsideFile, esc, 'file')
  } catch {
    try {
      await run('cmd', ['/c', 'mklink', '/J', esc, outsideDir])
    } catch {
      return 'this environment allows neither a file symlink nor a junction'
    }
  }

  const linky = { ...config, profileFiles: ['cordis.patch.yml', tracked] }
  await assert.rejects(
    () => core.collectProfile('filelink', linky),
    /resolves outside the profile directory/,
  )
  await assert.rejects(() => core.uploadProfile('filelink', { ghPath, config: linky }), /resolves outside/)
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'SHOULD-NOT-LEAK\n')
})

/* ---------------------------------------------------- transactional download -- */

await check('a failed commit restores what it wrote and leaves an external edit alone', async () => {
  // Three behaviours in one commit: `a.yml` is replaced by this download and then
  // rewritten by someone else, `f000.yml` is replaced and left alone, and `c.yml`
  // becomes a directory so the commit fails after both. The rollback has to put
  // `f000.yml` back, leave the editor's `a.yml` alone, and say so.
  const bulkNames = ['a.yml', ...Array.from({ length: 300 }, (_, index) => `f${String(index).padStart(3, '0')}.yml`), 'c.yml']
  const bulk = { ...config, profileFiles: bulkNames }
  const before = Object.fromEntries(bulkNames.map((name) => [name, `${name}: old\n`]))
  await seed('rollback', before)
  const uploaded = await core.uploadProfile('rollback', { ghPath, config: bulk })
  await core.gistPatch(ghPath, uploaded.gistId, {
    files: Object.fromEntries(bulkNames.map((name) => [name, `${name}: new\n`])),
  })

  // The extra files give the poller a wide window: it triggers on staging, then
  // waits for `a.yml` to hold the new revision — which only happens once the
  // commit has renamed it — before overwriting it.
  const dir = profileDir('rollback')
  let armed = false
  let edited = false
  const poller = setInterval(() => {
    if (edited) return
    try {
      if (!armed) {
        if (!fsSync.readdirSync(dir).some((name) => name.startsWith('.dsh-gist-settings-staging-'))) return
        fsSync.rmSync(path.join(dir, 'c.yml'), { recursive: true, force: true })
        fsSync.mkdirSync(path.join(dir, 'c.yml'))
        armed = true
        return
      }
      if (fsSync.readFileSync(path.join(dir, 'a.yml'), 'utf8') === 'a.yml: new\n') {
        fsSync.writeFileSync(path.join(dir, 'a.yml'), 'a.yml: EDITOR\n')
        edited = true
      }
    } catch {
      // The staging directory or the file may not exist yet; try again next tick.
    }
  }, 1)

  let error = null
  try {
    await core.downloadProfile('rollback', { ghPath, config: bulk, force: true }).catch((thrown) => {
      error = thrown
    })
  } finally {
    clearInterval(poller)
  }

  assert.ok(error, 'the commit must have failed')
  assert.match(error.message, /changed after this download wrote them/)
  assert.match(error.message, /a\.yml/)
  assert.equal(
    await read('rollback', 'a.yml'),
    'a.yml: EDITOR\n',
    'a revision written by someone else after this download is not ours to undo',
  )
  if (!edited) return 'the external edit did not land on this run, so nothing was exercised'
  assert.equal(await read('rollback', 'f000.yml'), 'f000.yml: old\n', 'our own write must be rolled back')

  const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith('.dsh-gist-settings-staging-'))
  assert.deepEqual(leftovers, [], 'the staging directory must be cleaned up even when the commit fails')
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

await check('a lock written by another machine is not judged by this machine’s pid rules', async () => {
  const pid = await deadPid()
  await fs.mkdir(stateDir, { recursive: true })
  // A pid that is gone, but from a host we cannot ask about. The pid means nothing
  // here, so the lock has to be judged by age instead — reclaiming it on sight
  // would steal a lock from a live process on another machine.
  await fs.writeFile(lockPath, `${pid} another-machine\n`, 'utf8')

  const pending = core.withStateLock(async () => 'took it', config)
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('waited'), 1200)),
  ])
  assert.equal(outcome, 'waited', 'a fresh foreign lock must not be reclaimed')

  await fs.rm(lockPath, { force: true })
  assert.equal(await pending, 'took it', 'and the waiter must proceed once the lock is gone')
})

await check('releasing a lock does not delete one another writer now owns', async () => {
  await fs.mkdir(stateDir, { recursive: true })
  await core.withStateLock(async () => {
    // The lock was reclaimed and re-taken by someone else while this call worked.
    await fs.writeFile(lockPath, '999999 another-machine\n', 'utf8')
  }, config)

  await assert.doesNotReject(
    () => fs.access(lockPath),
    'the release must not remove a lock file that is no longer ours',
  )
  await fs.rm(lockPath, { force: true })
})

await check('two waiters racing one stale lock cannot both enter the critical section', async () => {
  const pid = await deadPid()
  await fs.mkdir(stateDir, { recursive: true })
  const logPath = path.join(root, 'stale-race.log')
  // One stale lock, three waiters arriving together. Reclaiming by deleting the
  // path lets two of them both decide the lock is free, and the second delete
  // removes the first one's fresh lock — after which both are inside.
  await fs.writeFile(lockPath, `${pid} ${os.hostname()}\n`, 'utf8')

  const worker = path.join(here, 'lock-worker.mjs')
  const start = (tag) => run(process.execPath, [worker, logPath, tag, '200', root])
  await Promise.all([start('a'), start('b'), start('c')])

  const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 6, `every worker must have run: ${lines.join(' ')}`)
  for (let index = 0; index < lines.length; index += 2) {
    const [tag, phase] = lines[index].split(':')
    assert.equal(phase, 'in', `unexpected log line: ${lines.join(' ')}`)
    assert.equal(
      lines[index + 1],
      `${tag}:out`,
      `two critical sections overlapped: ${lines.join(' ')}`,
    )
  }
  await fs.rm(lockPath, { force: true })
})

await check('a state write is refused when the lock has been taken over', async () => {
  await fs.mkdir(stateDir, { recursive: true })
  let ran = false
  await assert.rejects(
    () =>
      core.withStateLock(async () => {
        // Another process reclaimed the lock and took it for itself, which is the
        // last thing an ownership-safe takeover should allow but which no lock file
        // can rule out on its own.
        await fs.writeFile(lockPath, '999999 another-machine\n', 'utf8')
        ran = true
        await core.saveState({ version: 1, profiles: {} }, config)
      }, config),
    /no longer held by this process/,
    'the write the lock protects has to verify the lock it is under',
  )
  assert.equal(ran, true, 'the critical section must have run')
  await fs.rm(lockPath, { force: true })
})

await check('a fresh reclaim token blocks every other reclaimer', async () => {
  const pid = await deadPid()
  await fs.mkdir(stateDir, { recursive: true })
  // An abandoned lock... and a reclaim already in progress on it. The token is what
  // makes takeover ownership-safe, so while it is held nobody else may remove the
  // lock, however stale it looks. This is the deterministic half of the race the
  // waiter test above can only provoke.
  await fs.writeFile(lockPath, `${pid} ${os.hostname()}\n`, 'utf8')
  await fs.writeFile(`${lockPath}.reclaim`, `${process.pid} ${os.hostname()}\n`, 'utf8')

  const pending = core.withStateLock(async () => 'took it', config)
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('waited'), 1200)),
  ])
  assert.equal(outcome, 'waited', 'a reclaim must be the work of one process at a time')

  await fs.rm(`${lockPath}.reclaim`, { force: true })
  await fs.rm(lockPath, { force: true })
  assert.equal(await pending, 'took it', 'and the waiter proceeds once the reclaimer is done')
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

/* ------------------------------------------------- nested names, for real -- */

await check('a tracked name that folds to another one is refused', async () => {
  // Both entries would stage to a single path, so the second rename could never
  // succeed and the profile could never be downloaded at all.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.throws(
      () => core.resolveProfileFiles({ profileFiles: ['a.txt', 'A.txt'] }),
      /duplicate tracked file name/,
    )
  }

  // The same name in its composed and decomposed Unicode spellings. macOS hands
  // those out interchangeably, so they are one file there and must be refused;
  // NTFS stores names verbatim, so there they are two real files and refusing
  // them would be a false refusal.
  const spellings = ['caf\u00e9.yml', 'cafe\u0301.yml']
  if (process.platform === 'darwin') {
    assert.throws(
      () => core.resolveProfileFiles({ profileFiles: spellings }),
      /duplicate tracked file name/,
    )
  } else {
    assert.deepEqual(core.resolveProfileFiles({ profileFiles: spellings }), spellings)
  }
})

/* --------------------------------------------------- cross-profile linking -- */

await check('a tracked file linked to a sibling profile is refused', async () => {
  if (process.platform !== 'win32') return 'junctions are a Windows-only construct'
  await seed('sibling-a', { 'package.json': '{"name":"sibling-a"}\n' })
  await seed('sibling-b', { 'package.json': '{"name":"sibling-b","secret":"BETA"}\n' })

  const link = path.join(profileDir('sibling-a'), 'shared')
  try {
    await run('cmd', ['/c', 'mklink', '/J', link, profileDir('sibling-b')])
  } catch {
    return 'this environment does not allow creating a junction'
  }

  // A tracked name is one segment, and here that segment is a link into a sibling
  // profile: reading it would publish that profile's config into this one's gist,
  // and writing it would overwrite it.
  const crossing = { ...config, profileFiles: ['package.json', 'shared'] }
  await assert.rejects(
    () => core.collectProfile('sibling-a', crossing),
    /resolves outside the profile directory/,
    'one profile must not be able to publish a sibling profile into its own gist',
  )
  await assert.rejects(
    () => core.uploadProfile('sibling-a', { ghPath, config: crossing }),
    /resolves outside the profile directory/,
  )

  // And the write direction must not reach the sibling either.
  const uploaded = await core.uploadProfile('sibling-a', { ghPath, config })
  await core.gistPatch(ghPath, uploaded.gistId, { files: { shared: '{"pwned":true}\n' } })
  await assert.rejects(
    () => core.downloadProfile('sibling-a', { ghPath, config: crossing, force: true }),
    /resolves outside the profile directory/,
  )
  assert.equal(await read('sibling-b', 'package.json'), '{"name":"sibling-b","secret":"BETA"}\n')
})

await check('a home directory reached through a junction can still restore a deleted profile', async () => {
  if (process.platform !== 'win32') return 'junctions are a Windows-only construct'
  const realHome = path.join(root, 'junction-home-real')
  const linkedHome = path.join(root, 'junction-home-link')
  await fs.mkdir(path.join(realHome, 'profiles', 'moved'), { recursive: true })
  await fs.writeFile(path.join(realHome, 'profiles', 'moved', 'cordis.patch.yml'), 'moved: 1\n', 'utf8')
  try {
    await run('cmd', ['/c', 'mklink', '/J', linkedHome, realHome])
  } catch {
    return 'this environment does not allow creating a junction'
  }

  // "Move ~/.dsh to another drive and leave a junction behind" is a common setup,
  // and it must not turn a deleted profile directory into a false escape — that
  // would disable exactly the recovery path this suite exists for.
  const viaLink = { dshHome: linkedHome, ghPath: fakeGh }
  await core.uploadProfile('moved', { ghPath, config: viaLink })
  await fs.rm(path.join(realHome, 'profiles', 'moved'), { recursive: true, force: true })

  assert.equal((await core.profileStatus('moved', { ghPath, config: viaLink })).status, 'missing-local')
  assert.equal((await core.syncProfile('moved', { ghPath, config: viaLink })).action, 'downloaded')
  assert.equal(
    await fs.readFile(path.join(realHome, 'profiles', 'moved', 'cordis.patch.yml'), 'utf8'),
    'moved: 1\n',
  )
})

/* --------------------------------------------------------------- convergence -- */

await check('a gist that lost its last tracked file is republished by one sync', async () => {
  await seed('solo', { 'cordis.patch.yml': 'solo: 1\n' })
  const solo = { ...config, profileFiles: ['cordis.patch.yml'] }
  const uploaded = await core.uploadProfile('solo', { ghPath, config: solo })

  // One-file profiles are the common case, so "the gist lost everything" is not
  // exotic. There is nothing to download, and this machine holds the only copy.
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'cordis.patch.yml': null } })
  assert.equal((await core.profileStatus('solo', { ghPath, config: solo })).status, 'remote-ahead')

  const result = await core.syncProfile('solo', { ghPath, config: solo })
  assert.equal(result.action, 'restored')
  assert.deepEqual(result.republished, ['cordis.patch.yml'])
  assert.equal((await core.profileStatus('solo', { ghPath, config: solo })).status, 'in-sync')
  assert.deepEqual((await core.gistGet(ghPath, uploaded.gistId)).fileNames, ['cordis.patch.yml'])
})

await check('sync with force resolves a restore that would discard unsynced local edits', async () => {
  await seed('mixed', { 'a.yml': 'A1\n', 'b.yml': 'B1\n' })
  const two = { ...config, profileFiles: ['a.yml', 'b.yml'] }
  await core.uploadProfile('mixed', { ghPath, config: two })

  await fs.rm(path.join(profileDir('mixed'), 'b.yml'))
  await fs.writeFile(path.join(profileDir('mixed'), 'a.yml'), 'A2-LOCAL\n', 'utf8')
  assert.equal((await core.profileStatus('mixed', { ghPath, config: two })).status, 'missing-local')

  // The refusal tells the caller to re-run with force, so force has to work —
  // otherwise the advice is a dead end printed by the only tool that can act.
  await assert.rejects(() => core.syncProfile('mixed', { ghPath, config: two }), /unsynced changes/)
  assert.equal(await read('mixed', 'a.yml'), 'A2-LOCAL\n', 'an unforced sync must not discard the edit')

  const result = await core.syncProfile('mixed', { ghPath, config: two, force: true })
  assert.equal(result.action, 'downloaded')
  assert.equal(await read('mixed', 'b.yml'), 'B1\n', 'the missing file must come back')
  assert.equal(await read('mixed', 'a.yml'), 'A1\n', 'and the local edit gives way, because force was asked for')
  assert.equal((await core.profileStatus('mixed', { ghPath, config: two })).status, 'in-sync')
})

/* ---------------------------------------------------- untracked gist content -- */

await check('an untracked truncated file cannot make the profile unreachable', async () => {
  await seed('extra', { 'cordis.patch.yml': 'extra: 1\n' })
  const narrow = { ...config, profileFiles: ['cordis.patch.yml'] }
  const uploaded = await core.uploadProfile('extra', { ghPath, config: narrow })
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'notes.txt': 'an unrelated note\n' } })

  process.env.FAKE_GH_TRUNCATE = 'notes.txt'
  process.env.FAKE_GH_RAW_BASE = 'https://elsewhere.example/collect'
  try {
    const status = await core.profileStatus('extra', { ghPath, config: narrow })
    assert.equal(status.status, 'in-sync', 'a file this machine does not track must not decide its fate')
    assert.deepEqual(status.remoteFiles, ['cordis.patch.yml'])
    assert.deepEqual(status.untrackedRemoteFiles, ['notes.txt'], 'but it is still reported, and still pruned')
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
    delete process.env.FAKE_GH_RAW_BASE
  }
})

await check('a tracked truncated file with an untrusted raw_url is still refused', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.extra.gistId
  process.env.FAKE_GH_TRUNCATE = 'notes.txt'
  process.env.FAKE_GH_RAW_BASE = 'https://elsewhere.example/collect'
  try {
    const status = await core.profileStatus('extra', {
      ghPath,
      config: { ...config, profileFiles: ['cordis.patch.yml', 'notes.txt'] },
    })
    // A read that fails is `unreachable`, never "deleted" — and never silently
    // treated as a file the profile does not have.
    assert.equal(status.status, 'unreachable')
    assert.match(status.error, /not a trusted GitHub URL/)
    // Still reported as truncated to a caller that asks for it, and refused when
    // that caller tracks it — skipping must not mean forgetting.
    assert.deepEqual((await core.gistGet(ghPath, gistId, { only: ['cordis.patch.yml'] })).truncated, [
      'notes.txt',
    ])
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
    delete process.env.FAKE_GH_RAW_BASE
  }
})

await check('a transport failure while fetching raw content falls back to gh', async () => {
  // Node's fetch ignores HTTP(S)_PROXY and the platform certificate store, both of
  // which gh honours, so on a machine that can only reach GitHub through a proxy
  // the direct request fails. The request gh would have made still has to work.
  const state = await core.loadState(config)
  const gistId = state.profiles.extra.gistId
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  try {
    const gist = await core.gistGet(ghPath, gistId, {
      only: ['cordis.patch.yml'],
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    assert.equal(gist.files['cordis.patch.yml'], 'extra: 1\n')
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
  }
})

/* ------------------------------------------------------------------- TOCTOU -- */

await check('a profile directory swapped for a link mid-download cannot redirect the write out', async () => {
  const outside = path.join(root, 'swap-outside')
  await fs.mkdir(outside, { recursive: true })

  const names = Array.from({ length: 300 }, (_, index) => `f${String(index).padStart(3, '0')}.yml`)
  const bulk = { ...config, profileFiles: names }
  await seed('swap', Object.fromEntries(names.map((name) => [name, `v: 0 # ${name}\n`])))
  const uploaded = await core.uploadProfile('swap', { ghPath, config: bulk })
  await core.gistPatch(ghPath, uploaded.gistId, {
    files: Object.fromEntries(names.map((name) => [name, `v: 1 # ${name}\n`])),
  })

  // Replace the profile directory itself with a link the moment staging begins:
  // that is the window in which the commit must not trust a path it resolved
  // earlier. If the poller misses it the download simply succeeds, so this case
  // can fail to detect, never fail wrongly.
  const dir = profileDir('swap')
  const parked = `${dir}-parked`
  let swapped = false
  let why = null
  const poller = setInterval(() => {
    if (swapped) return
    let staging = null
    try {
      staging = fsSync.readdirSync(dir).find((name) => name.startsWith('.dsh-gist-settings-staging-'))
    } catch {
      return
    }
    if (!staging) return
    try {
      fsSync.renameSync(dir, parked)
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', dir, outside])
      } else {
        fsSync.symlinkSync(outside, dir, 'dir')
      }
      swapped = true
    } catch (error) {
      why = error.message.split('\n')[0]
      // Put the directory back only if the rename actually moved it, then retry on
      // the next tick: a single refused attempt must not take the fixture apart.
      if (fsSync.existsSync(parked)) {
        try {
          fsSync.rmSync(dir, { recursive: true, force: true })
          fsSync.renameSync(parked, dir)
        } catch {
          // Leave the tree as it is; the assertions below still hold.
        }
      }
    }
  }, 1)

  try {
    await core.downloadProfile('swap', { ghPath, config: bulk, force: true }).catch(() => null)
  } finally {
    clearInterval(poller)
  }

  assert.deepEqual(
    (await fs.readdir(outside)).filter((name) => name.endsWith('.yml')),
    [],
    'no tracked file may be written outside the profile, however the download ended',
  )
  // Put the real directory back so the summary's cleanup can remove the fixture.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  await fs.rename(parked, dir).catch(() => {})

  // Reported rather than passed off as coverage: if the swap never landed, this
  // run proved nothing. On Windows it usually does not — the OS refuses to replace
  // a directory that a download is actively writing through — which is itself
  // worth knowing, and is why the per-item re-resolution is defence in depth
  // rather than the only thing standing between a swap and an out-of-tree write.
  if (!swapped) {
    return `the swap did not land on this run${why ? ` (${why})` : ''}, so nothing was exercised`
  }
})

/* ------------------------------------------------- deeper trees and tidy-ups -- */

await check('a profile is still resolved when its whole profiles directory is gone', async () => {
  const home = path.join(root, 'vanished-home')
  const homeConfig = { dshHome: home, ghPath: fakeGh }
  await fs.mkdir(path.join(home, 'profiles', 'ghost'), { recursive: true })
  await fs.writeFile(path.join(home, 'profiles', 'ghost', 'cordis.patch.yml'), 'ghost: 1\n', 'utf8')
  await core.uploadProfile('ghost', { ghPath, config: homeConfig })

  // Two missing components above the profile, so the resolved tail has to be
  // reassembled in the right order rather than reversed.
  await fs.rm(path.join(home, 'profiles'), { recursive: true, force: true })

  assert.equal((await core.profileStatus('ghost', { ghPath, config: homeConfig })).status, 'missing-local')
  assert.equal((await core.syncProfile('ghost', { ghPath, config: homeConfig })).action, 'downloaded')
  assert.equal(
    await fs.readFile(path.join(home, 'profiles', 'ghost', 'cordis.patch.yml'), 'utf8'),
    'ghost: 1\n',
  )
})

await check('two tracked names that resolve to one file are refused', async () => {
  await seed('aliased', { 'a.yml': 'AAAA\n' })
  // A hard link is a second name for one file, and creating one needs no
  // privilege. Both entries would stage, both would rename, and the second would
  // silently undo the first while the result claimed both had been written.
  await fs.link(path.join(profileDir('aliased'), 'a.yml'), path.join(profileDir('aliased'), 'b.yml'))

  const aliased = { ...config, profileFiles: ['a.yml', 'b.yml'] }
  const uploaded = await core.uploadProfile('aliased', { ghPath, config: aliased })
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'a.yml': 'BBBB\n', 'b.yml': 'BBBB\n' } })

  await assert.rejects(
    () => core.downloadProfile('aliased', { ghPath, config: aliased, force: true }),
    /resolve to the same file/,
  )
  assert.equal(await read('aliased', 'a.yml'), 'AAAA\n', 'and nothing may be written')
})

await check('pruning still sees an untracked file whose content was never fetched', async () => {
  process.env.FAKE_GH_TRUNCATE = 'notes.txt'
  process.env.FAKE_GH_RAW_BASE = 'https://elsewhere.example/collect'
  try {
    const narrow = { ...config, profileFiles: ['cordis.patch.yml'] }
    const pruned = await core.uploadProfile('extra', { ghPath, config: narrow })
    assert.deepEqual(pruned.pruned, ['notes.txt'], 'pruning decides on names, so it must still see the file')
    assert.deepEqual((await core.gistGet(ghPath, pruned.gistId)).fileNames, ['cordis.patch.yml'])
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
    delete process.env.FAKE_GH_RAW_BASE
  }
})

await check('a raw response that does not report its final URL is refused', async () => {
  const state = await core.loadState(config)
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  try {
    await assert.rejects(
      () =>
        core.gistGet(ghPath, state.profiles.extra.gistId, {
          only: ['cordis.patch.yml'],
          fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'x' }),
        }),
      /did not report its final URL/,
      'a response that cannot be shown to have stayed on GitHub must not be trusted',
    )
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
  }
})

await check('a stale-baseline repair does not overwrite a baseline another writer advanced', async () => {
  await seed('cas', { 'cordis.patch.yml': 'A1\n' })
  const one = { ...config, profileFiles: ['cordis.patch.yml'] }
  const uploaded = await core.uploadProfile('cas', { ghPath, config: one })

  // Both sides now agree on a new revision, so the recorded baseline is merely
  // stale and a status call would repair it...
  await fs.writeFile(path.join(profileDir('cas'), 'cordis.patch.yml'), 'A2\n', 'utf8')
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'cordis.patch.yml': 'A2\n' } })

  // ...but this call observed the OLD record, and another writer has already
  // advanced the stored baseline past it. Repairing from what this run saw would
  // move the baseline backwards and turn the next ordinary edit into a false
  // divergence.
  const observed = await core.loadState(config)
  observed.profiles.cas.lastSyncedHash = core.hashFiles({ 'cordis.patch.yml': 'A1\n' })

  const advanced = await core.loadState(config)
  const newer = core.hashFiles({ 'cordis.patch.yml': 'A3\n' })
  advanced.profiles.cas.lastSyncedHash = newer
  await core.saveState(advanced, config)

  const status = await core.profileStatus('cas', { ghPath, config: one, state: observed })
  assert.equal(status.status, 'in-sync')
  assert.equal(
    (await core.loadState(config)).profiles.cas.lastSyncedHash,
    newer,
    'a repair must be a compare-and-set, not a blind write',
  )
})

/* ------------------------------------------------------------ raw transfer -- */

await check('a raw response that redirected off the trusted host is refused', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.extra.gistId
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  try {
    await assert.rejects(
      () =>
        core.gistGet(ghPath, gistId, {
          only: ['cordis.patch.yml'],
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://evil.example/collected',
            text: async () => 'attacker body',
          }),
        }),
      /not a trusted GitHub URL/,
      'the final URL has to be checked, not just the one that was requested',
    )
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
  }
})

await check('raw content is fetched under its own deadline and read as a stream', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.extra.gistId
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  try {
    let seen = null
    const gist = await core.gistGet(ghPath, gistId, {
      only: ['cordis.patch.yml'],
      fetchImpl: async (url, options) => {
        seen = options
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url,
          // A streamed body is the only shape the size cap can act on, and a
          // response with no `text()` at all is the only shape that proves the
          // streaming path is the one being taken.
          body: (async function* streamed() {
            yield Buffer.from('extra: ')
            yield Buffer.from('1\n')
          })(),
        }
      },
    })
    assert.equal(gist.files['cordis.patch.yml'], 'extra: 1\n', 'a streamed body must be assembled in order')
    assert.ok(seen.signal instanceof AbortSignal, 'the request must carry a deadline of its own')
    assert.equal(seen.redirect, 'follow')
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
  }
})

await check('a raw request that fails at the transport falls back, and reports a failing fallback', async () => {
  const state = await core.loadState(config)
  const gistId = state.profiles.extra.gistId
  process.env.FAKE_GH_TRUNCATE = 'cordis.patch.yml'
  process.env.FAKE_GH_FAIL_RAW = '1'
  try {
    await assert.rejects(
      () =>
        core.gistGet(ghPath, gistId, {
          only: ['cordis.patch.yml'],
          fetchImpl: async () => {
            throw new TypeError('fetch failed')
          },
        }),
      /HTTP 502/,
      'a fallback that also fails must surface its own failure, not an empty file',
    )
  } finally {
    delete process.env.FAKE_GH_TRUNCATE
    delete process.env.FAKE_GH_FAIL_RAW
  }
})

/* --------------------------------------------------------- state write failure -- */

await check('a download whose baseline cannot be recorded says the files are in place', async () => {
  await seed('unrecorded', { 'cordis.patch.yml': 's: v1\n' })
  const solo = { ...config, profileFiles: ['cordis.patch.yml'] }
  const uploaded = await core.uploadProfile('unrecorded', { ghPath, config: solo })
  await core.gistPatch(ghPath, uploaded.gistId, { files: { 'cordis.patch.yml': 's: v2\n' } })

  // Make the state write fail while leaving it readable: on Windows by marking
  // the file read-only, elsewhere by removing write permission from its directory.
  const stateFile = path.join(stateDir, 'state.json')
  const blockWrites = async () => {
    if (process.platform === 'win32') await fs.chmod(stateFile, 0o444)
    else await fs.chmod(stateDir, 0o555)
  }
  const allowWrites = async () => {
    if (process.platform === 'win32') await fs.chmod(stateFile, 0o666)
    else await fs.chmod(stateDir, 0o755)
  }

  await blockWrites()
  try {
    await assert.rejects(
      () => core.downloadProfile('unrecorded', { ghPath, config: solo, force: true }),
      /files are in place/,
      'a failure after the commit must not be reported as a lost download',
    )
  } finally {
    await allowWrites()
  }

  assert.equal(await read('unrecorded', 'cordis.patch.yml'), 's: v2\n', 'the download itself succeeded')
  assert.deepEqual(
    (await fs.readdir(stateDir)).filter((name) => name.endsWith('.tmp')),
    [],
    'a half-written temp file must not be left behind',
  )

  // The same for the upload direction: the gist really was updated, so the report
  // has to say that rather than implying it was not.
  await fs.writeFile(path.join(profileDir('unrecorded'), 'cordis.patch.yml'), 's: v3\n', 'utf8')
  await blockWrites()
  try {
    await assert.rejects(
      () => core.uploadProfile('unrecorded', { ghPath, config: solo }),
      /recording it in .* failed/,
    )
  } finally {
    await allowWrites()
  }
  assert.equal((await core.gistGet(ghPath, uploaded.gistId)).files['cordis.patch.yml'], 's: v3\n')
  assert.deepEqual(
    (await fs.readdir(stateDir)).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
const skipNote = skipped.length ? `, ${skipped.length} skipped` : ''
console.log(`\n${results.length - failed}/${results.length} passed${skipNote}\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })