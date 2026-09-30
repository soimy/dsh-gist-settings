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
names what was substituted. The override file is derived and device-local — one JSON file per profile,
discovered from the environment under `<DSH_HOME>/gist-settings/overrides/` rather than from the tracked
configuration that names `stateDir` — and carries no config key, because the config row lives inside a
tracked file. It is plain JSON, because `JSON.parse` is in `node:` and the repository ships no YAML
reader. A recorded baseline is only half a record: it says what both sides agreed on, so the state file
also records **which override declaration** that agreement was reached under, and a declaration that has
changed since is never read as an ordinary `local-ahead`.

## What this design may not change

- **No runtime dependency, nothing outside `node:`.** That rules out a YAML reader for the override file
  and for `cordis.patch.yml`, and it is the constraint that shapes everything below.
- **`hashFiles` is pinned by a regression case.** Canonicalisation happens before the hash or not at all;
  `hashFiles` itself is untouched. The declaration fingerprint introduced below is a separate, local-only
  digest; it never feeds a comparison that leaves the machine.
- **Whole-file sync stays the model**, the tracked set stays `profileFiles`, and the state file keeps
  meaning what it means today: `lastSyncedHash` records the content this machine last agreed on — plus one
  new optional field, the declaration that content was canonicalised under, because a baseline without it
  cannot tell an ordinary local edit from an override file that has gone missing. An optional field does
  not move `STATE_VERSION`, and a record written before the field existed reads as "under no declaration",
  which is what every device had.
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

**Location.** `<overridesDir>/<profile>.json`, where `overridesDir` is discovered from the environment and
never from tracked configuration:

1. `DSH_GIST_OVERRIDES_DIR`, when it is set to a non-blank value (with a leading `~` expanded, as every
   configured path here is);
2. otherwise `<DSH_HOME>/gist-settings/overrides` when `DSH_HOME` is set, where `DSH_HOME` is **the
   environment variable**, not `config.dshHome`;
3. otherwise `<os.homedir()>/.dsh/gist-settings/overrides`.

When no configuration deviates, rule 2 lands on the same place the earlier draft named — the directory
`state.json` lives in, plus `overrides/` — so the anchor changes nothing for a machine whose tracked
values are its own, and changes exactly the lookup that a foreign `dshHome` or `stateDir` would otherwise
break.

**Why the environment and not `stateDir`.** An earlier draft of this page put the file at
`<stateDir>/overrides/`, and that is a circularity, not a detail. `stateDir` is one of the values this
feature exists to localize, and the plugin reads its own config row — the one carrying `stateDir`,
`dshHome` and the rest — out of the tracked `cordis.patch.yml`. A device that has just received another
machine's `stateDir` therefore resolves `resolveStateDir` to a directory that does not exist here, and the
file that would localize `stateDir` is exactly the file it cannot find. `config.dshHome` has the same
shape, because `resolveStateDir` falls back to it. Anchoring discovery to the environment breaks the loop:
the path that finds the override file does not depend on any value the override file exists to correct.

Four properties follow from that location, and each is a requirement rather than a coincidence:

- It is **outside every profile directory**, so `collectProfile` cannot read it, `profileFiles` cannot
  name it, the upload prune step cannot remove it (pruning decides on gist file names not in
  `trackedNames`), and no backup or rollback touches it.
- It is **derived**, not configured, and it is not tracked. A config key such as `overridesFile` would
  have to hold an absolute path — and the config row lives in the profile's own `cordis.patch.yml`, which
  is tracked, so that path would be uploaded and restored on the other device. That is the same
  circularity the issue identifies in `profileFiles`, and the derived location has no field for it to hide
  in. A new environment variable is not a config key and never travels; it only decides where this machine
  looks.
- It is **per profile**, so one profile's refusal cannot be another's — an isolation the bulk tools must
  be given, not one they already have. "What is refused" states that requirement.
- It is **reported**. `health()` names the resolved directory and which anchor produced it, so the user
  can find the file without reading `resolveStateDir` or this page.

The plugin never creates the directory. An absent directory or an absent file means "this device declares
no overrides", which is the state every device is in today.

**Where this stops, and what v1 therefore claims.** The environment anchor makes a tracked `stateDir`
recoverable: the override file is found even when that value is another machine's, and the value is then
canonicalised and localized like any other. Two of the other values are not recoverable, and pretending
otherwise would be the kind of claim this repository refuses:

| Tracked value | Why v1 cannot self-recover it |
| --- | --- |
| `config.dshHome`, or `config.profilesDir` | `resolveProfilesDir` derives the profile directory from `dshHome`, so a foreign value means the plugin cannot find the profile's files at all — there is nothing to canonicalise and no operation that can run. |
| `config.ghPath` | `resolveGh` probes the configured path and, when it is set and does not exist, returns `configured ghPath does not exist` **without falling back to `PATH`**. A foreign `ghPath` therefore means no gist can be read or written. |

So v1 **maintains** the device-scoped values on a machine that can already run the plugin, and localizes
`stateDir` even after it has been overwritten with another device's. It does not **bootstrap** a machine
whose tracked `dshHome`, `profilesDir` or `ghPath` already names another one; there the recovery is a
one-time hand edit — or deleting the key so `PATH` probing and the environment take over — after which the
override keeps the value correct. That is the same bootstrapping gap the issue lists as out of scope, and
it is named again in "Out of scope" here so that Task 6 does not claim more than it can deliver.

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

**What counts as an occurrence.** The two values are literals, and one may contain the other: with
`canonical` `link:/srv/plugins/dsh-gist-settings` and `local` `link:/srv/plugins`, a file that holds only
the canonical text also contains the local text. Counting raw substring matches would read that
canonical-only file as "both spellings present" and refuse it — breaking the already-canonical row above,
refusing a status on a file that is exactly right, and making download localization impossible — so the
counts in the table are defined with containment removed:

- A `local` occurrence that lies **entirely inside** a `canonical` occurrence is not counted as a local
  occurrence. It is that canonical value's text.
- A `canonical` occurrence that lies **entirely inside** a `local` occurrence is not counted as a
  canonical occurrence, symmetrically.
- The table above is then read with those two counts.

The discount is for containment only, and it is not a general overlap rule:

- Two occurrences of the **same** literal still count separately, even when they overlap each other, so
  `local` `aaa` in `aaaa` is two local occurrences and refuses.
- Two spans that overlap **without containing** each other — `local` `abcab` and `canonical` `bcabc` in
  `abcabc` — each survive the discount, so the table's "exactly 1, 1 or more" row refuses them. Neither
  reading is provable, and this design refuses rather than picks.
- A value that appears once standalone **and** once inside the other value leaves one surviving occurrence
  of each, which is the refuse row: substituting the standalone occurrence would leave the file holding
  both spellings.

A canonical-only file counts 0 local and 1 canonical, which is "already canonical"; direction *in* over
the same bytes counts 1 canonical and 0 local, which is the substitution a download needs. Both directions
work under the discount, because containment is symmetric.

Direction *in* is the same table and the same counting rule with the two columns swapped. Spans for two
entries in one file must not overlap; an overlap is refused, because which one wins would otherwise be
decided by array order.

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
| `profileStatus` | `localHash` becomes `hashFiles(canonicaliseFiles(files))`. The remote hash, `restorable` and the vocabulary's existing names are unchanged — the baseline in `state.json` is a canonical hash from now on, and it is paired with the declaration fingerprint described below, which is what adds the vocabulary's one new name. |
| `uploadProfile` | Canonicalise immediately after `collectProfile`; the canonical map is what `gistPatch`/`gistCreate` publish **and** what `lastSyncedHash` records, together with the fingerprint of the declaration that produced it. `missing`, `lost`, `pruned` and `dropped` decide on names and are unaffected. The applications from that canonicalisation are the result's `overrides`. |
| `downloadProfile` | `localHash` in the safety comparison becomes the canonical local hash, and so does the content `localIsSubsetOfRemote` compares — that function tests content, not names, so without it a device whose only local difference is its own override would be asked for `force` for no reason. The map handed to `commitTrackedFiles` is `localizeFiles(remoteFiles)`, and `lastSyncedHash` stays `hashFiles(remoteFiles)`, which is already canonical, recorded with the fingerprint of the declaration that localized the bytes. A substitution that refuses throws before `commitTrackedFiles` is called, so nothing is staged, nothing is renamed and no baseline moves. The applications from the localization are the result's `overrides`. |
| `syncProfile` | Its composition is untouched: it keeps composing the three above through `profileStatus`, so it inherits the behaviour, including the `missing-local` and `remote-ahead` paths. It gains a case for `override-changed`, and it reports the applications of the operation it actually ran rather than of the status it read before running it. |

`force` is not a way past a broken override. It means "overwrite local files"; it is not a statement that
the override file may be wrong, so a substitution that refuses fails the operation whatever `force` says,
with the reason in the message. A *changed* declaration is a different case, and "When the declaration
changes" below says why `force` is allowed to cross that one.

