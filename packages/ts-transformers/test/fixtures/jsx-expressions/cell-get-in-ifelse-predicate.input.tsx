/// <cts-enable />
import { Cell, ifElse, pattern, UI } from "commontools";

// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in derive(), which unwraps Cells,
// but fails to remove the .get() calls
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
