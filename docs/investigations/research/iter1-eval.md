# Identity Scorecard — Factory Pattern "Event RSVP"

**Run:** `2026-06-08-event-rsvp-90bc`
**Pattern under test:** `/Users/ben/code/pattern-factory/workspace/2026-06-08-event-rsvp-90bc/pattern/main.tsx`
**Canonical reference:** `/Users/ben/code/labs/docs/investigations/research/identity-map.md`
**Evaluator stance:** static read; the report is the only file written. Ground-truth, not prior-confirmation.

> Note on line numbers: `main.tsx` here is the **post-critic-fix** version (status buttons are static, name input is bound to `yourName`). `reviews/critic-001.md` cites the *pre-fix* line numbers; this report cites the current file.

---

## Headline verdict

This pattern is a **textbook "dead name string" identity model**. Identity is a `string` the user types into a field; people are rendered as `<span>{r.name}</span>`; "me" is a per-user *string* compared by lowercase equality; dedup is by normalized name. **Zero** canonical identity primitives are used — no `cf-avatar`, no `cf-profile-badge`, no `wish({query:"#profile"})`, no CFC authorship, no `cf-cfc-authorship`. It is internally clean, type-checks, and passes 30 tests, but it is the exact anti-pattern the identity-map warns against.

Crucially, **the factory's own pipeline never had a chance to do better**: the spec-interpreter explicitly decided "Identity is purely name-based, not account-based," the ux-designer made the RSVP name field *be* the identity mechanism, and the critic rubric contains **no identity dimension at all** (12 categories, none about user/person identity). So the failure is systemic, not a one-off model slip.

**One genuine positive:** the **state-scoping** is correct and idiomatic — `event`/`rsvps` are `PerSpace`, `yourName` is `PerUser` (`main.tsx:44-48`), and it did **not** invent DID/id fields to fake per-user isolation. That earns ID3 a real PASS.

---

## Scorecard (ID1–ID7)

| Dim | Verdict | One-line |
|---|---|---|
| ID1 Render others' identity | **FAIL** | People are `<span>{r.name}</span>` — dead strings, no `cf-avatar`/`cf-profile-badge`. |
| ID2 Render current viewer | **FAIL** | "Me" is a typed `yourName` string; no `#profile` wish, no "You" profile card. |
| ID3 Per-user vs shared state | **PASS** | `PerSpace` event/rsvps + `PerUser` yourName; no DID/id faking. |
| ID4 Join + snapshot idiom | **FAIL** | RSVP list ≈ a roster but keyed by typed name; no join, no name/avatar snapshot. |
| ID5 Authorship / ownership | **FAIL** | `organizer` + RSVP authorship are stored name strings; no CFC `AuthoredByCurrentUser`/`RepresentsCurrentUser`. |
| ID6 Identity-correctness pitfalls | **FAIL** | Dedup-by-name + compares mutable lowercased display names; no `equals()`/cell refs. |
| ID7 Identity UX | **PARTIAL** | Self *is* distinguished ("you" badge + tint) — good; but no avatars at all and no `alt`-bearing identity element. |

---

### ID1 — Render others' identity → FAIL

Every person in the guest list is a raw display string. No avatar, no badge.

`main.tsx:104-112` (`renderEntry`):
```tsx
<span style={{ fontWeight: "600", wordBreak: "break-word", ... }}>
  {r.name || "(unnamed)"}
</span>
```
That is the *entire* identity treatment for another person — `r.name` is a plain field off a serialized `Rsvp` object. No `cf-avatar` (which would be legal here — it carries no trust and is safe for any roster member), no `cf-profile-badge`.

**Improvement implies:** an **exemplar** + a **COMPONENTS.md** entry showing roster members rendered via `cf-avatar name={...} src={...}` at minimum. The identity-map (`§2`) confirms there is no *rule* forcing this today, which is precisely why the factory defaults to spans.

---

### ID2 — Render current viewer → FAIL

There is no resolution of the actual viewer. "Me" is whatever string the user typed, persisted in a `PerUser` cell.

