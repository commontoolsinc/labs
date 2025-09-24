# UI Layout and List Improvements — Plan

This plan organizes work into small, testable phases with commits between
each. We will keep mobile tabs (with an option for top or bottom placement),
add floating icon toggles for sidebars on mobile, make desktop sidebars
displace content, and introduce missing primitives (toolbar, list item,
dropdown). Keybinds rely on existing `ct-keybind`.

## Ground Rules

- Build: `deno task check`
- Tests: `deno task test`
- Formatting: `deno fmt`
- Keep changes focused; commit between phases.

## Phase 1 — Toolbar and Key Hints

Goals:
- Add `ct-toolbar` to group controls in headers and content.
- Add `ct-kbd` helper for inline shortcut hints next to controls.
- Demonstrate pairing with existing `ct-keybind`.

Scope:
- `packages/ui/src/v2/components/ct-toolbar/` (new)
- `packages/ui/src/v2/components/ct-kbd/` (new)
- Export from `packages/ui/src/v2/index.ts`.
- Add examples to `recipes/common-ui-v2-showcase.tsx`.

API Sketch:
- `<ct-toolbar dense elevated sticky>` with slots `start`, `center`, `end`.
- `<ct-kbd>⌘K</ct-kbd>` minimal visual hint; no behavior.

Acceptance:
- Renders correctly in header; matches v2 theme tokens.
- Shortcut hints are readable and unobtrusive.

## Phase 2 — ct-autolayout Rework (Tabs + Sidebars)

Goals:
- Desktop: sidebars displace content (grid columns resize).
- Mobile: keep tabs UX, add floating icon buttons to toggle left/right
  sidebars; animate off‑canvas panels with scrim overlay.
- Add option for tab placement top or bottom.

Scope:
- Update `packages/ui/src/v2/components/ct-autolayout/ct-autolayout.ts`.
- Add properties/events:
  - `tabsPosition: "top" | "bottom"` (default: `bottom`).
  - `leftOpen` / `rightOpen` (reflect) for mobile off‑canvas.
  - Fire `ct-toggle-left` / `ct-toggle-right` when toggles used.
- Add floating `ct-button size="icon"` toggles on mobile.
- Add scrim, focus return, ESC/back close.

Behavior Details:
- Desktop: CSS grid with `[left?] 1fr [right?]`; avoid animating grid widths
  directly; animate inner wrappers with `transform` for smoothness.
- Mobile: tabs control the main content pages; sidebars slide over content with
  scrim. Tabs appear at top or bottom per `tabsPosition`.

Acceptance:
- Desktop: opening/closing sidebars reflows without jank.
- Mobile: toggles open/close sidebars with animation and scrim; tabs switch
  pages; `tabsPosition` respected.
- Keybind pairing works via `ct-keybind` from screen/header.

## Phase 3 — Dropdown / Menu Primitive

Goals:
- Provide a lightweight anchored dropdown for actions.

Scope:
- `packages/ui/src/v2/components/ct-dropdown/` (new)
- Overlay root at document level for correct stacking.
- Roles, ESC/outside click close, focus return to trigger.

API Sketch:
- `<ct-dropdown>` with slots `trigger` and default `content`.
- Props: `open`, `placement`, `align`, `closeOnSelect`.

Acceptance:
- Positions relative to trigger; works inside autolayout and lists.
- Keyboard and focus behavior are correct.

## Phase 4 — List Primitives

Goals:
- Add `ct-list-item` row primitive aligned with v2 theme.
- Update `ct-list` to use theme spacing/colors and interop with list-item.

Scope:
- `packages/ui/src/v2/components/ct-list-item/` (new)
- Update `packages/ui/src/v2/components/ct-list/ct-list.ts` styles to v2
  tokens and allow custom row rendering via slot or render function where
  appropriate.

List Item API:
- Slots: `leading`, default (title/content), `subtitle`, `meta`, `actions`.
- States: `selected`, `active`, `disabled` (attributes).
- Events: `ct-activate` (click/Enter).

Acceptance:
- Rows look consistent with v2; actions do not hijack row activation.
- `ct-list` can render items using `ct-list-item` without regressions.

## Phase 5 — Refactor Chatbot List View

Goals:
- Replace ad‑hoc chat rows with `ct-list` + `ct-list-item` and per‑row
  dropdown actions.
- Add screen‑level toolbar and keybinds.

Scope:
- Modify `packages/patterns/chatbot-list-view.tsx`:
  - Header uses `ct-toolbar` with "New Chat" button + `<ct-kbd>` hints.
  - Left sidebar shows chats as `ct-list` of `ct-list-item` with actions:
    Open, Rename, Duplicate, Delete via `ct-dropdown`.
  - Bind Cmd/Ctrl+N for new chat, Cmd/Ctrl+B for left toggle, Cmd/Ctrl+. for
    right toggle using `ct-keybind`.

Acceptance:
- Feature parity preserved; UI markedly improved and consistent.

## Phase 6 — Polish and Docs

Goals:
- A11y roles/labels, reduced motion support, safe area/touch targets.
- Update READMEs and component JSDoc.

Scope:
- Add roles: `toolbar`, `list`, `listitem`, `menu`, `menuitem`.
- Respect `prefers-reduced-motion` for slide/transform animations.
- Document new props/events in component files and `packages/ui/README.md`.

Acceptance:
- `deno task check` passes; manual smoke tests on desktop + mobile.

## Risks & Mitigations

- Layout jank on desktop: animate inner wrappers; keep grid stable.
- Focus management for off‑canvas and menus: trap within panel, restore on
  close; outside/ESC close; return focus to trigger.
- Keybind scope: mount binds within screen; keep `ignoreEditable` true.
- Item keys: ensure list items use stable ids, not array indices.

## Milestone Checklist per Phase

1. Implement
2. `deno task check`
3. Update showcase recipe/demo
4. Manual verify desktop + mobile
5. Commit

