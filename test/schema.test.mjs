#!/usr/bin/env node
/**
 * Validate this plugin's hand-written tool definitions against the Harness's own
 * contract, using the installed `@deepseek-ai/dsh-tools` validators.
 *
 * The plugin deliberately imports nothing from the DSH installation, which is
 * what keeps it immune to module-resolution changes — but it also means the
 * Harness never type-checks these definitions. This test closes that gap: it
 * replays the checks `ToolRuntime.register()` performs, so a Harness upgrade
 * that tightens the supported JSON Schema subset fails here instead of at
 * profile startup.
 *
 * Skips (exit 0) when no DSH installation can be located; set DSH_TOOLS_DIR to
 * point at one explicitly.
 *
 * Run with: node test/schema.test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

import { apply } from '../index.js'

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
  console.log('\nSKIP: no installed @deepseek-ai/dsh-tools found; set DSH_TOOLS_DIR to run this suite.\n')
  process.exit(0)
}

const { assertSupportedJsonSchema } = await import(
  new URL(`file://${path.join(toolsDir, 'lib', 'types', 'json-schema.js').replace(/\\/g, '/')}`).href
)

/* Capture the definitions exactly as the runtime would receive them. */
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
apply(ctx, {})

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

await check('apply() produced definitions to validate', () => {
  if (definitions.length === 0) throw new Error('no tool definitions were registered')
})

for (const definition of definitions) {
  const { name } = definition

  await check(`${name}: output declares { schema, render }`, () => {
    const output = definition.output
    if (output === undefined || typeof output !== 'object') {
      throw new Error('missing output object')
    }
    if (typeof output.render !== 'function') throw new Error('output.render must be a function')
    if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
      throw new Error('output.presentationMeta must be a function when present')
    }
  })

  await check(`${name}: parameters pass assertSupportedJsonSchema`, () => {
    assertSupportedJsonSchema(definition.parameters)
    if (definition.parameters.type !== 'object') {
      throw new Error('parameters.root must be an object schema')
    }
  })

  await check(`${name}: output.schema passes assertSupportedJsonSchema`, () => {
    assertSupportedJsonSchema(definition.output.schema)
  })

  await check(`${name}: description and parameter docs are model-ready`, () => {
    if (typeof definition.description !== 'string' || definition.description.length < 40) {
      throw new Error('description must be a string of at least 40 characters')
    }
    for (const [key, node] of Object.entries(definition.parameters.properties ?? {})) {
      if (typeof node.description !== 'string' || node.description.length === 0) {
        throw new Error(`parameter "${key}" needs a description for the model`)
      }
    }
  })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1