import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  assertIngestAuthorized,
  ChannelNotAuthorizedError,
  parseIngestChannelAllowlist,
} from "./channel-acl.ts";

// The forge-hole stopgap: external ingest must fail closed against an explicit
// channel-space allowlist. A verified session.open proves only control of the
// issuer DID, never a relationship to the named space — so an empty/unmatched
// allowlist MUST reject, or any did:key holder could write to any space.
describe("assertIngestAuthorized (forge-hole stopgap)", () => {
  it("rejects every channel when the allowlist is empty (fail-closed default)", () => {
    const empty = parseIngestChannelAllowlist("");
    expect(() => assertIngestAuthorized("did:key:anything", empty))
      .toThrow(ChannelNotAuthorizedError);
    expect(() => assertIngestAuthorized("", empty))
      .toThrow(ChannelNotAuthorizedError);
  });

  it("permits only exactly-listed channel spaces", () => {
    const allow = parseIngestChannelAllowlist(
      " did:key:chan-a , did:key:chan-b ",
    );
    // Listed (whitespace-trimmed) → no throw.
    assertIngestAuthorized("did:key:chan-a", allow);
    assertIngestAuthorized("did:key:chan-b", allow);
    // Not listed → rejected, even though it is a well-formed DID.
    expect(() => assertIngestAuthorized("did:key:chan-c", allow))
      .toThrow(ChannelNotAuthorizedError);
    // No substring/prefix leniency.
    expect(() => assertIngestAuthorized("did:key:chan-", allow))
      .toThrow(ChannelNotAuthorizedError);
  });

  it("parses a comma-separated allowlist, dropping blanks", () => {
    expect([...parseIngestChannelAllowlist("a, ,b,")].sort()).toEqual([
      "a",
      "b",
    ]);
    expect(parseIngestChannelAllowlist(undefined).size).toBe(0);
  });
});
