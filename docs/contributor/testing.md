# Testing

This page is the long form of [What the test suites prove](../../CONTRIBUTING.md#what-the-test-suites-prove)
and [Continuous integration](../../CONTRIBUTING.md#continuous-integration): what each of the ten suites
does mechanically, which cases are load-bearing, and what runs where. The short table of counts and
one-line claims stays in `CONTRIBUTING.md`; this page is the version you read when a case fails and you
need to know whether it is your change or the platform.

## What `npm test` does, in order

`npm test` is a single `&&` chain, and its `pretest` step runs `npm run build` first, so a test run can
never exercise a stale `dist/`:

1. `npm run build` — `tsc -p tsconfig.json` (`pretest`).
2. `node test/entry.test.ts` — the boundary a profile crosses.
3. `node test/guards.test.ts` — the invariants nothing else can see.
4. `node test/sync.test.ts` — the engine lifecycle.
5. `node test/tools.test.ts` — the tool layer.
6. `node test/schema.test.ts` — the definitions against the installed Harness.
7. `node test/regression.test.ts` — the defects the adversarial reviews found.
8. `node test/safety.test.ts` — the guarantees the README makes.
9. `node test/release.test.ts` — the release-notes script.
10. `node test/docs.test.ts` — the documentation checker.
11. `node scripts/check-changelog.ts`.
12. `node scripts/check-docs.ts`.

The chain is the npm script itself, not `npm run test:*` wrappers, so each step is one `node` process
reading TypeScript from source. Because it is a chain, the first failing suite stops the run: a report
that only shows `test/sync.test.ts` failing means nothing after it ran. `test/entry.test.ts` and
`test/guards.test.ts` are the two suites that *borrow* the build rather than reading the sources, and
step 1 is why running the whole chain works from a clean checkout. `npm test` does **not** run
`npm run typecheck` — that is a separate command
locally and a separate CI job.

Nine of the ten suites are in the chain. The tenth, `test/live.test.ts`, is opt-in and never runs as
part of `npm test`.

## Running one suite

Every suite runs on its own, with no build step, because Node strips the types of any file outside
`node_modules` as it loads it:

```bash
node test/sync.test.ts
node test/safety.test.ts
npm run test:schema            # the npm aliases are thin wrappers around the same command
```

`test/entry.test.ts` and `test/guards.test.ts` are the exceptions: both read what the build emits, and
`npm run test:entry` and `npm run test:guards` therefore run `npm run build` before them. Running either
bare on a checkout with no `dist/` fails immediately and prints the two commands that produce one, rather
than reporting on an artifact that is not there. Every other suite runs against the sources with no build
step at all.

| Suite | Command | Cases | Mechanism in one line |
| --- | --- | --- | --- |
| [`test/entry.test.ts`](../../test/entry.test.ts) | `npm run test:entry` | 6 | Imports the package by name and compares the built entry against the sources. |
| [`test/guards.test.ts`](../../test/guards.test.ts) | `npm run test:guards` | 7 | Discovers the repository's whole `.ts` tree and asserts the invariants about it that no behavioural case can see. |
| [`test/sync.test.ts`](../../test/sync.test.ts) | `node test/sync.test.ts` | 19 | Drives the engine's whole lifecycle against the fake `gh`. |
| [`test/tools.test.ts`](../../test/tools.test.ts) | `node test/tools.test.ts` | 23 | Registers the four tools through a stub context and calls them. |
| [`test/schema.test.ts`](../../test/schema.test.ts) | `npm run test:schema` | 50 | Replays the Harness's own validators and the loader's compatibility gate. |
| [`test/regression.test.ts`](../../test/regression.test.ts) | `node test/regression.test.ts` | 32 | One case per defect a review found, each written to fail if the fix is reverted. |
| [`test/safety.test.ts`](../../test/safety.test.ts) | `node test/safety.test.ts` | 38 | Containment, atomic writes, forced deletion, recovery and cross-process locking. |
| [`test/release.test.ts`](../../test/release.test.ts) | `node test/release.test.ts` | 6 | Builds a miniature package per case and runs `scripts/release-notes.ts` against it. |
| [`test/docs.test.ts`](../../test/docs.test.ts) | `node test/docs.test.ts` | 13 | Builds a miniature checkout and runs `scripts/check-docs.ts` against it. |
| [`test/live.test.ts`](../../test/live.test.ts) | `npm run test:live` | 12 | The real GitHub round trip; opt-in. |

The counts are the ones `CONTRIBUTING.md` records and the ones a run on Node v22.23.1 reports: 194 cases
across the nine offline suites, plus the 12 live ones. `test/safety.test.ts` can print fewer passes than
that on a platform where a case skips, and says so separately.

## The shared runner, the fixture and the helpers

There is no test framework. Every suite is a standalone `node` script with its own four-line runner:

```ts
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push(true)
    console.log(`  \u001b[32mok\u001b[0m    ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}`)
    console.log(`        ${(error as Error).message.split('\n').join('\n        ')}`)
  }
}
```

Each suite ends with `${passed}/${total} passed` and sets `process.exitCode = 1` if anything failed, so
a suite's exit code is the signal `&&` acts on and the case name in the log is what you grep for.

[`test/fake-gh.ts`](../../test/fake-gh.ts) is the stand-in for the CLI. A suite points `ghPath` at
`[process.execPath, fake-gh.ts]` — the `[command, ...prefixArgs]` form the plugin also accepts for a
wrapper such as `['wsl', 'gh']` — and names a JSON state file in `FAKE_GH_STORE`; the double implements
`--version`, `auth status` and the `/gists` API (GET, POST, PATCH including a `null` file value that
deletes, DELETE). Failure injection is read from the environment, per case:

| Variable | Effect |
| --- | --- |
| `FAKE_GH_STORE` | The JSON store. Required; the double exits 2 without it. |
| `FAKE_GH_TRUNCATE` | Comma-separated file names served `truncated: true` with a partial body and a `raw_url`, as GitHub does for large files. |
| `FAKE_GH_RAW_BASE` | The origin those `raw_url` values are built from, so a case can present one the plugin must refuse to follow. |
| `FAKE_GH_FAIL_RAW` | `1` makes a raw content request fail, which is what a proxy-only machine looks like to the direct fetch. |
| `FAKE_GH_FAIL_GET` | Comma-separated gist ids whose GET answers HTTP 500. |
| `FAKE_GH_FAIL_GET_ALL` | `1` fails every gist GET. |
| `FAKE_GH_UNAUTHENTICATED` | `1` makes `auth status` report a logged-out CLI and exit non-zero. |
| `FAKE_GH_LOGGED_OUT_OK` | `1` reports a logged-out CLI while still exiting 0, which is what a real `gh` does with no host configured. |
| `FAKE_GH_FAIL_CREATE` | `1` fails every POST `/gists`. |

[`test/regression.test.ts`](../../test/regression.test.ts) clears six of those around every case
(`FAKE_GH_TRUNCATE`, `FAKE_GH_RAW_BASE`, `FAKE_GH_FAIL_GET`, `FAKE_GH_FAIL_GET_ALL`,
`FAKE_GH_UNAUTHENTICATED`, `FAKE_GH_LOGGED_OUT_OK`) so one case's injection cannot leak into the next;
`FAKE_GH_FAIL_RAW` and `FAKE_GH_FAIL_CREATE` are not in that list.

Two helpers exist only to make a case possible:

- [`test/stdout-flush.ts`](../../test/stdout-flush.ts) — `flushThenExit`, used by the fake `gh` to wait
  for a response body to reach the pipe before exiting, because `process.exit()` does not wait and a
  gist with a few hundred files is past the pipe buffer. It has a 5 000 ms limit
  (`FLUSH_TIMEOUT_MS`), and its `write`, `stderr` and `exit` hooks are injectable so the give-up branch
  can be driven by a double: staging a flush that genuinely never completes is not portable, because on
  Windows a full pipe blocks the writing thread and the process never reaches its own timeout.
- [`test/lock-worker.ts`](../../test/lock-worker.ts) — a child process that takes the state lock,
  records entry and exit around a delay and exits. Two of them run at once in the locking case: if the
  lock works, the log shows the two critical sections serialised one after the other.

## `test/entry.test.ts` — the boundary a profile crosses

**Mechanism.** It refuses to start without `dist/index.js`, `dist/lib/core.js` and `dist/index.d.ts`,
then imports the package *by name* (`@local/dsh-gist-settings`), relying on Node's self-reference rule
so the resolution under test is the real `exports` map rather than a path spelled out in the test. It
registers the loaded entry through a fake context, then does the same for `../index.ts` and compares
fingerprints of the two registrations.

**What it proves.** A profile's loader crosses this boundary and nothing else in the repository does:
every other suite imports the sources. What fails here is an `exports` target that names the sources or
a path that does not exist, a missing or stale build, a relative import the compiler rewrote to
something Node cannot resolve, and an entry that loads and registers nothing.

**Notable cases.** `the export map resolves to the built entry, not the sources` asserts
`import.meta.resolve()` matches `/dist/index.js$`. `the built entry, its engine and its declarations are
on disk` checks all three exist and are non-empty. `loading it by package name yields the plugin the
Loader expects` pins `inject` to `['tools']` and `apply` to a function. `every registered tool declares
what the registry requires` checks description, `parameters.type`, `output.schema.type`, `output.render`
and `execute` on each of the four. `the built entry registers exactly what the source entry registers`
is the stale-build detector: the fingerprint deliberately reaches past the declarations — member sets,
each tool's output schema, what `output.render` produces for a probe, and the concurrency verdict —
because comparing `name`/`description`/`parameters` alone would call a build that changed only behaviour
identical.

## `test/guards.test.ts` — the invariants nothing else can see

**Mechanism.** It reads the repository rather than exercising the plugin. The subjects are discovered,
not listed: every `.ts` file in the tree outside `dist/`, `node_modules/`, `.git/` and `.worktrees/`, so
a source that appears in a new directory is guarded the moment it lands. It parses `package.json`,
`tsconfig.json`, `tsconfig.check.json` and `.github/workflows/ci.yml` the same way — as text — and
asserts seven properties of the whole. No child process, and one in-memory fixture — a miniature workflow
inside the Node-floor case — which exists because the boundary that case depends on cannot be observed on
a workflow that is correct. The only thing it borrows from the build is the case that checks what
`exports` and `files` name.

**What it proves.** The properties this repository depends on to run at all, none of which a behavioural
suite can observe, because all seven fail *silently* in normal use: a file that stops surviving Node's
type stripper fails only when someone runs it; a removed `erasableSyntaxOnly` merely stops being checked;
a `package.json` entry that names nothing is only discovered at pack time; and an `engines.node` that
drifts from the leg CI actually runs is noticed on the platform nobody develops on. A short in-repo scan
is also the only way to see the difference between "the cases pass" and "every case still runs at all".

**Notable cases.** `every relative import names a file that exists, and the runtime imports .ts` is the
one that reaches across files. It resolves each specifier against the importing file's own directory,
requires the resolved path to be a **file** (a directory resolves and then fails at load with
`ERR_UNSUPPORTED_DIR_IMPORT`), and — for `index.ts` and `lib/**` only — requires the specifier to end in
`.ts`, because that suffix is what the build's `rewriteRelativeImportExtensions` turns into `.js`; naming
`.js` in the source compiles and then fails to load. The scan reads a wrapped `import {\n…\n} from '…'`,
a bare `import '…'`, and a dynamic `import('…')` anywhere in an expression, over a copy of the source
with its comments removed — a scanner rather than a line filter, because `//` and both quote characters
also appear inside strings and regular expressions here, and because a comment that names a path must not
be mistaken for an import. `the packaging names artifacts a build emits` walks `exports` recursively, so a
condition nested inside `exports["."]`, or a subpath nobody can import, cannot name a file that does not
exist, and a `*` pattern has to match something, so `./locale/*.json` cannot point at a directory that
holds no locale file. `every suite and script is run by a package script` resolves the `&&` chain one
alias deep and requires a segment that actually *runs* the file — `echo skipped test/sync.test.ts` names
it without running it — and separately requires the live suite to stay out of `npm test` itself.
`the declared Node floor is the one CI runs` asserts the shape, not a string: the floor is a matrix entry
with an `os`, the comment naming whose floor it is sits with that leg, and no line of the step running
`npm test` carries an `if:`, so the floor cannot be installed and skipped. That step is read whole — YAML
keys are unordered, so an `if:` below the command skips it just the same — and it is bounded by its own
indentation, so a condition on the job that follows is not read as a condition on this one.

**Where it deliberately stops.** Four boundaries are named rather than silent. A hand-written `client.js`
at the repository root is allowed, because the README documents it there as the settings page the Harness
bundles — a source, not compiled output; a `.js` beside a `.ts` twin, or nested anywhere outside `dist/`,
is not. A `.tsx` or `.jsx` source cannot be executed by Node's type stripper at all, so this suite does
not claim to cover one; the day the settings page adds such a file, the bounds of this suite change
deliberately rather than quietly. The import scan reads comment-stripped text rather than a syntax tree,
so a specifier spelled inside an ordinary string is read as an import — no file here writes a real
specifier that way, and the alternative is a parser this suite does not need. And a `.ts` file in a
directory nothing else polices is still scanned, which is the point of discovering subjects instead of
listing them.

**Why it is not a behaviour suite.** Each of the seven cases describes the *repository*, not the plugin,
so its mechanism is a file read and its failure is a report naming the file. Every case was verified the
way `CONTRIBUTING.md` requires: break the invariant by hand, watch only that case go red, restore it —
an `enum` appended to a script, an import pointed at a missing file, at a non-`.ts` file, pulled across
lines and made a directory, an `exports` condition and a `files` entry naming nothing, a suite kept in
the chain only as an `echo` argument, a flag removed, the floor moved, and the CI step that runs the
floor made conditional.

## `test/sync.test.ts` — the engine lifecycle

**Mechanism.** It imports `lib/core.ts` directly, seeds two profiles (`alpha`, `beta`) in a throwaway
`DSH_HOME`, points `ghPath` at the fake, and walks the lifecycle in order, carrying state from one case
to the next.

**What it proves.** The status vocabulary, the actions a sync can take, where backups land, and what
pruning and recreation do — the whole engine, with no network and no GitHub account.

**Notable cases.** `health()` reports the resolved path, the parsed version and the authenticated account.
`uploadProfile() creates a secret gist on first upload` pins the description string
(`DeepSeek Harness profile config: alpha`). A local edit reads `local-ahead`, a remote edit
`remote-ahead`, and a *true* divergence refuses to sync unforced (`/diverged/`) while
`force: true` resolves it as `forced-upload`. `downloading takes a backup of the previous local files`
reads the pre-download content back out of `<stateDir>/backups/alpha/<stamp>/cordis.patch.yml`.
`uploading prunes remote files that are no longer tracked` adds a `stale.yml` to the gist and expects it
gone, with the tracked files untouched. `a deleted gist is reported as missing-gist and recreated by
sync` asserts the new gist id differs from the old one. `repeated syncs are idempotent no-ops` expects
`noop`, and `state.json records one gist per profile` expects a `gistId` and a `lastSyncedHash` on both.

## `test/tools.test.ts` — the tool layer

**Mechanism.** `apply(ctx, config)` is driven with a stub context that captures each registered
definition and records the effect label; a `call()` helper executes a tool, renders its value through
`output.render` and asserts the blocks are text blocks, then joins them into the string the cases match
against. Everything runs against the fake `gh`.

**What it proves.** The layer between the model and the engine: registration, the JSON Schema each tool
advertises, argument validation, profile-name resolution, what each tool's output actually says, and
that one failing profile never aborts the others.

**Notable cases.** `an explicit-profile upload does not report other profiles as missing` asserts the
unselected profile's name does not appear at all in the output. The argument gate covers a misspelled
`profil` (which used to be dropped, widening "sync alpha" into "sync everything"), `force: 'false'`
(`Boolean("false") === true` used to force a destructive overwrite), an explicit `null` for a string or
a boolean, and a non-object argument list. The profile-resolution gate refuses a case-only variant
(`ALPHA`) with the real name in the message, still resolves the exact name, and refuses an unknown name
with the list of known ones. `a genuinely failing profile does not abort the others` empties `beta`'s
directory so its upload cannot succeed, then expects `beta: FAILED` and `alpha:` processed anyway — the
earlier case of that name only deleted gists, which is recoverable. `gist_sync restores a profile whose
tracked files were deleted locally` is the disaster-recovery path: an emptied profile used to classify
as `local-ahead` and upload, deleting the gist's only copy. `apply() refuses a profileFiles entry that
could leave the profile` pins validation at load time, not first use; the duplicate-spelling half of it
runs only where the filesystem folds case, because on Linux `package.json` and `PACKAGE.JSON` really are
two files.

## `test/schema.test.ts` — the Harness's own validators

**Mechanism.** It locates an installed `@deepseek-ai/dsh-tools` — `DSH_TOOLS_DIR` first, then three
candidate paths under the running Node's own installation — imports `lib/types/json-schema.js` and its
sibling `dsh-app-boot`'s `lib/index.js` by file URL, and calls the runtime's own functions rather than a
copy of their rules. Finding no installation **fails** the suite; `DSH_ALLOW_SCHEMA_SKIP=1` accepts the
skip instead, printing a `SKIP:` line and exiting 0. It then registers the four tools through a stub
context and drives them against the fake `gh` with one seeded profile.

**What it proves.** The plugin imports nothing from the Harness, which is what keeps it immune to
module-resolution changes — and which also means the Harness never type-checks these hand-written
definitions. This suite closes that gap by replaying what the runtime does: the registration contract
(`output` with `schema` and `render`; `presentationMeta` optional but a function when present),
`assertSupportedJsonSchema` on `parameters` and on `output.schema`, `validateJsonSchemaValue` on the
value `execute` returns, and that every `render` block is a text block. It also requires a description
of at least 40 characters and a description on every declared parameter, because those are what the
model reads.

For arguments it compares the two implementations: for each entry in its bad-argument list it asks the
*real* validator first, and only if the real validator rejects the value does it require the plugin's
hand-written `checkArgs` to reject it too, with `/invalid arguments/`. A value the real validator allows
has nothing to compare and the case returns.

**The loader-gate case, and its control.** The first case is
`the bundle manifest passes dsh <version>'s compatibility gate`. It calls
`evaluatePluginCompatibility(package.json)` — the function the profile loader itself calls before it
adds a bundle layer — and requires it to return `undefined`, so the installed runtime satisfies this
package's `@deepseek-ai/dsh` peer declaration. Directly below it sits the control: the same call against
a copy of the manifest whose peer is `0.0.1` must be **rejected**, "or this case would pass whatever
`peerDependencies` said". Without the control, a gate that returned `undefined` unconditionally would
keep the suite green while the declaration drifted.

This case belongs in this suite because no other suite can see it: they all call the plugin directly,
whereas the loader reads the declaration and nothing else, so a peer the installed runtime cannot
satisfy skips the whole bundle however sound the definitions are.

**Notable cases.** `apply() produced definitions to validate` guards the per-tool loop. Each tool gets
five contract checks plus the bad-argument comparisons — 2 + (4 tools × 12) = 50 with the four tools
registered. If a tool is added, the count moves with it.

## `test/regression.test.ts` — the defects the reviews found

**Mechanism.** Core against the fake `gh` with per-case environment injection, plus real child
processes where the defect was a process-level one, plus `flushThenExit` driven through its injectable
hooks.

**What it proves.** Each case here is written to fail if its fix is reverted, which is the gap the
mutation audit found: the happy path was covered, the guards and negative branches were not.

**Notable cases.** The first is the process-killing bug: `ghRun survives a child that exits without
draining a >64 KiB stdin body` writes 200 000 bytes to a stub that exits immediately, and requires
`ghRun` to resolve with a non-zero numeric code rather than reject — a regression takes the whole file
down, which is the loudest failure available. `a gh that exits 0 while logged out is still
unauthenticated` pins that the message is read, not just the exit code. `a response whose flush misses
its budget fails loudly, never as a success` requires exit code 1 and `/did not drain/`, because handing
back half a JSON document as a successful answer is the failure the flush exists to prevent.

On the engine: an unreachable gist must not read as deleted (status `unreachable`, error matching
`/500/`), and both upload and sync must refuse rather than mint a replacement. A tracked file missing
locally must not be deleted from the gist, must read `missing-local` rather than `local-ahead`, and is
restored by a sync without `force` — while pruning of files that are no longer tracked still happens.
`hashFiles is pinned to a frozen value` makes a change to the fingerprint function a deliberate,
reviewed act. `editing the SECOND tracked file is detected, not just the first` covers the loop that
only looked at one file. The truncation cases require exactly one `fetch` of the `raw_url` the API
named, with `redirect: 'follow'`; four lookalike hosts (including
`https://gist.githubusercontent.com%2F@evil.example/collect`) must be refused *unfetched*, and an error
status must be reported rather than quietly truncated. On state and identity: a malformed state file is
rejected clearly, two concurrent uploads both survive in the state file, a stale in-sync baseline is
repaired rather than causing a false divergence, every created gist is secret, and a name differing only
in case cannot create a second gist.

## `test/safety.test.ts` — the guarantees the README makes

**Mechanism.** Core against the fake `gh`, plus real filesystem tricks: directory junctions
(`cmd /c mklink /J`) and file symlinks (`fs.symlink`) for the containment cases, spawned children for
the locking cases, a real dead pid from a spawned `node -e ''`, and injected `fetchImpl` responses for
the raw transfer. Its runner is the only one that can skip: a case may return a reason string instead of
throwing, and that reason is printed and counted separately, never as a pass.

**What it proves.** The promises in [`README.md`](../../README.md#the-safety-model), one by one —
containment for the profile and every tracked file, an all-or-nothing download, `force` doing what it
says, recovery of a profile whose directory is gone, one-sync convergence after the remote drops a file,
cross-process locking, and a rollback that never overwrites a revision it cannot prove it wrote.

**Notable cases.** Containment: a tracked name with a separator, a reserved device name, or a trailing
dot or space is refused; a `profileFiles` entry that traverses is refused, as are two spellings of one
file where the filesystem folds them; a tracked entry that is a junction out of the profile, or a link
to a sibling profile, is refused; a junction under `profiles/` cannot escape. Atomicity: a failed commit
restores what it wrote and leaves an external edit alone, a tracked file named `rollback` cannot break
the rollback, and a target that cannot be read back is reported as unverified rather than as an edit.
Recovery: `gist_upload` with `force` really deletes the tracked file it is missing locally; a profile
whose directory was deleted outright is still discovered and restored, including when the whole
`profiles/` directory is gone or reached through a junction; a home directory reached through a junction
can still restore a deleted profile; bulk discovery invents nothing when there is neither a directory
nor a record. Convergence: one sync repairs a tracked file the gist dropped, and a gist that lost its
last tracked file is republished by one sync. Locking: two processes cannot interleave their critical
sections (the four-line log), a lock left by a dead process is reclaimed at once rather than waited out,
a lock written by another machine is not judged by this machine's pid rules, releasing a lock does not
delete one another writer now owns, two waiters racing one stale lock cannot both enter, a state write
is refused when the lock has been taken over, and the lock is released when the work throws while a
nested call is refused. Raw transfer: content is fetched under its own deadline and read as a stream, a
response that does not report its final URL is refused, a response that redirected off the trusted host
is refused, a transport failure falls back to `gh` and a failing fallback is reported, an untracked
truncated file cannot make the profile unreachable, and a truncated tracked file with an untrusted
`raw_url` is still refused. Baselines: a stale-baseline repair is a compare-and-set, so a repair cannot
overwrite a baseline another writer advanced, and a baseline that cannot be recorded is reported
honestly.

**The skips, and why they are honest.** The reasons a case may return are all environmental: junctions
are a Windows-only construct, this environment does not allow creating a junction, or a failure
injection did not land on this run (`the external edit did not land on this run, so nothing was
exercised`). Cases are written to avoid needing one — where Windows withholds the privilege for a file
symlink, the same last-segment containment check is exercised with a directory junction — because a
security case that quietly does nothing is worse than no case at all.

## `test/release.test.ts` — the release-notes script

**Mechanism.** Each case builds a miniature package in a temporary directory — a `package.json` and a
`CHANGELOG.md` — copies `scripts/release-notes.ts` into a `scripts/` subdirectory, runs it as a child
process with that directory as the working directory, and keeps stdout and stderr apart.

**What it proves.** `scripts/release-notes.ts` normally runs for the first time on a tag push, which is
the worst moment to discover it refuses a good tag or accepts a bad one. So the success path and every
refusal are checked on every push.

**Notable cases.** `a matching tag prints the section body and nothing else` pins the success path.
`an empty section is refused even when link definitions follow it` is the subtle one: the extraction
stops at the link definitions at the bottom of the changelog, so a heading with no entries of its own
cannot look non-empty by running into them. The refusals cover a tag that disagrees with `package.json`,
a version with no dated section, a tag that is not `vMAJOR.MINOR.PATCH`, and a pre-release tag. The
distinction that matters throughout is stdout versus stderr: the release job redirects stdout into a
notes file and publishes it, so a refusal has to leave stdout empty or a failed run would publish the
error text as the release notes.

## `test/docs.test.ts` — the documentation checker

**Mechanism.** Each case builds a miniature checkout containing `scripts/check-docs.ts`, the two
cross-linked READMEs the checker requires, and one `notes.md` holding the case's own link, then runs the
checker as a child process and asserts the exit code and the message.

**What it proves.** `scripts/check-docs.ts` runs inside `npm test`, so a bug in it fails the build for
the wrong reason, and a bug that makes it miss a link lets a broken document through unnoticed. Both
have happened, which is why the checker has its own suite.

**Notable cases.** `an angle-bracket destination containing a space resolves` (the old scan truncated at
the space), `a destination with balanced parentheses resolves` and `a destination with escaped
parentheses resolves` (the old scan cut at the first `)` and left backslashes in the name),
`an escaped hash stays part of the name`, `a link through an in-repo directory link to an outside file
is refused` (containment used to compare the spelled path, so a link through a symlink reached outside
the repository), `a direct link to an outside file is refused`, `link-shaped text inside a code span is
ignored`, `a reference definition pointing outside is refused`, and `a missing README pairing is
refused`.

## `test/live.test.ts` — the real GitHub round trip

**Mechanism.** Opt-in: without `DSH_GIST_LIVE_TEST=1` it prints a `SKIP:` line and exits 0. With it, the
suite resolves the real `gh` through `resolveGh`, asserts it is authenticated, and works entirely inside
a throwaway `DSH_HOME` under the OS temp directory, so no real profile is read or written. A `finally`
block deletes every gist the run created, including when an assertion failed. `readGistUntil` re-reads a
gist up to 12 times, 500 ms apart, because a PATCH is not always immediately visible to the following
GET.

```powershell
$env:DSH_GIST_LIVE_TEST='1'; npm run test:live     # PowerShell
```

```bash
DSH_GIST_LIVE_TEST=1 npm run test:live             # bash
```

**What it proves that the fake cannot.** That `gh api` really accepts this plugin's POST, PATCH and
DELETE bodies; that a PATCH with a `null` file value really deletes the remote file; that content
survives a real round trip byte for byte; and that a file big enough for the API to truncate — 1.5 MB
in this suite — comes back whole from the `raw_url` the API named, including through a forced download.
`the API refuses a filename containing a slash, which is why tracked names have none` pins the *reason*
`normalizeTrackedName` rejects a separator rather than the rejection itself, and deletes the gist if the
API has changed its mind.

**It is not in CI**, because it writes to a real GitHub account and needs a `gist`-scoped token. Run it
yourself when a change touches the API round trip; it deletes every gist it creates.

## The three scripts

All three run from source, with no build step, and are also `npm` scripts.

**[`scripts/check-docs.ts`](../../scripts/check-docs.ts)** — `npm run docs:check`. It walks every
Markdown file in the repository, skipping `.git`, `node_modules` and `.worktrees`, removes fenced blocks
and inline code spans, then scans each remaining destination: inline links, reference definitions,
angle-bracketed destinations that may contain spaces, balanced parentheses and backslash escapes.
Absolute URLs, `mailto:`, protocol-relative URLs and bare `#fragment` links are skipped deliberately —
they are not this repository's to verify. Everything else is percent-decoded, resolved against the
directory of the file that contains it, and required to exist; the *real* path is then required to stay
inside the repository, so a link through an in-repo symlink that points outside is refused. It also
requires `README.md` and `README.zh-CN.md` to link to each other. Success prints
`Documentation OK: N relative links across M Markdown files, none broken.`; failure lists every problem
and exits 1.

**[`scripts/check-changelog.ts`](../../scripts/check-changelog.ts)** — `npm run changelog:check`.
`[Unreleased]` must exist, come first and carry no date; every released heading must be
`MAJOR.MINOR.PATCH`, dated `YYYY-MM-DD` with a real date, and strictly descending; `package.json`'s
version must have a heading; and every heading must have exactly one link definition, with no link
definition without a heading. Success prints `CHANGELOG.md OK: N released versions, newest X (date),
plus [Unreleased].`

**[`scripts/release-notes.ts`](../../scripts/release-notes.ts)** — `npm run release:notes -- v0.2.0`. It
refuses (stderr, exit 1, nothing on stdout) when the argument is missing or is not `vMAJOR.MINOR.PATCH`,
when the tag disagrees with `package.json`, when there is no dated section for that version, and when
that section is empty. On success it writes the section body to stdout and a one-line report to stderr,
while the release workflow redirects stdout into a notes file and publishes it — which is why a refusal
leaving stdout empty is part of the contract. See [Release process](release-process.md).

## Continuous integration

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every push to `main`, on every pull
request and on `workflow_dispatch`. It holds `contents: read`, cancels a superseded run on the same ref
(`group: ci-${{ github.ref }}`, `cancel-in-progress: true`), and pins every action to a full commit SHA
rather than a tag, because a tag is mutable and a repointed one would run inside this repository's token
on the next push.

**The `suites` job.** A matrix of `ubuntu-latest`, `windows-latest` and `macos-latest` against Node
`22.x` and `24.x`, plus one included leg on `ubuntu-latest` at exactly `22.19.0` — seven legs.
`fail-fast` is off, so one platform failing does not cancel the others: which platform disagrees is
usually the whole diagnosis. Each leg runs `npm install --include=dev --no-audit --no-fund` and then
`npm test`, the same command a contributor runs.

The floor leg exists because a major-version alias only installs the newest release of that major, so
`22.x` would never notice something that arrived in the middle of one. `22.19.0` is what `engines`
names, and that floor is the Harness's rather than the engine's: `@deepseek-harness-tui/dsh-tui`
declares `engines: ^22.19 || >=24`, so the narrower version is the one the plugin promises. The three
platforms are not padding either — containment takes a different path per OS (case folding and reserved
device names on Windows, Unicode normalisation on macOS, rename-over-a-file semantics everywhere) — so a
green Linux run says nothing about the code path a Windows user gets.

The job also sets `DSH_ALLOW_SCHEMA_SKIP: '1'`, so on the matrix legs a missing Harness turns the schema
suite into an explicit, visible `SKIP:` line instead of a failure, while the rest of that suite still
runs on all seven.

**The `typecheck` job.** One leg, `ubuntu-latest`, Node `22.19.0`: install the pinned toolchain, then
`npm run typecheck`. It closes the gap the matrix cannot see — `npm test` builds the runtime but never
compiles the suites or the scripts, and erasing types is not checking them, so a mistyped test passes
all seven legs above and fails only here. One leg rather than seven, because the compiler reads the same
files and the same pinned `@types/node` wherever it runs; the floor, because the release job publishes
from it and runs this same command before it publishes.

**The `targets` and `schema` jobs.** `targets` reads `peerDependencies["@deepseek-ai/dsh"]` out of
`package.json`, splits it on `||` and emits the list as a job output, so the schema matrix cannot drift
from the declaration; the versions are spelled out as exact versions rather than a range because semver's
caret does not cross prereleases (`^0.1.7-rc.2` stops below `0.2.0-rc.2`). `schema` then runs one leg per
declared version — `fail-fast` off, Node `22.19.0`, and the composite action at
[`.github/actions/install-harness`](../../.github/actions/install-harness/action.yml) with that version —
followed by `npm run test:schema`.

The action installs the version with `npm install --no-save --no-audit --no-fund --include=dev`, resolves
`dsh-tools` from the Harness's own location rather than assuming where npm put it, fails with a
`::error::` naming the Node requirement when
`lib/types/json-schema.js` is absent — on too old a Node the install completes without it — and exports
`DSH_TOOLS_DIR` for the suite. It is shared with the release job on purpose: two jobs that both need a
Harness should not each have their own way of getting one, and the release job must not take the matrix's
skip, so its `npm test` runs the schema contract for real. [Release process](release-process.md) owns
what else that job does.

**Deliberately absent: the live suite.** It writes to a real GitHub account; see above.

## Mutation discipline

An audit deliberately injected 43 bugs into this codebase; 32 of them survived the original suite. Two
later reviews then found guards that stopped one level short of what they claimed. The regression and
safety suites exist because of that, and the practices below are how the repository tries not to repeat
it.

- **Prefer a case that fails before your change.** A new case should be run against the unfixed code
  first, and the pull request should name it — "tests still pass" is not evidence. If you cannot make
  the case fail without the change, the case is not testing the change.
- **Verify a fix by reverting it by hand.** Undo the fix, watch the case fail, restore it. This is the
  same claim from the other direction, and it is what `test/regression.test.ts`'s cases are written to
  survive.
- **Never weaken, delete, merge or skip a case** to make a change pass. A test that cannot fail is worse
  than no test.
- **A suite fails rather than skips when its precondition is missing.** `test/entry.test.ts` and
  `test/guards.test.ts` without a build, and `test/schema.test.ts` without a Harness, all fail and say
  what is missing, because a check
  that quietly runs nothing reads as coverage. The two deliberate opt-outs are explicit and visible: set
  `DSH_ALLOW_SCHEMA_SKIP=1` to accept the schema skip, and `test/safety.test.ts`'s skips print a reason
  and are reported separately instead of counting as passes.
- **Put the case where its mechanism already is.** A specific defect a review found belongs in
  `test/regression.test.ts`; a guarantee the README makes belongs in `test/safety.test.ts`; a new
  lifecycle transition belongs in `test/sync.test.ts`; anything about the tool surface, its arguments or
  its output belongs in `test/tools.test.ts` and `test/schema.test.ts`; a new Markdown rule belongs in
  `test/docs.test.ts`.
- **Run both commands before you push.** `npm test` for behaviour, `npm run typecheck` for the suites'
  own types — neither covers the other. [Development](development.md) has the rest of the loop.