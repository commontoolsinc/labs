/// <cts-enable />
import { computed, handler, ifElse, pattern, UI, Writable } from "commontools";

const openNoteEditor = handler<unknown, {
  subPieces: string[];
  editingNoteIndex: number | undefined;
  editingNoteText: string;
  index: number;
}>((_event, state) => state);
const openSettings = handler<unknown, {
  settingsModuleIndex: number | undefined;
  index: number;
}>((_event, state) => state);
const toggleExpanded = handler<unknown, {
  expandedIndex: number | undefined;
  index: number;
}>((_event, state) => state);
const trashSubPiece = handler<unknown, {
  subPieces: string[];
  trashedSubPieces: string[];
  expandedIndex: number | undefined;
  settingsModuleIndex: number | undefined;
  index: number;
}>((_event, state) => state);

interface Item {
  note?: string;
  collapsed?: boolean;
  pinned?: boolean;
  allowMultiple: boolean;
}

// FIXTURE: branch-lowered-capture-preservation
// Verifies: branch-lowered UI chunks inside a computed-array map preserve captured
// params needed by nested ifElse branches, inline computed() attributes, and handlers
//   allEntries.map(...)                     -> mapWithPattern(...)
//   ifElse(computed(() => !entry.collapsed), ...) -> branch lowering keeps entry/index ownership
//   openNoteEditor/openSettings/toggleExpanded/trashSubPiece handlers
//     -> params captures survive inside lowered branches
//   computed(() => entry?.note ? "700" : "400") / title computed(...)
//     -> authored compute wrappers still coexist with the preserved captures
export default pattern<{
  items: Item[];
  subPieces: string[];
  trashedSubPieces: string[];
}>(({ items, subPieces, trashedSubPieces }) => {
  const editingNoteIndex = Writable.of<number | undefined>();
  const editingNoteText = Writable.of("");
  const expandedIndex = Writable.of<number | undefined>();
  const settingsModuleIndex = Writable.of<number | undefined>();

  const allEntries = computed(() =>
    items.map((entry, index) => ({
      entry,
      index,
      isExpanded: index === 0,
      isPinned: entry.pinned || false,
      allowMultiple: entry.allowMultiple,
    }))
  );

  return {
    [UI]: (
      <div>
        {allEntries.map(({ entry, index, isExpanded, isPinned, allowMultiple }) =>
          ifElse(
            computed(() => !entry.collapsed),
            <div>
              {ifElse(
                allowMultiple,
                <button
                  type="button"
                  onClick={openNoteEditor({
                    subPieces,
                    editingNoteIndex,
                    editingNoteText,
                    index,
                  })}
                  style={computed(() => ({
                    fontWeight: entry?.note ? "700" : "400",
                  }))}
                  title={computed(() => entry?.note || "Add note...")}
                >
                  note
                </button>,
                null,
              )}
              {!isExpanded && ifElse(
                true,
                <button
                  type="button"
                  onClick={openSettings({ settingsModuleIndex, index })}
                >
                  settings
                </button>,
                null,
              )}
              <button
                type="button"
                onClick={toggleExpanded({ expandedIndex, index })}
                style={{ background: isPinned ? "a" : "b" }}
              >
                expand
              </button>
              {!isExpanded && (
                <button
                  type="button"
                  onClick={trashSubPiece({
                    subPieces,
                    trashedSubPieces,
                    expandedIndex,
                    settingsModuleIndex,
                    index,
                  })}
                >
                  trash
                </button>
              )}
            </div>,
            null,
          )
        )}
      </div>
    ),
  };
});
