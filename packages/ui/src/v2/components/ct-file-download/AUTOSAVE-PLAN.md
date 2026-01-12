# Auto-Save Feature Plan for ct-file-download

## Overview

Add an opt-in auto-save mode to `ct-file-download` that allows users to
automatically back up data to a chosen folder at regular intervals. This
provides resilience against system instability by creating timestamped backup
files.

## User Experience

### Enabling Auto-Save

1. User **Option+clicks** (Alt+click on Windows) on a `ct-file-download` button
   that has `allow-autosave` attribute
2. File System Access API's folder picker opens
3. User selects a folder
4. Auto-save mode activates with visual confirmation

### Disabling Auto-Save

- **Option+click** again to toggle off
- Returns to normal download button behavior

### If Button Doesn't Support Auto-Save

- User Option+clicks a button WITHOUT `allow-autosave`
- Button briefly shakes/flashes
- Tooltip appears: "Auto-save not available for this download"
- Normal download still proceeds (user doesn't lose the click)

### During Auto-Save Mode

- Every 60 seconds after a data change, a new timestamped file is saved to the
  folder
- Manual click saves immediately and resets the timer
- On tab hidden (`visibilitychange`) or page unload (`beforeunload`), save
  immediately if dirty
- Files use timestamps so they never overwrite:
  `backup-2026-01-09T10-30-00.json`

---

## Visual States

Google Docs-style calm, reassuring indicators:

| State                    | Icon | Indicator                | Color   | Tooltip                            |
| ------------------------ | ---- | ------------------------ | ------- | ---------------------------------- |
| **Normal** (no autosave) | ⬇    | None                     | Default | "Download"                         |
| **Autosave ON, saved**   | 🔄   | Small dot (steady)       | Green   | "Auto-save on · All changes saved" |
| **Autosave ON, pending** | 🔄   | Small dot (gentle pulse) | Amber   | "Auto-save on · Saving soon..."    |
| **Autosave ON, saving**  | 🔄   | Small dot (steady)       | Blue    | "Saving..."                        |

The dot is small (~6-8px), subtle. The pulse is gentle - not alarming.

---

## New Properties/Attributes

### `allow-autosave` (Boolean attribute)

Opt-in flag that enables the Option+click auto-save behavior.

```html
<!-- Auto-save enabled -->
<ct-file-download allow-autosave $data="{backupData}" filename="backup.json">
  Download Backup
</ct-file-download>

<!-- Auto-save NOT enabled (default) -->
<ct-file-download $data="{exportData}" filename="export.json">
  Export
</ct-file-download>
```

---

## Internal State

New private fields:

```typescript
// Auto-save mode
private _autosaveEnabled = false;
private _autosaveDirHandle: FileSystemDirectoryHandle | null = null;
private _autosaveTimer: ReturnType<typeof setTimeout> | null = null;
private _isDirty = false;
private _lastSavedData: string | null = null;
private _isSavingAutosave = false;

// Constants
private static readonly AUTOSAVE_INTERVAL = 60_000; // 60 seconds
```

---

## Implementation Steps

### Phase 1: Core Auto-Save Logic

1. **Add new properties**
   - `allowAutosave` boolean attribute
   - Internal state fields for autosave mode

2. **Implement Option+click detection**
   - In `_handleClick`, check `event.altKey`
   - If `allowAutosave` is false, show "not available" feedback
   - If `allowAutosave` is true, toggle autosave mode

3. **Implement folder picker flow**
   - Use `showDirectoryPicker()` to get `FileSystemDirectoryHandle`
   - Store handle for repeated writes
   - Handle permission errors gracefully

4. **Implement auto-save write**
   - Create new method `_performAutosave()`
   - Generate timestamped filename
   - Use `dirHandle.getFileHandle(filename, { create: true })`
   - Write via `createWritable()` API

### Phase 2: Change Detection & Timer

5. **Track data changes**
   - In `willUpdate`, compare new data to `_lastSavedData`
   - If different, set `_isDirty = true` and start/reset timer

6. **Implement 60-second timer**
   - On dirty, start timer: `setTimeout(_performAutosave, 60000)`
   - On manual save, clear timer and reset
   - On data change while timer running, reset timer

7. **Handle manual click during autosave mode**
   - Save immediately to autosave folder (not browser download)
   - Clear dirty flag
   - Reset timer

### Phase 3: Lifecycle Events

8. **Implement `visibilitychange` handler**
   - On `document.hidden` becoming true, if dirty, save immediately

9. **Implement `beforeunload` handler**
   - If dirty, attempt save
   - Show "unsaved changes" dialog if save fails or is slow

10. **Cleanup on disconnect**
    - Clear timers
    - Remove event listeners
    - Don't clear `_autosaveDirHandle` (might reconnect)

### Phase 4: Visual Feedback

11. **Add CSS for indicator dot**
    - Position: corner of button or after icon
    - Colors: green (saved), amber (pending), blue (saving)
    - Animation: gentle pulse for pending state

12. **Update render method**
    - Show 🔄 icon when autosave enabled
    - Show indicator dot with appropriate state
    - Update tooltip based on state

13. **Add "not available" feedback**
    - CSS animation for shake/flash
    - Temporary tooltip display

### Phase 5: Events

14. **Add new custom events**
    - `ct-autosave-enabled`: Fired when autosave mode activates
      - Detail: `{ directoryName: string }`
    - `ct-autosave-disabled`: Fired when autosave mode deactivates
    - `ct-autosave-success`: Fired on successful auto-save
      - Detail: `{ filename: string, size: number }`
    - `ct-autosave-error`: Fired on auto-save failure
      - Detail: `{ error: Error }`

### Phase 6: Persistence (Nice-to-Have)

15. **Investigate existing persistence patterns**
    - Check if other components use IndexedDB
    - If yes, store `FileSystemDirectoryHandle` for session persistence
    - If no, skip this (autosave resets on refresh)

---

## File Changes

### Modified Files

1. **`ct-file-download.ts`** - Main implementation
   - Add properties, state, methods
   - Update click handler
   - Update render method
   - Add lifecycle handlers

2. **`ct-file-download.test.ts`** - Tests
   - Test Option+click behavior
   - Test autosave timer
   - Test visual states
   - Mock File System Access API

### New Files (if needed)

- None expected - all changes in existing component

---

## Browser Compatibility

### File System Access API Support

- Chrome 86+ (full support)
- Edge 86+ (full support)
- Safari: Not supported (graceful fallback needed)
- Firefox: Not supported (graceful fallback needed)

### Fallback Behavior

When File System Access API is not available:

- Option+click shows tooltip: "Auto-save requires Chrome or Edge"
- Normal download still works

---

## Testing Plan

1. **Unit tests**
   - Option+click detection
   - Timer start/reset/clear
   - Dirty flag management
   - State transitions

2. **Integration tests**
   - Full flow with mocked File System Access API
   - Visual state verification
   - Event emission

3. **Manual testing**
   - Chrome: Full flow
   - Safari/Firefox: Fallback behavior
   - Edge cases: rapid clicks, tab switching, page unload

---

## Open Questions (Resolved)

| Question                    | Answer                                   |
| --------------------------- | ---------------------------------------- |
| Same file or same folder?   | Same folder, new timestamped files       |
| How to enable?              | Option+click triggers folder picker      |
| Persistence across refresh? | Nice-to-have, only if framework supports |
| Timer behavior?             | 60s after last change, not debounce      |
| beforeunload reliability?   | Use visibilitychange primarily           |
| Visual indicator?           | Subtle dot with colors, 🔄 emoji         |
| Attribute name?             | `allow-autosave`                         |

---

## Risks & Mitigations

| Risk                                 | Mitigation                                    |
| ------------------------------------ | --------------------------------------------- |
| File System Access API not supported | Graceful fallback with clear messaging        |
| Permission revoked mid-session       | Detect and prompt user to re-enable           |
| Large files slow to save             | Show "saving" state, don't block UI           |
| User confusion about autosave state  | Clear visual indicator + tooltips             |
| Data corruption during save          | Don't overwrite - always new timestamped file |

---

## Success Criteria

1. User can Option+click to enable auto-save on supported buttons
2. Files are saved every 60 seconds when data changes
3. Files save on tab switch / page leave
4. Visual indicator clearly shows save state
5. Manual click saves immediately and resets timer
6. Option+click on unsupported button shows clear feedback
7. Works in Chrome/Edge, graceful fallback in other browsers
