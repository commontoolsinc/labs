import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SessionRegistry } from "../v2/session-registry.ts";

const SPACE = "did:key:zSpace";

describe("session-registry", () => {
  it("notifies removal observers on outright removal", () => {
    const registry = new SessionRegistry();
    const removed: string[] = [];
    registry.onSessionRemoved((session) => removed.push(session.id));
    const opened = registry.open(SPACE, {}, 0, "conn-1");
    registry.remove(SPACE, opened.sessionId);
    expect(removed).toEqual([opened.sessionId]);
    expect(registry.get(SPACE, opened.sessionId)).toBeNull();
  });

  it("notifies removal observers when a detached session expires", () => {
    // ttlMs 0: detaching stamps an already-elapsed expiry, so the next
    // registry access prunes the session — no waiting involved.
    const registry = new SessionRegistry({ ttlMs: 0 });
    const removed: string[] = [];
    registry.onSessionRemoved((session) => removed.push(session.id));
    const opened = registry.open(SPACE, {}, 0, "conn-1");
    registry.detach(SPACE, opened.sessionId, "conn-1");
    expect(registry.get(SPACE, opened.sessionId)).toBeNull();
    expect(removed).toEqual([opened.sessionId]);
  });

  it("does not notify observers for a resume", () => {
    const registry = new SessionRegistry();
    const removed: string[] = [];
    registry.onSessionRemoved((session) => removed.push(session.id));
    const opened = registry.open(SPACE, {}, 0, "conn-1");
    const resumed = registry.open(
      SPACE,
      { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
      0,
      "conn-2",
    );
    expect(resumed.resumed).toBe(true);
    expect(removed).toEqual([]);
  });

  it("notifies every registered observer, registration order preserved", () => {
    // The Server registers its inference-retention cleanup this way even on
    // an INJECTED registry; a second owner of per-session state must not
    // displace it.
    const registry = new SessionRegistry();
    const calls: string[] = [];
    registry.onSessionRemoved(() => calls.push("first"));
    registry.onSessionRemoved(() => calls.push("second"));
    const opened = registry.open(SPACE, {}, 0, "conn-1");
    registry.remove(SPACE, opened.sessionId);
    expect(calls).toEqual(["first", "second"]);
  });
});
