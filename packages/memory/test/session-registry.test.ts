import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SessionRegistry } from "../v2/session-registry.ts";

describe("session-registry", () => {
  it("refuses to resume a session opened with `elidedVerdicts` for a client that does not advertise it", () => {
    // A commit the session had accepted under the waived identity proof may
    // replay as an elided positional write, which only a replica that drops
    // elided layers handles; the downgraded client opens a fresh session.
    const registry = new SessionRegistry();
    const opened = registry.open(
      "space",
      {},
      0,
      "connection-a",
      "principal",
      undefined,
      false,
      true,
    );
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts).toBe(true);
    const resume = {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    };

    expect(() => registry.open("space", resume, 0, "connection-b", "principal"))
      .toThrow("requires a client that advertises it");
    expect(
      registry.get("space", opened.sessionId)?.ownerConnectionId,
    ).toBe("connection-a");

    const resumed = registry.open(
      "space",
      resume,
      0,
      "connection-c",
      "principal",
      undefined,
      false,
      true,
    );
    expect(resumed.resumed).toBe(true);
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts).toBe(true);
  });

  it("opens a session for a client without `elidedVerdicts` and resumes it for one with it", () => {
    // The capability is the connection's: a session opened without it takes
    // it on from a later connection that advertises it.
    const registry = new SessionRegistry();
    const opened = registry.open("space", {}, 0, "connection-a", "principal");
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts)
      .toBeUndefined();
    registry.open(
      "space",
      { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
      0,
      "connection-b",
      "principal",
      undefined,
      false,
      true,
    );
    expect(registry.get("space", opened.sessionId)?.elidedVerdicts).toBe(true);
  });
});
