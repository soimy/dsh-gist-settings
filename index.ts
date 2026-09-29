/**
 * Host half of `dsh-gist-settings`.
 *
 * Registers four agent tools that back a DeepSeek Harness profile's
 * configuration up to GitHub Gists (and restore it) through the locally
 * installed `gh` CLI. All real work lives in `./lib/core.ts`, which has no
 * Cordis dependency and is covered by `test/sync.test.mjs`.
 *
 * Tool definitions are written as plain objects rather than built with
 * `defineTool` from `@deepseek-ai/dsh-tools`, so the bundle imports nothing
 * from the Harness installation and cannot break on a module-resolution change.
 * The shape mirrors what `defineTool` produces: `parameters` is raw JSON Schema
 * and `execute` returns the canonical value that `output.render` projects into
 * content blocks.
 */

import * as core from './lib/core.ts'
import type { Config, GhPath, Health, ProfileStatus, ProfileStatusName } from './lib/core.ts'

/* ------------------------------------------------------------- the types -- */

/**
 * This package imports nothing from the Harness installation, so the few framework
 * shapes this file reaches are described structurally here instead of imported.
 * Nothing in this block exists at runtime; core's own shapes are imported above.
 */

/**
 * An untrusted value once it is known to be a mapping.
 *
 * `typeof` narrowing on `unknown` leaves `object | null`, which has no index
 * signature, so this names the mapping the runtime checks establish. Every use is
 * a read that happens after the check that proves it.
 */
type Mapping = Record<string, unknown>

/** One tool's canonical value, before `output.render` projects it into content blocks. */
interface ToolValue {
  text: string
}

/**
 * What the registry hands `execute`: for this plugin, the abort signal of the call.
 *
 * Optional, and read with `?.` everywhere, because the registry — not this file —
 * decides what an execution carries.
 */
interface ToolExecution {
  signal?: AbortSignal
}

/** One declared argument's JSON Schema node. */
interface ArgumentSchemaNode {
  type: 'string' | 'boolean'
  description: string
}

/** The `parameters` object of a hand-written tool definition: raw JSON Schema. */
type ToolParameters = {
  type: 'object'
  properties: Record<string, ArgumentSchemaNode>
  additionalProperties: false
}

/**
 * The `parameters` object that one tool's declared argument type compiles to.
 *
 * The mapping is what keeps a declaration and its JSON Schema in step: a property
 * the schema omits, or a `type` that contradicts the declared argument, is a compile
 * error rather than a mismatch the model only discovers by calling the tool.
 */
type ArgumentSchema<A> = {
  type: 'object'
  properties: {
    [K in keyof A]-?: A[K] extends boolean | undefined
      ? { type: 'boolean'; description: string }
      : { type: 'string'; description: string }
  }
  additionalProperties: false
}

/** The argument types `checkArgs` produces: exactly what a JSON Schema here can declare. */
type ToolArgs = Record<string, string | boolean | undefined>

/** The arguments `gist_status` accepts. */
type StatusArgs = { profile?: string }

/** The arguments `gist_upload` accepts. */
type UploadArgs = { profile?: string; description?: string; force?: boolean; verifyGh?: boolean }

/** The arguments `gist_download` accepts. */
type DownloadArgs = { profile?: string; force?: boolean }

/** The arguments `gist_sync` accepts. */
type SyncArgs = { profile?: string; force?: boolean }

/** One tool definition as this file writes it, before `contentTool` completes it. */
interface ToolSpec<A extends ToolArgs> {
  name: string
  description: string
  parameters: ArgumentSchema<A>
  run(args: A, exec: ToolExecution | undefined): Promise<ToolValue>
  concurrencySafe?: boolean
}

/**
 * One completed tool definition, in the shape `ctx.tools.register` accepts.
 *
 * `parameters` is the loose JSON Schema shape here: each tool's literal is checked
 * against its own `ToolSpec` where it is written, and `register` receives the result.
 */
interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameters
  output: {
    schema: {
      type: 'object'
      properties: { text: { type: 'string' } }
      additionalProperties: false
    }
    render(args: unknown, value: ToolValue): Array<{ type: 'text'; text: string }>
  }
  isConcurrencySafe?: (args: unknown) => boolean
  execute(args: unknown, exec: ToolExecution | undefined): Promise<ToolValue>
}

/** Undo one registration; the effect body yields it so that unloading can call it. */
type Disposer = () => void

/** The slice of the plugin's Cordis context that this file uses. */
interface PluginContext {
  tools: {
    /** Register one tool for as long as this plugin row stays mounted. */
    register(tool: ToolDefinition): Disposer
  }
  /** Run a setup body and keep whatever it yields as this row's teardown. */
  effect(body: () => Generator<Disposer, void, unknown>, label: string): void
}

/**
 * One row of the status report: an engine row, plus the local row this file builds
 * when gh is unavailable and the remote state could not be read at all.
 *
 * Derived from core's `ProfileStatus` rather than restated, because that is where
 * the fields come from; the local row merely carries fewer of them.
 */
type StatusRow = Omit<Partial<ProfileStatus>, 'profile' | 'status'> & {
  profile: string
  status: ProfileStatusName | 'unknown'
}

/** Registering tools is the only service this plugin needs. */
export const inject = ['tools']

const KNOWN_CONFIG_KEYS = ['ghPath', 'dshHome', 'profilesDir', 'stateDir', 'profileFiles']

/**
 * Read and validate this row's `config:` block.
 *
 * The plugin declares no `Config` schema, so the Loader passes the block through
 * untouched. Validating it here is what turns a typo into a clear error rather
 * than a silent fall back to defaults — which matters most for `profileFiles`,
 * where a mistake would quietly change which files get backed up.
 */
function readConfig(raw: unknown): Config {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`config must be a mapping, received ${Array.isArray(input) ? 'an array' : typeof input}`)
  }

  const unknown = Object.keys(input as Mapping).filter((key) => !KNOWN_CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `unknown config key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}; ` +
        `known keys are ${KNOWN_CONFIG_KEYS.join(', ')}`,
    )
  }

  const str = (key: string): string | undefined => {
    const value = (input as Mapping)[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`config.${key} must be a non-empty string`)
    }
    return value.trim()
  }

  const stringList = (key: string): string[] | undefined => {
    const value = (input as Mapping)[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`config.${key} must be a non-empty array of strings`)
    }
    const parts = value.map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : ''))
    if (parts.some((entry) => entry === '')) {
      throw new Error(`config.${key} must contain only non-empty strings`)
    }
    return parts
  }

  /**
   * `ghPath` is a string for a normal install. An array is the escape hatch for
   * reaching gh through a wrapper — `['wsl', 'gh']`, a shim script, a portable
   * build invoked by its interpreter.
   */
  let ghPath: GhPath | undefined
  if ((input as Mapping).ghPath !== undefined) {
    ghPath = Array.isArray((input as Mapping).ghPath) ? stringList('ghPath') : str('ghPath')
  }

  const profileFiles = stringList('profileFiles')
  // Validated here as well as at use time, so a name that could never be handled —
  // an absolute path, a `..` segment, a colon — fails when the plugin loads rather
  // than on the first tool call, where it would look like a one-off error.
  if (profileFiles) core.resolveProfileFiles({ profileFiles })

  return {
    ghPath,
    dshHome: str('dshHome'),
    profilesDir: str('profilesDir'),
    stateDir: str('stateDir'),
    profileFiles,
  }
}

