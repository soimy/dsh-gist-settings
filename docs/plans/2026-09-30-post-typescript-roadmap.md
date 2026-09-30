# Post-TypeScript Roadmap Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking, and every step states how it is verified. Designs belong in `docs/spec/`, plans belong in `docs/plans/`. Work happens in a worktree under `.worktrees/<name>` and reaches `main` through a pull request.

**Goal:** Close out the TypeScript migration, turn the dsh compatibility declaration into routine maintenance rather than an outage, and finish the planned work that is still open: a guard suite, repository hygiene, and the settings page.

**Context:** Everything merged since `0.2.0` is still under `[Unreleased]`. In that window the runtime moved to TypeScript and started compiling into `dist/`; the nine suites and three scripts moved to TypeScript and run from source under Node's type stripper; CI gained a repository-wide type-check job and a schema job that installs every declared dsh version and runs the loader's own compatibility gate; and the peer declaration became an enumerated list after dsh `0.2.0-rc.2` skipped the bundle outright.

**Tech stack:** TypeScript executed from source by Node's type stripper (floor `^22.19 || >=24`), `tsc` for the compiling half, plain `node` scripts instead of a test framework, GitHub Actions with SHA-pinned actions, `gh` for everything GitHub-facing.

---

### Task 1: Close the migration's verification gap

The migration changed code that CI cannot reach, and one thing a user sees cannot be checked from a build log.

**Files:** none required. If the restart turns up a surprise, the fix belongs with the code that caused it, and a note belongs in `docs/user/troubleshooting/index.md`.

- [ ] **Step 1: Confirm a running Harness loads the bundle again**

  Run: `dsh --profile dsh-tui --dump-config`
  Expected: no `skipping profile bundle` line, and a `dsh-gist-settings` row in the composed profile. This was the reported failure; the merged declaration is what fixes it.

- [ ] **Step 2: Restart dsh and confirm the four tools are registered**

  Run: call `gist_status` from a session.
  Expected: a status report listing the profiles and their state. A session that started while the bundle was skipped has no `gist_*` tools at all, so this is the proof that the restart picked the fix up.

- [ ] **Step 3: Run the live suite once against the migrated source**

  Run: `$env:DSH_GIST_LIVE_TEST='1'; npm run test:live`
  Expected: 12/12 passed. It creates and deletes a real secret gist.
  Why now: it is the only suite CI never runs, and the migration rewrote 71 lines of it — type annotations, a re-wrapped signature, and a typed predicate where `.filter(Boolean)` used to be.

### Task 2: Release 0.3.0

**Files:** `package.json`, `CHANGELOG.md`, `docs/releases/index.md`, `docs/releases/latest.md`

- [ ] **Step 1: Freeze the changelog section**

  Turn `## [Unreleased]` into `## [0.3.0] - <date>`, add a fresh empty `[Unreleased]`, and update the link definitions at the bottom of the file.

  Run: `npm run changelog:check`
  Expected: `CHANGELOG.md OK: 3 released versions, newest 0.3.0 (<date>), plus [Unreleased].`

- [ ] **Step 2: Bump the version and move the release index**

  Set `version` to `0.3.0`, add a row to `docs/releases/index.md`, and point `docs/releases/latest.md` at the new section.

  Run: `npm run release:notes -- v0.3.0`
  Expected: the `0.3.0` section on stdout. A version that disagrees with `package.json` must refuse.

- [ ] **Step 3: Merge the release pull request, then tag it**

  PR title `chore: release 0.3.0`. After it merges: `git tag v0.3.0 && git push origin v0.3.0`.

  Run: watch the `release` workflow.
  Expected: it re-runs `npm test`, `npm run typecheck` and the schema contract, generates the notes from
  the tagged section, and creates the GitHub release with `--verify-tag`. Note that this job passes the
  composite action no version, so it installs the declaration as a whole and npm resolves the newest
  entry: the *per-declared-version* proof is CI's `schema` job, which ran on this same commit before the
  tag existed. Whether the release job should prove each version itself is one of the open decisions
  below.

  Why `0.3.0` rather than `0.2.1`: it adds a supported runtime line and a new distribution model (compiled `dist/`), not only a fix.

### Task 3: A tenth suite for the invariants nothing currently checks

The suites test behaviour. Nothing tests the properties that make this repository work at all: that every file is still strippable, that imports name real files, that the packaging points at things that exist. Each of the following should be written the way this repository writes tests — revert the invariant by hand, watch the case go red, then restore it.

