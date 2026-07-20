/**
 * Scoped-link / convergence coverage — multi-runtime, in-process, no browser.
 *
 * The original reader-blackout investigation exposed a write-side identity
 * defect: putting a live `PerUser` cell into shared `PerSpace` state stored a
 * scope-generic link, so another session resolved the link into its own empty
 * user partition.
 *
 * If that scoped field is required, its absent target correctly makes the
 * element and containing array fail schema validation. Callers that want the
 * remaining message fields while the target is unavailable must declare the
 * field optional. The minimal cases pin that distinction, plus the PerSpace
 * control where every reader resolves the same target.
 *
 * The storm fixture uses the optional declaration and checks observer
 * convergence under sustained writes. The independent B3 writer-integration
 * gap remains covered separately.
 */

import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const ROOT_PATH = join(import.meta.dirname!, "..");
const fixture = (name: string): string =>
  join(import.meta.dirname!, "fixtures", name, "main.tsx");

type Msg = { author: string; body: string; n: number };

async function messages(session: MultiRuntimeSession): Promise<Msg[]> {
  return ((await session.read(["messages"])) as Msg[] | undefined) ?? [];
}

const bodies = (list: Msg[]): string[] => list.map((m) => m.body).sort();

function summarize(list: Msg[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const m of list) by[m.author] = (by[m.author] ?? 0) + 1;
  return by;
}

/**
 * Alice makes one fully-settled post and a different identity reads the list.
 */
function minimalCase(
  title: string,
  fixtureName: string,
  observerBodies: string[],
) {
  describe(title, () => {
    let harness: MultiRuntimeHarness;
    let alice: MultiRuntimeSession;
    let observer: MultiRuntimeSession;

    beforeAll(async () => {
      harness = await MultiRuntimeHarness.create({
        programPath: fixture(fixtureName),
        rootPath: ROOT_PATH,
        sessions: ["min-alice", "min-observer"],
      });
      [alice, observer] = harness.sessions;
      await harness.settle();
    });

    afterAll(async () => {
      await harness?.dispose();
    });

    it("applies the element schema for a second session", async () => {
      await alice.send("post", { author: "alice", body: "alice-0", n: 0 });
      await harness.settle(5);

      const aliceView = await messages(alice);
      const observerView = await messages(observer);
      assertEquals(
        bodies(aliceView),
        ["alice-0"],
        "author's own read is broken — different failure than the repro targets",
      );
      assertEquals(
        bodies(observerView),
        observerBodies,
        `observer sees ${JSON.stringify(observerView)}`,
      );
    });
  });
}

// A required PerUser-cell link resolves to an absent target for the observer.
// The property does not match, so neither does its element or containing array.
minimalCase(
  "required PerUser-cell link in elements",
  "convergence-chat-noderived",
  [],
);

// Control — B1 sidestepped: the linked cell is PerSpace, so every session
// resolves the same partition. (Green independent of the B2 fix.)
minimalCase(
  "control: PerSpace-scoped link in elements",
  "convergence-chat-spacelink",
  ["alice-0"],
);

// An optional field may be omitted when its PerUser target is unavailable, so
// the remaining message object and array still match.
minimalCase(
  "control: optional PerUser-cell link in elements",
  "convergence-chat-optlink",
  ["alice-0"],
);

// The optional-field model exercised at storm scale: a non-writing participant
// fully converges under sustained concurrent writes. Writer convergence is a
// separate, still-open concern
// (B3 — the interleaving writer keeps only its own appends); it is pinned by
// deliberately-red tests in the follow-up B3 PR, so this test deliberately
// asserts only the reader/observer guarantee.
describe("convergence storm — observer converges with optional scoped links", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let observer: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: fixture("convergence-chat"),
      rootPath: ROOT_PATH,
      sessions: ["storm-alice", "storm-bob", "storm-observer"],
    });
    [alice, bob, observer] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("a non-writing session sees every concurrently-posted message", async () => {
    const K = 20;
    const storm = async (session: MultiRuntimeSession, author: string) => {
      const sent: string[] = [];
      for (let n = 0; n < K; n++) {
        const body = `${author}-${n}`;
        // idle:false stacks sends into a deep optimistic pipeline — the
        // multiplayer contention shape (each browser tab pipelines commits).
        await session.send("post", { author, body, n }, undefined, {
          idle: false,
        });
        sent.push(body);
      }
      return sent;
    };
    const [fromAlice, fromBob] = await Promise.all([
      storm(alice, "alice"),
      storm(bob, "bob"),
    ]);
    const sent = [...fromAlice, ...fromBob];

    await harness.settle(20);

    // The observer never posts, so it has no local pendings of its own — it
    // reflects purely what the runtime materializes from durable state. It must
    // see all 2*K messages (delivery + reader convergence), the guarantee B2
    // restores.
    const observerView = await messages(observer);
    assertEquals(
      bodies(observerView),
      [...sent].sort(),
      `observer missed messages: sent=${sent.length} ` +
        `landed=${observerView.length} ` +
        `observer=${JSON.stringify(summarize(observerView))}`,
    );
  });
});
