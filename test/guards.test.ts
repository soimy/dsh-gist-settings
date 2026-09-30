#!/usr/bin/env node
/**
 * Guard the invariants that make this repository work, which no behavioural suite can see.
 *
 * Every other suite here tests what the code *does*. None of them tests the properties the
 * repository needs in order to run at all: that each TypeScript file survives Node's own
 * type stripper, that every relative import names a file that exists, that no compiled
 * JavaScript has been left where only TypeScript may live, that the packaging names
 * artifacts a build emits, that every suite and script is run by a package script, that the
 * compiler flags this repository depends on are still on, and that the declared Node floor
 * is the one CI runs.
 *
 * Each case is written to be reverted by hand — break the invariant, watch the case go red,
 * restore it. `docs/contributor/testing.md` owns that discipline, and the reason it matters
 * more here than anywhere else is that all seven of these fail *silently* in normal use: a
 * file that stops stripping fails when someone runs it, a flag that is removed changes what
 * the compiler checks, and a floor that drifts is only noticed on the platform nobody
 * develops on.
 *
 * The subjects are discovered rather than listed: every `.ts` file in the repository, minus
 * `dist/`, `node_modules/`, `.git/` and `.worktrees/`. A new source file is therefore
 * guarded the moment it lands, in whatever directory it lands. Two boundaries are
 * deliberate and documented in the case that owns them: a hand-written `client.js` at the
 * repository root (the settings page the README plans) is not compiled output, and a
 * bundled client source in another extension — `.tsx`, say — cannot be executed by Node's
 * type stripper at all, so this suite does not claim to cover it.
 *
 * One case reads what the build emits, so this suite needs `dist/` in the same way
 * `test/entry.test.ts` does: `npm run test:guards` builds first, and `npm test` builds
 * through its `pretest` step.
 *
 * Run with: node test/guards.test.ts  (also part of `npm test`)
 */

import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/** The Node floor this package declares, which is the Harness's floor rather than its own. */
const NODE_FLOOR = '^22.19 || >=24'

/** The exact version CI must run to prove that floor: the floor string's own `22.19.0`. */
const NODE_FLOOR_VERSION = '22.19.0'

/** The compiler flags a repository executed by Node's type stripper depends on. */
const REQUIRED_FLAGS = [
  'erasableSyntaxOnly',
  'verbatimModuleSyntax',
  'rewriteRelativeImportExtensions',
  'isolatedModules',
  'strict',
]

/** Generated output, installed dependencies, and a nested checkout: not this repository's sources. */
const GENERATED = new Set(['dist', 'node_modules', '.git', '.worktrees'])

/** Read one repository-relative file as UTF-8. */
const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8')

/** Every file under one directory, recursively, whose name `keep` accepts. */
async function walk(directory: string, keep: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory === '.' ? entry.name : path.posix.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (GENERATED.has(entry.name)) continue
      found.push(...(await walk(relative, keep)))
    } else if (keep(entry.name)) found.push(relative)
  }
  return found
}

/**
 * True when the resolved path is a file.
 *
 * A directory is not a module specifier: `import '../lib'` resolves here and then fails at
 * load with `ERR_UNSUPPORTED_DIR_IMPORT`, so `existsSync` would be too weak a claim.
 */
function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    // A path that does not exist is exactly what this predicate answers `false` for; there is
    // no failure here to report.
    return false
  }
}

/** True when the resolved path exists at all, because a `files` entry may name a directory. */
function exists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch {
    // Same as `isFile`: absence is the answer, not a failure.
    return false
  }
}

/**
 * A JSON object read from a file this repository owns.
 *
 * The files below are ours, so a shape that is not an object is a broken checkout rather
 * than untrusted input — but it must still be reported with the file's name instead of
 * throwing a `TypeError` somewhere further down.
 */
