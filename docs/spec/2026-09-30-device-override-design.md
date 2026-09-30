# Device override layer: design

Issue #4 is the defect this settles. Whole-file sync moves a profile's tracked files between machines
verbatim, so a value that is legitimately different on each device — a `link:` path to the plugin that
performs the sync, a `ghPath` in the plugin's own configuration row — leaves the profile permanently
`diverged`, and the only exits are a hand edit or `force`, where `force` overwrites the very file that
makes the plugin load on that machine. The issue carries the evidence, including the two `dsh-tui`
spellings of one `package.json`. This page decides what to build; execution is Task 6 of
[the roadmap](../plans/2026-09-30-post-typescript-roadmap.md).

**The decision.** A device declares the literal values it owns, in a file only that device has: for each
tracked file, a `canonical` value — what the gist holds and every device agrees on — and a `local` value
this device needs. Canonicalisation is a **text substitution of exactly those literals**, never a parse
and re-serialise of the file, applied to the file map at three call sites in `lib/core.ts` and inherited
by the fourth, `syncProfile`, which composes them — always *before* `hashFiles`. Upload publishes
canonical content, download writes local content, and status hashes canonical content on both sides, so a
value that is correct on both sides and deliberately different reads `in-sync` while the report still
names what was substituted. The override file is derived and device-local —
`<stateDir>/overrides/<profile>.json` — and carries no config key, because the config row lives inside a
tracked file. It is plain JSON, because `JSON.parse` is in `node:` and the repository ships no YAML
reader.

## What this design may not change

- **No runtime dependency, nothing outside `node:`.** That rules out a YAML reader for the override file
  and for `cordis.patch.yml`, and it is the constraint that shapes everything below.
- **`hashFiles` is pinned by a regression case.** Canonicalisation happens before the hash or not at all;
  the fingerprint function itself is untouched.
- **Whole-file sync stays the model**, the tracked set stays `profileFiles`, and the state file keeps
  meaning what it means today: `lastSyncedHash` records the content this machine last agreed on.
- **The plugin never writes the override file.** The user does, as they do the profile's own files;
  `state.json` is the plugin's to write, and this deliberately is not.

## Why the substitution has to be textual

Every structured design starts the same way: parse the file, replace the value at a path, write it back.
That cannot work here, and the reason is not the size of the parser.

`profileStatus` decides equality by `hashFiles(canonicalise(local)) === hashFiles(remote)`, and
`downloadProfile` asks the same question twice — once as that hash, once as a byte-for-byte content
comparison in `localIsSubsetOfRemote`. Take two devices and one `package.json` that differs only in the
plugin's `link:` path. Device A declares no override; device B declares one.

- A uploads its bytes verbatim.
- B resolves its local file to a canonical form. If that form came from `JSON.parse` followed by
  `JSON.stringify`, it equals A's bytes only when A's bytes already were the plugin's serialisation —
  same key order, same two-space indent, same `\n`. Nothing enforces that, and `package.json` is a file
  the user's own tooling writes.
- So the hashes differ on a file whose *content* agrees, B reads `local-ahead`, uploads its formatted
  version, and A downloads a reformatting it never asked for. The ping-pong the feature exists to remove
  is still there; only the differing detail has changed, from a path to whitespace.

A text substitution has none of that: it changes the matched characters and leaves every other character
— indentation, key order, quoting, comments, line endings — exactly as they were. `canonicalise(B)` is
then byte-for-byte A's file whenever the two differ only in the overridden value, which is the premise of
the whole feature. That is what makes `in-sync` reachable at all, and it is why the primitive below is
"replace this exact text" rather than "set this key".

The same argument decides the format of the *tracked* file that is edited. A YAML scalar has several
spellings (`'C:\Program Files\…'`, `"C:\\Program Files\\…"`, a folded block), and a design that reasons
about the parsed value has to write one of them back, changing bytes nobody asked to change. Matching the
file's own text sidesteps the question: the override names the characters that are in the file.

## The override file

**Location.** `<stateDir>/overrides/<profile>.json`, where `stateDir` is the directory `state.json`
already lives in (`resolveStateDir`: `config.stateDir`, else `<dshHome>/gist-settings`).

Three properties follow from that location, and each is a requirement rather than a coincidence:

- It is **outside every profile directory**, so `collectProfile` cannot read it, `profileFiles` cannot
  name it, the upload prune step cannot remove it (pruning decides on gist file names not in
  `trackedNames`), and no backup or rollback touches it.
- It is **derived**, not configured. A config key such as `overridesFile` would have to hold an absolute
  path — and the config row lives in the profile's own `cordis.patch.yml`, which is tracked, so that path
  would be uploaded and restored on the other device. That is the same circularity the issue identifies in
  `profileFiles`, and the derived location has no field for it to hide in. If a knob is ever wanted, it
  may not be an absolute path in tracked configuration.
