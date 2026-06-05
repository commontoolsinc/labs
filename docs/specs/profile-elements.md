# Profile Elements — Design Decision (CT-1651)

## Status

Design decision + documentation. **Implementation deferred until after Berni's
PR #3830 (multi-profile support) merges.** This document decides behavior, UI
copy, and the `wish({ scope: ["profile"] })` contract; it changes no code.

Tracks Linear issue **CT-1651: "Clarify or complete profile elements"**.

## Summary

The profile space can hold "profile elements," and
`wish({ query: "#tag", scope: ["profile"] })` can search them by hashtag. The
issue asks whether elements are **references**, **deployed pieces**, or
**both**, and to align the UI, copy, and docs accordingly.

**Verdict (recommended direction): profile elements are *references* today and
should be documented and renamed as references.** The "Pattern URL" element flow
does **not** compile or deploy the pattern at the URL; it stores the URL string
and renders a small display card. Promoting elements to genuinely deployed
pieces is possible but is a larger, separate effort (a follow-up issue), not a
rename. This document recommends shipping the rename/clarification first and
treating "deploy a pattern URL into the profile space" as opt-in future work.

---

## 1. Current behavior (code-grounded)

### 1.1 What a `ProfileElement` stores

The type, in `packages/patterns/system/profile-home.tsx:40-46`:

```ts
export type ProfileElement = {
  cell: any;
  tag: string;
  userTags: readonly string[];
  title?: string;
  source?: "catalog" | "url";
};
```

- `cell` — a cell ref produced by instantiating one of two **local display
  sub-patterns** (see below), pinned with `.for(tag)`.
- `tag` — the hashtag-search snapshot string (defaults to the catalog id, the
  pattern URL, or `"profile"`; `profile-home.tsx:138`).
- `userTags` — user-supplied tags stored **without** the `#` prefix
  (`profile-home.tsx:147`, `:224`).
- `title` — display label.
- `source` — `"catalog"` or `"url"`, decided by whether `event.patternUrl` is
  present (`profile-home.tsx:135`).

### 1.2 The two element "kinds" are both local display cards

Two sub-patterns are defined **inside `profile-home.tsx`** and instantiated by
the handlers:

`ProfileCatalogCard` (`profile-home.tsx:94-103`) renders just a bold title:

```tsx
const ProfileCatalogCard = pattern<{ title: string }, ProfileElementCell>(
  ({ title }) => ({
    [NAME]: title,
    [UI]: (<cf-vstack ...><strong>{title}</strong></cf-vstack>),
  }),
);
```

`UrlPatternReference` (`profile-home.tsx:105-118`) renders the title **and the
URL string as plain text** — it never fetches, compiles, or runs anything at
that URL:

```tsx
const UrlPatternReference = pattern<
  { title: string; url: string },
  ProfileElementCell
>(({ title, url }) => ({
  [NAME]: title,
  [UI]: (
    <cf-vstack ...>
      <strong>{title}</strong>
      <span ...>{url}</span>   // <-- the URL is displayed, not loaded
    </cf-vstack>
  ),
}));
```

### 1.3 What `addElement` actually does

`addElement` (`profile-home.tsx:131-151`):

```ts
const source = event.patternUrl ? "url" : "catalog";
...
const cell = source === "url"
  ? (UrlPatternReference({ title, url: event.patternUrl ?? "" }) as any).for(tag)
  : (ProfileCatalogCard({ title }) as any).for(tag);
appendElement({ cell, tag, userTags: event.userTags ?? [], title, source }, elements);
```

The "Pattern URL" path instantiates the **local** `UrlPatternReference`
sub-pattern with the URL passed as a *string prop*. It does **not** call
`HttpProgramResolver`, `patternManager.compilePattern`, `runtime.run`, or
`PatternFactory.inSpace(...)`. The string at `patternUrl` is never resolved as a
program. `addUrlElement` (`profile-home.tsx:206-229`) is the UI-button variant
and behaves identically.

`.for(tag)` only pins the sub-pattern instance to a stable cause within the
**current (profile) space** — it does not create a new space. Contrast this with
the genuine deploy mechanism (§1.6).

**Conclusion: a "Pattern URL" element is a reference card, not a deployed
pattern.** It is closer to a favorite/bookmark than to a running piece.

### 1.4 How elements are rendered

In the profile UI (`profile-home.tsx:343-362`), each element renders as a
`cf-cell-link` to `element.cell` (the local card) plus its `#userTags` and a
Remove button:

