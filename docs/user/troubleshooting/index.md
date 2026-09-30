# Troubleshooting

Symptom, cause, fix. Every message quoted here is one the code raises, and the section that owns the
behaviour is linked rather than restated. Start with [`gist_status`](#start-here-run-gist_status), which
reports what the plugin can see without changing anything, and read the first section if the four tools
are not there at all.

## The bundle was skipped: incompatible with dsh

This is the failure this project most recently hit, and the one to check first, because it removes all
four tools before any of them can run. The line to look for in the host's output starts with:

```text
dsh: skipping profile bundle "@local/dsh-gist-settings": ... incompatible with dsh ...
```

**Symptom.** The profile loads, the four gist tools are absent, and the host prints that line.

**Cause.** Before a profile loads a bundle, the Harness reads that bundle's `peerDependencies` for any
`@deepseek-ai/dsh*` entry and skips the whole bundle when the installed dsh does not satisfy it. It reads
the declaration only — it never loads the plugin to find out whether it would have worked — so a
declaration the installed runtime cannot satisfy skips the bundle however sound its code is.

This repository therefore declares an **enumerated list of verified versions**: currently
`0.1.7-rc.2 || 0.2.0-rc.2` in [`package.json`](../../../package.json). The versions are spelled out rather
than written as a range because the platform ships prereleases and semver's `^` does not cross them —
`^0.1.7-rc.2` stops below `0.2.0-rc.2`, so a caret would refuse the very runtime the declaration has to
admit. When `0.2.0-rc.2` was added, nothing inside the plugin changed:
[`test/schema.test.ts`](../../../test/schema.test.ts) replayed that version's own validators without an
edit, which is what makes it a declaration fix rather than a port.

**Why CI proves it rather than trusting it.** The `targets` job in
[`ci.yml`](../../../.github/workflows/ci.yml) reads the list out of the declaration instead of keeping a
second copy of it — it splits `peerDependencies["@deepseek-ai/dsh"]` on `||` — and the `schema` job is a
matrix over those versions. Each one is installed through
[`.github/actions/install-harness`](../../../.github/actions/install-harness/action.yml) and then
`npm run test:schema` runs against it. That suite calls `evaluatePluginCompatibility` — the loader's own
function, taken from `@deepseek-ai/dsh-app-boot` inside the installed Harness — on this repository's
manifest, and also asserts that the same call *refuses* a declaration nothing can satisfy (`0.0.1`), so
the case cannot pass whatever the declaration says. A declared version that nothing installs would be a
claim rather than a check.

**Fix.**

1. Add the version the message names to the `@deepseek-ai/dsh` entry in `package.json` as an exact
   version: `0.1.7-rc.2 || 0.2.0-rc.2 || <new version>`.
2. Do not grant an exact-version exemption, and do not remove the `peerDependencies` entry to get past
   the gate. [`AGENTS.md`](../../../AGENTS.md) lists both as prohibited: the gate is a safety net for a
   plugin that rewrites profile files, and an exemption is invisible to CI.
3. Let CI install it. The matrix is derived from the declaration, so adding the version there is the
   whole change. Locally, `npm run test:schema` runs the same gate against an installed Harness:
   `DSH_TOOLS_DIR` points the suite at a specific installation, and finding no Harness *fails* the suite
   unless `DSH_ALLOW_SCHEMA_SKIP=1` accepts the skip deliberately.
4. Load the profile again. The declaration is read when the profile layer is built, so the skip does not
   clear until the host has read the manifest again.

[Updating](../getting-started/update.md) is the same problem from the other side: what to check after dsh
moves to a version this plugin does not declare yet, and why a restart is required.

## Start here: run `gist_status`

`gist_status` is the diagnostic entry point. It never touches profile files or the gist, and it is the
one tool declared concurrency-safe, so it can run alongside other read-only calls. Its output, with the
conditional lines marked by a comment:

```
gh:   <version>            # or: gh:   NOT FOUND - <reason>
      <path>
auth: ok (<account>)       # or the not-authenticated / not-checked line
home: <dshHome>
state: <state.json>

<profile>
  status: <the vocabulary below>
  gist:   <url>            # when a gist is recorded
  error:  <reason>         # on an unreachable gist
  absent: <names>          # tracked files not on disk
  gist also holds (untracked here): <names>
```

Then read the vocabulary row. The printed strings are the ones to search for in this page:

| Printed | Meaning and where to go |
| --- | --- |
| `not tracked` | No gist exists for this profile yet. Run `gist_upload`. |
| `in sync` | Nothing to do. |
| `local changes to upload` | [Only the local side changed](#local-changes-to-upload). |
| `gist changes to download` | [Only the gist changed](#gist-changes-to-download). |
| `DIVERGED - needs a decision` | [Both sides changed](#diverged---needs-a-decision). |
| `tracked files missing locally - run gist_download to restore` | [A tracked file is gone from disk](../reference/recovery.md#a-tracked-file-was-deleted-locally). |
| `gist deleted - the next upload recreates it` | [A genuine 404](#gist-deleted---the-next-upload-recreates-it). |
| `gist UNREACHABLE (not deleted) - retry when connected` | [A transient failure](#gist-unreachable-not-deleted---retry-when-connected). |
| `unknown - gh is unavailable, remote state not checked` | `gh` is missing or logged out; see [gh is not found](#gh-is-not-found). |

Two things about the output that are easy to misread. A profile listed with `status: unknown` is not a
profile with no gist: the state file still records its gist, and the URL is printed beside it — the
remote half simply could not be read. And `gist_status` is not strictly read-only: when a profile's two
sides already match but the recorded baseline is stale, it repairs the baseline in `state.json`, which is
what stops the next ordinary edit from being misread as a divergence.

Argument mistakes are errors, not guesses: a misspelled key, a wrong type, or a case-only variant of a
real profile name fails the call with a message naming the real name or listing the known profiles. And
in `gist_upload`, `gist_download` and `gist_sync`, a failure on one profile never aborts the others: the
report continues, and the failing profile's line starts with `FAILED - ` and carries the reason.

## The four tools are missing after an upgrade

**Symptom.** A session has no `gist_status`, `gist_upload`, `gist_download` or `gist_sync`, after a dsh
upgrade, a reinstall or a fresh checkout.

**Cause and fix, in the order worth checking.**

1. **The bundle was skipped by the compatibility gate.** Look for the `dsh: skipping profile bundle`
   line and follow [the section above](#the-bundle-was-skipped-incompatible-with-dsh). This is the most
   common cause after a dsh upgrade.
2. **`dist/` is missing or stale.** The Harness loads compiled JavaScript, and `package.json`'s
   `exports["."]` names `./dist/index.js`, so a fresh clone has nothing to load until `npm run build`
   runs. See [the plugin behaves like an older revision](#the-plugin-behaves-like-an-older-revision).
3. **The bundle or its row is not installed.** Installing is a `plugin_manager` call with `action:
   install_bundle` and the absolute path of this directory: it links the directory into the profile,
   adds the bundle to `dsh.profile.bundles` and applies the patch in `cordis.patch.yml`. Do not add the
   bundle row or the dependency to the profile by hand — `install_bundle` owns the selection. A session
   needs **full access** or an approval prompt for that call, and it refuses otherwise. See
   [Installing into a profile](../getting-started/install.md).
4. **The host has not restarted.** A new module generation loads only after a restart, so a freshly
   installed or rebuilt bundle is invisible to the running host.
5. **Check the artifact itself.** `npm run test:entry` builds first and then loads the package by name
   the way the Cordis loader does, pinning that the export resolves to `dist/index.js`, that the
   artifact and its declarations exist and are non-empty, and that a context registering through it gets
   exactly `gist_download`, `gist_status`, `gist_sync` and `gist_upload`.

**If the tools are present but one call fails**, that is a different problem: in `gist_upload`,
`gist_download` and `gist_sync` a failure is reported per profile, so read the `FAILED - ` line for the
message and find it below or in [Recovery](../reference/recovery.md).

## The plugin behaves like an older revision

**Symptom.** An edit to `index.ts` or `lib/core.ts` reaches the running profile only partly, or not at
all; behaviour matches a previous revision.

**Cause.** A profile reaches this package through a junction inside the profile's own `node_modules`, so
the working copy *is* the live plugin — but what the Harness loads is `dist/`, and a source edit reaches
it only after a rebuild. `dist/` is generated output: never edited by hand, never committed. The
converse also holds — the package cannot be run as raw TypeScript, because Node refuses to strip types
for a file it resolves under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is
why the build exists at all.

**Fix.** Run `npm run build`, or keep `npm run build:watch` running while you work, then restart the
host. To confirm what is on disk matches the sources, run `npm run test:entry`: it compares the built
entry with the file it was compiled from — member sets, each tool's output schema, a rendered probe
value and the concurrency verdict — so a `dist/` left behind by an earlier edit fails it instead of being
loaded silently.

## `gh` is not found

**Symptom.** A tool fails with this message, or `gist_status` prints `gh: NOT FOUND - <reason>` with
`auth: not checked - gh is not installed`.

```text
gh CLI not found: <reason>. Install GitHub CLI (https://cli.github.com) or set `ghPath` in this plugin's config.
```

**Cause.** `gh` is located in this order: the configured `ghPath`, then `gh` on the process's `PATH`,
then a list of well-known install locations. The `PATH` that matters is the one the *host process* was
started with — on Windows, a host started before GitHub CLI was installed keeps the old `PATH` until it
is restarted, which is why the well-known locations are probed at all.

**Fix.**

1. Install GitHub CLI and restart the host so it inherits the new `PATH`, or
2. Set `ghPath` in this plugin's `config:` block (see [Configuration](../reference/configuration.md)).
   It may be a path, or an array of `[command, ...prefixArgs]` to reach `gh` through a wrapper, for
   example `['wsl', 'gh']`.
3. Read the reason for the two configured-but-unusable cases: `configured ghPath does not exist: <path>`
   and `configured ghPath is not runnable: <path>`. The unconfigured one is
   `gh CLI not found on PATH or in any well-known install location`.

Without a usable `gh`, `gist_status` still reports the resolved `home:` and `state:` paths and what the
state file tracks — it does not claim every profile is untracked. A profile with a recorded gist reads
`unknown - gh is unavailable, remote state not checked`.

## `gh` is installed but not authenticated

**Symptom.** A tool fails with the message below, or `gist_status` prints an `auth: NOT AUTHENTICATED`
line telling you to run `gh auth login`.

```text
gh is installed at <path> but not authenticated. Run `gh auth login` once, then retry. Gists are created with `gh api`, so no extra scopes are needed.
```

**Cause.** `gh` is present but its own credential store has no logged-in host.

**Fix.** Run `gh auth login` once. No extra OAuth scopes are needed beyond the default, because gists
are read and written through `gh api`; the plugin never stores, reads or asks for a token of its own —
`gh` owns the credential.

Two details worth knowing. A `gh auth status` that exits 0 while logged out is still unauthenticated:
the plugin reads the message, not the exit code alone. And `gist_upload`'s `verifyGh: false` skips the
pre-flight check deliberately — the first `gh api` failure then surfaces instead, and if `gh` cannot be
resolved at all the call fails for a missing CLI and points at the `ghPath` config key.

## `local changes to upload`

Only the local side changed since the recorded baseline. Run `gist_upload` for that profile, or
`gist_sync`, which fast-forwards by uploading. No `force` is needed for this case. An upload that also
refuses because a tracked file is missing locally is a different decision — see
[A tracked file was deleted locally](../reference/recovery.md#a-tracked-file-was-deleted-locally).

## `gist changes to download`

Only the gist changed. Run `gist_download`, or `gist_sync`, which fast-forwards by downloading. Three
boundaries matter when you read the result:

- A download writes only the tracked files: a gist file that is not in `profileFiles` is never written
  locally.
- Tracked files the gist does not carry are kept locally and reported as `kept locally`, never deleted.
- If the gist carries **none** of the tracked files, there is nothing to download. `gist_sync` treats
  that as "this machine holds the only copy" and republishes the local files instead (the action is
  `restored`), while `gist_download` refuses and points at `gist_upload`. Either way, one call reaches a
  settled state.

## `DIVERGED - needs a decision`

Both sides changed since the recorded baseline, and the plugin will not guess which one you meant. A
plain `gist_sync` refuses; `gist_download` refuses without `force`; `gist_upload` pushes the local side.

Pick a direction deliberately — [Recovery](../reference/recovery.md#a-profile-diverged) gives the
step-by-step route, including the backup a forced download takes and the `forced-upload` action a forced
sync reports. Only the tracked files are compared, so a file added to the gist by hand cannot be the
cause.

## `gist UNREACHABLE (not deleted) - retry when connected`

**Cause.** The gist could not be read for a reason other than a genuine `HTTP 404`: a 401, a 5xx, a rate
limit, a DNS failure, or a *tracked* truncated file whose full content could not be fetched from a
trusted GitHub URL. The `error:` line in the status output carries the reason.

**Fix.** Restore connectivity or authentication and retry. An upload refuses to create a replacement —
`Refusing to create a replacement gist, which would abandon the existing backup` — and a sync refuses
for the same reason, so retrying is safe: nothing was forked, and the original gist is still the target.

One case is worth separating. Truncation is resolved only for files this profile tracks, so a large
attachment someone added through the web UI neither costs a request on every status call nor can break
one; it is listed under `gist also holds (untracked here):` and is removed by the next upload, which
prunes files that are no longer tracked.

## `gist deleted - the next upload recreates it`

**Cause.** GitHub returned a genuine `HTTP 404` for the gist. This verdict is reserved for that case
alone; anything else is `unreachable` above.

**Fix.** Run `gist_upload` for the profile, or `gist_sync`, which recreates it in the same call and
reports the action `created`. Because the gist really is gone, there is nothing left to update: a new
secret gist is created from the local files, and the result names the URL that could not be read under
`REPLACED a gist that could not be read; the previous one was <url>`. The state record is rewritten to the
new gist. [Recovery](../reference/recovery.md#the-gist-was-deleted-on-github) covers the case where the
local files are gone too.

## Related pages

- [Tools](../reference/tools.md) — the parameters, results, per-tool failure modes and every printed
  string.
- [Configuration](../reference/configuration.md) — `ghPath`, `stateDir`, `profileFiles` and the rest.
- [Installing into a profile](../getting-started/install.md) and [Updating](../getting-started/update.md)
  — the install call, what "installed" means for a running Harness, and the upgrade checks.
- [Recovery](../reference/recovery.md) — backups, the staging directory, the state file, `force` and the
  state lock.
- [`README.md`](../../../README.md) — requirements, installation and the safety model.
- [`test/schema.test.ts`](../../../test/schema.test.ts) — the compatibility gate replayed against the
  installed Harness.