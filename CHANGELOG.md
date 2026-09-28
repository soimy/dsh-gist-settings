# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`CHANGELOG.md` is validated by `npm run changelog:check`, which runs as part of `npm test`. See
[CONTRIBUTING.md](CONTRIBUTING.md#changelog) for the convention.

## [Unreleased]

Defects found by a re-review of the fixes below
([issue #1](https://github.com/soimy/dsh-gist-settings/issues/1)), and then by a second adversarial
pass over those fixes themselves. Most are pinned by `test/safety.test.mjs`; the truncated-content
cases live in `test/regression.test.mjs`, and the ones that can only be settled against real GitHub are
in `test/live.test.mjs`. Every one of them fails if its fix is reverted.

### Added

- **Continuous integration.** `npm test` now runs on Linux, Windows and macOS at Node 20.x, 22.x and
  24.x, plus one leg on 20.3.0 — the floor `engines` names. The platform matrix is not decoration: the
  containment checks take a different path per OS (junctions and reserved device names on Windows,
  Unicode normalisation on macOS, rename-over-a-file semantics everywhere), so a green Linux run says
  nothing about what a Windows user gets. No install step is needed, because the package has no
  dependencies and no lockfile; `fail-fast` is off so one platform's failure does not hide the others.
  The live suite stays out of CI on purpose: it writes to a real GitHub account. A second job installs
  the Harness version `peerDependencies` names and runs the schema suite against its real validators,
  which no runner has by default; the matrix opts into that suite's explicit skip instead, so the skip
  appears in the log rather than passing silently.
- **A documentation check**, `npm run docs:check`, now part of `npm test`: it resolves every relative
  link in every Markdown file, refuses one that points outside the repository, and requires the two
  READMEs to link to each other. The rule that they stay in step was documented but unchecked.
- **A release workflow.** `CONTRIBUTING.md` told a maintainer that pushing a `vX.Y.Z` tag generates the
  GitHub release from the changelog section, and nothing did. `.github/workflows/release.yml` now
  re-runs `npm test` on the tagged commit and publishes that version's section as the release notes.
  `npm run release:notes -- vX.Y.Z` previews them, and refuses a tag that disagrees with `package.json`,
  a version with no dated changelog section, and an empty one — writing nothing to stdout when it
  refuses, so a failed run cannot publish a release with no notes.
- **`npm run test:release`**, six cases for the release-notes script: the success path, and every way it
  is meant to refuse a tag. It is the one script here that normally first runs on a tag push, which is
  the worst moment to discover it accepts the wrong thing, so its refusals are checked on every push.

### Fixed

- **The release job could not have published anything.** It ran `npm test`, which includes
  `test/schema.test.mjs` — and that suite fails, by design, when it cannot find an installed Harness.
  The matrix gets away with it by opting into the skip and letting a separate job run the contract; the
  release job had neither, so the first `v*` tag anybody pushed would have died in `npm test` before it
  generated the notes. Both jobs now install the Harness through one shared composite action, so the
  release job runs the schema contract for real rather than taking the matrix's skip.
- **The test double could truncate its own output.** `test/fake-gh.mjs` wrote a body and then called
  `process.exit(0)`, and exit does not wait for a write to a pipe. This double answers `GET /gists/<id>`
  and a raw URL with the whole payload — hundreds of kilobytes for the suites that track a few hundred
  files, and 1.5 MB for the live truncation case, both well past the 64 KiB pipe buffer — so the body
  arrived cut short now and then, which core reported as `gh returned non-JSON output` and which read
  like a defect in the plugin. Those paths now wait for the write to drain before exiting, which also
  required them to be awaited: `process.exit()` never returns, so a replacement that does would let the
  request handling run on and answer a second time.
- **The documentation check both missed links and failed on good ones.** Destinations wrapped in angle
  brackets (`[x](<a b.md>)`) were truncated at the space, so a link to nothing passed unchecked, and
  destinations containing balanced parentheses (`[x](a(1).md)`) were cut at the first `)`, so a link to a
  file that exists failed `npm test`. Containment was also compared against the spelled path, so a link
  through a symlink inside the repository reached a file outside it and satisfied the rule that says it
  cannot. Destinations are now scanned rather than matched, and containment compares real paths.
- **The release-notes script accepted an empty section.** When the tagged version was the last section in
  the file, extraction ran on into the link definitions below it, so a section with no entries of its own
  looked non-empty and those definitions would have been published as the release notes.
- **`engines` claimed Node 20.0.0; the code needs 20.3.0.** `AbortSignal.any`, which puts one deadline
  on the `fetch` that reads truncated gist content, arrived in 20.3. On 20.0–20.2 the plugin therefore
  loaded and then failed the first time it read a file above the API's truncation threshold. The floor
  is now 20.3.0, both READMEs say so, and CI runs a leg on 20.3.0 itself, so the claim is tested rather
  than asserted.
- **A tracked file named `rollback` could abort the whole rollback.** The restore copies went into a fixed
  `rollback` subdirectory of the staging directory, so a profile tracking a file by that name — one not
  yet committed, whose staged copy still occupied the path — made creating that directory throw. Every
  restore was skipped, the download was left half applied, and the thrown `EEXIST` *replaced* the error
  that explains the download, so the backup location and the rollback outcome were lost too. Restores are
  now written beside the staged files under a per-call random token: no naming decision a profile can
  influence, and no setup step whose failure can pre-empt the report.
- **A read failure during rollback was reported as somebody else's edit.** `readFile(...).catch(() =>
  null)` collapsed every read error — `EISDIR`, `EPERM`, `EBUSY`, `EMFILE` — into "the content differs",
  so the file was skipped and the message blamed an edit that may never have happened. A failed read is
  not evidence of an edit: it means the transaction cannot prove the target is still its own revision,
  and the answer is to leave the bytes alone and say so. Unreadable targets are now reported as
  *unverified*, separately from *changed*, and — deliberately — are not restored. Restoring on a guess is
  the one outcome that can destroy data no backup holds.
- **Stale-lock takeover could still act on a lock it had not inspected.** Replacing the `rm` with a
  rename was not enough: both act on the path, so a waiter whose decision was delayed by a loaded
  machine could move or delete a lock another waiter had already taken. Removal now happens under a
  reclaim token only one process can create, and the lock is re-read *and re-checked for staleness*
  under that token — while it is held nothing else can remove the lock (that needs the token) and
  nothing else can create one (the path is occupied). The token's own critical section is three
  filesystem calls with no I/O, so an abandoned token is taken over after a few seconds, and even then a
  reclaimer removes the lock only if the re-read still says stale. On top of that, `saveState` now proves
  it still holds the lock immediately before every write, which closes every way the lock could have been
  displaced — from the side that would corrupt the file.
- **A rollback could destroy an edit made after the download wrote the file.** For a file the download
  created, the rollback deleted whatever was at that path; for one it replaced, it renamed the
  pre-download bytes over it. Neither checked that the target still held *this transaction's* revision,
  so an editor's change — which is in no backup the plugin took — was destroyed. Content is now compared
  before anything is undone: a target that has changed is left exactly as it is and named in the error
  alongside the backup directory. (Content rather than file identity, because an editor usually writes in
  place: the inode is unchanged while the bytes are not.)
- **An upload of one named profile reported every other profile as missing.** The list of profiles to
  name as "no directory on this machine" was computed from every known profile rather than from the
  selection, so `gist_upload(profile: "alpha")` claimed `beta` had no directory when `beta` simply was
  not selected. That list is now empty for a single-profile upload, and a tool-layer case pins it.
- **Windows device names were accepted as tracked names.** `NUL`, `nul.txt`, `COM1.yml` and friends passed
  validation. Node reaches them through verbatim paths and treats them as ordinary files — that is not
  the failure, and I could not reproduce one — but the name means a device to every other program that
  touches the profile directory, and a tracked name has to mean one thing everywhere. They are refused.
- **Nested tracked names were advertised and cannot work.** A gist is a flat collection of files, and
  GitHub answers a filename containing a slash with `HTTP 422 Validation Failed` — verified against the
  real API, and now pinned by `test/live.test.mjs`. So `profileFiles: ['config/app.yml']` did not merely
  have rough edges: the first upload of such a configuration failed outright, and only the fake-gh
  suites ever exercised it. A tracked name must now be a single name, with no separator, and the
  local-path machinery that existed only for nesting — staging subdirectories, creating missing parents,
  ancestor/descendant conflict detection — went with it. A backslash is refused too: it is legal in a
  gist filename but separates paths on Windows, so accepting it would mean one name for the file and
  another for the gist. The live suite fails if the API ever changes its mind, so this can be revisited
  rather than staying quietly wrong.
- **Reclaiming a stale lock could delete a live one.** Two waiters could both read the same abandoned
  lock; the first would remove it, write its own and enter the critical section, and the second's
  removal then deleted a lock that was by then live, after which both proceeded believing they held it —
  reopening the lost-update and duplicate-gist failures the lock exists to prevent. Takeover now *moves*
  the stale file aside with an atomic rename, which only one waiter can win; the loser goes back to
  competing for the exclusive create, the one operation that grants the lock. Pinned by a case that races
  three waiters against one stale lock.
- **The stale-baseline repair could move the baseline backwards.** A status call computed the local and
  remote hashes before taking the state lock, and then wrote the baseline it had observed. If another
  writer advanced the record in between — uploading a newer revision and recording its hash — the repair
  overwrote the newer baseline with the older one, and the next ordinary edit looked like a divergence.
  The write is now a compare-and-set on the gist id and the baseline this call actually observed, and is
  skipped when the record has moved.
- **Tracked-file paths could still leave the profile directory.** Containment covered
  `profiles/<name>` but not the files inside it, so a `profileFiles` entry of
  `../../some-secret-file` — or a tracked file that was itself a link out of the tree, or that sat
  under a linked subdirectory — was read and published by an upload and overwritten by a download.
  Every name is now validated as a plain relative path, and every segment of its resolved path is
  checked. A tracked name is a single name with no separator and no `..`.
- **Containment held at the wrong boundary.** A tracked file was checked against the profiles
  directory rather than the profile's own, so a junction pointing at a *sibling* profile let one
  profile's gist publish another profile's config and then overwrite it, breaking the
  one-gist-per-profile invariant. The boundary is now the profile directory, and the check is repeated
  immediately before each write instead of once per operation.
- **A download could write a file under a directory's name.** Resolving a path whose parent
  directory did not exist returned the shortened path, so restoring a nested tracked file into a
  profile without its parent wrote the content into a *file* named after the directory, reported
  success, and left the profile unable to converge. The resolver now returns the whole path, never a
  prefix of it. (Nested names themselves turned out to be unsupported by the API — see above.)
- **A path could be swapped for a link between the check and the write.** Targets were resolved once,
  then written after a staging phase whose length is proportional to the payload; a directory replaced
  by a junction in that window redirected the write out of the tree. Each target is re-resolved
  immediately before its rename, and the rollback re-resolves too, so a restore cannot be redirected
  either.
- **A symlinked profiles directory disabled disaster recovery.** When `~/.dsh` is a junction to another
  drive, a deleted profile directory resolved to a lexical path that looked like an escape, so
  status, sync and download all refused. The nearest existing ancestor is now resolved and the missing
  tail appended.
- **A failed download could leave the profile at a revision that existed nowhere.** Files were written
  one at a time, so a failure after the first left a mixture of old and new content. Content is now
  staged inside the profile directory and measured before anything tracked is touched, then renamed
  into place one file at a time, and a failure puts the already-replaced files back.
- **`gist_upload(force: true)` did not perform the deletion it documented.** The flag suppressed the
  refusal and then left the gist's copy exactly where it was. It now removes those files too, and the
  result names them so the two deletion cases are never confused.
- **A profile whose directory had been deleted outright was invisible** to bulk status, download and
  sync, because the candidate list came from the directory listing alone — which is precisely the
  disaster-recovery case those operations exist for. Bulk operations now also consider the profiles the
  state file still tracks, and `gist_upload`, which cannot upload a directory that is gone, names such
  a profile in its result instead of dropping it silently.
- **One `gist_sync` did not converge after a remote deletion.** A tracked file deleted from the gist is
  still never deleted locally, but sync now puts the local copy back into the gist in the same call.
  A gist that lost *every* tracked file is republished rather than reported as unreadable, and
  `force` now reaches the restore that the refusal message tells the caller to re-run with.
- **The state lock was process-local**, so two Harness hosts sharing a `stateDir` could each drop the
  other's record — untracking a profile and orphaning its gist — or mint two gists for one profile. A
  lock file now names the owning pid; a lock whose owner has exited is reclaimed at once; a lock
  written by another machine is judged by age and kept fresh by a heartbeat; and releasing a lock
  removes it only if it is still the one this process took.
- **Truncated gist content was fetched with `gh api <raw_url>`.** That command is documented as taking
  an API endpoint, and it would carry the caller's token to a host gh was never configured for. The
  URL is now fetched directly, after the host check and again after any redirect, with a timeout and a
  size cap — and a *transport* failure falls back to the request gh would have made, because Node's
  `fetch` does not honour `HTTP(S)_PROXY` or the platform certificate store the way gh does.
- **Truncation was resolved for every file in the gist**, so a large file the user never tracks could
  cost a request on every status call, and a failed fetch for it made the whole profile look
  unreachable. Only tracked files have their content resolved now; pruning still sees every name.
- **Two tracked names that fold to one file were accepted**, so both staged to a single path and the
  second rename always failed — the profile could never be downloaded. A set that folds under the
  platform's rules is now refused, as a case-only profile-name variant already was. The Unicode part of
  that check applies only where the filesystem normalises: NTFS stores names verbatim, so there the two
  spellings are two real files and refusing them would be a false refusal.
- **Two tracked names that *denote* one file were still accepted.** Folding the name catches two
  spellings, not two paths: a hard link, or a Windows 8.3 short name, makes both entries name one file,
  so the second silently discarded the first while the result claimed both had been written. Write
  targets are now identified by file id, or by resolved parent plus name when the file does not exist
  yet, and a collision is refused before anything is staged.
- **The post-redirect host check was skipped whenever a response reported no final URL**, which is a
  shape a response stub has by default. The final URL is now required: a response that cannot be shown
  to have stayed on a GitHub host is refused.
- **An aborted caller was treated as a transport failure** and retried through `gh`, so a cancelled
  call started a second request and surfaced as "gh exited with code 1". An aborted signal now
  propagates.
- **A failed state write on the upload path** now distinguishes "the gist was updated" from "nothing
  happened", the way the download path already did.
- **A failed state write after a successful download reported a lost download** and left a temp file
  behind. The files are in place and the error says so, the temp file is removed with the failure, and
  a state write that fails after an upload says the gist exists rather than implying it does not.
- **`gist_status` advised `gh auth login` when `gh` was not installed**, because a missing `gh` left no
  auth state to report. It now says auth was not checked.
- A tracked file whose parent was a regular file surfaced a bare `ENOTDIR` instead of being reported
  as absent, which hid the real cause from the error the user eventually saw.

### Added

- `test/safety.test.mjs` — the guarantees the README makes: containment for the profile and for every
  tracked file, an all-or-nothing download, `force` doing what it says, recovery of a profile whose
  directory is gone, one-sync convergence, and cross-process state locking. It also covers a download
  into a two-level deleted tree, the directories a failed commit has to take back, a home directory
  reached through a junction, a parameter set whose names collide on one file, and a state write that
  fails after the files are already in place.
- `test/regression.test.mjs` covers a gh that exits 0 while logged out, and four lookalike `raw_url`
  hosts where a loosened or decode-then-fetch check would have followed an attacker's URL.
- The live suite now covers a file above the API's 1 MB truncation threshold.

## [0.1.0] - 2026-09-27

The first release. Nothing has been tagged before it, so the whole history is here.

### Added

- **Sync engine** (`lib/core.js`) — no Cordis dependency, so it is testable on its own. Discovers
  `gh`, scans profiles under `DSH_HOME`, hashes tracked content, and performs gist create/read/patch
  through `gh api` so no interactive editor is ever launched.
- **Host plugin and four agent tools** — `gist_status`, `gist_upload`, `gist_download`, `gist_sync`.
  Tool definitions are hand-written plain objects matching the shape `defineTool` produces, so the
  bundle imports nothing from the Harness installation.
- **A guarded two-way sync** — a content hash recorded at the last agreed revision distinguishes
  "only local changed" from "only the gist changed" from a true divergence, and refuses to guess at
  the last of those.
- **Backups before destructive writes**, under `<stateDir>/backups/<profile>/<timestamp>/`.
- **Bundle metadata** — `icon.svg` and `locale/{en,zh}.json` display metadata for Plugin Manager cards.
- **Documentation** — English and Chinese READMEs, a contributing guide, and issue and pull-request
  templates.
- **Test suite** — 116 offline cases across four suites plus 10 opt-in live cases against real
  GitHub, including `test/fake-gh.mjs`, an in-memory stand-in for the `gh` CLI.

### Fixed

Defects found by an adversarial review of the repository (independent correctness, security,
integration, mutation-testing and documentation audits). Each fix is pinned by a case in
`test/regression.test.mjs` that fails if the fix is reverted.

- A `gh` process that exited before draining a request body larger than the 64 KiB pipe buffer raised
  an unhandled `error` on `child.stdin` and **killed the whole Harness process**. It now resolves
  with a failure code.
- Every gist read failure was read as "the gist was deleted", because `gh` reports a 404 and an
  expired token identically. A 5xx, a rate limit or a DNS failure silently minted a replacement gist
  and abandoned the original. Only a genuine `HTTP 404` may now mean the gist is gone; anything else
  is reported as unreachable and both upload and sync refuse.
- Upload pruned remote files that were absent from **disk** rather than absent from the **tracked
  set**, so a tracked file that had merely gone missing locally was deleted from the gist — the only
  remaining copy — and the profile then reported `in sync`. Missing tracked files are now their own
  state, sync restores them, and an upload refuses without `force`.
- `profileStatus` hashed every remote file while the writers recorded a baseline over the tracked
  subset, so a gist holding one extra file reported `remote-ahead` forever and every sync
  "downloaded" without ever converging.
- A tracked file that went missing locally was classified `local-ahead`, and `gist_download`'s
  refusal message said "Upload first" — pointing the user straight at the destructive action.
- Tool arguments were not validated, because validation lives in `defineTool` and these definitions
  are hand-written. `Boolean("false")` is `true`, so `force: "false"` forced a destructive overwrite,
  and a misspelled `profile` widened a single-profile call to every profile.
- Profile containment was lexical only, so a junction at `profiles/<name>` made the tools read and
  write outside the profiles directory. It is now re-checked against `realpath`.
- A stale `in-sync` baseline turned the next ordinary edit into a false divergence.
- `state.json` was unvalidated and written without serialization, so concurrent calls could lose a
  record or orphan a gist.
- A `gist_status` for a profile with no local files and no gist was a dead end.
- The canonical tool value was the framework's `@internal` content-blocks-as-value test fixture,
  which PTC mode would project into a generated SDK as `list[Any]`. It is now a domain-owned DTO.
- Configuration was read without validation, so a typo silently changed which files were backed up.
  An unknown key is now rejected with the list of known keys.
- `dshHome` did not expand `~` or resolve relative paths, so `dshHome: '~/.dsh'` — the form the
  Harness itself displays — named a different tree rooted in the working directory.
- `exec.signal` was ignored, so a cancelled call still completed its write.
- `assertProfileName` accepted `node_modules`, which the framework reserves.
- A profile name differing only in case from a tracked one — `ALPHA` for `alpha` — created a second
  secret gist for the same directory, because Windows and macOS treat those as one path. Names are
  now matched exactly: a case-only variant is refused with the real name attached, an unknown name is
  refused with the list of known ones, and the write paths refuse to record a second entry differing
  only in case, so a direct caller of the engine is protected too.

[Unreleased]: https://github.com/soimy/dsh-gist-settings/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/soimy/dsh-gist-settings/releases/tag/v0.1.0