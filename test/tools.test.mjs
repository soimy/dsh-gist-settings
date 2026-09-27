#!/usr/bin/env node
/**
 * Exercise the Host plugin's tool layer in isolation.
 *
 * `apply()` is driven with a stub context that captures the registered tool
 * definitions, so the four tools can be executed against `test/fake-gh.mjs`
 * without installing the bundle into a profile.
 *
 * Run with: node test/tools.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-tools-'))
process.env.FAKE_GH_STORE = path.join(root, 'fake-store.json')

for (const name of ['alpha', 'beta']) {
  const dir = path.join(root, 'profiles', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), `- id: ${name}\n`, 'utf8')
  await fs.writeFile(path.join(dir, 'package.json'), `{\n  "name": "${name}"\n}\n`, 'utf8')
}

/* Capture the tool definitions the plugin registers, the way the runtime would. */
const tools = new Map()
const disposeLabels = []
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(body, label) {
    disposeLabels.push(label)
    for (const dispose of body()) void dispose
    return () => {}
  },
}

apply(ctx, {
  dshHome: root,
  ghPath: [process.execPath, path.join(here, 'fake-gh.mjs')],
})

/** Run a tool and return its single text block. */
async function call(name, args) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} was not registered`)
  const blocks = await definition.execute(args ?? {})
  assert.ok(Array.isArray(blocks), `${name} must return content blocks`)
  return blocks.map((b) => b.text).join('\n')
}

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

console.log(`\ndsh-gist-settings tool tests\n  fixture: ${root}\n`)

await check('apply() registers exactly the four gist tools', () => {
  assert.deepEqual([...tools.keys()].sort(), ['gist_download', 'gist_status', 'gist_sync', 'gist_upload'])
})

await check('each tool exposes a JSON-Schema parameter object', () => {
  for (const [name, definition] of tools) {
    assert.equal(typeof definition.description, 'string', `${name} needs a description`)
    assert.ok(definition.description.length > 40, `${name} description is too thin for the model`)
    assert.equal(definition.parameters.type, 'object', `${name} parameters must be an object root`)
    assert.equal(typeof definition.output.render, 'function', `${name} needs an output renderer`)
  }
})

await check('gist_status reports gh health and per-profile state', async () => {
  const body = await call('gist_status')
  assert.match(body, /gh: {3}gh version 0\.0\.0-fake/)
  assert.match(body, /auth: ok \(testuser\)/)
  assert.match(body, /alpha/)
  assert.match(body, /beta/)
  assert.match(body, /not tracked/)
})

await check('gist_upload creates a gist for every profile', async () => {
  const body = await call('gist_upload')
  assert.match(body, /alpha: created https:\/\/gist\.github\.com/)
  assert.match(body, /beta: created https:\/\/gist\.github\.com/)
})

await check('gist_status now reports both profiles in sync', async () => {
  const body = await call('gist_status')
  assert.equal(body.match(/in sync/g)?.length, 2, body)
  assert.doesNotMatch(body, /Not tracked yet/)
})

await check('gist_sync is a no-op when nothing changed', async () => {
  const body = await call('gist_sync')
  assert.match(body, /alpha: already in sync/)
  assert.match(body, /beta: already in sync/)
})

await check('gist_sync uploads a local edit', async () => {
  await fs.writeFile(path.join(root, 'profiles', 'alpha', 'cordis.patch.yml'), '- id: alpha\nedited: true\n', 'utf8')
  const body = await call('gist_sync')
  assert.match(body, /alpha: uploaded/)
  assert.match(body, /beta: already in sync/)
})

await check('gist_download restores one profile from its gist', async () => {
  const body = await call('gist_download', { profile: 'alpha' })
  assert.match(body, /alpha: restored from https:\/\/gist\.github\.com/)
  assert.match(body, /backed up to/)
})

await check('an unknown profile name is rejected before touching the filesystem', async () => {
  await assert.rejects(() => call('gist_download', { profile: '../../etc' }), /invalid profile name/)
})

await check('a single-profile call is scoped to that profile', async () => {
  const body = await call('gist_status', { profile: 'beta' })
  assert.match(body, /beta/)
  assert.doesNotMatch(body, /^alpha$/m)
})

await check('a failing profile is reported without aborting the others', async () => {
  const gistState = JSON.parse(await fs.readFile(process.env.FAKE_GH_STORE, 'utf8'))
  for (const id of Object.keys(gistState.gists)) delete gistState.gists[id]
  await fs.writeFile(process.env.FAKE_GH_STORE, JSON.stringify(gistState), 'utf8')

  const body = await call('gist_sync')
  assert.match(body, /alpha: created/)
  assert.match(body, /beta: created/)
})

await check('apply() registered its registrations as one labelled effect', () => {
  assert.deepEqual(disposeLabels, ['dsh-gist-settings tools'])
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })