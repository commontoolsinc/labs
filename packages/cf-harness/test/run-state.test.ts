import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import { createHarnessRunState } from "../src/run-state.ts";

describe("run-state", () => {
  describe("createHarnessRunState()", () => {
    it("carries a defensive copy of a given handle table", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        `/of:fid1:${"A".repeat(43)}`,
      );

      const state = createHarnessRunState({
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        handleTable: table,
      });

      expect(state.handleTable).toEqual(table);
      expect(state.handleTable).not.toBe(table);
      table.entries.pop();
      expect(state.handleTable?.entries.length).toBe(1);
    });
  });
});
