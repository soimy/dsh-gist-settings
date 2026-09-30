# Tools

This page is the reference for the four agent tools the plugin registers: `gist_status`, `gist_upload`,
`gist_download` and `gist_sync`. It documents every parameter and the values that are refused, the value
a call returns, what a call writes under the state directory and inside a profile, which gists it creates
or removes files from, when it takes a backup, and how it fails.

The README's [Tools](../../../README.md#tools) section is the short version, and its
[status vocabulary](../../../README.md#status-vocabulary) lists the printed status lines.
[configuration.md](configuration.md) is the reference for the configuration these tools read, and
[recovery.md](recovery.md) covers recovering from a bad state.

The definitions live in [`index.ts`](../../../index.ts); everything they execute lives in
[`lib/core.ts`](../../../lib/core.ts). The behaviour described here is pinned by `test/tools.test.ts` and
`test/schema.test.ts`; [testing.md](../../contributor/testing.md) maps the remaining behaviour to the
suites that cover it.

## The shape of a call

`apply()` registers the four definitions through one labelled Cordis effect, `dsh-gist-settings tools`,
and declares `inject = ['tools']` as the only service the plugin needs. `test/tools.test.ts` pins that
exactly these four names are registered and that they are disposed under that one label.

The definitions are hand-written objects rather than `defineTool` results, so the Harness's own argument
validator never sees a call: `checkArgs` validates on the way in, before any file or `gh` work. Each
definition declares `parameters` as raw JSON Schema with `additionalProperties: false`, and every
parameter node carries the `description` the model reads.

### Arguments

Every parameter of every tool is optional. The argument object may be omitted entirely, and `undefined`,
`null` or `{}` all mean "no arguments". Beyond that, values are checked and never coerced:

- A misspelled key is refused: `invalid arguments for gist_sync: unknown argument "profil"`. Without
  this, a dropped key would widen the call to every profile.
- A wrong type is refused, including an explicit `null` for a declared parameter:
  `invalid arguments for gist_download: "force" must be a boolean, received "false"`. A string is never
  read as a boolean, so `force: "false"` cannot become a forced overwrite.
- An argument list that is not an object is refused:
  `invalid arguments for gist_download: expected an object, received an array` (also `string`, `number`).
- Several problems in one call are reported together, joined with `; `.

`test/schema.test.ts` compares this gate against the Harness's own `validateJsonSchemaValue`: for every
argument shape the real validator rejects, the plugin must reject it too.

### The returned value

Every tool returns the same canonical value: an object with one string field, `text`, whose value is the
report. Each definition declares the matching output schema

```json
{ "type": "object", "properties": { "text": { "type": "string" } }, "additionalProperties": false }
```

and `output.render` projects that value into a single content block, `[{ type: 'text', text }]`.
`test/schema.test.ts` runs the Harness's own `validateJsonSchemaValue` over a returned value for each
tool, and `test/tools.test.ts` calls `render` on every case and asserts that each block is a text block.

A per-profile failure is part of that text, not a thrown error, for `gist_upload`, `gist_download` and
`gist_sync`: each catches per profile, emits `<profile>: FAILED - <message>` and continues with the next
one, so one bad profile never aborts the rest. `gist_status` has no per-profile catch, so an engine error
there — an unresolvable profile directory, an unreadable state file — fails the whole call. A refusal
that applies to the call as a whole is thrown for every tool and reaches the model as a tool error.

### Concurrency

Only `gist_status` declares a concurrency classifier, `isConcurrencySafe: () => true`, so the registry
may run it in a parallel batch. The other three declare none, which `index.ts` documents as exclusive.

| Tool | Declared classifier | Effect in a batch |
|---|---|---|
| `gist_status` | `() => true` | may run alongside other calls |
| `gist_upload` | none | exclusive |
| `gist_download` | none | exclusive |
| `gist_sync` | none | exclusive |

Independently of that verdict, every read-modify-write of the state file runs under
`<stateDir>/state.lock`, so two Harness processes sharing one `stateDir` queue instead of losing a
record. The lock is per engine call: a `gist_sync` step that downloads and then republishes what the
gist had dropped takes it twice, so another process can interleave between the two halves.

### Profile names and profile selection

A `profile` argument is resolved by `resolveProfileArg` before any gist or profile file is touched:

- The name must match `^[A-Za-z0-9._-]+$`, must not begin with `.`, and may not be the shared
  `node_modules` store. Otherwise: `invalid profile name: "../../etc"`.
- A case-only variant of a real profile directory is refused and the real name is named, because on
  Windows and macOS the two spell the same directory and accepting both would mint two gists for one
  profile: `profile "ALPHA" is not the name of a profile directory; "alpha" is. Names are matched
  exactly, so that a difference of case alone cannot create a second gist for the same directory.`
- A case-only variant of a tracked profile whose directory is gone is refused the same way:
  `profile "ALPHA" is tracked as "alpha"; use that exact name, …`.
- A name that is neither on disk nor tracked is refused with the list of known names:
  `unknown profile "no-such-profile"; known profiles: alpha, beta`, or `(none)` when there are none.
- A tracked name whose directory no longer exists is accepted, because `gist_download` is what restores
  it.

Selection differs per tool, and the difference matters most when a profile directory has been deleted:

| Tool | With `profile` | Without `profile` |
|---|---|---|
| `gist_status` | that profile | every known profile: the directories under `profilesDir`, plus every name recorded in `state.json` |
| `gist_upload` | that profile | only the profiles with a directory on this machine; a tracked name without one is reported, not skipped silently |
| `gist_download` | that profile | every known profile that has a recorded gist |
| `gist_sync` | that profile | every known profile |

"Known" is `listKnownProfiles`: the directory listing plus the state file. The listing skips
`node_modules` and any dot-directory. The `gh` half of the health check runs before the name check in
every tool; `gist_status` and `gist_download` also read the state file before it, so a missing `gh` or an
unparsable state file is reported before an unknown profile name is.

## `gist_status`

Reports whether the local `gh` CLI is usable and what state every profile is in, changing neither the
profile nor the gist.

### Parameters

| Parameter | Type | Required | Default | Refused when |
|---|---|---|---|---|
| `profile` | string | no | every known profile | not a string; an invalid, unknown or case-only-variant name |

### What it returns

A header, then one block per selected profile, then optionally a "not tracked yet" suffix:

```
gh:   <version line from `gh --version`>
      <resolved gh path>
auth: ok (<account>) | NOT AUTHENTICATED - run `gh auth login` | not checked - gh is not installed
home: <resolved dshHome>
state: <stateDir>/state.json

<profile>
  status: <label>
  gist:   <url>
  error:  <message>
  absent: <tracked files missing locally>
  gist also holds (untracked here): <names>
```

The `gist:`, `error:`, `absent:` and `gist also holds` lines appear only when they have something to
say. When `gh` is missing the first line becomes `gh:   NOT FOUND - <reason>`, and when it is installed
but not authenticated the `auth:` line says so; in neither case does the report advise `gh auth login`
for a CLI that is not installed. With no profiles at all the body is `No profiles found.`, after the
header. Selected profiles with no record in `state.json` add a final paragraph:
`Not tracked yet: <names>. Run gist_upload to create their gists.`

Each status name is decided by `profileStatus`, on the tracked subset of the gist only — so a file added
to the gist by hand cannot make a profile look permanently out of date, and it is reported separately as
"gist also holds (untracked here)":

| Status | Printed as | Decided by |
|---|---|---|
| `untracked` | `not tracked` | no gist is recorded and the profile has at least one tracked file on disk |
| `in-sync` | `in sync` | the hashes of the local and remote tracked files are equal |
| `local-ahead` | `local changes to upload` | the local hash moved away from the recorded baseline and the remote hash still equals it |
| `remote-ahead` | `gist changes to download` | the remote hash moved away from the baseline and the local hash still equals it |
| `diverged` | `DIVERGED - needs a decision` | both sides moved away from the baseline, or no baseline was ever recorded and the two differ |
| `missing-local` | `tracked files missing locally - run gist_download to restore` | a tracked file is absent locally while the gist still holds it; also, no gist is recorded and the profile holds none of the tracked files |
| `missing-gist` | `gist deleted - the next upload recreates it` | reading the gist failed with `HTTP 404` or `Not Found` |
| `unreachable` | `gist UNREACHABLE (not deleted) - retry when connected` | reading the gist failed for any other reason; the message is on the `error:` line |
| `unknown` | `unknown - gh is unavailable, remote state not checked` | `gh` is missing or logged out, and a gist is recorded for the profile |

When `gh` is unusable no gist is read at all: each selected profile is reported as `unknown` if
`state.json` records a gist for it, and as `untracked` otherwise, with the URL from the record.

### What it does to the world

- Reads `state.json` and the tracked files of each profile.
- Reads each tracked gist, resolving full content only for files this profile tracks.
- Writes nothing inside any profile, and creates, updates or deletes no gist.
- May repair a stale baseline in `state.json`. When a profile is `in-sync` but the recorded
  `lastSyncedHash` is not what both sides now agree on, it rewrites that field and `lastSyncAt` — under
  the state lock, and only if the record's `gistId` and baseline are still the ones it read
  (compare-and-set), so a newer revision written by another process is never moved backwards. The write
  goes through `saveState`, which also leaves the previous revision as `state.json.bak`.
- Extra files in the gist that this profile does not track are reported, never touched.

**Concurrency:** declared safe to run alongside other calls. Its one write path is guarded by the state
lock and by the compare-and-set above.

### Failure modes

- `gh` missing or logged out is not a failure: the report says so and falls back to the local record.
- An unknown, invalid or case-only-variant profile name is refused (see
  [Profile names and profile selection](#profile-names-and-profile-selection)).
- A state file that cannot be read or parsed fails the call, with the message naming the file. The same
  applies to a `profiles` section that is not an object and to a record whose `gistId` is not
  alphanumeric, because that id is interpolated into a `gh api` endpoint.
- A profile directory that resolves outside `profilesDir`, or a tracked file that resolves outside its
  own profile directory, fails the call: there is no per-profile catch here.
- A tracked name that is a directory on disk fails the call with
  `tracked file "<name>" of profile "<profile>" is a directory, not a file`.
- The baseline-repair write can fail on the state lock, or if the state directory is not writable; the
  [shared failure modes](#failures-common-to-all-four) list both messages.

## `gist_upload`

Pushes each selected profile's tracked files into its gist — creating the gist on the first upload,
updating that same gist afterwards — and never modifies a local file.

### Parameters

| Parameter | Type | Required | Default | Refused when |
|---|---|---|---|---|
| `profile` | string | no | the profiles that still have a directory | not a string; an invalid, unknown or case-only-variant name |
| `description` | string | no | the profile's recorded description, else `DeepSeek Harness profile config: <profile>` | not a string |
| `force` | boolean | no | `false` | not a boolean |
| `verifyGh` | boolean | no | `true` | not a boolean |

`description` is selected with `description || record?.description || default`, so an empty string falls
back to the recorded or generated description rather than clearing it.

`verifyGh: false` skips the `gh auth status` check but still resolves `gh`; a `gh` that cannot be found
still fails the call.

### What it returns

One block per selected profile, separated by blank lines:

```
<profile>: created|updated <gist url>
  files: <tracked files uploaded>
  REPLACED a gist that could not be read; the previous one was <url>
  removed from the gist (no longer tracked): <names>
  DELETED from the gist because force was set, though they are still tracked: <names>
  absent locally: <names>
```

The four indented lines appear only when they apply. A profile that fails produces
`<profile>: FAILED - <message>` in place of its block. In a bulk upload, a tracked profile with no
directory is reported once at the end:

```
<names>: NOT uploaded - no profile directory on this machine. Run gist_download to restore it from its gist.
```

With nothing to do at all — no directory and nothing tracked — the whole value is
`No profiles found; nothing to upload.`

### What it does to the world

- **Creates** a secret gist (`public: false` via `gh api --method POST /gists`) when the profile has no
  recorded gist, including when a recorded gist answers a genuine 404. In the 404 case the previous URL
  is reported on the `REPLACED` line and the record is replaced.
- **Patches** the recorded gist (`PATCH /gists/<id>`) otherwise, sending every tracked file's content
  plus a `null` for each file it removes.
- **Removes** from the gist every file the gist holds that is not in `profileFiles`. This is the one
  destructive path with no backup: the content is not saved anywhere by this plugin.
- **Removes tracked files with `force: true`** when they are missing locally but still present in the
  gist, and names them on the `DELETED` line. Without `force` such an upload is refused instead, because
  the gist may hold the only remaining copy. A tracked file that is missing locally *and* absent from the
  gist is not a refusal; it is reported on the `absent locally` line.
- **Never writes, renames or deletes a local file**, and takes no backup.
- **Writes the state record** for each uploaded profile: `gistId`, `gistUrl`, `description`, `files`,
  `lastSyncedHash`, `lastSyncAt` and `lastDirection: 'upload'`. The whole operation runs under
  `<stateDir>/state.lock`, and `saveState` creates the state directory if needed and leaves the previous
  revision as `state.json.bak`.
- Removing files is decided by the configured tracked set, never by what is on disk: shrinking
  `profileFiles` makes the next upload prune those files from the gist.

**Concurrency:** exclusive.

### Failure modes

- ``gh CLI not found: <reason>. Install GitHub CLI (https://cli.github.com) or set `ghPath` in this
  plugin's config.`` With `verifyGh: false` and no working `gh` the message is shorter:
  ``gh CLI not found; set `ghPath` in this plugin's config.``
- ``gh is installed at <path> but not authenticated. Run `gh auth login` once, then retry. Gists are
  created with `gh api`, so no extra scopes are needed.``
- `profile "<name>" has none of the tracked files in <dir>` — an empty or deleted profile directory has
  nothing to send.
- A gist read that fails for any reason other than a 404 aborts that profile's upload rather than
  replacing the gist: `could not read gist <id> for profile "<name>": <detail>. Refusing to create a
  replacement gist, which would abandon the existing backup; retry when reachable.`
- `refusing to upload "<profile>": <files> is/are missing locally but still present in the gist, so
  uploading would delete the only remaining copy. Run gist_download to restore them, or pass force to
  drop them from the gist too.`
- `profile "<name>" differs only in case from the tracked profile "<other>", and both name the same
  directory on this filesystem. Use the existing name: a second gist for one profile would diverge
  silently.`
- If the gist was created or updated but the state record could not be written, the message says so and
  warns about the consequence: `the gist <url> was created|updated for profile "<name>", but recording it
  in <statePath> failed (<message>). The gist exists; make the state directory writable before retrying,
  or the next upload will create a second one.`
- A call that is cancelled has its abort checked around the network steps; the upload is reported like
  any other per-profile failure and the local files are untouched.

## `gist_download`

Restores each selected profile's tracked files from its gist, after backing up what is on disk, with a
write that either lands completely or leaves the profile as it was.

### Parameters

| Parameter | Type | Required | Default | Refused when |
|---|---|---|---|---|
| `profile` | string | no | every known profile that has a recorded gist | not a string; an invalid, unknown or case-only-variant name |
| `force` | boolean | no | `false` | not a boolean |

`gh` is always resolved and authenticated before anything else; this tool has no `verifyGh` escape.

### What it returns

```
<profile>: restored from <gist url>
  files: <files written>
  kept locally (the gist does not carry them): <names>
  previous files backed up to: <backup dir>
```

The last two lines appear only when they apply, and a failing profile produces
`<profile>: FAILED - <message>`. When no selected profile has a gist, the value is
`Nothing to download: no profile has a gist yet. Run gist_upload first.` and nothing is written.

### What it does to the world

- Reads `state.json`, the gist, and the local tracked files. Profiles without a recorded gist are
  filtered out before the engine is called, so `downloadProfile`'s own "not tracked yet" error is not
  reachable from this tool.
- **Backs up first**: every tracked file that exists locally is copied to
  `<stateDir>/backups/<profile>/<timestamp>/`, with the timestamp derived from an ISO 8601 instant with
  `:` and `.` replaced by `-`. A profile that holds none of the tracked files gets no backup directory,
  and the result says so by omitting the `backed up to` line.
- **Writes all-or-nothing**: the new content is staged inside the profile directory at
  `.dsh-gist-settings-staging-<pid>-<base36 time>/`, each staged file's byte count is checked, and only
  then is each file renamed into place — one atomic rename per file. The staging directory is removed in
  a `finally`. A profile directory that does not exist is created.
- **Rolls back a failed commit**: files this transaction already replaced are restored from the bytes
  read at the start. A file that changed since the write, or that the rollback cannot read back, is left
  exactly as it is and named in the error, because overwriting it on a guess could destroy work no
  backup holds. The error also names the backup directory, or says nothing existed locally before.
- **Keeps local tracked files the gist does not carry** and reports them; it never deletes them, and the
  next upload adds them back.
- **Writes the state record**: `gistUrl`, `description`, the new file list, `lastSyncedHash` set to the
  remote hash, `lastSyncAt` and `lastDirection: 'download'`.
- **Creates, updates and deletes no gist** — this tool only reads one.
- Restoring files that are merely missing locally discards nothing, so it needs no `force`. `force` is
  required to overwrite local content that was never uploaded, and it still takes the backup.

**Concurrency:** exclusive.

### Failure modes

Refusals, all raised before anything is written:

- `gist <id> holds none of the tracked files for profile "<name>". Run gist_upload to repopulate it from
  this machine.` — not overridable by `force`.
- `local "<name>" has unsynced changes; downloading would discard them. Upload them, or re-run with force
  (a backup is taken first).`
- `profile "<name>" has diverged: both local and gist changed since the last sync. Re-run with force to
  overwrite local files (a backup is taken first).`
- `profile "<name>" has no recorded baseline and its local files differ from the gist, so a download
  cannot be proven safe. Re-run with force to overwrite local files (a backup is taken first).`

Failures after the point of no return:

- A failed rename rolls back and reports what it could not put back (see above).
- A failed state write after a successful commit does not claim the download was lost:
  `profile "<name>" was restored from <url>, but recording the new baseline in <statePath> failed
  (<message>). The files are in place; gist_status repairs a stale baseline once that directory is
  writable again.`
- A cancellation is checked after the backup and before the first write, so an aborted call leaves the
  profile untouched. The commit itself is deliberately not interruptible, because stopping between two
  renames is the half-applied state the staging step exists to prevent.

## `gist_sync`

Fast-forwards each selected profile in whichever direction changed, restores tracked files that went
missing locally, and refuses to guess when both sides changed.

### Parameters

| Parameter | Type | Required | Default | Refused when |
|---|---|---|---|---|
| `profile` | string | no | every known profile | not a string; an invalid, unknown or case-only-variant name |
| `force` | boolean | no | `false` | not a boolean |

`force` does two things: it resolves a divergence by uploading the local files, and it lets a restore
proceed when it would otherwise be refused for discarding unsynced local edits. A backup is still taken
before any overwrite.

### What it returns

One line per selected profile, `<profile>: <detail>`, where the detail is
`already in sync (<url>)` for a no-op — or `already in sync (no gist url)` when the record holds no URL —
or `<action> <url>` otherwise, followed by any of the same indented lines `gist_upload` and
`gist_download` print:

```
  REPLACED a gist that could not be read; the previous one was <url>
  removed from the gist (no longer tracked): <names>
  DELETED from the gist because force was set, though they are still tracked: <names>
  kept locally (the gist does not carry them): <names>
  the gist had dropped these; put back from the local copy: <names>
  restored: <names>
  previous files backed up to: <dir>
```

`kept locally` is suppressed when the same call republished those files, because after that they are no
longer absent from the gist. With no known profiles at all the value is `No profiles found; nothing to
sync.`, and a failing profile produces `<profile>: FAILED - <message>`.

### What it does to the world

The call classifies the profile, then takes exactly one of these paths. The action words are the ones
the report prints.

| Status | Action | What happens |
|---|---|---|
| `untracked` | `created` | uploads; the gist is created |
| `missing-gist` | `created` | uploads; a new gist replaces the deleted one, and the replaced URL is reported when the record held one |
| `in-sync` | (no-op) | nothing at all; the line says `already in sync (<url>)` |
| `local-ahead` | `uploaded` | uploads |
| `remote-ahead` | `downloaded` | downloads; if the download kept local files the gist had dropped, they are uploaded again in the same call and the action becomes `restored` |
| `remote-ahead` with an empty tracked set in the gist | `restored` | the gist carries none of the tracked files, so the local copies are republished rather than a download that could change nothing |
| `diverged` | `forced-upload` | refused unless `force` is set; with `force`, the local files are uploaded |
| `missing-local` | `downloaded` | downloads, with `force` threaded through so the refusal it can raise is actionable |
| `unreachable` | — | refused; a gist that cannot be read is never treated as deleted |

Everything each of those actions writes is what the corresponding tool writes:
[`gist_upload`](#gist_upload) for an upload and [`gist_download`](#gist_download) for a download,
including the backup before a write and the state record afterwards. A profile with no local tracked
files and no gist is the one case that neither restores nor uploads.

**Concurrency:** exclusive.

### Failure modes

- `profile "<name>" has diverged: local and gist both changed since the last sync. Choose upload or
  download explicitly, or re-run with force.`
- `profile "<name>": cannot read gist <id> (<error>). Refusing to sync, because creating a replacement
  would abandon the existing backup.` — a gist that is merely unreachable stops the sync rather than
  being replaced.
- `profile "<name>" has no local config files and no gist to restore them from. Restore the files, or
  delete the profile directory if it is obsolete.`
- Everything the upload, download and status paths can raise, plus the shared failures below.
- Deletions are never propagated in either direction: a tracked file removed from the gist is put back
  into it in the same call, and a tracked file deleted locally is not removed from the gist. Applying a
  deletion is a deliberate act on the side that still holds the copy — delete the local file and sync,
  or use `gist_upload` with `force: true`.

## Failures common to all four

- **`gh` is resolved and authenticated first** for every tool except an upload with `verifyGh: false`.
  Resolution tries the configured `ghPath`, then `gh` on the `PATH`, then the well-known install
  locations, and a failure carries the reason: `gh:   NOT FOUND - <reason>` is the `gist_status` report,
  while the other three throw `gh CLI not found: <reason> …`.
- **The state file is read defensively.** Invalid JSON, a `profiles` section that is not an object, a
  record that is not an object, or a `gistId` that fails the alphanumeric pattern all fail the call with
  a message naming the file. A record with no `gistId` is dropped rather than reported.
- **The state lock is cross-process.** Waiters give up after 150000 ms and name the holder:
  `timed out after 150000 ms waiting for <stateDir>/state.lock, held by pid <pid> on <host>. Another
  DeepSeek Harness process is writing the same state directory. Retry once it finishes, or delete that
  file if no such process is running.` A lock whose owner has exited is reclaimed at once.
- **Containment is re-checked against real paths.** A profile directory that resolves outside
  `profilesDir`, or a tracked file that resolves outside its own profile directory, is refused:
  `profile "<name>" resolves outside the profiles directory (<path>); refusing to read or write it`.
  This is what stops a junction placed at `profiles/<name>`, or a tracked file that is a link out of the
  tree, from being published or overwritten.
- **Cancellation** is honoured around the network and write steps through the execution's abort signal;
  the engine checks it between steps rather than in the middle of a commit.
- **One profile never aborts the others** in `gist_upload`, `gist_download` and `gist_sync`.
  `test/tools.test.ts` pins this with a profile whose upload cannot succeed while a healthy profile is
  still processed.

## Related

- [configuration.md](configuration.md) — every configuration key and its default.
- [recovery.md](recovery.md) — recovering from a bad state, a lost directory or a deleted gist.
- [troubleshooting](../troubleshooting/index.md) — what to do when a call fails.
- [`index.ts`](../../../index.ts) and [`lib/core.ts`](../../../lib/core.ts) — the definitions and the
  engine.
- [README — Tools](../../../README.md#tools) — the short version of this page.