- It is **per profile**, so one profile's refusal cannot be another's, which is the isolation the bulk
  tools already rely on.

The plugin never creates the directory. An absent directory or an absent file means "this device declares
no overrides", which is the state every device is in today.

**Format.** JSON, one object:

```json
{
  "version": 1,
  "files": {
    "package.json": [
      {
        "canonical": "link:C:/Users/you/Repo/dsh-gist-settings",
        "local": "link:/home/you/Repo/dsh-gist-settings"
      }
    ],
    "cordis.patch.yml": [
      { "canonical": "C:\\Program Files\\GitHub CLI\\gh.exe", "local": "/usr/bin/gh" },
      { "canonical": "C:\\Users\\you\\.dsh", "local": "/home/you/.dsh" }
    ]
  }
}
```

- `version` is required and must be `1`. An unknown version is refused rather than guessed at.
- `files` is keyed by a **tracked name**, and every key must be in `profileFiles` for the profile being
  operated on. A key that is not is refused with the tracked set in the message, so a typo cannot look
  like a working override.
- Each entry has exactly two fields, `canonical` and `local`, both non-empty strings, and they must
  differ. An unknown field, a missing one, a non-string or an identical pair is refused.
- The two values are **matched as text in the tracked file**, not as parsed values. In the example above,
  the JSON string `"C:\\Program Files\\GitHub CLI\\gh.exe"` names exactly the characters that sit inside
  the YAML quotes — YAML's own quoting and escape rules never enter the picture.
- Values are literals. There is no expansion of `${HOME}`, `${DSH_HOME}`, `${platform}` or anything else:
  the file never travels (it is device-local by construction), so a variable buys nothing a literal does
  not, and an unexpanded token that quietly becomes a path is exactly the class of mistake this design
  refuses everywhere else.
- Prefer the whole value over a fragment: `link:C:/Users/you/Repo/dsh-gist-settings`, not
  `C:/Users/you/Repo`. A fragment can be a substring of a longer path, and while the uniqueness rule below
  turns that into a refusal rather than a corruption, a refusal the user has to debug is worse than an
  example that does not produce one.

## The substitution rule

Canonicalisation is a pure function from a `{ name: content }` map to a new map, in one of two
directions:

| Direction | Meaning | Applied by |
| --- | --- | --- |
| **out** (`canonicaliseFiles`) | local form → canonical form | `uploadProfile`, `profileStatus`, and the local side of `downloadProfile`'s comparison |
| **in** (`localizeFiles`) | canonical form → local form | the content `downloadProfile` commits |

For each file that has entries, all entries are matched against the content **as read**, before any
replacement, so the result does not depend on the order entries appear in the JSON. For one entry in
direction *out*:

| `local` occurrences | `canonical` occurrences | Result |
| --- | --- | --- |
| exactly 1 | 0 | Substitute the one span with `canonical`. Reported as applied. |
| 0 | exactly 1 | The file already holds the canonical form. No change; reported as already canonical. |
| 0 | 0 | **Refuse.** Neither value is in the file, so the override describes nothing that is here. |
| 2 or more | any | **Refuse.** A text override must match exactly once. |
| exactly 1 | 1 or more | **Refuse.** Both spellings are present; substituting one leaves the file inconsistent. |
| 0 | 2 or more | **Refuse.** The reverse direction could not be unambiguous either. |

Direction *in* is the same table with the two columns swapped. Spans for two entries in one file must not
overlap; an overlap is refused, because which one wins would otherwise be decided by array order.

Two consequences worth stating outright:

- **Idempotence.** Running *out* on an already-canonical file changes nothing and is not an error. That
  is the state a device is in when the override was added after the file arrived, and treating it as a
  failure would make the first status after the edit a red one.
- **Nothing is invented.** An override never adds a key, a line or a file. If the value it names is not
  there, the operation fails; it does not write the canonical value in.

A tracked file that is **absent locally** is not an error for direction *out*: it is already in the
`missing` list, and the existing rules for a missing tracked file own what happens next. The download that
restores it applies direction *in* like any other write.

## Where canonicalisation is applied

The call sites, all in `lib/core.ts` and all before `hashFiles` sees anything:

