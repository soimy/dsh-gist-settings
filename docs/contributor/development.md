# Development

This page is the long form of [Development setup](../../CONTRIBUTING.md#development-setup) and
[Development](../../README.md#development): the exact commands, what each one does to the tree, and the
constraints every file here has to satisfy. For the two-module split and for why the Harness loads
`dist/` rather than the sources, read [Architecture](architecture.md) instead; for the suites and CI,
read [Testing](testing.md).

## Setup

From a checkout — or, as the repository's own rules ask, from a worktree under `.worktrees/<name>` —
one install and one command:

```bash
npm install --include=dev
npm test
```

The install adds the pinned toolchain declared in `package.json` — `typescript` at `5.9.3` and
`@types/node` at `22.20.4`, the latter with its own single transitive dependency, `undici-types` — and
nothing else is needed, because the plugin has no *runtime* dependency: `lib/core.ts` imports only
`node:` built-ins, `index.ts` imports nothing from the Harness installation, and this package installs
no dependency of its own into a profile.

`--include=dev` is load-bearing rather than decorative. npm omits devDependencies whenever
`NODE_ENV=production`, and an install that omits them exits 0 having installed nothing — so the failure
does not appear at install time, when it would be obvious, but later as a missing `tsc` in the middle of
a build. CI installs with the same flag, for the same reason.

There is deliberately no lockfile, and therefore no `npm ci`: the package has no runtime dependencies to
pin, and `npm ci` refuses to run without a lockfile. The two exact-pinned devDependencies are the whole
toolchain.

`npm test` is not only the suites: its `pretest` step runs `npm run build` first, so a fresh checkout
compiles `dist/` and then exercises it. What runs, in what order, is [Testing](testing.md). If the
machine has no Harness installation, the schema suite fails rather than skipping; set
`DSH_ALLOW_SCHEMA_SKIP=1` for a run that is not about the tool definitions, or point `DSH_TOOLS_DIR` at
one — [Testing](testing.md) explains both.

`package.json` declares `"engines": { "node": "^22.19 || >=24" }`. That floor is the Harness's, not the
engine's: `@deepseek-harness-tui/dsh-tui` declares `engines: ^22.19 || >=24`, and a plugin nothing can
load is not supported by anything. CI runs one leg on exactly `22.19.0`.

## The build, and the loop

```bash
npm run build           # tsc -p tsconfig.json          → dist/
npm run build:watch     # the same, with --watch --preserveWatchOutput
```

`tsconfig.json` compiles `index.ts` and `lib/**/*.ts` into `dist/`, with `declaration: true` and
`sourceMap: false`. `package.json`'s `exports["."]` names `./dist/index.js` for the runtime and
`./dist/index.d.ts` for types, so `dist/` is not an optimisation: it is the artifact a profile loads.

The build exists because of where the package is loaded from. A profile reaches this package through a
junction inside the profile's own `node_modules`, and Node refuses to strip types for any file it
resolves under `node_modules` — it throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — so the package
cannot be run as raw TypeScript in the place that matters. The same constraint is why
`rewriteRelativeImportExtensions` and `allowImportingTsExtensions` are on: the sources name real files
(`./lib/core.ts`) and the emitted JavaScript has to name what sits next to it (`./lib/core.js`). Neither
the `.ts` spellings in the sources nor the `.js` spellings in `dist/` are mistakes to be corrected by
hand.

`dist/` is regenerated output. It is ignored by git, never edited by hand and never committed;
everything else in the repository — the suites and `scripts/` — is executed straight from TypeScript by
Node's type stripper, which is allowed outside `node_modules`.

The working loop:

1. Keep `npm run build:watch` running in one terminal.
2. Edit `index.ts` or `lib/core.ts`.
3. Run the suite that covers the change directly, for example `node test/sync.test.ts`. Nothing has to
   be built for any suite except `test/entry.test.ts`; [Testing](testing.md) maps behaviour to suite.
4. Run `npm run typecheck` before you commit — it is the only thing that checks the suites themselves.
5. Reload the profile, or reinstall the bundle, to run the new `dist/`.

To exercise the working copy against a real profile, install the checkout as a bundle;
`install_bundle` links the directory rather than copying it, so a reload picks up whatever `dist/` holds
at that moment and an edit that was never rebuilt is invisible. `CONTRIBUTING.md` has the exact
`plugin_manager` call under [Development setup](../../CONTRIBUTING.md#development-setup).

`test/entry.test.ts` is the one exception to step 3's "no build needed". It loads `dist/` the way the
Cordis loader does and refuses to run at all when `dist/index.js`, `dist/lib/core.js` or
`dist/index.d.ts` is missing, printing the two commands that produce them. `npm run test:entry` builds
first; `npm test` does too, through `pretest`.

## What `npm run typecheck` covers, and what it does not

`npm run typecheck` is `tsc -p tsconfig.check.json`. That config extends `tsconfig.json` and changes two
things: `noEmit: true` with `declaration: false`, so it writes nothing, and an `include` that adds
`test/**/*.ts`, `scripts/**/*.ts` and `types/**/*.d.ts` to the runtime's `index.ts` and `lib/**/*.ts`.
(The last pattern matches nothing today: there is no `types/` directory. It is there so ambient
declarations would be checked if one appeared.)

What it covers is every TypeScript file in the repository in one pass — runtime, all nine suites and all
three scripts — against the same pinned `@types/node`. That matters because of how the suites run: Node
erases their types as it loads them, and erasing is not checking. A mistyped test therefore passes
`npm test` and fails only here. CI gives that its own job, on the floor Node version, for exactly this
reason.

What it does not cover:

- **`npm test` does not run it.** The two are separate commands locally and separate jobs in CI, so a
  green `npm test` says nothing about the suites' types. Run both.
- **No artifact is checked.** It emits nothing, so it cannot tell you whether `dist/` exists, whether it
  is stale, or whether `exports` resolves. That is `test/entry.test.ts`'s subject — [Testing](testing.md).
- **Nothing about the Harness's contract.** The registration contract, the supported JSON Schema subset,
  argument validation and the loader's compatibility gate are replayed by `test/schema.test.ts` against
  the installed Harness; the compiler reads this repository only.
- **Nothing that is not TypeScript.** `package.json`, `cordis.patch.yml`, `locale/*.json` and the
  workflows are outside it, and `skipLibCheck: true` means the pinned dependency declarations are not
  re-checked either.

The options that shape what you may write:

| Option | What it buys |
| --- | --- |
| `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch` | The usual strict set, plus two extra checks: an overriding member must say `override`, and a `case` must not fall through into the next one. |
| `module` / `moduleResolution` `nodenext`, `target` / `lib` `es2023` | The package is ESM (`"type": "module"`) and resolves the way Node does. |
| `verbatimModuleSyntax` | A type-only import must be written `import type`; a value import of a type survives stripping and throws at run time. |
| `isolatedModules` | Every file has to be translatable on its own, which is what per-file type stripping requires. |
| `erasableSyntaxOnly` | Refuses syntax the type stripper cannot erase. See below. |
| `forceConsistentCasingInFileNames` | A case-only import mismatch fails here rather than on one of the case-folding filesystems the plugin targets. |
| `skipLibCheck` | The pinned dependency declarations are not re-checked on every run. |
| `allowImportingTsExtensions`, `rewriteRelativeImportExtensions` | Sources name real files; the emitted JavaScript names the file next to it. |
| `types: ["node"]` | The ambient types are Node's, since nothing else may be imported. |

## The erasable-syntax constraint

`erasableSyntaxOnly: true` sits in `tsconfig.json`, and therefore in `tsconfig.check.json`, which
extends it. It refuses any syntax whose compilation emits code instead of erasing a type.

It is on because every TypeScript file in this repository is loaded by Node's type stripper somewhere.
The suites and the scripts are executed from source, and the suites import `../index.ts` and
`../lib/core.ts` directly, so the runtime files are stripped too whenever a test runs — only the `dist/`
that the Harness loads is compiled. Syntax that needs a transform would work in `dist/` and fail in
every suite that imports the same source.

The refusal is enforced, not merely documented. With an `enum`, a `namespace` and a constructor
parameter property in one file, `tsc` reports one error per declaration:

```
probe.ts(1,6): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
```

Node's own stripper refuses the same syntax on its own terms — an `enum` in a file it loads fails with
`SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` —
so the compiler option is not the only guard, just the one that names the line before any suite runs.

What to write instead:

- `enum` — a union of string literal types. The status vocabulary and the action names in `lib/core.ts`
  are written this way (`ProfileStatusName`, `SyncAction`).
- `namespace` — a module: a file, or `import * as name`.
- Constructor parameter properties (`constructor(private readonly value: number)`) — declare the field
  and assign it in the constructor body.
- `import type` for anything used only as a type: `verbatimModuleSyntax` keeps a value import of a type
  in the output, where it throws.

## The `catch` binding

A `catch` binding is `unknown` under `strict`, and the house form is to name what the throw is known to
be, with a comment saying why the cast is honest:

```ts
try {
  await something()
} catch (error) {
  // A `catch` binding is `unknown`; every failure here is an `Error` (`assert` and the
  // runtime both throw them), so this cast names what is already true, and is erased.
  const failure = error as Error
  console.log(`        ${failure.message}`)
}
```

Two things the form must not do — narrow with `instanceof`, or rethrow — because either changes what a
non-`Error` throw does. Where a value's shape is genuinely open, the repository keeps the probe small
and explicit instead: `lib/core.ts` has `errorMessage(error: unknown)`, which falls back to `String()`,
`errorCode(error: unknown)` for a Node `code` such as `ENOENT`, and `isNotFoundError(error: unknown)`
for the one error a gist lookup raises. The suites do the same with a local structural type.

Related rules that the type checker does not express:

- No `any`, no `as any`, no `as unknown as`, no `@ts-expect-error`, no `@ts-ignore`, no
  `eslint-disable`. A cast is acceptable where a guard or a documented producer proves the shape, and it
  carries a comment naming that proof.
- A non-null assertion (`!`) is acceptable only where the preceding lines already prove the value is
  present — an assertion, an existence check, a `throw` guard — and says what guarantees it.
- Comments are documentation here: they explain *why*, not what the line already says. Preserve the ones
  you find while editing around them.
- The four tool definitions are plain objects rather than `defineTool` results, so the bundle imports
  nothing from the Harness and cannot break on a module-resolution change.
  [Architecture](architecture.md) owns that decision; the practical effect is that a change to a tool's
  parameters or return value has to keep `parameters`, `output.schema` and `render` consistent by hand,
  which `test/tools.test.ts` and `test/schema.test.ts` check.

## Commit messages

Conventional-commit style prefixes, an imperative subject under about 72 characters, and a body that
explains **why** when it is not obvious.

Prefixes in use: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`. The convention, with a worked
example, is owned by [`CONTRIBUTING.md`](../../CONTRIBUTING.md#commit-messages).

## Pull requests

Work in a worktree under `.worktrees/<name>` and open a pull request; do not commit to `main`. Pull
requests are expected to be small and single-concern — one that fixes a bug, reformats a file and adds a
feature will be asked to split.

Use the template at
[`.github/pull_request_template.md`](../../.github/pull_request_template.md). The parts that decide the
review:

- **A test that fails without the change.** Not "tests still pass": name the case, and say that you
  watched it fail before the fix. [Testing](testing.md#mutation-discipline) describes the discipline this
  repository follows.
- **Both READMEs.** `README.md` and `README.zh-CN.md` are a pair; a behaviour or configuration change
  that updates only one of them is incomplete.
- **A changelog entry** under `[Unreleased]` for anything user-visible.
- **No secrets in the diff.** No tokens, no real gist URLs, no profile contents — a secret gist URL is a
  bearer read capability.
- **The data-safety section.** Anything that can delete, overwrite or publish answers three questions:

  1. What is backed up before the destructive step, and where?
  2. What happens if that step fails halfway?
  3. How does a user recover?

  The template asks the same three in concrete form — whether the change alters when files are pruned
  from a gist, when a download overwrites local files, and what counts as safe to fast-forward — and
  marks the section as the most important one in the pull request when a change can destroy anything.
  The current answers live in [`README.md`](../../README.md#the-safety-model); read them before changing
  one, and update them if you do. `force` is not a synonym for "do not check": it overrides a specific
  refusal, and widening it is a behaviour change like any other.

Every push to `main` and every pull request runs `npm test` on the platform matrix, plus the type-check
and schema jobs — [Testing](testing.md#continuous-integration) has the shape, including which legs exist
and why one of them is pinned to the Node floor.