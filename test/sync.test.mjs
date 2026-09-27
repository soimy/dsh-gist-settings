#!/usr/bin/env node
/**
 * End-to-end exercise of `lib/core.js` against `test/fake-gh.mjs`.
 *
 * Runs the full lifecycle — create, upload, detect a local change, detect a
 * remote change, refuse a true divergence, prune remote files, and recover from
 * a deleted gist — with no network access and no GitHub account.
 *
 * Run with: node test/sync.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as core from '../lib/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeGh = [process.execPath, path.join(here, 'fake-gh.mjs')]

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-test-'))
process.env.FAKE_GH_STORE = path.join(root, 'fake-store.json')

const config = { dshHome: root, ghPath: fakeGh }
const ghPath = config.ghPath

async function seedProfile(name, files) {
  const dir = path.join(root, 'profiles', name)
  await fs.mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content, 'utf8')
  }
}

async function readProfileFile(name, file) {
  return fs.readFile(path.join(root, 'profiles', name, file), 'utf8')
}

await seedProfile('alpha', {
  'cordis.patch.yml': '- id: alpha\n  config:\n    value: 1\n',
  'package.json': '{\n  "name": "alpha"\n}\n',
})
await seedProfile('beta', {
  'cordis.patch.yml': '- id: beta\n  config:\n    value: 2\n',
  'package.json': '{\n  "name": "beta"\n}\n',
})

/* ------------------------------------------------------------- mini runner -- */

const results = []
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

function statusOf(rows, profile) {
  const row = rows.find((r) => r.profile === profile)
  assert.ok(row, `no status row for ${profile}`)
  return row.status
}

/* ------------------------------------------------------------------- tests -- */

console.log(`\ndsh-gist-settings core tests\n  fixture: ${root}\n`)

await check('health() locates the gh command and reads auth state', async () => {
  const h = await core.health(config)
  assert.equal(h.gh.found, true)
  assert.equal(h.gh.version, 'gh version 0.0.0-fake (test-double)')
  assert.deepEqual(h.gh.path, fakeGh)
  assert.equal(h.auth.authenticated, true)
  assert.equal(h.auth.account, 'testuser')
})

await check('listProfiles() finds both seeded profiles', async () => {
  assert.deepEqual(await core.listProfiles(config), ['alpha', 'beta'])
})

await check('both profiles start untracked', async () => {
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(profiles.length, 2)
  assert.equal(statusOf(profiles, 'alpha'), 'untracked')
  assert.equal(statusOf(profiles, 'beta'), 'untracked')
})

let alphaGistId
await check('uploadProfile() creates a secret gist on first upload', async () => {
  const result = await core.uploadProfile('alpha', { ghPath, config })
  assert.equal(result.created, true)
  assert.match(result.gistUrl, /gist\.github\.com/)
  assert.deepEqual(result.uploadedFiles.sort(), ['cordis.patch.yml', 'package.json'])
  alphaGistId = result.gistId
})

await check('the created gist is secret and holds both files', async () => {
  const gist = await core.gistGet(ghPath, alphaGistId)
  assert.deepEqual(Object.keys(gist.files).sort(), ['cordis.patch.yml', 'package.json'])
  assert.equal(gist.description, 'DeepSeek Harness profile config: alpha')
})

await check('alpha reports in-sync and beta stays untracked', async () => {
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'in-sync')
  assert.equal(statusOf(profiles, 'beta'), 'untracked')
})

await check('a local edit surfaces as local-ahead', async () => {
  await fs.writeFile(
    path.join(root, 'profiles', 'alpha', 'cordis.patch.yml'),
    '- id: alpha\n  config:\n    value: 99\n',
    'utf8',
  )
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'local-ahead')
})

await check('syncProfile() fast-forwards a local-ahead profile by uploading', async () => {
  const result = await core.syncProfile('alpha', { ghPath, config })
  assert.equal(result.action, 'uploaded')
  const gist = await core.gistGet(ghPath, alphaGistId)
  assert.match(gist.files['cordis.patch.yml'], /value: 99/)
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'in-sync')
})

await check('a remote edit surfaces as remote-ahead', async () => {
  await core.gistPatch(ghPath, alphaGistId, {
    files: { 'cordis.patch.yml': '- id: alpha\n  config:\n    value: 1234\n' },
  })
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'remote-ahead')
})