function asMapping(value: unknown, what: string): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${what} must be a JSON object`,
  )
  // The assertion above proves the shape; this cast only names it for the compiler.
  return value as Record<string, unknown>
}

/**
 * Parse a JSON file that may carry comments.
 *
 * `tsconfig.json` is JSONC: each flag documents why it is on, and `JSON.parse` refuses the
 * comments. Removing them needs a scan rather than a regular expression, because `//`
 * appears inside string values here — `"./lib/core.ts"` is a path, not a comment.
 */
function parseJsonc(source: string): unknown {
  let stripped = ''
  let quote: string | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (quote) {
      stripped += char
      if (char === '\\') {
        stripped += next
        index += 1
      } else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      stripped += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      stripped += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    stripped += char
  }
  return JSON.parse(stripped)
}

/**
 * A TypeScript source with all of its comments removed.
 *
 * The import scan has to read a specifier on any line and in any of the three quote
 * characters, so it cannot anchor to a line start everywhere — and a comment that names a
 * path (this repository is full of them) would then be read as an import. A scanner rather
 * than a regular expression, because `//` and both quote characters also appear inside
 * strings and regular expressions here. The one heuristic is that a `/` where a value may
 * begin starts a regular expression rather than a division; the two readings are handled the
 * same way, by copying the span to its closing delimiter.
 */
function withoutComments(source: string): string {
  let out = ''
  let index = 0
  // The last significant character emitted, for the regex-versus-division guess below.
  let previous = ''
  const valueMayStart = () => previous === '' || '([{,;=:!&|?+-*%~^<>'.includes(previous)

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      out += '\n'
      previous = '\n'
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      out += ' '
      previous = ' '
      continue
    }

    if (char === '/' && valueMayStart()) {
      out += char
      index += 1
      let inCharacterClass = false
      while (index < source.length) {
        const inner = source[index]
        out += inner
        index += 1
        // A division read as a regex stops at the end of its line rather than swallowing the
        // rest of the file; the copied text is unchanged either way.
        if (inner === '\\' && index < source.length) {
          out += source[index]
          index += 1
          continue
        }
        if (inner === '[') inCharacterClass = true
        else if (inner === ']') inCharacterClass = false
        else if (inner === '/' && !inCharacterClass) break
        else if (inner === '\n') break
      }
      previous = '/'
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      out += char
      index += 1
      let closed = false
      while (index < source.length) {
        const inner = source[index]
        out += inner
        index += 1
        if (inner === '\\' && index < source.length) {
          out += source[index]
          index += 1
          continue
        }
        if (inner === char) {
          closed = true
          break
        }
        // An ordinary string cannot span a line, so a missing quote is a typo rather than an
        // invitation to treat the rest of the file as a string.
        if (inner === '\n' && char !== '`') break
      }
      previous = closed ? char : '\n'
      continue
    }

    out += char
    if (!/\s/.test(char)) previous = char
    index += 1
  }

  return out
}

/**
 * True when a `*`-bearing `exports` or `files` pattern names something that exists.
 *
 * A pattern is not one path, so the exact-path check has to skip it — and without this, a
 * package could point `./locale/*.json` at a directory that no longer holds a locale file,
 * break every consumer import, and still pass this suite. Both shapes npm uses are handled:
 * a single star inside one directory, and a `**` that may sit below it.
 */
