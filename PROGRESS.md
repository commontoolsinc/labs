# Omnibot Refactor Progress

## Plan

See `/Users/ben/.claude/plans/floating-squishing-wren.md` for the full plan.

## Goal

Refactor the Omnibox from a bottom-right FAB into a bottom-center pill omnibar,
and add external pinning so users can Alt+hover any cell on the page and pin it
to the Omnibot conversation context.

## Completed Steps

### 1. Added `pinCell`/`unpinAllCells` streams to `llm-dialog.ts` ✅

- **File:** `packages/runner/src/builtins/llm-dialog.ts`
- Added `pinCell` and `unpinAllCells` to result schema with `asStream: true`
- Added `{ $stream: true }` markers in initial result write
- Registered handlers using `createHandler` pattern (pinCell checks duplicates +
  appends, unpinAllCells clears)

### 2. Updated `BuiltInLLMDialogState` types ✅

- **File:** `packages/api/index.ts`
- Added `pinCell: Stream<{ path: string; name: string }>` and
  `unpinAllCells: Stream<void>`

### 3. Exposed pin streams from `chatbot.tsx` ✅

- **File:** `packages/patterns/chatbot.tsx`
- Destructured `pinCell` and `unpinAllCells` from `llmDialog()` return
- Added to `ChatOutput` type and pattern return value

### 4. Wired `pinToChat` handler in `omnibox-fab.tsx` and `default-app.tsx` ✅

- **File:** `packages/patterns/system/omnibox-fab.tsx`
  - Added `Stream` import, created `handleExternalPin` handler
  - Handler: if !accumulate → unpinAllCells, then pinCell, then fabExpanded=true
  - Exported as `pinToChat` on pattern return
- **File:** `packages/patterns/system/default-app.tsx`
  - Added `pinToChat: fab.pinToChat` to pattern return

### 5. Added "pin" button to `ct-cell-context` toolbar ✅

- **File:** `packages/ui/src/v2/components/ct-cell-context/ct-cell-context.ts`
- Added "pin" button after watch/unwatch in Alt+hover toolbar
- `_handlePinClick` reads `e.shiftKey` for accumulate mode
- Emits `ct-cell-pin` event with `{ cell, label, accumulate }` (bubbles +
  composed)

### 6. Shell bridge: catch `ct-cell-pin` in `BodyView.ts` ✅

- **File:** `packages/shell/src/views/BodyView.ts`
- Added `connectedCallback`/`disconnectedCallback` with `ct-cell-pin` listener
- `_handleCellPin`: extracts cell ref, constructs LLM-friendly path (`/${id}` or
  `/${id}/${path}`), sends to
  `rootCell.key("pinToChat").send({path, name, accumulate})`

### 7. Restyled `ct-fab` as pill omnibar ✅

- **File:** `packages/ui/src/v2/components/ct-fab/ct-fab.ts`
  - Collapsed: 360x48px pill (border-radius 24px), light surface bg with border
  - Shows ct-logo + "Ask about anything..." placeholder text
  - Expanded: width `min(560px, calc(100vw-48px))`
  - Added `position="bottom-center"` variant with centered CSS + backdrop mask
  - Repositioned preview notification to center
- **File:** `packages/shell/src/components/OmniLayout.ts`
  - Changed `.fab` slot from `right: 24px` to
    `left: 50%; transform: translateX(-50%)`
- **File:** `packages/html/src/jsx.d.ts`
  - Added `"bottom-center"` to `CTFabAttributes.position` type union

### 8. Restructured `omnibox-fab.tsx` layout ✅

- **File:** `packages/patterns/system/omnibox-fab.tsx`
  - Changed position to `"bottom-center"`
  - Prompt input now at TOP (omnibar feel), attachments bar below, chat history
    at bottom (always visible)
  - Removed chevron toggle, showHistory state, peek preview, peekDismissedIndex
  - Kept `latestAssistantMessage` for fab's `$previewMessage` prop

### 9. Drop-to-pin on omnibar ✅

- **File:** `packages/patterns/system/omnibox-fab.tsx`
  - Wrapped `<ct-fab>` with `<ct-drop-zone onct-drop={handleDropToPin(...)}>`
  - Added `handleDropToPin` handler: extracts `sourceCell.ref()` for path, tries
    `NAME` for label
  - Drop always replaces (accumulate=false); use Alt+hover pin button + Shift to
    accumulate

## Build Status

- `deno task check` passes (exit code 0, no errors)

## Remaining Work

- Test the full flow end-to-end in a running dev environment

## Files Modified (complete list)

1. `packages/runner/src/builtins/llm-dialog.ts` — pin/unpin streams
2. `packages/api/index.ts` — BuiltInLLMDialogState types
3. `packages/patterns/chatbot.tsx` — expose pin streams
4. `packages/patterns/system/omnibox-fab.tsx` — handleExternalPin,
   handleDropToPin, layout restructure, position, ct-drop-zone wrapper
5. `packages/patterns/system/default-app.tsx` — expose pinToChat
6. `packages/ui/src/v2/components/ct-cell-context/ct-cell-context.ts` — pin
   button
7. `packages/shell/src/views/BodyView.ts` — ct-cell-pin event bridge
8. `packages/ui/src/v2/components/ct-fab/ct-fab.ts` — pill restyle
9. `packages/shell/src/components/OmniLayout.ts` — center positioning
10. `packages/html/src/jsx.d.ts` — bottom-center position type
