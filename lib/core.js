/**
 * Core sync engine for `dsh-gist-settings`.
 *
 * Deliberately free of any Cordis / DSH dependency: it only uses Node built-ins so
 * that the sync logic can be exercised directly with `node` before, and
 * independently of, the plugin being installed into a profile.
 *
 * Every GitHub interaction shells out to the locally installed `gh` CLI.
 * Gist reads and writes go through `gh api` rather than `gh gist edit`, because
 * `gh gist edit` opens `$EDITOR` and would hang a non-interactive plugin host.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PROFILE_FILES = ['cordis.patch.yml', 'package.json']
export const STATE_VERSION = 1

/* ------------------------------------------------------------------ paths -- */

/** Expand a leading `~` the way the Harness's own home-path resolver does. */
function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** A configured path, or `undefined` when unset or blank. Always absolute. */
function configuredPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  // Resolving matters: `~/.dsh` — the shape the Harness itself displays — and any
  // relative value would otherwise name a different tree, resolved against the
  // process cwd (the user's workspace) and written to by saveState.
  return path.resolve(expandHome(value.trim()))
}

export function resolveDshHome(config = {}) {
  return configuredPath(config.dshHome) ?? configuredPath(process.env.DSH_HOME) ?? path.join(os.homedir(), '.dsh')
}

export function resolveProfilesDir(config = {}) {
  return configuredPath(config.profilesDir) ?? path.join(resolveDshHome(config), 'profiles')
}

export function resolveStateDir(config = {}) {
  return configuredPath(config.stateDir) ?? path.join(resolveDshHome(config), 'gist-settings')
}

export function resolveProfileFiles(config = {}) {
  const files = config.profileFiles
  if (!Array.isArray(files) || files.length === 0) return [...DEFAULT_PROFILE_FILES]
  return files.map((f) => String(f))
}

async function fileExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- gh lookup -- */

/** Candidate install locations, most-specific first, for hosts without a refreshed PATH. */
function ghCandidates() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'GitHub CLI', 'gh.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
      process.env.ProgramData && path.join(process.env.ProgramData, 'chocolatey', 'bin', 'gh.exe'),
      path.join(home, 'scoop', 'shims', 'gh.exe'),
    ].filter(Boolean)
  }
  return [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    path.join(home, '.local', 'bin', 'gh'),
  ]
}

/**
 * Locate a working `gh` executable.
 * Order: explicit config -> PATH -> well-known install dirs.
 * Returns `{ path, version }` or `{ path: null, reason }`.
 */
export async function resolveGh(config = {}) {
  const tried = []

  const probe = async (candidate, label) => {
    tried.push(candidate)
    const res = await ghRun(candidate, ['--version'])
    if (res.code === 0) {
      const version = res.stdout.split('\n')[0].trim()
      return { path: candidate, version, tried }
    }
    return null
  }

  if (config.ghPath) {
    const [command] = ghCommandParts(config.ghPath)
    const isBareName = !command.includes(path.sep) && !command.includes('/')
    if (!isBareName && !(await fileExists(command))) {
      return { path: null, reason: `configured ghPath does not exist: ${command}`, tried }
    }
    const found = await probe(config.ghPath, 'config')
    if (found) return found
    return { path: null, reason: `configured ghPath is not runnable: ${command}`, tried }
  }

  const onPath = await probe('gh', 'PATH')
  if (onPath) return onPath

  for (const candidate of ghCandidates()) {
    if (!(await fileExists(candidate))) continue
    const found = await probe(candidate, 'well-known')
    if (found) return found
  }

  return {
    path: null,
    reason: 'gh CLI not found on PATH or in any well-known install location',
    tried,
  }
}

/* ------------------------------------------------------------- gh process -- */

/**
 * Normalize a `ghPath` into `[command, ...prefixArgs]`.
 * A plain string is the normal case; an array lets a caller route gh through a
 * wrapper (`['wsl', 'gh']`, a shim script, or a test double).
 */
export function ghCommandParts(ghPath) {
  return Array.isArray(ghPath) ? ghPath.map(String) : [String(ghPath)]
}

