# Configuration

This page is the reference for every configuration key the plugin accepts: where the block lives, what
each key means, its type and default, how its value is resolved, and the validation that refuses a value
it cannot use. The README's [Configuration](../../../README.md#configuration) section is the short
version; [tools.md](tools.md) documents the tools these settings govern.

## Where the configuration comes from

The plugin declares no `Config` schema, so the Cordis Loader passes this plugin row's `config:` block
through untouched, and `apply()` validates it itself while the row is being mounted. A typo therefore
fails the plugin load, when the person who typed it is still looking, rather than silently falling back
to a default on the first tool call. `test/tools.test.ts` pins the load-time refusal.

The row and its commented template live in this repository's [`cordis.patch.yml`](../../../cordis.patch.yml):

```yaml
# Inserts the dsh-gist-settings Host plugin, which registers the gist_status,
# gist_upload, gist_download and gist_sync tools.
#
# Tunable values live here rather than in code, so this block survives plugin
# upgrades. Every field is optional; the defaults track $DSH_HOME.
#
# - insert:
#     - id: dsh-gist-settings
#       name: '@local/dsh-gist-settings'
#       config:
#         ghPath: 'C:\Program Files\GitHub CLI\gh.exe'   # default: probe PATH, then well-known dirs
#         profileFiles: ['cordis.patch.yml', 'package.json']   # single file names; no separators, no '..'
#         # dshHome: 'C:\Users\me\.dsh'
#         # profilesDir: 'C:\Users\me\.dsh\profiles'
#         # stateDir: 'C:\Users\me\.dsh\gist-settings'

- insert:
    - id: dsh-gist-settings
      name: '@local/dsh-gist-settings'
```

Only the last `insert` is active: the bundle patch adds the row with no `config:` block, so every key
takes its default until one is set. The keys belong in the same row in the profile's own patch layer,
where `install_bundle` puts the bundle — that is what makes them survive a plugin upgrade, because the
patch layer is not part of the package. Do not add the row or the dependency by hand;
[install.md](../getting-started/install.md) and [update.md](../getting-started/update.md) cover those
steps, and the README's [Install](../../../README.md#install) section states the rule.

The block is validated in `readConfig` in [`index.ts`](../../../index.ts); the paths and tracked names
are resolved in [`lib/core.ts`](../../../lib/core.ts).

## Keys at a glance

| Key | Type | Default |
|---|---|---|
| `ghPath` | non-empty string, or a non-empty array of non-empty strings | unset: probe `gh` on the `PATH`, then the well-known install directories |
| `dshHome` | non-empty string | `$DSH_HOME`, else `~/.dsh` |
| `profilesDir` | non-empty string | `<dshHome>/profiles` |
| `stateDir` | non-empty string | `<dshHome>/gist-settings` |
| `profileFiles` | non-empty array of non-empty strings | `['cordis.patch.yml', 'package.json']` |

All five are optional. Every string value is trimmed before use.

## Validation of the block itself

- Absent or `null` is fine: the whole block is then `{}` and every default applies.
- The block must be a mapping. An array is refused with `config must be a mapping, received an array`;
  a string, number or boolean with `config must be a mapping, received string` and so on.
- An unknown key is refused, with the known keys listed: `unknown config key: profileFile; known keys
  are ghPath, dshHome, profilesDir, stateDir, profileFiles`. Several typos produce the plural
  `unknown config keys:`.
- A key that takes one string — `dshHome`, `profilesDir`, `stateDir`, or a non-array `ghPath` — must be
  a non-empty string: `config.dshHome must be a non-empty string`. A blank or whitespace-only string is
  refused, and so is `null`, because only `undefined` counts as "not set".
- A key that takes a list — `profileFiles`, or an array `ghPath` — must be a non-empty array:
  `config.profileFiles must be a non-empty array of strings`. An entry that is not a non-empty string is
  refused with `config.profileFiles must contain only non-empty strings`.

## `ghPath`

How the plugin finds `gh`. Resolution order:

