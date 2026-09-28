#!/usr/bin/env node
/**
 * Validate the links inside the repository's own Markdown.
 *
 * CONTRIBUTING.md requires the two READMEs to stay in step and every document to
 * reach the others by relative path. Nothing else notices when that breaks: the
 * test suites never read Markdown, and a reader who follows a link to a file that
 * was renamed or deleted just gets a 404. This walks every Markdown file in the
 * repository, resolves each relative link against the file that contains it, and
 * reports the ones that do not resolve.
 *
 * Checks:
 *   - every relative link target exists on disk;
 *   - no relative link points outside the repository;
 *   - `README.md` and `README.zh-CN.md` each link to the other, which is the
 *     pairing rule CONTRIBUTING.md states.
 *
 * Skipped, deliberately: absolute URLs and `mailto:` (not this repository's to
 * verify), `#fragment` links and the anchors inside them (they depend on how a
 * renderer builds heading ids, not on the tree), and anything inside a fenced
 * block or an inline code span, where a link-shaped string is an example rather
 * than a link.
 *
 * Run with: node scripts/check-docs.mjs  (also part of `npm test`)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Directories that are not part of the documentation tree. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees'])

const problems = []
const fail = (message) => problems.push(message)

/* --------------------------------------------------------------- discovery -- */

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), found)
    } else if (entry.name.endsWith('.md')) {
      found.push(path.join(dir, entry.name))
    }
  }
  return found
}

/** ASCII punctuation, which is what a backslash may escape in Markdown. */
const ESCAPABLE = /\\([!-/:-@[-`{-~])/g

/**
 * The path part of a destination, with its Markdown escapes resolved.
 *
 * `[x](a\(1\).md)` means the file `a(1).md`: the backslashes are escapes, not
 * characters of the name. Leaving them in reported an existing file as missing, and
 * on Windows a literal backslash also reads as a path separator, so the check was
 * looking somewhere else entirely. The fragment separator is found before
 * unescaping, so that an escaped `\#` stays part of the name.
 */
function destinationPath(raw) {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\\') {
      index += 1
      continue
    }
    if (raw[index] === '#') return raw.slice(0, index).replace(ESCAPABLE, '$1')
  }
  return raw.replace(ESCAPABLE, '$1')
}

/**
 * Every link destination in one Markdown document.
 *
 * Scanned rather than matched with one pattern, because a destination is not
 * "anything up to the first `)`": `[x](<a b.md>)` wraps it in angle brackets and
 * may contain spaces, and `[x](a(1).md)` contains balanced parentheses. A pattern
 * that stops at the first space or the first `)` does both kinds of damage — it
 * misses real links, so a destination pointing at nothing passes unchecked, and it
 * invents others, so `a(1).md` becomes `a(1` and a link that is perfectly fine
 * fails `npm test`.
 *
 * Inline links (`[text](target)`) and reference definitions (`[label]: target`)
 * both count. Code is removed first so that a document may show link syntax as an
 * example without the checker treating it as a link.
 */
function linksIn(text) {
  const stripped = text
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '')

  const targets = []
  for (let index = 0; index < stripped.length; index += 1) {
    if (stripped[index] !== ']' || stripped[index + 1] !== '(') continue
    let cursor = index + 2
    while (cursor < stripped.length && /\s/.test(stripped[cursor])) cursor += 1

    if (stripped[cursor] === '<') {
      // Angle brackets: spaces are allowed inside, a line break is not.
      const close = stripped.indexOf('>', cursor + 1)
      if (close === -1) continue
      const inner = stripped.slice(cursor + 1, close)
      if (!inner.includes('\n')) targets.push(inner)
      continue
    }

    const start = cursor
    let depth = 0
    for (; cursor < stripped.length; cursor += 1) {
      const character = stripped[cursor]
      if (character === '\\') {
        cursor += 1
      } else if (character === '(') {
        depth += 1
      } else if (character === ')') {
        if (depth === 0) break
        depth -= 1
      } else if (/\s/.test(character)) {
        break
      }
    }
    const bare = stripped.slice(start, cursor)
    if (bare !== '') targets.push(bare)
  }

  for (const match of stripped.matchAll(/^\[[^\]]+\]:\s*(?:<([^>\n]+)>|(\S+))\s*$/gm)) {
    targets.push(match[1] ?? match[2])
  }
  return targets
}

const files = walk(root).sort()
if (files.length === 0) fail('no Markdown files found; the checker would prove nothing')

/* ------------------------------------------------------------------- links -- */

let checked = 0
// Resolved once: the containment comparison has to be between real paths, or a
// symlink inside the repository satisfies it by looking like an ordinary relative
// path while pointing somewhere else entirely.
const realRoot = fs.realpathSync(root)
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  for (const raw of linksIn(fs.readFileSync(file, 'utf8'))) {
    // A scheme, a protocol-relative URL, or a fragment of this same document.
    if (raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    const target = destinationPath(raw)
    if (target === '') continue

    let decoded
    try {
      decoded = decodeURIComponent(target)
    } catch {
      fail(`${relative}: ${raw} is not valid percent-encoding`)
      continue
    }

    checked += 1
    const resolved = path.resolve(path.dirname(file), decoded)
    if (!fs.existsSync(resolved)) {
      fail(`${relative}: ${raw} does not exist`)
      continue
    }
    // Where it lands, not where it spells.
    const real = fs.realpathSync(resolved)
    const outward = path.relative(realRoot, real)
    if (outward.startsWith('..') || path.isAbsolute(outward)) {
      fail(`${relative}: ${raw} points outside the repository`)
    }
  }
}

/* ---------------------------------------------------------- the README pair -- */

const PAIR = ['README.md', 'README.zh-CN.md']
for (const from of PAIR) {
  const to = PAIR.find((name) => name !== from)
  const source = path.join(root, from)
  if (!fs.existsSync(source)) {
    fail(`${from} is missing; both READMEs are required`)
    continue
  }
  if (!linksIn(fs.readFileSync(source, 'utf8')).includes(to)) {
    fail(`${from} must link to ${to}, so a reader of either language finds the other`)
  }
}

/* ------------------------------------------------------------------ report -- */

if (problems.length > 0) {
  console.error(`\nDocumentation failed ${problems.length} check${problems.length === 1 ? '' : 's'}:\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(
  `Documentation OK: ${checked} relative link${checked === 1 ? '' : 's'} across ` +
    `${files.length} Markdown file${files.length === 1 ? '' : 's'}, none broken.`,
)