/** Resolve `gh` and refuse to continue unless it is installed and authenticated. */
async function requireGh(config: Config): Promise<GhPath> {
  const resolved = await core.resolveGh(config)
  if (!resolved.path) {
    throw new Error(
      `gh CLI not found: ${resolved.reason}. Install GitHub CLI ` +
        '(https://cli.github.com) or set `ghPath` in this plugin\'s config.',
    )
  }
  const auth = await core.checkAuth(resolved.path)
  if (!auth.authenticated) {
    throw new Error(
      `gh is installed at ${resolved.path} but not authenticated. ` +
        'Run `gh auth login` once, then retry. Gists are created with `gh api`, so no extra scopes are needed.',
    )
  }
  return resolved.path
}

/**
 * Guard a profile name before it reaches the filesystem.
 * Mirrors the framework's own profile-name rules, which also reserve the shared
 * `node_modules` store, and `lib/core.ts` re-checks containment against real
 * paths so a junction cannot redirect the read or the write.
 */
function assertProfileName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name.startsWith('.') ||
    name === 'node_modules'
  ) {
    throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * Resolve a requested profile name to the name that actually exists.
 *
 * On a case-insensitive filesystem `ALPHA` and `alpha` are the same directory,
 * so accepting both would mint two secret gists and two state entries for one
 * profile. The requested name is matched exactly and a case-only variant is
 * refused with the real name attached — silently rewriting it to a different
 * name than the caller asked for is exactly the kind of guess this plugin
 * avoids everywhere else.
 *
 * A name that matches nothing is also refused, listing what does exist, rather
 * than failing later with a confusing "has none of the tracked files".
 */
async function resolveProfileArg(name: unknown, config: Config): Promise<string> {
  const wanted = assertProfileName(name)
  const known = await core.listProfiles(config)
  const state = await core.loadState(config)
  const tracked = Object.keys(state.profiles ?? {})

  if (known.includes(wanted)) return wanted

  const directoryVariant = known.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
  if (directoryVariant) {
    throw new Error(
      `profile "${wanted}" is not the name of a profile directory; "${directoryVariant}" is. Names ` +
        'are matched exactly, so that a difference of case alone cannot create a second gist for ' +
        'the same directory.',
    )
  }

  // Not on disk. Allowed only for a profile this machine already tracks under
  // exactly this name — its directory may have been deleted and a download
  // recreates it.
  if (tracked.includes(wanted)) return wanted

  const trackedVariant = tracked.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
  if (trackedVariant) {
    throw new Error(
      `profile "${wanted}" is tracked as "${trackedVariant}"; use that exact name, so that a ` +
        'difference of case alone cannot create a second gist for the same directory.',
    )
  }

  const pool = [...new Set([...known, ...tracked])].sort()
  throw new Error(`unknown profile "${wanted}"; known profiles: ${pool.join(', ') || '(none)'}`)
}

/* ------------------------------------------------------------- formatting -- */

const STATUS_LABEL: Record<ProfileStatusName | 'unknown', string> = {
  'untracked': 'not tracked',
  'in-sync': 'in sync',
  'local-ahead': 'local changes to upload',
  'remote-ahead': 'gist changes to download',
  'diverged': 'DIVERGED - needs a decision',
  'missing-local': 'tracked files missing locally - run gist_download to restore',
  'missing-gist': 'gist deleted - the next upload recreates it',
  'unreachable': 'gist UNREACHABLE (not deleted) - retry when connected',
  'unknown': 'unknown - gh is unavailable, remote state not checked',
}

/**
 * The auth line, which must not tell you to log in to a CLI that is not installed.
 * When gh could not be found there is no auth state to report, and advising
 * `gh auth login` sends the reader down the wrong path entirely.
 */
function describeAuth(health: Health): string {
  if (!health.gh.found) return 'not checked - gh is not installed'
  if (!health.auth?.authenticated) return 'NOT AUTHENTICATED - run `gh auth login`'
  return `ok (${health.auth.account})`
}

function formatStatusReport(health: Health, rows: StatusRow[], statePath: string): string {
  const lines: string[] = []
  if (health.gh.found) {
    lines.push(`gh:   ${health.gh.version}`)
    lines.push(`      ${health.gh.path}`)
  } else {
    lines.push(`gh:   NOT FOUND - ${health.gh.reason}`)
  }
  lines.push(`auth: ${describeAuth(health)}`)
  lines.push(`home: ${health.dshHome}`)
  lines.push(`state: ${statePath}`)
  lines.push('')
  if (rows.length === 0) {
    lines.push('No profiles found.')
    return lines.join('\n')
  }
  for (const row of rows) {
    lines.push(`${row.profile}`)
    lines.push(`  status: ${STATUS_LABEL[row.status] ?? row.status}`)
    if (row.gistUrl) lines.push(`  gist:   ${row.gistUrl}`)
    if (row.error) lines.push(`  error:  ${row.error}`)
    if (row.missing?.length) lines.push(`  absent: ${row.missing.join(', ')}`)
    if (row.untrackedRemoteFiles?.length) {
      lines.push(`  gist also holds (untracked here): ${row.untrackedRemoteFiles.join(', ')}`)
    }
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------- tool shape -- */

/**
 * Validate and narrow one tool call's arguments.
 *
 * These definitions are hand-written rather than built with the harness's
 * `defineTool`, so nothing validates the model's arguments for us. Without this
 * a `force: "false"` string arrives truthy and silently forces a destructive
 * overwrite, and a misspelled `profile` widens the call to every profile.
 *
 * Values are checked, never coerced: a wrong type or an explicit `null` is an
 * error the model can correct, not something to guess at.
 */
function checkArgs<A extends ToolArgs>(toolName: string, parameters: ToolParameters, args: unknown): A {
  const input = args === undefined || args === null ? {} : args
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `invalid arguments for ${toolName}: expected an object, received ${Array.isArray(input) ? 'an array' : typeof input}`,
    )
  }

  const properties = parameters.properties ?? {}
  const problems = []

  for (const key of Object.keys(input as Mapping)) {
    if (!Object.hasOwn(properties, key)) problems.push(`unknown argument "${key}"`)
  }

  const accepted: Record<string, string | boolean> = {}
  for (const [key, schema] of Object.entries(properties)) {
    const value = (input as Mapping)[key]
    if (value === undefined) continue
    if (schema.type === 'string') {
      if (typeof value !== 'string') problems.push(`"${key}" must be a string, received ${JSON.stringify(value)}`)
      else accepted[key] = value
    } else if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') problems.push(`"${key}" must be a boolean, received ${JSON.stringify(value)}`)
      else accepted[key] = value
    } else {
      // Refuse at construction rather than waving an unvalidated value through.
      throw new Error(`${toolName}: parameter "${key}" declares unsupported type ${JSON.stringify(schema.type)}`)
    }
  }

  if (problems.length > 0) throw new Error(`invalid arguments for ${toolName}: ${problems.join('; ')}`)
  // Every value above was checked against the type its own schema declares; the
  // assertion only names that result for the caller, which the compiler cannot
  // correlate with a `parameters` object it sees as data.
  return accepted as A
}