`main.tsx:44-48`:
```tsx
yourName?: PerUser<Writable<string | Default<"">>>;
```
`main.tsx:480` — the viewer "identifies" by typing into a text input bound to that string:
```tsx
<cf-input $value={yourName} placeholder="Your name" />
```
No `wish({ query: "#profile" })` / `#profileName` anywhere (grep-confirmed: the strings `wish`, `#profile`, `cf-profile-badge`, `cf-avatar` do not appear in the file). There is no "You" card rendering the viewer's own profile cell — the canonical move (identity-map `§3a`, `packages/patterns/fair-share/main.tsx` "You" card) is absent.

**Improvement implies:** **spec-interpreter agent** guidance ("when a pattern needs the current viewer, resolve `#profile`/`#profileName`, don't add a self-typed name field") + an **exemplar** with a viewer "You" badge.

---

### ID3 — Per-user vs shared state → PASS (the real bright spot)

Scoping is correct and matches `docs/common/patterns/multi-user-patterns.md`.

`main.tsx:44-48`:
```tsx
event?: PerSpace<Writable<EventDetails | Default<typeof DEFAULT_EVENT>>>;
rsvps?: PerSpace<Writable<Rsvp[] | Default<[]>>>;
yourName?: PerUser<Writable<string | Default<"">>>;
```
Shared event + shared roster are `PerSpace`; the viewer's own name preference is `PerUser`. Transient form/edit state is plain pattern-body `Writable` (`main.tsx:172-185`) — correct (not in the input schema, so not scoped). Critically, it did **NOT** store DIDs / user-ids / synthetic ids to fake isolation — the identity-map anti-pattern (`§4b`) is avoided. The pattern-maker notes (`notes/pattern-maker.md:16-22`) show this was a deliberate, doc-grounded choice.

Caveat keeping it from being exemplary: because identity is a name string rather than scope-derived, the `PerUser` `yourName` is **decorative** — it drives a UI highlight but does not actually key the user's RSVP (the RSVP is keyed by the typed name in the shared array). So the scoping is right, but the identity model underneath it is not leveraging it.

---

### ID4 — Join + snapshot idiom → FAIL

The `rsvps` array is functionally a roster, but it is built from typed names, not a join+snapshot of each user's own identity.

`main.tsx:277-296` (`submitRsvp`): the "join" is "type a name, push/replace by normalized name":
```tsx
const entry: Rsvp = { name: trimmed, status, guestCount: guests, message: note };
const key = normalizeName(trimmed);
const idx = current.findIndex((r) => normalizeName(r.name) === key);
if (idx >= 0) rsvps.set(current.map((r, i) => (i === idx ? entry : r)));
else rsvps.push(entry);
```
The canonical roster idiom (identity-map `§4c`, `docs/specs/shared-profile-rosters.md`) is: each user joins and **snapshots their own name+avatar** into a `PerSpace` roster, with a `PerUser` "me" pointer (`me.set({ user: users.key(idx) })`). Here there is no `me` pointer into the roster, no avatar snapshot, and the "user" is a string anyone can spoof by typing.

**Improvement implies:** an **exemplar** roster (port of `scoped-user-directory`) + a **spec template** section: "Multi-person rosters: each viewer contributes their own snapshot on join; never key the roster by a typed name."

---

### ID5 — Authorship / ownership → FAIL

Two ownership concepts exist (event organizer; RSVP author) and **both** are stored name strings with no CFC attestation.

Organizer — `main.tsx:19-24`, displayed at `main.tsx:430`:
```tsx
organizer: string;  // EventDetails
...
Organized by {computed(() => event.get().organizer)}
```
RSVP author — the `Rsvp.name` field *is* the claimed author, set from a free-text field. Nothing prevents user B from submitting as "Alice." No `AuthoredByCurrentUser<T>` / `RepresentsCurrentUser<T>` wrappers (identity-map `§4d`), no `cf-cfc-authorship` chip. "Who created it / who responded" is entirely forgeable.

