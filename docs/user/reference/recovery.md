# Recovery

What the plugin writes and where, exactly what `force` overrides, how the state lock behaves when a
process leaves it behind, and the steps out of each failure the suites pin: a download that failed
part-way, a diverged profile, a gist deleted on GitHub, a deleted profile directory, a tracked file
deleted locally, and a stale lock.

The promises themselves are the README's [safety model](../../../README.md#the-safety-model). This page
is the operational long form for them: the behaviour is implemented in
[`lib/core.ts`](../../../lib/core.ts), and the cases in `test/safety.test.ts`,
`test/regression.test.ts` and `test/sync.test.ts` pin the guarantees it makes.

## Where the plugin writes

The state directory is `<stateDir>`, which defaults to `<dshHome>/gist-settings`; `<dshHome>` is the
`dshHome` config key, else `$DSH_HOME`, else `~/.dsh`. See
[Configuration](./configuration.md) for those keys.

| Path | Written by | What it holds |
| --- | --- | --- |
| `<stateDir>/state.json` | every operation that records a sync | one record per tracked profile: its gist and its sync baseline |
| `<stateDir>/state.json.bak` | the write that replaces `state.json` | the previous revision of that file |
| `<stateDir>/backups/<profile>/<timestamp>/` | `gist_download`, before the first write | the profile's tracked files exactly as they were |
| `<stateDir>/state.lock` | every state-writing operation | the pid and hostname of the holder, while it works |
| `<profile>/.dsh-gist-settings-staging-<pid>-<time>/` | `gist_download`, for the duration of the commit | the new content, staged before anything tracked is touched |

Two further files exist only while an operation is in flight: a per-writer
`<state.json>.<pid>.<random>.tmp`, which is renamed into place on success and removed on failure, and
`<stateDir>/state.lock.reclaim`, the token held while a stale lock is being reclaimed.