/** Run `gh` and capture output. Never rejects on a non-zero exit; inspect `code`. */
export function ghRun(ghPath, args, { input, cwd, timeout = 60_000, signal } = {}) {
  const [command, ...prefix] = ghCommandParts(ghPath)
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        command,
        [...prefix, ...args],
        {
          cwd,
          timeout,
          signal,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8',
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        },
        (error, stdout, stderr) => {
          if (error && error.code === 'ENOENT') {
            resolve({ code: 127, stdout: '', stderr: `${command}: not found` })
            return
          }
          const code = error?.code ?? (error ? 1 : 0)
          resolve({
            code: typeof code === 'number' ? code : 1,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            timedOut: Boolean(error?.killed),
          })
        },
      )
    } catch (error) {
      // execFile throws synchronously for a command it refuses to spawn at all
      // (a `.cmd`/`.bat` shim on Windows, an invalid path). Callers expect a
      // result object, never a rejection.
      resolve({ code: 127, stdout: '', stderr: `${command}: ${error.message}`, spawnFailed: true })
      return
    }
    if (input !== undefined) {
      // When the child exits before draining stdin — `gh` failing on a bad host,
      // expired credentials, an unknown flag, i.e. exactly when the machine is
      // offline — writing a body larger than the OS pipe buffer (64 KiB on
      // Windows) fails with EPIPE/EOF. An `error` event with no listener is an
      // uncaught exception that takes the whole host process down, so the
      // listener is not optional.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

/** Run `gh` and parse stdout as JSON, raising a useful error when that fails. */
async function ghJson(ghPath, args, opts = {}) {
  const res = await ghRun(ghPath, args, opts)
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || `gh exited with code ${res.code}`
    const err = new Error(detail)
    err.code = res.code
    err.stderr = res.stderr
    // gh reports a deleted gist and a bad token with the same shape (exit 1, a
    // message on stderr). Only a real HTTP 404 may be read as "the gist is
    // gone"; treating a 401, a 5xx, a rate limit, a DNS failure or an oversized
    // response the same way would let one network blip silently mint a
    // replacement gist and abandon the original.
    err.notFound = /HTTP 404|Not Found/i.test(detail)
    throw err
  }
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`gh returned non-JSON output for: gh ${args.join(' ')}`)
  }
}

/* ------------------------------------------------------------------- auth -- */

export async function checkAuth(ghPath) {
  const res = await ghRun(ghPath, ['auth', 'status'])
  const output = `${res.stdout}${res.stderr}`
  const authenticated = res.code === 0 && /Logged in to/i.test(output)
  const account = output.match(/account\s+(\S+)/i)?.[1] ?? null
  return { authenticated, account, output: output.trim() }
}

/* --------------------------------------------------------------- profiles -- */

/** List profile directory names, skipping the shared `node_modules` store. */
export async function listProfiles(config = {}) {
  const dir = resolveProfilesDir(config)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/**
 * Resolve one profile directory, refusing anything that escapes `profilesDir`.
 *
 * The tool layer's name check is lexical: it cannot see a junction or symlink
 * placed at `profiles/<name>` pointing elsewhere on disk. Uploading such a
 * "profile" would publish files from outside the profiles directory to a gist,
 * and downloading into it would overwrite them, so containment is re-checked
 * against real paths here.
 */
export async function resolveProfileDir(profile, config = {}) {
  const root = resolveProfilesDir(config)
  const candidate = path.join(root, profile)
  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(root).catch(() => path.resolve(root)),
    fs.realpath(candidate).catch(() => path.resolve(candidate)),
  ])
  const relative = path.relative(realRoot, realCandidate)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `profile "${profile}" resolves outside the profiles directory (${realCandidate}); ` +
        'refusing to read or write it',
    )
  }
  return candidate
}

