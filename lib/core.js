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

export function resolveDshHome(config = {}) {
  return config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function resolveProfilesDir(config = {}) {
  return config.profilesDir || path.join(resolveDshHome(config), 'profiles')
}

export function resolveStateDir(config = {}) {
  return config.stateDir || path.join(resolveDshHome(config), 'gist-settings')
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
    if (!(await fileExists(config.ghPath))) {
      return { path: null, reason: `configured ghPath does not exist: ${config.ghPath}`, tried }
    }
    const found = await probe(config.ghPath, 'config')
    if (found) return found
    return { path: null, reason: `configured ghPath is not runnable: ${config.ghPath}`, tried }
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

/** Run `gh` and capture output. Never rejects on a non-zero exit; inspect `code`. */
export function ghRun(ghPath, args, { input, cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      ghPath,
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: `${ghPath}: not found` })
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
    if (input !== undefined) {
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

/** Read the tracked files of one profile. Missing files are reported, not fatal. */
export async function collectProfile(profile, config = {}) {
  const dir = path.join(resolveProfilesDir(config), profile)
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

export async function loadState(config = {}) {
  try {
    const raw = await fs.readFile(statePath(config), 'utf8')
    const parsed = JSON.parse(raw)
    return { version: STATE_VERSION, profiles: {}, ...parsed }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: STATE_VERSION, profiles: {} }
    throw error
  }
}

export async function saveState(state, config = {}) {
  const dir = resolveStateDir(config)
  await fs.mkdir(dir, { recursive: true })
  const target = statePath(config)
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, target)
  return target
}

/* ------------------------------------------------------------- gist calls -- */

/** Create a secret gist. Returns `{ id, url, files }`. */
export async function gistCreate(ghPath, { description, files, isPublic = false }) {
  const body = JSON.stringify({
    description,
    public: isPublic,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
  })
  const result = await ghJson(
    ghPath,
    ['api', '--method', 'POST', '/gists', '-H', 'Content-Type: application/json', '--input', '-'],
    { input: body },
  )
  return { id: result.id, url: result.html_url, description: result.description }
}

/** Fetch a gist. Large files come back with `truncated: true`; those download via `raw_url`. */
export async function gistGet(ghPath, gistId) {
  const result = await ghJson(ghPath, ['api', `/gists/${gistId}`])
  const files = {}
  const truncated = []
  for (const [name, meta] of Object.entries(result.files ?? {})) {
    if (meta.truncated && meta.raw_url) {
      truncated.push(name)
      const res = await ghRun(ghPath, ['api', meta.raw_url])
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
export async function gistPatch(ghPath, gistId, { description, files }) {
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
    { input: JSON.stringify(payload) },
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
 * Compare one profile against its tracked gist without changing anything.
 * Status: untracked | in-sync | local-ahead | remote-ahead | diverged | missing-gist | missing-local
 */
export async function profileStatus(profile, { ghPath, config = {}, state } = {}) {
  const current = state ?? (await loadState(config))
  const record = current.profiles?.[profile]
  const { files, missing, dir } = await collectProfile(profile, config)
  const localHash = hashFiles(files)

  if (missing.length === resolveProfileFiles(config).length) {
    return { profile, dir, status: 'missing-local', missing, localHash, gistId: record?.gistId ?? null }
  }
  if (!record?.gistId) {
    return {
      profile,
      dir,
      status: 'untracked',
      missing,
      localHash,
      gistId: null,
      files: Object.keys(files),
    }
  }

  let remote
  try {
    remote = await gistGet(ghPath, record.gistId)
  } catch (error) {
    return {
      profile,
      dir,
      status: 'missing-gist',
      missing,
      localHash,
      gistId: record.gistId,
      gistUrl: record.gistUrl ?? null,
      error: error.message,
    }
  }

  const remoteHash = hashFiles(remote.files)
  const baseline = record.lastSyncedHash ?? null
  const localChanged = baseline !== localHash
  const remoteChanged = baseline !== remoteHash

  let status
  if (localHash === remoteHash) status = 'in-sync'
  else if (!baseline) status = 'diverged'
  else if (localChanged && remoteChanged) status = 'diverged'
  else if (localChanged) status = 'local-ahead'
  else if (remoteChanged) status = 'remote-ahead'
  else status = 'diverged'

  return {
    profile,
    dir,
    status,
    missing,
    localHash,
    remoteHash,
    baseline,
    gistId: record.gistId,
    gistUrl: remote.url,
    gistUpdatedAt: remote.updatedAt,
    localFiles: Object.keys(files),
    remoteFiles: Object.keys(remote.files),
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

/** Push local profile config to its gist, creating the gist on first upload. */
export async function uploadProfile(profile, { ghPath, config = {}, description } = {}) {
  const state = await loadState(config)
  const { files, missing, dir } = await collectProfile(profile, config)
  if (Object.keys(files).length === 0) {
    throw new Error(`profile "${profile}" has none of the tracked files in ${dir}`)
  }

  const record = state.profiles[profile]
  const desc = description || record?.description || defaultDescription(profile)
  let gistId = record?.gistId
  let url = record?.gistUrl
  let created = false

  if (gistId) {
    const existing = await gistGet(ghPath, gistId).catch(() => null)
    if (existing) {
      // Remove remote files that are no longer tracked locally.
      const removals = {}
      for (const name of Object.keys(existing.files)) {
        if (!(name in files)) removals[name] = null
      }
      const patched = await gistPatch(ghPath, gistId, {
        description: desc,
        files: { ...files, ...removals },
      })
      url = patched.url
    } else {
      gistId = undefined
    }
  }

  if (!gistId) {
    const created_ = await gistCreate(ghPath, { description: desc, files })
    gistId = created_.id
    url = created_.url
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

  return { profile, gistId, gistUrl: url, created, uploadedFiles: Object.keys(files), missing, localHash }
}

/** Pull the gist content down over the local profile files, after backing them up. */
export async function downloadProfile(profile, { ghPath, config = {}, force = false } = {}) {
  const state = await loadState(config)
  const record = state.profiles?.[profile]
  if (!record?.gistId) {
    throw new Error(`profile "${profile}" is not tracked yet; run an upload first to create its gist`)
  }

  const remote = await gistGet(ghPath, record.gistId)
  const remoteFiles = Object.fromEntries(
    Object.entries(remote.files).filter(([name]) => resolveProfileFiles(config).includes(name)),
  )
  if (Object.keys(remoteFiles).length === 0) {
    throw new Error(`gist ${record.gistId} has none of the tracked files for profile "${profile}"`)
  }

  const { files: localFiles } = await collectProfile(profile, config)
  const localHash = hashFiles(localFiles)
  const remoteHash = hashFiles(remoteFiles)

  if (localHash !== remoteHash && !force) {
    const baseline = record.lastSyncedHash ?? null
    if (baseline && localHash !== baseline && remoteHash !== baseline) {
      throw new Error(
        `profile "${profile}" has diverged: both local and gist changed since the last sync. ` +
          'Re-run with force to overwrite local files (a backup is taken first).',
      )
    }
    if (localHash !== baseline && remoteHash === baseline) {
      throw new Error(
        `local "${profile}" has unsynced changes; downloading would discard them. ` +
          'Upload first, or re-run with force (a backup is taken first).',
      )
    }
  }

  const backupDir = await backupProfile(profile, config)
  const dir = path.join(resolveProfilesDir(config), profile)
  await fs.mkdir(dir, { recursive: true })
  const written = []
  for (const [name, content] of Object.entries(remoteFiles)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8')
    written.push(name)
  }

  state.profiles[profile] = {
    ...record,
    gistUrl: remote.url,
    description: remote.description ?? record.description,
    files: written,
    lastSyncedHash: remoteHash,
    lastSyncAt: new Date().toISOString(),
    lastDirection: 'download',
  }
  await saveState(state, config)

  return { profile, gistId: record.gistId, gistUrl: remote.url, written, backupDir, remoteHash }
}

/**
 * One-step bidirectional sync.
 * Fast-forwards whichever side changed; refuses to guess on a true divergence.
 */
export async function syncProfile(profile, { ghPath, config = {}, force = false } = {}) {
  const status = await profileStatus(profile, { ghPath, config })
  switch (status.status) {
    case 'untracked':
      return { profile, action: 'created', ...(await uploadProfile(profile, { ghPath, config })) }
    case 'in-sync':
      return { profile, action: 'noop', gistId: status.gistId, gistUrl: status.gistUrl }
    case 'local-ahead':
      return { profile, action: 'uploaded', ...(await uploadProfile(profile, { ghPath, config })) }
    case 'remote-ahead':
      return { profile, action: 'downloaded', ...(await downloadProfile(profile, { ghPath, config })) }
    case 'diverged':
      if (!force) {
        throw new Error(
          `profile "${profile}" has diverged: local and gist both changed since the last sync. ` +
            'Choose upload or download explicitly, or re-run with force.',
        )
      }
      return { profile, action: 'forced-upload', ...(await uploadProfile(profile, { ghPath, config })) }
    case 'missing-local':
      return { profile, action: 'downloaded', ...(await downloadProfile(profile, { ghPath, config, force: true })) }
    case 'missing-gist':
      return { profile, action: 'created', ...(await uploadProfile(profile, { ghPath, config })) }
    default:
      throw new Error(`unhandled status "${status.status}" for profile "${profile}"`)
  }
}

export async function syncAll({ ghPath, config = {}, force = false } = {}) {
  const profiles = await listProfiles(config)
  const results = []
  for (const profile of profiles) {
    try {
      results.push({ ok: true, ...(await syncProfile(profile, { ghPath, config, force })) })
    } catch (error) {
      results.push({ ok: false, profile, error: error.message })
    }
  }
  return results
}

/** Health report used by both the `gist_status` tool and the settings page. */
export async function health(config = {}) {
  const resolved = await resolveGh(config)
  if (!resolved.path) {
    return { gh: { found: false, reason: resolved.reason, tried: resolved.tried }, auth: null }
  }
  const auth = await checkAuth(resolved.path)
  return {
    gh: { found: true, path: resolved.path, version: resolved.version },
    auth,
    dshHome: resolveDshHome(config),
    profilesDir: resolveProfilesDir(config),
    stateDir: resolveStateDir(config),
    statePath: statePath(config),
    trackedFiles: resolveProfileFiles(config),
  }
}