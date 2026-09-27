#!/usr/bin/env node
/**
 * A stand-in for the real `gh` CLI, used only by the test suite.
 *
 * It implements the slice of the GitHub API that `lib/core.js` touches:
 * `--version`, `auth status`, and `api` requests against `/gists`. State lives in
 * the JSON file named by `FAKE_GH_STORE`, so a test can run the full
 * upload/download/sync cycle without network access or a GitHub account.
 *
 * Failure and edge-case injection, all optional and read from the environment:
 *
 *   FAKE_GH_STORE          path to the JSON store (required)
 *   FAKE_GH_TRUNCATE       comma-separated file names served `truncated: true`
 *                          with a `raw_url`, as real GitHub does for large files
 *   FAKE_GH_FAIL_GET       comma-separated gist ids whose GET fails with HTTP 500
 *   FAKE_GH_FAIL_GET_ALL   "1" to fail every gist GET
 *   FAKE_GH_UNAUTHENTICATED "1" to make `auth status` report a logged-out CLI
 *   FAKE_GH_FAIL_CREATE    "1" to fail every POST /gists
 */

import fs from 'node:fs'

const STORE = process.env.FAKE_GH_STORE
if (!STORE) {
  process.stderr.write('FAKE_GH_STORE is not set\n')
  process.exit(2)
}

const VERSION = 'gh version 0.0.0-fake (test-double)'
const list = (name) =>
  (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const TRUNCATE = list('FAKE_GH_TRUNCATE')
const FAIL_GET = list('FAKE_GH_FAIL_GET')

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

function rawUrlFor(gist, name) {
  return `https://gist.githubusercontent.com/testuser/${gist.id}/raw/${name}`
}

/**
 * Project a stored gist into the API shape. A file named in FAKE_GH_TRUNCATE is
 * reported the way real GitHub reports a large one: a `truncated` flag, a partial
 * `content`, and a `raw_url` carrying the rest.
 */
function project(gist) {
  return {
    id: gist.id,
    description: gist.description,
    public: gist.public,
    html_url: gist.html_url,
    updated_at: gist.updated_at,
    files: Object.fromEntries(
      Object.entries(gist.files).map(([name, content]) => {
        const truncated = TRUNCATE.includes(name) && content.length > 8
        return [
          name,
          {
            filename: name,
            type: 'text/plain',
            language: null,
            size: content.length,
            truncated,
            content: truncated ? content.slice(0, 8) : content,
            ...(truncated ? { raw_url: rawUrlFor(gist, name) } : {}),
          },
        ]
      }),
    ),
  }
}

/** Resolve a `gist.githubusercontent.com/<user>/<id>/raw/<name>` URL back to its content. */
function serveRaw(url) {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  const rawIndex = parts.indexOf('raw')
  if (rawIndex < 1 || rawIndex + 1 >= parts.length) fail(`fake gh: unrecognised raw URL ${url}`)
  const id = parts[rawIndex - 1]
  const name = parts[rawIndex + 1]
  const gist = load().gists[id]
  if (!gist || !(name in gist.files)) fail(`fake gh: HTTP 404: Not Found (${url})`)
  out(gist.files[name])
  process.exit(0)
}

const argv = process.argv.slice(2)

if (argv[0] === '--version') {
  out(VERSION)
  process.exit(0)
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  if (process.env.FAKE_GH_UNAUTHENTICATED === '1') {
    fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')
  }
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
  } else if (token === '-H' || token === '--header' || token === '--jq') {
    i += 1
  } else if (!token.startsWith('-') && endpoint === null) {
    endpoint = token
  }
}

if (endpoint?.startsWith('https://')) serveRaw(endpoint)

const data = load()
const body = inputFromStdin ? JSON.parse((await readStdin()) || '{}') : null

const gistMatch = endpoint?.match(/^\/gists\/([^/?]+)$/)

if (endpoint === '/gists' && method === 'POST') {
  if (process.env.FAKE_GH_FAIL_CREATE === '1') fail('fake gh: HTTP 503: Service Unavailable')
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
  if (!gist) fail(`fake gh: HTTP 404: Not Found (/gists/${id})`, 1)

  if (method === 'GET') {
    if (process.env.FAKE_GH_FAIL_GET_ALL === '1' || FAIL_GET.includes(id)) {
      fail('fake gh: HTTP 500: Internal Server Error')
    }
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