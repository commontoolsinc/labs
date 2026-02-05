/// <cts-enable />
/**
 * MINIMAL REPRO: Actions cannot close over SELF
 *
 * This pattern demonstrates a bug where actions defined inside a pattern body
 * cannot close over the `self` variable (from SELF symbol). The bindings object
 * passed to the handler at runtime is undefined.
 *
 * EXPECTED: Both buttons should work - actions should be able to close over any
 * variable in scope, including `self`.
 *
 * ACTUAL: "Increment" works, "Show Self" fails with:
 *   "Cannot destructure property 'self' of 'undefined'"
 *
 * WORKAROUND: Use module-scope handler() and explicitly bind `self` from the
 * pattern body. See `showSelfWorkaround` below.
 */
import {
  action,
  handler,
  NAME,
  pattern,
  SELF,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ============================================================================
// Output type
// ============================================================================

interface TestOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  count: number;
}

// ============================================================================
// WORKAROUND: Module-scope handler that takes `self` as explicit binding
// ============================================================================

const showSelfHandler = handler<
  Record<string, never>,
  { self: TestOutput; count: Writable<number> }
>((_, { self, count }) => {
  // This works because `self` is passed as an explicit binding
  console.log("WORKAROUND - self:", self);
  console.log("WORKAROUND - self.title:", self.title);
  console.log("WORKAROUND - self.count:", self.count);
  // Prove it works by incrementing
  count.set(count.get() + 100);
});

// ============================================================================
// Pattern demonstrating the bug
// ============================================================================

export default pattern<{ title?: string }, TestOutput>(
  ({ title, [SELF]: self }) => {
    const count = Writable.of(0);

    // ========================================================================
    // BUG: Action closing over `self` - FAILS at runtime
    // ========================================================================
    // The transformer correctly extracts `self` as a binding and generates:
    //   const showSelfBroken = handler(eventSchema, ctxSchema, fn)({ self })
    //
    // But at runtime, the ctx parameter passed to fn is undefined.
    const showSelfBroken = action((_: Record<string, never>) => {
      console.log("BUG - self:", self);
      console.log("BUG - self.title:", self.title);
    });

    // ========================================================================
    // WORKS: Action closing over regular Writable (no self)
    // ========================================================================
    const increment = action((_: Record<string, never>) => {
      count.set(count.get() + 1);
    });

    // ========================================================================
    // WORKAROUND: Bind module-scope handler with `self`
    // ========================================================================
    const showSelfWorkaround = showSelfHandler({ self, count });

    return {
      [NAME]: "Action SELF Repro",
      [UI]: (
        <ct-vstack gap="4" padding="4">
          <ct-card>
            <ct-vstack gap="3">
              <div style={{ fontWeight: "bold" }}>
                Bug Repro: Actions cannot close over SELF
              </div>
              <div>Title: {title}</div>
              <div>Count: {count}</div>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <div style={{ fontSize: "13px", color: "#666" }}>
                This button works - action closes over regular Writable:
              </div>
              <ct-button onClick={increment}>
                Increment (+1)
              </ct-button>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <div style={{ fontSize: "13px", color: "#666" }}>
                This button FAILS - action closes over `self`:
              </div>
              <ct-button onClick={showSelfBroken}>
                Show Self (BROKEN - check console)
              </ct-button>
              <div style={{ fontSize: "11px", color: "#c00" }}>
                Error: Cannot destructure property 'self' of 'undefined'
              </div>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <div style={{ fontSize: "13px", color: "#666" }}>
                WORKAROUND - module-scope handler with explicit binding:
              </div>
              <ct-button onClick={showSelfWorkaround}>
                Show Self (WORKAROUND - adds 100)
              </ct-button>
              <div style={{ fontSize: "11px", color: "#090" }}>
                Works because `self` is passed as explicit binding
              </div>
            </ct-vstack>
          </ct-card>
        </ct-vstack>
      ),
      title,
      count,
    };
  },
);
