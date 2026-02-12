/// <cts-enable />
/**
 * REPRO & WORKAROUND: Actions closing over SELF fail with optional inputs
 *
 * BUG: When a pattern has optional input properties (e.g. `title?: string`),
 * actions that close over `self` (from the [SELF] symbol) crash at runtime:
 *
 *   "Cannot destructure property 'self' of 'undefined'"
 *
 * ROOT CAUSE: The transformer generates an output schema with
 * `required: ["title", "count", "$NAME", "$UI"]`, but when `title` is optional
 * in the input, the piece data may not have a `title` value. At runtime, the
 * binding resolver tries to match `self` against the output schema's required
 * properties — if any required property is missing from the piece data, the
 * entire binding resolves to `undefined`.
 *
 * Actions that DON'T close over `self` (like `increment` below) work fine,
 * because their bindings don't depend on the output schema matching.
 *
 * WORKAROUND: Use `Default<T, V>` for ALL input properties instead of making
 * them optional with `?`. Default<> ensures the piece always has a value for
 * every property, so `self` always satisfies the output schema.
 *
 *   BAD:  pattern<{ title?: string }, TestOutput>(...)
 *   GOOD: pattern<{ title: Default<string, ""> }, TestOutput>(...)
 */
import {
  action,
  type Default,
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

// WORKAROUND: Use Default<string, ""> instead of `title?: string`
export default pattern<{ title: Default<string, ""> }, TestOutput>(
  ({ title, [SELF]: self }) => {
    const count = Writable.of(0);

    // This action closes over `self` — it works because all inputs use Default<>
    const showSelf = action((_: Record<string, never>) => {
      console.log("self:", self);
      console.log("self.title:", self.title);
    });

    // This action does NOT close over `self` — it always works regardless
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
