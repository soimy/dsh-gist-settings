# Releases

The release notes for this project live in the root [`CHANGELOG.md`](../../CHANGELOG.md). That is a
deliberate choice rather than an unused directory:

- `scripts/check-changelog.ts` validates the file's structure, its version order and its consistency
  with `package.json`, and it runs as part of `npm test`.
- `scripts/release-notes.ts` extracts the section for a tag, and `.github/workflows/release.yml`
  publishes exactly that text as the GitHub release. A missing, empty or mismatched section makes the
  tag fail before anything is published.

So this directory indexes that file rather than duplicating it: one source of truth, and no second copy
to drift out of step. `latest.md` is the alias for the newest release, and it is updated whenever a new
release note is added — the same way a release note and the version bump travel together.

| Version | Released | Notes |
| --- | --- | --- |
| `0.2.0` | 2026-09-28 | [CHANGELOG](../../CHANGELOG.md#020---2026-09-28) · [GitHub release](https://github.com/soimy/dsh-gist-settings/releases/tag/v0.2.0) |
| `0.1.0` | 2026-09-27 | [CHANGELOG](../../CHANGELOG.md#010---2026-09-27) · [GitHub release](https://github.com/soimy/dsh-gist-settings/releases/tag/v0.1.0) |

Work merged since `0.2.0` is under [`[Unreleased]`](../../CHANGELOG.md#unreleased) and has not been
tagged. The current release is described by [latest.md](latest.md).

How a release is cut, and everything the release job checks first, is in
[the release process](../contributor/release-process.md).