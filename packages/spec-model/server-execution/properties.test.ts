/**
 * Property checks over explored schedules of the v2 identity/commit
 * model. Each test names the spec passages it binds. One test is a
 * CHARACTERIZATION of open ledger item FP1 (field-provenance.md §6):
 * it asserts the defect IS reachable; when the ruling closes FP1,
 * that test flips to asserting closure.
 */

import { assert, assertEquals } from "@std/assert";
import {
  admitDerived,
  applicableSet,
  apply,
  explore,
  makeWorld,
  pushRowsFor,
  sessionKey,
  type Step,
  userKey,
  type World,
} from "./model.ts";

const U1 = "did:u1";
const S1 = "sess1";
const U2 = "did:u2";
const S2 = "sess2";

function noViolations(worlds: World[]) {
  for (const w of worlds) {
    assertEquals(w.violations, [], `violations in trace ${w.trace.join(" ")}`);
  }
}

/** Every stream entry's firedAt equals its chain root (events §2). */
function assertInheritance(w: World) {
  for (const sp of Object.values(w.spaces)) {
    for (const st of Object.values(sp.streams)) {
      for (const e of st.entries) {
        const root = w.rootOf[e.eventId];
        assert(root !== undefined, `no root for ${e.eventId}`);
        assertEquals(e.firedAt.user, root.user, "root user preserved");
        assertEquals(
          e.firedAt.session,
          root.session ?? "server",
          "root session preserved (or sessionless)",
        );
      }
    }
  }
}

// ---------- C1: same-space cascade (trace T3's shape) ----------

