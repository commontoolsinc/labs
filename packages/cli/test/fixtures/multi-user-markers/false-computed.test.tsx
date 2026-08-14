/// <cts-enable />
/**
 * A false `computed(...)` assertion. It carries a bare boolean rather than
 * the record an `assert(...)` carries, so the failure has no operands to
 * render and reports the value that was read instead.
 */
import {
  action,
  computed,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

export interface MarkerSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, MarkerSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { action: action(() => setup.note.set("from alice")) },
    { label: "alice-wrote" },
  ],
}));

export const bob = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-wrote" },
    { assertion: computed(() => setup.note.get() === "from nobody") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
