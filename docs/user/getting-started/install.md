# Installing into a profile

This page is the long form of the README's [Install](../../../README.md#install) section: what the
bundle is, what an `install_bundle` call writes into a dsh profile, what has to be true of the
machine first, how to tell that it worked, and how to take it out again. Install is also the
prerequisite for [update.md](update.md), which assumes what this page sets up.

## What this package installs

This is a Cordis **bundle**, not a plugin row you place by hand.
[`package.json`](../../../package.json) carries a bundle patch — the field `"dsh": { "bundle": {
"patch": "./cordis.patch.yml" } }` — pointing at the repository's `cordis.patch.yml`, which inserts
one row, `dsh-gist-settings`, naming `@local/dsh-gist-settings`. That row is what registers the four
agent tools: `gist_status`, `gist_upload`, `gist_download` and `gist_sync`.

The package is never published to a registry. `"private": true` means it exists only to be installed
as a local bundle, and `exports["."]` names `./dist/index.js` with `./dist/index.d.ts` beside it —
the build, not the sources.

## Before you install

**A dsh version this plugin declares.** `peerDependencies` reads `"@deepseek-ai/dsh": "0.1.7-rc.2 ||
0.2.0-rc.2"`, an enumerated list of the versions this plugin has been verified against rather than a
range. The gate that reads it is strict and reads nothing else. Before a profile loads a bundle, the
Harness reads that bundle's `peerDependencies` for any `@deepseek-ai/dsh*` entry and skips the whole
bundle when the installed dsh does not satisfy it; it never loads the plugin to find out whether it
would have worked. A dsh version outside the list therefore produces no tools at all —
[update.md](update.md) walks through that case, and it is the first thing to check when the tools
are missing. The declaration is spelled out rather than written as a range because the platform
ships prereleases and semver's `^` does not cross them: `^0.1.7-rc.2` stops below `0.2.0-rc.2`.

**Node `^22.19 || >=24`.** That floor is `engines` in [`package.json`](../../../package.json), and
it is the Harness's floor rather than this engine's: `@deepseek-harness-tui/dsh-tui` declares
`engines: { node: "^22.19 || >=24" }`, and nothing can load a Harness plugin without a Harness. The
engine's own code would need less — `node:` built-ins, `AsyncLocalStorage`, and `AbortSignal.any`
(20.3) to put one deadline on the global `fetch` that reads truncated gist content — but a floor
nobody can run the plugin on is not a floor worth naming. CI runs one leg on 22.19.0 itself, so the
claim is tested rather than asserted.

**`gh`, installed and authenticated.** Every gist read and write goes through `gh api`, so no extra
OAuth scopes are needed beyond the default, and the plugin never stores, reads or asks for a token
of its own — `gh` owns the credential:

```bash
gh auth login
```

If `gh` is not on the `PATH` of the process running the Harness — common on Windows right after
installing it — the plugin probes the usual install locations before giving up, and the `ghPath`
config key names the binary explicitly when the probe is not enough
([configuration.md](../reference/configuration.md)).

**A session allowed to manage plugins.** `plugin_manager` refuses an install without full access or
an approval prompt. An install can also ask for approval of package build scripts; this bundle has
none, and it declares no runtime dependency — only two exact-pinned devDependencies, `typescript`
and `@types/node`.

**A built checkout.** The Harness loads `dist/`, and `dist/` is generated output that is never
committed, so a fresh clone starts without it:

```bash
npm install --include=dev
npm run build
```

`--include=dev` is load-bearing rather than decorative: npm omits devDependencies whenever
`NODE_ENV=production`, and such an install exits 0 having installed nothing, which reads as success
right up until `tsc` is missing.

## The install call

```
plugin_manager  action: install_bundle  target: <absolute path to this checkout>
```

The call writes four things:

- **A dependency in the profile's `package.json`.** The package's own `"name"` field decides the key
  — `@local/dsh-gist-settings` — and a local directory target is recorded as a `link:` entry
  pointing at this checkout, so the profile depends on the directory rather than on a copy of it.