async function patternMatches(pattern: string): Promise<boolean> {
  const normalized = pattern.replace(/^\.\//, '')
  const starAt = normalized.indexOf('*')
  const directory = normalized.slice(0, starAt).replace(/\/$/, '')
  const suffix = normalized.slice(starAt).replace(/^[*\/]+/, '')
  if (!exists(path.join(root, directory))) return false
  const recursive = normalized.slice(starAt).startsWith('**')
  const candidates = recursive
    ? await walk(directory, () => true)
    : (await fs.readdir(path.join(root, directory), { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
  return candidates.some((candidate) => candidate.endsWith(suffix))
}

/** Every path an `exports` value names, at any depth of condition nesting. */
function exportPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  // The guard above proves a mapping; `exports` has no array form, and an array would simply
  // contribute its elements to the walk.
  return Object.values(value as Record<string, unknown>).flatMap((nested) => exportPaths(nested))
}

/** How far a line is indented, which is what separates one YAML node from the next here. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * The lines of the YAML step that contains `at`.
 *
 * A step ends where the indentation falls back to the step's own level: the next `- ` item,
 * or the next job's first key. Stopping at the next `- ` alone is not enough — it sweeps up
 * every key of the job below, so a condition on *that* job reads as a condition on this step
 * and a valid workflow fails this suite. A blank line and a comment end nothing, because
 * neither is a YAML node: skipping them keeps a step's own keys in one slice, while an `if:`
 * indented inside the step is still inside it.
 */
function stepLines(workflow: string[], at: number): string[] {
  let start = at
  while (start > 0 && !/^\s*- /.test(workflow[start])) start -= 1
  const indent = indentOf(workflow[start])
  let end = at
  for (let index = at + 1; index < workflow.length; index += 1) {
    const line = workflow[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (indentOf(line) <= indent) break
    end = index
  }
  return workflow.slice(start, end + 1)
}

/* ------------------------------------------------------------ the subjects -- */

/** Every TypeScript source in the repository, wherever it lives. */
const sources = await walk('.', (name) => name.endsWith('.ts'))

/** The half the Harness loads, which must import `.ts` so the build can rewrite it. */
const runtime = sources.filter((file) => file === 'index.ts' || file.startsWith('lib/'))

/** Every suite under `test/`, its helpers included. */
const suites = sources.filter((file) => file.startsWith('test/'))

/** Every script under `scripts/`. */
const scripts = sources.filter((file) => file.startsWith('scripts/'))

const pkg = asMapping(parseJsonc(await read('package.json')), 'package.json')
const scriptsField = asMapping(pkg.scripts, 'package.json scripts')

/**
 * The `node <file>` invocations one script performs, following `npm run <name>` aliases.
 *
 * A substring test is not enough in either direction: `echo skipped test/sync.test.ts` names
 * the file without ever running it, and a chain composed of the `test:*` aliases names every
 * suite without spelling any path. Resolution stops after a few levels, because a cycle in
 * the alias graph should report "this script runs nothing", not hang.
 */
function runTargets(script: string, depth = 0): string[] {
  const value = scriptsField[script]
  if (typeof value !== 'string' || depth > 2) return []
  const targets: string[] = []
  for (const segment of value.split('&&').map((part) => part.trim())) {
    const direct = /^node (.+)$/.exec(segment)
    if (direct) targets.push(direct[1])
    else {
      const alias = /^npm run ([\w:.-]+)$/.exec(segment)
      if (alias) targets.push(...runTargets(alias[1], depth + 1))
    }
  }
  return targets
}

/** Every `node <file>` invocation any package script performs. */
const targetsEverywhere = Object.keys(scriptsField).flatMap((name) => runTargets(name))

/* -------------------------------------------------------------- the runner -- */

const results: boolean[] = []
async function check(name: string, fn: () => Promise<void>) {
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

/* ------------------------------------------------------------------ cases -- */

await check('every TypeScript source survives Node\'s type stripper', async () => {
  // `erasableSyntaxOnly` protects this at compile time and nothing protects it at runtime:
  // an `enum`, a `namespace`, or a parameter property compiles here only if someone runs
  // `tsc`, and fails the moment Node loads the file. This is also what keeps the build's
  // rewrite of `.ts` imports to `.js` importing something that exists.
  for (const file of sources) {
    const source = await read(file)
    try {
      stripTypeScriptTypes(source, { mode: 'strip' })
    } catch (error) {
      // `stripTypeScriptTypes` throws a SyntaxError naming the construct it refused.
      throw new Error(`${file} does not survive Node's type stripper: ${(error as Error).message}`)
    }
  }
  assert.ok(sources.length >= 10, `only ${sources.length} TypeScript sources were found; the scan itself is broken`)
})

await check('every relative import names a file that exists, and the runtime imports .ts', async () => {
  // Three shapes are in use: `import ... from './x.ts'`, a bare `import './x.ts'`, and a
  // dynamic `import('./x.ts')`. The first two anchor at the start of a line — that is what
  // keeps a specifier quoted in a doc comment out of the result, since every comment line
  // here begins with `//`, `*` or `/**` — but the statement itself may wrap, so the scan
  // cannot stop at the end of that line. The dynamic form is matched anywhere, because it
  // appears mid-expression. Backticks count: a template literal is a module specifier.
  const fromClause = /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*['"`](\.[^'"`\n]+)['"`]/gm
  const bareClause = /^[ \t]*import[ \t]*['"`](\.[^'"`\n]+)['"`]/gm
  const dynamicClause = /\bimport\s*\(\s*['"`](\.[^'"`\n]+)['"`]/g

  const found: Array<{ file: string; specifier: string }> = []
  for (const file of sources) {
    const source = withoutComments(await read(file))
    for (const clause of [fromClause, bareClause, dynamicClause]) {
      for (const match of source.matchAll(clause)) {
        // A specifier built by interpolation cannot be resolved here; the build would have to
        // evaluate it, and a guard that guesses is worse than one that stays quiet.
        if (match[1].includes('${')) continue
        found.push({ file, specifier: match[1] })
      }
    }
  }

  // A scan that matches nothing would pass this case for every repository, including one
  // where every import is broken. The floor is the smoke test for the scan, and the second
  // assertion anchors it to a file whose imports provably exist.
  assert.ok(found.length >= 8, `only ${found.length} relative imports were found; the scan itself is broken`)
  assert.ok(found.some((entry) => entry.file === 'index.ts'), 'the scan did not even see index.ts import its engine')

  for (const { file, specifier } of found) {
    const target = path.resolve(path.dirname(path.join(root, file)), specifier)
    assert.ok(isFile(target), `${file} imports ${specifier}, which is not a file that exists`)
    if (runtime.includes(file)) {
      // The runtime is the half `tsc` rewrites: naming `./lib/core.js` here would compile,
      // but the source itself would stop resolving under Node's stripper, which is how
      // every suite loads it.
      assert.ok(
        specifier.endsWith('.ts'),
        `${file} imports ${specifier}; runtime imports name the source file ('.ts') so the build rewrites them`,
      )
    }
  }
})

await check('no compiled JavaScript sits beside a source, and none outside dist/', async () => {
  // Generated output belongs in `dist/` and `node_modules/`, both skipped by the walk. Two
  // boundaries are deliberate. A `.js` file nested anywhere else is a leftover — under
  // `lib/` it is the pre-migration compiled engine, and under `test/` or `scripts/` it is a
  // half-finished migration. At the repository root, a `.js` with a `.ts` twin of the same
  // name is that same leftover (`index.js` beside `index.ts`), while a root `.js` with no
  // twin is allowed: the README documents `client.js` there as the settings page the
  // Harness bundles, which is a source rather than compiled output.
  const isPlainJs = (name: string) => name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')
  const everyJs = await walk('.', isPlainJs)

  const nested = everyJs.filter((file) => file.includes('/'))
  assert.deepEqual(nested, [], `JavaScript found where only TypeScript may live: ${nested.join(', ')}`)

  const twins = everyJs.filter(
    (file) => !file.includes('/') && sources.includes(file.replace(/\.(m|c)?js$/, '.ts')),
  )
  assert.deepEqual(twins, [], `compiled output left beside its own source: ${twins.join(', ')}`)
})

await check('the packaging names artifacts a build emits', async () => {
  // This is the boundary a profile crosses: the Loader reads `exports`, so a rename that
  // leaves it pointing at a source file or a path that is never built is invisible to every
  // other suite here — they import `index.ts` directly. Every string anywhere in `exports`
  // has to exist, however deeply its conditions nest, because a subpath nobody can import
  // is not covered by the entry suite either.
  for (const artifact of ['dist/index.js', 'dist/index.d.ts']) {
    assert.ok(
      isFile(path.join(root, artifact)),
      `${artifact} is missing. Run \`npm run build\` (or \`npm test\`, whose pretest step builds).`,
    )
  }

  const exportsField = asMapping(pkg.exports, 'package.json exports')
  const entry = asMapping(exportsField['.'], 'package.json exports["."]')
  assert.equal(entry.default, './dist/index.js', 'the package entry must be the built entry, not the sources')
  assert.equal(entry.types, './dist/index.d.ts', 'the package entry must name the built declarations')

  for (const [key, value] of Object.entries(exportsField)) {
    for (const named of exportPaths(value)) {
      // `./locale/*.json` is a pattern rather than one path, and a pattern that matches
      // nothing is this case's failure as much as a path that does not exist.
      const ok = named.includes('*') ? await patternMatches(named) : isFile(path.join(root, named))
      assert.ok(ok, `exports["${key}"] names ${named}, which does not match anything that exists`)
    }
  }

  const files = pkg.files
  assert.ok(Array.isArray(files) && files.length > 0, 'package.json files must be a non-empty list')
  const listed = files.filter((entryName): entryName is string => typeof entryName === 'string')
  assert.equal(listed.length, files.length, 'package.json files must contain only strings')
  for (const entryName of listed) {
    const ok = entryName.includes('*') ? await patternMatches(entryName) : exists(path.join(root, entryName))
    assert.ok(ok, `package.json files names ${entryName}, which does not exist`)
  }
})

await check('every suite and script is run by a package script', async () => {
  // A file nobody runs is not a check. What matters is that a script actually invokes it, not
  // that its path appears somewhere: `echo skipped test/sync.test.ts` names the file, and the
  // chain composed of the `test:*` aliases names every suite without spelling a path.
  // `live` is the one documented exception to the chain: it writes to a real GitHub account,
  // so it has its own script and is deliberately outside `npm test`.
  const testTargets = runTargets('test')
  assert.ok(testTargets.length > 0, 'the `test` script must run something')
  // The live suite is opt-in precisely because it writes to a real GitHub account: reachable
  // from `npm test`, an ordinary test run would create and delete real gists for everyone.
  assert.ok(
    !testTargets.includes('test/live.test.ts'),
    'the live suite must stay out of `npm test`; it creates and deletes gists on a real account',
  )

  for (const suite of suites) {
    if (!suite.endsWith('.test.ts')) continue
    if (suite === 'test/live.test.ts') {
      assert.ok(
        targetsEverywhere.includes(suite),
        'the opt-in live suite must still be run by a script of its own',
      )
      continue
    }
    assert.ok(
      testTargets.includes(suite),
      `${suite} is not run by \`npm test\`; only the opt-in live suite may be left out`,
    )
  }

  for (const script of scripts) {
    assert.ok(
      targetsEverywhere.includes(script),
      `${script} is not run by any package script, so nothing runs it`,
    )
  }
})

await check('the compiler flags this repository depends on are still on', async () => {
  // Each of these is load-bearing for a repository that is executed by Node's type stripper
  // rather than compiled: removing one changes what is checked, or breaks the emitted
  // imports, without failing anything else that runs here. The check config extends the
  // build config, so it is enough for it to leave a flag alone — but turning one off there
  // disables it for the type checker while the build keeps it, which is the same silent loss.
  const options = asMapping(
    asMapping(parseJsonc(await read('tsconfig.json')), 'tsconfig.json').compilerOptions,
    'tsconfig.json compilerOptions',
  )
  for (const flag of REQUIRED_FLAGS) {
    assert.equal(options[flag], true, `tsconfig.json no longer sets ${flag}`)
  }

  const checkConfig = asMapping(parseJsonc(await read('tsconfig.check.json')), 'tsconfig.check.json')
  // Inheriting is the only reason an absent flag above is acceptable: without `extends` the
  // check config has no flags at all, and the type-check half silently stops checking them.
  assert.equal(
    checkConfig.extends,
    './tsconfig.json',
    'tsconfig.check.json must extend the build config, or the flags below are inherited from nothing',
  )
  const checkOptions = asMapping(
    checkConfig.compilerOptions ?? {},
    'tsconfig.check.json compilerOptions',
  )
  for (const flag of REQUIRED_FLAGS) {
    if (checkOptions[flag] === undefined) continue
    assert.equal(checkOptions[flag], true, `tsconfig.check.json turns ${flag} off`)
  }
})

await check('the declared Node floor is the one CI runs', async () => {
  // The floor is the Harness's rather than this engine's: a plugin only runs inside a
  // Harness, and the Harness declares this exact range. So the declaration, the workflow
  // that names whose floor it is, and the leg that actually runs it have to agree — a
  // floor that is installed but skipped, or a comment mentioning it from somewhere else in
  // the file, is a claim rather than a check.
  const engines = asMapping(pkg.engines, 'package.json engines')
  assert.equal(engines.node, NODE_FLOOR, `package.json engines.node must stay ${NODE_FLOOR}`)

  const workflow = (await read('.github/workflows/ci.yml')).split('\n')
  const floorAt = workflow.findIndex((line) => new RegExp(`^\\s*node:\\s*'${NODE_FLOOR_VERSION.replace(/\./g, '\\.')}'\\s*$`).test(line))
  assert.ok(floorAt > 0, `CI must run a leg on exactly ${NODE_FLOOR_VERSION}, the floor engines names`)
  assert.ok(
    workflow.slice(Math.max(0, floorAt - 3), floorAt).some((line) => line.includes('- os: ubuntu-latest')),
    'the floor must be a matrix entry with an os, not a version that appears where nothing runs it',
  )
  assert.ok(
    workflow.slice(Math.max(0, floorAt - 14), floorAt).some((line) => line.includes('engines: ^22.19 || >=24')),
    "the comment naming whose floor this is must sit with the leg it explains, not elsewhere in the file",
  )

  const testStepAt = workflow.findIndex((line) => /^\s*run:\s+npm test\s*$/.test(line))
  assert.ok(testStepAt > 0, 'CI must run `npm test`')
  // The whole step, not just the lines above `run:`: YAML keys are unordered, so an `if:`
  // below the command is the same skip as one above it.
  assert.ok(
    !stepLines(workflow, testStepAt).some((line) => /^\s*if:/.test(line)),
    'the step that runs `npm test` must not be conditional: a skipped leg installs the floor Node and tests nothing on it',
  )

  // The boundary that slice depends on cannot be observed on a workflow that is correct, so
  // it is pinned against a fixture: the job below carries a condition, and it must not be
  // read as one on this step. The second assertion is what keeps the first honest — a scan
  // that returned nothing at all would pass it, so an `if:` inside the step has to be found.
  const workflowFixture = (insideStep: string[] = []) => [
    'jobs:',
    '  suites:',
    '    steps:',
    '      - name: Offline suites and repository checks',
    '        run: npm test',
    ...insideStep,
    '  typecheck:',
    '    if: github.event.ref == \'refs/heads/main\'',
    '    steps:',
    '      - name: Type-check the whole repository',
    '        run: npm run typecheck',
  ]
  const fixtureAt = workflowFixture().findIndex((line) => /^\s*run:\s+npm test\s*$/.test(line))
  assert.ok(fixtureAt > 0, 'the fixture must contain the step it makes a claim about')
  assert.ok(
    !stepLines(workflowFixture(), fixtureAt).some((line) => /^\s*if:/.test(line)),
    'a condition on the job after the `npm test` step must not be read as a condition on the step',
  )
  assert.ok(
    stepLines(workflowFixture(['        if: false']), fixtureAt).some((line) => /^\s*if:/.test(line)),
    'a condition inside the step that runs `npm test` must still be found',
  )
})

/* ---------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1