/// <cts-enable />
/**
 * Test: Actions closing over SELF with Default<> inputs
 *
 * When all input properties use Default<T, V> (not optional `?`), the piece
 * always has values for every property. This means `self` (which is the piece
 * itself) satisfies the output schema's `required` array at runtime.
 *
 * The output schema should mark `title` as required (since Default<> ensures
 * a value always exists), and the handler's context schema should mark `self`
 * as required.
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
