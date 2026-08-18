import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  hasRecentActivity,
  keyHolderAccounts,
  leaseAction,
} from "./test-records-janitor.ts";

function searchFetch(payload: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200 }),
    )) as typeof fetch;
}

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

  describe("hasRecentActivity()", () => {
    const clients = (payload: unknown) => ({
      gcpToken: "t",
      fetchImpl: searchFetch(payload),
    });

    it("returns true for a positive search count", async () => {
      expect(
        await hasRecentActivity(clients({ total_count: 2 }), "o", "2026-07-19"),
      ).toBe(true);
    });

    it("returns false for a complete zero", async () => {
      expect(
        await hasRecentActivity(
          clients({ total_count: 0, incomplete_results: false }),
          "o",
          "2026-07-19",
        ),
      ).toBe(false);
    });

    it("returns unknown for a partial zero", async () => {
      expect(
        await hasRecentActivity(
          clients({ total_count: 0, incomplete_results: true }),
          "o",
          "2026-07-19",
        ),
      ).toBeUndefined();
    });
  });
});