/** Read the tracked files of one profile. Missing files are reported, not fatal. */
export async function collectProfile(profile, config = {}) {
  const dir = await resolveProfileDir(profile, config)
  const wanted = resolveProfileFiles(config)
  const files = {}
  const missing = []
  for (const name of wanted) {
    const target = path.join(dir, name)
    try {
      files[name] = await fs.readFile(target, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(name)
      else throw error
    }
  }
  return { dir, files, missing }
}

/** Stable content hash over a `{ filename: content }` map. */
export function hashFiles(files) {
  const hash = createHash('sha256')
  for (const name of Object.keys(files).sort()) {
    hash.update(name)
    hash.update('\0')
    hash.update(files[name])
    hash.update('\0')
  }
  return hash.digest('hex')
}

/* ------------------------------------------------------------------ state -- */

function statePath(config = {}) {
  return path.join(resolveStateDir(config), 'state.json')
}

/**
 * The id is interpolated into a `gh api` endpoint, so it is validated before it
 * is sent: alphanumerics and inner hyphens only, which rules out a leading
 * hyphen (flag injection) and any path separator. Real GitHub gist ids are
 * 32-character hex and match this comfortably.
 */
const GIST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export async function loadState(config = {}) {
  const target = statePath(config)
  let raw
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: STATE_VERSION, profiles: {} }
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `${target} is not valid JSON, so no profile can be resolved. Fix or move it aside; ` +
        'the gists it named still exist on GitHub.',
    )
  }

  // A hand-edited or half-written file must not turn into silent misbehaviour:
  // `profiles: null` throws deep inside a tool, and an array accepts named
  // properties that never serialise, so every upload would mint a fresh gist.
  const profiles = parsed?.profiles
  if (profiles !== undefined && (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles))) {
    throw new Error(`${target} has an invalid "profiles" section; expected an object keyed by profile name.`)
  }

  const clean = {}
  for (const [name, record] of Object.entries(profiles ?? {})) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`${target}: record for profile "${name}" is not an object.`)
    }
    if (!record.gistId) continue
    if (typeof record.gistId !== 'string' || !GIST_ID_PATTERN.test(record.gistId)) {
      // The id is interpolated into a `gh api` endpoint, so a malformed one is
      // refused rather than sent.
      throw new Error(
        `${target}: profile "${name}" has an invalid gistId ${JSON.stringify(record.gistId)}; ` +
          'expected an alphanumeric gist id.',
      )
    }
    clean[name] = record
  }
  return { version: STATE_VERSION, ...parsed, profiles: clean }
}

/**
 * Serialize read-modify-write cycles over state.json within this process.
 *
 * An agent routinely issues tool calls in parallel. Two uploads racing on
 * load-modify-save would each see the old file and the later write would drop
 * the earlier profile's record — untracking it and orphaning its gist.
 */
let stateLock = Promise.resolve()

