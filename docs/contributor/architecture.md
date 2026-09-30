# Architecture

This page is the long form of how `dsh-gist-settings` is put together: which module owns what, why the
Harness loads a build rather than the sources, what decides whether a profile loads the bundle at all,
and how one sync moves from a status reading to a state write. It is the source of truth for where logic
belongs. The short form is the README's `Repository layout` and `Development` sections and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md)'s `Development setup`; this page deepens those rather than
repeating them, and the [documentation map](../index.md) says which page owns which subject.

## The two modules

| File | Role | Imports |
| --- | --- | --- |
| [`index.ts`](../../index.ts) | The Host plugin: the four tool definitions, argument validation, `config:` validation, profile-name resolution, the per-profile loop, and the report text. | `./lib/core.ts` only |
| [`lib/core.ts`](../../lib/core.ts) | The sync engine: paths, `gh`, the GitHub gist API, hashing, the state file, the lock, and the status/upload/download/sync verbs. | six `node:` built-ins only |

The engine's imports are exactly `node:async_hooks`, `node:child_process`, `node:crypto`,
`node:fs/promises`, `node:os` and `node:path`; no Cordis type or helper appears anywhere in it. That is
what makes the sync logic directly runnable — `node test/sync.test.ts` exercises the whole lifecycle
with no plugin host, no build step and no GitHub account. The direction of dependency is one way:
`index.ts` imports the engine, and the engine knows nothing about the tool layer, the Cordis context or
the Harness.

The split is not "thin wrapper, thick engine" for its own sake. The Host plugin row is the replaceable
part: it is what a profile mounts, unmounts and reloads, and the four agent-facing definitions are the
part that changes when the model should be told something different. Everything that touches a profile
file, the gist, the state file or the lock lives in the engine, so a change to what a sync *does* cannot
be reached by a change to how it is *described*.

What `index.ts` does hold, and why it is the right place for each:

- **The tool definitions.** Names, descriptions, parameter schemas, the output schema, the renderer and
  the concurrency verdicts; see `The four tools` below.
- **Argument validation** (`checkArgs`). The definitions are hand-written, so nothing else validates
  what a model passes; this is where `force: "false"` is refused instead of being read as truthy, and
  where an unknown key is an error rather than a widened call.
- **`config:` validation** (`readConfig`). `KNOWN_CONFIG_KEYS` is `ghPath`, `dshHome`, `profilesDir`,
  `stateDir`, `profileFiles`; an unknown key, a blank string or a malformed list throws while the plugin
  loads. That matters most for `profileFiles`, where a typo would otherwise change which files are
  backed up, silently. `readConfig` also calls the engine's `resolveProfileFiles` at load, so a name
  that could never be handled fails there rather than on the first tool call. The keys and their
  defaults are the configuration reference's subject: see
  [Configuration](../user/reference/configuration.md).
- **Profile-name resolution** (`assertProfileName`, `resolveProfileArg`). The lexical name check mirrors
  the framework's rules and reserves the shared `node_modules` store; `resolveProfileArg` then matches
  the requested name exactly against the directories on disk and the profiles the state file tracks, and
  refuses a case-only variant by naming the real spelling. The engine re-checks containment against real
  paths afterwards, because a lexical check cannot see a junction.
- **Per-profile iteration and formatting.** The tools loop over profiles themselves rather than calling
  the engine's batch helpers (`statusAll`, `syncAll`, which the suites use), so one profile failing
  becomes one `FAILED` line and never aborts the others.

### Registration and teardown

The module exports two things the Cordis loader reads: `inject = ['tools']`, the only service the plugin
needs, and `apply(ctx, config)`. `apply` validates the `config:` block once, then runs one labelled
effect:

```ts
ctx.effect(function* registerGistTools() {
  for (const tool of buildTools(ctx, userConfig)) {
    yield ctx.tools.register(tool)
  }
}, 'dsh-gist-settings tools')
```

Each `ctx.tools.register` returns the disposer that undoes that one registration, and yielding all four
from the effect body is what ties them to the plugin row's lifetime: unmounting the row unregisters the
tools. One labelled effect wraps all four, so the row has a single named teardown unit rather than four
unrelated registrations.

