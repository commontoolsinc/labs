/// <cts-enable />
import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-basic-capture
// Verifies: computed(() => expr) with two cell captures is closure-extracted into derive()
//   computed(() => value.get() * multiplier.get()) → derive(captureSchema, resultSchema, { value, multiplier }, ({ value, multiplier }) => value.get() * multiplier.get())
//   Captured cells are annotated with asCell: true in the capture schema.
export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);

  const result = computed(() => value.get() * multiplier.get());

  return result;
});