1. The configured value, if present.
2. `gh` as a bare command, resolved through `PATH`.
3. The well-known install locations, each probed with `gh --version` and skipped when the file is absent.

The value may be a string, or an array of `[command, ...prefixArgs]` for reaching `gh` through a wrapper
— `['wsl', 'gh']`, a shim script, or an interpreter plus a portable build.

A configured string that contains a path separator is checked before it is run: a file that does not
exist gives `configured ghPath does not exist: <command>`, and a file that exists but whose `--version`
does not exit 0 gives `configured ghPath is not runnable: <command>`. A bare command name is always
probed, so a wrapper on the `PATH` still works. When nothing is found and no `ghPath` was configured,
the reason is `gh CLI not found on PATH or in any well-known install location`.

The well-known locations, in the order they are tried:

| Platform | Locations |
|---|---|
| Windows | `%ProgramFiles%\GitHub CLI\gh.exe`, `%ProgramFiles(x86)%\GitHub CLI\gh.exe`, `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`, `%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe`, `%ProgramData%\chocolatey\bin\gh.exe`, `~/scoop/shims/gh.exe` |
| Other | `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, `/usr/bin/gh`, `~/.local/bin/gh` |

Each `gh` invocation runs with `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`, a 60 second timeout,
at most 32 MiB of captured output, and no interactive editor: gist reads and writes go through `gh api`,
never `gh gist edit`. Those two environment variables are set by the plugin and are not configurable.

## `dshHome`

The Harness home the other defaults are derived from. It resolves in this order:

1. `config.dshHome`, when set.
2. The `DSH_HOME` environment variable.
3. `~/.dsh`, from the operating system's home directory.

A leading `~`, `~/` or `~\` is expanded to the home directory; any other relative value is resolved
against the process working directory, which is the user's workspace rather than the Harness home. The
result is always an absolute path, and it is the value `gist_status` prints on its `home:` line. A
relative value is therefore not relative to the Harness home, and `stateDir` is written to by
`saveState`, so a relative `stateDir` lands where the plugin did not mean.

## `profilesDir`

Where the profiles live; default `<dshHome>/profiles`. It is both the directory the tools list and the
containment boundary a profile directory is checked against, so changing it changes which profiles the
tools can see and which ones they refuse as an escape. `gist_status` does not print this path; the
profile rows it prints are what show which directory was listed.

## `stateDir`

Where this plugin's own files live; default `<dshHome>/gist-settings`. The directory is created on
demand and holds:

| Path | Written by | Contents |
|---|---|---|
| `state.json` | `saveState` | the profile-to-gist mapping: `version` plus one record per tracked profile |
| `state.json.bak` | `saveState` | a copy of the previous revision, kept so a bad write is recoverable by hand |
| `state.lock` | an operation that modifies state | the owning `pid` and hostname, while the lock is held |
| `state.lock.reclaim` | a lock waiter | a short-lived token that makes stale-lock removal single-writer |
| `backups/<profile>/<timestamp>/` | `gist_download`, and the download path in `gist_sync` | the tracked files as they were before a destructive write |

`state.json` is written atomically: a per-writer temporary file is written, the previous revision is
copied to `state.json.bak`, and the temporary file is renamed into place; a failure removes the
temporary file. Each record holds `gistId`, `gistUrl`, `description`, `files`, `lastSyncedHash`,
`lastSyncAt` and `lastDirection`. On read, a record without a `gistId` is dropped; a file that is not
valid JSON, a `profiles` section that is not an object, and a `gistId` that is not alphanumeric each
fail the call with a message naming the file. The lock is what makes a read-modify-write safe across
processes; [recovery.md](recovery.md) covers what to do when a state file or a lock is in the way.

## `profileFiles`

The tracked set: which files inside each profile directory are backed up, compared, restored and
pruned. The default is two files, `['cordis.patch.yml', 'package.json']`, and a configured array
replaces it — there is no merging with the default.

Each entry is used three ways at once: as a path inside the profile directory, as the file's name in the
gist, and as the file's path inside a backup directory. It therefore has to be a plain, single name.

### What makes a name valid

| Refused | Why |
|---|---|
| a non-string, or an empty string | it is not a name; through the config block this is caught earlier, as `config.profileFiles must contain only non-empty strings` |
| `:` `*` `?` `"` `<` `>` `|`, or a NUL byte | `:` introduces a drive-relative path or an alternate data stream on Windows, and the rest are illegal in a Windows file name |
| a `/` | a gist is a flat collection of files, not a tree: GitHub answers a filename containing a slash with `HTTP 422 Validation Failed`, and that filename is what has to be sent |
| a `\` | it separates paths on Windows, so one name would mean a local path and a gist name that differ |
| `.` or `..` | it is a path segment, not a file name |
| a name Windows reserves for a device: `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9` | the name means a device to every other program that touches the directory. The check is case-insensitive and applies to the part before the first dot, so `NUL` and `com1.yml` are refused |
| a leading or trailing space, or a trailing dot | Windows strips it when it creates the name, so `a. ` and `a` would be two spellings of one file |

A refused entry fails the load with
`invalid tracked file name "<name>": <why>. An entry of profileFiles names one file directly inside the
profile directory — and that same name is the file's name in the gist — for example "cordis.patch.yml".`
The refusal is never a repair: `a/../b` is an error, not a quiet rewrite to `b`.