**Improvement implies:** **pattern-critic rubric** addition (a new "Identity & Authorship" category) + **COMPONENTS.md** entry for `cf-cfc-authorship` + spec-template note ("ownership/authorship of a record → CFC, not a stored name").

---

### ID6 — Identity-correctness pitfalls → FAIL

Hits multiple named anti-patterns from identity-map (`§4b` "use `equals()`+references, not id fields … never the mutable display name"):

- **Dedup-by-name** — `main.tsx:284-292` keys identity on `normalizeName(name)`.
- **Comparing mutable display names** — "is this me?" is `normalizeName(r.name) === ownKey` (`main.tsx:93`):
```tsx
const isMine = normalizeName(r.name) === ownKey && ownKey.length > 0;
```
- **No `equals()` / cell-reference identity** anywhere.

Consequence: two real people named "alex" collapse into one RSVP; renaming yourself silently steals/merges another entry; the "you" highlight lights up on anyone who shares your name. The identity-map's worked fix (`cfc-group-chat-demo/trusted.tsx`, `§4e`) compares the profile **cell** via `equals()`, never the name — the opposite of what this pattern does.

The spec even *enshrines* this: `spec.md:50-51` — "person name … Acts as the unique identifier for deduplication." So the bug is specified upstream, not introduced by the pattern-maker.

---

### ID7 — Identity UX → PARTIAL

The one identity-aware UX touch is genuinely present and correct in spirit: the viewer's own entry is distinguished by a tint + a "you" badge.

`main.tsx:99-119`:
```tsx
backgroundColor: isMine ? "var(--cf-color-gray-100)" : "transparent",
...
{isMine ? <cf-badge variant="solid" ...>you</cf-badge> : null}
```
Treatment is consistent across all sections (single `renderEntry`). **But:** (a) no avatars at all, so there's no visual person-recognition and no `alt`/name-bearing identity element for accessibility; (b) the distinction is built on the fragile name-equality from ID6, so it misidentifies same-named users. Hence PARTIAL: the *intent* (self vs others) is met; the *medium* (real identity components, accessible avatars) is not.

---

## Required reportbacks

### A) How does the pattern determine "the current user"?

**It asks the user to type their name into a text field, and persists that string per-user.** This is the crux and it is fully name-based.

- The field — `main.tsx:480`: `<cf-input $value={yourName} placeholder="Your name" />`.
- The store — `main.tsx:46`: `yourName?: PerUser<Writable<string | Default<"">>>`.
- It is *seeded* two ways, both from typed strings:
  - from the organizer field on event creation — `main.tsx:245-247`:
    ```tsx
    if (!yourName.get().trim()) { yourName.set(o); }
    ```
  - refreshed from the RSVP name on submit — `main.tsx:295`: `yourName.set(trimmed);`
- "Am I this row?" — `main.tsx:93`: `normalizeName(r.name) === ownKey`.

There is **no** `wish`, no `#profile`, no runtime-derived identity. The viewer is a self-declared, fully spoofable string.

### B) How are RSVPs keyed / deduped per person?

**Keyed by `name.trim().toLowerCase()` inside a shared `Rsvp[]`; upsert-in-place by linear `findIndex`.**

- Data structure — `main.tsx:27-32`:
  ```tsx
  export interface Rsvp { name: string; status: RsvpStatus; guestCount: number; message: string; }
  ```
  stored as `rsvps: PerSpace<Writable<Rsvp[]>>`.
- Key fn — `main.tsx:84`: `const normalizeName = (name) => name.trim().toLowerCase();`
- Update handler — `main.tsx:284-292` (quoted in ID4): `findIndex(normalizeName match)` → replace at index, else `push`. No id, no cell reference, no `equals()`.

### C) What did the spec-interpreter / ux-designer say about identity? ("Viewer Identity" framing)

They **invented a name-string identity on purpose** and named it a first-class entity.