```tsx
{elements.map((element) => (
  <cf-hstack ...>
    <cf-cell-link $cell={element.cell}>{element.title ?? element.tag}</cf-cell-link>
    <span ...>{element.userTags.map((tag) => `#${tag}`).join(" ")}</span>
    <cf-button ... onClick={removeElementCell({ elements, cell: element.cell })}>
      Remove
    </cf-button>
  </cf-hstack>
))}
```

So even the rendered output is a link to a tiny local card whose body is the
title (catalog) or title + URL text (url).

### 1.5 How `scope: ["profile"]` search works

The search path lives in `packages/runner/src/builtins/wish.ts`.

- Scope dispatch: `searchByHashtag` sets
  `const searchProfile = ctx.scope?.includes("profile")` (`wish.ts:552`) and, if
  true, calls `searchProfileForHashtag` (`wish.ts:573-581`).
- `searchProfileForHashtag` (`wish.ts:481-534`):
  1. Resolves the profile element list via
     `getProfileDefaultCell(ctx).key("elements").asSchema(profileElementListSchema)`
     (`wish.ts:487-494`). `getProfileDefaultCell` reaches
     `homeSpaceCell.defaultPattern.profile` and throws a `WishError` if the
     profile link is unset (`wish.ts:279-309`).
  2. Reads the elements; if the cell hasn't loaded yet it returns
     `{ matches: [], loaded: false }` so the reactive system re-triggers
     (`wish.ts:500-502`).
  3. Filters each entry (`wish.ts:514-520`):
     - **`userTags` exact match** (lowercased, no `#`):
       `t.toLowerCase() === searchTermWithoutHash`.
     - else **`tag` hashtag match** via
       `tagMatchesHashtag(entry.tag, searchTermWithoutHash)`
       (`tagMatchesHashtag`, `wish.ts:181-187`, extracts `#([a-z0-9-]+)` from the
       tag string and requires an exact token match).
  4. Maps each match to `{ cell: match.cell, pathPrefix }`, dropping entries
     without a `cell` (`wish.ts:528-530`).

The matched `cell` is then path-resolved and returned in the unified
`{ result, candidates, [UI] }` wish shape; `[UI]` falls back to a
`cf-cell-link` if the resolved cell has no `[UI]`
(`wish.ts:1723-1748`). Because the element `cell` is the local display card, the
returned `[UI]` is that card.

The `tag` snapshot semantics match favorites exactly
(`searchFavoritesForHashtag`, `wish.ts:329-375`): `userTags` first, then a
hashtag extracted from the snapshot `tag` string. Profile differs from
mentionables, which compute the tag from the live schema (`wish.ts:443-467`).

### 1.6 The genuine "deploy into a space" mechanism (for contrast)

The repo *does* have a real deploy-into-a-new-space mechanism, used for the
profile **space itself** in `profile-create.tsx:36-42`:

```ts
profile.set(
  ProfileHome.inSpace(name)({ initialName: name }) as ProfileHomeOutput,
);
```

`PatternFactory.inSpace(...)` (declared `packages/api/index.ts:1355`; resolved
`packages/runner/src/builder/pattern.ts:444-445`, `:479-531`) runs a pattern in
a **new/derived space DID**. And ordinary piece creation goes through the
`addPiece` handler wished from `#default`
(`docs/common/conventions/adding-pieces.md`), which compiles and instantiates a
real piece (`MentionablePiece`). The profile-element "Pattern URL" flow uses
**neither** of these — confirming it is a reference, not a deployed piece.

---

## 2. Decision

**Profile elements are references. Recommend renaming/clarifying to match, and
deferring true deployment to an opt-in follow-up.**

### Why references is the right model for v1

1. **It matches the implemented code.** Nothing in `addElement` compiles or runs
   the URL (§1.3); the URL is rendered as text (§1.2). Calling it a "deployed
   pattern" would be a documentation lie.
2. **It mirrors how the system already models lightweight saved things.** The
   profile element list is explicitly the profile-space analog of **favorites**
   (`shared-profile-space.md:159-166`), and favorites are references with a
   snapshotted `tag` (`wish.ts:329-375`). The profile search path is a near-copy
   of the favorites search path. References are the consistent, low-risk model.
3. **Deployment already has a home.** When something genuinely needs to run in a
   space, the system uses `inSpace(...)` (§1.6) or `addPiece` from `#default`.
   Profile elements don't need to duplicate that; if a user wants a *running*
   pattern, they deploy a piece and can `wish` for it via a DID scope. Profile
   elements are the user's portable "pin these references to me" list.
4. **Smaller, safer change.** A rename + doc clarification carries no
   authorization, compilation, or cross-space-write risk. Real deployment would
   need: program resolution, owner-authorized writes into the profile space,
   dedup of deployed instances, and lifecycle/removal of deployed pieces — all
   CFC-protected surfaces.

### Could elements be "both"?

Yes, eventually — a single list can hold both reference cards and links to
genuinely deployed pieces, distinguished by `source`. But "both" should be
reached **incrementally**: ship references-with-honest-copy now, then add a
`source: "deployed"` (or similar) path later (§5). Do not block the rename on the
deployment work.

