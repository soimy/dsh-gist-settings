# dsh-gist-settings

A [DeepSeek Harness](https://github.com/deepseek-ai) Cordis plugin that backs up and restores your
Harness **profile configuration** to **GitHub Gists**, using the `gh` CLI you already have installed
and authenticated.

One secret gist per profile, holding that profile's tracked config files. Upload, download, and a
guarded two-way sync are exposed as agent tools, so you can drive them from a conversation.

## Status

| Part | State |
|---|---|
| Sync engine (`lib/core.js`) | Done — 19 tests |
| Host plugin + agent tools | **Installed and live**; callable from a session |
| Real GitHub round-trip | **Verified** — 10 live cases against a real account |
| Client settings page | Not started — see [The settings page](#the-settings-page) |

## Requirements

- **Node.js 18+** (uses `node:` prefixed built-ins and ESM).
- **`gh` CLI, installed and authenticated.** The plugin shells out to `gh` for every GitHub call.

  ```bash
  gh auth login
  ```

  Gists are read and written through `gh api`, so no extra OAuth scopes are needed beyond the
  default. The plugin never stores, reads, or asks for a token of its own — `gh` owns the credential.

  If `gh` is not on the `PATH` of the process running the Harness — which is common on Windows
  right after installing it — the plugin probes the usual install locations before giving up, and
  you can always name the binary explicitly with `ghPath`.

## Install

The bundle installs into a profile and survives restarts:

```
plugin_manager  action: install_bundle  target: <absolute path to this directory>
```

That links this directory into the profile, adds the bundle to `dsh.profile.bundles`, and applies
the patch in `cordis.patch.yml`. Do not edit the profile's `package.json` or `cordis.patch.yml` by
hand — `install_bundle` owns those steps.

Afterwards a restart is needed before the new module generation is loaded.

## Tools

| Tool | Direction | What it does |
|---|---|---|
| `gist_status` | — | Reports whether `gh` is installed and authenticated, then lists every profile with its gist URL and sync state: `in sync`, `local changes to upload`, `gist changes to download`, `DIVERGED`, `gist missing`, or `not tracked`. Read-only. |
| `gist_upload` | local → gist | Creates a secret gist on a profile's first upload, then updates that same gist on later runs, **including deleting gist files that are no longer tracked**. Never touches local files. |
| `gist_download` | gist → local | Restores local files from the gist. Backs up the existing local files first, and refuses to overwrite unsynced local changes unless `force` is true. |
| `gist_sync` | both | Fast-forwards whichever side changed, creates a gist for an untracked profile, and does nothing when both sides match. On a true divergence it refuses to guess and reports it unless `force` is true. |

All four accept an optional `profile`; omitting it operates on every profile. A failure on one
profile never aborts the others.

## Configuration

Tunable values live in the profile patch layer, so they survive plugin upgrades. Edit the
`dsh-gist-settings` row's `config:` block in your profile's `cordis.patch.yml` (the commented block
in this repo's `cordis.patch.yml` is the template):

| Key | Default | Meaning |
|---|---|---|
| `ghPath` | probe `PATH`, then well-known install dirs | Path to the `gh` binary. May also be an array of `[command, ...prefixArgs]` to reach gh through a wrapper, e.g. `['wsl', 'gh']`. |
| `profileFiles` | `['cordis.patch.yml', 'package.json']` | Which files in each profile directory are tracked. |
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | Harness home directory. |
| `profilesDir` | `<dshHome>/profiles` | Where profiles live. |
| `stateDir` | `<dshHome>/gist-settings` | Where the gist index and backups are written. |

The plugin declares no `Config` schema, so these are validated in code and reported as clear errors
rather than by the Loader at startup.

## How it works

**Gist layout.** One secret gist per profile, described as `DeepSeek Harness profile config: <name>`,
containing that profile's tracked files under their own names. The profile-to-gist mapping lives in
`<stateDir>/state.json`.

**Divergence is never guessed at.** The state file records the content hash of the last successful
sync as a baseline. Comparing the current local hash and the current gist hash against that baseline
distinguishes four cases unambiguously:

- only local changed → `local-ahead`, safe to fast-forward by uploading
- only the gist changed → `remote-ahead`, safe to fast-forward by downloading
- both changed → `diverged`, and the plugin stops and asks
- neither changed → `in-sync`

Without a baseline (first contact) the plugin also reports `diverged` rather than picking a winner.

**Backups before destructive writes.** `gist_download` copies the profile's tracked files to
`<stateDir>/backups/<profile>/<timestamp>/` before overwriting anything, including when forced.

**No interactive editor, ever.** Gist reads and writes go through `gh api`. The obvious alternative,
`gh gist edit`, opens `$EDITOR` and would hang a non-interactive plugin host.

**No imports from the Harness installation.** Tool definitions are written as plain objects matching
the shape `defineTool` produces — raw JSON Schema `parameters`, plus an `output` schema and a `render`
projection. This keeps the bundle immune to module-resolution changes; `test/schema.test.mjs` replays
the Harness's own validators so the definitions cannot silently drift out of contract.

**Path-traversal guard.** Profile names are validated against `^[A-Za-z0-9._-]+$` before they reach
the filesystem.

## Repository layout

```
index.js              Host plugin: registers the four agent tools
lib/core.js           Sync engine — no Cordis dependency, directly testable
cordis.patch.yml      Bundle patch (inserts the plugin row; documents config)
client.js             Client settings page (not yet written)
locale/{en,zh}.json   Plugin display metadata for Plugin Manager cards
icon.svg              Bundle icon
test/                 58 tests across four suites
```

## Development

```bash
npm test            # the three offline suites
npm run test:sync   # engine lifecycle against a fake gh
npm run test:tools  # tool layer against a fake gh
npm run test:schema # definitions vs. the installed Harness validators
npm run test:live   # opt-in: real GitHub, needs DSH_GIST_LIVE_TEST=1
```

`test/fake-gh.mjs` is an in-memory stand-in for `gh` implementing `--version`, `auth status`, and the
`/gists` API. The `sync` and `tools` suites point `ghPath` at it, so the whole lifecycle — create,
upload, download, divergence, backup, pruning, gist recreation, idempotency — runs offline with no
GitHub account.

`test/schema.test.mjs` locates the installed `@deepseek-ai/dsh-tools` from `process.execPath`
(override with `DSH_TOOLS_DIR`) and skips cleanly when absent.

`test/live.test.mjs` is **opt-in** because it creates a real secret gist:

```bash
DSH_GIST_LIVE_TEST=1 npm run test:live
```

It works inside a throwaway `DSH_HOME` under the OS temp directory, so no real profile is read or
written, and it deletes the gist it created even when an assertion fails. It covers what the fake
cannot: that `gh api` really accepts our POST/PATCH/DELETE bodies, that a `PATCH` carrying a `null`
file value really deletes that file, and that content survives a real round trip byte for byte.

Because `install_bundle` links this directory into the profile, the working copy **is** the live
plugin: edits to `index.js` and `lib/` take effect on reload.

## The settings page

A Client settings page is planned but not written. Two findings shape it:

1. **The active profile has no Web UI.** The `dsh-tui` profile composes the terminal interface;
   the `dsh-web-app` bundle — which provides the browser surface and the settings slots — is
   disabled there. A settings page therefore has nowhere to render until the plugin is installed
   into the `web` profile, or the web bundle is enabled for `dsh-tui`.

2. **Client-to-Host calls need a supported channel.** The shipped, typed route is the settings
   domain (`ctx.remote.settings.*`, or the `ctx.configForms` wrapper), which requires the Host half
   to declare a settings namespace — and that in turn means importing the Harness's `schemastery`
   from a workspace-installed bundle, which is unverified for non-shipped bundles. The alternative,
   the raw `ctx.connection.rpc` channel, is fully typed but has no shipped consumer outside the API
   gateway. This is the open question to settle before writing `client.js`.

The page is intended to register into the `settings.section` slot (one nav entry in the Settings
dialog), showing the same status table as `gist_status` with buttons wired to the four operations.