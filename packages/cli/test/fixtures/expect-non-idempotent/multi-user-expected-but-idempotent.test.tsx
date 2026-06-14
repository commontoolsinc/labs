/**
 * Multi-user: alice sets expectNonIdempotent: true but both participants are
 * trivially idempotent. No flagged participant sees a violation, so the run
 * must FAIL with the synthetic "expectNonIdempotent" result.
 */
import { computed, multiUserTest, pattern, Writable } from "commonfabric";

export const alice = pattern(() => {
  const value = new Writable("alice");
  const ok = computed(() => value.get() === "alice");
  return {
    tests: [{ assertion: ok }],
    expectNonIdempotent: true,
  };
});

export const bob = pattern(() => {
  const value = new Writable("bob");
  const ok = computed(() => value.get() === "bob");
  return {
    tests: [{ assertion: ok }],
  };
});

export default multiUserTest({ participants: { alice, bob } });
