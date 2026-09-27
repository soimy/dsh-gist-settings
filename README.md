# dsh-gist-settings

**English** · [中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) Cordis plugin that backs up and restores your
Harness **profile configuration** to **GitHub Gists**, using the `gh` CLI you already have installed
and authenticated.

One secret gist per profile, holding that profile's tracked config files. Upload, download, and a
guarded two-way sync are exposed as agent tools, so you can drive them from a conversation.

## Status

| Part | State |
|---|---|
| Sync engine (`lib/core.js`) | Done |
| Host plugin + agent tools | **Installed and live**; callable from a session |
| Real GitHub round-trip | **Verified** against a real account |
| Test suite | **116 offline cases + 10 live cases**, all passing |
| Client settings page | Not started — see [The settings page](#the-settings-page) |
| Licence | MIT |

This code has been through an adversarial review (independent security, correctness, integration,
mutation-testing and documentation audits). Everything they proved is fixed and pinned by a
regression test; the [safety model](#the-safety-model) below describes the resulting behaviour
rather than the original intent.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the issue, pull-request and
changelog conventions, and [CHANGELOG.md](CHANGELOG.md) for what has changed.

## Requirements

- **Node.js 20+** (uses `import.meta.dirname` in the tests and `node:` prefixed built-ins).
- **`gh` CLI, installed and authenticated.**

  ```bash
  gh auth login
  ```

  Gists are read and written through `gh api`, so no extra OAuth scopes are needed beyond the
  default. The plugin never stores, reads, or asks for a token of its own — `gh` owns the credential.

  If `gh` is not on the `PATH` of the process running the Harness — common on Windows right after
  installing it — the plugin probes the usual install locations before giving up, and you can always
  name the binary explicitly with `ghPath`.

## Install

Installing requires a session with **full access** or an approval prompt; `plugin_manager` refuses
otherwise. An install can also ask for approval of package build scripts, which this bundle does not
have.

```
plugin_manager  action: install_bundle  target: <absolute path to this directory>
```

That links this directory into the profile, adds the bundle to `dsh.profile.bundles`, and applies the
patch in `cordis.patch.yml`. Afterwards a restart is needed before a new module generation loads.

Do not add the bundle row or the dependency to the profile by hand — `install_bundle` owns the
selection. The row's `config:` block is yours to edit (see [Configuration](#configuration)).

### Uninstall

```
plugin_manager  action: remove_bundle  target: @local/dsh-gist-settings
```

The gists the plugin created are **not** touched. To remove those too, delete them on GitHub (the
URLs are in `state.json`), then delete the state directory:

```
<stateDir>            # default: <dshHome>/gist-settings
```

That directory holds `state.json` (the profile → gist mapping), `state.json.bak`, and every backup
the plugin has taken. Deleting it loses the mapping and the local backups, but not the gists.

## Tools

| Tool | Direction | What it does |
|---|---|---|
| `gist_status` | — | Reports whether `gh` is installed and authenticated, then lists every profile with its gist URL and sync state. Never touches profile files or the gist; it may repair a stale sync baseline in its own state file. |
| `gist_upload` | local → gist | Creates a secret gist on a profile's first upload, then updates that same gist. **Removes gist files that are no longer tracked** — see the warning below. Never modifies local files. |
| `gist_download` | gist → local | Restores local files from the gist. Backs up the existing local files first. |
| `gist_sync` | both | Fast-forwards whichever side changed, restores tracked files that went missing locally, and does nothing when both sides match. Refuses to guess on a true divergence. |

All four accept an optional `profile`; omitting it operates on every profile. A failure on one
profile never aborts the others. Every argument is type-checked — a wrong type or an unknown key is
an error, never a silent coercion, so `force: "false"` cannot become a forced overwrite.

**Profile names are matched exactly.** `ALPHA` is refused when the directory is `alpha`, because on
Windows and macOS those name one directory and accepting both would back it up twice, into two gists
that then diverge silently. The error names the real profile. An unknown name is refused with the
list of the ones that exist, rather than failing later with a confusing "has none of the tracked
files".

### Status vocabulary

`gist_status` prints exactly these:

| Printed | Meaning |
|---|---|
| `not tracked` | No gist exists for this profile yet. |
| `in sync` | Local and gist agree. |
| `local changes to upload` | Only the local side changed since the last sync. |
| `gist changes to download` | Only the gist changed since the last sync. |
| `DIVERGED - needs a decision` | Both sides changed. Nothing is guessed; choose a direction. |
| `tracked files missing locally - run gist_download to restore` | A tracked file is gone from disk but still in the gist. |
| `gist deleted - the next upload recreates it` | GitHub returned a genuine 404 for the gist. |
| `gist UNREACHABLE (not deleted) - retry when connected` | The gist could not be read for any other reason — offline, 401, 5xx, rate limit. |
| `unknown - gh is unavailable, remote state not checked` | `gh` is missing or logged out, so only the local tracking record is known. |

> **`gist_upload` deletes gist files that are no longer tracked, and keeps no backup of them.** "No
> longer tracked" means absent from the configured `profileFiles` — not merely missing from disk. A
> file added to the gist by hand (through the GitHub web UI, say) *will* be removed by the next
> upload. A tracked file that is only missing locally is a different case: the upload **fails** and
> tells you to download instead, because the gist may hold the only remaining copy. `force: true`
> overrides that and deletes it from the gist too.

## Configuration

Tunable values live in the profile patch layer, so they survive plugin upgrades. Edit the
`dsh-gist-settings` row's `config:` block in your profile's `cordis.patch.yml` (the commented block
in this repo's `cordis.patch.yml` is the template):

| Key | Default | Meaning |
|---|---|---|
| `ghPath` | probe `PATH`, then well-known install dirs | Path to the `gh` binary. May also be an array of `[command, ...prefixArgs]` to reach gh through a wrapper, e.g. `['wsl', 'gh']`. |
| `profileFiles` | `['cordis.patch.yml', 'package.json']` | Which files in each profile directory are tracked. |
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | Harness home directory. A leading `~` is expanded and relative values are resolved against the process working directory. |
| `profilesDir` | `<dshHome>/profiles` | Where profiles live. |
| `stateDir` | `<dshHome>/gist-settings` | Where the gist index and backups are written. |

The plugin declares no `Config` schema, so it validates the block itself at load time: an unknown key
is rejected with the list of known keys, and a wrong type is rejected rather than silently falling
back to a default. A typo therefore fails loudly instead of quietly changing which files are backed up.

## The safety model

**Gist layout.** One secret gist per profile, described as `DeepSeek Harness profile config: <name>`,
containing that profile's tracked files under their own names. The profile-to-gist mapping lives in
`<stateDir>/state.json`.

**A transient failure is never mistaken for a deletion.** `gh` reports a deleted gist and an expired
token the same way — exit 1 with a message on stderr. Only a genuine `HTTP 404` is read as "the gist
is gone"; a 401, a 5xx, a rate limit or a DNS failure yields `unreachable`, and both upload and sync
refuse rather than mint a replacement gist that would abandon the original.

**Divergence is never guessed at.** The state file records the content hash of the last agreed
revision as a baseline. Comparing the current local and gist hashes against it distinguishes
"only local changed" (safe to upload) from "only the gist changed" (safe to download) from "both
changed" (`diverged`, and the plugin stops). Only the *tracked* subset of the gist is compared, so an
extra file in the gist cannot make a profile look permanently out of date.

**A tracked file missing locally is restored, not deleted.** It is reported as its own state, sync
downloads it, and an upload refuses without `force`. This is the one asymmetry the tools never
resolve on their own, because the gist may hold the only copy.

**Backups before destructive writes.** `gist_download` copies the profile's tracked files to
`<stateDir>/backups/<profile>/<timestamp>/` before overwriting anything, including when forced. The
backup is taken before the first write, so a cancelled or failed download leaves the profile
untouched.

**Containment.** Profile names are validated against the framework's own rules, and the resolved
directory is re-checked against `realpath(profilesDir)`. A junction or symlink placed at
`profiles/<name>` is refused rather than followed, so the tools cannot read or write outside the
profiles directory.

**No interactive editor, ever.** Gist reads and writes go through `gh api`. The obvious alternative,
`gh gist edit`, opens `$EDITOR` and would hang a non-interactive plugin host.

**No imports from the Harness installation.** Tool definitions are written as plain objects matching
the shape `defineTool` produces. This keeps the bundle immune to module-resolution changes;
`test/schema.test.mjs` replays the Harness's own validators so the definitions cannot silently drift
out of contract. The trade-off is that the Harness's version gate cannot see the plugin either, so
`peerDependencies` pins the DSH version it was written against.

**A secret gist URL is a bearer read capability.** Anyone holding the URL can read a secret gist, and
the tools return that URL in their output, which becomes part of the conversation transcript. Treat
the URLs accordingly.

## Repository layout

```
index.js               Host plugin: registers the four agent tools
lib/core.js            Sync engine — no Cordis dependency, directly testable
cordis.patch.yml       Bundle patch (inserts the plugin row; documents config)
client.js              Client settings page (not yet written)
locale/{en,zh}.json    Plugin display metadata for Plugin Manager cards
icon.svg               Bundle icon
test/                  116 offline cases across four suites, plus 10 live ones
scripts/               check-changelog.mjs — validates CHANGELOG.md
.github/               Issue forms and the pull-request template
```

## Documentation

| Document | What it covers |
|---|---|
| [README.zh-CN.md](README.zh-CN.md) | This README in Chinese. The two are kept in sync; a behaviour change that updates only one is incomplete. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Reporting, development setup, what each test suite proves, and the changelog, commit and release conventions. |
| [CHANGELOG.md](CHANGELOG.md) | Every notable change, newest first, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. |
| [LICENSE](LICENSE) | MIT. |

## Development

```bash
npm test                # the four offline suites (116 cases) plus the changelog check
npm run test:sync       # engine lifecycle against a fake gh
npm run test:tools      # tool layer, argument validation, failure isolation
npm run test:schema     # definitions vs. the installed Harness validators
npm run test:regression # the defects the adversarial review found
npm run changelog:check # CHANGELOG.md structure and version consistency
npm run test:live       # opt-in: real GitHub
```

`test/fake-gh.mjs` is an in-memory stand-in for `gh` implementing `--version`, `auth status`, and the
`/gists` API, with optional injection of truncated files, HTTP 500s and a logged-out CLI. The `sync`,
`tools` and `regression` suites point `ghPath` at it, so the whole lifecycle — create, upload,
download, divergence, backup, pruning, gist recreation, idempotency, recovery — runs offline with no
GitHub account.

`test/schema.test.mjs` locates the installed `@deepseek-ai/dsh-tools` from `process.execPath`
(override with `DSH_TOOLS_DIR`) and replays the runtime's own checks: the registration contract, the
supported JSON Schema subset, argument validation, and that each tool's returned value satisfies its
declared output schema. **Finding no installation fails the suite** rather than skipping, because a
silent skip would leave `npm test` green with none of those checks having run; set
`DSH_ALLOW_SCHEMA_SKIP=1` to accept the skip deliberately.

`test/live.test.mjs` is **opt-in** because it creates a real secret gist. It works inside a throwaway
`DSH_HOME` under the OS temp directory, so no real profile is read or written, and it deletes the gist
it created even when an assertion fails.

```powershell
$env:DSH_GIST_LIVE_TEST='1'; npm run test:live     # PowerShell
```

```bash
DSH_GIST_LIVE_TEST=1 npm run test:live             # bash
```

Because `install_bundle` links this directory into the profile, the working copy **is** the live
plugin: edits to `index.js` and `lib/` take effect on reload.

## The settings page

A Client settings page is planned but not written. Two findings shape it:

1. **The active profile has no Web UI.** The `dsh-tui` profile composes the terminal interface; the
   `dsh-web-app` bundle — which provides the browser surface and the settings slots — is disabled
   there. A settings page therefore has nowhere to render until the plugin is also installed into the
   `web` profile, or the web bundle is enabled for `dsh-tui`.

2. **Client-to-Host calls need a supported channel.** The shipped, typed route is the settings domain
   (`ctx.remote.settings.*`, or the `ctx.configForms` wrapper), which requires the Host half to
   declare a settings namespace — and that means importing the Harness's `schemastery` from a
   workspace-installed bundle, which is unverified for a non-shipped bundle. The alternative, the raw
   `ctx.connection.rpc` channel, is fully typed but has no shipped consumer outside the API gateway.
   This is the open question to settle before writing `client.js`.

The page is intended to register into the `settings.section` slot (one nav entry in the Settings
dialog), showing the same table as `gist_status` with buttons wired to the four operations.

## Licence

[MIT](LICENSE) © 2026 Shen Yiming.

`package.json` sets `"private": true` on purpose: it means the package is never published to npm and
exists only to be installed as a local bundle. That is orthogonal to the licence.

## Review history

An adversarial review of this repository found, among other things: a `gh` failure that could kill
the whole Harness process; every gist read error being read as "deleted", silently forking backups;
and an upload that deleted the gist's only copy of a file that was merely missing from disk. All of
those are fixed and covered by `test/regression.test.mjs`, whose cases are written to fail if the fix
is reverted. The review also confirmed several things were already sound: the registration contract,
the effect and disposal lifecycle, the manifest, and the divergence classifier when both sides hash
the same file set.