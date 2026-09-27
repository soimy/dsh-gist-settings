# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`CHANGELOG.md` is validated by `npm run changelog:check`, which runs as part of `npm test`. See
[CONTRIBUTING.md](CONTRIBUTING.md#changelog) for the convention.

## [Unreleased]

Nothing yet.

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