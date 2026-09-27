/**
 * Host half of `dsh-gist-settings`.
 *
 * Registers four agent tools that back a DeepSeek Harness profile's
 * configuration up to GitHub Gists (and restore it) through the locally
 * installed `gh` CLI. All real work lives in `./lib/core.js`, which has no
 * Cordis dependency and is covered by `test/sync.test.mjs`.
 *
 * Tool definitions are written as plain objects rather than built with
 * `defineTool` from `@deepseek-ai/dsh-tools`, so the bundle imports nothing
 * from the Harness installation and cannot break on a module-resolution change.
 * The shape mirrors what `defineTool` produces: `parameters` is raw JSON Schema
 * and `execute` returns the canonical value that `output.render` projects into
 * content blocks.
 */

import * as core from './lib/core.js'

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
function readConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`config must be a mapping, received ${Array.isArray(input) ? 'an array' : typeof input}`)
  }

  const unknown = Object.keys(input).filter((key) => !KNOWN_CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `unknown config key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}; ` +
        `known keys are ${KNOWN_CONFIG_KEYS.join(', ')}`,
    )
  }

  const str = (key) => {
    const value = input[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`config.${key} must be a non-empty string`)
    }
    return value.trim()
  }

  const stringList = (key) => {
    const value = input[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`config.${key} must be a non-empty array of strings`)
    }
    const parts = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
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
  let ghPath
  if (input.ghPath !== undefined) {
    ghPath = Array.isArray(input.ghPath) ? stringList('ghPath') : str('ghPath')
  }

  return {
    ghPath,
    dshHome: str('dshHome'),
    profilesDir: str('profilesDir'),
    stateDir: str('stateDir'),
    profileFiles: stringList('profileFiles'),
  }
}

/** Resolve `gh` and refuse to continue unless it is installed and authenticated. */
async function requireGh(config) {
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
 * `node_modules` store, and `lib/core.js` re-checks containment against real
 * paths so a junction cannot redirect the read or the write.
 */
function assertProfileName(name) {
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

/* ------------------------------------------------------------- formatting -- */

const STATUS_LABEL = {
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

function formatStatusReport(health, rows, statePath) {
  const lines = []
  if (health.gh.found) {
    lines.push(`gh:   ${health.gh.version}`)
    lines.push(`      ${health.gh.path}`)
  } else {
    lines.push(`gh:   NOT FOUND - ${health.gh.reason}`)
  }
  lines.push(
    `auth: ${health.auth?.authenticated ? `ok (${health.auth.account})` : 'NOT AUTHENTICATED - run `gh auth login`'}`,
  )
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
function checkArgs(toolName, parameters, args) {
  const input = args === undefined || args === null ? {} : args
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `invalid arguments for ${toolName}: expected an object, received ${Array.isArray(input) ? 'an array' : typeof input}`,
    )
  }

  const properties = parameters.properties ?? {}
  const problems = []

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(properties, key)) problems.push(`unknown argument "${key}"`)
  }

  const accepted = {}
  for (const [key, schema] of Object.entries(properties)) {
    const value = input[key]
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
  return accepted
}

/**
 * Build a registry-ready tool.
 *
 * The canonical value is a domain-owned DTO rather than the framework's
 * `@internal` content-blocks-as-value test fixture: `output.schema` is what PTC
 * mode projects into a generated SDK, so an untyped array would hand the model
 * `list[Any]` instead of a described result.
 */
function contentTool({ name, description, parameters, run, concurrencySafe = false }) {
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
      return await run(checkArgs(name, parameters, args), exec)
    },
  }
}

/** The canonical value every tool returns; `output.render` turns it into content. */
const text = (body) => ({ text: body })

/* ----------------------------------------------------------------- tools -- */

function buildTools(ctx, userConfig) {
  const withConfig = (config) => ({ ...userConfig, ...config })

  const statusTool = contentTool({
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
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(config)
      const online = h.gh.found && h.auth?.authenticated === true
      const rows = []
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

  const uploadTool = contentTool({
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
          description: 'Profile to upload. Omit to upload every profile.',
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
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(config)
      if (names.length === 0) return text('No profiles found; nothing to upload.')

      const lines = []
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
          if (result.missing.length) parts.push(`  absent locally: ${result.missing.join(', ')}`)
          lines.push(parts.join('\n'))
        } catch (error) {
          lines.push(`${name}: FAILED - ${error.message}`)
        }
      }
      return text(lines.join('\n\n'))
    },
  })

  const downloadTool = contentTool({
    name: 'gist_download',
    description:
      'Download GitHub Gist configuration over the local DeepSeek Harness profile files (the "sync in" ' +
      'direction). Local files are backed up under the state directory first. Restoring files that are ' +
      'simply missing locally needs no force; overwriting local changes that were never uploaded does, ' +
      'and is refused otherwise. Tracked files the gist does not carry are kept, never deleted.',
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
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(config)
      const tracked = names.filter((n) => state.profiles?.[n]?.gistId)
      if (tracked.length === 0) {
        return text('Nothing to download: no profile has a gist yet. Run gist_upload first.')
      }

      const lines = []
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
          lines.push(`${name}: FAILED - ${error.message}`)
        }
      }
      return text(lines.join('\n\n'))
    },
  })

  const syncTool = contentTool({
    name: 'gist_sync',
    description:
      'Synchronise local DeepSeek Harness profile configuration with GitHub Gists in one step. ' +
      'Uploads when only local files changed, downloads when only the gist changed, restores tracked ' +
      'files that went missing locally, creates a gist for an untracked or genuinely deleted one, and ' +
      'does nothing when both sides already match. When both sides changed it refuses to guess and ' +
      'reports a divergence unless force is true. A gist that merely cannot be reached is never treated ' +
      'as deleted.',
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Profile to sync. Omit to sync every profile.',
        },
        force: {
          type: 'boolean',
          description: 'Resolve a divergence by uploading the local files. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
    run: async ({ profile, force }, exec) => {
      const config = withConfig()
      const signal = exec?.signal
      const ghPath = await requireGh(config)
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(config)
      if (names.length === 0) return text('No profiles found; nothing to sync.')

      const lines = []
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
          if (result.keptLocally?.length) {
            detail += `\n  kept locally (the gist does not carry them): ${result.keptLocally.join(', ')}`
          }
          lines.push(`${name}: ${detail}`)
        } catch (error) {
          lines.push(`${name}: FAILED - ${error.message}`)
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
export function apply(ctx, config) {
  const userConfig = readConfig(config)
  ctx.effect(function* registerGistTools() {
    for (const tool of buildTools(ctx, userConfig)) {
      yield ctx.tools.register(tool)
    }
  }, 'dsh-gist-settings tools')
}