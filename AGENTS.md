# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-30
**Type:** DeepSeek Harness (dsh) Cordis Host plugin — profile configuration sync through GitHub Gists

## OVERVIEW

This package backs up and restores a dsh profile's configuration through GitHub Gists, using the `gh`
CLI already installed on the machine. It registers four agent tools — `gist_status`, `gist_upload`,
`gist_download`, `gist_sync` — and holds no UI.

`index.ts` is the Host plugin: it declares the four tool definitions and registers them. `lib/core.ts`
is the sync engine and has no Cordis dependency at all, which is what makes it directly testable. The
Harness loads compiled JavaScript from `dist/`; the suites and the scripts run from source under Node's
own type stripping — see `docs/contributor/architecture.md` for why both are true at once.

Documentation convention for this repository: keep `README.md` the concise project entry page, put
user-facing detail in `docs/user/`, contributor and process detail in `docs/contributor/`, release
notes in `docs/releases/`, agent-authored plans in `docs/plans/`, and design specs in `docs/spec/`. Do
not create tool-specific documentation roots. `docs/index.md` is the map.

For where logic belongs and how the pieces fit, the canonical guide is
`docs/contributor/architecture.md`. For how this repository expects work to be done, read
`CONTRIBUTING.md` (bilingual) and `docs/contributor/documentation.md`.

This repository is licensed under MIT.

## STRUCTURE

