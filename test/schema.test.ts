#!/usr/bin/env node
/**
 * Validate what the Harness checks about this bundle — its hand-written tool
 * definitions, and the peer declaration that decides whether it loads at all —
 * against the runtime's own code: the installed `@deepseek-ai/dsh-tools`
 * validators, and `@deepseek-ai/dsh-app-boot`'s compatibility gate.
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
 *     declared `output.schema`;
 *   - `evaluatePluginCompatibility()`: `package.json`'s `peerDependencies`
 *     satisfies the installed runtime. The profile loader reads that declaration
 *     and nothing else, so a version it cannot satisfy skips the whole bundle
 *     however sound the definitions are — which is a failure no other suite here
 *     can see, because they all call the plugin directly.
 *
 * Finding no DSH installation FAILS the suite by default, because skipping would
 * leave `npm test` green with none of these checks having run. Set
 * `DSH_ALLOW_SCHEMA_SKIP=1` to accept the skip, or `DSH_TOOLS_DIR` to point at an
 * installation explicitly.
 *
 * Run with: node test/schema.test.ts
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

/**
 * The two validators this suite replays, described as this file calls them.
 *
 * `dsh-tools` is reached by path rather than imported, so its own declarations are
 * never seen here; this names the two entry points instead of leaving them untyped.
 */
interface JsonSchemaValidators {
  assertSupportedJsonSchema(schema: unknown): void
  validateJsonSchemaValue(schema: unknown, value: unknown, label: string): unknown[]
}

const asFileUrl = (p: string): string => new URL(`file://${p.replace(/\\/g, '/')}`).href
const { assertSupportedJsonSchema, validateJsonSchemaValue }: JsonSchemaValidators = await import(
  asFileUrl(path.join(toolsDir, 'lib', 'types', 'json-schema.js'))
)

/**
 * The profile loader's compatibility check, reached the same way and for the same
 * reason: `dsh-app-boot` is `dsh-tools`' sibling inside one installed Harness, and its
 * `evaluatePluginCompatibility` is what the loader calls before it adds a profile layer.
 * The Harness's own function is used rather than a copy of its rules, so this cannot
 * drift from what the loader actually does.
 */
interface BundleGate {
  getDshRuntimeVersion(): string
  evaluatePluginCompatibility(manifest: object): { peers: Record<string, string> } | undefined
  pluginCompatibilityWarning(issue: { peers: Record<string, string> }): string
}
const gate: BundleGate = await import(asFileUrl(path.join(toolsDir, '..', 'dsh-app-boot', 'lib', 'index.js')))
const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

/* Drive the plugin against the fake gh so the suite stays hermetic. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gist-schema-'))
process.env.FAKE_GH_STORE = path.join(root, 'fake-store.json')
for (const name of ['alpha']) {
  const dir = path.join(root, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `- id: ${name}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "name": "${name}"\n}\n`, 'utf8')
}

/**
 * One registered tool definition, as far as this suite reads it.
 *
 * What the suite re-checks at run time with `typeof` stays `unknown` here, so those
 * checks keep their meaning: the definitions arrive through Cordis' `register`, and
 * nothing in this file can assume they were type-checked on the way in.
 */
interface RegisteredTool {
  name: string
  description?: unknown
  parameters: {
    type?: unknown
    properties?: Record<string, { description?: unknown }>
  }
  output: {
    schema: unknown
    render(args: unknown, value: unknown): Array<{ type: string; text: string }>
    presentationMeta?: unknown
  }
  execute(args: unknown, exec: { signal?: AbortSignal } | undefined): Promise<unknown>
}

const definitions: RegisteredTool[] = []
const ctx = {
  tools: {
    register(definition: RegisteredTool) {
      definitions.push(definition)
      return () => {}
    },
  },
  effect(body: () => Generator<() => void, void, unknown>) {
    for (const dispose of body()) void dispose
    return () => {}
  },
}
apply(ctx, {
  dshHome: root,
  ghPath: [process.execPath, path.join(fileURLToPath(new URL('.', import.meta.url)), 'fake-gh.ts')],
})

const results: boolean[] = []
async function check(name: string, fn: () => unknown) {
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

console.log(`\ndsh-gist-settings schema conformance\n  dsh-tools: ${toolsDir}\n`)

/**
 * The declaration, checked with the function the loader itself calls.
 *
 * A plugin whose definitions are perfect is still skipped before any of its code runs
 * when the runtime cannot satisfy its `peerDependencies` — which is how an exact pin
 * shipped through a green matrix and was refused by the next dsh release.
 */
await check(`the bundle manifest passes dsh ${gate.getDshRuntimeVersion()}'s compatibility gate`, () => {
  const issue = gate.evaluatePluginCompatibility(manifest)
  assert.equal(issue, undefined, issue ? gate.pluginCompatibilityWarning(issue) : '')

  // Control: the same call has to refuse a declaration nothing can satisfy, or this
  // case would pass whatever `peerDependencies` said.
  const impossible = gate.evaluatePluginCompatibility({
    ...manifest,
    peerDependencies: { '@deepseek-ai/dsh': '0.0.1' },
  })
  assert.ok(impossible, 'the gate must reject an unsatisfiable peer, or this case proves nothing')
})

/** Arguments the real validator rejects, paired with what they would do if let through. */
const BAD_ARGS: Array<{ label: string; args: unknown }> = [
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