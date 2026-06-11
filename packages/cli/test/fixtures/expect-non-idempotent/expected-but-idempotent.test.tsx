/**
 * expectNonIdempotent: true on a trivially idempotent pattern.
 *
 * The flag asserts that the idempotency detector fires, so this test must
 * FAIL with "expected non-idempotent computation(s), none detected" — a
 * silent pass here is exactly the detection regression the flag guards.
 */
import { computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const value = new Writable("hello");

  const ok = computed(() => value.get() === "hello");

  return {
    tests: [{ assertion: ok }],
    expectNonIdempotent: true,
  };
});
