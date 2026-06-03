import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isRevealed,
  requestReveal,
  RevealRequest,
  setRevealStatus,
} from "./reveal.ts";

const ADMIN = "did:key:carol";
const CLAIM = "claim-1";

describe("reveal handshake", () => {
  it("request adds a pending request", () => {
    const out = requestReveal([], ADMIN, CLAIM);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      requestedBy: ADMIN,
      claimId: CLAIM,
      status: "pending",
    });
  });

  it("request is idempotent for the same (admin, claim)", () => {
    const once = requestReveal([], ADMIN, CLAIM);
    const twice = requestReveal(once, ADMIN, CLAIM);
    expect(twice.length).toBe(1);
  });

  it("approve transitions only the matching request", () => {
    const other: RevealRequest = {
      requestedBy: "did:key:dave",
      claimId: "claim-2",
      status: "pending",
    };
    const requests = requestReveal([other], ADMIN, CLAIM);
    const out = setRevealStatus(requests, ADMIN, CLAIM, "approved");
    expect(out.find((r) => r.claimId === CLAIM)?.status).toBe("approved");
    expect(out.find((r) => r.claimId === "claim-2")?.status).toBe("pending");
  });

  it("isRevealed is true only after approval", () => {
    const pending = requestReveal([], ADMIN, CLAIM);
    expect(isRevealed(pending, ADMIN, CLAIM)).toBe(false);
    const approved = setRevealStatus(pending, ADMIN, CLAIM, "approved");
    expect(isRevealed(approved, ADMIN, CLAIM)).toBe(true);
    const declined = setRevealStatus(pending, ADMIN, CLAIM, "declined");
    expect(isRevealed(declined, ADMIN, CLAIM)).toBe(false);
  });

  it("a different admin's request does not grant reveal", () => {
    const approved = setRevealStatus(
      requestReveal([], ADMIN, CLAIM),
      ADMIN,
      CLAIM,
      "approved",
    );
    expect(isRevealed(approved, "did:key:eve", CLAIM)).toBe(false);
  });
});
