/**
 * Fixture: expectRuntimeErrors: 2 but only one throw occurs.
 * A numeric expectation is exact — a count mismatch must fail the run.
 */
import { action, computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const fine = new Writable(true);
  const stillFine = computed(() => fine.get());

  const throwsOnce = action(() => {
    throw new Error("verb rejected: only one of the expected two");
  });

  return {
    tests: [
      { action: throwsOnce },
      { assertion: stillFine },
    ],
    expectRuntimeErrors: 2,
  };
});