```
./
├── index.ts                    # Host plugin: the four tool definitions + registration
├── lib/core.ts                 # Sync engine: config, gh, state, locking, upload/download/sync
├── dist/                       # `npm run build` output — what the Harness loads; never edited, never committed
├── tsconfig.json               # Compiles index.ts + lib/ into dist/
├── tsconfig.check.json         # Type-checks runtime, tests and scripts; emits nothing
├── cordis.patch.yml            # Bundle patch: inserts the plugin row and documents its config
├── package.json                # exports → ./dist/index.js; peerDependencies is the compatibility declaration
├── docs/
│   ├── index.md                # Documentation map
│   ├── user/                   # Install, update, tools, configuration, recovery, troubleshooting
│   ├── contributor/            # Architecture, development, testing, release process, documentation rules
│   ├── releases/               # Release index; the canonical notes are the root CHANGELOG.md
│   ├── plans/                  # Dated agent-authored plans (YYYY-MM-DD-slug.md)
│   └── spec/                   # Dated design specs (YYYY-MM-DD-slug-design.md)
├── test/                       # Nine suites, three helpers; run from source, never compiled
├── scripts/                    # check-changelog, check-docs, release-notes; run from source
└── .github/
    ├── workflows/              # CI (matrix + typecheck + schema job) and release
    ├── actions/install-harness # Composite action, shared by the schema job and the release job
    └── pull_request_template.md
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Tool definitions | `index.ts` | Names, descriptions, parameter schemas, `render`, concurrency verdicts |
| Plugin registration | `index.ts` | `apply(ctx, config)`, `inject = ['tools']`, one labelled effect |
| Sync engine | `lib/core.ts` | Everything the tools execute |
| Configuration | `index.ts` (`readConfig`), resolved by `lib/core.ts` | Validated at load; an unknown key is refused |
| Profiles and paths | `lib/core.ts` (`resolveDshHome`, `resolveProfilesDir`, `resolveStateDir`, `resolveProfileDir`) | Defaults track `$DSH_HOME` |
| Tracked files | `lib/core.ts` (`resolveProfileFiles`, `normalizeTrackedName`) | Containment and case-folding rules |
| `gh` invocation | `lib/core.ts` (`resolveGh`, `ghRun`, `checkAuth`) | Spawn, stdin flushing, timeout, error reporting |
| State and locking | `lib/core.ts` (`loadState`, `saveState`, `withStateLock`) | Atomic write, cross-process lock, reclaim |
| Gist API surface | `lib/core.ts` (`gistCreate`, `gistGet`, `gistPatch`, `gistDelete`) | Truncation and `raw_url` trust rules |
| Status model | `lib/core.ts` (`profileStatus`, `statusAll`, `ProfileStatusName`) | The vocabulary the tools report |
| Upload / download / sync | `lib/core.ts` (`uploadProfile`, `downloadProfile`, `syncProfile`, `syncAll`) | Backups, staging, rollback, force semantics |
| Compatibility declaration | `package.json` + `.github/workflows/ci.yml` | An enumerated list of verified dsh versions; CI installs each |
| What the suites prove | `test/` + `docs/contributor/testing.md` | The mapping from behaviour to suite |
| Repository checks | `scripts/check-changelog.ts`, `scripts/check-docs.ts` | Both run as part of `npm test` |
| Release notes | `CHANGELOG.md` | Canonical; the release job publishes the tagged section |
| Documentation rules | `docs/contributor/documentation.md` | Placement, language pairing, link rules |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `apply` | function | `index.ts` | Registers the four tools through one labelled effect |
| `inject` | const | `index.ts` | `['tools']` — the service the plugin needs |
| `gist_status` / `gist_upload` / `gist_download` / `gist_sync` | tool definitions | `index.ts` | The agent-facing surface |
| `DEFAULT_PROFILE_FILES` | const | `lib/core.ts` | `['cordis.patch.yml', 'package.json']` |
| `STATE_VERSION` | const | `lib/core.ts` | Shape version of the state file |
| `Config`, `State`, `ProfileRecord` | interface | `lib/core.ts` | The persisted and configured shapes |
| `ProfileStatusName` | type | `lib/core.ts` | The eight statuses a profile can report |
| `SyncAction` | type | `lib/core.ts` | `created`, `uploaded`, `noop`, `downloaded`, `restored`, `forced-upload` |
| `resolveGh` | function | `lib/core.ts` | Locates `gh`; returns a reason instead of throwing |
| `ghRun` | function | `lib/core.ts` | Spawns `gh`, writes stdin, reports timeouts and spawn failures |
| `hashFiles` | function | `lib/core.ts` | The content fingerprint the state baseline is built on |
| `loadState` / `saveState` | function | `lib/core.ts` | Reads defensively, writes atomically |
| `withStateLock` | function | `lib/core.ts` | Cross-process critical section, with stale-lock reclaim |
| `profileStatus` / `statusAll` | function | `lib/core.ts` | Compares local content, the gist, and the recorded baseline |
| `uploadProfile` / `downloadProfile` | function | `lib/core.ts` | The two destructive paths; both take backups |
| `syncProfile` / `syncAll` | function | `lib/core.ts` | Fast-forward in whichever direction is safe, or refuse |
| `health` | function | `lib/core.ts` | Reports `gh` resolution, auth state and the resolved paths |

## CONVENTIONS

**Types and syntax**

- `strict`, `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`; `module`/`moduleResolution` are `nodenext`, target `es2023`.
- `erasableSyntaxOnly` is not decoration: every file here runs through Node's type stripper, so `enum`,
  `namespace`, parameter properties and anything else that emits code are refused. Use `const` objects
  and union types instead.
- No `any`, no `as any`, no `as unknown as`, no `@ts-expect-error`, no `@ts-ignore`, no
  `eslint-disable`. A cast is acceptable where a guard or a documented producer proves the shape, and
  it should carry a comment saying which.
- A non-null assertion (`!`) is acceptable only where the preceding lines already prove the value is
  present — an assertion, an existence check, a `throw` guard, or a module-level fact stated where it
  is established. Say what guarantees it.
- A type-only import must be written `import type`; a value import of a type throws at runtime, because
  the stripper keeps it.
- Imports inside the runtime name real files (`./lib/core.ts`) and `rewriteRelativeImportExtensions`
  makes the emitted JavaScript name `./lib/core.js`. Do not "fix" that by hand.

**Comments, errors and tests**

- Comments are documentation here. Preserve them, and explain *why* a thing is done rather than what
  the line already says.
- A `catch` binding is `unknown`. The house form is a short comment plus `const failure = error as
  Error`; do not narrow with `instanceof` and do not rethrow, because both change what a non-`Error`
  throw does. Property probes on a caught value may use a small local structural type, with a comment
  naming the producer's guarantee.
- Never weaken, delete, merge or skip a case. Prefer a case that fails before your change, and verify a
  fix by reverting it by hand. A test that cannot fail is worse than no test.
- A behaviour change must answer three questions in the pull request: what is backed up first, what
  happens if the destructive step fails half-way, and how a user recovers. See `CONTRIBUTING.md`.

**Git and pull requests**

- Conventional-style prefixes in use: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`. Imperative
  subject under about 72 characters; the body explains why, not what.
- A pull request keeps an English title and a body that states what changed, why, and how it was
  verified — including the command that proves it. Use `.github/pull_request_template.md`.
- Work in a worktree under `.worktrees/<name>` and open a pull request; do not commit to `main`.

**Documentation**

- Placement: concise entry page in `README.md`; user detail in `docs/user/`; contributor and process
  detail in `docs/contributor/`; the release index in `docs/releases/`; plans in `docs/plans/`; specs
  in `docs/spec/`. Never open a documentation root named after a tool or an editor.
- `CHANGELOG.md` is canonical for releases and stays at the root: `scripts/check-changelog.ts` validates
  it in `npm test`, and the release job publishes the tagged section from it. `docs/releases/` indexes
  that file; it does not duplicate it.
