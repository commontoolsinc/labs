import { action, computed, pattern, Writable } from "commonfabric";
import TypePickerModule from "./type-picker.tsx";
import type { SubPieceEntry, TrashedSubPieceEntry } from "./record/types.ts";

// The picker renders the template list and passes its dismissed state through.
// Its apply/dismiss handlers are bound to buttons in the UI rather than exposed
// as result streams, so a headless test drives the state cell rather than those
// clicks.
export default pattern(() => {
  const entries = new Writable<SubPieceEntry[]>([
    { type: "notes", pinned: false, piece: null },
    { type: "type-picker", pinned: false, piece: null },
  ]);
  const trashedEntries = new Writable<TrashedSubPieceEntry[]>([]);
  const dismissed = new Writable(false);

  const picker = TypePickerModule({ entries, trashedEntries, dismissed });

  const assert_starts_undismissed = computed(() => picker.dismissed === false);

  // `dismissed` is passed straight through, so the output follows the cell
  // rather than a value snapshotted at instantiation.
  const action_dismiss = action(() => {
    dismissed.set(true);
  });
  const assert_dismissed_follows_the_cell = computed(() =>
    picker.dismissed === true
  );

  return {
    tests: [
      { assertion: assert_starts_undismissed },
      { action: action_dismiss },
      { assertion: assert_dismissed_follows_the_cell },
    ],
    picker,
  };
});