- **A selection in `dsh.profile.bundles`**, in that same file, with `@local/dsh-gist-settings`
  appended. That list is the profile's bundle selection.
- **A link under the profile's `node_modules`**, named `@local/dsh-gist-settings` and pointing at
  the checkout — a junction on Windows, a symlink where the platform uses one. This is the junction
  the README means when it describes how a profile reaches this package, and it is why the package
  cannot be run as raw TypeScript: Node refuses to strip types for a file it resolves under
  `node_modules`, with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
- **The bundle patch applied.** The row in `cordis.patch.yml` becomes part of the profile's
  composition with every config key at its default. Tuning it means editing the row's `config:`
  block in the profile's own patch layer, which is also what makes the values survive a plugin
  upgrade — see [configuration.md](../reference/configuration.md).

Do not add the dependency or the bundle row by hand: `install_bundle` owns the selection.

## What "installed" means for a running Harness

Installing only links the directory; nothing is copied. The profile resolves this package out of the
checkout through `exports["."]`, which names `./dist/index.js`, so what a running Harness picks up
is whatever `dist/` holds at that moment. Two consequences follow:

- Rebuilding the checkout changes the live plugin. [update.md](update.md) is that procedure.
- A missing `dist/` — a clone that was never built, or one whose build output was deleted — leaves
  the four tools unregistered, because the package's entry point does not exist.

The README's [Development](../../../README.md#development) section states the same fact from the
other side: the working copy is the live plugin, and the Harness still never loads the sources.

## Did it work?

Restart dsh. The README's [Install](../../../README.md#install) section states that a restart is
needed afterwards, before a new module generation loads, so a process that is already running keeps
what it already loaded.

Then the four tools should be callable from a session, and the cheapest check is `gist_status`: it
reports whether `gh` is installed and authenticated, then lists every profile with its gist URL and
sync state, without touching profile files or the gist. Its answer is one of these shapes:

- A profile with no gist yet reads `not tracked`.
- A machine where `gh` is missing or logged out reads `unknown - gh is unavailable, remote state not
  checked`; the call still answers, from the local tracking record alone.

The full vocabulary is in the README's [status vocabulary](../../../README.md#status-vocabulary),
and [tools.md](../reference/tools.md) documents every argument and the text a call returns.

If the four tools are absent from the session rather than failing when called, the bundle did not
load. Check the installed dsh version against the declaration in
[`package.json`](../../../package.json) first; the loader's own `dsh: skipping profile bundle` line
is the sign that the gate refused it. [troubleshooting/index.md](../troubleshooting/index.md) takes
it from there.

## Uninstalling

```
plugin_manager  action: remove_bundle  target: @local/dsh-gist-settings
```

The gists the plugin created are **not** touched. To remove those too, delete them on GitHub — the
URLs are in `state.json` — and then delete the state directory:

```
<stateDir>            # default: <dshHome>/gist-settings
```

That directory holds `state.json` (the profile → gist mapping), `state.json.bak`, every backup the
plugin has taken, and `state.lock` for as long as an operation is writing. Deleting it loses the
mapping and the local backups, but not the gists. The defaults, and how each path is resolved, are
in [configuration.md](../reference/configuration.md).

One leftover is harmless and expected. A download creates a short-lived
`.dsh-gist-settings-staging-<pid>-<time>` directory inside the profile it is writing to, so the new
content can be staged on the same volume before anything tracked is touched. A killed process can
leave one behind; it is inert — never tracked, never uploaded, skipped when profiles are listed —
and the download's own `finally` removes it on every normal path.

## Where to go next

- [update.md](update.md) — rebuilding, restarting, and what to do when dsh moves to a new version.
- [tools.md](../reference/tools.md) — the four tools in full.
- [configuration.md](../reference/configuration.md) — the keys and the patch layer they live in.
- [recovery.md](../reference/recovery.md) — what to do after a refused or failed operation.
