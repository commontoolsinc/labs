/// <cts-enable />
/**
 * Dummy Test Module - Minimal pattern for OOM bisection testing (CT-1148)
 *
 * This module is intentionally minimal to test if ANY 21st module causes OOM
 * or if photo.tsx's specific complexity is the problem.
 */
import { type Default, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "dummy-test",
  label: "Dummy",
  icon: "🧪",
};

export interface DummyTestInput {
  value: Default<string, "">;
}

export const DummyTestModule = recipe<DummyTestInput, DummyTestInput>(
  "DummyTestModule",
  ({ value }) => ({
    [NAME]: "Dummy",
    [UI]: <span>{value}</span>,
    value,
  }),
);

export default DummyTestModule;