Because `in-sync` is now reachable while the bytes on disk differ from the gist, the report has to say so.
`ProfileStatus` gains `overrides?: OverrideApplication[]` — one entry per declared override whose file this
operation read, a file that is missing locally being reported by `missing` already — and each entry is a
**location and an outcome, not a value**:

```
OverrideApplication = { file: string; entry: number; applied: boolean }
```

`file` is the tracked name, `entry` is the 1-based position of the entry in that file's array, and
`applied` is what keeps the line honest: `true` means the operation substituted the local value, `false`
means the file already held the canonical one. The tool's `render` prints one line per entry, for example:

```
overridden locally: package.json — override #1 (applied)
overridden locally: cordis.patch.yml — override #2 (already canonical)
```

`canonical` and `local` are deliberately absent from the shape and never appear in tool text. Nothing in
the override format bounds what a value may be — a `cordis.patch.yml` row is a plausible place for a token,
and this reader cannot tell a path from a secret — while the locator and the outcome are enough to act on.
The file is device-local and `health()` names the directory it lives in, so the user opens it when they
need the value itself. The deferred `path` locator is also a reporting change: a field path is a better
locator than `#1`, and it still does not need the values echoed.

A profile with no override file prints nothing new, so every existing output is unchanged for every
existing user.

**Where the list comes from.** Each transformation returns its own applications, and the operation that
ran reports them. Nothing is derived from a status that was computed for another purpose:

- `canonicaliseFiles` and `localizeFiles` return the new map together with the applications they made.
- `profileStatus` reports the applications from the canonicalisation behind `localHash`.
- `uploadProfile` reports the applications from the canonicalisation of the payload it published.
- `downloadProfile` reports the applications from the localization of the bytes it committed.
- `syncProfile` runs one of the three and reports *that* operation's list; for `noop` it reports the
  status' list, because nothing was transformed. It cannot report the status' list for a forced upload:
  an `in-sync` status carries the "already canonical" list, while the upload that follows `force`
  substitutes.
- `UploadResult`, `DownloadResult` and `SyncResult` gain `overrides`, and `gist_status` reads the field on
  `ProfileStatus`. Direct upload and download never call `profileStatus` today and do not start: each is a
  single direction, and a remote read they do not need would be cost with no answer in it.

`health()` gains the resolved overrides directory, so a user can find the file without reading this page.

## When the declaration changes: the baseline fingerprint

`lastSyncedHash` alone cannot tell an ordinary local edit from an override file that was deleted, moved, or
never mounted, and the difference is the whole defect this feature exists to remove:

1. The gist holds `link:C:/Users/you/Repo/dsh-gist-settings`; this device holds
   `link:/home/you/Repo/dsh-gist-settings` and declares the pair.
2. A sync succeeds. `lastSyncedHash` records the canonical hash, which equals the gist's.
3. The override file is deleted, moved, or sits on a volume this machine has not mounted.
4. Canonicalisation is now the identity map, so `localHash` is the raw local file's hash and differs from
   the baseline, while `remoteHash` still equals it. `profileStatus` reads that as `local-ahead`.
5. `gist_sync` uploads on `local-ahead`. The Linux path is now the gist's canonical value and the
   ping-pong is back — with no `force`, and with nothing in the output saying the override file had gone.

The fix is to record what the baseline was recorded **under**. `ProfileRecord` gains an optional
`overrideFingerprint`: a stable digest of this profile's effective declaration — its tracked-file keys
sorted, each file's entries normalised and sorted, the format version included — or `null` when the
override file does not exist. It never leaves the machine (`state.json` is neither tracked nor uploaded),
so it is not a wire format: its only job is to answer "is this the declaration the baseline was taken
under?" on this device, and a later change to the digest costs one re-baseline rather than a migration. A
record that predates the field reads as `null`, which is correct — before this feature, no device had a
declaration.

`profileStatus` compares the fingerprint before it classifies:

| Current fingerprint vs. recorded | Hashes | Status |
| --- | --- | --- |
| equal | any | Today's classification, unchanged. |
| different, including `null` against an entry set | `localHash === remoteHash` | `in-sync`, and the baseline **and** the fingerprint are repaired together under the state lock, compare-and-set exactly as the existing stale-baseline repair already does. This is the enable case: adding an override to a device whose file already holds the canonical text changes no bytes and must not read as a change. |
| different | `localHash !== remoteHash` | **`override-changed`** — the one new name in the vocabulary. The two sides disagree, and the recorded baseline was taken under a different declaration, so neither "the local side moved" nor "the remote side moved" is a statement this design is entitled to make. |

