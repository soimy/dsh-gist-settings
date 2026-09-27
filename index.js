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

/** Accept only the config fields we understand; ignore anything else. */
function readConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const list = (value) =>
    Array.isArray(value) && value.length > 0 ? value.filter((v) => typeof v === 'string' && v) : undefined
  /**
   * `ghPath` is a string for a normal install. An array is the escape hatch for
   * reaching gh through a wrapper — `['wsl', 'gh']`, a shim script, a portable
   * build invoked by its interpreter.
   */
  const ghPath = (() => {
    const single = str(input.ghPath)
    if (single) return single
    const parts = list(input.ghPath)
    return parts && parts.length > 0 ? parts.map((part) => part.trim()) : undefined
  })()
  return {
    ghPath,
    dshHome: str(input.dshHome),
    profilesDir: str(input.profilesDir),
    stateDir: str(input.stateDir),
    profileFiles: list(input.profileFiles),
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

/** Guard a profile name against path traversal before it reaches the filesystem. */
function assertProfileName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
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
  'missing-gist': 'gist missing (deleted?)',
  'missing-local': 'no local config files',
}

function formatStatusReport(health, rows, statePath) {
  const lines = []
  if (health.gh.found) {
    lines.push(`gh:   ${health.gh.version}`)
    lines.push(`      ${health.gh.path}`)
  } else {
    lines.push(`gh:   NOT FOUND - ${health.gh.reason}`)
  }
  lines.push(`auth: ${health.auth?.authenticated ? `ok (${health.auth.account})` : 'NOT AUTHENTICATED - run `gh auth login`'}`)
  lines.push(`home: ${health.dshHome}`)
  lines.push(`state:${statePath ? ` ${statePath}` : ''}`)
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
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------- tool shape -- */

/**
 * Build a registry-ready tool whose canonical value is its own content blocks.
 * Mirrors the harness's own `defineContentToolFixture` contract.
 */
function contentTool({ name, description, parameters, run }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'array' },
      render: (_args, value) => value,
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      return await run(input)
    },
  }
}

const text = (body) => [{ type: 'text', text: body }]

/* ----------------------------------------------------------------- tools -- */

function buildTools(ctx, userConfig) {
  const withConfig = (config) => ({ ...userConfig, ...config })

  const statusTool = contentTool({
    name: 'gist_status',
    description:
      'Report whether the local gh CLI is installed and authenticated, and show every DeepSeek Harness ' +
      'profile alongside its GitHub Gist: the gist URL, and whether the profile is in sync, has local ' +
      'changes to upload, has gist changes to download, or has diverged. Read-only; changes nothing. ' +
      'Use this first to see what needs syncing.',
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
    run: async ({ profile }) => {
      const h = await core.health(withConfig())
      const state = await core.loadState(withConfig())
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(withConfig())
      const rows = []
      for (const name of names) {
        if (!h.gh.found) {
          rows.push({ profile: name, status: 'untracked' })
          continue
        }
        rows.push(await core.profileStatus(name, { ghPath: h.gh.path, config: withConfig(), state }))
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
      'Upload local DeepSeek Harness profile configuration to GitHub Gists (the "update/sync out" direction). ' +
      'Creates a secret gist on a profile\'s first upload, then updates that same gist on later runs, including ' +
      'removing gist files that are no longer tracked. Never touches local files.',
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
        verifyGh: {
          type: 'boolean',
          description: 'Check that gh is installed and authenticated before uploading. Defaults to true.',
        },
      },
      additionalProperties: false,
    },
    run: async ({ profile, description, verifyGh }) => {
      const config = withConfig()
      const ghPath = verifyGh === false ? (await core.resolveGh(config)).path : await requireGh(config)
      if (!ghPath) throw new Error('gh CLI not found; set `ghPath` in this plugin\'s config.')
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(config)
      if (names.length === 0) return text('No profiles found; nothing to upload.')

      const lines = []
      for (const name of names) {
        try {
          const result = await core.uploadProfile(name, { ghPath, config, description })
          lines.push(
            `${name}: ${result.created ? 'created' : 'updated'} ${result.gistUrl}\n` +
              `  files: ${result.uploadedFiles.join(', ')}` +
              (result.missing.length ? `\n  absent locally: ${result.missing.join(', ')}` : ''),
          )
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
      'direction). The existing local files are backed up under the state directory first. Refuses to ' +
      'overwrite local changes that were never uploaded unless force is true.',
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
    run: async ({ profile, force }) => {
      const config = withConfig()
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
          const result = await core.downloadProfile(name, { ghPath, config, force: Boolean(force) })
          lines.push(
            `${name}: restored from ${result.gistUrl}\n` +
              `  files: ${result.written.join(', ')}` +
              (result.backupDir ? `\n  previous files backed up to: ${result.backupDir}` : ''),
          )
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
      'Uploads when only local files changed, downloads when only the gist changed, creates a gist for an ' +
      'untracked profile, and does nothing when both sides already match. When both sides changed it refuses ' +
      'to guess and reports a divergence unless force is true.',
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
    run: async ({ profile, force }) => {
      const config = withConfig()
      const ghPath = await requireGh(config)
      const names = profile ? [assertProfileName(profile)] : await core.listProfiles(config)
      if (names.length === 0) return text('No profiles found; nothing to sync.')

      const lines = []
      for (const name of names) {
        try {
          const result = await core.syncProfile(name, { ghPath, config, force: Boolean(force) })
          const detail =
            result.action === 'noop'
              ? `already in sync (${result.gistUrl ?? 'no gist url'})`
              : `${result.action} ${result.gistUrl ?? ''}`.trim()
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