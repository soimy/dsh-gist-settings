#!/usr/bin/env node
/**
 * Print the release notes for a tag, or refuse to.
 *
 * CONTRIBUTING.md's release steps end with "Tag `vX.Y.Z` and push the tag; the
 * GitHub release is generated from the changelog section". This is what generates
 * it, and it validates before it prints: a release published from the wrong commit,
 * or with no notes, is the kind of thing that is awkward to take back.
 *
 * Checks:
 *   - the argument is a vMAJOR.MINOR.PATCH tag;
 *   - it names the version in package.json, so a release cannot ship a version the
 *     package does not claim — the usual cause is tagging before the version bump
 *     merged;
 *   - CHANGELOG.md has a dated `## [x.y.z]` section for it;
 *   - that section is not empty, so an accidental release cannot be published with
 *     nothing in it.
 *
 * The section body goes to stdout and every problem to stderr with a non-zero exit,
 * which is what makes `node scripts/release-notes.mjs "$TAG" > notes.md` safe to
 * pipe: a failure cannot leave a plausible-looking empty file behind.
 *
 * Run with: node scripts/release-notes.mjs v1.2.3   (also `npm run release:notes`)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const problems = []
const fail = (message) => problems.push(message)

const tag = (process.argv[2] ?? '').trim()
const match = /^v(\d+\.\d+\.\d+)$/.exec(tag)
if (!tag) fail('no tag given; usage: node scripts/release-notes.mjs v1.2.3')
else if (!match) fail(`"${tag}" is not a vMAJOR.MINOR.PATCH tag`)
const version = match?.[1] ?? null

let pkg = {}
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
} catch {
  fail('package.json is missing or is not valid JSON')
}
if (version && pkg.version && pkg.version !== version) {
  fail(
    `the tag says ${version} but package.json says ${pkg.version}; a release must ship the version the ` +
      'package claims, so bump it and merge that before tagging',
  )
}

/* ----------------------------------------------------- the changelog section -- */

let body = null
let date = null
if (version) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  } catch {
    fail('CHANGELOG.md is missing')
  }
  if (text) {
    const lines = text.split(/\r?\n/)
    const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]\\s*-\\s*(\\S+)\\s*$`)
    let start = -1
    let end = lines.length
    for (const [index, line] of lines.entries()) {
      if (start === -1) {
        const found = heading.exec(line)
        if (found) {
          start = index
          date = found[1]
        }
        continue
      }
      if (/^## \[/.test(line)) {
        end = index
        break
      }
    }
    if (start === -1) {
      fail(
        `CHANGELOG.md has no dated "## [${version}] - YYYY-MM-DD" section; rename [Unreleased] to it ` +
          'before tagging',
      )
    } else {
      body = lines.slice(start + 1, end).join('\n').trim()
      if (!body) fail(`the [${version}] section of CHANGELOG.md is empty, so the release would have no notes`)
    }
  }
}

/* ------------------------------------------------------------------ report -- */

if (problems.length > 0) {
  console.error(`\nRefusing to write release notes for ${tag || '(no tag)'}:\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

process.stdout.write(`${body}\n`)
console.error(`release notes for ${tag} (${date}), ${body.split('\n').length} lines`)