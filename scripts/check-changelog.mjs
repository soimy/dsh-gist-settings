#!/usr/bin/env node
/**
 * Validate CHANGELOG.md against the convention CONTRIBUTING.md documents.
 *
 * A changelog is only a mechanism if something checks it. This catches the two
 * failures that actually happen: bumping `package.json` without adding a
 * changelog entry, and a heading whose compare link was never defined.
 *
 * Checks:
 *   - an `## [Unreleased]` section exists, and carries no date;
 *   - every released heading is semver, strictly descending, and dated YYYY-MM-DD;
 *   - `package.json`'s version is one of the released headings;
 *   - every heading has exactly one link definition, and vice versa.
 *
 * Run with: node scripts/check-changelog.mjs  (also part of `npm test`)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const changelogPath = path.join(root, 'CHANGELOG.md')

const problems = []
const fail = (message) => problems.push(message)

let text
try {
  text = fs.readFileSync(changelogPath, 'utf8')
} catch {
  console.error('FAIL: CHANGELOG.md is missing.')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const lines = text.split(/\r?\n/)

/* ------------------------------------------------------------- headings -- */

const headings = []
for (const [index, line] of lines.entries()) {
  const match = /^## \[([^\]]+)\](.*)$/.exec(line)
  if (!match) continue
  const [, version, tail] = match
  const dateMatch = /^\s*-\s*(\S+)\s*$/.exec(tail)
  if (tail.trim() !== '' && !dateMatch) {
    fail(`CHANGELOG.md:${index + 1}: unexpected text after the heading: ${JSON.stringify(tail.trim())}`)
  }
  headings.push({ version, date: dateMatch?.[1] ?? null, line: index + 1 })
}

if (headings.length === 0) fail('CHANGELOG.md: no "## [version]" headings found')

const unreleased = headings.filter((h) => h.version === 'Unreleased')
if (unreleased.length === 0) fail('CHANGELOG.md: an "## [Unreleased]" section is required')
if (unreleased.length > 1) fail('CHANGELOG.md: more than one "## [Unreleased]" section')
if (unreleased[0]?.date) fail(`CHANGELOG.md:${unreleased[0].line}: [Unreleased] must not carry a date`)
if (headings[0] && headings[0].version !== 'Unreleased') {
  fail('CHANGELOG.md: the "## [Unreleased]" section must come first')
}

/* ------------------------------------------------------------- versions -- */

const semver = /^\d+\.\d+\.\d+$/
const compare = (a, b) => {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number)
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch
}

const released = headings.filter((h) => h.version !== 'Unreleased')
for (const entry of released) {
  if (!semver.test(entry.version)) {
    fail(`CHANGELOG.md:${entry.line}: "${entry.version}" is not a MAJOR.MINOR.PATCH version`)
    continue
  }
  if (!entry.date) {
    fail(`CHANGELOG.md:${entry.line}: released version ${entry.version} needs a " - YYYY-MM-DD" date`)
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    fail(`CHANGELOG.md:${entry.line}: "${entry.date}" is not a YYYY-MM-DD date`)
  } else if (Number.isNaN(Date.parse(entry.date))) {
    fail(`CHANGELOG.md:${entry.line}: "${entry.date}" is not a real date`)
  }
}

for (let i = 1; i < released.length; i += 1) {
  if (compare(released[i - 1].version, released[i].version) <= 0) {
    fail(
      `CHANGELOG.md:${released[i].line}: ${released[i].version} must sort below ${released[i - 1].version}; ` +
        'released versions are newest first',
    )
  }
}

if (semver.test(pkg.version) && !released.some((h) => h.version === pkg.version)) {
  fail(
    `package.json is at ${pkg.version} but CHANGELOG.md has no "## [${pkg.version}]" section; ` +
      'add one, or move the changes under [Unreleased]',
  )
}

/* --------------------------------------------------------- link references -- */

const defined = new Set()
for (const line of lines) {
  const match = /^\[([^\]]+)\]:\s*(\S+)\s*$/.exec(line)
  if (match) defined.add(match[1])
}

for (const heading of headings) {
  if (!defined.has(heading.version)) {
    fail(`CHANGELOG.md: no link definition for [${heading.version}] at the bottom of the file`)
  }
}
for (const label of defined) {
  if (!headings.some((h) => h.version === label)) {
    fail(`CHANGELOG.md: link definition [${label}] has no matching heading`)
  }
}

/* ------------------------------------------------------------------ report -- */

if (problems.length > 0) {
  console.error(`\nCHANGELOG.md failed ${problems.length} check${problems.length === 1 ? '' : 's'}:\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const newest = released[0]
console.log(
  `CHANGELOG.md OK: ${released.length} released version${released.length === 1 ? '' : 's'}` +
    `${newest ? `, newest ${newest.version} (${newest.date})` : ''}, plus [Unreleased].`,
)