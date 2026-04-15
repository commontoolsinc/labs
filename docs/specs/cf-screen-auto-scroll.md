# cf-screen Auto-Scroll Spec

**Status**: Draft
**Date**: 2026-04-15

## Overview

`cf-screen` is a full-height layout component with header/main/footer slots. Its
`.main` area currently has **no overflow rule**, so content that exceeds the
viewport is silently clipped by `overflow: hidden` on `:host`. Every pattern that
puts scrollable content in the main area must wrap it in `cf-vscroll` to avoid
this trap — but nothing enforces or clearly explains that requirement.

This spec adds `overflow-y: auto; overflow-x: hidden` to `.main`, making
`cf-screen` the single component patterns need for full-page layouts:
short content stretches to fill the space; long content scrolls automatically.
`cf-vscroll` becomes an optional upgrade for advanced scroll features
(snap-to-bottom, fade-edges, styled scrollbar).

### The problem in one sentence

`cf-screen` clips overflowing content, so 26+ patterns must pair it with
`cf-vscroll` just to get basic scrolling — a footgun for every new pattern.

### Motivating examples

- A `cf-vstack` with many items placed directly inside `cf-screen` gets clipped
  with no visible scrollbar. Two patterns (`notebook.tsx`, `daily-journal.tsx`)
  independently discovered this and added manual `overflow: auto` wrapper divs.
- AI-generated patterns frequently forget `cf-vscroll` and ship layouts with
  invisible content below the fold.
- The note.tsx code-editor case works correctly today (editor fills space via
  `flex: 1`) and must continue to work.

---

## Current state (verified)

**File:** `packages/ui/src/v2/components/cf-screen/cf-screen.ts`

```css
:host {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;       /* ← contains everything */
  box-sizing: border-box;
}

.header { flex: none; }

.main {
  flex: 1;
  min-height: 0;          /* ← allows flex children to shrink */
  display: flex;
  flex-direction: column;
  /* no overflow — content clips against :host */
}

.footer { flex: none; }
```

Three slots: `header` (named), default (main), `footer` (named). ~109 pattern
files use this component. ~26 of those pair it with `cf-vscroll`.

### The scroll chain (shell → pattern)

```
OmniLayout .main          overflow: auto    ← shell-level scroll
  cf-render :host          overflow: hidden  ← containment boundary
    .render-container      overflow: auto    ← pattern-level scroll
      cf-screen :host      overflow: hidden  ← opts out of shell scroll
        .main              (none)            ← THE GAP — content clips here
```

Patterns without `cf-screen` scroll via `.render-container`. Patterns with
`cf-screen` (for header/footer pinning) take `height: 100%`, fill the container
exactly, and must manage their own scrolling — but `.main` provides none.

---

## Proposed change

Add two overflow properties to `.main`:

```css
.main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;       /* ← NEW: scroll when content overflows */
  overflow-x: hidden;     /* ← NEW: prevent horizontal scroll */
}
```

`overflow-x: hidden` matches `cf-vscroll`'s existing behavior and prevents wide
content (long URLs, pre-formatted text) from creating unexpected horizontal
scrollbars at the layout level. Components that need horizontal scroll
(`cf-hscroll`, `cf-table`) handle it internally.

---

## Backward compatibility analysis

| Scenario | Count | Before | After | Risk |
|---|---|---|---|---|
| `cf-screen` + `cf-vscroll[flex]` | 26+ | cf-vscroll fills .main via flex:1, handles own scroll | Same — .main never overflows | None |
| `cf-screen` alone, content fits | ~10 | Content fills space | Same | None |
| `cf-screen` alone, content overflows | ~10 | **Silently clipped** | **.main scrolls** | Fix, not regression |
| `cf-screen` + self-scrolling child (code editor) | ~3 | Editor fills .main via flex:1, manages own scroll | Same — .main never overflows | None |

**No pattern benefits from the current clipping behavior.** Two patterns already
work around it with manual `overflow: auto` wrappers.

### Why not opt-in (`<cf-screen scroll>`)?

An attribute would not fix the core problem — the silent clipping trap remains
the default. The clipping is a bug, not a feature. Making `.main` scrollable by
default is strictly better for all existing patterns.

---

## New mental model

```
No cf-screen          → Shell scrolls your whole UI as a page
cf-screen             → App layout: pinned header/footer, auto-scrolling main
cf-screen + cf-vscroll → Same, plus advanced scroll features
```

**When to use each:**

| Component | Use when |
|---|---|
| Neither | Sub-patterns, embedded variants, data-only patterns |
| `cf-screen` alone | Any full-page pattern with header/footer — content scrolls automatically |
| `cf-screen` + `cf-vscroll` | Chat (snap-to-bottom), lists with fade-edges, or styled/hidden scrollbar |

---

## Documentation updates

### 1. `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md`

Add a `cf-screen` entry (currently missing entirely):