| Site | Change |
| --- | --- |
| `profileStatus` | `localHash` becomes `hashFiles(canonicaliseFiles(files))`. The remote hash, the baseline comparison, `restorable` and the status vocabulary are unchanged — the baseline in `state.json` is a canonical hash from now on. |
| `uploadProfile` | Canonicalise immediately after `collectProfile`; the canonical map is what `gistPatch`/`gistCreate` publish **and** what `lastSyncedHash` records. `missing`, `lost`, `pruned` and `dropped` decide on names and are unaffected. |
| `downloadProfile` | `localHash` in the safety comparison becomes the canonical local hash, and so does the content `localIsSubsetOfRemote` compares — that function tests content, not names, so without it a device whose only local difference is its own override would be asked for `force` for no reason. The map handed to `commitTrackedFiles` is `localizeFiles(remoteFiles)`, and `lastSyncedHash` stays `hashFiles(remoteFiles)`, which is already canonical. A substitution that refuses throws before `commitTrackedFiles` is called, so nothing is staged, nothing is renamed and no baseline moves. |
| `syncProfile` | Untouched. It composes the three above through `profileStatus`, so it inherits the behaviour, including the `missing-local` and `remote-ahead` paths. |

`force` is not a way past a broken override. It means "overwrite local files"; it is not a statement that
the override file may be wrong, so a substitution that refuses fails the operation whatever `force` says,
with the reason in the message.

Because `in-sync` is now reachable while the bytes on disk differ from the gist, the report has to say so.
`ProfileStatus` gains `overrides?: OverrideApplication[]` — one entry per declared override whose file this
operation read, a file that is missing locally being reported by `missing` already — and each entry is
`{ file, canonical, local, applied }`. The tool's `render` prints one line per entry, for example:

```
overridden locally: package.json — link:C:/Users/you/Repo/dsh-gist-settings → link:/home/you/Repo/dsh-gist-settings
```

`applied` is what keeps the line honest: `true` means the operation substituted the local value,
`false` means the file already held the canonical one. A profile with no override file prints nothing new,
so every existing output is unchanged for every existing user. Upload, download and sync results carry the
same list, derived from the status they already compute.

`health()` gains the resolved overrides directory, so a user can find the file without reading this page.

## What is refused

Every refusal names the override file and the offending entry, and nothing is written and no baseline
moves:

| Condition | Why it is not guessed at |
| --- | --- |
| The file is not valid JSON, or is not an object | Same stance as `state.json`: a hand-edited file that cannot be read is reported, not ignored. |
| `version` missing, not `1`, or not a number | The shape is versioned so that a later shape can be added without changing the meaning of this one. |
| An unknown top-level field | The config reader refuses unknown keys; so does this. |
| `files` missing, or not an object | An override file that declares nothing is a mistake, not a no-op. |
| A key not in `profileFiles` | The message lists the tracked set. |
| An entry that is not an object, or whose `canonical`/`local` is not a non-empty string | Shape errors are refused at load, before any file is touched. |
| `canonical === local` | The entry does nothing; accepting it would hide a typo. |
| Any row of the substitution table above that says refuse | Ambiguity is the failure mode of a text substitution. The design chooses to stop rather than to pick. |

A refusal fails the operation for **that profile**. `statusAll`, `syncAll` and the tool layer already
isolate per profile, so one broken override file does not stop the others — and the message says which
file, so the fix is a one-line edit.

## Alternatives considered

**Parse and re-serialise, with a path per format.** Rejected in "Why the substitution has to be textual":
it cannot promise that only the overridden characters change, so two devices that agree on content never
agree on bytes, and `in-sync` is unreachable in the mixed fleet this feature exists for.

**A structured JSON-path locator in v1.** Deferred rather than rejected — see the next section. It needs
a source-position scanner (`JSON.parse` reports no spans) with its own refusal surface, and it buys
nothing for the evidence in the issue, where the value being overridden occurs exactly once.

**The textual rewrite map in the plugin's own config row** — the issue's "smaller alternative",
`pathRewrites: [{ from, to }]`. Rejected as a carrier: the config row is tracked, so the map is uploaded
and restored on the other device, which is the circularity this design exists to avoid. The mechanism
itself is what this design adopts; the differences are that it lives in a device-local file, is scoped to
one named file, and requires a unique match instead of rewriting every occurrence it finds.

**Narrowing v1 to `package.json`.** Rejected: the issue's evidence includes `ghPath`, `dshHome`,
`profilesDir` and `stateDir`, all of which live in `cordis.patch.yml`, and the mechanism is identical for
both files — the text locator does not know or care which format it is editing. Narrowing would remove the
larger half of the reported problem to save nothing.

**Variable expansion in the override file.** Deferred: see "Format" above. The file is device-local and
never travels, so the only thing expansion supports is copying it between machines by hand — and an
unexpanded `${HOME}` that quietly becomes a literal path is a silent wrong answer, which is the failure
mode this design refuses everywhere else.

## The deferred `path` locator

One extension is designed here so that Task 6 does not need a second spec, and deliberately not built:

```json
{ "path": ["dependencies", "@local/dsh-gist-settings"],
  "canonical": "link:C:/Users/you/Repo/dsh-gist-settings",
  "local": "link:/home/you/Repo/dsh-gist-settings" }
```