### Two spellings of one file

Two entries that name one file would leave one of the two unreachable while the writers used the other,
so a duplicate is refused: `duplicate tracked file name: "package.json" and "PACKAGE.JSON" name the same
file on this platform`.

What counts as a duplicate depends on the filesystem, because that is what the names mean there:

| Platform | Comparison |
|---|---|
| Windows, macOS | case is folded, so `package.json` and `PACKAGE.JSON` collide |
| macOS | names are also compared after Unicode NFC normalisation, because the filesystem hands out those spellings interchangeably |
| Linux | names are compared as written; `package.json` and `PACKAGE.JSON` really are two files, so both are allowed |

An exact duplicate (`['a.yml', 'a.yml']`) is refused on every platform, without the
` on this platform` suffix.

### What the tracked set controls

- Which files an upload sends, which files a download writes, and which files a backup holds.
- Which files are compared for a profile's status; the rest of the gist is reported as untracked rather
  than compared.
- What pruning removes. A file in the gist that is absent from this list is deleted from the gist by the
  next upload, with no backup of it — so shortening the list is a destructive act on the next upload.
- What is *not* affected by deleting a file from disk: the tracked set still names it, so an upload
  refuses rather than propagating the deletion, and a download restores it. To drop a missing file from
  the gist deliberately, use `gist_upload` with `force: true`; see [tools.md](tools.md).

Validation happens at load: `readConfig` runs `core.resolveProfileFiles` while the plugin mounts, so a
name that could never be handled — an absolute path, a `..` segment, a colon — fails there rather than on
the first tool call, where it would look like a one-off error.

## What the configuration does not cover

- No key selects which profiles an operation touches; the `profile` argument of each tool does. See
  [tools.md](tools.md).
- `force`, `description` and `verifyGh` are per-call arguments, not configuration.
- The plugin reads no environment variable of its own beyond the `DSH_HOME` fallback for `dshHome` and
  the usual variables used to guess `gh`'s install location (`ProgramFiles`, `ProgramFiles(x86)`,
  `LOCALAPPDATA`, `ProgramData` on Windows).
- The gists themselves are never configured: one secret gist per profile, created on the first upload.

## Related

- [tools.md](tools.md) — the four tools, their arguments and their failure modes.
- [recovery.md](recovery.md) — a bad state file, a stale lock, a lost profile directory.
- [install.md](../getting-started/install.md) and [update.md](../getting-started/update.md) — installing
  the bundle and keeping the row's configuration across an upgrade.
- [troubleshooting](../troubleshooting/index.md) — when a setting does not take effect.
- [README — Configuration](../../../README.md#configuration) — the short version of this page.