#!/usr/bin/env node
/**
 * Exercise the documentation checker.
 *
 * `scripts/check-docs.mjs` runs as part of `npm test`, so a bug in it fails the
 * build for the wrong reason — and, worse, a bug that makes it miss a link lets a
 * broken document through while nobody notices. Both have happened: destinations
 * wrapped in angle brackets were truncated at the space, destinations containing
 * balanced parentheses were cut at the first `)`, Markdown backslash escapes were
 * left in the path, and containment compared the spelled path so a link through an
 * in-repo symlink reached outside the repository.
 *
 * Each case builds a miniature checkout: the two cross-linked READMEs the checker
 * requires, so the only thing under test is the case's own link.
 *
 * Run with: node test/docs.test.mjs  (also part of `npm test`)
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'check-docs.mjs')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gist-docs-'))

/** Build a checkout whose only interesting content is `body` in notes.md. */
async function checkout(body, { extra = async () => {} } = {}) {
  const dir = await fs.mkdtemp(path.join(root, 'case-'))
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true })
  await fs.copyFile(script, path.join(dir, 'scripts', 'check-docs.mjs'))
  await extra(dir)
  await fs.writeFile(path.join(dir, 'README.md'), '[中文](README.zh-CN.md)\n\n[notes](notes.md)\n')
  await fs.writeFile(path.join(dir, 'README.zh-CN.md'), '[English](README.md)\n')
  await fs.writeFile(path.join(dir, 'notes.md'), `${body}\n`)
  return dir
}

async function checkDocs(dir) {
  try {
    const { stdout } = await run(process.execPath, ['scripts/check-docs.mjs'], { cwd: dir })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** A directory link that needs no privilege on either platform. */
function linkDirectory(target, at) {
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', at, target], { stdio: 'ignore' })
  } else {
    execFileSync('ln', ['-s', target, at])
  }
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

/* ------------------------------------------------------------------ cases -- */

await check('a link to a file that does not exist is refused', async () => {
  const { code, output } = await checkDocs(await checkout('[x](docs/missing.md)'))
  assert.equal(code, 1)
  assert.match(output, /does not exist/)
})

await check('an angle-bracket destination containing a space resolves', async () => {
  const dir = await checkout('[x](<a b.md>)', {
    extra: (where) => fs.writeFile(path.join(where, 'a b.md'), 'hello\n'),
  })
  assert.equal((await checkDocs(dir)).code, 0)
})

await check('an angle-bracket destination that does not exist is refused', async () => {
  const { code, output } = await checkDocs(await checkout('[x](<missing file.md>)'))
  assert.equal(code, 1)
  assert.match(output, /does not exist/)
})

await check('a destination with balanced parentheses resolves', async () => {
  const dir = await checkout('[x](a(1).md)', {
    extra: (where) => fs.writeFile(path.join(where, 'a(1).md'), 'hello\n'),
  })
  assert.equal((await checkDocs(dir)).code, 0, 'a link to a file that exists must not fail the build')
})

await check('a destination with escaped parentheses resolves', async () => {
  const dir = await checkout('[x](a\\(1\\).md)', {
    extra: (where) => fs.writeFile(path.join(where, 'a(1).md'), 'hello\n'),
  })
  assert.equal(
    (await checkDocs(dir)).code,
    0,
    'the escapes belong to Markdown, not to the file name',
  )
})

await check('an escaped destination that does not exist is refused', async () => {
  const { code } = await checkDocs(await checkout('[x](a\\(1\\).md)'))
  assert.equal(code, 1)
})

await check('an escaped hash stays part of the name', async () => {
  const dir = await checkout('[x](a\\#b.md)', {
    extra: (where) => fs.writeFile(path.join(where, 'a#b.md'), 'hello\n'),
  })
  assert.equal((await checkDocs(dir)).code, 0)
})

await check('a link through an in-repo directory link to an outside file is refused', async () => {
  let outside = null
  const dir = await checkout('[x](link/secret.md)', {
    extra: async (where) => {
      outside = path.join(path.dirname(where), 'outside')
      await fs.mkdir(outside, { recursive: true })
      await fs.writeFile(path.join(outside, 'secret.md'), 'secret\n')
      linkDirectory(outside, path.join(where, 'link'))
    },
  })
  const { code, output } = await checkDocs(dir)
  assert.equal(code, 1)
  assert.match(output, /points outside the repository/)
  assert.ok(outside, 'the fixture must have been built')
})

await check('a direct link to an outside file is refused', async () => {
  const dir = await checkout('[x](../outside.md)', {
    extra: (where) => fs.writeFile(path.join(path.dirname(where), 'outside.md'), 'secret\n'),
  })
  const { code, output } = await checkDocs(dir)
  assert.equal(code, 1)
  assert.match(output, /points outside the repository/)
})

await check('link-shaped text inside a code span is ignored', async () => {
  assert.equal((await checkDocs(await checkout('Write it as `[x](nope.md)`.'))).code, 0)
})

await check('a reference definition pointing outside is refused', async () => {
  const dir = await checkout('See [the guide][g].\n\n[g]: ../outside.md', {
    extra: (where) => fs.writeFile(path.join(path.dirname(where), 'outside.md'), 'secret\n'),
  })
  assert.equal((await checkDocs(dir)).code, 1)
})

await check('a reference definition with an angle-bracket destination resolves', async () => {
  const dir = await checkout('See [the guide][g].\n\n[g]: <a b.md>', {
    extra: (where) => fs.writeFile(path.join(where, 'a b.md'), 'hello\n'),
  })
  assert.equal((await checkDocs(dir)).code, 0)
})

await check('a missing README pairing is refused', async () => {
  const dir = await fs.mkdtemp(path.join(root, 'pair-'))
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true })
  await fs.copyFile(script, path.join(dir, 'scripts', 'check-docs.mjs'))
  await fs.writeFile(path.join(dir, 'README.md'), 'no pairing here\n')
  const { code, output } = await checkDocs(dir)
  assert.equal(code, 1)
  assert.match(output, /must link to README\.zh-CN\.md/)
})

/* ----------------------------------------------------------------- summary -- */

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true })