/**
 * Test Pattern: Google email wrapper patterns
 *
 * Exercises the thin extractor wrappers that pass a shared Google auth cell
 * through to GmailImporter, GmailExtractor, and BillExtractor children.
 */
import { computed, NAME, pattern, Writable } from "commonfabric";
import type { Auth } from "../core/gmail-importer.tsx";
import BofABillTracker from "./bofa-bill-tracker.tsx";
import ChaseBillTracker from "./chase-bill-tracker.tsx";
import PGEBillTracker from "./pge-bill-tracker.tsx";

function emptyAuth() {
  return new Writable<Auth>({
    token: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
    user: { email: "", name: "", picture: "" },
  });
}

export default pattern(() => {
  const bofa = BofABillTracker({ overrideAuth: emptyAuth() });
  const chase = ChaseBillTracker({ overrideAuth: emptyAuth() });
  const pge = PGEBillTracker({ overrideAuth: emptyAuth() });

  const assert_bill_wrappers_start_empty = computed(() =>
    bofa[NAME] === "BofA Bill Tracker" &&
    (bofa.bills ?? []).length === 0 &&
    bofa.totalUnpaid === 0 &&
    chase[NAME] === "Chase Bill Tracker" &&
    (chase.bills ?? []).length === 0 &&
    chase.totalUnpaid === 0 &&
    pge[NAME] === "PGE Bill Tracker" &&
    (pge.bills ?? []).length === 0 &&
    pge.totalUnpaid === 0
  );

  return {
    tests: [{ assertion: assert_bill_wrappers_start_empty }],
    bofa,
    chase,
    pge,
  };
});
