/**
 * Fixture: console.warn with allowConsoleWarnings: true.
 * The test runner must NOT fail this despite the warning.
 */
import { action, computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const triggered = new Writable(false);
  const didTrigger = computed(() => triggered.get());

  const triggerWarn = action(() => {
    console.warn("intentional-test-warning: allowed by flag");
    triggered.set(true);
  });

  return {
    tests: [
      { action: triggerWarn },
      { assertion: didTrigger },
    ],
    allowConsoleWarnings: true,
  };
});
