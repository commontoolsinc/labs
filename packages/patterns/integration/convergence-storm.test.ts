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
 * B3 (writer-side integration gap, INDEPENDENT of B1/B2): a writer that
 *     interleaves its own append never integrates a peer's concurrent append —
 *     a same-seq value divergence the delta-sync protocol can't repair. Pinned
 *     by array-append-client-convergence.test.ts (deterministic) and the
 *     "writer integration gap (plain elements)" case here.
 *
 * Status in this PR (see the PR body for the decision-ready breakdown):
 *  - "reader blackout (minimal)" → GREEN: fixed by the B2 grace change in this
 *    PR (traverse.ts required-exemption for unresolvable links).
 *  - "controls" (PerSpace link / optional field) → GREEN, pin the two mechanisms.
 *  - "convergence storm — observer converges" → GREEN: with B2 fixed, a
 *    non-writing participant fully converges under a 40-message storm (was the
 *    escalated blackout/wedge before the fix).
 *  - "writer integration gap (plain elements)" → RED: the still-open B3.
 *
 * Green = what this PR achieves; red = the pinned, still-open B3 (asserts the
 * desired end-state, red until B3 is fixed). Full context + measurements:
 * docs/plans/2026-06-30-profile-loading-investigation.md and
 * docs/plans/2026-07-02-convergence-evidence-appendix.md.
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

// The reader blackout: a required element field carries a PerUser-cell link
// that a non-authoring reader cannot resolve (B1 stores it scope-generic), and
// the `required` check then voids the whole array read (B2). GREEN with the B2
// fix in this PR (the required-exemption for unresolvable links); was the core
// red repro before it. (B1 is still latent here — the reader now sees a cell
// resolving into its own partition — but the LIST no longer blacks out.)
minimalCase(
  "reader blackout (minimal): required PerUser-cell link in elements",
  "convergence-chat-noderived",
);

// Control — B1 sidestepped: the linked cell is PerSpace, so every session
// resolves the same partition. (Green independent of the B2 fix.)
minimalCase(
  "control: PerSpace-scoped link in elements",
  "convergence-chat-spacelink",
);

// Control — B2 sidestepped a different way: the field is optional, so the
// absent resolution degrades that field instead of voiding the element/array.
// (Green independent of the B2 fix; pins that `required` is the collapse lever.)
minimalCase(
  "control: optional PerUser-cell link in elements",
  "convergence-chat-optlink",
);

// FAILS today — B3 (writer-side integration gap, distinct from B1/B2): with
// PLAIN elements (no links, so no blackout), all sends land durably and a
// non-writing observer converges — but the writer that lost the interleaving
// race permanently keeps a stale array holding ONLY ITS OWN appends, through
// 20 settle rounds and pulling reads (5/5 reproducible via storm-driver.ts
// `20 2 pipeline 0 convergence-chat-plain`).
describe("writer integration gap (plain elements, no links)", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let observer: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: fixture("convergence-chat-plain"),
      rootPath: ROOT_PATH,
      sessions: ["plain-alice", "plain-bob", "plain-observer"],
    });
    [alice, bob, observer] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("both writers converge after concurrent posting", async () => {
    const K = 20;
    const storm = async (session: MultiRuntimeSession, author: string) => {
      for (let n = 0; n < K; n++) {
        await session.send(
          "post",
          { author, body: `${author}-${n}`, n },
          undefined,
          { idle: false },
        );
      }
    };
    await Promise.all([storm(alice, "alice"), storm(bob, "bob")]);
    await harness.settle(20);

    const aliceView = await messages(alice);
    const bobView = await messages(bob);
    const observerView = await messages(observer);
    const detail = `alice=${JSON.stringify(summarize(aliceView))} ` +
      `bob=${JSON.stringify(summarize(bobView))} ` +
      `observer=${JSON.stringify(summarize(observerView))}`;

    // The observer converges and shows full delivery (passes today) — the
    // defect is confined to the racing writers' own replicas.
    assertEquals(
      observerView.length,
      2 * K,
      `observer missed durable sends: ${detail}`,
    );
    // One racing writer keeps a stale own-appends-only array (fails today).
    assertEquals(
      bodies(aliceView),
      bodies(observerView),
      `alice's replica is stale: ${detail}`,
    );
    assertEquals(
      bodies(bobView),
      bodies(observerView),
      `bob's replica is stale: ${detail}`,
    );
  });
});

// The B2 fix, exercised at storm scale: a non-writing participant fully
// converges under a sustained concurrent-write storm and sees every accepted
// send. Before the fix this observer read `{}` (the reader blackout, escalated
// by the shared derived reader in `convergence-chat` into the seq-0 commit
// wedge). The writers' MUTUAL convergence is a SEPARATE, still-open concern
// (B3 — the interleaving writer keeps only its own appends); it is pinned by
// `array-append-client-convergence.test.ts` and the "writer integration gap"
// case above, so this test deliberately asserts only the reader/observer
// guarantee that B2 restores.
describe("convergence storm — observer converges under concurrent writes (B2)", () => {
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