### Interaction with PR #3830

PR #3830 rewrites profile-**candidate** resolution in `wish.ts` (multi-profile:
`profiles[]` + default + MRU, with `#profile` resolving the default). It does
**not** touch the profile-**elements** code path (`searchProfileForHashtag`,
`profile-home.tsx`). However, both depend on `getProfileDefaultCell` /
`homeSpaceCell.defaultPattern.profile`. After #3830, "the profile" becomes "the
**default** profile." Implementation of this decision must therefore:

- Land **after** #3830 to avoid conflicts in `wish.ts`.
- Treat `scope: ["profile"]` as "search the **default** profile's elements"
  (matching #3830's `#profile` → default-profile semantics), and note that
  searching a *non-default* profile's elements (e.g. by DID) is out of scope for
  v1 unless #3830 introduces a natural hook.

---

## 3. Implied UI / copy changes

Because elements are references, the "Pattern URL" framing overpromises
(it reads as "deploy the pattern at this URL"). Proposed copy changes in
`packages/patterns/system/profile-home.tsx` (deferred to implementation):

| Location (current) | Current text | Proposed text |
|---|---|---|
| `:325` label | `Pattern URL` | `Link URL` (or `Reference URL`) |
| `:326` input placeholder | `/api/patterns/...` | `https://… or /api/patterns/… (saved as a link)` |
| `:338` button | `Add URL element` | `Add link` |
| `:321` button | `Add profile card` | `Add card` (unchanged meaning; optional) |
| sub-pattern name `:105` | `UrlPatternReference` | keep — name is already honest |

Notes:
- The `source: "url"` value can stay; only user-facing copy changes. If desired,
  rename the value to `source: "link"` for clarity, but that touches the type,
  the handlers, and `profileElementListSchema` (`wish.ts:57-74`) — keep it as a
  separate, optional cleanup.
- Add a one-line helper under the field: *"Links are saved as reference cards.
  They are not deployed or run."* This removes the core ambiguity the issue
  flags.

If, instead, the team chooses to make elements deployable (not recommended for
v1), see §4 / §5 for the design-level flow; in that case the "Pattern URL" copy
stays but the handler must actually compile + run the URL.

---

## 4. `wish({ query: "#tag", scope: ["profile"] })` documentation

### Contract

`wish({ query: "#tag", scope: ["profile"] })` searches the **current user's
(default) profile** element list — `homeSpaceCell.defaultPattern.profile.elements`
— and returns the cells of matching profile elements in the unified wish shape
`{ result, candidates, [UI] }`.

Matching rules (`wish.ts:514-520`), applied per element in order:

1. **`userTags` exact match** — case-insensitive, no `#`. `#person` matches an
   element whose `userTags` contains `"person"`.
2. **`tag` hashtag match** — if no userTag matched, the element's snapshot `tag`
   string is scanned for `#([a-z0-9-]+)` tokens and must contain the exact
   search token. `#profile-card` matches `tag: "profile-card"` only if the tag
   string contains `#profile-card`; note the catalog default stores the **bare**
   id (`profile-home.tsx:138`), so authors should ensure the searchable token is
   present (see Example 2 caveat).

Behavior details:
- If the profile link is unset, `getProfileDefaultCell` throws a `WishError`
  (`wish.ts:291`); with `scope: ["profile"]` only, the wish surfaces an error
  state rather than crashing the scheduler (`searchByHashtag` aggregates and the
  action catches; `wish.ts:597-612`, `:1811-1836`).
- If the elements cell hasn't loaded, the search returns "pending" (empty) and
  re-triggers reactively (`wish.ts:500-502`, `:1651-1672`).
- Scope can be combined. Search order is favorites (`~`), current-space
  mentionables (`.`), profile (`profile`), then explicit DIDs
  (`wish.ts:557-595`).
- The returned `[UI]` is the matched element's card UI (the local
  `ProfileCatalogCard` / `UrlPatternReference`), or a `cf-cell-link` fallback
  (`wish.ts:1743`).

### Example 1 — userTag match (recommended pattern)

Setup: user added a catalog element with
`addElement({ catalogId: "profile-card", title: "Profile card", tag: "profile-card", userTags: ["person"] })`
(see `profile-home.test.tsx:8-13`).

```tsx
const me = wish({ query: "#person", scope: ["profile"] });
```

- **Matches**: the element, because `userTags` contains `"person"` (rule 1).
- **Returns**: `me.result` = that element's `cell` (the `ProfileCatalogCard`
  instance); `me.candidates` = `[that cell]`; `me[UI]` = the card showing
  "Profile card".

### Example 2 — tag-token match across mixed scope