**Files:** `test/guards.test.ts` (new), `package.json` (a `test:guards` script and a place in the `test` chain), then the counts in `CONTRIBUTING.md` and both READMEs, `docs/contributor/testing.md`, and a `CHANGELOG.md` entry.

- [ ] **Step 1: Every TypeScript file still strips**

  Run `module.stripTypeScriptTypes` over `index.ts`, `lib/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`.
  Expected: no throw. `erasableSyntaxOnly` protects this at compile time; nothing protects it at runtime, and a `.ts` file that fails to strip fails only when someone runs it.

- [ ] **Step 2: Every relative import names a file that exists**

  Expected: no import in those files resolves to nothing, and the runtime's imports still end in `.ts` rather than `.js`.

- [ ] **Step 3: No stray JavaScript**

  Expected: no `.js` or `.mjs` file under `test/` or `scripts/`, and none at the root — `dist/` and `node_modules` are the only places compiled output may live.

- [ ] **Step 4: The packaging points at things that exist**

  Expected: every path in `exports` and `files` exists after `npm run build`, and `exports["."]` still names `./dist/index.js` rather than a source file. This is the boundary the entry suite crosses; this case is what catches a rename that breaks it.

- [ ] **Step 5: Nothing is written that nobody runs**

  Expected: every `test/*.test.ts` and `scripts/*.ts` is named by a package script. `live` is the one documented exception — it is opt-in by design.

- [ ] **Step 6: The compiler flags that make stripping safe are still on**

  Expected: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `isolatedModules` and `strict` are all present in `tsconfig.json`. A silent removal turns the whole model off without failing anything else.

- [ ] **Step 7: The engine floor is still the Harness's floor**

  Expected: `engines.node` is `^22.19 || >=24`, with a comment saying whose floor it is. The CI matrix already proves the code runs there; this case is what stops the declared floor drifting away from it.

  Run: `npm test`
  Expected: one more suite, and every count updated to match.

### Task 4: Repository hygiene

- [ ] **Step 1: Bring the action pins up**

  `actions/checkout` is pinned at v4.2.2 and `actions/setup-node` at v4.0.4; upstream is at v7.0.1 and v7.0.0, and the v4 line runs on the Node 20 action runtime GitHub has been retiring. Bump one major at a time, keep the SHA pin and the version comment, and let CI prove each step.

  Run: one full CI run per bump.
  Expected: green, with no new deprecation annotations.

- [ ] **Step 2: Decide the lockfile question**

  This repository commits no lockfile and `.gitignore` documents that `npm ci` is therefore unsupported. That was cheap when the package had no dependencies; every CI leg now installs `typescript` and `@types/node`, so the install is a real dependency resolution on every run.

  Decision: commit `package-lock.json` and switch CI to `npm ci`, or keep the current stance and say why in `CONTRIBUTING.md`.

- [ ] **Step 3: Decide the `dist/` distribution model**

  `dist/` is regenerated output and is not committed. That is right for this machine, where the profile installs the checkout by link. The open question is what anyone else would use: a release asset, or nothing until publishing is on the table.

### Task 5: The settings page

The one product-shaped item left, and the only one without a design.

- [ ] **Step 1: Write the design spec first**

  `docs/spec/<date>-settings-page-design.md`: what the page shows (the profile list, each profile's status, and the actions that follow from it), how it reaches the Host, which slots it registers, which theme tokens it uses, and what it does when `gh` is missing or unauthenticated.

- [ ] **Step 2: Implement it behind that design**

  `client.js` is a placeholder today, the locale cards exist, and the Host side needs the RPC methods the page will call. Verify in the Harness Web UI, in both themes, beside a comparable host page.

---

### Decisions this plan does not make

- **The next release's version number.** `0.3.0` is argued above; `0.2.1` is defensible if the runtime-support line is considered a fix.
- **Whether the safety suite should be split.** It is 1,263 lines and shares one fixture deliberately. If it is split, that is its own pull request with its own reasoning, not a rider on anything here.
- **Whether the release job should prove every declared dsh version.** It currently installs the declaration as a whole — the newest entry — while CI's `schema` job installs each one. The tagged commit was proved per version by CI before the tag existed, so this is about the release job's own log telling the whole story, not about coverage that is missing.
- **Whether to publish the package.** It is `private: true` and installed by link. Publishing changes what the `dist/` question means.

### Not in scope

- Nothing about the compatibility gate's design: it is the Harness's, not ours, and the repository's job is to declare versions it can verify.
- No new tool. The four tools are the surface; the settings page is the missing view, not a fifth tool.