/// <cts-enable />
/**
 * MINIMAL REPRO: Actions cannot close over SELF
 *
 * This pattern demonstrates a bug where actions defined inside a pattern body
 * cannot close over the `self` variable (from SELF symbol). The bindings object
 * passed to the handler at runtime is undefined.
 *
 * EXPECTED: All buttons should work - actions should be able to close over any
 * variable in scope, including `self`.
 *
 * ACTUAL: "Increment" works, "Show Self" fails with:
 *   "Cannot destructure property 'self' of 'undefined'"
 *
 * WORKAROUND: Use module-scope handler() and explicitly bind `self` from the
 * pattern body. Two variants are tested:
 *   - Variant A: `{ self: TestOutput }` (typed) - FAILS (tries to destructure)
 *   - Variant B: `{ self: any }` (untyped) - WORKS (can use optional chaining)
 *
 * NOTE: Even the working "any" variant triggers a spurious VDOM error:
 *   "[RuntimeClient Error] {type: 'callback:error', message: 'null'}"
 * This appears to be a separate bug in the VDOM reconciler where something
 * throws `null` during re-render after the handler successfully completes.
 * The handler DOES work - count increments correctly - the error is benign
 * but should be investigated separately (see reconciler.ts dispatchEvent).
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
// WORKAROUND VARIANT A: Module-scope handler with typed `self`
// ============================================================================

const showSelfTyped = handler<
  Record<string, never>,
  { self: TestOutput; count: Writable<number> }
>((_, { self, count }) => {
  console.log("TYPED WORKAROUND - self:", self);
  console.log("TYPED WORKAROUND - self.title:", self.title);
  count.set(count.get() + 100);
});

// ============================================================================
// WORKAROUND VARIANT B: Module-scope handler with `self: any`
// ============================================================================

const showSelfAny = handler<
  Record<string, never>,
  // deno-lint-ignore no-explicit-any
  { self: any; count: Writable<number> }
>((_, { self, count }) => {
  try {
    console.log("ANY WORKAROUND - self:", self);
    console.log(
      "ANY WORKAROUND - self keys:",
      self ? Object.keys(self) : "null",
    );
    console.log("ANY WORKAROUND - self.count:", self?.count);
    console.log("ANY WORKAROUND - self.$NAME:", self?.$NAME);
    // Prove we can read from self by logging the count
    count.set(count.get() + 1000);
    console.log("ANY WORKAROUND - completed successfully");
  } catch (e) {
    console.log("ANY WORKAROUND - caught error:", e);
    throw e;
  }
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
    // WORKAROUND A: Module-scope handler with typed `self: TestOutput`
    // ========================================================================
    const showSelfWorkaroundTyped = showSelfTyped({ self, count });

    // ========================================================================
    // WORKAROUND B: Module-scope handler with `self: any`
    // ========================================================================
    const showSelfWorkaroundAny = showSelfAny({ self, count });

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
                WORKAROUND A - module-scope handler with typed self:
              </div>
              <ct-button onClick={showSelfWorkaroundTyped}>
                Show Self (TYPED - adds 100)
              </ct-button>
              <div style={{ fontSize: "11px", color: "#666" }}>
                Uses {"{ self: TestOutput }"}
              </div>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <div style={{ fontSize: "13px", color: "#666" }}>
                WORKAROUND B - module-scope handler with any self:
              </div>
              <ct-button onClick={showSelfWorkaroundAny}>
                Show Self (ANY - adds 1000)
              </ct-button>
              <div style={{ fontSize: "11px", color: "#666" }}>
                Uses {"{ self: any }"}
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
