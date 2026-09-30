# Release process

This is the long form of the release steps in `CONTRIBUTING.md`: what belongs in `CHANGELOG.md`, what
reads it, how the version bump and the tag are prepared, what the release job re-runs before it
publishes anything, and every way `scripts/release-notes.ts` is built to refuse a tag. The short form
stays in [CONTRIBUTING.md](../../CONTRIBUTING.md#releases) — this page adds the file-by-file detail and the
commands, and does not repeat the issue and pull-request conventions.

## Where release notes live

[`CHANGELOG.md`](../../CHANGELOG.md) at the repository root is canonical. Two mechanisms read that exact
path, and neither of them reads a page under `docs/`:

- `scripts/check-changelog.ts` validates it, and runs as part of `npm test`.
- `.github/workflows/release.yml` extracts the tagged version's section from it and publishes that as
  the GitHub release body.

[the release index](../releases/index.md) indexes the same file rather than holding a second copy of the
notes; the placement rule is stated in [AGENTS.md](../../AGENTS.md), and the Markdown conventions are in
[documentation.md](documentation.md). A page under `docs/releases/` would be read by neither mechanism,
so it could drift from what a tag actually publishes.

Both scripts locate their inputs from their own directory, not from the working directory: each does
`fileURLToPath(new URL('..', import.meta.url))` and then joins `package.json` and `CHANGELOG.md` onto
it, so they read the same files whatever directory they are invoked from — and
[test/release.test.ts](../../test/release.test.ts) depends on exactly that, copying the script into a
temporary package (where `..` is that package) so it can drive each refusal without touching this one.

## What belongs in the changelog

`CHANGELOG.md` follows Keep a Changelog 1.1.0 and Semantic Versioning, and names both — with links — in
its header. The rules in [CONTRIBUTING.md](../../CONTRIBUTING.md#changelog) are:

- A user-visible change goes under `## [Unreleased]`, inside one of `### Added`, `### Changed`,
  `### Deprecated`, `### Removed`, `### Fixed` or `### Security`. Create the section if it is not
  there already.
- Write for someone deciding whether to upgrade, not as a diff summary: what changed for them, not
  which function moved.
- Internal changes with no user-visible effect need no entry. The `[Unreleased]` entries for the
  TypeScript migration were still written for a reader: one says outright that the engine's behaviour is
  unchanged and that nothing a user of the four tools can observe has changed.
- A released section is not rewritten to match later refactors. The `[Unreleased]` entry says the
  entries below keep the file names those versions had at the time, which is why `[0.2.0]` still talks
  about `test/safety.test.mjs` while the suites live in `.ts` files.
- A change to what gets uploaded or deleted, or to the meaning of the state file, is breaking even
  when the API looks the same.

None of that is machine-checked. `check-changelog.ts` reads only `##` headings; it never looks at the
`###` sections, at their names, or at what is written under them, and it does not object to an empty
released section. The six-section rule is enforced in review, and only the emptiness itself is caught
by the release job, at tag time — see "How release-notes.ts refuses a tag" below.

## What the changelog check enforces

`npm run changelog:check` runs `scripts/check-changelog.ts` on its own; `npm test` runs it as one of
its two repository checks. It reads `CHANGELOG.md` and `package.json`, collects every problem it finds
rather than stopping at the first, and exits 1 after printing a `CHANGELOG.md failed N checks:` banner
to stderr (singular when there is one problem) with each problem on its own `  - ` line. On success it
prints one line:

```
CHANGELOG.md OK: 2 released versions, newest 0.2.0 (2026-09-28), plus [Unreleased].
```

The checks, in the order the script makes them:

- An `## [Unreleased]` section exists, there is only one of them, it carries no date, and it is the
  first `##` heading in the file.
- Nothing follows a heading except an optional `- YYYY-MM-DD` date. Any other trailing text is
  reported as `unexpected text after the heading`.
- Every other heading is `MAJOR.MINOR.PATCH` — no `v` prefix, no pre-release suffix.
- Every released heading carries a date, the date matches `YYYY-MM-DD`, and `Date.parse` accepts it. The
  last part is weaker than it sounds: a day that does not exist in that month is rolled over rather than
  rejected, so `2026-02-31` passes, while a month outside 1–12 is reported as `not a real date`.
- Released versions sort strictly descending, newest first.
- `package.json`'s version has a heading of its own. This is what fails a version bump that was
  committed without a changelog section, and it is checked only when `package.json`'s version is a
  semver string.
- Every heading has a link definition at the bottom of the file, **and every link definition has a
  heading**. A footnote-style reference definition for anything other than a version will fail the
  second half of that rule.

## Preparing the release

The convention is one pull request that does three things, and nothing else:

1. Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and leave a fresh, empty, undated
   `## [Unreleased]` as the first heading.
2. Add both link definitions at the bottom — `[Unreleased]` and `[x.y.z]` — and move the
   `[Unreleased]` compare base to the new tag. `[Unreleased]` compares `vX.Y.Z...HEAD`; the released
   entry points at `.../releases/tag/vX.Y.Z`.
3. Set `"version"` in [`package.json`](../../package.json) to `x.y.z`.

`npm run changelog:check` fails until all three agree, which is the point: the checker ties the version,
the dated heading and the link definitions together, so a partial bump cannot pass `npm test`.

The 0.2.0 release is what this looks like in history. One commit, `chore: release 0.2.0`, on a branch
named `release/0.2.0`, touching only `CHANGELOG.md` and `package.json`: the `[Unreleased]` heading
became `## [0.2.0] - 2026-09-28`, a new `[Unreleased]` went above it, the compare base moved from
`v0.1.0` to `v0.2.0`, and a `[0.2.0]` link definition was added. `chore` is one of the prefixes in use
for commits here; the subject convention is in [CONTRIBUTING.md](../../CONTRIBUTING.md#commit-messages).

Before opening the pull request, run the two commands the release job will run, in the same order it
runs them:

```bash
npm test                          # pretest builds dist/, then eight suites and both repository checks
npm run release:notes -- vX.Y.Z   # preview the notes the tag would publish
```

`npm test` also covers `scripts/check-docs.ts`, so a new page under `docs/` whose relative links do not
resolve fails here rather than in the release job. The release notes preview is the second command
because it is the one that catches the common mistake — a tag whose version never merged.

## The tag

`.github/workflows/release.yml` has a single trigger, `on: push: tags: ['v*']`, and no
`workflow_dispatch`. The job is `Publish ${{ github.ref_name }}` on `ubuntu-latest`, with a 20-minute
timeout and workflow-level `permissions: contents: write`.

The tag does not have to be the release commit itself; it has to point at a tree where the bump and the
dated section are both present, which is exactly what `release-notes.ts` checks on the tagged commit.
(`v0.2.0` sits on a later merge than the release commit.)

The steps, in order:

1. `actions/checkout`, pinned to a commit SHA (v4.2.2), with `persist-credentials: false`. The job
   holds `contents: write` and then installs an external dependency tree with no lockfile to pin it, so
   the checkout token is deliberately not left in the local git config.
2. `actions/setup-node`, pinned to a commit SHA (v4.0.4), at **22.19.0** — the floor `engines` names,
   which is the Harness's own floor. It is also the Node version CI's `typecheck` and `schema` jobs use,
   so the release publishes from the same runtime those jobs prove.
3. `./.github/actions/install-harness`, with no `dsh-version` input, so it installs the
   `peerDependencies` declaration itself, resolves `@deepseek-ai/dsh-tools` from inside that
   installation, fails with an `::error::` line if `lib/types/json-schema.js` is not where it should be,
   and exports the resolved directory as `DSH_TOOLS_DIR`. Its `--include=dev` install is also where the
   release job's pinned TypeScript comes from: this job has no separate toolchain install step, and
   `npm test`'s `pretest` step needs `tsc` to build `dist/`.
4. `npm test` — the same command a contributor runs, on the tagged commit. Because a Harness is
   installed and `DSH_ALLOW_SCHEMA_SKIP` is not set, `test/schema.test.ts` runs the schema contract for
   real here instead of taking the skip the platform matrix opts into.
5. `npm run typecheck` — the whole repository, suites and scripts included. `npm test` compiles the
   runtime without checking the suites or the scripts, so without this step a tag could publish a commit
   that CI's own `typecheck` job rejects.
6. `node scripts/release-notes.ts "$GITHUB_REF_NAME" > "$RUNNER_TEMP/notes.md"` — the extraction
   described below.
7. Publish the release, with `GH_TOKEN` set from `github.token`:

   ```bash
   gh release create "$GITHUB_REF_NAME" \
     --title "$GITHUB_REF_NAME" \
     --notes-file "$RUNNER_TEMP/notes.md" \
     --verify-tag
   ```

   `--verify-tag` means the release cannot create a tag of its own, and the title is the tag name — the
   date lives in the notes themselves rather than in the release title.

The install action is shared with CI's `schema` job on purpose. One composite action means two
Harness-dependent jobs cannot drift into two different ways of getting a Harness, and the release job
must not inherit the matrix's visible skip. One declared dsh version is installed per leg in CI's
`schema` job matrix; the release job installs the declaration as a whole rather than one chosen entry.

## How release-notes.ts refuses a tag

`scripts/release-notes.ts` is the script behind `npm run release:notes -- vX.Y.Z` and step 6 above. It
prints the tagged section's body to stdout and every problem to stderr, and it exits 1 without writing
anything to stdout when it refuses. That stdout/stderr split is what makes the workflow's
`> "$RUNNER_TEMP/notes.md"` safe to pipe: a failed run leaves an empty file, and the old behaviour —
extraction running on into the link definitions below the last section, so a section with no entries of
its own looked non-empty — is pinned by a case in [test/release.test.ts](../../test/release.test.ts).

Every refusal it can produce:

| Condition | Reported problem | Pinned by a case |
|---|---|---|
| No argument | `no tag given; usage: node scripts/release-notes.ts v1.2.3` | yes, as the empty string in the malformed-tag case |
| Not `vMAJOR.MINOR.PATCH` (`1.0.0`, `v1.0`, `release-1.0.0`) | `"<tag>" is not a vMAJOR.MINOR.PATCH tag` | yes |
| A pre-release tag such as `v1.0.0-rc.1` | the same message; the pattern has no room for a suffix | yes, its own case |
| `package.json` missing or unparsable | `package.json is missing or is not valid JSON` | no |
| The tag's version differs from `package.json`'s | `the tag says X but package.json says Y; a release must ship the version the package claims, so bump it and merge that before tagging` | yes |
| `CHANGELOG.md` missing | `CHANGELOG.md is missing` | no |
| No `## [x.y.z]` heading carrying a date | `CHANGELOG.md has no dated "## [x.y.z] - YYYY-MM-DD" section; rename [Unreleased] to it before tagging` | yes |
| That section has no content of its own | `the [x.y.z] section of CHANGELOG.md is empty, so the release would have no notes` | yes |

Each problem is collected rather than thrown, so a run that is wrong in two ways reports both. The
banner is `Refusing to write release notes for <tag>:` (or `(no tag)`), each problem follows on its own
`  - ` line, and the exit code is 1. On success the body goes to stdout with a trailing newline, and one
status line goes to stderr: `release notes for <tag> (<date>), <N> lines`.

Details worth knowing before you rely on it:

- The heading pattern requires the date. `## [0.2.0]` with no ` - YYYY-MM-DD` does not match, and is
  reported as a missing section rather than as a missing date. The version must also appear bare: the
  script looks for `## [0.2.0]`, not `## [v0.2.0]`.
- The date is accepted as any non-space token by this script; the `YYYY-MM-DD` format and the
  "is it a real date" rule belong to `check-changelog.ts`, which the same job runs earlier as part of
  `npm test`.
- The section ends at the next `## [` heading or at the first link definition line, whichever comes
  first, so the definitions at the bottom of `CHANGELOG.md` can never be published as notes.
- The body keeps the section's `### Added` / `### Fixed` subheadings. Only the `## [x.y.z]` heading is
  dropped — it becomes the release title.
- Both the version comparison and the changelog-version check are skipped when `package.json` has no
  `version` string at all: `release-notes.ts` compares only when `pkg.version` is present, and
  `check-changelog.ts` looks for a heading only when that version is semver.
- The script does not verify that the tag exists or where it points. That is `--verify-tag`'s job in the
  publish step.
- The workflow's filter is `v*`, which is wider than the script accepts. A tag like `v1.0.0-rc.1` starts
  the job and then fails at the notes step, so a pre-release cannot be published through this path.

## Pre-tag checklist

Run from a clean checkout of the commit that will be tagged.

1. Every user-visible change since the last release has an entry under `## [Unreleased]`, in the right
   section, written for someone deciding whether to upgrade.
2. `## [Unreleased]` is renamed to `## [x.y.z] - YYYY-MM-DD`, and a fresh undated `## [Unreleased]` is
   the first heading.
3. Both link definitions exist at the bottom, exactly once each, and the `[Unreleased]` compare base has
   moved to the new tag.
4. `package.json` says `"version": "x.y.z"`.
5. `npm run changelog:check` — it should print the `CHANGELOG.md OK:` line naming the new version as the
   newest release.
6. `npm test` — the `pretest` build, the eight offline suites, and both repository checks. The live suite
   is not part of it and is not run by CI either; run `npm run test:live` separately only if the release
   touches the GitHub round trip.
7. `npm run release:notes -- vX.Y.Z` — read the output. It should be the section body: no `## [x.y.z]`
   heading, and none of the link definitions from the bottom of the file.
8. Commit as `chore: release X.Y.Z`, open the pull request, and merge it. The 0.2.0 release commit
   touched only `CHANGELOG.md` and `package.json`; a behaviour or configuration change belongs to the
   pull request that introduces it, where both READMEs have to be updated with it.
9. After the merge, tag the commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

10. Watch the Release workflow. It re-runs `npm test` and `npm run typecheck` on the tagged commit,
    regenerates the notes, and only then publishes. A failure before the publish step leaves no release
    behind at all: the notes step writes nothing to stdout when it refuses, and the publish step is the
    last one in the job, so the log of the failed step names the reason.

## Related pages

- [CONTRIBUTING.md](../../CONTRIBUTING.md#releases) — the short form of the release steps.
- [`CHANGELOG.md`](../../CHANGELOG.md) — the canonical notes, newest first.
- [the release index](../releases/index.md) — the index of published versions.
- [testing.md](testing.md) — what each suite proves, including `npm run test:release`.
- [`release.yml`](../../.github/workflows/release.yml) and
  [`install-harness/action.yml`](../../.github/actions/install-harness/action.yml) — the workflow and the
  shared install step.