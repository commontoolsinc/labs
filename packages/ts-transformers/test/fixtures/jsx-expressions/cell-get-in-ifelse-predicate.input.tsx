/// <cts-enable />
import { Cell, ifElse, pattern, UI } from "commonfabric";

// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in derive(), which unwraps Cells,
// but fails to remove the .get() calls
// FIXTURE: cell-get-in-ifelse-predicate
// Verifies: .get() calls on Cell refs inside ifElse predicates are preserved within derive()
//   showHistory && messageCount !== dismissedIndex.get() → derive(..., ({...}) => showHistory && messageCount !== dismissedIndex.get())
// Context: Bug repro -- predicate wrapped in derive() which unwraps Cells, but .get() must remain
export default pattern<{
  showHistory: boolean;
  messageCount: number;
  dismissedIndex: Cell<number>;
}>(({ showHistory, messageCount, dismissedIndex }) => {
  return {
    [UI]: (
      <div>
        {ifElse(
          showHistory && messageCount !== dismissedIndex.get(),
          <div>Show notification</div>,
          <div>Hide notification</div>
        )}
      </div>
    ),
  };
});