Registration also means the plugin declares no `Config` schema of its own — the Loader passes the block
through untouched, which is exactly why `readConfig` has to validate it. `index.ts` describes the shapes
it reaches structurally (`PluginContext`, `ToolDefinition`, `ToolExecution`, `ToolValue`, `Disposer`)
instead of importing them from the Harness, for the reason in `The module-resolution rule` below.

## The four tools and how a definition is built

Every definition is produced by one local helper, `contentTool`, from a `ToolSpec`: a name, a
description, a `parameters` object, a `run` function and an optional `concurrencySafe` flag.
`contentTool` completes it into the shape `ctx.tools.register` accepts:

- **`parameters`.** Raw JSON Schema, but typed through `ArgumentSchema<A>` so the declared argument type
  and the schema cannot drift: a property the schema omits, or a `type` that contradicts the declared
  argument, is a compile error rather than a mismatch the model discovers by calling the tool. A
  `boolean | undefined` argument maps to `{ type: 'boolean' }`, anything else to `{ type: 'string' }`,
  and `additionalProperties` is `false` everywhere.
- **`output.schema`.** A domain-owned DTO — `{ type: 'object', properties: { text: { type: 'string' } },
  additionalProperties: false }` — rather than the framework's content-blocks-as-value fixture. PTC mode
  projects this schema into a generated SDK, so an untyped array would hand the model an undescribed
  result.
- **`output.render`.** Projects the canonical `{ text }` value into a single `{ type: 'text', text }`
  content block.
- **`execute`.** Validates the call's arguments with `checkArgs` and only then runs `run`. Values are
  checked, never coerced: a wrong type, an explicit `null` or an unknown key is an error the model can
  correct.
- **`isConcurrencySafe`.** Attached only when the spec sets `concurrencySafe`, because the registry
  treats an undeclared classifier as exclusive. Only `gist_status` is declared safe to join a parallel
  batch: it touches no profile file and no gist, and the one thing it can write — a stale baseline in
  the state file — is taken under the state lock.

| Tool | Parameters | Concurrency | Engine calls |
| --- | --- | --- | --- |
| `gist_status` | `profile?` | safe | `health`, `loadState`, `listKnownProfiles` / `profileStatus` |
| `gist_upload` | `profile?`, `description?`, `force?`, `verifyGh?` | exclusive | `uploadProfile` |
| `gist_download` | `profile?`, `force?` | exclusive | `downloadProfile` |
| `gist_sync` | `profile?`, `force?` | exclusive | `syncProfile` |

The defaults are the engine's, stated in the descriptions and implemented at the call site: `force` is
`false` for upload, download and sync; `verifyGh` defaults to `true`, and `verifyGh: false` resolves
`gh` without the install-and-authentication pre-flight, so an unauthenticated `gh` surfaces its own
error later instead of the plugin's refusal. Per-parameter semantics, including what `force` overrides,
belong to the [tool reference](../user/reference/tools.md) and the
[recovery guide](../user/reference/recovery.md).

Which profiles a call covers is deliberately not the same set in all four tools. A single named profile
is resolved by `resolveProfileArg` first. Without a name, `gist_status` and `gist_download` and
`gist_sync` use `listKnownProfiles` — the directories on disk *plus* the profiles the state file still
tracks, because a profile whose directory was deleted outright has its gist as the only remaining copy,
and listing directories alone would hide exactly the profile that needs restoring. `gist_upload` uses
`listProfiles` instead: an upload pushes what is on disk, so a tracked profile with no directory is
named in the result and pointed at `gist_download` rather than silently skipped or falsely reported as
uploaded.

`gist_status` also degrades rather than lying. With no usable `gh` it cannot read any gist, but it still
knows from the state file what this machine tracks: a profile with a recorded gist id is reported as
`unknown` ("gh is unavailable, remote state not checked") and an untracked one as `untracked`, which is
what stops the one tool a stranded user reaches for from claiming their backups do not exist.

## Why `dist/` exists

The Harness loads JavaScript, not TypeScript, and the reason is a property of where the package sits
rather than a preference:

