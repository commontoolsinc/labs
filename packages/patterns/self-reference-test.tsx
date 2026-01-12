/// <cts-enable />
import { Default, NAME, pattern, SELF, UI } from "commontools";

/**
 * Test pattern demonstrating the SELF symbol for self-referential types.
 *
 * SELF allows a pattern to reference its own output type, enabling
 * recursive data structures like trees where children are the same type
 * as the parent.
 *
 * Usage:
 *   const Node = pattern<Input>(({ name, [SELF]: self }) => ({
 *     name,
 *     children: [] as typeof self[],  // self is OpaqueRef<Output>
 *   }));
 */

interface Input {
  label: Default<string, "Node">;
}

export default pattern<Input>(({ label, [SELF]: self }) => {
  // `self` is typed as OpaqueRef<Output> - same type as what this pattern returns
  // This enables type-safe self-referential structures

  // Children array with self-referential type
  const children = [] as (typeof self)[];

  return {
    [NAME]: `Tree Node: ${label}`,
    [UI]: (
      <div style="padding: 8px; border: 1px solid #ccc; margin: 4px; border-radius: 4px;">
        <div style="font-weight: bold; margin-bottom: 8px;">{label}</div>

        <div style="margin-left: 16px;">
          {children.map((child, i) => <ct-cell-link key={i} $cell={child} />)}
        </div>

        <div style="margin-top: 8px; font-size: 12px; color: #666;">
          Children: {children.length} | Self reference type:{" "}
          {self ? typeof self : "undefined"}
        </div>
      </div>
    ),
    label,
    children,
    self, // Expose self reference in output for demonstration
  };
});
