/// <cts-enable />
import { derive, h } from "commontools";
// Test case: User-written derive calls should not be double-wrapped
// This tests that derive(index, (i) => i + 1) doesn't become derive(index, index => derive(index, (i) => i + 1))
export default function TestComponent({ items, cellRef }) {
    return (<div>
      {/* User-written derive with simple parameter transformation - should NOT be double-wrapped */}
      <span>Count: {derive(items.length, (n) => n + 1)}</span>

      {/* User-written derive accessing opaque ref property - should NOT be double-wrapped */}
      <span>Name: {derive(cellRef, (ref) => ref.name || "Unknown")}</span>

      {/* Nested in map with user-written derive - derives should NOT be double-wrapped */}
      {items.map((item, index) => (<li key={item.id}>
          {/* These user-written derives should remain as-is, not wrapped in another derive */}
          Item {derive(index, (i) => i + 1)}: {derive(item, (it) => it.title)}
        </li>))}

      {/* Simple property access - should NOT be transformed */}
      <span>Direct access: {cellRef.value}</span>
    </div>);
}