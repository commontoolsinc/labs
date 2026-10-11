import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SessionDemand } from "@commonfabric/memory/v2/server";
import { DemandShareCache } from "../../src/executor/demand-shares.ts";

const space = "did:key:z6MkDemandSharesSpace";

const share = (sessionId: string): SessionDemand => ({
  sessionId,
  rows: new Map(),
});

/** A reader that answers from `shares` and records what it was asked for. */
const reader = (shares: Record<string, SessionDemand>) => {
  const asked: string[][] = [];
  return {
    asked,
    read: (sessionIds: string[]) => {
      asked.push([...sessionIds]);
      return Promise.resolve(
        sessionIds.flatMap((id) =>
          shares[id] === undefined ? [] : [shares[id]]
        ),
      );
    },
  };
};

const live = (...entries: Array<[string, string | undefined]>) =>
  new Map(entries.map(([id, principal]) => [id, { principal }]));

describe("demand-shares", () => {
  it("reads every live session's share once and hands the same objects to the next pass", async () => {
    const cache = new DemandShareCache();
    const shares = { a: share("a"), b: share("b") };
    const r = reader(shares);
    const sessions = live(["a", "did:key:alice"], ["b", "did:key:bob"]);

    const first = await cache.sharesFor(space, sessions, undefined, r.read);
    const second = await cache.sharesFor(space, sessions, undefined, r.read);

    expect(first).toEqual([shares.a, shares.b]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(r.asked).toEqual([["a", "b"]]);
  });

  it("re-reads only the session whose demand changed", async () => {
    const cache = new DemandShareCache();
    const shares = { a: share("a"), b: share("b") };
    const r = reader(shares);
    const sessions = live(["a", undefined], ["b", undefined]);
    const first = await cache.sharesFor(space, sessions, undefined, r.read);

    shares.b = share("b");
    cache.noteChanged(space, "b");
    const second = await cache.sharesFor(space, sessions, undefined, r.read);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(shares.b);
    expect(r.asked).toEqual([["a", "b"], ["b"]]);
  });

  it("re-reads every session when the change names none", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a"), b: share("b") });
    const sessions = live(["a", undefined], ["b", undefined]);
    await cache.sharesFor(space, sessions, undefined, r.read);

    cache.noteChanged(space);
    await cache.sharesFor(space, sessions, undefined, r.read);

    expect(r.asked).toEqual([["a", "b"], ["a", "b"]]);
  });

  it("leaves out the excluded principal's sessions and the ones no longer live or held", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a"), c: share("c") });
    const first = await cache.sharesFor(
      space,
      live(["a", "did:key:alice"], ["svc", "did:key:service"], [
        "c",
        undefined,
      ]),
      "did:key:service",
      r.read,
    );
    const second = await cache.sharesFor(
      space,
      live(["a", "did:key:alice"], ["gone", undefined]),
      "did:key:service",
      r.read,
    );

    expect(first.map((s) => s.sessionId)).toEqual(["a", "c"]);
    expect(second.map((s) => s.sessionId)).toEqual(["a"]);
    expect(r.asked).toEqual([["a", "c"], ["gone"]]);
  });

  it("reads a forgotten session's share again when it is live", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a") });
    const sessions = live(["a", undefined]);
    await cache.sharesFor(space, sessions, undefined, r.read);

    cache.forget(space, "a");
    await cache.sharesFor(space, sessions, undefined, r.read);

    expect(r.asked).toEqual([["a"], ["a"]]);
  });
});