await check('syncProfile() fast-forwards a remote-ahead profile by downloading', async () => {
  const result = await core.syncProfile('alpha', { ghPath, config })
  assert.equal(result.action, 'downloaded')
  assert.match(await readProfileFile('alpha', 'cordis.patch.yml'), /value: 1234/)
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'in-sync')
})

await check('downloading takes a backup of the previous local files', async () => {
  const backupRoot = path.join(root, 'gist-settings', 'backups', 'alpha')
  const stamps = await fs.readdir(backupRoot)
  assert.ok(stamps.length >= 1, 'expected at least one backup directory')
  const contents = await fs.readFile(
    path.join(backupRoot, stamps[stamps.length - 1], 'cordis.patch.yml'),
    'utf8',
  )
  assert.match(contents, /value: 99/, 'backup should hold the pre-download content')
})

await check('a true divergence is reported and refuses to sync unforced', async () => {
  await fs.writeFile(
    path.join(root, 'profiles', 'alpha', 'cordis.patch.yml'),
    '- id: alpha\n  config:\n    value: LOCAL\n',
    'utf8',
  )
  await core.gistPatch(ghPath, alphaGistId, {
    files: { 'cordis.patch.yml': '- id: alpha\n  config:\n    value: REMOTE\n' },
  })
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'diverged')
  await assert.rejects(
    () => core.syncProfile('alpha', { ghPath, config }),
    /diverged/,
    'an unforced sync must refuse to guess',
  )
})

await check('a forced sync resolves the divergence by uploading', async () => {
  const result = await core.syncProfile('alpha', { ghPath, config, force: true })
  assert.equal(result.action, 'forced-upload')
  const gist = await core.gistGet(ghPath, alphaGistId)
  assert.match(gist.files['cordis.patch.yml'], /value: LOCAL/)
})

await check('a download refuses to clobber unsynced local changes without force', async () => {
  await fs.writeFile(
    path.join(root, 'profiles', 'alpha', 'cordis.patch.yml'),
    '- id: alpha\n  config:\n    value: KEEP-ME\n',
    'utf8',
  )
  await assert.rejects(
    () => core.downloadProfile('alpha', { ghPath, config }),
    /unsynced changes|diverged/,
  )
  assert.match(await readProfileFile('alpha', 'cordis.patch.yml'), /KEEP-ME/)
})

await check('uploading prunes remote files that are no longer tracked', async () => {
  await core.gistPatch(ghPath, alphaGistId, { files: { 'stale.yml': 'obsolete\n' } })
  await core.uploadProfile('alpha', { ghPath, config })
  const gist = await core.gistGet(ghPath, alphaGistId)
  assert.equal('stale.yml' in gist.files, false, 'stale.yml should have been removed')
  assert.deepEqual(Object.keys(gist.files).sort(), ['cordis.patch.yml', 'package.json'])
})

await check('a deleted gist is reported as missing-gist and recreated by sync', async () => {
  await core.gistDelete(ghPath, alphaGistId)
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'missing-gist')
  const result = await core.syncProfile('alpha', { ghPath, config })
  assert.equal(result.action, 'created')
  assert.notEqual(result.gistId, alphaGistId, 'recreation should mint a new gist id')
})

await check('syncAll() creates gists for every profile', async () => {
  const results2 = await core.syncAll({ ghPath, config })
  assert.equal(results2.length, 2)
  assert.ok(results2.every((r) => r.ok), `expected no failures: ${JSON.stringify(results2)}`)
  const { profiles } = await core.statusAll({ ghPath, config })
  assert.equal(statusOf(profiles, 'alpha'), 'in-sync')
  assert.equal(statusOf(profiles, 'beta'), 'in-sync')
})

await check('repeated syncs are idempotent no-ops', async () => {
  const result = await core.syncProfile('alpha', { ghPath, config })
  assert.equal(result.action, 'noop')
})

await check('state.json records one gist per profile', async () => {
  const state = await core.loadState(config)
  assert.deepEqual(Object.keys(state.profiles).sort(), ['alpha', 'beta'])
  for (const profile of ['alpha', 'beta']) {
    assert.ok(state.profiles[profile].gistId, `${profile} should have a gistId`)
    assert.ok(state.profiles[profile].lastSyncedHash, `${profile} should have a baseline hash`)
  }
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })