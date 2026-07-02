/**
 * Reader-blackout / convergence repro — multi-runtime, in-process, no browser.
 *
 * ROOT CAUSE (two composable defects, isolated by the fixture matrix here):
 *
 *  B1 (write-side identity loss): a handler pushing a live `PerUser` cell into
 *     shared `PerSpace` state stores a scope-GENERIC `"user"` link — the owner
 *     DID is not captured — so every OTHER session resolves the link into its
 *     OWN (empty) user partition.
 *  B2 (read-side collapse): the element schema marks that field `required`;
 *     when the link target resolves absent for a reader, schema validation
 *     voids the WHOLE element and the WHOLE array read (undefined) — while
 *     sub-path reads (`messages.0.author`) still work.
 *
 * Composition: any session that didn't author the write reads the shared list
 * as EMPTY, even though its replica holds both the array and the linked docs
 * (verified via raw storage reads — see storm-driver.ts). With shared derived
 * cells over the list, the void read is recorded at seq 0 into their commits,
 * which then conflict forever once the docs land — the wedge / retry-storm /
 * starvation tower measured in the browser investigation
 * (docs/plans/2026-06-30-profile-loading-investigation.md).
 *
 * Layout:
 *  - "reader blackout (minimal)": ONE settled post, zero contention → FAILS.
 *  - "controls": PerSpace-scoped link (B1 sidestepped) and optional field
 *    (B2 sidestepped) — both PASS today, pinning the two mechanisms.
 *  - "storm": 2 concurrent writers + observer, deep pipelines → FAILS, shows
 *    the same defect amplified under load (plus conflict churn).
 *
 * The failing cases assert DESIRED behaviour — this file is a repro vehicle
 * and stays red until the defects are fixed.
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
 * The minimal flow shared by the blackout case and both controls: alice makes
 * ONE fully-settled post; the observer (a different identity that never
 * writes) must be able to read it.
 */
function minimalCase(title: string, fixtureName: string) {
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

    it("a second session reads the settled post", async () => {
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
        ["alice-0"],
        `reader blackout: observer sees ${JSON.stringify(observerView)} ` +
          `(raw replica holds the array + linked doc — see storm-driver.ts)`,
      );
    });
  });
}

// FAILS today: PerUser-cell link stored scope-generic (B1) + required field
// voids the whole array read for non-authors (B2).
minimalCase(
  "reader blackout (minimal): required PerUser-cell link in elements",
  "convergence-chat-noderived",
);

// PASSES today — B1 sidestepped: the linked cell is PerSpace, so every
// session resolves the same partition.
minimalCase(
  "control: PerSpace-scoped link in elements",
  "convergence-chat-spacelink",
);

// PASSES today — B2 sidestepped: the field is optional, so the absent
// resolution degrades that field instead of voiding the element/array.
minimalCase(
  "control: optional PerUser-cell link in elements",
  "convergence-chat-optlink",
);

describe("convergence storm (2 writers + observer, deep pipelines)", () => {
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

  it("delivers every concurrent send and converges", async () => {
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

    const aliceView = await messages(alice);
    const bobView = await messages(bob);
    // The observer never posts: its view separates DURABLE loss (a send never
    // landed server-side) from a reader-side failure to materialize state.
    const observerView = await messages(observer);
    const detail = `alice=${JSON.stringify(summarize(aliceView))} ` +
      `bob=${JSON.stringify(summarize(bobView))} ` +
      `observer=${JSON.stringify(summarize(observerView))}`;

    // Convergence: all sessions read the same list.
    assertEquals(
      bodies(aliceView),
      bodies(bobView),
      `writer sessions diverge: ${detail}`,
    );
    assertEquals(
      bodies(observerView),
      bodies(aliceView),
      `observer diverges from writers: ${detail}`,
    );

    // Delivery: every send the handler accepted is in the shared list.
    assertEquals(
      bodies(observerView),
      [...sent].sort(),
      `lost writes: sent=${sent.length} landed=${observerView.length} (${detail})`,
    );

    // Liveness: the pipelines survived the storm — a fresh send still lands
    // and reaches every session (the browser repro left the winning session
    // wedged: its post-storm send never landed at all).
    await alice.send("post", { author: "alice", body: "probe-alice", n: -1 });
    await bob.send("post", { author: "bob", body: "probe-bob", n: -1 });
    await harness.waitFor(
      "post-storm probe sends visible in both writer sessions",
      async () => {
        const a = bodies(await messages(alice));
        const b = bodies(await messages(bob));
        return a.includes("probe-alice") && a.includes("probe-bob") &&
          b.includes("probe-alice") && b.includes("probe-bob");
      },
    );
  });
});
