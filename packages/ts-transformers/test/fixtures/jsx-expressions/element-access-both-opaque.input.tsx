import { cell, pattern, UI } from "commonfabric";

// FIXTURE: element-access-both-opaque
// Verifies: element access where both array and index are cell-backed OpaqueRefs is wrapped in a lift-applied computation
//   items.get()[index.get()] → lift(({items, index}) => items.get()[index.get()])({ items, index })
export default pattern((_state) => {
  const items = cell(["apple", "banana", "cherry"]);
  const index = cell(1);

  return {
    [UI]: (
      <div>
        <h3>Element Access with Both OpaqueRefs</h3>
        {/* Both items and index are OpaqueRefs */}
        <p>Selected item: {items.get()[index.get()]}</p>
      </div>
    ),
  };
});
