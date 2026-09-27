#!/usr/bin/env node
/**
 * A stand-in for the real `gh` CLI, used only by the test suite.
 *
 * It implements the small slice of the GitHub API that `lib/core.js` touches:
 * `--version`, `auth status`, and `api` requests against `/gists`. State lives in
 * the JSON file named by `FAKE_GH_STORE`, so a test can run the full
 * upload/download/sync cycle without network access or a GitHub account.
 */

import fs from 'node:fs'

const STORE = process.env.FAKE_GH_STORE
if (!STORE) {
  process.stderr.write('FAKE_GH_STORE is not set\n')
  process.exit(2)
}

const VERSION = 'gh version 0.0.0-fake (test-double)'

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'))
  } catch {
    return { seq: 0, gists: {} }
  }
}

function save(data) {
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2), 'utf8')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function out(value) {
  process.stdout.write(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function project(gist) {
  return {
    id: gist.id,
    description: gist.description,
    public: gist.public,
    html_url: gist.html_url,
    updated_at: gist.updated_at,
    files: Object.fromEntries(
      Object.entries(gist.files).map(([name, content]) => [
        name,
        { filename: name, type: 'text/plain', language: null, size: content.length, truncated: false, content },
      ]),
    ),
  }
}

const argv = process.argv.slice(2)

if (argv[0] === '--version') {
  out(VERSION)
  process.exit(0)
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  out('github.com\n  ✓ Logged in to github.com account testuser (keyring)\n  - Active account: true')
  process.exit(0)
}

if (argv[0] !== 'api') fail(`fake gh: unsupported command "${argv.join(' ')}"`)

let method = 'GET'
let endpoint = null
let inputFromStdin = false
const rest = argv.slice(1)

for (let i = 0; i < rest.length; i += 1) {
  const token = rest[i]
  if (token === '--method' || token === '-X') {
    method = rest[i + 1]
    i += 1
  } else if (token === '--input' || token === '--input=') {
    inputFromStdin = true
    if (token === '--input') i += 1
  } else if (token === '-H' || token === '--header') {
    i += 1
  } else if (!token.startsWith('-') && endpoint === null) {
    endpoint = token
  }
}

const data = load()
const body = inputFromStdin ? JSON.parse((await readStdin()) || '{}') : null

const gistMatch = endpoint?.match(/^\/gists\/([^/?]+)$/)

if (endpoint === '/gists' && method === 'POST') {
  data.seq += 1
  const id = `gist-${data.seq}`
  const gist = {
    id,
    description: body.description ?? '',
    public: Boolean(body.public),
    html_url: `https://gist.github.com/testuser/${id}`,
    updated_at: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(body.files ?? {}).map(([n, f]) => [n, f.content])),
  }
  data.gists[id] = gist
  save(data)
  out({ id: gist.id, html_url: gist.html_url, description: gist.description })
  process.exit(0)
}

if (gistMatch) {
  const id = gistMatch[1]
  const gist = data.gists[id]
  if (!gist) fail(`fake gh: HTTP 404: Not Found (/gists/${id})`)

  if (method === 'GET') {
    out(project(gist))
    process.exit(0)
  }

  if (method === 'PATCH') {
    if (body.description !== undefined) gist.description = body.description
    for (const [name, file] of Object.entries(body.files ?? {})) {
      if (file === null) delete gist.files[name]
      else gist.files[name] = file.content
    }
    gist.updated_at = new Date().toISOString()
    save(data)
    out({ id: gist.id, html_url: gist.html_url, updated_at: gist.updated_at })
    process.exit(0)
  }

  if (method === 'DELETE') {
    delete data.gists[id]
    save(data)
    process.exit(0)
  }
}

fail(`fake gh: unhandled request ${method} ${endpoint}`)