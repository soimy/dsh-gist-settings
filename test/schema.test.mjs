#!/usr/bin/env node
/**
 * Validate this plugin's hand-written tool definitions against the Harness's own
 * contract, using the installed `@deepseek-ai/dsh-tools` validators.
 *
 * The plugin deliberately imports nothing from the DSH installation, which is
 * what keeps it immune to module-resolution changes — but it also means the
 * Harness never type-checks these definitions. This suite closes that gap by
 * replaying the checks the runtime performs:
 *
 *   - `ToolRuntime.register()`: output shape, `assertSupportedJsonSchema` on the
 *     parameters and on the output schema, model-readable docs;
 *   - `defineTool()`: `validateJsonSchemaValue` over the arguments — which the
 *     plugin's own `checkArgs` reimplements by hand, so both are compared;
 *   - `createSuccessResult()`: the value `execute` returns really satisfies the
 *     declared `output.schema`.
 *
 * Finding no DSH installation FAILS the suite by default, because skipping would
 * leave `npm test` green with none of these checks having run. Set
 * `DSH_ALLOW_SCHEMA_SKIP=1` to accept the skip, or `DSH_TOOLS_DIR` to point at an
 * installation explicitly.
 *
 * Run with: node test/schema.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.ts'

/** Candidate locations for the installed `@deepseek-ai/dsh-tools` package. */
function findDshTools() {
  const candidates = []
  if (process.env.DSH_TOOLS_DIR) candidates.push(process.env.DSH_TOOLS_DIR)

  const nodeDir = path.dirname(process.execPath)
  const dshPackages = [
    path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    path.join(nodeDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    path.join(nodeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ]
  for (const base of dshPackages) candidates.push(path.join(base, 'dsh-tools'))

  return candidates.find((dir) => fs.existsSync(path.join(dir, 'lib', 'types', 'json-schema.js'))) ?? null
}

const toolsDir = findDshTools()
if (!toolsDir) {
  const message =
    'no installed @deepseek-ai/dsh-tools found; set DSH_TOOLS_DIR to run the schema-conformance suite'
  if (process.env.DSH_ALLOW_SCHEMA_SKIP === '1') {
    console.log(`\nSKIP: ${message} (DSH_ALLOW_SCHEMA_SKIP=1).\n`)
    process.exit(0)
  }
  console.error(`\nFAIL: ${message}. Set DSH_ALLOW_SCHEMA_SKIP=1 to accept a skip instead.\n`)
  process.exit(1)
}

const asFileUrl = (p) => new URL(`file://${p.replace(/\\/g, '/')}`).href
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(
  asFileUrl(path.join(toolsDir, 'lib', 'types', 'json-schema.js'))
)

/* Drive the plugin against the fake gh so the suite stays hermetic. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gist-schema-'))
process.env.FAKE_GH_STORE = path.join(root, 'fake-store.json')
for (const name of ['alpha']) {
  const dir = path.join(root, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `- id: ${name}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "name": "${name}"\n}\n`, 'utf8')
}

const definitions = []
const ctx = {
  tools: {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  },
  effect(body) {
    for (const dispose of body()) void dispose
    return () => {}
  },
}
apply(ctx, {
  dshHome: root,
  ghPath: [process.execPath, path.join(fileURLToPath(new URL('.', import.meta.url)), 'fake-gh.mjs')],
})

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

console.log(`\ndsh-gist-settings schema conformance\n  dsh-tools: ${toolsDir}\n`)

/** Arguments the real validator rejects, paired with what they would do if let through. */
const BAD_ARGS = [
  { label: 'a misspelled key', args: { profil: 'alpha' } },
  { label: 'a string for a boolean', args: { force: 'false' } },
  { label: 'an explicit null for a string', args: { profile: null } },
  { label: 'an explicit null for a boolean', args: { force: null } },
  { label: 'a number for a boolean', args: { force: 0 } },
  { label: 'an array instead of an object', args: [] },
  { label: 'a string instead of an object', args: 'alpha' },
]

await check('apply() produced definitions to validate', () => {
  if (definitions.length === 0) throw new Error('no tool definitions were registered')
})

for (const definition of definitions) {
  const { name, parameters } = definition

  await check(`${name}: output declares { schema, render }`, () => {
    const output = definition.output
    if (output === undefined || typeof output !== 'object') throw new Error('missing output object')
    if (typeof output.render !== 'function') throw new Error('output.render must be a function')
    if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
      throw new Error('output.presentationMeta must be a function when present')
    }
  })

  await check(`${name}: parameters pass assertSupportedJsonSchema`, () => {
    assertSupportedJsonSchema(parameters)
    assert.equal(parameters.type, 'object', 'parameters root must be an object schema')
  })

  await check(`${name}: output.schema passes assertSupportedJsonSchema`, () => {
    assertSupportedJsonSchema(definition.output.schema)
  })

  await check(`${name}: a valid call returns a value its own output.schema accepts`, async () => {
    const value = await definition.execute({}, { signal: undefined })
    const violations = validateJsonSchemaValue(definition.output.schema, value, 'value')
    assert.deepEqual(violations, [], `output schema violations: ${JSON.stringify(violations)}`)

    const blocks = definition.output.render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render must produce content blocks')
    for (const block of blocks) {
      assert.equal(block.type, 'text', 'every block must be a text block')
      assert.equal(typeof block.text, 'string', 'a text block needs string text')
    }
  })

  await check(`${name}: description and parameter docs are model-ready`, () => {
    if (typeof definition.description !== 'string' || definition.description.length < 40) {
      throw new Error('description must be a string of at least 40 characters')
    }
    for (const [key, node] of Object.entries(parameters.properties ?? {})) {
      if (typeof node.description !== 'string' || node.description.length === 0) {
        throw new Error(`parameter "${key}" needs a description for the model`)
      }
    }
  })

  for (const { label, args } of BAD_ARGS) {
    await check(`${name}: rejects ${label}`, async () => {
      // The real contract rejects it...
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length === 0) return // the real validator allows it; nothing to compare
      // ...so the plugin must too, or the model never learns its call was wrong.
      await assert.rejects(
        () => definition.execute(args, { signal: undefined }),
        /invalid arguments/,
        'the plugin accepted arguments the real validator rejects',
      )
    })
  }
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
fs.rmSync(root, { recursive: true, force: true })