/**
 * Build a registry-ready tool.
 *
 * The canonical value is a domain-owned DTO rather than the framework's
 * `@internal` content-blocks-as-value test fixture: `output.schema` is what PTC
 * mode projects into a generated SDK, so an untyped array would hand the model
 * `list[Any]` instead of a described result.
 */
function contentTool<A extends ToolArgs>({ name, description, parameters, run, concurrencySafe = false }: ToolSpec<A>): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // The registry treats an undeclared classifier as exclusive; only the
    // read-only status tool may join a parallel batch.
    ...(concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    async execute(args, exec) {
      return await run(checkArgs<A>(name, parameters, args), exec)
    },
  }
}

/** The canonical value every tool returns; `output.render` turns it into content. */
const text = (body: string): ToolValue => ({ text: body })

/* ----------------------------------------------------------------- tools -- */

function buildTools(ctx: PluginContext, userConfig: Config): ToolDefinition[] {
  const withConfig = (config?: Config): Config => ({ ...userConfig, ...config })

  const statusTool = contentTool<StatusArgs>({
    name: 'gist_status',
    concurrencySafe: true,
    description:
      'Report whether the local gh CLI is installed and authenticated, and show every DeepSeek Harness ' +
      'profile alongside its GitHub Gist: the gist URL and whether the profile is in sync, has local ' +
      'changes to upload, has gist changes to download, has diverged, has tracked files missing locally, ' +
      'or has an unreachable or deleted gist. Never touches profile files or the gist; it may repair a ' +
      'stale sync baseline in its own state file. Use this first to see what needs syncing.',
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Limit the report to one profile. Omit to report every profile.',
        },
      },
      additionalProperties: false,
    },
    run: async ({ profile }, exec) => {
      const config = withConfig()
      const signal = exec?.signal
      const h = await core.health(config)
      const state = await core.loadState(config)
      const names = profile ? [await resolveProfileArg(profile, config)] : await core.listKnownProfiles(config)
      const online = h.gh.found && h.auth?.authenticated === true
      const rows: StatusRow[] = []
      for (const name of names) {
        if (!online) {
          // Without a usable gh the gist cannot be read, but what this machine
          // tracks is still known from the state file. Claiming "not tracked"
          // here would be a lie in exactly the situation the tool exists for.
          const record = state.profiles?.[name]
          rows.push({
            profile: name,
            status: record?.gistId ? 'unknown' : 'untracked',
            gistUrl: record?.gistUrl ?? null,
          })
          continue
        }
        rows.push(await core.profileStatus(name, { ghPath: h.gh.path, config, state, signal }))
      }
      const tracking = Object.keys(state.profiles ?? {})
      const body = formatStatusReport(h, rows, h.statePath)
      const untracked = names.filter((n) => !tracking.includes(n))
      const suffix = untracked.length
        ? `\n\nNot tracked yet: ${untracked.join(', ')}. Run gist_upload to create their gists.`
        : ''
      return text(body + suffix)
    },
  })

  const uploadTool = contentTool<UploadArgs>({
    name: 'gist_upload',
    description:
      'Upload local DeepSeek Harness profile configuration to GitHub Gists (the "sync out" direction). ' +
      'Creates a secret gist on a profile\'s first upload, then updates that same gist on later runs. ' +
      'Removes gist files that are no longer TRACKED (absent from the configured profileFiles), so a file ' +
      'added to the gist by hand is deleted, with no backup of it. A tracked file that is merely missing ' +
      'from disk is never deleted — the upload fails instead, because the gist may hold the only copy. ' +
      'Never modifies local files. If the gist was genuinely deleted, a new one is created and the ' +
      'replaced URL is reported.',
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description:
            'Profile to upload. Omit to upload every profile that still has a directory on this ' +
            'machine; a tracked profile whose directory is gone is named in the result rather than ' +
            'silently skipped, because gist_download is what restores it.',
        },
        description: {
          type: 'string',
          description: 'Gist description to set. Defaults to a generated per-profile description.',
        },
        force: {
          type: 'boolean',
          description:
            'Also delete gist files that are tracked but missing from disk, discarding the only ' +
            'remaining copy. Defaults to false, which makes such an upload fail instead.',
        },
        verifyGh: {
          type: 'boolean',
          description: 'Check that gh is installed and authenticated before uploading. Defaults to true.',
        },
      },
      additionalProperties: false,
    },
    run: async ({ profile, description, force, verifyGh }, exec) => {
      const config = withConfig()
      const signal = exec?.signal
      const ghPath = verifyGh === false ? (await core.resolveGh(config)).path : await requireGh(config)
      if (!ghPath) throw new Error('gh CLI not found; set `ghPath` in this plugin\'s config.')
      // Local, not known: an upload pushes what is on disk, and a profile the
      // state file still tracks but whose directory is gone has nothing to send.
      // It is named in the result rather than dropped, because silently omitting a
      // tracked profile is how a reader concludes their backups are complete.
      //
      // Only for a bulk upload, though: when one profile was named, every other
      // profile is simply not selected, and reporting those as "no directory on this
      // machine" would be false.
      const names = profile ? [await resolveProfileArg(profile, config)] : await core.listProfiles(config)
      const skipped: string[] = profile
        ? []
        : (await core.listKnownProfiles(config)).filter((name) => !names.includes(name))
      if (names.length === 0 && skipped.length === 0) return text('No profiles found; nothing to upload.')

      const lines: string[] = []
      for (const name of names) {
        try {
          const result = await core.uploadProfile(name, { ghPath, config, description, force, signal })
          const parts = [`${name}: ${result.created ? 'created' : 'updated'} ${result.gistUrl}`]
          parts.push(`  files: ${result.uploadedFiles.join(', ')}`)
          if (result.replaced) {
            parts.push(`  REPLACED a gist that could not be read; the previous one was ${result.replaced}`)
          }
          if (result.pruned.length) {
            parts.push(`  removed from the gist (no longer tracked): ${result.pruned.join(', ')}`)
          }
          if (result.dropped.length) {
            parts.push(
              `  DELETED from the gist because force was set, though they are still tracked: ${result.dropped.join(', ')}`,
            )
          }
          if (result.missing.length) parts.push(`  absent locally: ${result.missing.join(', ')}`)
          lines.push(parts.join('\n'))
        } catch (error) {
          lines.push(`${name}: FAILED - ${(error as Error).message}`)
        }
      }
      if (skipped.length > 0) {
        lines.push(
          `${skipped.join(', ')}: NOT uploaded - no profile directory on this machine. ` +
            'Run gist_download to restore it from its gist.',
        )
      }
      return text(lines.join('\n\n'))
    },
  })

  const downloadTool = contentTool<DownloadArgs>({
    name: 'gist_download',
    description:
      'Download GitHub Gist configuration over the local DeepSeek Harness profile files (the "sync in" ' +
      'direction). Local files are backed up under the state directory first. Restoring files that are ' +
      'simply missing locally needs no force; overwriting local changes that were never uploaded does, ' +
      'and is refused otherwise. Tracked files the gist does not carry are kept, never deleted. The write ' +
      'is all-or-nothing: content is staged first and then renamed into place, so a failure part way ' +
      'through leaves every file exactly as it was.',
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Profile to download. Omit to download every tracked profile.',
        },
        force: {
          type: 'boolean',
          description:
            'Overwrite local files even when they hold unsynced changes. A backup is still taken first. ' +
            'Defaults to false.',
        },
      },
      additionalProperties: false,
    },
    run: async ({ profile, force }, exec) => {
      const config = withConfig()
      const signal = exec?.signal
      const ghPath = await requireGh(config)
      const state = await core.loadState(config)
      // Known, not local: a profile whose directory was deleted outright is still
      // tracked, and its gist is the only copy left. Listing directories alone
      // would hide exactly the profile that needs restoring.
      const names = profile ? [await resolveProfileArg(profile, config)] : await core.listKnownProfiles(config)
      const tracked = names.filter((n) => state.profiles?.[n]?.gistId)
      if (tracked.length === 0) {
        return text('Nothing to download: no profile has a gist yet. Run gist_upload first.')
      }

      const lines: string[] = []
      for (const name of tracked) {
        try {
          const result = await core.downloadProfile(name, { ghPath, config, force, signal })
          const parts = [`${name}: restored from ${result.gistUrl}`, `  files: ${result.written.join(', ')}`]
          if (result.keptLocally.length) {
            parts.push(`  kept locally (the gist does not carry them): ${result.keptLocally.join(', ')}`)
          }
          if (result.backupDir) parts.push(`  previous files backed up to: ${result.backupDir}`)
          lines.push(parts.join('\n'))
        } catch (error) {
          lines.push(`${name}: FAILED - ${(error as Error).message}`)
        }
      }
      return text(lines.join('\n\n'))
    },
  })

  const syncTool = contentTool<SyncArgs>({
    name: 'gist_sync',
    description:
      'Synchronise local DeepSeek Harness profile configuration with GitHub Gists in one step. ' +
      'Uploads when only local files changed, downloads when only the gist changed, restores tracked ' +
      'files that went missing locally, creates a gist for an untracked or genuinely deleted one, and ' +
      'does nothing when both sides already match. When both sides changed it refuses to guess and ' +
      'reports a divergence unless force is true. A gist that merely cannot be reached is never treated ' +
      'as deleted. A deletion is never propagated in either direction: a tracked file removed from the ' +
      'gist is put back into it in the same call, and a tracked file deleted locally is not removed ' +
      'from the gist. To apply a deletion, delete the side that still holds the copy first.',
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Profile to sync. Omit to sync every profile.',
        },
        force: {
          type: 'boolean',
          description:
            'Resolve without stopping to ask. A divergence is resolved by uploading the local files; a ' +
            'restore that would discard unsynced local edits is allowed through instead of being refused ' +
            '(a backup is taken first). Defaults to false.',
        },
      },
      additionalProperties: false,
    },
    run: async ({ profile, force }, exec) => {
      const config = withConfig()
      const signal = exec?.signal
      const ghPath = await requireGh(config)
      const names = profile ? [await resolveProfileArg(profile, config)] : await core.listKnownProfiles(config)
      if (names.length === 0) return text('No profiles found; nothing to sync.')

      const lines: string[] = []
      for (const name of names) {
        try {
          const result = await core.syncProfile(name, { ghPath, config, force, signal })
          let detail =
            result.action === 'noop'
              ? `already in sync (${result.gistUrl ?? 'no gist url'})`
              : `${result.action} ${result.gistUrl ?? ''}`.trim()
          if (result.replaced) {
            detail += `\n  REPLACED a gist that could not be read; the previous one was ${result.replaced}`
          }
          if (result.pruned?.length) {
            detail += `\n  removed from the gist (no longer tracked): ${result.pruned.join(', ')}`
          }
          if (result.dropped?.length) {
            detail +=
              `\n  DELETED from the gist because force was set, though they are still tracked: ` +
              result.dropped.join(', ')
          }
          // `keptLocally` means "still here and still absent from the gist", which
          // stops being true when the same call republished them.
          if (result.keptLocally?.length && !result.republished?.length) {
            detail += `\n  kept locally (the gist does not carry them): ${result.keptLocally.join(', ')}`
          }
          if (result.republished?.length) {
            detail += `\n  the gist had dropped these; put back from the local copy: ${result.republished.join(', ')}`
          }
          if (result.written?.length) {
            detail += `\n  restored: ${result.written.join(', ')}`
          }
          if (result.backupDir) {
            detail += `\n  previous files backed up to: ${result.backupDir}`
          }
          lines.push(`${name}: ${detail}`)
        } catch (error) {
          lines.push(`${name}: FAILED - ${(error as Error).message}`)
        }
      }
      return text(lines.join('\n'))
    },
  })

  return [statusTool, uploadTool, downloadTool, syncTool]
}

/**
 * @param ctx - the plugin's Cordis context; `ctx.tools` comes from `inject`.
 * @param config - this row's `config:` block from the profile patch.
 */
export function apply(ctx: PluginContext, config: unknown): void {
  const userConfig = readConfig(config)
  ctx.effect(function* registerGistTools() {
    for (const tool of buildTools(ctx, userConfig)) {
      yield ctx.tools.register(tool)
    }
  }, 'dsh-gist-settings tools')
}