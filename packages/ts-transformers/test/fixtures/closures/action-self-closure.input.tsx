/// <cts-enable />
/**
 * Test: Actions closing over SELF
 *
 * This tests that actions defined inside a pattern body can close over
 * the `self` variable (from SELF symbol) and access its properties.
 */
import { action, NAME, pattern, SELF, UI, type VNode, Writable } from "commontools";

interface TestOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  count: number;
}

export default pattern<{ title?: string }, TestOutput>(
  ({ title, [SELF]: self }) => {
    const count = Writable.of(0);

    // Action closing over `self` - should work
    const showSelf = action((_: Record<string, never>) => {
      console.log("self.title:", self.title);
    });

    // Action closing over both `self` and `count`
    const incrementWithSelf = action((_: Record<string, never>) => {
      console.log("self:", self);
      count.set(count.get() + 1);
    });

    return {
      [NAME]: "Action SELF Test",
      [UI]: (
        <div>
          <ct-button onClick={showSelf}>Show Self</ct-button>
          <ct-button onClick={incrementWithSelf}>Increment with Self</ct-button>
        </div>
      ),
      title,
      count,
    };
  },
);