- spec.md has a dedicated entity — `spec.md:57-66` **"Entity: Viewer Identity"**: "your name — The name the current viewer has set for themselves … When set, the guest list highlights this person's own entry … pre-fills the name field."
- spec-interpreter reasoning — `notes/spec-interpreter.md:42-46`: "I'll treat 'person name' as the identity key for deduplication. The 'current user' feature … needs some mechanism — I'll add a 'your name' field that the user sets once."
- The decisive assumption — `spec.md:180-183`: "**No authentication** … Participants self-identify by typing their name. **Identity is purely name-based, not account-based.**"
- ux-designer — `notes/ux-designer.md:81-86`: "Treat the RSVP form name field as the identity mechanism. When the user submits an RSVP, we remember that name. We don't need a separate 'set your name' UI."

So "Viewer Identity" intent = a persisted self-typed nickname for highlighting/pre-fill. They never considered `#profile` / real identity; the exemplars they leaned on (`habit-tracker`, `simple-list`) have no identity concept (`notes/spec-interpreter.md:100-102`).

### D) Did the factory critic flag ANY identity issue?

**No.** Not a single identity-correctness finding. The critic affirmatively *blessed* the name-based model.

- `reviews/critic-001.md:51` — **[PASS]** "No custom identity field — deduplication uses name-based lookup … The spec explicitly calls for name-based identity … **This is spec-correct.**"
- `reviews/critic-001.md:110` — **[PASS]** "ViewerIdentity (yourName) is separate" (treated purely as a state-shape concern).
- The 12 critic categories (`critic-001.md:13-127`) contain **no** "identity / person / avatar / authorship" dimension. Every CRITICAL finding is about `onClick`-inside-`computed()` mechanics; the one MAJOR is the *name pre-fill* spec-AC (`critic-001.md:173`) — i.e. it pushed the pattern *deeper* into name-as-identity (the fix bound the input directly to `yourName`, `notes/pattern-maker.md:83-90`).

This tells us the **critic guidance has a total identity blind spot** — the highest-leverage finding in this whole eval.

---

## E) Hypothesis scorecard

| # | Hypothesis | Result | Evidence |
|---|---|---|---|
| H1 | renders people as dead name strings, not cf-avatar/badge | **CONFIRMED** | `main.tsx:111` `{r.name}` in a `<span>`; no cf-avatar/cf-profile-badge in file. |
| H2 | no #profile current-viewer resolution / no "You" card | **CONFIRMED** | no `wish`/`#profile`; viewer is typed `yourName` (`main.tsx:46,480`). (A "you" *badge* exists, but it's name-equality, not a profile card.) |
| H3/H6 | RSVPs keyed by name string + dedup-by-name, not PerUser | **CONFIRMED** | dedup `normalizeName` upsert (`main.tsx:284-292`); `yourName` is PerUser but does NOT key the RSVP. |
| H4 | createdBy stored as a name, not CFC authorship | **CONFIRMED** | `organizer: string` (`main.tsx:23`), shown raw (`main.tsx:430`); no CFC. |
| H5 | roster from typed names, not join+snapshot | **CONFIRMED** | roster = typed-name upsert; no `me` pointer, no avatar snapshot (`main.tsx:277-296`). |

All five confirmed. The only nuance is H2: the pattern *does* visually distinguish self, so if the hypothesis is read strictly as "no self-distinction UX at all," that part is softer — but on the load-bearing claim (no `#profile`, no profile card) it is confirmed.

---

## F) Top improvement targets (ranked by leverage)

1. **Add an "Identity & Authorship" category to the pattern-critic rubric.** *Highest leverage* — the critic ran 12 categories and caught zero identity issues while explicitly blessing dead-string identity (`critic-001.md:51`). Concrete checks to add: "Are people rendered via `cf-avatar`/`cf-profile-badge`, not raw name strings/`<img>`? Is the current viewer resolved via `#profile`/`#profileName` rather than a self-typed name field? Is record ownership/authorship CFC-attested (`AuthoredByCurrentUser`/`RepresentsCurrentUser`), not a stored name? Is per-person identity keyed by cell reference/`equals()`, not by normalized display name?" *Where:* the pattern-critic agent prompt + `skills/pattern-critic` (and mirror the rule into `docs/development/debugging/gotchas/` as an "identity anti-patterns" gotcha).

