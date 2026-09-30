# Contributor documentation

The contract for contributing is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md): how to report a defect,
how to propose a feature, the development setup, what each suite proves, the commit and pull-request
conventions, the changelog rules, the release steps and the security policy. It is bilingual, with the
Chinese half mirroring the English one.

These pages are the long form of that contract, and the place to look before changing behaviour:

| Page | Covers |
| --- | --- |
| [Architecture](architecture.md) | The two-module split, why the Harness loads `dist/`, the compatibility gate, and the data flow of a sync. The source of truth for where logic belongs. |
| [Development](development.md) | Setup, the build and watch loop, the constraints the type stripper imposes, house style, and the commit and pull-request path. |
| [Testing](testing.md) | What each of the ten suites proves and why it is shaped that way, the CI shape, and the mutation discipline this repository follows. |
| [Release process](release-process.md) | The changelog, the version bump, the tag, and everything the release job verifies before it publishes. |
| [Documentation rules](documentation.md) | Where each kind of document belongs, the language pairing, and the link rules that `npm test` enforces. |

Two further directories hold work products rather than reference material:

- `../plans/` — dated execution plans, one file per piece of work.
- `../spec/` — dated design specs, written when a change needs its design settled before it is built.

For the rules an automated agent must follow in this repository — constraints, forbidden shortcuts and
commands — read [`AGENTS.md`](../../AGENTS.md) at the root.