`override-changed` is not `diverged`: the difference is known to be the declaration rather than the
content, and the message says so. `syncProfile` handles it the way it handles `diverged` — without `force`
it refuses, naming the profile, the override file and the two recoveries (restore or correct the file, or
run `gist_upload` / `gist_download` to choose a direction by hand) — and with `force` it uploads. That is a
deliberate distinction from the paragraph above: a **refused** override (bad JSON, bad shape, a literal
that is absent, ambiguous or conflicting) fails the operation whatever `force` says, because the file is
wrong; a **changed** declaration is not wrong, it invalidates the baseline, and `force` is the user saying
they know that. Every result produced under a changed declaration — an upload, a download, a forced sync —
names the change, so nobody publishes this device's raw bytes without seeing that the canonical view moved.

The lifecycle, case by case:

| Event | Fingerprint | Result |
| --- | --- | --- |
| **Enable**, file already canonical | `null` → set | `in-sync`; baseline and fingerprint repaired. No upload. |
| **Enable**, file still holds the local text | `null` → set | `in-sync` when the canonicalised local equals the gist — the ordinary case — and `override-changed` when it does not. |
| **Disable** or **lose** the file, local text already canonical | set → `null` | `in-sync`; baseline and fingerprint repaired. Nothing to do. |
| **Disable** or **lose** the file, local text still local | set → `null` | `override-changed`. The dangerous transition above becomes a refusal instead of an upload. |
| **Edit** an entry and the two sides still agree | set → set, different | `in-sync`; re-baselined. |
| **Edit** an entry and the two sides disagree | set → set, different | `override-changed`. |
| **Local-only** edit under an unchanged declaration | set → set, equal | Today's table: `local-ahead`, and `gist_sync` uploads canonicalised bytes, which is correct. |
| **Stale baseline**, both sides already agree | equal | Today's repair, extended to write the fingerprint in the same compare-and-set. |

`uploadProfile` and `downloadProfile` record the fingerprint of the declaration they actually applied, in
the same locked write that records `lastSyncedHash`. `profileStatus`'s repair writes it in the same
compare-and-set, so a concurrent writer that advanced the record is still left alone.

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

A refusal fails the operation for **that profile** — and saying so is a requirement of Task 6, not a
description of what the code does today. `syncAll` already catches per profile, and so do the upload,
download and sync tool loops, but `statusAll` awaits `profileStatus` in a bare loop, and `gist_status`
does the same in its own: nothing in today's statuses is something a user is expected to hit, so the gap
has never shown, and a refusal raised by an override file would abort the whole fleet report instead of
failing one row. Two things are therefore required:

- Every refusal the override layer raises carries a marker the way `ghJson`'s "really gone" error already
  carries `notFound`, and both bulk status paths catch **that marker** per profile, push a failure row
  naming the profile and the file, and report the remaining profiles. They catch nothing else: an
  unrelated throw keeps today's behaviour, which is what keeps the no-override path byte-identical.
- A **named** profile request (`gist_status <profile>`) keeps failing loudly rather than becoming a row.
  There is no other profile in that call to protect, and the caller asked about this one.

The failure row is `{ profile, status: 'failed', error }`, printed the way the other tools already print a
per-profile failure (`<profile>: FAILED - <message>`), so one bulk report never hides a broken override and
never loses the other rows.

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
larger half of the reported problem to save nothing. What v1 does **not** claim is self-recovery, and the
location section above draws that line precisely: the declaration covers all four values, but
`dshHome`, `profilesDir` and `ghPath` are maintained on a device that can already run the plugin rather
than recovered on one that cannot.

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
writes profile files, and there is no evidence yet that it is needed. It is also what would restore the
key-level wording in issue #4's criterion 5 — "a missing key" and "a value of the wrong shape" are
statements a structured locator can make and a text locator cannot — which is why the map below reads that
criterion at the literal level for v1.

## The issue's acceptance criteria, mapped