function c1World(splitWaves = false) {
  return makeWorld({
    spaces: {
      A: {
        streams: {
          s1: { writes: ["session"], cascadeTo: { space: "A", stream: "s2" } },
          s2: { writes: ["session"], navigate: true },
        },
      },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
    splitWaves,
  });
}

const C1_MENU: Step[] = [
  { kind: "fire", session: S1, space: "A", stream: "s1" },
  { kind: "wave", space: "A" },
  { kind: "enact", session: S1, space: "A" },
  { kind: "ack", session: S1, space: "A" },
];

Deno.test("C1: cascade inherits the root actor; intents reach the clicking session; LT1 carriage in one wave", () => {
  const w0 = apply(c1World(), C1_MENU[0]);
  const { finals, all } = explore(w0, C1_MENU.slice(1), { maxSteps: 6 });
  noViolations(all);
  assert(finals.length > 0);
  for (const w of all) assertInheritance(w);
  for (const w of finals) {
    const sp = w.spaces.A;
    // both events consequenced, in ONE wave commit's consequenceOf
    const derived = sp.commits.filter((c) => c.class === "derived");
    assert(derived.length >= 1, "a wave committed");
    const withConseq = derived.filter((c) => (c.consequenceOf ?? []).length);
    for (const c of withConseq) {
      assertEquals(
        c.consequenceOf!.length,
        2,
        "same-space cascade processed in the SAME wave (LT1, T3.Q8)",
      );
    }
    // no outbox involvement for a same-space cascade (LT1)
    assertEquals(w.servers.A.outbox.length, 0);
    assertEquals(w.servers.A.lostAppends.length, 0);
    // every session write landed in the ROOT session's instance
    for (const c of derived) {
      for (const row of c.writes) {
        assertEquals(row.scopeKey, sessionKey(U1, S1), "scopes §5");
        assertEquals(row.attribution?.user, U1);
        assertEquals(row.attribution?.session, S1);
      }
    }
    // every intent is in the clicking session's effects instance
    for (const [key, intents] of Object.entries(sp.effects)) {
      if (intents.length > 0) assertEquals(key, sessionKey(U1, S1));
    }
    // no handler errors on this legal chain
    for (const st of Object.values(sp.streams)) {
      for (const e of st.entries) {
        assertEquals(e.error, undefined, "no error on a session-bearing chain");
      }
    }
  }
});

Deno.test("C1-split: every split commit repeats the FULL consequenceOf (serving-loop §3)", () => {
  const w0 = apply(c1World(true), C1_MENU[0]);
  const { finals } = explore(w0, [{ kind: "wave", space: "A" }], {
    maxSteps: 3,
  });
  let sawSplit = false;
  for (const w of finals) {
    const derived = w.spaces.A.commits.filter((c) => c.class === "derived");
    const byWave = new Map<number, typeof derived>();
    for (const c of derived) {
      const list = byWave.get(c.waveId!) ?? [];
      list.push(c);
      byWave.set(c.waveId!, list);
    }
    for (const group of byWave.values()) {
      if (group.length > 1) sawSplit = true;
      const first = JSON.stringify(group[0].consequenceOf);
      for (const c of group) {
        assertEquals(JSON.stringify(c.consequenceOf), first);
        assertEquals(c.derivedThrough, group[0].derivedThrough);
      }
    }
  }
  assert(sawSplit, "the split configuration actually split a wave");
});

Deno.test("C1-LT8: a reload between enact and ack can re-enact — bounded, and accepted", () => {
  const w0 = apply(c1World(), C1_MENU[0]);
  const menu: Step[] = [...C1_MENU.slice(1), { kind: "reload", session: S1 }];
  const { all } = explore(w0, menu, { maxSteps: 8 });
  noViolations(all);
  let sawReEnact = false;
  for (const w of all) {
    const reloads = w.trace.filter((t) => t.includes('"reload"')).length;
    for (const n of Object.values(w.clients[S1].enactCount)) {
      assert(
        n <= 1 + reloads,
        "each re-enactment requires a reload (the LT8 window, nothing more)",
      );
      if (n >= 2) sawReEnact = true;
    }
  }
  assert(sawReEnact, "the LT8 window is real: a schedule re-enacts");
});

// ---------- C2: cross-space chain (trace T4's shape) + FP1 ----------

function c2World() {
  return makeWorld({
    spaces: {
      A: {
        streams: {
          s1: { writes: [], cascadeTo: { space: "B", stream: "t1" } },
        },
      },
      B: {
        streams: {
          t1: { writes: ["session"], navigate: true },
        },
      },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
}

Deno.test("C2: identity crosses the boundary (LT2); session write lands in B under (U1,S1); navigateTo in B errors (LT3)", () => {
  const w0 = apply(c2World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s1",
  });
  const menu: Step[] = [
    { kind: "wave", space: "A" },
    { kind: "deliver", space: "A" },
    { kind: "wave", space: "B" },
  ];
  const { finals, all } = explore(w0, menu, { maxSteps: 6 });
  noViolations(all);
  for (const w of all) assertInheritance(w);
  const done = finals.filter((w) =>
    Object.values(w.spaces.B.streams.t1.entries).some((e) => e.consequenced)
  );
  assert(done.length > 0, "some schedule completes the chain");
  for (const w of done) {
    const entry = w.spaces.B.streams.t1.entries[0];
    // stamped at B from the CARRIED actor, not the delegating envelope
    assertEquals(entry.firedAt.user, U1);
    assertEquals(entry.firedAt.session, S1);
    // session-scoped consequence landed in (U1,S1)'s instance IN B
    const rows = w.spaces.B.commits.flatMap((c) => c.writes);
    assert(rows.some((r) => r.scopeKey === sessionKey(U1, S1)));
    // LT3: navigateTo computed in B, where S1 is NOT connected → error
    assert(
      entry.error?.includes("LT3"),
      "cross-space navigateTo is the deferral error",
    );
    assertEquals(Object.keys(w.spaces.B.effects).length, 0, "no intent");
  }
});

Deno.test("C2-FP1 (CHARACTERIZATION of the open gap): a crash between wave commit and delivery loses the append forever", () => {
  const w0 = apply(c2World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s1",
  });
  const menu: Step[] = [
    { kind: "wave", space: "A" },
    { kind: "deliver", space: "A" },
    { kind: "crash", space: "A" },
    { kind: "recover", space: "A" },
    { kind: "wave", space: "B" },
  ];
  const { all } = explore(w0, menu, { maxSteps: 8 });
  noViolations(all);
  // The gap: a REACHABLE state where the append is lost, B never saw
  // it, and nothing can ever regenerate it — A's event is already
  // consequenced (no wave re-emits), the outbox entry is gone, and
  // no transition in the menu can recreate it. "Forever" is
  // structural, so quantify over all reachable states, not terminal
  // ones (the crash/recover toggle means lost states never
  // terminate).
  const lostForever = all.filter((w) =>
    w.servers.A.lostAppends.length > 0 &&
    w.spaces.B.streams.t1.entries.length === 0 &&
    w.servers.A.outbox.length === 0 &&
    w.spaces.A.streams.s1.entries.every((e) => e.consequenced)
  );
  assert(
    lostForever.length > 0,
    "FP1 is real: the lost-append state is reachable. When the FP1 " +
      "ruling lands a regeneration mechanism, model it and flip this " +
      "test to assert the set is EMPTY.",
  );
  // And on crash-free schedules, delivery is exactly-once:
  for (const w of all) {
    if (w.servers.A.lostAppends.length === 0) {
      assert(w.spaces.B.streams.t1.entries.length <= 1, "never duplicated");
    }
  }
});

Deno.test("C2-dedupe: at-least-once redelivery is idempotent at the target (events §4)", () => {
  // Deliver twice by re-enqueueing the same entry manually.
  let w = apply(c2World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s1",
  });
  w = apply(w, { kind: "wave", space: "A" });
  const entry = structuredClone(w.servers.A.outbox[0]);
  w = apply(w, { kind: "deliver", space: "A" });
  w.servers.A.outbox.push(entry); // the retry
  w = apply(w, { kind: "deliver", space: "A" });
  assertEquals(w.spaces.B.streams.t1.entries.length, 1, "deduped by eventId");
  w = apply(w, { kind: "wave", space: "B" });
  w.servers.A.outbox.push(entry); // late retry, post-processing
  w = apply(w, { kind: "deliver", space: "A" });
  assertEquals(
    w.spaces.B.streams.t1.entries.length,
    1,
    "post-watermark duplicate skipped (idempotent)",
  );
});

// ---------- C3: sessionless chains and uniform inheritance (LT6) ----------

Deno.test("C3: derivation-emitted events carry the demand identity uniformly (LT6); sessionless writes error", () => {
  const base = makeWorld({
    spaces: {
      A: { streams: { s: { writes: ["session", "user"], navigate: true } } },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  const cases: Array<{
    acting: { user?: string; session?: string };
    wantSession: string;
    sessionWriteOk: boolean;
    userWriteOk: boolean;
    navigateOk: boolean;
  }> = [
    // space-scope run: no identity at all
    {
      acting: {},
      wantSession: "server",
      sessionWriteOk: false,
      userWriteOk: false,
      navigateOk: false,
    },
    // user-instance run: acting user, no session
    {
      acting: { user: U1 },
      wantSession: "server",
      sessionWriteOk: false,
      userWriteOk: true,
      navigateOk: false,
    },
    // session-instance run: fully session-bearing (LT6 uniform)
    {
      acting: { user: U1, session: S1 },
      wantSession: S1,
      sessionWriteOk: true,
      userWriteOk: true,
      navigateOk: true,
    },
  ];
  for (const c of cases) {
    let w = apply(base, {
      kind: "derivationEmit",
      space: "A",
      stream: "s",
      acting: c.acting,
    });
    w = apply(w, { kind: "wave", space: "A" });
    const entry = w.spaces.A.streams.s.entries[0];
    assertEquals(entry.firedAt.session, c.wantSession);
    const rows = w.spaces.A.commits.flatMap((x) => x.writes);
    assertEquals(
      rows.some((r) => r.scopeKey.startsWith("session:")),
      c.sessionWriteOk,
    );
    assertEquals(
      rows.some((r) => r.scopeKey.startsWith("user:")),
      c.userWriteOk,
    );
    const intents = Object.values(w.spaces.A.effects).flat();
    assertEquals(intents.length > 0, c.navigateOk);
    if (!c.sessionWriteOk || !c.navigateOk) {
      assert(entry.error !== undefined, "the specced runtime error surfaced");
    }
    assertEquals(w.violations, []);
  }
});

// ---------- C4: push privacy and settledness ----------

Deno.test("C4: a subscriber receives only its applicable set (protocol §3); settledness is sound (protocol §4)", () => {
  const w0 = makeWorld({
    spaces: {
      A: { streams: { s: { writes: ["space", "user", "session"] } } },
    },
    clients: [
      { user: U1, session: S1, connected: ["A"] },
      { user: U2, session: S2, connected: ["A"] },
    ],
  });
  let w = apply(w0, { kind: "fire", session: S1, space: "A", stream: "s" });
  const fireSeq = w.spaces.A.seq;
  w = apply(w, { kind: "wave", space: "A" });
  const s2 = w.clients[S2];
  for (const commit of w.spaces.A.commits) {
    const rows = pushRowsFor(commit, s2);
    const ok = new Set(applicableSet(s2));
    for (const r of rows) assert(ok.has(r.scopeKey));
    // U1's scoped rows are ABSENT for S2
    assert(!rows.some((r) => r.scopeKey === userKey(U1)));
    assert(!rows.some((r) => r.scopeKey === sessionKey(U1, S1)));
    // the space row IS delivered
    if (commit.class === "derived") {
      assert(rows.some((r) => r.scopeKey === "space"));
    }
  }
  // settledness: W >= the fire's seq implies its consequences committed
  assert(w.spaces.A.W >= fireSeq);
  assert(w.spaces.A.streams.s.entries.every((e) => e.consequenced));
});

// ---------- C6: admission negatives ----------

Deno.test("C6: derived admission is the lease equality check — forgeries and non-holders rejected (protocol §2, serving-loop §2)", () => {
  const w = makeWorld({
    spaces: { A: { streams: {} } },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  const sp = w.spaces.A;
  assert(admitDerived(sp, { holder: "server:A", envelope: "service:A" }));
  assert(!admitDerived(sp, { holder: "server:B", envelope: "service:B" }));
  assert(!admitDerived(sp, { holder: undefined, envelope: "service:A" }));
  // a client cannot even represent a derived commit: envelope check
  assert(
    !admitDerived(sp, { holder: "server:A", envelope: sessionKey(U1, S1) }),
  );
  sp.leaseHolder = null; // expired lease matches NOBODY (protocol §2)
  assert(!admitDerived(sp, { holder: "server:A", envelope: "service:A" }));
});
