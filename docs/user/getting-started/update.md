# Updating

This page is the long form of two things the README says in passing: what to do after the checkout
changes, and what to do when dsh itself moves to a new version. Both were learned the hard way — a
declaration that named one exact dsh version stopped the plugin loading the day the platform shipped
the next one, and an edit to `index.ts` or `lib/core.ts` reaches nothing until `dist/` is rebuilt.
The install itself is [install.md](install.md); the README's [Install](../../../README.md#install)
section is the short version of both pages.

## The two moving parts

Because an install is a `link:` to the checkout, the profile reads this package's files out of the
working copy. What a running session sees is then decided by two separate things:

- **What it loads is `dist/`.** `exports["."]` names `./dist/index.js`, and the sources
  [`index.ts`](../../../index.ts) and [`lib/core.ts`](../../../lib/core.ts) are never loaded by the
  Harness. The suites and the scripts run from source under Node's own type stripping; the package
  itself cannot, because a profile reaches it through a junction under `node_modules` and Node
  refuses to strip types there.
- **Whether it loads at all is `peerDependencies`.** Before a profile loads a bundle, the Harness
  reads that bundle's `peerDependencies` for any `@deepseek-ai/dsh*` entry and skips the whole
  bundle when the installed dsh does not satisfy it. It reads the declaration only: it never loads
  the plugin to find out whether it would have worked.

## After changing the sources

```bash
npm run build           # tsc -p tsconfig.json → dist/, the JavaScript the Harness loads
npm run build:watch     # the same, watching — keep it running while you work
```

Then restart dsh. `build:watch` keeps `dist/` in step with the sources while you work, but a running
process holds the module generation it loaded at start; the README's
[Development](../../../README.md#development) section puts the change of behaviour the other way
round — a reload picks up whatever `dist/` holds at that moment.

Skipping the rebuild is the quieter mistake of the two: an unbuilt edit is invisible, so the four
tools simply keep their previous behaviour and nothing reports a problem. Three commands build for you
rather than letting that happen: `npm test` compiles first through its `pretest` step, so a test run
cannot exercise a stale `dist/`, and `npm run test:entry` and `npm run test:guards` build first because
they read what the build emits — the first loads the plugin the way the Cordis loader does, by package
name through `exports`, and the second checks that `exports` and `files` still name artifacts that
exist.

## When dsh moves to a new version

This is the case that fails silently, so it is worth stating as the procedure the repository learned
from shipping it wrong.

The defect: `peerDependencies` named one exact version, `0.1.7-rc.2`. When dsh updated to
`0.2.0-rc.2`, the gate did exactly what it says — the bundle was skipped before any of its code ran,
the loader's `dsh: skipping profile bundle` line was the only sign, and the four tools were gone
from every session. Nothing inside the plugin had changed: `test/schema.test.ts` replayed the
0.2.0-rc.2 validators without an edit, which is what makes this a declaration fix rather than a
port.

The declaration is now the verified list `0.1.7-rc.2 || 0.2.0-rc.2`, and the procedure for extending
it is:

1. **Add the new version to the list** in [`package.json`](../../../package.json). Versions are
   spelled out rather than written as a range because the platform ships prereleases and semver's
   `^` does not cross them: `^0.1.7-rc.2` stops below `0.2.0-rc.2`.
2. **Let CI install it and verify it.** The `targets` job in
   [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) reads the `||` list out of the
   declaration itself, so the matrix cannot drift from it, and the `schema` job runs one leg per
   declared version:
   [`.github/actions/install-harness`](../../../.github/actions/install-harness/action.yml) installs
   that dsh for real, then `npm run test:schema` exercises the hand-written tool definitions against
   the Harness's own validators, including the loader's compatibility gate called on this
   repository's `package.json`. A declared target that nothing installs is a claim, not a check.
   Locally, `npm run test:schema` runs the same contract against your installed Harness, and it
   fails rather than skipping when it cannot find one.
3. **Restart dsh.** The gate is read when a bundle is loaded, not on every tool call, so the
   corrected declaration takes effect on the next load. After that the bundle composes against the
   new runtime and the four tools are back.

The repository's rule is to declare the version and let CI verify it, not to remove the
`peerDependencies` entry to get past the gate, and not to grant an exact-version exemption instead
of declaring a version CI can verify — [`AGENTS.md`](../../../AGENTS.md) lists both as prohibited,
and [release-process.md](../../contributor/release-process.md) covers the release that carries the
change.

For someone using an installed bundle, the same change has a user-side sequence: update the
checkout, rebuild `dist/`, restart dsh. The bundle does not have to be reinstalled, because the
`link:` dependency and the junction already point at the checkout ([install.md](install.md)); the
declaration in the checkout is what decides whether the new dsh version loads it at all.

## Why a restart is required

A restart is what composes the profile again: bundles are re-read, the compatibility gate is
re-evaluated, and this package's module generation is loaded fresh from `dist/`. The README's
[Install](../../../README.md#install) section states the rule directly — after an install, a restart
is needed before a new module generation loads — and the same holds for every change on this page,
because a running process keeps the JavaScript it already imported.

What you see if you skip it is an absence, not an error:

- After a rebuild without a restart, the tools keep the behaviour the process loaded, and the
  compiler's output sits unused on disk.
- After a declaration change without a restart, the four tools are still absent from the session,
  with `dsh: skipping profile bundle` in the loader's log as the only line that names a reason.
- After a missing `dist/`, the entry point is not there at all, and the four tools never register —
  `npm run test:entry` is the local check that the export still names a build that exists.

When the four tools are missing and the reason is not obvious, start with
[troubleshooting/index.md](../troubleshooting/index.md). The README's [the safety
model](../../../README.md#the-safety-model) section explains why the plugin refuses rather than
guessing when it is unsure.
