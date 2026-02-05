/// <cts-enable />
import {
  action,
  NAME,
  pattern,
  SELF,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface TestOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  count: number;
}

export default pattern<{ title?: string }, TestOutput>(
  ({ title, [SELF]: self }) => {
    const count = Writable.of(0);

    // Simple action closing over `self`
    const showSelf = action((_: Record<string, never>) => {
      console.log("self:", self);
      console.log("self.title:", self.title);
    });

    // Action closing over just count (no self)
    const increment = action((_: Record<string, never>) => {
      count.set(count.get() + 1);
    });

    return {
      [NAME]: "Self Action Test",
      [UI]: (
        <ct-vstack gap="4" padding="4">
          <div>Title: {title}</div>
          <div>Count: {count}</div>
          <ct-button onClick={increment}>Increment (no self)</ct-button>
          <ct-button onClick={showSelf}>Show Self (uses self)</ct-button>
        </ct-vstack>
      ),
      title,
      count,
    };
  },
);
