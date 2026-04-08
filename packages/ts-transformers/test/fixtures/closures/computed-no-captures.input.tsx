import { computed, pattern } from "commonfabric";

// FIXTURE: computed-no-captures
// Verifies: computed(() => expr) with no external captures is transformed to derive() with empty captures
//   computed(() => 42) → derive({ type: "object", properties: {} }, resultSchema, {}, () => 42)
// Context: The capture schema has no properties and the captures object is empty {}.
//   The callback parameter list is also empty (no destructuring needed).
export default pattern(() => {
  const result = computed(() => 42);

  return result;
});