| Issue #4 criterion | How this design meets it |
| --- | --- |
| 1. A Linux device with the override reports `in sync`, downloads without `force`, and leaves the gist's value untouched | Canonical hashes on both sides; direction *in* on the staged bytes; direction *out* on the upload payload. Task 6 Step 7 walks it end to end. |
| 2. A → B → A converges with no `force` and no stale baseline | The baseline is a canonical hash on both devices, so a round trip is a no-op on the second pass. |
| 3. The override file is never uploaded, pruned or counted as a tracked file | It lives outside the profile directory; `profileFiles`, the prune step and the backup walk cannot reach it. One case each. |
| 4. The tools name what was overridden | `ProfileStatus.overrides` plus the rendered `overridden locally:` line; `applied` distinguishes a substitution from a file that already agreed. The line names the file and the entry's position, never the values. |
| 5. A missing target or a wrong shape fails with the file and the key in the message, writing nothing | At v1's literal level: a wrong entry shape is refused at load, and a literal that is absent, ambiguous or conflicting is refused with the file and the entry, before anything is staged, so a download's commit never starts. "The key" arrives with the deferred `path` locator, not before — see below. |
| 6. Behaviour is byte-identical when no override file exists | No file → no overrides and a `null` fingerprint → the map passed to `hashFiles` and to the writers is the map read from disk, unchanged, and the fingerprint comparison is between two `null`s. |
| 7. Tests, and the documentation that goes with it | See "Consequences" below. |

Criterion 5 is the one place where the issue's words and v1's mechanism do not line up, so the design
records the difference rather than papering over it. A text locator has no idea what a key is: it can say
that a literal is absent, that it occurs more than once, that both spellings are present, or that an entry
has the wrong shape — and "a missing key" and "a value of the wrong shape" are properties of a structured
locator. The roadmap's Task 6 states the same literal vocabulary for the same reason.

The seven criteria do not cover two consequences this design found while settling them, and both are
requirements of Task 6 rather than observations about it: a declaration that changes must not be read as
an ordinary local edit ("When the declaration changes"), and a refusal must not take the other profiles'
status rows down with it ("What is refused").

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
- **Recovering a device whose tracked `dshHome`, `profilesDir` or `ghPath` already names another machine.**
  The environment anchor makes `stateDir` recoverable, but those three values decide whether the plugin can
  find profiles and run `gh` at all, so a device that has received another machine's copy needs one hand
  edit before any operation can run. v1 maintains them from then on; making the recovery automatic belongs
  to the bootstrap issue above.
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
  both directions belong beside them, including the containment cases the occurrence rule turns on (a
  `local` that is a prefix of `canonical`, and the reverse). `test/sync.test.ts`, `test/tools.test.ts` and
  `test/regression.test.ts` gain the cases the roadmap's Task 6 lists, and the lifecycle table's eight rows
  are the regression cases for the fingerprint.
- **The state file and the vocabulary move.** `ProfileRecord` gains the optional `overrideFingerprint`;
  `ProfileStatusName` gains `override-changed` (nine names, not eight); `ProfileStatus` and the three
  result types gain `overrides`; `statusAll` gains a `StatusFailure` row. `STATE_VERSION` stays `1`,
  because every addition is optional and a record without the fingerprint reads as "no declaration". The
  tool layer's label map is a `Record` over the names, so the compiler — not a test — is what refuses to
  let the new row print as a raw string.
- **`test/guards.test.ts` needs no edit**, and that is the check worth noting: it discovers every `.ts`
  file, so the new module and the new suite are covered the moment they land — strippability, import
  targets, and the case that fails if a suite is not reachable from the `test` chain. The chain entry in
  `package.json` is therefore load-bearing rather than cosmetic.
- **Every suite count moves, and there are two spellings of it.** "Ten suites" (the whole set) becomes
  eleven and "nine offline suites" becomes ten, in `AGENTS.md`, `CONTRIBUTING.md` (whose per-suite table
  gains the new suite and its cases), both READMEs, `docs/index.md`, `docs/contributor/testing.md`,
  `docs/contributor/index.md`, `docs/contributor/architecture.md`, `docs/contributor/development.md` and
  `docs/contributor/release-process.md`; the offline case total moves with them. `AGENTS.md`'s code map
  also carries the status count, so "the eight statuses a profile can report" becomes nine.
- **Documentation**: `README.md` and `README.zh-CN.md` (configuration table, both languages),
  `docs/user/reference/configuration.md`, `docs/user/reference/recovery.md` (what `force` may and may not
  cross: a changed declaration, never a refused one), `docs/user/reference/tools.md` (the status table,
  the new name, the per-profile failure row, and the `overridden locally:` line), the commented template in
  `cordis.patch.yml` (where the file lives — no new key), `docs/contributor/architecture.md` (the module,
  the classification and action tables, the state field), `docs/contributor/testing.md` (the new suite and
  the counts), `AGENTS.md` (the code map and the status count), and a `CHANGELOG.md` entry written for
  someone deciding whether to upgrade.