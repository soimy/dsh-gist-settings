# Documentation

This directory holds the long form. The root files stay the short form, and each page here says which
README or CONTRIBUTING section owns the summary it expands.

## Where to look

| Question | Read |
| --- | --- |
| What is this, and does it work? | [`README.md`](../README.md) — status, requirements, install, the safety model, review history |
| How do I install it into a profile? | [Install](user/getting-started/install.md) |
| How do I keep it working when dsh updates? | [Update](user/getting-started/update.md) |
| What do the four tools do, exactly? | [Tools](user/reference/tools.md) |
| What can I configure? | [Configuration](user/reference/configuration.md) |
| A download failed, or a profile diverged — what now? | [Recovery](user/reference/recovery.md) |
| The plugin is not loading, or a tool is missing | [Troubleshooting](user/troubleshooting/index.md) |
| How is it built, and why is there a `dist/`? | [Architecture](contributor/architecture.md) |
| How do I work on it? | [Development](contributor/development.md) |
| What do the nine suites prove? | [Testing](contributor/testing.md) |
| How is a release cut? | [Release process](contributor/release-process.md) |
| How should documentation be written here? | [Documentation rules](contributor/documentation.md) |
| What changed, and when? | [`CHANGELOG.md`](../CHANGELOG.md), indexed by [Releases](releases/index.md) |
| What is planned next? | [Post-TypeScript roadmap](plans/2026-09-30-post-typescript-roadmap.md) |
| What are the rules for an agent working here? | [`AGENTS.md`](../AGENTS.md) |

## The shape of this documentation

- **`docs/user/`** — what someone using the four tools needs: installing, updating, the tool
  reference, the configuration reference, recovery, troubleshooting.
- **`docs/contributor/`** — what someone changing the code needs: architecture, development, testing,
  the release process, and the rules this documentation itself follows.
- **`docs/releases/`** — the release index. The canonical notes are the root `CHANGELOG.md`, because
  `scripts/check-changelog.ts` validates that file as part of `npm test` and the release job publishes
  the tagged section from it.
- **`docs/plans/`** — dated execution plans, `YYYY-MM-DD-slug.md`.
- **`docs/spec/`** — dated design specs, `YYYY-MM-DD-slug-design.md`.

## Language

`README.md` and `README.zh-CN.md` are a pair, and `CONTRIBUTING.md` carries an English half and a
Chinese half in one file. Pages under `docs/` are written in English: they are reference material for
whoever is changing the code, and a second copy of them in another language would be a second thing to
keep in step. If a page is written for users rather than contributors and deserves a Chinese mirror,
add it beside the English one as `<name>.zh-CN.md` and link the two, the way the READMEs do.