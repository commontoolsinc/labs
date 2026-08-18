import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { keyHolderAccounts, leaseAction } from "./test-records-janitor.ts";

describe("test-records-janitor", () => {
  describe("leaseAction()", () => {
    it("returns disable only for an inactive, enabled account", () => {
      expect(leaseAction({ disabled: false, active: false })).toBe("disable");
      expect(leaseAction({ disabled: false, active: true })).toBe("none");
      expect(leaseAction({ disabled: true, active: true })).toBe("enable");
      expect(leaseAction({ disabled: true, active: false })).toBe("none");
    });
  });

  describe("keyHolderAccounts()", () => {
    it("returns only accounts with our prefix and display name", () => {
      const holders = keyHolderAccounts([
        {
          email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
          displayName: "Test records key holder: octocat",
          disabled: false,
        },
        {
          email: "test-records-relay-labs@p.iam.gserviceaccount.com",
          displayName: "Test Records Relay - labs",
        },
        {
          email: "test-records-gh-mangled@p.iam.gserviceaccount.com",
          displayName: "Something else entirely",
        },
        { displayName: "Test records key holder: ghost" },
      ]);
      expect(holders).toEqual([{
        email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
        username: "octocat",
        disabled: false,
      }]);
    });
  });
});
