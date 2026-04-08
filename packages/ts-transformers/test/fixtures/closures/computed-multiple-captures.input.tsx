import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-multiple-captures
// Verifies: computed() with a multi-statement body capturing three cells is closure-extracted
//   computed(() => { const sum = a.get() + b.get(); return sum * c.get() }) → derive(captureSchema, resultSchema, { a, b, c }, ({ a, b, c }) => { ... })
//   All three cells (a, b, c) are captured with asCell: true in the schema.
export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);
  const c = Writable.of(30);

  const result = computed(() => {
    const sum = a.get() + b.get();
    return sum * c.get();
  });

  return result;
});