Setup: a profile element whose snapshot `tag` contains a hashtag token, e.g.
`tag: "#portfolio"`, plus a favorite also tagged `#portfolio`.

```tsx
const portfolio = wish({ query: "#portfolio", scope: ["~", "profile"] });
```

- **Searches**: favorites first, then profile elements.
- **Matches**: any favorite and any profile element whose `userTags` include
  `portfolio` **or** whose `tag` string contains the `#portfolio` token
  (rule 2).
- **Returns**: if exactly one match, `result` is that cell and `[UI]` is its
  card; if multiple, `candidates` holds all of them and the suggestion picker is
  launched (`wish.ts:1749-1810`).
- **Caveat**: a profile element created with only `tag: "portfolio"` (bare, no
  `#`) will **not** match via rule 2, because `tagMatchesHashtag` extracts
  `#`-prefixed tokens (`wish.ts:185`). To make tag-based discovery reliable,
  rely on `userTags` (rule 1, stored bare and compared directly) or store the
  hashtag form in `tag`. This caveat should be called out wherever element
  creation is documented.

### Where this belongs in user docs

`docs/common/conventions/wish.md` already documents the `"profile"` scope
(lines 76-78, 94-95, 124-136). This section should be reconciled with that doc
during implementation — specifically adding the **userTags-vs-tag matching
caveat** (Example 2), which the existing doc does not spell out.

---

## 5. Deferred implementation plan (post-#3830)

> All items land **after PR #3830 merges**, to avoid conflicts in `wish.ts`'s
> profile-candidate resolution. None of these are implemented by this document.

### A. Rename / clarify (the recommended v1)

- [ ] Apply the copy changes in §3 to `profile-home.tsx` (label, placeholder,
      button text, helper line). No type/schema changes required.
- [ ] Update `docs/common/conventions/wish.md` to add the userTags-vs-tag
      matching caveat (§4 Example 2) and a one-line "elements are references"
      note.
- [ ] (Optional) Rename `source: "url"` → `source: "link"` across
      `ProfileElement` (`profile-home.tsx:40-46`), the handlers, and
      `profileElementListSchema` (`wish.ts:57-74`). Keep as a separate PR.

### B. Tests (currently deferred per CT-1651; specified here)

- [ ] **Element search (runner)** — extend `packages/runner/test/wish.test.ts`:
  - `scope: ["profile"]` matches an element by `userTags` (rule 1).
  - `scope: ["profile"]` matches an element by `#`-token in `tag` (rule 2).
  - a bare (`#`-less) `tag` does **not** match via rule 2 (locks in the caveat).
  - unset profile link yields an error `WishState`, not a thrown scheduler
    action.
  - mixed scope `["~", "profile"]` returns favorites + profile matches in order.
- [ ] **Element rendering (pattern)** — extend
      `packages/patterns/system/profile-home.test.tsx`:
  - adding a `url` element stores `source: "url"`, `title`, `tag`, and renders
    the URL text (asserts it is a reference card, not a deployed run).
  - dedup: adding the same element twice yields one entry
    (`appendElement`, `profile-home.tsx:120-129`).
- [ ] **Integration (optional)** — a demo pattern that `wish`es
      `#tag scope:["profile"]` and renders `result`/`[UI]`, asserting the card
      appears (mirrors `shared-profile-space.md:360-425`).

### C. Future opt-in: deployable elements (NOT v1)

If/when "both" is pursued, as a **separate** issue:

- [ ] Add an explicit `source: "deployed"` (or `"piece"`) path to
      `AddProfileElementEvent` / `addElement`.
- [ ] In that path, resolve + compile the pattern URL via `HttpProgramResolver`
      + `patternManager.compilePattern` and run it into the **profile space**
      (via `inSpace(...)` or the profile-space `addPiece`), storing a link to
      the running piece in `element.cell`.
- [ ] Gate the deploy write behind the existing owner CFC integrity on
      `profileDefault.elements` (`shared-profile-space.md:241-281`).
- [ ] Handle removal/lifecycle of deployed instances distinctly from dropping a
      reference.
- [ ] Coordinate with #3830 multi-profile: decide whether deploy targets the
      **default** profile space or an explicitly selected profile.

---

## Open ambiguities (could not be resolved from code alone)

1. **Intended product meaning of "Pattern URL."** The code unambiguously stores
   a reference, but whether the *original intent* was eventual deployment is not
   recoverable from code. This doc recommends references; a product owner should
   confirm before any deploy work (§5C).
2. **`source: "url"` rename.** Whether to rename the stored value (not just UI
   copy) is a judgement call with schema ripple (`wish.ts:57-74`); left optional.
3. **Non-default profile element search.** With #3830's multi-profile model, it
   is unclear whether `scope: ["profile"]` should ever search a non-default
   profile. Code today only knows the single/default profile; deferred to a
   #3830 follow-up.
