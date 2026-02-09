/// <cts-enable />
/**
 * MINIMAL REPRO: action(() => ...) returns Stream<void>, not Stream<{}>
 *
 * When using action() without parameters, the return type is Stream<void>.
 * But event handlers like onct-click on ct-chip expect Stream<{}>.
 *
 * This causes a type error:
 *   Type 'Stream<void>' is not assignable to type 'Stream<{}>'.
 *     Types of property '[CELL_INNER_TYPE]' are incompatible.
 *       Type 'void' is not assignable to type '{}'.
 *
 * EXPECTED: action(() => ...) should work as an event handler
 *
 * WORKAROUND: Use action((_: Record<string, never>) => ...) to get Stream<{}>
 */
import { action, NAME, pattern, UI, type VNode, Writable } from "commontools";

interface Output {
  [NAME]: string;
  [UI]: VNode;
  count: number;
}

export default pattern<Record<string, never>, Output>(() => {
  const count = Writable.of(0);

  // BUG: This returns Stream<void> which is not assignable to ct-chip's onct-click
  const incrementBroken = action(() => {
    count.set(count.get() + 1);
  });

  // WORKAROUND: Explicitly type the unused parameter to get Stream<{}>
  const incrementWorkaround = action((_: Record<string, never>) => {
    count.set(count.get() + 10);
  });

  return {
    [NAME]: "Action Void Repro",
    [UI]: (
      <ct-vstack gap="4" padding="4">
        <ct-card>
          <ct-vstack gap="3">
            <div style={{ fontWeight: "bold" }}>
              Bug: action(() =&gt; ...) returns Stream&lt;void&gt;
            </div>
            <div>Count: {count}</div>
          </ct-vstack>
        </ct-card>

        <ct-card>
          <ct-vstack gap="2">
            <div style={{ fontSize: "13px", color: "#666" }}>
              ct-chip with onct-click using action(() =&gt; ...) - TYPE ERROR:
            </div>
            <ct-chip
              label="Increment (BROKEN)"
              interactive
              onct-click={incrementBroken}
            />
            <div style={{ fontSize: "11px", color: "#c00" }}>
              Stream&lt;void&gt; not assignable to Stream&lt;{}&gt;
            </div>
          </ct-vstack>
        </ct-card>

        <ct-card>
          <ct-vstack gap="2">
            <div style={{ fontSize: "13px", color: "#666" }}>
              WORKAROUND - use (_: Record&lt;string, never&gt;):
            </div>
            <ct-chip
              label="Increment (WORKAROUND +10)"
              interactive
              onct-click={incrementWorkaround}
            />
          </ct-vstack>
        </ct-card>
      </ct-vstack>
    ),
    count,
  };
});
