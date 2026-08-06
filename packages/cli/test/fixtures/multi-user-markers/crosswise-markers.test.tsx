/// <cts-enable />
/**
 * Both participants announce before either crosses the other's marker, so
 * each announces from a replica that predates the other's announcement. A
 * marker document with more than one writer takes a conflict here and drops
 * the marker it was asked to record, which shows up as a wait that never
 * ends.
 */
import { assert, multiUserTest, pattern, Writable } from "commonfabric";

export interface MarkerSetup {
  note: Writable<string>;
}

export const setup = pattern<Record<string, never>, MarkerSetup>(() => ({
  note: Writable.of<string>(""),
}));

export const alice = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  tests: [
    { label: "alice-1" },
    { await: "bob-1" },
    { assertion: assert(() => setup.note.get() === "") },
  ],
}));

export const bob = pattern<{ setup: MarkerSetup }>(({ setup }) => ({
  tests: [
    { label: "bob-1" },
    { await: "alice-1" },
    { assertion: assert(() => setup.note.get() === "") },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
