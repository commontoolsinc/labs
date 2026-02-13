/// <cts-enable />
/**
 * Fixture: action closing over SELF requires Default<> inputs (not optional `?`)
 * to ensure the output schema's required properties are always satisfied.
 */
import { action, type Default, NAME, pattern, SELF, UI, type VNode, Writable } from "commontools";

interface TestOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  count: number;
}

export default pattern<{ title: Default<string, ""> }, TestOutput>(
  ({ title, [SELF]: self }) => {
    const count = Writable.of(0);

    // Action closing over `self` — works because all inputs use Default<>
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