`path` replaces the "match the `canonical` string" locator with "the value at this JSON path", which
closes two gaps the text locator has by construction: a value that is **not unique** in its file, and a
value that is **not a string** (the `web` profile's `"dependencies": {}` against three installed bundles,
which the issue lists as related work). It keeps the substitution rule: the locator finds a span, the span
is replaced, every other character survives. The reader must agree with `JSON.parse` about the value it
found, and refuse when it cannot — the same shape as the oracle checks the safety suite already uses.

Trigger: the first user who needs one of those two cases. Not before: it is new code on the path that
writes profile files, and there is no evidence yet that it is needed.

## The issue's acceptance criteria, mapped

| Issue #4 criterion | How this design meets it |
| --- | --- |
| 1. A Linux device with the override reports `in sync`, downloads without `force`, and leaves the gist's value untouched | Canonical hashes on both sides; direction *in* on the staged bytes; direction *out* on the upload payload. Task 6 Step 7 walks it end to end. |
| 2. A → B → A converges with no `force` and no stale baseline | The baseline is a canonical hash on both devices, so a round trip is a no-op on the second pass. |
| 3. The override file is never uploaded, pruned or counted as a tracked file | It lives outside the profile directory; `profileFiles`, the prune step and the backup walk cannot reach it. One case each. |
| 4. The tools name what was overridden | `ProfileStatus.overrides` plus the rendered `overridden locally:` line; `applied` distinguishes a substitution from a file that already agreed. |
| 5. A missing target or a wrong shape fails with the file and the key in the message, writing nothing | The refusal tables above; on a download the substitution runs before anything is staged, so the commit never starts. |
| 6. Behaviour is byte-identical when no override file exists | No file → no overrides → the map passed to `hashFiles` and to the writers is the map read from disk, unchanged. |
| 7. Tests, and the documentation that goes with it | See "Consequences" below. |

## Safety properties that come for free

Worth recording, because they are the reason the location and not the code does the work: the override
file is not in the profile directory, so the containment walk (`resolveTrackedFile`), the tracked-name
validator (`normalizeTrackedName`), the atomic commit (`commitTrackedFiles`), the backup and rollback
paths, and the gist prune step all keep their current guarantees without a special case. The one new path
that touches bytes is the substitution, and it runs on content that is already in memory — on the way out
before anything is sent, on the way in before anything is staged.

## Out of scope

- **Bootstrapping a second device from an existing gist** (`gist_download` refuses a profile with no state
  record as `not tracked yet`). The issue names it out of scope and it is a defect in its own right; file
  it when Task 6 lands.
- **Syncing the set of installed plugins per device** (the `web` example) — the `path` locator above is
  the prerequisite, not this design.
- **Any new tool, tool parameter or config key.** The override file is derived, so no tool gains a
  parameter and nothing is added to `readConfig`. The reporting changes live in the internal status shape
  and in the text the tools already return — every one of the four returns a single text block, so no
  declared schema moves and the schema contract suite is untouched. That is deliberate: issue #5's
  `/gist` surface and the settings page would each have to carry a new parameter if the location were
  configurable.

## Consequences for the repository

Task 6 implements this; the list is here so the spec is the whole decision.

- **New module `lib/overrides.ts`**, beside `lib/core.ts` and Cordis-free like it: the loader, the two
  substitution functions, `OVERRIDE_VERSION`, and the types. `lib/core.ts` imports it; `index.ts` imports
  neither beyond what it imports today.
- **New suite `test/overrides.test.ts`.** The refusal surface is a table of cases of its own and does not
  belong in `test/safety.test.ts`, which is already the repository's largest; the substitution rule and
  both directions belong beside them. `test/sync.test.ts`, `test/tools.test.ts` and
  `test/regression.test.ts` gain the cases the roadmap's Task 6 lists.
- **`test/guards.test.ts` needs no edit**, and that is the check worth noting: it discovers every `.ts`
  file, so the new module and the new suite are covered the moment they land — strippability, import
  targets, and the case that fails if a suite is not reachable from the `test` chain. The chain entry in
  `package.json` is therefore load-bearing rather than cosmetic.
- **Every count that says "ten suites" moves to eleven** — `AGENTS.md`, `CONTRIBUTING.md`, both READMEs,
  `docs/index.md` and `docs/contributor/testing.md` each carry it, and the guard suite's own case count
  and the offline total move with them.
- **Documentation**: `README.md` and `README.zh-CN.md` (configuration table, both languages),
  `docs/user/reference/configuration.md`, `docs/user/reference/recovery.md` (only to say that `force`
  semantics are unchanged), the commented template in `cordis.patch.yml` (where the file lives — no new
  key), `docs/contributor/architecture.md` (the module), `docs/contributor/testing.md` (the new suite and
  the counts), `AGENTS.md` (the code map), and a `CHANGELOG.md` entry written for someone deciding whether
  to upgrade.