export async function withStateLock(fn) {
  const previous = stateLock
  let release
  stateLock = new Promise((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function saveState(state, config = {}) {
  const dir = resolveStateDir(config)
  await fs.mkdir(dir, { recursive: true })
  const target = statePath(config)
  // A per-writer temp name: two processes sharing one fixed name could interleave
  // their writes and rename a half-written file into place.
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  // Keep the previous revision so a bad write is recoverable by hand.
  await fs.copyFile(target, `${target}.bak`).catch(() => {})
  await fs.rename(tmp, target)
  return target
}

/* ------------------------------------------------------------- gist calls -- */

/** Create a secret gist. Returns `{ id, url, files }`. */
export async function gistCreate(ghPath, { description, files, isPublic = false, signal } = {}) {
  const body = JSON.stringify({
    description,
    public: isPublic,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
  })
  const result = await ghJson(
    ghPath,
    ['api', '--method', 'POST', '/gists', '-H', 'Content-Type: application/json', '--input', '-'],
    { input: body, signal },
  )
  return { id: result.id, url: result.html_url, description: result.description }
}

/** Whether a response-provided `raw_url` may be followed. */
function isTrustedRawUrl(value) {
  if (typeof value !== 'string') return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = url.hostname
  return (
    url.protocol === 'https:' &&
    (host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com'))
  )
}

/** Fetch a gist. Large files come back with `truncated: true`; those download via `raw_url`. */
export async function gistGet(ghPath, gistId, { signal } = {}) {
  const result = await ghJson(ghPath, ['api', `/gists/${gistId}`], { signal })
  const files = {}
  const truncated = []
  for (const [name, meta] of Object.entries(result.files ?? {})) {
    if (meta.truncated) {
      // `raw_url` comes from a response body and is fetched with the user's
      // credentials, so it is only followed back to a GitHub host over https.
      if (!isTrustedRawUrl(meta.raw_url)) {
        throw new Error(
          `gist file "${name}" is truncated and its raw_url is not a trusted GitHub URL; refusing to follow it`,
        )
      }
      truncated.push(name)
      const res = await ghRun(ghPath, ['api', meta.raw_url], { signal })
      if (res.code !== 0) throw new Error(`failed to fetch raw content of ${name}`)
      files[name] = res.stdout
    } else {
      files[name] = meta.content ?? ''
    }
  }
  return {
    id: result.id,
    url: result.html_url,
    description: result.description,
    updatedAt: result.updated_at,
    files,
    truncated,
  }
}

/** Patch a gist. Pass `null` as a file's value to delete it. */
export async function gistPatch(ghPath, gistId, { description, files, signal } = {}) {
  const payload = {}
  if (description !== undefined) payload.description = description
  if (files) {
    payload.files = Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, content === null ? null : { content }]),
    )
  }
  const result = await ghJson(
    ghPath,
    ['api', '--method', 'PATCH', `/gists/${gistId}`, '-H', 'Content-Type: application/json', '--input', '-'],
    { input: JSON.stringify(payload), signal },
  )
  return { id: result.id, url: result.html_url, updatedAt: result.updated_at }
}

export async function gistDelete(ghPath, gistId) {
  const res = await ghRun(ghPath, ['api', '--method', 'DELETE', `/gists/${gistId}`])
  if (res.code !== 0) throw new Error((res.stderr || '').trim() || 'failed to delete gist')
}

/* -------------------------------------------------------------- the verbs -- */

export function defaultDescription(profile) {
  return `DeepSeek Harness profile config: ${profile}`
}

/**
 * Compare one profile against its tracked gist without changing profile files.
 *
 * Status: untracked | in-sync | local-ahead | remote-ahead | diverged |
 *         missing-local | missing-gist | unreachable
 *
 * Only the tracked subset of the gist is compared, because that is the only
 * subset the writers manage: hashing every remote file would make a gist that
 * holds one extra file — a note added through the GitHub web UI, say — report
 * `remote-ahead` forever, and every sync would "download" without converging.
 *
 * When both sides already agree this repairs a stale baseline in the state
 * file. It never touches profile files or the gist.
 */
export async function profileStatus(profile, { ghPath, config = {}, state, signal } = {}) {
  const current = state ?? (await loadState(config))
  const record = current.profiles?.[profile]
  const trackedNames = resolveProfileFiles(config)
  const { files, missing, dir } = await collectProfile(profile, config)
  const localHash = hashFiles(files)

  // No gist yet. An empty directory is handled by syncProfile, which downloads.
  if (!record?.gistId) {
    const status = Object.keys(files).length === 0 ? 'missing-local' : 'untracked'
    return { profile, dir, status, missing, localHash, gistId: null, localFiles: Object.keys(files) }
  }

  let remote
  try {
    remote = await gistGet(ghPath, record.gistId, { signal })
  } catch (error) {
    if (!error.notFound) {
      // A 401, a 5xx, a rate limit, a DNS failure: the gist may be perfectly
      // intact. Calling this "deleted" is exactly what would make a later
      // upload mint a replacement and abandon the original.
      return {
        profile,
        dir,
        status: 'unreachable',
        missing,
        localHash,
        gistId: record.gistId,
        gistUrl: record.gistUrl ?? null,
        error: error.message,
      }
    }
    return {
      profile,
      dir,
      status: 'missing-gist',
      missing,
      localHash,
      gistId: record.gistId,
      gistUrl: record.gistUrl ?? null,
    }
  }

  const remoteTracked = Object.fromEntries(
    Object.entries(remote.files).filter(([name]) => trackedNames.includes(name)),
  )
  const remoteHash = hashFiles(remoteTracked)
  const baseline = record.lastSyncedHash ?? null

  // A tracked file that is gone locally but still present in the gist: an
  // upload would delete the only remaining copy. This is the one asymmetry the
  // tools must not resolve on their own.
  const restorable = missing.filter((name) => name in remote.files)

  let status
  if (restorable.length > 0) {
    status = 'missing-local'
  } else if (localHash === remoteHash) {
    status = 'in-sync'
  } else if (!baseline) {
    status = 'diverged'
  } else {
    const localChanged = baseline !== localHash
    const remoteChanged = baseline !== remoteHash
    if (localChanged && remoteChanged) status = 'diverged'
    else if (localChanged) status = 'local-ahead'
    else if (remoteChanged) status = 'remote-ahead'
    else status = 'diverged'
  }

  if (status === 'in-sync' && baseline !== localHash) {
    // Both sides already agree, so the recorded baseline is merely stale — an
    // edit made and uploaded on another machine, or a state write that failed.
    // Left stale, the NEXT ordinary edit would be misread as a divergence and
    // refused, pushing the user to `force`, which would clobber the other side.
    await withStateLock(async () => {
      const latest = await loadState(config)
      const entry = latest.profiles?.[profile]
      if (entry) {
        entry.lastSyncedHash = localHash
        entry.lastSyncAt = new Date().toISOString()
        await saveState(latest, config)
        current.profiles[profile] = entry
      }
    })
  }

  return {
    profile,
    dir,
    status,
    missing,
    restorable,
    localHash,
    remoteHash,
    baseline,
    gistId: record.gistId,
    gistUrl: remote.url,
    gistUpdatedAt: remote.updatedAt,
    localFiles: Object.keys(files),
    remoteFiles: Object.keys(remoteTracked),
    untrackedRemoteFiles: Object.keys(remote.files).filter((name) => !trackedNames.includes(name)),
    description: remote.description,
  }
}

export async function statusAll({ ghPath, config = {} } = {}) {
  const state = await loadState(config)
  const profiles = await listProfiles(config)
  const rows = []
  for (const profile of profiles) {
    rows.push(await profileStatus(profile, { ghPath, config, state }))
  }
  return { profiles: rows, statePath: statePath(config) }
}

/** Back up the profile's tracked files before any destructive write. */
async function backupProfile(profile, config = {}) {
  const { files } = await collectProfile(profile, config)
  if (Object.keys(files).length === 0) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(resolveStateDir(config), 'backups', profile, stamp)
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8')
  }
  return dir
}

