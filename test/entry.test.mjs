#!/usr/bin/env node
/**
 * The entry a profile actually loads.
 *
 * Every other suite imports `../index.ts` and `../lib/core.ts`, so they check the
 * sources. What the Harness loads is `dist/index.js`, reached through
 * `package.json`'s `exports` map — the one boundary nothing else crosses, and one
 * where all of these would pass unnoticed:
 *
 *   - an `exports` target that names the sources, or a path that does not exist;
 *   - a missing or stale build, including a `dist/` the last edit never reached;
 *   - a relative import the compiler rewrote to something Node cannot resolve;
 *   - an entry that loads and registers nothing.
 *
 * The Cordis loader imports this package by name, and Node's self-reference rule
 * lets this suite do exactly that from inside the package — so the resolution
 * under test is the real one, not a path spelled out here.
 *
 * A missing artifact FAILS rather than skipping, for the reason
 * `test/schema.test.mjs` fails without a Harness: a check that quietly runs
 * nothing reads as coverage. `npm test` builds first, so the normal path always
 * has an artifact to load.
 *
 * Run with: node test/entry.test.mjs  (also part of `npm test`)
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const PACKAGE = '@local/dsh-gist-settings'

/* Refuse to report on an artifact that is not there, and say how to make one. */
const missing = ['dist/index.js', 'dist/lib/core.js', 'dist/index.d.ts'].filter(
  (file) => !fs.existsSync(path.join(root, file)),
)
if (missing.length > 0) {
  console.error(`\nFAIL: ${missing.join(', ')} missing — there is nothing for the Harness to load.`)
  console.error('      `npm test` builds first (its `pretest` step); `npm run build` builds by hand.\n')
  process.exit(1)
}

/* A load that throws is one of the failures this suite exists to report, so it is
   reported rather than allowed to end the run with a stack trace. */
let built
try {
  built = await import(PACKAGE)
} catch (error) {
  console.error(`\nFAIL: importing ${PACKAGE} threw, so a profile could not load this plugin:`)
  console.error(`      ${error.message}\n`)
  process.exit(1)
}

/**
 * Register the plugin's tools through a fake context, the way the runtime does:
 * one labelled effect whose body yields each registration's disposer.
 */
function registerFrom(module) {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(body) {
      for (const dispose of body()) void dispose
      return () => {}
    },
  }
  module.apply(ctx, {})
  return registered
}

const namesOf = (definitions) => definitions.map((definition) => definition.name).sort()

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

/* ------------------------------------------------------------------ cases -- */

await check('the export map resolves to the built entry, not the sources', () => {
  const resolved = import.meta.resolve(PACKAGE)
  assert.match(
    resolved,
    /\/dist\/index\.js$/,
    `exports["."] resolved to ${resolved}; a profile would load that, so it has to be the build`,
  )
})

await check('the built entry, its engine and its declarations are on disk', () => {
  for (const file of ['dist/index.js', 'dist/lib/core.js', 'dist/index.d.ts']) {
    const full = path.join(root, file)
    assert.ok(fs.existsSync(full), `${file} is missing`)
    assert.ok(fs.statSync(full).size > 0, `${file} is empty`)
  }
})

await check('loading it by package name yields the plugin the Loader expects', () => {
  assert.deepEqual(built.inject, ['tools'], 'the plugin must still declare the service it needs')
  assert.equal(typeof built.apply, 'function', 'apply is what the Loader calls')
})

await check('a context registering through it gets all four tools', () => {
  assert.deepEqual(namesOf(registerFrom(built)), [
    'gist_download',
    'gist_status',
    'gist_sync',
    'gist_upload',
  ])
})

await check('every registered tool declares what the registry requires', () => {
  const definitions = registerFrom(built)
  assert.equal(definitions.length, 4)
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string', `${definition.name}: description`)
    assert.ok(definition.description.length > 0, `${definition.name}: description is empty`)
    assert.equal(definition.parameters?.type, 'object', `${definition.name}: parameters`)
    assert.equal(definition.output?.schema?.type, 'object', `${definition.name}: output.schema`)
    assert.equal(typeof definition.output?.render, 'function', `${definition.name}: output.render`)
    assert.equal(typeof definition.execute, 'function', `${definition.name}: execute`)
  }
})

await check('the built entry registers exactly what the source entry registers', async () => {
  // The artifact is compared against the file it was compiled from, so a `dist/`
  // left behind by an earlier edit fails here rather than being loaded silently.
  // The fingerprint deliberately reaches past the declarations — member sets, each
  // tool's output schema, what `output.render` produces for a probe value, and the
  // concurrency verdict — because a comparison of `name`/`description`/`parameters`
  // alone would call a build that changed only behaviour identical.
  const source = await import('../index.ts')
  const fingerprint = (definitions) =>
    definitions
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        members: Object.keys(definition).sort(),
        outputMembers: Object.keys(definition.output ?? {}).sort(),
        schema: definition.output?.schema,
        rendered: definition.output?.render({}, { text: 'probe' }),
        concurrencySafe: definition.isConcurrencySafe?.() ?? null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
  assert.deepEqual(fingerprint(registerFrom(built)), fingerprint(registerFrom(source)))
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1