2. **Give the spec-interpreter an identity decision rule.** The whole failure is seeded at `spec.md:180-183` ("Identity is purely name-based"). The agent should, when a brief involves multiple people or "the current user," default to: resolve the viewer via `#profile`; model people as profile cells/roster snapshots; only fall back to typed names if the runtime genuinely offers no identity (and say so explicitly). *Where:* spec-interpreter agent prompt + a "Viewer Identity" section in the **spec template** that points to the canonical primitives.

3. **Write a canonical multi-person exemplar** (e.g. `event-rsvp-identity` or port `scoped-user-directory`/`fair-share`) showing: `wish({query:"#profile"})` viewer resolution, a "You" `cf-profile-badge` card, roster members via `cf-avatar`, join+snapshot with a `PerUser` `me` pointer, and `equals()`/cell-reference dedup. *Where:* `packages/patterns/` + register in `packages/patterns/index.md`. Exemplars are what the factory agents actually imitate (`notes/spec-interpreter.md:94-102` shows imitation drives behavior), so this is the most direct behavior-changer after the rubric.

4. **Fill the COMPONENTS.md identity gap.** identity-map `§2` documents that `docs/common/components/COMPONENTS.md` has **no** entry for `cf-avatar`, `cf-profile-badge`, or `cf-cfc-authorship`. Add narrative entries with the "bind a profile **cell**, not strings" guidance and the avatar-vs-badge (untrusted vs trusted) distinction. *Where:* `docs/common/components/COMPONENTS.md`. This is the doc the pattern-maker actually reads (`notes/pattern-maker.md:11`).

5. **ux-designer: stop equating "the name field" with identity.** `notes/ux-designer.md:81-86` made the RSVP name input *be* the identity. Add guidance: a viewer's identity is their resolved profile (show a "You" badge), distinct from any per-record name field; render other participants with avatars/badges, not bare text. *Where:* ux-designer agent prompt.

---

## G) Representative identity-relevant snippets from main.tsx

1. **Identity = a typed string, per-user** (`main.tsx:46`):
```tsx
yourName?: PerUser<Writable<string | Default<"">>>;
```

2. **"Who am I" via free-text input** (`main.tsx:480`):
```tsx
<cf-input $value={yourName} placeholder="Your name" />
```

3. **"Is this me?" = mutable-display-name equality** (`main.tsx:92-93`):
```tsx
const renderEntry = (r: Rsvp, ownKey: string) => {
  const isMine = normalizeName(r.name) === ownKey && ownKey.length > 0;
```

4. **Other people rendered as dead strings** (`main.tsx:104-112`):
```tsx
<span style={{ fontWeight: "600", wordBreak: "break-word", ... }}>
  {r.name || "(unnamed)"}
</span>
```

5. **Dedup-by-name upsert (no cell/equals identity)** (`main.tsx:284-292`):
```tsx
const key = normalizeName(trimmed);
const idx = current.findIndex((r) => normalizeName(r.name) === key);
if (idx >= 0) rsvps.set(current.map((r, i) => (i === idx ? entry : r)));
else rsvps.push(entry);
```

6. **Authorship/ownership as a stored name string** (`main.tsx:23` + `main.tsx:430`):
```tsx
organizer: string; // EventDetails
...
Organized by {computed(() => event.get().organizer)}
```

---

## Appendix — what the factory got *right* (fairness check)

- **State scoping is idiomatic** (ID3): `PerSpace` shared data + `PerUser` viewer pref, transient UI as plain `Writable`. No DID/id-faking. This is real and matches `multi-user-patterns.md`.
- **Self-vs-others UX intent is present** (ID7 PARTIAL): the "you" badge + tint, applied uniformly. The *idea* is correct; only the medium (name-equality instead of identity) is wrong.
- **The pattern is otherwise well-built**: type-checks, 30/30 tests, no `onClick`-in-`computed` after the fix pass, defensive trims. The identity problem is a *design/guidance* gap, not sloppiness — which is exactly why the fix belongs in the factory's agents/docs/exemplars/rubric, not in this one pattern.
