<!--
  Thanks for the pull request. Keep the sections that apply and delete the rest;
  a short, specific description beats a long, vague one.
-->

## What this changes

<!-- One paragraph. What is different after this merges? -->

## Why

<!-- The problem, not the patch. Link the issue if there is one: Fixes #123 -->

## How it was verified

<!--
  Say what you actually ran, and paste anything surprising. "Tests pass" alone is
  weak; name the case that would have failed before this change.
-->

- [ ] `npm test` — the four offline suites
- [ ] `npm run test:live` — only if this touches the GitHub round trip (creates and deletes a real gist)
- [ ] Manual check: <!-- what you did in a real session, if anything -->

## Data safety

<!--
  This tool overwrites and deletes configuration. If your change can destroy
  anything, this section is the most important one in the PR.
-->

- [ ] This change cannot delete or overwrite user data
- [ ] Or: it can, and the PR explains what is backed up first and how a user recovers

Specifically:

- **Does it change when files are pruned from a gist?**
- **Does it change when a download overwrites local files?**
- **Does it change what counts as "safe to fast-forward"?**

## Checklist

- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` (required for any user-visible change)
- [ ] Documentation updated — `README.md` **and** `README.zh-CN.md` if behaviour or config changed
- [ ] New behaviour is pinned by a test that fails if the change is reverted
- [ ] Nothing in the diff contains a token, a gist URL, or a real profile's contents
- [ ] Commit messages follow the convention in `CONTRIBUTING.md`

## Screenshots

<!-- Only for UI changes, which currently means the unwritten settings page. -->