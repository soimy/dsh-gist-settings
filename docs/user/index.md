# User documentation

This section is the long form for someone who uses the plugin rather than changes it: installing it,
keeping it working across a dsh upgrade, and getting out of a sync that went wrong. The
[README](../../README.md) stays the short form, and each page below names the section that owns its
summary.

## The pages

- [Install](getting-started/install.md) — what `install_bundle` writes into a profile, what has to
  be true of the machine first, how to check that the four tools loaded, and how to uninstall. Short
  version: the README's [Install](../../README.md#install) and
  [Requirements](../../README.md#requirements) sections.
- [Update](getting-started/update.md) — why `dist/` is what the Harness loads, when to rebuild, when
  a restart is required, and what to do when dsh moves to a version this plugin does not declare.
  Short version: README [Install](../../README.md#install) and
  [Development](../../README.md#development).
- [Tools](reference/tools.md) — the four tools parameter by parameter: arguments, the text a call
  returns, refusals, and per-profile failures. Short version: README [Tools](../../README.md#tools)
  and [Status vocabulary](../../README.md#status-vocabulary).
- [Configuration](reference/configuration.md) — every key, its type, its default, how its value is
  resolved, and the validation that refuses a value it cannot use. Short version: README
  [Configuration](../../README.md#configuration).
- [Recovery](reference/recovery.md) — what to do after a refused or failed operation: a divergence,
  a tracked file missing locally, a failed download, a profile directory that is gone. Short
  version: README [the safety model](../../README.md#the-safety-model).
- [Troubleshooting](troubleshooting/index.md) — the bundle is installed but the tools are absent,
  `gh` is missing or logged out, a status reads `unknown`, an operation reports a held lock. Short
  version: README [Requirements](../../README.md#requirements) and CONTRIBUTING's [Reporting a
  problem](../../CONTRIBUTING.md#reporting-a-problem).

## Where else to look

- [`docs/index.md`](../index.md) is the map of the whole documentation tree, contributor pages
  included.
- [`CHANGELOG.md`](../../CHANGELOG.md) is what changed and when; [Releases](../releases/index.md)
  indexes it.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) is where a problem report goes and what it should
  contain: your `gist_status` output, the exact tool call, and your versions — with secret gist URLs
  reduced to their first few characters and inline keys replaced with `<redacted>`.