1. `plugin_manager`'s `install_bundle` links the checkout into the profile and records
   `"@local/dsh-gist-settings": "link:…"`; a junction under the profile's own `node_modules` points at
   the working copy, which is why the working copy *is* the live plugin.
2. Node refuses to strip types for any file it resolves under `node_modules`, and throws
   `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when asked to.
3. So the package cannot be run as raw TypeScript from a profile, and `npm run build` must produce the
   half that loads.

[`tsconfig.json`](../../tsconfig.json) is that build: it compiles `index.ts` and `lib/**/*.ts` with
`rootDir: "."`, `outDir: "dist"` and `declaration: true`, emitting `dist/index.js`, `dist/lib/core.js`
and the matching `.d.ts` files. `package.json`'s `exports["."]` then names the build — `./dist/index.js`
and `./dist/index.d.ts` — so what a profile loads starts at compiled JavaScript, never at the sources.

Two compiler options carry weight beyond style:

- `rewriteRelativeImportExtensions` is what lets the source name the real file it imports
  (`./lib/core.ts`) while the emitted JavaScript names what actually sits beside it (`./lib/core.js`).
  The alternative — importing `./lib/core.js` in the source — would break the suites, which load the
  `.ts` files directly.
- `erasableSyntaxOnly` keeps the sources loadable by Node's type stripper: `enum`, `namespace` and
  parameter properties emit code, so they are refused at compile time rather than failing at runtime for
  whichever consumer strips types first.

`dist/` is regenerated output. It is never edited by hand and never committed (`.gitignore` lists it),
which is why a fresh clone has no `dist/` and why the README's install step builds before installing.
A profile that reaches a checkout whose `dist/` is missing, stale or built from an earlier edit gets a
load failure or the wrong definitions; `npm run build:watch` while working, plus a restart, is the
supported loop ([`CONTRIBUTING.md`](../../CONTRIBUTING.md) `Development setup`). `test/entry.test.ts`
pins the boundary rather than assuming it: it loads the package by name through `exports`, fails when an
artifact is missing instead of skipping, and compares the loaded build against the source entry — member
sets, each output schema, what `render` produces, and the concurrency verdict — so a stale `dist/` fails
a test rather than being loaded silently.

## The `exports` map

`exports` is the package's entire public surface; a subpath it does not name is not importable at all,
which is why the three names below are listed explicitly rather than left to a deep path.

| Name | Target | Why it is named |
| --- | --- | --- |
| `"."` | `./dist/index.js`, types `./dist/index.d.ts` | The Host plugin entry the loader imports by package name — the one boundary a profile actually crosses. |
| `"./package.json"` | `./package.json` | The manifest stays reachable through the package name; the compatibility gate reads a bundle's `peerDependencies` from it. |
| `"./locale/*.json"` | `./locale/*.json` | The display metadata (`locale/en.json`, `locale/zh.json`) that the Plugin Manager reads for a bundle card. |

`files` decides what a packed copy would carry: `dist/`, `locale/`, `icon.svg`, `cordis.patch.yml`, the
licence, both READMEs, `CHANGELOG.md` and `CONTRIBUTING.md`.

## Why the suites and the scripts run from source

The nine suites under `test/` and the three scripts under `scripts/` are TypeScript too, and nothing
compiles them. Node strips their types as it loads them, which is allowed *outside* `node_modules` —
the inverted reason the build exists. So `node test/sync.test.ts` works with no build step, and the
suites import `../index.ts` and `../lib/core.ts` directly, which is why an edit to either source is
covered by the next run.

Erasing types is not checking them, and that is a gap `npm test` cannot see: its `pretest` step builds
the runtime, but the suites and scripts are never compiled.
[`tsconfig.check.json`](../../tsconfig.check.json) closes it — `noEmit`, `declaration: false`, and an
`include` covering `index.ts`, `lib/`, `test/`, `scripts/` and `types/**/*.d.ts` — so `npm run typecheck`
fails on a mistyped test exactly as it fails on a mistyped engine. CI runs that one command in its own
job, because the platform matrix would otherwise repeat a single answer seven times.

The one exception to "from source" is `test/entry.test.ts`. It imports the package by name
(`@local/dsh-gist-settings`), so the resolution it exercises is the real one through `exports`, and it
therefore needs `dist/`. `npm test` builds first through `pretest`, and `npm run test:entry` is
`npm run build && node test/entry.test.ts`. Every other suite runs standalone. What each suite proves is
the subject of [Testing](testing.md); the suites and their coverage are also tabulated in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## The compatibility gate

What decides whether a profile loads this bundle at all is a declaration in the manifest, not anything
in the code. `package.json` declares:

```json
"peerDependencies": { "@deepseek-ai/dsh": "0.1.7-rc.2 || 0.2.0-rc.2" },
"peerDependenciesMeta": { "@deepseek-ai/dsh": { "optional": true } }
```

The Harness's profile loader reads a bundle's `@deepseek-ai/dsh*` peer declaration before it adds that
bundle's layer, and skips the whole bundle when the installed runtime does not satisfy it. It reads the
declaration only — it never loads the plugin to find out whether it works — so a version the gate cannot
satisfy disables four sound tools however good the definitions are. The check itself is
`evaluatePluginCompatibility` in the Harness's `@deepseek-ai/dsh-app-boot`.

Three things keep that declaration honest:

- **It is an enumerated list, not a range.** The platform ships prereleases and semver's `^` does not
  cross them — `^0.1.7-rc.2` stops below `0.2.0-rc.2` — so exact versions joined by `||` are the only
  spelling that can express "these two, verified".
- **CI installs every version in it.** `ci.yml` reads the list out of the declaration rather than
  copying it beside, and the `schema` job installs each version in turn and runs `npm run test:schema`,
  which calls the runtime's own gate function on this repository's manifest — with a control that must
  be refused, so the case cannot pass whatever the declaration says.
- **The peer is marked `optional`.** `peerDependenciesMeta` sets `@deepseek-ai/dsh` to
  `{ "optional": true }`, and nothing from that package is imported, so an absent or different Harness
  is a compatibility question rather than a missing install.

`package.json`'s `dsh.bundle.patch` names [`cordis.patch.yml`](../../cordis.patch.yml), the patch that
inserts the plugin row (`id: dsh-gist-settings`, `name: @local/dsh-gist-settings`) once the bundle has
been selected, and documents the `config:` keys in comments. Editing the row's `config:` block in the
profile is the supported way to configure the plugin; the patch is what makes a plugin row exist at all.

The failure modes this gate creates are the reason [`AGENTS.md`](../../AGENTS.md) prohibits the obvious
shortcuts: removing the `peerDependencies` entry to get past the gate, granting an exact-version
exemption instead of declaring a version CI can verify, or widening the list without a CI leg to install
the new target. Each one turns a checked promise into an unchecked one.

## The data flow of one sync

`gist_sync` reads before it writes, and every write path starts from the same classification.

### 1. Status: local content, remote content, and a recorded baseline

`core.profileStatus` is the decision point:

1. `loadState` reads the state file and finds the profile's record (if any).
2. `resolveProfileFiles` yields the tracked names — `profileFiles` or the default
   `['cordis.patch.yml', 'package.json']`.
3. `collectProfile` reads each tracked file through `resolveTrackedFile`, which resolves every path
   component and checks it against the profile's *real* directory, so a link cannot redirect a read out
   of the profile or into a sibling's config. A file that does not exist is reported in `missing`, not
   fatal.
4. `hashFiles` fingerprints what was read into `localHash`.
5. `gistGet` reads the gist with `only: trackedNames`, so only the tracked subset pays the second
   request the API needs for a truncated file. `remoteHash` is computed over that subset.
6. `baseline` is `record.lastSyncedHash ?? null`.

The classification, in order:

| Condition | Status |
| --- | --- |
| No recorded gist id, and the profile directory holds none of the tracked files | `missing-local` |
| No recorded gist id, and at least one tracked file is present | `untracked` |
| The gist read failed with anything other than a real `HTTP 404` / `Not Found` | `unreachable` |
| The gist read failed with a real 404 | `missing-gist` |
| A tracked file is missing locally but still present in the gist | `missing-local` |
| `localHash === remoteHash` | `in-sync` |
| No baseline recorded, and the two hashes differ | `diverged` |
| Only the local side moved from the baseline | `local-ahead` |
| Only the remote side moved from the baseline | `remote-ahead` |
| Both sides moved | `diverged` |

The distinctions are the safety model, not pedantry. `unreachable` and `missing-gist` are separate
because `gh` reports a deleted gist and a bad token the same way — exit 1 with a message on stderr — and
only a literal 404 goes on to be treated as "the gist is gone"; treating a 401, a rate limit, a DNS
failure or an oversized response that way would let one network blip mint a replacement gist and abandon
the original. `missing-local` is reported before the hash comparison because a tracked file that exists
only in the gist is the one asymmetry the tools must not resolve on their own: an upload would delete the
last copy.

`hashFiles` is SHA-256 over the sorted file names, each name and each content followed by a NUL byte, so
the digest depends on names and bytes and not on iteration order. The remote side is hashed over the
tracked subset only: hashing every remote file would make a gist carrying one extra note — added through
the GitHub web UI, say — report `remote-ahead` forever, and every sync would "download" without
converging.

Status never touches profile files and never writes the gist. One thing in it does write: when the two
sides already agree but the recorded baseline does not match, the baseline is stale (an edit uploaded
from another machine, or a state write that failed), and leaving it stale would turn the next ordinary
edit into a false divergence. That repair runs under the state lock, re-reads the state, and
compare-and-sets on the record's `gistId` and previous `lastSyncedHash`, so a concurrent upload that
advanced the record is left alone rather than moved backwards.

### 2. The verb: which side moves

`core.syncProfile` maps the status onto an action. It does not hold the state lock itself; each verb
takes it.

| Status | Action | What runs |
| --- | --- | --- |
| `untracked`, `missing-gist` | `created` | `uploadProfile` — a first upload creates the gist; a real 404 creates a replacement and reports the URL it replaced. |
| `in-sync` | `noop` | Nothing is written on either side. |
| `local-ahead` | `uploaded` | `uploadProfile`. |
| `remote-ahead` | `downloaded` or `restored` | `downloadProfile`; if the download kept local files the gist does not carry, `uploadProfile` republishes them in the same call and the action becomes `restored`. When the gist carries none of the tracked files there is nothing to download and this machine holds the only copies, so `uploadProfile` runs directly and the action is `restored` with `republished` naming the files. |
| `diverged` | `forced-upload`, or a refusal | Without `force`, an error naming the divergence and telling the caller to choose a direction. With `force: true`, `uploadProfile` with `force`. |
| `missing-local` | `downloaded` | `downloadProfile`, with `force` threaded through so the refusal it can produce is actionable. With no gist to restore from, an error instead. |
| `unreachable` | a refusal | An error naming the failed read and stating that creating a replacement would abandon the existing backup. |

No deletion is ever propagated by these paths, in either direction: a tracked file removed from the gist
is put back into it, and a tracked file deleted locally is not removed from the gist. Applying a deletion
is a deliberate act on the side that still holds a copy, which is what the recovery guide documents.

### 3. Upload: prune and dropped files, then the record

`core.uploadProfile` runs under `withStateLock` and writes only the remote side:

1. `loadState`, then `assertNoCaseCollision` — a profile whose name differs only in case from an already
   tracked one is refused, because on a case-insensitive filesystem the two names are one directory and
   two gists for one directory diverge silently.
2. `collectProfile`; an upload of a profile that holds none of the tracked files is refused, naming the
   directory it looked in.
3. If the record has a gist id, the gist is read. A read that fails for anything other than a real 404
   aborts the upload — creating a replacement would fork the backup and abandon the original while other
   machines kept syncing to it. A real 404 clears the id and records the old URL as `replaced`, so the
   report can name the gist that was abandoned.
4. A tracked file that is missing locally but still present in the gist is a refusal unless `force` is
   set: uploading would delete the only remaining copy. With `force`, those names are `dropped` — and
   they are actually sent as deletions, which is what makes `force` mean what its description says.
5. Every gist file whose name is no longer tracked is `pruned` (sent as a `null` content, which deletes
   it), because the tracked set is the contract; a file added to the gist by hand is removed with no
   backup of it.
6. Content and removals go out in one `gistPatch`, or the gist is created with `gistCreate` on a first
   upload or after a real 404.
7. The record is written — `gistId`, `gistUrl`, `description`, the uploaded file names, `lastSyncedHash`
   set to the local hash, `lastSyncAt`, `lastDirection: 'upload'` — and saved. If that save fails, the
   error says the gist exists and names it, because a bare failure would invite a retry that mints a
   second gist.

### 4. Download: guards, a backup, and one atomic commit

`core.downloadProfile` also runs under `withStateLock`, and its first half is refusal logic:

- No record → "not tracked yet; run an upload first".
- A gist carrying none of the tracked files → refused, because a download from it would change nothing.
- `localHash !== remoteHash` and no `force` and the local files are not a byte-identical subset of the
  remote → refused, with the message chosen by what moved: no baseline at all, both sides changed
  (divergence), or only the local side changed (unsynced edits that a download would discard).
  Restoring files that are merely absent locally needs no `force`: it discards nothing.

Then the write:

1. `backupProfile` copies every tracked file that exists into
   `<stateDir>/backups/<profile>/<timestamp>`, where the timestamp is an ISO string with `:` and `.`
   replaced by `-`. A profile with nothing local returns `null` instead of creating an empty directory,
   and the reporting says so rather than pointing at a backup that was not taken.
2. `signal.throwIfAborted()` — the one cancellation point before the commit, so a cancelled call leaves
   the profile untouched.
3. `commitTrackedFiles` stages, measures, and only then commits, in that order:
   - Each target is resolved through `resolveTrackedFile` and given an identity: the file id
     (`dev`:`ino`) when the target exists, otherwise its resolved parent directory plus its final name.
     Two tracked names with one identity are refused before anything is written, because one of them
     would otherwise overwrite the other and reporting both as written would be false. This is what
     catches `link/cordis.patch.yml` and `real/cordis.patch.yml` being one file through a junction, and
     a Windows short name spelling.
   - A staging directory is created *inside* the profile directory — `mkdir`, not `recursive` — under
     `.dsh-gist-settings-staging-<pid>-<base36 time>`. Being inside the profile keeps the final step on
     one volume, and a name that already exists is an honest `EEXIST` rather than a directory the plugin
     would later delete by name. Nothing tracked is touched yet.
   - Every file is written into the staging directory, then measured: `stat().size` against
     `Buffer.byteLength(content, 'utf8')`, so a short write that still reported success is caught before
     the profile is overwritten.
   - Each target is re-resolved immediately before its `rename`, because staging a large payload takes
     time and the profile directory could have been swapped for a link in that window. `rename` is the
     commit: it lands as either the old content or the new one, never a truncated mixture.
   - A rename that fails calls `rollbackFiles`, which walks the already-committed files in reverse and
     undoes only what this transaction actually wrote: for each one it re-reads the bytes and leaves the
     file alone if they differ (an editor or a second process may have replaced it with a revision no
     backup here holds), restores previous content through the staging directory so the restore is
     atomic too, and removes a file the download created. Names it could not read or could not restore
     are reported as such, and the error names the backup directory. "Left untouched" and "at the new
     revision" are different outcomes and are reported differently.
   - The staging directory is removed in a `finally` on every path. One left behind by a killed process
     is inert: nothing tracks it, `listProfiles` skips dot-directories, and the next run uses a fresh
     name.
4. Files the gist does not carry are `keptLocally` — reported, never deleted.
5. The record's `lastSyncedHash` becomes `remoteHash` (the remote content this machine now agrees on),
   `lastDirection` becomes `'download'`, and the state is saved. If that save fails, the error says the
   files are in place and that `gist_status` repairs a stale baseline once the directory is writable —
   the failure is in the recording, not in the restore.

## The state file and the cross-process lock

Both live in the state directory: `resolveStateDir(config)` is `config.stateDir`, else
`<dshHome>/gist-settings`, where `dshHome` is `config.dshHome`, else `$DSH_HOME`, else `~/.dsh`. The
directory also holds `state.json.bak` and the `backups/` tree.

### `state.json`

The file is `{ "version": 1, "profiles": { "<name>": { … } } }`. `STATE_VERSION` is `1`: it is the
version a missing state file reports, and the upload path stamps it on the state before saving, while
`loadState` otherwise carries a file's own `version` through unchanged. A record's only required field
is `gistId`; `gistUrl`, `description`, `files`, `lastSyncedHash`, `lastSyncAt` and `lastDirection` are
the rest. `files` is informational — the tracked set always comes from `profileFiles`, so a record that
drifted from the configuration cannot change what is read or written.

`loadState` is defensive because the file is also reachable by hand and by JavaScript. A missing file is
an empty state, not an error. Invalid JSON is an error naming the path and noting that the gists it
named still exist. `profiles` must be an object: `null` would throw deep inside a tool and an array would
accept named properties that never serialise, so every later upload would mint a fresh gist. Each record
must be an object, and a `gistId` must match `^[A-Za-z0-9][A-Za-z0-9-]*$` because it is interpolated
into a `gh api` endpoint — which rules out a leading hyphen (flag injection) and any path separator.
Records without a `gistId` are dropped.

`saveState` is atomic: it writes `<target>.<pid>.<random>.tmp` (a per-writer name, so two processes
cannot rename half of each other's file into place), copies the previous revision to `state.json.bak`,
renames the temp file over the target, and removes the temp file if anything fails. The `.bak` is what
makes a bad write recoverable by hand.

### The lock

Two locks exist because two different things race:

- An **in-process promise chain** (`stateLock`), because an agent issues tool calls in parallel and two
  uploads would each read the old file — the later write dropping the earlier profile's record,
  untracking it and orphaning its gist.
- A **lock file** (`state.lock` in the state directory), because two host processes sharing one
  `stateDir` race the same way and a promise is invisible to the other process. It is also what stops two
  processes syncing the same untracked profile from minting two gists for it.

The file holds `<pid> <hostname>`. Acquisition is an exclusive `wx` create; on `EEXIST` the holder is
read and the caller waits, polling every `LOCK_POLL_MS` (100 ms) for up to `LOCK_WAIT_MS` (150 s), after
which the error names the holder, its pid and its host, and says what to do. The wait is sized to outlast
one profile's slowest operation: an upload or download makes at most two sequential `gh` calls before
releasing the lock, and each `gh` call is capped at 60 seconds. A holder that actually died never waits
at all.

Staleness is decided by evidence rather than by age alone:

- Same host and a readable pid → the pid is authoritative. `kill(pid, 0)` asks the OS whether it still
  exists (no signal is sent; `EPERM` means someone else's live process), so a crashed holder is reclaimed
  immediately and a slow but live holder is never stolen from.
- A foreign host, or a file that could not be parsed → age, with a threshold of
  `FOREIGN_LOCK_STALE_MS` (60 s). The holder keeps the file's mtime fresh with a heartbeat every
  `FOREIGN_LOCK_STALE_MS / 3` (20 s, `unref`'d so it does not hold the host open).

Removing a stale lock is the delicate part, because `rm` acts on the path rather than on the file that
was inspected: two waiters can read the same abandoned lock, and the second can then remove the first's
*live* lock and enter alongside it. So the removal happens under a token file created with `wx`
(`state.lock.reclaim`), and only the winner re-reads the lock and removes it if it is *still* stale.
While the token is held, nothing else can remove the lock or create one. A token older than
`RECLAIM_TAKEOVER_MS` (5 s) belonged to a process that died inside its three filesystem calls and may be
taken over; even then the re-read rule means a live lock is never removed. Release removes the file only
if it still names this pid and this host, so a release cannot free a lock another process now owns.

The lock is deliberately **not reentrant**: `AsyncLocalStorage` records the held lock, and a nested
`withStateLock` in the same call chain throws with an explanation instead of deadlocking. A depth
counter could not tell a nested call from a second independent caller that must still queue.

`saveState` closes the remaining race from the other side: when a write happens while a lock is held, it
re-reads the lock file first and refuses — with `lockLost` on the error — if the lock is no longer this
process's, rather than overwriting a newer revision recorded by whoever took it.

## The module-resolution rule

The runtime imports nothing outside `node:`. In full, that is one value import and one type-only import
in `index.ts` (`./lib/core.ts`) and the six `node:` imports in `lib/core.ts` listed at the top of this
page. The Harness appears only as an optional peer dependency; nothing is imported from
`@deepseek-ai/dsh`, `@deepseek-ai/dsh-tools` or any sibling package.

Two consequences follow, and both are intentional:

- **The framework shapes the plugin reaches are written structurally.** `PluginContext`,
  `ToolDefinition`, `ToolExecution`, `ToolValue` and `Disposer` are declared in `index.ts` as the
  minimum the code uses, not imported from the runtime. The tool definitions are plain objects rather
  than `defineTool` results, mirroring what `defineTool` produces: raw JSON Schema in `parameters`,
  `execute` returning a canonical value, `output.render` projecting it into content blocks. A change to
  how the Harness lays out its packages, or to what its types are named, cannot break the bundle — the
  module graph has no edge into the installation to break.
- **The Harness never type-checks these definitions.** That gap is closed by `test/schema.test.ts`,
  which locates an installed `@deepseek-ai/dsh-tools`, replays the registry's own checks against these
  definitions — the output shape, `assertSupportedJsonSchema` on the parameters and the output schema,
  `validateJsonSchemaValue` over arguments (compared against `checkArgs`, which reimplements it by
  hand), and that each returned value satisfies its declared `output.schema` — and calls the loader's
  `evaluatePluginCompatibility` on this repository's manifest. Finding no installation fails that suite
  rather than skipping it.

The same rule explains the dependency list: `package.json` has no runtime `dependencies`, and its
`devDependencies` are `@types/node` and `typescript`, both exact-pinned. `npm install --include=dev` is
therefore a build-tool install, and adding a runtime dependency would be the first edge from this bundle
into somebody else's module resolution — which is why [`AGENTS.md`](../../AGENTS.md) prohibits it.

## Where logic belongs

The rule the two-module split exists to state:

- A change to **what a sync does** — a guard, a filesystem or `gh` interaction, a field in the state
  file, the lock, the hashing, the containment rules — belongs in `lib/core.ts`, with a case in the
  suite that owns that behaviour.
- A change to **what the model is told or what a call accepts** — a name, a description, a parameter, a
  default, `config:` validation, the report text — belongs in `index.ts`, with a case in the suite that
  owns the tool layer.
- Neither module may reach into the other's side of the boundary: the engine must not import a Cordis
  type or read the Cordis context, and the tool layer must not touch the filesystem, spawn `gh`, or edit
  the state file directly.

| Change | Owner | Proven by |
| --- | --- | --- |
| A sync rule, a refusal, a backup, the atomic commit | `lib/core.ts` | `test/sync.test.ts`, `test/safety.test.ts`, `test/regression.test.ts` |
| A tool description, parameter, default or report line | `index.ts` | `test/tools.test.ts`, `test/schema.test.ts`, `test/entry.test.ts` |
| Which files are tracked | `resolveProfileFiles` / `normalizeTrackedName` in `lib/core.ts`, with the key kept in `readConfig`'s `KNOWN_CONFIG_KEYS` | `test/safety.test.ts`, `test/tools.test.ts` |
| The compatibility declaration | `package.json`, plus a CI leg that installs each declared version | `test/schema.test.ts` |
| The bundle patch and the row it inserts | `cordis.patch.yml` | An install into a real profile |

The suites listed are the ones that own the behaviour, not the only ones that exercise it; the full
mapping is in [Testing](testing.md) and in [`CONTRIBUTING.md`](../../CONTRIBUTING.md) under
`What the test suites prove`. Before changing anything that can delete, overwrite or publish, read the
three questions `CONTRIBUTING.md` requires a pull request to answer — what is backed up first, what
happens if the destructive step fails half-way, and how a user recovers.