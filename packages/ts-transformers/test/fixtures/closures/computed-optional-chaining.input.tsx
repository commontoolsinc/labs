/// <cts-enable />
import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-optional-chaining
// Verifies: computed() with optional chaining and nullish coalescing on captured cells
//   computed(() => value.get() * (config.get()?.multiplier ?? 1)) → derive(..., { value, config }, ({ value, config }) => ...)
//   The config cell has a nullable type (anyOf [object, null]) with asCell: true in the capture schema.
export default pattern(() => {
  const config = Writable.of<{ multiplier?: number } | null>({ multiplier: 2 });
  const value = Writable.of(10);

  const result = computed(() => value.get() * (config.get()?.multiplier ?? 1));

  return result;
});