- Every relative link in every Markdown file is checked by `scripts/check-docs.ts`; a link that does not
  resolve, or that points outside the repository, fails `npm test`.
- `README.md` and `README.zh-CN.md` each link to the other and are kept in step. `CONTRIBUTING.md`
  carries English and Chinese halves in one file. New pages under `docs/` are written in English;
  translate only when the page is meant for users rather than contributors.
- Long form lives in `docs/`, short form in the README and CONTRIBUTING. When you add detail, put it in
  the page that owns it and link from the short form, rather than growing both.

## ANTI-PATTERNS (THIS PROJECT)

**Prohibited**

- Editing anything under `dist/` by hand, or committing it. It is regenerated output.
- Adding a runtime dependency. The plugin imports nothing outside `node:` and ships none; `typescript`
  and `@types/node` are development tools.
- Importing anything from the Harness installation. Declaring the Harness as a peer is the only
  coupling there is, and it is what keeps the bundle immune to module-resolution changes.
- Removing the `peerDependencies` entry to get past the compatibility gate, or granting an exact-version
  exemption instead of declaring a version that CI can verify. The gate is a safety net for a plugin
  that rewrites profile files.
- Widening the declared dsh versions without letting CI install each one — a declared target that
  nothing installs is a claim, not a check.
- Weakening a test to make a change pass, or skipping a suite rather than failing it.
- Introducing a second source of truth for release notes, or a second copy of the compatibility
  declaration.
- Swallowing an error to make a run look green. Every refusal in this codebase names what failed.

**Careful**

- `force` is not a synonym for "do not check". Read `docs/user/reference/recovery.md` before changing
  what it overrides.
- The state file and the lock are shared between processes. Anything that reads or writes them belongs
  inside `withStateLock`.

## COMMANDS

```bash
npm install --include=dev      # one-time setup; --include=dev is load-bearing, not decorative
npm run build                  # tsc -p tsconfig.json → dist/, the JavaScript the Harness loads
npm run build:watch            # the same, watching — keep it running while you work
npm run typecheck              # tsc -p tsconfig.check.json: runtime, tests, scripts; emits nothing
npm test                       # builds first (pretest), then 187 cases and the repository checks
npm run test:entry             # the package export a profile loads
npm run test:sync              # engine lifecycle against a fake gh
npm run test:tools             # tool layer, argument validation, failure isolation
npm run test:schema            # definitions vs. the installed Harness validators + the loader's gate
npm run test:regression        # the defects the adversarial reviews found
npm run test:safety            # containment, atomic writes, forced deletion, recovery, locking
npm run test:release           # the release-notes script and every way it refuses a tag
npm run test:docs              # the documentation link checker
npm run changelog:check        # CHANGELOG.md structure and version consistency
npm run docs:check             # every relative link in every Markdown file
npm run release:notes -- v1.2.3  # print the changelog section a tag would publish
npm run test:live              # opt-in; creates and deletes a real secret gist
```

## NOTES

**How a running Harness finds this package.** A profile installs the bundle as a link: the profile's
`package.json` records `"@local/dsh-gist-settings": "link:…"` and a junction under the profile's
`node_modules` points at the checkout. The Harness therefore loads `dist/index.js` from the working
copy: after editing `index.ts` or `lib/core.ts`, run `npm run build` (or keep `build:watch` running) and
restart — an unbuilt edit is invisible, and a missing `dist/` leaves the four tools unregistered.

**The compatibility gate.** Before a profile loads a bundle, the Harness reads that bundle's
`peerDependencies` for any `@deepseek-ai/dsh*` entry and skips the whole bundle when the installed dsh
does not satisfy it. It reads the declaration only — it never loads the plugin to find out whether it
works — so the declaration is a promise, not a formality. This repository declares an enumerated list of
verified versions (`0.1.7-rc.2 || 0.2.0-rc.2`), and CI installs every version in that list and runs the
loader's own `evaluatePluginCompatibility` against the manifest, so a broken declaration fails a build
rather than a user's profile.

**Test knobs.** `DSH_ALLOW_SCHEMA_SKIP=1` accepts the schema suite's skip when no Harness is installed
(the CI matrix sets it; the `schema` job does not). `DSH_TOOLS_DIR` points the suite at a specific
installation. `DSH_GIST_LIVE_TEST=1` enables the live suite, which needs real GitHub access.

**Releases.** Version bumps, the changelog section, the tag and what the release job verifies are
documented in `docs/contributor/release-process.md`. In short: `CHANGELOG.md` is canonical, the tag
publishes from it, and the release job re-runs the suites, the type check and the schema contract before
it publishes anything. Be precise about that last one: the release job hands the action no version, so
it installs the declaration as a whole and npm resolves the newest entry in it — CI's `schema` job is
what installs each declared version in turn.