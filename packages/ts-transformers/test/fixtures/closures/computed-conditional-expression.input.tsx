/// <cts-enable />
import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-conditional-expression
// Verifies: computed(() => expr) with four cell captures in a ternary expression
//   computed(() => value.get() > threshold.get() ? a.get() : b.get()) → derive(captureSchema, resultSchema, { value, threshold, a, b }, ({ value, threshold, a, b }) => ...)
//   All four cells are captured with asCell: true in the schema.
export default pattern(() => {
  const value = Writable.of(10);
  const threshold = Writable.of(5);
  const a = Writable.of(100);
  const b = Writable.of(200);

  const result = computed(() =>
    value.get() > threshold.get() ? a.get() : b.get()
  );

  return result;
});