/**
 * Push local profile config to its gist, creating the gist on first upload.
 *
 * Pruning removes remote files that are no longer TRACKED — absent from
 * `profileFiles`. It must never remove a tracked file that merely happens to be
 * missing from disk: the gist may hold the only remaining copy, and an
 * accidental local delete would otherwise propagate into the backup silently.
 *
 * A gist read that fails for any reason other than a real 404 aborts the
 * upload, because minting a replacement would fork the backup and abandon the
 * original while other machines kept syncing to it.
 */
export async function uploadProfile(
  profile,
  { ghPath, config = {}, description, force = false, signal } = {},
) {
  return withStateLock(async () => {
    const state = await loadState(config)
    const trackedNames = resolveProfileFiles(config)
    const { files, missing, dir } = await collectProfile(profile, config)
    if (Object.keys(files).length === 0) {
      throw new Error(`profile "${profile}" has none of the tracked files in ${dir}`)
    }

    const record = state.profiles[profile]
    const desc = description || record?.description || defaultDescription(profile)
    let gistId = record?.gistId
    let url = record?.gistUrl
    let created = false
    let replaced = null
    const pruned = []

    if (gistId) {
      let existing = null
      try {
        existing = await gistGet(ghPath, gistId, { signal })
      } catch (error) {
        if (!error.notFound) {
          throw new Error(
            `could not read gist ${gistId} for profile "${profile}": ${error.message}. Refusing to ` +
              'create a replacement gist, which would abandon the existing backup; retry when reachable.',
          )
        }
      }

      if (existing) {
        const lost = missing.filter((name) => name in existing.files)
        if (lost.length > 0 && !force) {
          throw new Error(
            `refusing to upload "${profile}": ${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} ` +
              'missing locally but still present in the gist, so uploading would delete the only ' +
              'remaining copy. Run gist_download to restore them, or pass force to drop them from the gist too.',
          )
        }
        for (const name of Object.keys(existing.files)) {
          if (!trackedNames.includes(name)) pruned.push(name)
        }
        const removals = Object.fromEntries(pruned.map((name) => [name, null]))
        signal?.throwIfAborted()
        const patched = await gistPatch(ghPath, gistId, {
          description: desc,
          files: { ...files, ...removals },
          signal,
        })
        url = patched.url
      } else {
        // A genuine 404: the gist is gone and this machine holds the only copy.
        replaced = record.gistUrl ?? null
        gistId = undefined
      }
    }

    if (!gistId) {
      signal?.throwIfAborted()
      const fresh = await gistCreate(ghPath, { description: desc, files, signal })
      gistId = fresh.id
      url = fresh.url
      created = true
    }

    const localHash = hashFiles(files)
    state.profiles[profile] = {
      gistId,
      gistUrl: url,
      description: desc,
      files: Object.keys(files),
      lastSyncedHash: localHash,
      lastSyncAt: new Date().toISOString(),
      lastDirection: 'upload',
    }
    state.version = STATE_VERSION
    await saveState(state, config)

    return {
      profile,
      gistId,
      gistUrl: url,
      created,
      replaced,
      pruned,
      uploadedFiles: Object.keys(files),
      missing,
      localHash,
    }
  })
}

