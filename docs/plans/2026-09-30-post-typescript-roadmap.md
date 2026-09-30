# Roadmap Implementation Plan: Migration Close-Out, the Two Open Issues, and the Settings Page

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking, and every step states how it is verified. Designs belong in `docs/spec/`, plans belong in `docs/plans/`. Work happens in a worktree under `.worktrees/<name>` and reaches `main` through a pull request.

**Goal:** Close out the TypeScript migration, turn the dsh compatibility declaration into routine
maintenance rather than an outage, fix the two open issue reports — the per-device override layer
([issue #4](https://github.com/soimy/dsh-gist-settings/issues/4)) and the `/gist` command surface
([issue #5](https://github.com/soimy/dsh-gist-settings/issues/5)) — and finish the planned work that is
still open: a guard suite, repository hygiene, and the settings page.

**Context:** Everything merged since `0.2.0` is still under `[Unreleased]`. In that window the
runtime moved to TypeScript and started compiling into `dist/`; the suites and the three scripts
moved to TypeScript and run from source under Node's type stripper; CI gained a repository-wide
type-check job and a schema job that installs every declared dsh version and runs the loader's own
compatibility gate; the peer declaration became an enumerated list after dsh `0.2.0-rc.2` skipped the
bundle outright; and the documentation tree under `docs/` landed with `AGENTS.md` (PR #11). The two
open issues were filed on 2026-09-28 against the pre-TypeScript sources; every line reference in them
has since moved, and the behaviour they describe is unchanged.

**Why the order below is the order below.** The two issues are not the same kind of work. Issue #5
is a second entry point over logic that already exists, and its own text names the prerequisite: the
orchestration in `index.ts` has to move somewhere both surfaces can call, or the two will drift. Issue
#4 is a defect in the sync model itself, and its proposal cannot be implemented as written — see Task
5. So the migration close-out ships first (it is finished work sitting in `[Unreleased]`), then the
issue work begins with the design that decides #4's mechanism, and #5 follows the extraction it names.

### Constraints every task below obeys

These are the house rules that decide *how* these tasks may be implemented, and each of them narrows
one of the tasks:

- **No runtime dependency, and nothing outside `node:`.** The bundle ships none and imports none, so
  `package.json` can be addressed with `JSON.parse` but a YAML file cannot be addressed with a parser
  that does not exist here. This is what makes issue #4's `cordis.patch.yml` half a design decision
  rather than a coding step.
- **Nothing imported from the Harness installation.** A service the Harness provides — `ctx.tools`
  today, `ctx.commands` for issue #5 — is declared structurally in this repository, never imported.
- **`hashFiles` is pinned by a regression case.** Canonicalisation has to happen *before* the hash,
  never inside it, or `hashFiles is pinned to a frozen value` stops meaning anything.
- **`test/entry.test.ts` pins `inject` to `['tools']`.** Adding a service to `inject` is a deliberate
  edit to that pin, with a comment saying why; nothing may widen it by accident.
- **A release pull request touches four files and nothing else.** A behaviour change belongs to the
  pull request that introduces it.
- **A declared dsh version is not verified until CI installs it.** CI's `targets` job reads the list
  out of `peerDependencies`, so a declaration change is proved by the `schema` job or not at all.

### The sequence

One row per reviewable unit. "Depends on" is a merge-order constraint, not a suggestion.

| Order | Task | Deliverable | Depends on |
| --- | --- | --- | --- |
| 0 | Task 1 — verification smoke | Evidence, no pull request | — |
| 1 | Task 2 — the guard suite | PR `test: guard the invariants nothing currently checks` | — |
| 2 | Task 3 — release `0.3.0` | PR `chore: release 0.3.0`, then tag `v0.3.0` | Task 2 |
| 3 | Task 4 — repository hygiene | Pin-bump PRs and two recorded decisions | Task 3 |
| 4 | Task 5 — issue #4, design | `docs/spec/<date>-device-override-design.md` | — |
| 5 | Task 6 — issue #4, implementation | Engine, tools, tests, docs | Task 5 |
| 6 | Task 7 — the operation layer | Refactor PR, no behaviour change | Task 6 |
| 7 | Task 8 — issue #5, `/gist` | Command surface over the extracted layer | Task 7 |
| 8 | Task 9 — the settings page | Research, spec, implementation | Task 8 |

Tasks 3 and 4 are `.github/` and release-page work and share no files with Tasks 5–8; they may run
alongside them. Task 6 and Task 7 both edit `index.ts`, so they are strictly ordered.

---

### Task 1: Close the migration's verification gap

The migration changed code that CI cannot reach, and one thing a user sees cannot be checked from a
build log. This is the cheapest task here and it gates the release: it is the only check that a
*running* Harness loads `dist/`.

**Files:** none required. If the restart turns up a surprise, the fix belongs with the code that
caused it, and a note belongs in `docs/user/troubleshooting/index.md`.

- [x] **Step 1: Confirm a running Harness loads the bundle again**

  Run: `dsh --profile dsh-tui --dump-config`
  Expected: no `skipping profile bundle` line, and a `dsh-gist-settings` row in the composed
  profile. This was the reported failure; the merged declaration is what fixes it.

- [ ] **Step 2: Restart dsh and confirm the four tools are registered**

  Run: call `gist_status` from a session.
  Expected: a status report listing the profiles and their state. A session that started while the
  bundle was skipped has no `gist_*` tools at all, so this is the proof that the restart picked the
  fix up.

- [x] **Step 3: Run the live suite once against the migrated source**

  Run: `$env:DSH_GIST_LIVE_TEST='1'; npm run test:live`
  Expected: 12/12 passed. It creates and deletes a real secret gist.
  Why now: it is the only suite CI never runs, and the migration rewrote 71 lines of it — type
  annotations, a re-wrapped signature, and a typed predicate where `.filter(Boolean)` used to be.

### Task 2: A tenth suite for the invariants nothing currently checks

The suites test behaviour. Nothing tests the properties that make this repository work at all: that
every file is still strippable, that imports name real files, that the packaging points at things
that exist. Each of the following should be written the way this repository writes tests — revert
the invariant by hand, watch the case go red, then restore it.

It lands **before** the release and before the issue work, because the tasks below add a config key,
a module and a service declaration, and these are exactly the packaging invariants a rename or a new
directory can break silently.

**Files:** `test/guards.test.ts` (new), `package.json` (a `test:guards` script and a place in the
`test` chain), then the counts in `CONTRIBUTING.md` and both READMEs, `docs/contributor/testing.md`,
and a `CHANGELOG.md` entry.

- [x] **Step 1: Every TypeScript file still strips**

  Run `module.stripTypeScriptTypes` over `index.ts`, `lib/**/*.ts`, `test/**/*.ts` and
  `scripts/**/*.ts`.
  Expected: no throw. `erasableSyntaxOnly` protects this at compile time; nothing protects it at
  runtime, and a `.ts` file that fails to strip fails only when someone runs it.

- [x] **Step 2: Every relative import names a file that exists**

  Expected: no import in those files resolves to nothing, and the runtime's imports still end in
  `.ts` rather than `.js`.

- [x] **Step 3: No stray JavaScript**

  Expected: no `.js` or `.mjs` file under `test/` or `scripts/`, and none at the root — `dist/` and
  `node_modules` are the only places compiled output may live.

- [x] **Step 4: The packaging points at things that exist**

  Expected: every path in `exports` and `files` exists after `npm run build`, and `exports["."]`
  still names `./dist/index.js` rather than a source file. This is the boundary the entry suite
  crosses; this case is what catches a rename that breaks it.

- [x] **Step 5: Nothing is written that nobody runs**

  Expected: every `test/*.test.ts` and `scripts/*.ts` is named by a package script. `live` is the
  one documented exception — it is opt-in by design.

- [x] **Step 6: The compiler flags that make stripping safe are still on**

  Expected: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`,
  `isolatedModules` and `strict` are all present in `tsconfig.json`. A silent removal turns the
  whole model off without failing anything else.

- [x] **Step 7: The engine floor is still the Harness's floor**

  Expected: `engines.node` is `^22.19 || >=24`, with a comment saying whose floor it is. The CI
  matrix already proves the code runs there; this case is what stops the declared floor drifting
  away from it.

  Run: `npm test`
  Expected: one more suite, and every count updated to match.

**As implemented, after an independent review.** The steps above state the requirement; the suite is
slightly wider and narrower in four places, all of them recorded here rather than only in the code:

- The subjects are **discovered**, not listed: every `.ts` file in the tree outside `dist/`,
  `node_modules/`, `.git/` and `.worktrees/`. A hard-coded `index.ts` + `lib/` + `test/` + `scripts/`
  list left a new source in any other directory silently unchecked.
- Step 5's "named by a package script" became "**run** by one". A substring test passed on
  `echo skipped test/sync.test.ts`, which names the file and never runs it.
- Step 4's walk is recursive through `exports`, because a condition nested inside `exports["."]` or a
  subpath nobody can import could otherwise name a file that does not exist.
- Step 7 asserts the **shape** of the CI leg — a matrix entry with an `os`, whose explanatory comment
  sits with it, and a step that runs `npm test` with no `if:` — rather than the presence of a version
  string, which a skipped leg or a comment moved elsewhere in the file also satisfies.

Two boundaries are deliberate and named in the suite and in
[Testing](../contributor/testing.md): a hand-written root `client.js` is not compiled output and is
allowed, and a `.tsx`/`.jsx` source cannot be executed by Node's type stripper at all, so these cases
do not claim to cover one.

### Task 3: Release 0.3.0

**Files:** `package.json`, `CHANGELOG.md`, `docs/releases/index.md`, `docs/releases/latest.md`

- [ ] **Step 1: Freeze the changelog section**

  Turn `## [Unreleased]` into `## [0.3.0] - <date>`, add a fresh empty `[Unreleased]`, and update
  the link definitions at the bottom of the file.

  Run: `npm run changelog:check`
  Expected: `CHANGELOG.md OK: 3 released versions, newest 0.3.0 (<date>), plus [Unreleased].`

- [ ] **Step 2: Bump the version and move the release index**

  Set `version` to `0.3.0`, add a row to `docs/releases/index.md`, and point
  `docs/releases/latest.md` at the new section.

  Run: `npm run release:notes -- v0.3.0`
  Expected: the `0.3.0` section on stdout. A version that disagrees with `package.json` must refuse.

- [ ] **Step 3: Merge the release pull request, then tag it**

  PR title `chore: release 0.3.0`. After it merges: `git tag v0.3.0 && git push origin v0.3.0`.

  Run: watch the `release` workflow.
  Expected: it re-runs `npm test`, `npm run typecheck` and the schema contract, generates the notes
  from
  the tagged section, and creates the GitHub release with `--verify-tag`. Note that this job passes
  the
  composite action no version, so it installs the declaration as a whole and npm resolves the newest
  entry: the *per-declared-version* proof is CI's `schema` job, which ran on this same commit before
  the
  tag existed. Whether the release job should prove each version itself is one of the open decisions
  below.

  Why `0.3.0` rather than `0.2.1`: it adds a supported runtime line and a new distribution model
  (compiled `dist/`), not only a fix. The two issues below are deliberately *not* in it — each is a
  behaviour change with its own notes, and a release pull request touches four files and nothing else.

### Task 4: Repository hygiene

- [ ] **Step 1: Bring the action pins up**

  Both actions are still pinned to v4-line commit SHAs, which run on the Node 20 action runtime
  GitHub
  has been retiring; upstream has moved several majors ahead. Do not freeze the minor versions in
  prose:
  a pinned minor is a claim that goes stale the moment upstream tags a release. Bump one major at a
  time,
  keep the SHA pin, and let CI prove each step.

  Two things to correct in the workflow while doing it: the `# vX.Y.Z` comment beside each pin does
  not
  name the release its SHA actually belongs to — the checkout pin is a v4 backport commit, not the
  tag its
  comment names — and a bump that changes the SHA without the comment repeats that. The same pair of
  pins is used four times in `ci.yml` and once in `release.yml`.

  Run: one full CI run per bump.
  Expected: green, with no new deprecation annotations, and a comment that matches the SHA it
  annotates.

- [ ] **Step 2: Decide the lockfile question**

  This repository commits no lockfile and `.gitignore` documents that `npm ci` is therefore
  unsupported. That was cheap when the package had no dependencies; every CI leg now installs
  `typescript` and `@types/node`, so the install is a real dependency resolution on every run.

  Decision: commit `package-lock.json` and switch CI to `npm ci`, or keep the current stance and say
  why in `CONTRIBUTING.md`.

- [ ] **Step 3: Decide the `dist/` distribution model**

  `dist/` is regenerated output and is not committed. That is right for this machine, where the
  profile installs the checkout by link. The open question is what anyone else would use: a release
  asset, or nothing until publishing is on the table.

### Task 5: Issue #4, part one — settle the override design

**Why this is a design task and not a coding task.** Issue #4 asks for an override that names "a
JSON path for `package.json`, a YAML path for `cordis.patch.yml`". The first half is implementable
with `JSON.parse`. The second half is where the proposal meets this repository's rules: there is no
YAML parser in `node:`, and adding one is a runtime dependency, which `AGENTS.md` prohibits and
`package.json` does not have. The spec has to choose a mechanism, and the choice is not obvious —
each option has a failure mode that matters:

- **A structured per-key override with a deliberately small reader.** Correct and surgical, but the
  reader is new code that has to refuse anything it does not understand, and a YAML subset reader
  that guesses is worse than no feature.
- **A textual rewrite map** — `from: 'C:/Users/sym/Repo'`, `to: '/home/sym/Repo'` — applied in both
  directions. No parser, covers `link:` dependencies and `ghPath`, and rewrites any string that
  merely looks like that path. This is the stopgap the issue itself describes and distrusts.
- **Narrowing v1 to `package.json`** (structured, `JSON.parse`) plus textual rewrites for the rest.

Two smaller decisions belong to the same spec, because implementing them twice is the cost of
getting them wrong: where the override file lives (a directory of per-profile files under `stateDir`
is device-local by construction; a single file named by the config row is *not* per-profile, and a
key inside the plugin's own `cordis.patch.yml` row is uploaded and restored on the other device,
which is the circularity the issue describes), and where canonicalisation sits (before `hashFiles`,
never inside it).

**Files:** `docs/spec/<date>-device-override-design.md` (new). Naming and the no-links rule follow
`docs/spec/README.md`.

- [x] **Step 1: Write the spec**

  It states the problem with the ping-pong evidence from the issue, the three candidate mechanisms
  above with their costs, the decision, the override file's location and expansion set, the exact
  point in `uploadProfile` / `downloadProfile` / `profileStatus` where canonicalisation is applied,
  what `gist_status` and the tool results say about an overridden location, and what happens when a
  named location is missing or has an unexpected shape.

- [ ] **Step 2: Record the decision on the issue**

  Comment on issue #4 with the chosen mechanism and a link to the spec, so the next reader does not
  re-litigate it. Keep the issue open until Task 6 lands.

  Run: `npm run docs:check`
  Expected: the new spec's relative links resolve (there are none by construction, but the checker
  is what proves it).

### Task 6: Issue #4, part two — implement the device-override layer

The engine keeps whole-file sync and gains a device-scoped canonical form: upload publishes the
canonical bytes, download writes the local form, and hashes are taken over canonical bytes, so a
value that is *correct on both sides and deliberately different* reads `in-sync` instead of
`diverged`. Issue #4's own acceptance criteria are the bar; they are restated here as steps.

**Files:** `lib/core.ts` (the model and the three call sites), `lib/overrides.ts` (the reader and the
two substitution functions the spec names), `index.ts` (`readConfig`, the status row, the result text),
`test/overrides.test.ts` (new), `test/sync.test.ts`,
`test/tools.test.ts`, `test/regression.test.ts`, `test/safety.test.ts`, `README.md` and
`README.zh-CN.md` (the configuration table, in both languages), `docs/user/reference/configuration.md`,
`docs/user/reference/recovery.md` (only if `force` semantics change), `cordis.patch.yml` (the
template's commented block), `CHANGELOG.md`.

- [ ] **Step 1: Load and validate the override file**

  Device-local, never tracked, never uploaded. Unknown keys, a version this reader does not know, a
  target file that is not in `profileFiles`, a location that does not resolve, and a value of the
  wrong shape are all refused with the file and the key in the message — the existing "refuse rather
  than guess" stance, so a typo cannot look like a working sync.

- [ ] **Step 2: Canonicalise on the way out**

  `uploadProfile` publishes canonical bytes, and the recorded baseline is the canonical hash. A
  device therefore never pushes its own path into the shared gist.

- [ ] **Step 3: Substitute on the way in**

  `downloadProfile` applies the overrides to the **staged** bytes before the rename, so an override
  that fails aborts the whole download and nothing is replaced — the existing all-or-nothing write
  and its backup carry the feature for free.

- [ ] **Step 4: Report overridden locations**

  `profileStatus` hashes canonical content on both sides, and the status row and tool results name
  what was overridden (`overridden locally: package.json → dependencies["@local/dsh-gist-settings"]`).
  A file that differs on disk from the gist must never be reported as plain `in sync` without that
  explanation.

- [ ] **Step 5: Prove the override file cannot enter the round trip**

  It is not uploaded, not pruned by an upload, not counted as a tracked file, not restored by a
  download, and not backed up or rolled back as profile content. Each of those is its own case.

- [ ] **Step 6: Prove the no-override path is byte-identical**

  With no override file present, every existing suite passes **with no edits to the cases that
  describe behaviour** — that is the regression bar for this task, and it is why the change is
  canonicalisation-before-hash rather than a new comparison rule.

- [ ] **Step 7: Walk the issue's acceptance criteria end to end**

  Gist holds `link:C:/Users/sym/Repo/dsh-gist-settings`; a Linux device with the override reports
  `in sync`; `gist_download` writes the Linux path without `force`; `gist_upload` leaves the gist's
  value untouched; a device A → B → A round trip converges with no `force` and no stale baseline.

  Run: `npm test && npm run typecheck`
  Expected: green, with the new cases and every count updated.

### Task 7: Extract the surface-neutral operation layer

**Why this comes before issue #5.** The command surface must not introduce a second implementation
of sync behaviour, and it cannot import one either: `gh` availability and auth checks, profile
argument resolution, bulk-profile selection, per-profile error isolation and result formatting all
live in `index.ts` today. Extracting them is the prerequisite issue #5 names in its own text, and it
is also what the settings page will call.

**Files:** a new module beside `lib/core.ts` for the extracted operations (`lib/core.ts` itself stays
Cordis-free and stays the engine), `index.ts` (tool definitions and registration only),
`test/tools.test.ts` (unchanged cases are the oracle).

- [ ] **Step 1: Move the orchestration out of the tool layer**

  The four tools become thin argument validators over the shared operations; the operation layer has
  no Cordis dependency and no tool-definition knowledge.

- [ ] **Step 2: Prove it changed nothing**

  Run: `npm test && npm run typecheck`
  Expected: green with **no behavioural case edited**. A case that has to change means the
  extraction changed behaviour, which is the whole thing this step is meant to exclude.

### Task 8: Issue #5 — the `/gist` command surface

**Why this is now a small task, and what was checked.** The Harness ships a plugin-owned human
command registry — `@deepseek-ai/dsh-commands`, service name `commands` — whose `register()` takes
`{ name, description, input?, handler }` and returns a disposer, with the handler receiving the
verbatim `rawInput` and returning `{ kind: 'success' | 'error', text }`. `/goal` and `/compact` are
shipped examples of exactly this shape. So the command surface is a first-class API, not a TUI
convention, and this repository reaches it the way it reaches `ctx.tools`: declared structurally,
never imported.

**Two findings that shape the implementation.**

1. **`inject` is a hard dependency.** Cordis's array form means "wait for these services"; there is
   no optional variant. Putting `commands` in `inject` would make the four tools *disappear* in any
   profile whose composition has no command adapter — a regression, not a feature. The command
   surface should therefore be registered through the optional path (`ctx.inject(['commands'], …)`,
   or `ctx.reflect.get('commands')` and a probe) and the tools must keep loading without it. A stub
   context with no `commands` service is the case that proves it.
2. **Subcommands are this plugin's grammar, not the registry's.** `rawInput` arrives verbatim, so
   the parse is ours: `status|upload|download|sync`, an optional profile, and `--force`.

**Files:** the new command module, `index.ts` (the optional registration), `test/entry.test.ts` (the
`inject` pin, only if it changes, with a comment saying why), the stub contexts in
`test/tools.test.ts` and `test/schema.test.ts`, a new `test/commands.test.ts`, both READMEs' tool
tables, `docs/user/reference/tools.md`, `CHANGELOG.md`.

- [ ] **Step 1: Parse the grammar and refuse the rest**

  `/gist status [profile]`, `/gist upload|download|sync [profile] [--force]`. `--force` with
  `status` is refused with usage; an unknown subcommand is refused with usage; `--force` never
  widens a single-profile call, mirroring the argument gate the tools already have. A device with no
  `commands` adapter must be unaffected.

- [ ] **Step 2: Implement the handler over the extracted layer**

  Same operations, same isolation: one failing profile is reported as text while the others are
  processed. No second sync implementation, no direct `lib/core.ts` call that bypasses the layer.

- [ ] **Step 3: Register it through the optional path**

  Disposal matches the plugin's existing one-effect shape, so unloading the row removes the command
  the same way it removes the tools.

- [ ] **Step 4: Check the definition against the runtime, the way the tools are checked**

  `test/schema.test.ts` replays the Harness's own validators for tool definitions; the command
  definition deserves the same treatment — the registration contract, and that a handler result of
  either kind satisfies `CommandResult`.

- [ ] **Step 5: Document the second entry point**

  `docs/user/reference/tools.md` gains the command family, both READMEs point at it, and the
  CHANGELOG entry says what a user gains: a deterministic way to run an operation without the model
  deciding to.

  Run: `npm test && npm run typecheck`
  Expected: green, with the new suite and every count updated.

### Task 9: The settings page

The one product-shaped item left, and the only one without a design. **Two findings the repository
already recorded are blockers, not details** — until they are answered with evidence, a spec would
be guessing:

1. **The active profile has no Web UI.** The `dsh-tui` profile composes the terminal interface; the
   `dsh-web-app` bundle that provides the browser surface and the settings slots is disabled there.
   A settings page has nowhere to render until this plugin is also installed into a web-composing
   profile, or the web bundle is enabled for `dsh-tui`.
2. **Client-to-Host calls need a supported channel.** The shipped, typed route is the settings
   domain (`ctx.remote.settings.*`, or the `ctx.configForms` wrapper), which requires the Host half
   to declare a settings namespace — and that means importing the Harness's `schemastery` from a
   workspace-installed bundle, which is unverified for a non-shipped bundle. The alternative, the
   raw `ctx.connection.rpc` channel, is fully typed but has no shipped consumer outside the API
   gateway.

- [ ] **Step 1: Timebox a spike and answer both with evidence**

  Which profile composes `dsh-web-app` on this machine, and what a workspace-installed bundle can
  reach without importing Harness code. Record commands and observed output, not conclusions.

- [ ] **Step 2: Write the design spec first**

  `docs/spec/<date>-settings-page-design.md`: what the page shows (the profile list, each profile's
  status, and the actions that follow from it), how it reaches the Host, which slots it registers,
  which theme tokens it uses, and what it does when `gh` is missing or unauthenticated.

- [ ] **Step 3: Implement it behind that design**

  The client page is not written; `README.md` currently lists `client.js` as a file that does not
  exist yet, so the layout block and that listing move with the change. The Host side needs the RPC
  methods the page will call, on top of Task 7's operation layer. Verify in the Harness Web UI, in
  both themes, beside a comparable host page.

### Decisions this plan does not make

- **Which override mechanism issue #4 gets.** *Settled by
  [the device-override design](../spec/2026-09-30-device-override-design.md):* a device-local JSON file
  of `canonical`/`local` literal pairs, substituted as text in the tracked file rather than by parsing
  and re-serialising it. The constraint this plan named decided it — the repository ships no YAML parser
  and will not add one — and a second argument turned out to be the sharper one: a re-serialised
  canonical form cannot equal the bytes a device without an override uploaded verbatim, so `in-sync`
  would be unreachable for exactly the mixed fleet the feature exists for. The structured per-key reader
  is deferred, with its shape and its trigger written down, rather than rejected.
- **Whether Task 7 moves ahead of Task 6.** Extracting the operation layer first gives issue #4's
  new "overridden locally" reporting a single home, at the cost of putting a refactor in front of a
  filed defect. The order above keeps the defect first; swapping the two is defensible and changes
  no acceptance criteria.
- **Whether the two issues ship inside `0.3.0`.** If they land before Task 3, the release notes
  carry them; the order above puts them in their own minor (0.4.0) so each feature's notes are
  written for its own release.
- **The next release's version number.** `0.3.0` is argued above; `0.2.1` is defensible if the
  runtime-support line is considered a fix.
- **Whether the safety suite should be split.** It is 1,263 lines and shares one fixture
  deliberately. If it is split, that is its own pull request with its own reasoning, not a rider on
  anything here.
- **Whether the release job should prove every declared dsh version.** It currently installs the
  declaration as a whole — the newest entry — while CI's `schema` job installs each one. The tagged
  commit was proved per version by CI before the tag existed, so this is about the release job's own
  log telling the whole story, not about coverage that is missing.
- **Whether to publish the package.** It is `private: true` and installed by link. Publishing
  changes what the `dist/` question means.

### Not in scope

- **Bootstrapping a second device from an existing gist.** Issue #4 names it out of scope and it is
  a defect in its own right: `gist_download` refuses a profile with no state record as
  `not tracked yet`, and the first upload mints a *new* gist instead of finding the existing one,
  because a gist is only reachable through the machine-local `state.json`. It changes what the state
  file means as a bootstrap record, so it needs its own issue and its own plan rather than a rider
  here. File it when Task 6 lands.
- **Syncing the *set of installed plugins* per device** — the `web` profile example in issue #4,
  where the gist holds `"dependencies": {}` and this machine installs three bundles. Related in
  shape, different feature; the override layer must at least not make it worse.
- Nothing about the compatibility gate's design: it is the Harness's, not ours, and the repository's
  job is to declare versions it can verify.
- No new agent tool. The four tools are the surface; `/gist` is a second entry point over the same
  operations, and the settings page is the missing view, not a fifth tool.