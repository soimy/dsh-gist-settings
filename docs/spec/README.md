# Design specs

A design spec settles *what* a change should be before anyone builds it: the problem, the constraints,
the options that were considered, the decision, and what it costs. It is written for a change whose
shape is not obvious from the code, or whose alternatives are worth recording so that a later reader
does not re-litigate them.

Name a spec `YYYY-MM-DD-slug-design.md`, using the date the design was settled. One spec per decision;
if a spec is superseded, say so at the top and link the one that replaced it rather than rewriting
history.

Specs are not published anywhere and are not linked from the README. `docs/plans/` is the sibling
directory for execution: a plan says what will be done, in what order, and how each step is verified,
while a spec says what the thing is.

Specs so far:

- [Device override layer](2026-09-30-device-override-design.md) — the mechanism issue #4 needs, settled
  before Task 6 of the roadmap implements it.

The next candidate is the settings page, which is the one open product item without a design — see
[the roadmap](../plans/2026-09-30-post-typescript-roadmap.md).