```
### N. cf-screen

**Purpose**: Full-height app layout with pinned header/footer and auto-scrolling
main area. **Tag**: `<cf-screen>`

**Slots**:
- `header` — Fixed content at the top (use with cf-vstack or cf-heading)
- (default) — Main content area. Stretches to fill available height;
  scrolls automatically when content overflows.
- `footer` — Fixed content at the bottom (use with cf-hstack for actions)

**Usage notes**:
- Use for any full-page pattern that needs header/footer pinning
- Content in the default slot scrolls automatically — no need for cf-vscroll
  unless you need snap-to-bottom (chat), fade-edges, or styled scrollbar
- Do NOT nest cf-screen inside another cf-screen

**Example**:
<cf-screen>
  <cf-heading slot="header" level={2}>Title</cf-heading>
  <cf-vstack gap="4" padding="4">
    {/* content — scrolls if it overflows */}
  </cf-vstack>
  <cf-hstack slot="footer" gap="2" padding="4">
    <cf-button>Action</cf-button>
  </cf-hstack>
</cf-screen>
```

### 2. `docs/common/components/COMPONENTS.md`

Rewrite the `cf-screen` section. Current text implies `cf-vscroll` is required
inside `cf-screen`:

```markdown
## cf-screen

Full-height app layout with pinned header, auto-scrolling main area, and pinned
footer. Use instead of manual `height: 100%` + flexbox, which breaks because
parent heights aren't explicit in the pattern rendering context.

\`\`\`tsx
// Simple case — main area scrolls automatically
<cf-screen>
  <cf-heading slot="header" level={2}>Title</cf-heading>
  <cf-vstack gap="4" padding="4">
    {items}
  </cf-vstack>
</cf-screen>

// Advanced case — snap-to-bottom for chat
<cf-screen>
  <cf-heading slot="header" level={2}>Chat</cf-heading>
  <cf-vscroll flex snapToBottom fadeEdges>
    {messages}
  </cf-vscroll>
  <cf-message-input slot="footer" />
</cf-screen>
\`\`\`

Use `cf-vscroll` inside `cf-screen` only when you need snap-to-bottom,
fade-edges, or a styled/hidden scrollbar. For everything else, content in the
default slot scrolls automatically.
```

### 3. `docs/common/patterns/ui-cookbook.md`

Update the default recipe (section 1) to show `cf-screen` alone as the simple
default. Keep `cf-vscroll` in the recipe as a commented-out upgrade path:

```tsx
<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>Pattern</cf-heading>
    <cf-vstack gap="4" padding="4">
      {/* main content — scrolls automatically */}
    </cf-vstack>
  </cf-screen>
</cf-theme>
```

Add a note: "For chat patterns or lists that need snap-to-bottom, wrap the body
in `<cf-vscroll flex snapToBottom fadeEdges>` instead of placing it directly in
the default slot."

### 4. `skills/pattern-ui/SKILL.md`

Update lines 59-61 which currently say:

> put the body content inside `cf-vscroll` rather than placing a long stack
> directly under `cf-screen`

Replace with:

> Content in `cf-screen`'s default slot scrolls automatically when it overflows.
> Use `cf-vscroll` only when you need snap-to-bottom (chat), fade-edges, or
> styled scrollbar.

Also update the layout structure example (lines 114-123) to show the simple
case without `cf-vscroll`, with a comment showing when to add it.

---

## Scrollbar styling note

When `.main` scrolls, the native browser scrollbar appears. This looks different
from `cf-vscroll`'s styled scrollbar. Adding `scrollbar-width: thin` to `.main`
would give a subtler native look. This is optional for v1.

---

## Verification plan

1. **No double scroll**: Open a pattern using `cf-screen` + `cf-vscroll`
   (e.g., `do-list.tsx`). Verify only the `cf-vscroll` scrollbar appears, not a
   second one on `.main`.
2. **Code editor fill**: Open `note.tsx`. Verify the code editor still fills the
   remaining height without scrollbar on `.main`.
3. **Auto-scroll works**: Create a test pattern with `cf-screen` + a long
   `cf-vstack` (no `cf-vscroll`). Verify it scrolls instead of clipping.
4. **Grep for workarounds**: Search for patterns that manually add
   `overflow: auto` wrappers inside `cf-screen`. These are now redundant.

---

## Optional follow-up (same or separate PR)

- Remove the redundant `overflow: auto` workarounds in `notebook.tsx` and
  `daily-journal.tsx`.
- Add a basic test for `cf-screen` that verifies `.main` is scrollable when
  content overflows. (There are currently no tests for this component.)

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| Move cf-screen into the shell | Patterns have different headers/footers; needs new protocol; breaks "pattern is a standalone app" model |
| Replace cf-screen with `<cf-container fullHeight scroll />` | 109 files to migrate; same functional result as the CSS fix |
| Opt-in `<cf-screen scroll>` attribute | Clipping is a bug, not a feature — opt-in leaves the trap as the default |
| Change cf-render's .render-container instead | Affects ALL patterns, not just cf-screen users; could create double-scroll for patterns that already manage their own scroll |
