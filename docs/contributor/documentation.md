# Documentation rules

This page is the contract for documentation in this repository. It is short on purpose: the rules are
the kind that are only useful if someone actually follows them, so each one says what it prevents.

The short version of the repository's own convention, repeated from [`AGENTS.md`](../../AGENTS.md):
keep `README.md` the concise project entry page, put user-facing detail in `docs/user/`, contributor and
process detail in `docs/contributor/`, the release index in `docs/releases/`, plans in `docs/plans/`, and
design specs in `docs/spec/`.

## Placement

| Kind of document | Lives in | Why there |
| --- | --- | --- |
| Project entry: status, requirements, install, the safety model, review history | `README.md` | It is what a visitor reads first, and it is what `README.zh-CN.md` mirrors. |
| The contributor contract: reporting, setup, suites, commit and pull-request rules, changelog, releases, security | `CONTRIBUTING.md` | One file a contributor can read end to end, with the Chinese half mirroring it. |
| Reference material for someone *using* the tools | `docs/user/` | Long form: every parameter, every key, every failure mode. |
| Reference material for someone *changing* the code | `docs/contributor/` | Architecture, development, testing, the release process, and these rules. |
| Release notes | `CHANGELOG.md`, indexed by `docs/releases/` | See below — the file is load-bearing. |
| Execution plans | `docs/plans/YYYY-MM-DD-slug.md` | Dated, one per piece of work, checkboxes for steps. |
| Design specs | `docs/spec/YYYY-MM-DD-slug-design.md` | Dated, written when the shape of a change needs settling first. |

Do not open a documentation root named after a tool, an editor or an agent. There is one `docs/`
directory and these are its subdirectories.

## Short form and long form

The README and CONTRIBUTING stay readable in one sitting. When a section grows past what a reader needs
to decide whether to use the thing, the detail moves to the page in `docs/` that owns it, and the short
form keeps a sentence and a link.

Both copies of the same explanation is the failure mode to avoid: they drift, and then nobody knows
which one is true. Write the detail once, where it belongs, and link.

## Release notes

`CHANGELOG.md` is canonical and stays at the root, unlike the usual "release notes live under `docs/`"
layout. Two things depend on it:

- `scripts/check-changelog.ts` validates its structure, its version order and its agreement with
  `package.json`, and it runs as part of `npm test`.
- `scripts/release-notes.ts` extracts the section for a tag, and `.github/workflows/release.yml`
  publishes that text as the GitHub release — refusing a tag whose section is missing, empty, or
  disagrees with the packaged version.

`docs/releases/` therefore indexes that file and holds the `latest.md` alias. Moving the notes would
mean moving the release mechanism with them, for no gain.

## Language

`README.md` and `README.zh-CN.md` are a pair: each links to the other, and a change that updates one and
not the other is incomplete. `CONTRIBUTING.md` carries an English half and a Chinese half in the same
file, section for section.

Pages under `docs/` are English. They are reference material for whoever changes the code, and a second
copy in another language is a second thing to keep in step. A user-facing page may be mirrored as
`<name>.zh-CN.md` beside its English original, with the two linking to each other — the same pattern the
READMEs use. Do that for pages a user reads, not for pages a contributor reads.

## Links

`scripts/check-docs.ts` walks every Markdown file in the repository, resolves every relative link
against the file that contains it, and refuses a link whose target does not exist or that points outside
the repository. It runs as part of `npm test`, so a broken link fails a build rather than a reader.

Points worth knowing, because the checker is stricter than it looks:

- Links inside code spans and fenced blocks are ignored, so a document can show link syntax as an
  example.
- Links through a directory link inside the repository to a file outside it are refused — the
  containment rule that keeps a documentation tree honest.
- `#fragment` targets are not verified. Use them where they help a reader, but do not rely on one being
  checked.
- External `https://` links are not fetched, so they cannot break a build; they can still rot, so link to
  the canonical page rather than a deep anchor that moves.

## Voice

Write as the rest of this repository does: precise, direct, and specific about what is true. Prefer the
concrete (a command, a key name, a message a user will see) to the general. Explain why a thing is the
way it is, especially when the obvious alternative was rejected — that is the part a later reader cannot
reconstruct.

Wrap prose at roughly 100 columns. Use `backticks` for identifiers, paths, commands and values. Use an
em dash as ` — ` with spaces, and avoid emoji. Do not write a paragraph that only restates the heading.