/** Whether every local tracked file is byte-identical to its counterpart in the gist. */
function localIsSubsetOfRemote(localFiles, remoteFiles) {
  return Object.keys(localFiles).every(
    (name) => name in remoteFiles && remoteFiles[name] === localFiles[name],
  )
}

/**
 * Pull the gist content down over the local profile files, after backing them up.
 *
 * `lastSyncedHash` records the remote content this machine last agreed on, which
 * is what keeps the classifier converging: if the gist is missing a tracked file
 * that exists locally, the recorded baseline differs from the local hash, so the
 * next sync reports `local-ahead` and uploads it back rather than looping on
 * downloads that cannot change anything.
 */
export async function downloadProfile(profile, { ghPath, config = {}, force = false, signal } = {}) {
  return withStateLock(async () => {
    const state = await loadState(config)
    const record = state.profiles?.[profile]
    if (!record?.gistId) {
      throw new Error(`profile "${profile}" is not tracked yet; run an upload first to create its gist`)
    }

    const remote = await gistGet(ghPath, record.gistId, { signal })
    const trackedNames = resolveProfileFiles(config)
    const remoteFiles = Object.fromEntries(
      Object.entries(remote.files).filter(([name]) => trackedNames.includes(name)),
    )
    if (Object.keys(remoteFiles).length === 0) {
      throw new Error(
        `gist ${record.gistId} holds none of the tracked files for profile "${profile}". ` +
          'Run gist_upload to repopulate it from this machine.',
      )
    }

    const { files: localFiles } = await collectProfile(profile, config)
    const localHash = hashFiles(localFiles)
    const remoteHash = hashFiles(remoteFiles)
    const baseline = record.lastSyncedHash ?? null

    // Restoring files that are merely absent locally discards nothing, so it
    // does not need force — that is the whole point of a backup.
    const restoringOnly = localIsSubsetOfRemote(localFiles, remoteFiles)

    if (localHash !== remoteHash && !force && !restoringOnly) {
      if (!baseline) {
        throw new Error(
          `profile "${profile}" has no recorded baseline and its local files differ from the gist, so a ` +
            'download cannot be proven safe. Re-run with force to overwrite local files (a backup is taken first).',
        )
      }
      if (localHash !== baseline && remoteHash !== baseline) {
        throw new Error(
          `profile "${profile}" has diverged: both local and gist changed since the last sync. ` +
            'Re-run with force to overwrite local files (a backup is taken first).',
        )
      }
      if (localHash !== baseline && remoteHash === baseline) {
        throw new Error(
          `local "${profile}" has unsynced changes; downloading would discard them. ` +
            'Upload them, or re-run with force (a backup is taken first).',
        )
      }
    }

    const backupDir = await backupProfile(profile, config)
    // Aborting after the backup but before the first write leaves the profile
    // untouched, which is the point: a cancelled call must not half-apply.
    signal?.throwIfAborted()
    const dir = await resolveProfileDir(profile, config)
    await fs.mkdir(dir, { recursive: true })
    const written = []
    for (const [name, content] of Object.entries(remoteFiles)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8')
      written.push(name)
    }

    // Tracked files the gist does not carry are reported, never deleted: the
    // user may still want them, and the next upload adds them back.
    const keptLocally = Object.keys(localFiles).filter((name) => !(name in remoteFiles))

    state.profiles[profile] = {
      ...record,
      gistUrl: remote.url,
      description: remote.description ?? record.description,
      files: [...new Set([...written, ...keptLocally])].sort(),
      lastSyncedHash: remoteHash,
      lastSyncAt: new Date().toISOString(),
      lastDirection: 'download',
    }
    await saveState(state, config)

    return { profile, gistId: record.gistId, gistUrl: remote.url, written, keptLocally, backupDir, remoteHash }
  })
}

