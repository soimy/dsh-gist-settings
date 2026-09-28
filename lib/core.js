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

import { AsyncLocalStorage } from 'node:async_hooks'
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

/**
 * Characters that can never appear in a tracked file name.
 *
 * `:` is refused because on Windows it introduces a drive-relative path
 * (`C:file`) or an alternate data stream (`file:stream`); the rest are illegal
 * in a Windows file name anyway, so refusing them costs nothing and keeps one
 * name meaning one file on every platform.
 */
const TRACKED_NAME_FORBIDDEN = /[\0:*?"<>|]/

/**
 * Canonicalise one entry of `profileFiles`, or refuse it.
 *
 * A tracked name is used three ways at once: as a path inside the profile
 * directory, as the file's key in the gist, and as a path inside a backup
 * directory. It therefore has to be a plain relative path — an absolute name, a
 * `..` segment or a drive-relative prefix would make the plugin publish, or
 * overwrite, a file outside the tree the README promises it stays inside.
 *
 * It also has to be a **single** name, with no separator, because a gist is a flat
 * collection of files rather than a tree: GitHub answers a filename containing a
 * slash with `HTTP 422 Validation Failed`, and that filename is exactly what has to
 * be sent. A backslash is legal in a gist filename but is a separator on Windows,
 * so accepting it would mean one name for the local path and another for the gist.
 * Rejecting both keeps one name meaning one file everywhere. `test/live.test.mjs`
 * pins the API behaviour, so this can be revisited if GitHub ever allows it.
 *
 * The check refuses rather than repairs: `a/../b` is an error, not a quiet rewrite
 * to `b`, because a name that means one thing to us and another to whoever
 * normalises it differently is exactly the ambiguity this plugin avoids elsewhere.
 */
export function normalizeTrackedName(value) {
  const reject = (why) => {
    throw new Error(
      `invalid tracked file name ${JSON.stringify(value)}: ${why}. An entry of profileFiles names one ` +
        'file directly inside the profile directory — and that same name is the file\'s name in the ' +
        'gist — for example "cordis.patch.yml".',
    )
  }
  if (typeof value !== 'string') reject(`it is a ${typeof value}, not a string`)
  else if (value === '') reject('it is empty')
  if (TRACKED_NAME_FORBIDDEN.test(value)) {
    reject('it contains one of the reserved characters : * ? " < > | or a NUL byte')
  }
  if (value.includes('/')) reject('it contains a slash, and a gist cannot hold a directory')
  if (value.includes('\\')) reject('it contains a backslash, which separates paths on Windows')
  if (value === '.' || value === '..') reject(`it is the path segment "${value}"`)
  // Windows strips a trailing dot or space from a name it creates, so "a. " and
  // "a" would be two spellings of one file.
  if (value !== value.trim() || value.endsWith('.')) {
    reject('it starts or ends with a space or a dot')
  }
  return value
}

export function resolveProfileFiles(config = {}) {
  const files = config.profileFiles
  if (!Array.isArray(files) || files.length === 0) return [...DEFAULT_PROFILE_FILES]
  const names = files.map((file) => normalizeTrackedName(file))
  // Two entries that name one file would leave one of them unreachable while the
  // writers used the other. A name is a single segment, so the only way two entries
  // collide is by spelling: a case difference where the filesystem folds case, and
  // the two Unicode spellings macOS hands out interchangeably. NFC folding applies
  // only where the filesystem normalises, because NTFS stores names verbatim and
  // there the two spellings really are two different files.
  const foldsCase = process.platform === 'win32' || process.platform === 'darwin'
  const foldsUnicode = process.platform === 'darwin'
  const seen = new Map()
  for (const name of names) {
    let key = name
    if (foldsUnicode) key = key.normalize('NFC')
    if (foldsCase) key = key.toLowerCase()
    const previous = seen.get(key)
    if (previous !== undefined) {
      throw new Error(
        `duplicate tracked file name: ${JSON.stringify(previous)} and ${JSON.stringify(name)} name ` +
          `the same file${foldsCase ? ' on this platform' : ''}`,
      )
    }
    seen.set(key, name)
  }
  return names
}

async function fileExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * `realpath`, tolerating a path whose last components do not exist yet.
 *
 * The tail is resolved from the nearest ancestor that *does* exist and then
 * appended. This matters when a parent directory is itself a link — the common
 * "move `~/.dsh` to another drive and leave a junction behind" setup. Falling back
 * to the plain lexical path there would compare a resolved root against an
 * unresolved candidate, so a profile whose directory had been deleted would look
 * like an escape and the one recovery path that matters would refuse to run.
 */
async function realpathAllowingMissing(target) {
  const missing = []
  let walk = target
  for (;;) {
    try {
      return path.join(await fs.realpath(walk), ...missing)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(walk)
    if (parent === walk) return path.resolve(target)
    missing.unshift(path.basename(walk))
    walk = parent
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

/** Throw unless `realTarget` names something strictly inside `boundaryRoot`. */
function assertContained(boundaryRoot, realTarget, describe, boundary) {
  const relative = path.relative(boundaryRoot, realTarget)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${describe} resolves outside the ${boundary} (${realTarget}); refusing to read or write it`)
  }
}

/**
 * Resolve one profile directory, refusing anything that escapes `profilesDir`.
 *
 * The tool layer's name check is lexical: it cannot see a junction or symlink
 * placed at `profiles/<name>` pointing elsewhere on disk. Uploading such a
 * "profile" would publish files from outside the profiles directory to a gist,
 * and downloading into it would overwrite them, so containment is re-checked
 * against real paths here.
 *
 * `realDir` is returned as well, because checking the profile directory alone is
 * not enough: the tracked files inside it need the same treatment, against this
 * boundary rather than the outer one.
 */
async function resolveProfileContext(profile, config = {}) {
  const root = resolveProfilesDir(config)
  const candidate = path.join(root, profile)
  const [realRoot, realCandidate] = await Promise.all([
    realpathAllowingMissing(root).catch(() => path.resolve(root)),
    realpathAllowingMissing(candidate).catch(() => path.resolve(candidate)),
  ])
  assertContained(realRoot, realCandidate, `profile "${profile}"`, 'profiles directory')
  return { root, realRoot, dir: candidate, realDir: realCandidate }
}

export async function resolveProfileDir(profile, config = {}) {
  return (await resolveProfileContext(profile, config)).dir
}

/**
 * Resolve one tracked file to a path that is provably inside its own profile.
 *
 * Validating the name is not sufficient on its own. The name is a path, and any
 * component of it — the last one included — can be a symlink or a junction: a
 * tracked `cordis.patch.yml` that is a link to `C:\Users\me\.ssh\id_rsa` would
 * be uploaded and published without the name itself looking unusual, and a
 * download would follow the same link and overwrite the target.
 *
 * Every component is therefore resolved, and the result is checked against the
 * profile directory itself rather than the profiles directory. A link to a
 * *sibling* profile would otherwise let one profile's gist publish another's
 * config and then overwrite it, which breaks the one-gist-per-profile invariant
 * just as surely as an escape out of the tree. (Sharing whole profiles through a
 * link at `profiles/<name>` is still allowed: that is a deliberate act, and it is
 * the boundary `resolveProfileContext` names.)
 *
 * A component that does not exist yet short-circuits the walk, because nothing at
 * or below a missing component can exist and so nothing there can redirect the
 * path. The **whole** path is returned in that case, never a shortened one: a
 * prefix would name the parent directory rather than the file.
 */
async function resolveTrackedFile(profile, name, { dir, realDir }) {
  const segments = normalizeTrackedName(name).split('/')
  let current = dir
  for (const segment of segments) {
    current = path.join(current, segment)
    let real
    try {
      real = await fs.realpath(current)
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return path.join(dir, ...segments)
      throw error
    }
    assertContained(realDir, real, `tracked file "${name}" of profile "${profile}"`, 'profile directory')
  }
  return current
}

/** Read the tracked files of one profile. Missing files are reported, not fatal. */
export async function collectProfile(profile, config = {}) {
  const { dir, realDir } = await resolveProfileContext(profile, config)
  const wanted = resolveProfileFiles(config)
  const files = {}
  const missing = []
  for (const name of wanted) {
    const target = await resolveTrackedFile(profile, name, { dir, realDir })
    try {
      files[name] = await fs.readFile(target, 'utf8')
    } catch (error) {
      // ENOTDIR means a parent component is a regular file, so the tracked file
      // cannot exist. It is reported as absent rather than fatal, which lets a
      // download reach the staging step and fail there with a message naming the
      // real cause instead of surfacing a bare filesystem error code.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') missing.push(name)
      else if (error.code === 'EISDIR') {
        throw new Error(`tracked file "${name}" of profile "${profile}" is a directory, not a file`)
      } else throw error
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

/* ----------------------------------------------------------- state locking -- */

/**
 * Serialize read-modify-write cycles over state.json, within and across processes.
 *
 * Two locks are needed because two different things race:
 *
 *  - an in-process promise chain, because an agent routinely issues tool calls in
 *    parallel and two uploads would each read the old file, the later write
 *    dropping the earlier profile's record — untracking it and orphaning its gist;
 *  - a lock file in the state directory, because two host processes sharing one
 *    `stateDir` race in exactly the same way, and a promise is invisible to the
 *    other process. It is also what stops two processes concurrently syncing the
 *    same untracked profile from minting two gists for it.
 *
 * The lock is deliberately not reentrant. `AsyncLocalStorage` turns a nested call
 * into a clear error rather than a deadlock; a plain depth counter could not tell
 * a nested call from a second independent caller that must still queue.
 */
let stateLock = Promise.resolve()
const lockContext = new AsyncLocalStorage()

/** Age at which a lock file with an unreadable or foreign owner may be reclaimed. */
const FOREIGN_LOCK_STALE_MS = 60_000
/**
 * How long to wait for another process before giving up and naming the holder.
 *
 * A live holder is making progress, not misbehaving, so this is sized to outlast
 * one profile's slowest operation: an upload or a download makes at most two
 * sequential `gh` calls before releasing the lock, and `ghRun` caps each at 60
 * seconds. A holder that has actually died never reaches this — its pid is gone,
 * so the lock is reclaimed immediately.
 */
const LOCK_WAIT_MS = 150_000
const LOCK_POLL_MS = 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lockFilePath(config = {}) {
  return path.join(resolveStateDir(config), 'state.lock')
}

/** `kill(pid, 0)` sends no signal; it only asks the OS whether the pid exists. */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === 'EPERM'
  }
}

/**
 * Read the current holder, or `null` when the lock file is gone.
 *
 * An unreadable or half-written file reports no pid but still reports its mtime,
 * so the caller falls back to the age rule instead of treating a lock it merely
 * failed to parse as free.
 */
async function readLockOwner(target) {
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return null
  }
  let pid = null
  let host = null
  try {
    const [rawPid, rawHost] = (await fs.readFile(target, 'utf8')).trim().split(/\s+/)
    if (/^\d+$/.test(rawPid ?? '')) {
      pid = Number(rawPid)
      host = rawHost || null
    }
  } catch {
    // Fall through to the age rule below.
  }
  return { pid, host, mtime: stat.mtimeMs }
}

function lockIsStale(owner) {
  if (!owner) return true
  // Same machine: the pid is authoritative, so a crashed holder is reclaimed at
  // once and a slow but perfectly live holder is never stolen from.
  if (owner.pid !== null && owner.host === os.hostname()) return !processIsAlive(owner.pid)
  // Another machine sharing this state directory, or a file we could not parse:
  // fall back to age, which the holder keeps fresh with its heartbeat.
  return Date.now() - owner.mtime > FOREIGN_LOCK_STALE_MS
}

/** The error a waiter gets when the lock never comes free. */
function lockTimeout(target, owner) {
  return new Error(
    `timed out after ${LOCK_WAIT_MS} ms waiting for ${target}, held by ` +
      `${owner?.pid ? `pid ${owner.pid}` : 'an unknown process'}${owner?.host ? ` on ${owner.host}` : ''}. ` +
      'Another DeepSeek Harness process is writing the same state directory. Retry once it finishes, or ' +
      'delete that file if no such process is running.',
  )
}

/**
 * Take the lock file, or wait for its holder. Returns an async release function.
 *
 * Reclaiming a lock whose owner has gone is done by **moving the stale file
 * aside**, never by deleting the path. `rm` looks equivalent and is not: two
 * waiters can both read the same stale lock, and if the first then removes it,
 * writes its own and enters the critical section, the second's `rm` deletes a lock
 * that is now live and both processes believe they hold it — reopening exactly the
 * lost-update and duplicate-gist failures the lock exists to prevent. A rename is
 * atomic and can succeed for one waiter only; the loser gets ENOENT and goes back
 * to competing for the exclusive create, which is the one operation that ever
 * grants the lock.
 */
async function acquireStateLock(config) {
  const dir = resolveStateDir(config)
  await fs.mkdir(dir, { recursive: true })
  const target = lockFilePath(config)
  const payload = `${process.pid} ${os.hostname()}\n`
  const deadline = Date.now() + LOCK_WAIT_MS
  let owner = null

  for (;;) {
    try {
      await fs.writeFile(target, payload, { flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    owner = await readLockOwner(target)
    if (lockIsStale(owner)) {
      const aside = `${target}.reclaim.${process.pid}.${Math.random().toString(36).slice(2)}`
      try {
        await fs.rename(target, aside)
        await fs.rm(aside, { force: true }).catch(() => {})
      } catch {
        // Another waiter moved it first, or it vanished. Either way the path is
        // free or freshly taken; loop and let the exclusive create decide.
      }
      if (Date.now() > deadline) throw lockTimeout(target, owner)
      // No sleep: the create at the top of the loop is the arbiter, and the waiter
      // that loses it finds a live lock and falls through to waiting.
      continue
    }
    if (Date.now() > deadline) throw lockTimeout(target, owner)
    await sleep(LOCK_POLL_MS)
  }

  // Kept fresh while held, so a long upload is not aged out by another host that
  // shares this state directory. `unref` stops the timer holding the host open.
  const heartbeat = setInterval(() => {
    const now = new Date()
    fs.utimes(target, now, now).catch(() => {})
  }, FOREIGN_LOCK_STALE_MS / 3)
  heartbeat.unref?.()

  return async () => {
    clearInterval(heartbeat)
    // Only remove a lock that is still ours: if it was reclaimed while we held
    // it, deleting it would release a lock another process now owns.
    const current = await readLockOwner(target)
    if (current?.pid === process.pid && current.host === os.hostname()) {
      await fs.rm(target, { force: true }).catch(() => {})
    }
  }
}

export async function withStateLock(fn, config = {}) {
  if (lockContext.getStore()) {
    throw new Error(
      'withStateLock is not reentrant: a lock is already held in this call chain, so taking it again ' +
        'would wait on itself. Do the work under the lock that is already held.',
    )
  }
  const previous = stateLock
  let releaseChain
  stateLock = new Promise((resolve) => {
    releaseChain = resolve
  })
  await previous

  let releaseFile = null
  try {
    releaseFile = await acquireStateLock(config)
    return await lockContext.run(true, fn)
  } finally {
    try {
      if (releaseFile) await releaseFile()
    } finally {
      // Always let the next in-process caller through, even if releasing the
      // lock file threw: a chain that stops resolving wedges every later call.
      releaseChain()
    }
  }
}

export async function saveState(state, config = {}) {
  const dir = resolveStateDir(config)
  await fs.mkdir(dir, { recursive: true })
  const target = statePath(config)
  // A per-writer temp name: two processes sharing one fixed name could interleave
  // their writes and rename a half-written file into place.
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    // Keep the previous revision so a bad write is recoverable by hand.
    await fs.copyFile(target, `${target}.bak`).catch(() => {})
    await fs.rename(tmp, target)
  } catch (error) {
    // A half-written temp file left behind would be read by nobody and explained
    // by nothing, so it goes with the failure.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
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

/** Refuse to buffer a raw body larger than this. The old `ghRun` cap was 32 MiB. */
const MAX_RAW_BYTES = 64 * 1024 * 1024
/** Matches the cap `ghRun` puts on a `gh` call, so neither path can hang the lock. */
const RAW_FETCH_TIMEOUT_MS = 60_000

/** Read a response body, refusing to buffer an unbounded one into memory. */
async function readBounded(response, url) {
  if (!response.body) return await response.text()
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > MAX_RAW_BYTES) {
      throw new Error(`the body of ${url} is larger than ${MAX_RAW_BYTES} bytes; refusing to buffer it`)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Ask gh for the URL. The fallback path, not the documented one — see below. */
async function ghFetchRaw(ghPath, url, { signal } = {}) {
  const result = await ghRun(ghPath, ['api', url], { signal })
  if (result.code !== 0) {
    throw new Error((result.stderr || '').trim() || `gh exited with code ${result.code}`)
  }
  return result.stdout
}

/**
 * Read a truncated file's full content from the `raw_url` the API handed back.
 *
 * `fetch` rather than `gh api <url>`: the gist API documents `raw_url` as the URL
 * to GET for the content the JSON response truncated, and this is that request.
 * `gh api` happens to accept an absolute URL, but it is documented as taking an
 * API endpoint, and it would carry the caller's token to a host gh was never
 * configured for. The URL has already been restricted to a GitHub raw host over
 * https by `isTrustedRawUrl`, and the host is checked again after any redirect.
 *
 * No credentials are sent, which is what makes this work: a secret gist is
 * unlisted, not access-controlled, so its raw URL is readable by whoever holds it
 * — the same reason the README calls the gist URL a bearer capability.
 *
 * The one thing `fetch` does worse than `gh` is the network: Node ignores
 * `HTTP(S)_PROXY` and the platform certificate store, both of which gh honours. So
 * a *transport* failure falls back to the request gh would have made. An HTTP
 * error status does not: a 404 has to stay a 404.
 */
async function fetchRawContent(url, { signal, fetchImpl = globalThis.fetch, ghPath } = {}) {
  const timeout = AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(url, { signal: deadline, redirect: 'follow', headers: { accept: 'text/plain' } })
  } catch (error) {
    // A cancelled call is not a transport failure: falling back would start a
    // request the caller has already asked to stop.
    if (signal?.aborted) throw error
    if (!ghPath) throw error
    return await ghFetchRaw(ghPath, url, { signal })
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText ?? ''}`.trim())
  // Required, not best-effort: `redirect: 'follow'` would otherwise let the
  // validated origin hand the body to any host it likes, and a response that does
  // not report its final URL cannot be shown to have stayed on one.
  if (!isTrustedRawUrl(response.url)) {
    throw new Error(
      typeof response.url === 'string' && response.url !== ''
        ? `redirected to ${response.url}, which is not a trusted GitHub URL`
        : 'the raw response did not report its final URL, so it cannot be shown to have stayed on GitHub',
    )
  }
  return await readBounded(response, url)
}

/**
 * Fetch a gist.
 *
 * `only` restricts which files have their full content resolved. The API truncates
 * a file's `content` above 1 MB and the remainder costs a second request, so a
 * caller that only cares about the tracked subset — which is every caller but the
 * live test — passes it. Without that, a large file the user never tracks, added
 * through the web UI, would cost a fetch on every single status call and a
 * failure fetching it would make the whole gist look broken.
 *
 * A file outside `only` that the API truncated is left out of `files` entirely
 * and listed in `truncated`, so no caller can mistake a prefix for the whole
 * file. `fileNames` always lists every file in the gist, which is what pruning
 * needs.
 */
export async function gistGet(ghPath, gistId, { signal, fetchImpl, only } = {}) {
  const result = await ghJson(ghPath, ['api', `/gists/${gistId}`], { signal })
  const files = {}
  const truncated = []
  const fileNames = Object.keys(result.files ?? {})
  for (const [name, meta] of Object.entries(result.files ?? {})) {
    if (meta.truncated) {
      truncated.push(name)
      if (only && !only.includes(name)) continue
      // `raw_url` comes from a response body, so it is only followed back to a
      // GitHub host over https — see `isTrustedRawUrl`.
      if (!isTrustedRawUrl(meta.raw_url)) {
        throw new Error(
          `gist file "${name}" is truncated and its raw_url is not a trusted GitHub URL; refusing to follow it`,
        )
      }
      try {
        files[name] = await fetchRawContent(meta.raw_url, { signal, fetchImpl, ghPath })
      } catch (error) {
        throw new Error(
          `gist file "${name}" is truncated and its raw content could not be fetched from ` +
            `${meta.raw_url}: ${error.message}`,
        )
      }
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
    fileNames,
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
    remote = await gistGet(ghPath, record.gistId, { signal, only: trackedNames })
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
      // Compare-and-set on what this run actually observed. Another writer may have
      // advanced the record between the read above and this lock — uploading a
      // newer revision and recording its hash — and writing the older hash over it
      // would move the baseline backwards, turning the next ordinary edit into a
      // false divergence. If the record has moved, leave it alone.
      if (entry && entry.gistId === record.gistId && (entry.lastSyncedHash ?? null) === baseline) {
        entry.lastSyncedHash = localHash
        entry.lastSyncAt = new Date().toISOString()
        await saveState(latest, config)
        current.profiles[profile] = entry
      }
    }, config)
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
    untrackedRemoteFiles: remote.fileNames.filter((name) => !trackedNames.includes(name)),
    description: remote.description,
  }
}

/**
 * Every profile a bulk operation must consider: the directories on disk, plus the
 * profiles the state file still tracks.
 *
 * The two are not the same set, and the difference is the disaster case these
 * tools exist for: when a profile's directory has been deleted outright, its gist
 * holds the only remaining copy of that configuration. Deriving the candidates
 * from the directory listing alone leaves such a profile invisible, so nothing
 * offers to restore it and the backup looks like it was never taken.
 *
 * Names are joined exactly. A state file that tracks two names differing only in
 * case — which the write path refuses to create — therefore reports both rows:
 * the duplicate is real, and hiding one of the pair would hide the thing that
 * needs deleting.
 */
export async function listKnownProfiles(config = {}) {
  const [local, state] = await Promise.all([listProfiles(config), loadState(config)])
  const names = new Set(local)
  for (const name of Object.keys(state.profiles ?? {})) names.add(name)
  return [...names].sort()
}

export async function statusAll({ ghPath, config = {} } = {}) {
  const state = await loadState(config)
  const rows = []
  for (const profile of await listKnownProfiles(config)) {
    rows.push(await profileStatus(profile, { ghPath, config, state }))
  }
  return { profiles: rows, statePath: statePath(config) }
}

/**
 * Refuse a profile name that differs only in case from one already tracked.
 *
 * On a case-insensitive filesystem — Windows, and macOS by default — `ALPHA` and
 * `alpha` are the same directory. Tracking both would mint two secret gists for
 * one profile, and later reads would act on whichever record they found first,
 * so the two copies would diverge silently.
 *
 * Only the write paths call this. A state file that already holds such a pair
 * from an earlier version must still be readable, so reads are left alone.
 */
function assertNoCaseCollision(state, profile) {
  const collision = Object.keys(state.profiles ?? {}).find(
    (key) => key !== profile && key.toLowerCase() === profile.toLowerCase(),
  )
  if (collision) {
    throw new Error(
      `profile "${profile}" differs only in case from the tracked profile "${collision}", and both ` +
        'name the same directory on this filesystem. Use the existing name: a second gist for one ' +
        'profile would diverge silently.',
    )
  }
}

/** Back up the profile's tracked files before any destructive write. */
async function backupProfile(profile, config = {}) {
  const { files } = await collectProfile(profile, config)
  if (Object.keys(files).length === 0) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(resolveStateDir(config), 'backups', profile, stamp)
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    // `name` is a validated single-segment tracked name, so this stays inside the
    // backup directory without any further escaping.
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
    assertNoCaseCollision(state, profile)
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
    let dropped = []

    if (gistId) {
      let existing = null
      try {
        existing = await gistGet(ghPath, gistId, { signal, only: trackedNames })
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
        // Every file the gist holds, by name — not just the ones whose content was
        // resolved, because pruning is decided on the name alone.
        for (const name of existing.fileNames) {
          if (!trackedNames.includes(name)) pruned.push(name)
        }
        // `force` is documented as "also delete gist files that are tracked but
        // missing from disk". Without this the flag was accepted, the refusal was
        // skipped, and the deletion it promised never happened: the caller was
        // told the only remaining copy had been dropped while it was still there.
        dropped = force ? lost : []
        const removals = Object.fromEntries([...pruned, ...dropped].map((name) => [name, null]))
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
      // Informational: what this machine held when it last synced. The tracked set
      // always comes from `profileFiles`, never from here, so a record that has
      // drifted from the configuration cannot change what is read or written.
      files: Object.keys(files),
      lastSyncedHash: localHash,
      lastSyncAt: new Date().toISOString(),
      lastDirection: 'upload',
    }
    state.version = STATE_VERSION
    try {
      await saveState(state, config)
    } catch (error) {
      // The remote half already happened, so "FAILED" alone would be a lie with
      // consequences: without the record, the next upload mints a second gist and
      // abandons this one.
      throw new Error(
        `the gist ${url} was ${created ? 'created' : 'updated'} for profile "${profile}", but recording it ` +
          `in ${statePath(config)} failed (${error.message}). The gist exists; make the state directory ` +
          'writable before retrying, or the next upload will create a second one.',
      )
    }

    return {
      profile,
      gistId,
      gistUrl: url,
      created,
      replaced,
      pruned,
      dropped,
      uploadedFiles: Object.keys(files),
      missing,
      localHash,
    }
  }, config)
}

/** Whether every local tracked file is byte-identical to its counterpart in the gist. */
function localIsSubsetOfRemote(localFiles, remoteFiles) {
  return Object.keys(localFiles).every(
    (name) => name in remoteFiles && remoteFiles[name] === localFiles[name],
  )
}

/**
 * A stable identity for one write target, so two tracked names that denote a
 * single file can be refused instead of quietly overwriting each other.
 *
 * The lexical path is not enough. `link/f.yml` and `real/f.yml` are two strings
 * and one file when `link` is a junction, and on Windows `AREALL~1.YML` is the
 * same file as `areallylongname.yml`. So a target that exists is identified by its
 * file id, and one that does not is identified by its resolved parent plus its
 * final name — which is what catches the junction case on a machine where the file
 * has not been downloaded yet. Case is not folded here: two names differing only
 * in case were already refused by `resolveProfileFiles` where the filesystem folds
 * case, and folding again would collide two real files elsewhere.
 */
async function targetIdentity(target) {
  try {
    const stats = await fs.stat(target, { bigint: true })
    if (stats.ino !== 0n) return `id:${stats.dev}:${stats.ino}`
  } catch {
    // Missing or unreadable: fall through to the path-based identity.
  }
  const parent = path.dirname(target)
  const realParent = await fs.realpath(parent).catch(() => parent)
  return `path:${path.join(realParent, path.basename(target))}`
}

/**
 * Put back the files a failed commit had already replaced.
 *
 * Returns the error to throw, carrying the outcome of the rollback. Content comes
 * from what this run read out of the profile at the start — the same bytes the
 * backup holds — and a file that did not exist before is removed again.
 */
async function rollbackFiles({ profile, dir, realDir, done, localFiles, staged, backupDir, cause }) {
  const failed = []
  for (const item of [...done].reverse()) {
    try {
      // Re-resolved like the commit was: a component that became a link while the
      // download ran must not redirect the restore out of the tree either. A path
      // that can no longer be resolved is reported, not written to.
      const target = await resolveTrackedFile(profile, item.name, { dir, realDir })
      const previous = localFiles[item.name]
      if (previous === undefined) {
        await fs.rm(target, { force: true })
        continue
      }
      // Restored through the staging directory rather than written straight in,
      // so the restore is atomic too.
      const restore = path.join(staged, 'rollback', ...item.name.split('/'))
      await fs.mkdir(path.dirname(restore), { recursive: true })
      await fs.writeFile(restore, previous, 'utf8')
      await fs.rename(restore, target)
    } catch (error) {
      failed.push(`${item.name} (${error.message})`)
    }
  }
  const outcome = failed.length
    ? `Could NOT restore ${failed.join(', ')} — those are left at the new revision.`
    : 'The tracked files were put back exactly as they were.'
  // Never point at a backup that was not taken: an empty profile has nothing to
  // back up, and telling the reader otherwise sends them looking for a directory
  // that does not exist.
  const recovery = backupDir
    ? `The content from before this download is in ${backupDir}.`
    : 'Nothing of this profile existed locally before the download, so there is nothing else to recover.'
  return new Error(`failed to write profile "${profile}": ${cause.message}. ${outcome} ${recovery}`)
}

/** Prefix of the staging directory a download writes through: never tracked, never listed. */
const STAGING_PREFIX = '.dsh-gist-settings-staging-'

/**
 * Replace the profile's tracked files with `files`, or leave them exactly as they were.
 *
 * Writing the files one at a time is not safe. If the second of two writes fails —
 * a permission problem, a full disk, a file another process holds open on
 * Windows — the profile is left holding one file from the new revision and one
 * from the old, at a revision that exists nowhere. A backup makes that manually
 * recoverable, which is not the same promise as "a failed download leaves the
 * profile untouched".
 *
 * So the content is staged first, inside the profile directory so the final step
 * stays on one volume, and nothing tracked is touched until every byte has been
 * written and measured. The commit itself is one rename per file, which lands as
 * either the old content or the new one and never a truncated mixture. If a rename
 * still fails, the files already replaced are put back and the error names the
 * backup directory.
 *
 * A staging directory left behind by a killed process is inert: nothing tracks it,
 * `listProfiles` skips dot-directories, and the next run uses a fresh name.
 */
async function commitTrackedFiles({ profile, dir, realDir, files, localFiles, backupDir }) {
  const staged = path.join(dir, `${STAGING_PREFIX}${process.pid}-${Date.now().toString(36)}`)
  const plan = []
  const identities = new Map()
  for (const [name, content] of Object.entries(files)) {
    const target = await resolveTrackedFile(profile, name, { dir, realDir })
    // Refused before anything is staged: writing both would discard one revision
    // without a word, and reporting both in `written` would be a lie.
    const identity = await targetIdentity(target)
    const clash = identities.get(identity)
    if (clash !== undefined) {
      throw new Error(
        `tracked names ${JSON.stringify(clash)} and ${JSON.stringify(name)} resolve to the same file ` +
          `(${target}), so one of them would silently overwrite the other. Nothing was written.`,
      )
    }
    identities.set(identity, name)
    plan.push({ name, content, target })
  }

  // Not `recursive`: an entry already at this name is not ours, and the cleanup
  // below removes the tree by name. Failing with EEXIST is the honest outcome.
  await fs.mkdir(staged)
  try {
    for (const item of plan) {
      item.staged = path.join(staged, item.name)
      await fs.writeFile(item.staged, item.content, 'utf8')
    }
    // Measure what landed: a short write that still reported success would
    // otherwise be discovered only after the profile had been overwritten.
    for (const item of plan) {
      const { size } = await fs.stat(item.staged)
      const expected = Buffer.byteLength(item.content, 'utf8')
      if (size !== expected) {
        throw new Error(`staged ${item.name} is ${size} bytes, expected ${expected}`)
      }
    }

    const done = []
    for (const item of plan) {
      try {
        // Re-resolved immediately before the write. The first resolution happened
        // before staging, and staging a large payload takes time: the profile
        // directory itself could have been swapped for a link in that window, which
        // would redirect this rename out of the tree. The gap is narrowed to the
        // rename call itself, which is as close as `fs` gets — see the note in the
        // README.
        item.target = await resolveTrackedFile(profile, item.name, { dir, realDir })
        await fs.rename(item.staged, item.target)
      } catch (error) {
        throw await rollbackFiles({ profile, dir, realDir, done, localFiles, staged, backupDir, cause: error })
      }
      done.push(item)
    }
    return plan.map((item) => item.name)
  } finally {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Pull the gist content down over the local profile files, after backing them up.
 *
 * The write is all-or-nothing: see `commitTrackedFiles`.
 *
 * `lastSyncedHash` records the remote content this machine last agreed on, which
 * is what keeps the classifier converging: if the gist is missing a tracked file
 * that exists locally, the recorded baseline differs from the local hash, so the
 * next sync reports `local-ahead` and uploads it back rather than looping on
 * downloads that cannot change anything. `syncProfile` applies that second step
 * in the same call rather than leaving the profile half-converged.
 */
export async function downloadProfile(profile, { ghPath, config = {}, force = false, signal } = {}) {
  return withStateLock(async () => {
    const state = await loadState(config)
    assertNoCaseCollision(state, profile)
    const record = state.profiles?.[profile]
    if (!record?.gistId) {
      throw new Error(`profile "${profile}" is not tracked yet; run an upload first to create its gist`)
    }

    const trackedNames = resolveProfileFiles(config)
    const remote = await gistGet(ghPath, record.gistId, { signal, only: trackedNames })
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
    // untouched, which is the point: a cancelled call must not half-apply. The
    // commit itself is deliberately not interruptible, because stopping between
    // two renames is the half-applied state the staging step exists to prevent.
    signal?.throwIfAborted()
    const { dir, realDir } = await resolveProfileContext(profile, config)
    await fs.mkdir(dir, { recursive: true })
    const written = await commitTrackedFiles({
      profile,
      dir,
      realDir,
      files: remoteFiles,
      localFiles,
      backupDir,
    })

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
    try {
      await saveState(state, config)
    } catch (error) {
      // The files are already in place, so a bare failure would be a lie in the
      // other direction. The stale baseline it leaves behind is repaired by the
      // next status, so the report says so rather than implying data loss.
      throw new Error(
        `profile "${profile}" was restored from ${remote.url}, but recording the new baseline in ` +
          `${statePath(config)} failed (${error.message}). The files are in place; gist_status repairs a ` +
          'stale baseline once that directory is writable again.',
      )
    }

    return { profile, gistId: record.gistId, gistUrl: remote.url, written, keptLocally, backupDir, remoteHash }
  }, config)
}

/**
 * One-step bidirectional sync.
 * Fast-forwards whichever side changed; refuses to guess on a true divergence.
 *
 * A deletion is never propagated on its own, in either direction, because the copy
 * being deleted may be the last one. A tracked file removed from the gist is put
 * back into it, in this same call, rather than removed locally; a tracked file
 * deleted locally is not deleted from the gist either. Applying a deletion is
 * always a deliberate act on the side that still holds the copy: delete the local
 * file yourself and sync, or use `gist_upload` with `force: true` to drop a
 * locally-missing file from the gist.
 */
export async function syncProfile(profile, { ghPath, config = {}, force = false, signal } = {}) {
  const status = await profileStatus(profile, { ghPath, config, signal })
  const settle = (action, result) => ({ profile, action, ...result })

  switch (status.status) {
    case 'untracked':
    case 'missing-gist':
      return settle('created', await uploadProfile(profile, { ghPath, config, signal }))
    case 'in-sync':
      return { profile, action: 'noop', gistId: status.gistId, gistUrl: status.gistUrl }
    case 'local-ahead':
      return settle('uploaded', await uploadProfile(profile, { ghPath, config, signal }))
    case 'remote-ahead': {
      // The gist carries none of the tracked files. There is nothing to download,
      // and this machine's copies are now the only ones, so the conservative
      // policy points at republishing them rather than reporting a failure.
      if (status.remoteFiles.length === 0) {
        const republished = await uploadProfile(profile, { ghPath, config, signal })
        return settle('restored', { ...republished, republished: republished.uploadedFiles })
      }
      const downloaded = await downloadProfile(profile, { ghPath, config, signal })
      if (downloaded.keptLocally.length === 0) return settle('downloaded', downloaded)
      // The gist dropped files this machine still has. The download kept them, so
      // the two sides now differ and the local copy wins; uploading them back here
      // is the second half of that one policy, not a second policy.
      const restored = await uploadProfile(profile, { ghPath, config, signal })
      return settle('restored', {
        ...downloaded,
        republished: downloaded.keptLocally,
        gistId: restored.gistId,
        gistUrl: restored.gistUrl,
      })
    }
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
      // `force` is threaded through so the refusal it can produce is actionable:
      // without it, downloadProfile refuses to discard unsynced local edits and
      // tells the caller to re-run with force — which this call used to drop.
      return settle('downloaded', await downloadProfile(profile, { ghPath, config, force, signal }))
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
  const profiles = await listKnownProfiles(config)
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