In particular, `gist_upload` writes no backup of any kind: it never modifies a local file, and the gist
files it removes when they stop being tracked are removed with no copy kept — see [Backups](#backups)
below and the warning in the [README](../../../README.md#tools).

## Backups

`gist_download` copies the profile's tracked files to `<stateDir>/backups/<profile>/<timestamp>/` before
it overwrites anything, **including when `force: true` is set**. A forced download still backs up.

- The timestamp is the ISO time of the operation with `:` and `.` replaced by `-`, so a stamp looks like
  `2026-09-30T12-34-56-789Z`. Sorting the directories as strings sorts them by time.
- Each file inside keeps its own tracked name, so a file's previous revision is
  `backups/<profile>/<stamp>/<name>`.
- The download's result reports `previous files backed up to: <dir>`.
- A profile that had **none** of the tracked files locally has nothing to back up, so no directory is
  created and no path is reported. The plugin says so rather than naming a directory that does not
  exist: the rollback error ends with `Nothing of this profile existed locally before the download, so
  there is nothing else to recover.`
- Only files that existed at that moment are in the stamp. `gist_download` does not delete tracked files
  the gist does not carry — those are reported as `kept locally` instead — so no delete needs a backup.

To restore by hand, copy the file out of the stamp you want and put it back into the profile directory.
The bytes are exactly what the download read before it wrote.

`gist_upload` is the other direction and keeps no backup:

- A file removed from the gist because it is no longer in `profileFiles` is gone from GitHub with no copy
  taken. The result lists it under `removed from the gist (no longer tracked)`.
- A tracked file that is missing locally is refused rather than uploaded-and-deleted, so the gist copy
  survives. `force: true` overrides that, and the removed names are listed under
  `DELETED from the gist because force was set, though they are still tracked`.

## The staging directory

A download never writes a tracked file directly. It writes the new content into a staging directory
inside the profile it is writing to, measures every staged file against the bytes it meant to write, and
only then renames each file into place — one rename per file, which is either the old content or the new
one. The staging directory is named

```
<profile>/.dsh-gist-settings-staging-<pid>-<base36 time>
```

and it is removed by the download's own `finally` on every path that created it: a successful commit, a
failed commit, and a rollback. A call aborted between the backup and the first write leaves no staging
directory at all, because nothing had been staged yet.

If the process is killed mid-download, one can be left behind. A leftover is inert:

- it is a dot-directory inside the profile, and `listProfiles` skips dot-directories, so it is never
  listed as a profile and no bulk operation considers it;
- an upload sends only the names in `profileFiles`, never the directory;
- the next download derives its name from its own pid and clock, so it neither reuses a leftover nor
  trips over it.

Deleting one by hand is safe. It contains only staged copies of content that either landed in the
profile already or is still in the gist.

The rollback writes its restore copies into the same staging directory, under
`.dsh-gist-settings-restore-<pid>-<token>`, and they go away with it. They are deliberately not written
into a fixed subdirectory such as `rollback`: a profile may track a file by that name, and its staged
copy would already occupy that path.

## The state file

`<stateDir>/state.json` maps each tracked profile to its gist and records the baseline the status
classifier compares against. One record per profile:

| Field | Meaning |
| --- | --- |
| `gistId` | The gist this profile is backed up to. The only field the code requires. |
| `gistUrl` | The URL reported by the tools. |
| `description` | The gist's description, defaulting to `DeepSeek Harness profile config: <name>`. |
| `files` | Informational: the tracked file names the last write saw. |
| `lastSyncedHash` | The baseline: the content hash of the last revision both sides agreed on. |
| `lastSyncAt` | When that happened, as an ISO timestamp. |
| `lastDirection` | `upload` or `download`. |

The tracked set itself is **never** read from this file: it always comes from `profileFiles`. A record
whose `files` list has drifted from the configuration therefore cannot change what is read or written.

The file also carries a `version` field, which `STATE_VERSION` in `lib/core.ts` currently defines as `1`.
`saveState` writes the file atomically: content goes to a per-writer temp file, the current file is
copied to `state.json.bak`, and the temp file is renamed into place. A failed write removes its temp
file, so no half-written `.tmp` file is left behind.

### When it is missing

A missing `state.json` is not an error: it is read as `{ version: 1, profiles: {} }`. Every profile whose
tracked files are on disk then reports `not tracked`, and an upload creates a new gist. That is the
honest reading of "this machine has no record", and it is why deleting the state directory loses the
mapping: the gists stay on GitHub, but the next upload for a profile whose record is gone mints a
**second** gist instead of updating the first one. The
[uninstall section](../../../README.md#uninstall) says the same thing from the other side.

### When it is malformed

The file is validated on every read, and a bad one stops every tool: all four call `loadState`, so a
malformed file fails `gist_status` as readily as an upload. Nothing repairs or rewrites it, and the
error names the problem exactly:

| The file | The error |
| --- | --- |
| is not JSON | `<path> is not valid JSON, so no profile can be resolved. Fix or move it aside; the gists it named still exist on GitHub.` |
| has a `profiles` value that is an array, `null`, or not an object | `<path> has an invalid "profiles" section; expected an object keyed by profile name.` |
| has a record that is not an object | `<path>: record for profile "<name>" is not an object.` |
| has a `gistId` that is not an alphanumeric id | `<path>: profile "<name>" has an invalid gistId "<value>"; expected an alphanumeric gist id.` |

The `gistId` is validated because it is interpolated into a `gh api` endpoint; alphanumerics with inner
hyphens are accepted, which covers every real gist id. A leading hyphen, a separator or a `..` is
refused before it is ever sent to `gh`.

One case is silent rather than an error: a record with no `gistId` at all is dropped while the file is
read. The profile then reads as `not tracked`, and the next upload mints a second gist. A hand-edit must
therefore keep a valid `gistId`.

**To recover from a malformed file:** repair it by hand, or move it aside and copy `state.json.bak` over
it. Repairing by hand is the safer of the two, because the backup is best-effort rather than guaranteed:
`saveState` copies the previous revision to `state.json.bak` before it replaces the file, but a copy that
fails is swallowed, so the backup can be missing entirely or older than the revision you are replacing.
Look at it before you use it — its timestamp, and the profile names and `gistId`s inside it — and keep
the current file's records if the backup names fewer gists than you expect. Restoring an older revision
loses the records it does not have, and the next upload of a profile with no recorded `gistId` mints a
second gist. Then run `gist_status` to see what the plugin now believes. Either route is safe with
respect to GitHub: the gists the file named are untouched, and their URLs are in the file itself and in
the tool output that created them.

A state **write** that fails is reported differently, because the work it was recording has already
happened:

- After a successful upload: `the gist <url> was created for profile "<name>", but recording it in
  <statePath> failed (<reason>). The gist exists; make the state directory writable before retrying, or
  the next upload will create a second one.` The word is `updated` rather than `created` when the gist
  already existed.
- After a successful download: `profile "<name>" was restored from <url>, but recording the new baseline
  in <statePath> failed (<reason>). The files are in place; gist_status repairs a stale baseline once
  that directory is writable again.`

So neither is data loss, and neither needs a manual fix beyond making the directory writable again. The
stale baseline a failed download leaves behind is repaired by the next `gist_status`, which is also what
keeps a profile whose two sides already match from reporting a false divergence after an edit made on
another machine.

## What `force` overrides — and what it never does

`force` is not a synonym for "do not check". It overrides a specific decision per tool, and nothing else.

| Call | `force: true` overrides |
| --- | --- |
| `gist_upload` | The refusal to upload when a tracked file is missing locally but still present in the gist. Those files are then deleted from the gist, and the result lists them under the `DELETED from the gist because force was set` line. |
| `gist_download` | The three refusals that protect unsynced local content: no recorded baseline while the two sides differ, a true divergence, and local edits that were never uploaded. A backup is still taken first. |
| `gist_sync` | A divergence, resolved by uploading the local files (the action is `forced-upload`). On a `missing-local` profile it is passed to the download, so a restore that would otherwise be refused for discarding unsynced edits goes through. |

What `force` never overrides:

- **Containment.** A tracked name that resolves outside its profile, a profile directory that is a link
  out of `profilesDir`, a tracked file linked into a sibling profile, or two tracked names that resolve
  to one file are all refused before anything is staged or written, forced or not.
- **The tracked-name rules.** `profileFiles` still has to be plain single names; `force` does not make a
  separator, a `..`, a drive letter or a reserved character acceptable.
- **Exact profile names.** A name that differs only in case from a tracked one is refused, so one
  directory cannot acquire two gists.
- **An unreachable gist.** An upload and a sync both refuse to mint a replacement for a gist that could
  not be read for any reason other than a genuine `HTTP 404`. Only the 404 is a deletion.
- **A download with nothing to restore.** A profile that is not tracked yet, or whose gist holds none of
  the tracked files, is refused with the action to take instead — `force` does not invent content.
- **The backup.** A forced download still copies the existing files to a backup stamp first.
- **Local files during an upload.** `gist_upload` never modifies a local file, with or without `force`.
- **Argument validation.** `force: "false"` is a type error rather than a forced call; every argument is
  checked and never coerced.

## The state lock

`<stateDir>/state.lock` serialises read-modify-write cycles over `state.json` across processes. The file
holds one line: `<pid> <hostname>`. An in-process queue serialises calls inside one host as well, so two
tool calls issued in parallel queue instead of losing each other's profile records.

How a waiter judges a lock it did not get:

| The lock file | Judgement |
| --- | --- |
| names this host, and that pid is alive | Wait. The lock is live. |
| names this host, and that pid is gone | Stale. It is reclaimed at once, so a crash does not block the next call. |
| names another host, or has no readable pid | Age. It is stale once its modification time is more than 60 seconds old; the holder refreshes that time every 20 seconds while it works. |

A waiter polls every 100 ms and gives up after 150 000 ms, which is sized to outlast one profile's
slowest operation. The timeout error names the holder:

```
timed out after 150000 ms waiting for <stateDir>/state.lock, held by pid <pid> on <host>.
Another DeepSeek Harness process is writing the same state directory. Retry once it finishes, or
delete that file if no such process is running.
```

The holder is named as `an unknown process` when the lock file could not be read, and the host is left
out when it did not record one.

Reclaiming a stale lock is ownership-safe rather than a delete: the reclaimer creates a token file
(`state.lock.reclaim`) that only one process can create, re-reads the lock under that token, and removes
it only if it is still stale. The exclusive create of the lock is the final arbiter. Releasing it removes
the file only if it still names this process, and `saveState` re-checks the ownership immediately before
every write — so a lock taken over mid-operation produces an error, never a silently older state file:

```
state lock <stateDir>/state.lock is no longer held by this process, so another writer may be
recording a newer revision. Refusing to overwrite it with this one.
```

A call chain that takes the lock twice is refused rather than deadlocked, with
`withStateLock is not reentrant: a lock is already held in this call chain...`.

### When the lock looks stuck

1. Read `<stateDir>/state.lock`. It names a pid and a hostname.
2. If the hostname is this machine and that pid is still running, another Harness host is writing the
   same state directory. Let it finish; a call waits up to 150 seconds on its own. Do not delete the
   lock: the other process is making progress, and `saveState` will refuse its next write if its lock
   disappears mid-operation.
3. If the hostname is another machine, the lock is held by a process this one cannot inspect. It is kept
   only while it is refreshed; a lock older than 60 seconds is reclaimed automatically. Deleting a fresh
   one lets two hosts write `state.json` at once.
4. If no such process is running and the lock file is still there, delete it, which is what the timeout
   error advises. A same-host lock whose pid is gone is reclaimed on its own, so a file that survives
   names a live pid on this machine, a pid that has since been reused by an unrelated process, or another
   host — check the hostname before you delete.
5. A leftover `state.lock.reclaim` needs no attention: it is a token whose critical section is three
   filesystem calls, and one older than a few seconds is treated as abandoned and taken over by the next
   reclaimer.

## Recovering from a failed download

The commit is all-or-nothing, and the rollback is deliberately narrow. Read the error; it names what
happened, file by file. Each of these sentences is a distinct outcome:

| In the error | What it means |
| --- | --- |
| `The tracked files were put back exactly as they were.` | The rollback restored everything this transaction wrote. |
| `Could not verify <name> (<reason>) — those were left untouched...` | The file could not be read back, so the rollback would not guess. It is exactly as it is. |
| `Could NOT restore <name> (<reason>) — those are at the new revision.` | The rollback could not put this one back. The backup is the recovery route. |
| `<name> changed after this download wrote them, so they were left alone rather than overwritten by a rollback.` | An edit landed after the download wrote the file. It exists in no backup, so it was preserved. |
| `The content from before this download is in <backupDir>.` | The stamp that holds the previous revision. |
| `Nothing of this profile existed locally before the download, so there is nothing else to recover.` | There was nothing to back up. |

Steps:

1. Run `gist_status`. A profile that rolled back reports the same state it did before the attempt; a
   profile whose files landed but whose state write failed reads `in sync`, because the status pass
   repairs the baseline once the state directory is writable again.
2. For every name the error says was **not restored**, or could **not be verified**, copy that file out
   of `<backupDir>` (the path is in the same error) and put it back into the profile directory.
3. Re-run `gist_download`. The likely causes — a permission problem, a full disk, a file another process
   holds open on Windows — are usually transient, and the second attempt stages and measures again
   before it touches anything.

There is one file the plugin will not put back for you: one that **changed after this download wrote
it**. That revision is not in the backup, because the backup was taken before the download started.
Recover it from the editor or process that wrote it; the plugin will not overwrite it on a guess.

## A profile diverged

Both sides changed since the recorded baseline: the local files and the gist both differ from
`lastSyncedHash`. Nothing is guessed, and a plain `gist_sync` refuses:

```
profile "<name>" has diverged: local and gist both changed since the last sync. Choose upload or
download explicitly, or re-run with force.
```

Choose a direction. Both are deliberate acts:

1. Run `gist_status` and note the gist URL and the `status:` line for the profile. Only tracked files are
   compared, so a file someone added to the gist by hand cannot be the cause of a divergence.
2. **Local copy wins:** run `gist_upload` for that profile. A divergence alone does not need `force` —
   the upload pushes what is on disk. If it also refuses because a tracked file is missing locally, that
   is a separate decision; see [a tracked file was deleted locally](#a-tracked-file-was-deleted-locally).
3. **Gist wins:** run `gist_download` with `force: true`. The local edits are discarded, and the previous
   local revision is in the backup stamp the result reports.
4. **One call, local wins:** `gist_sync` with `force: true` resolves the divergence by uploading and
   reports the action `forced-upload`.
5. Confirm with `gist_status`; the profile should read `in sync`.

A profile that says `in sync` is never in this state, whatever the baseline says: when both sides agree
and the recorded baseline is merely stale — an edit made and uploaded on another machine, or a failed
state write — the status call repairs the baseline instead of reporting a divergence.

## The gist was deleted on GitHub

`gist_status` reports `gist deleted - the next upload recreates it`. That verdict is reserved for a
genuine `HTTP 404`: a 401, a 5xx, a rate limit or a DNS failure is `unreachable` and is **not** a
deletion, because minting a replacement for a gist that still exists would abandon the original backup.

Steps:

1. Run `gist_upload` for that profile, or `gist_sync`, which recreates it in the same call (action
   `created`).
2. The result names the URL that could not be read:
   `REPLACED a gist that could not be read; the previous one was <url>`. The new gist is secret and
   holds the profile's tracked files, and the state record is rewritten to point at it.
3. Nothing recovers the deleted gist's content, because GitHub no longer has it. The local files are the
   source of the new gist.
4. If the profile directory was deleted too, there is no local source left: the upload fails with
   `profile "<name>" has none of the tracked files in <dir>` rather than creating an empty gist. Once the
   gist is gone as well, the only local copies are the download backups under
   `<stateDir>/backups/<profile>/`, for whichever downloads ran for that profile.

## The profile directory was deleted

This is the case the tools exist for, and the reason they work from the state file rather than from a
directory listing. A profile whose directory is gone is still resolved:

- `gist_status` lists it, reading `tracked files missing locally - run gist_download to restore`.
- `gist_download` recreates the directory and writes the tracked files from the gist. Name the profile,
  or omit it: a bulk download covers every profile with a recorded gist.
- `gist_sync` does the same in one call (action `downloaded`).
- A **bulk** `gist_upload` cannot send what is not on disk, so it names the profile instead of skipping
  it silently: `<name>: NOT uploaded - no profile directory on this machine. Run gist_download to
  restore it from its gist.` An upload that names the profile explicitly fails with
  `profile "<name>" has none of the tracked files in <dir>`.

The profile name must be the exact one the state file tracks — that is what the name check accepts for a
directory that is not on disk, and it still refuses a case-only variant. The profile's parent directory
may be missing as well; the resolved path is reassembled, so `profiles/<name>` is recreated.

## A tracked file was deleted locally

`gist_status` reports `tracked files missing locally - run gist_download to restore`, and the `absent:`
line names the files. The gist still has them, so nothing has to be guessed:

1. Run `gist_download` — no `force` is needed, because restoring a file that is simply absent locally
   discards nothing. `gist_sync` also restores it, in the same call that settles the profile.
2. If the download refuses because other local files hold unsynced edits, that refusal is about those
   files: upload them first, or re-run with `force: true`, which backs up before it writes.
3. An upload refuses while a tracked file is missing locally, because the gist may hold the only
   remaining copy: `refusing to upload "<name>": <files> are missing locally but still present in the
   gist, so uploading would delete the only remaining copy. Run gist_download to restore them, or pass
   force to drop them from the gist too.`
4. If the file should stay gone, say so deliberately: `gist_upload` with `force: true` deletes it from
   the gist and reports it under `DELETED from the gist because force was set, though they are still
   tracked`. There is no flag that applies a remote deletion to the local copy, and a deletion is never
   propagated in either direction on its own.

## A lock was left behind by a dead process

Nothing is needed in the common case. A lock file whose pid is gone is reclaimed immediately, and the
next call proceeds and then removes it; this is pinned by a case that measures that the call does not
wait out the timeout. If a lock file persists:

- it names a live process on this machine, or
- it names another host, in which case it is reclaimed once it has gone 60 seconds without a heartbeat.

Follow [When the lock looks stuck](#when-the-lock-looks-stuck) above. Do not delete a lock that a live
process holds: the write it protects verifies the lock it is under, so the operation fails with the
lock-lost error instead of corrupting the state file — but the operation is lost either way.

## Related pages

- [`README.md`](../../../README.md#the-safety-model) — the safety model these behaviours implement.
- [Configuration](./configuration.md) — `stateDir`, `dshHome`, `profilesDir` and `profileFiles`.
- [Tools](./tools.md) — the parameters, results and printed status vocabulary.
- [Troubleshooting](../troubleshooting/index.md) — the plugin not loading, `gh` missing, and the
  statuses that are not a recovery step.
- [`test/safety.test.ts`](../../../test/safety.test.ts) — the containment, atomic-write, forced-deletion,
  recovery and locking cases named above.