/**
 * One-step bidirectional sync.
 * Fast-forwards whichever side changed; refuses to guess on a true divergence.
 */
export async function syncProfile(profile, { ghPath, config = {}, force = false, signal } = {}) {
  const status = await profileStatus(profile, { ghPath, config, signal })
  const settle = (action, result) => ({ profile, action, nextStatus: status.status, ...result })

  switch (status.status) {
    case 'untracked':
    case 'missing-gist':
      return settle('created', await uploadProfile(profile, { ghPath, config, signal }))
    case 'in-sync':
      return { profile, action: 'noop', gistId: status.gistId, gistUrl: status.gistUrl }
    case 'local-ahead':
      return settle('uploaded', await uploadProfile(profile, { ghPath, config, signal }))
    case 'remote-ahead':
      return settle('downloaded', await downloadProfile(profile, { ghPath, config, signal }))
    case 'diverged':
      if (!force) {
        throw new Error(
          `profile "${profile}" has diverged: local and gist both changed since the last sync. ` +
            'Choose upload or download explicitly, or re-run with force.',
        )
      }
      return settle('forced-upload', await uploadProfile(profile, { ghPath, config, force: true, signal }))
    case 'missing-local':
      if (!status.gistId) {
        throw new Error(
          `profile "${profile}" has no local config files and no gist to restore them from. ` +
            'Restore the files, or delete the profile directory if it is obsolete.',
        )
      }
      // No force: downloadProfile restores missing files freely but still
      // refuses to discard unsynced local edits.
      return settle('downloaded', await downloadProfile(profile, { ghPath, config, signal }))
    case 'unreachable':
      throw new Error(
        `profile "${profile}": cannot read gist ${status.gistId} (${status.error}). Refusing to sync, ` +
          'because creating a replacement would abandon the existing backup.',
      )
    default:
      throw new Error(`unhandled status "${status.status}" for profile "${profile}"`)
  }
}

export async function syncAll({ ghPath, config = {}, force = false, signal } = {}) {
  const profiles = await listProfiles(config)
  const results = []
  for (const profile of profiles) {
    try {
      results.push({ ok: true, ...(await syncProfile(profile, { ghPath, config, force, signal })) })
    } catch (error) {
      results.push({ ok: false, profile, error: error.message })
    }
  }
  return results
}

/**
 * Health report used by both the `gist_status` tool and the settings page.
 * Paths are reported even when gh is missing, so the tool can still show what
 * it tracks instead of claiming every profile is untracked.
 */
export async function health(config = {}) {
  const paths = {
    dshHome: resolveDshHome(config),
    profilesDir: resolveProfilesDir(config),
    stateDir: resolveStateDir(config),
    statePath: statePath(config),
    trackedFiles: resolveProfileFiles(config),
  }
  const resolved = await resolveGh(config)
  if (!resolved.path) {
    return { gh: { found: false, reason: resolved.reason, tried: resolved.tried }, auth: null, ...paths }
  }
  const auth = await checkAuth(resolved.path)
  return {
    gh: { found: true, path: resolved.path, version: resolved.version },
    auth,
    ...paths,
  }
}