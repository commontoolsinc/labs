// Differential consistency harness: seeded random commit schedules driven
// against the real engine AND the naive reference model (naive-admission.ts).
//
// Checked properties (IDs from docs/specs/memory-v2/09-invariants.md):
//
//   INV-2 (one-directional refinement): if the engine ACCEPTS a commit, the
//     naive model must also accept it. The engine rejecting more than the
//     model is fine (over-approximation costs a retry); accepting more is
//     an unsound admission.
//
//   INV-9 (log determinism): after each schedule, every entity's durable
//     value in the engine equals the naive fold of the accepted operations.
//
//   INV-1 (read coherence, confirmed reads): a post-hoc re-scan of the
//     accepted history — the same check the state-inspector oracle runs
//     over a space DB — finds no committed confirmed read that an exact
//     overlap test would have rejected.
//
// Determinism: schedules are generated from fixed seeds via a local PRNG —
// no wall clock, no Math.random, no timing dependence. On failure the seed
// and step index identify the exact schedule; rerun with only that seed to
// reproduce, then shrink by hand or promote the schedule to a named
// regression test.

import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  read,
} from "../v2/engine.ts";
import {
  type ClientCommit,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";
import {
  emptyHistory,
  naiveAdmit,
  naiveApply,
  naivePathsOverlap,
  naiveRecord,
  toNaiveOps,
} from "./naive-admission.ts";

// --- Deterministic PRNG (mulberry32) -------------------------------------

const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];
const chance = (rng: Rng, p: number): boolean => rng() < p;

// --- Schedule vocabulary --------------------------------------------------

const ENTITIES = ["entity:A", "entity:B"] as const;
const SESSIONS = [
  { sessionId: "s-alice", principal: "did:key:zAlice" },
  { sessionId: "s-bob", principal: "did:key:zBob" },
  { sessionId: "s-carol", principal: "did:key:zCarol" },
] as const;

// Object-key leaves plus one array for appends; every generated set keeps
// this full shape so later patches never hit a missing container.
const KEY_LEAVES = [
  ["value", "title"],
  ["value", "votes", "u1"],
  ["value", "votes", "u2"],
] as const;
const freshDocValue = (stamp: number) => ({
  title: `t${stamp}`,
  votes: { u1: 0, u2: 0 },
  items: [] as unknown[],
});
const doc = (value: unknown): EntityDocument => ({ value } as EntityDocument);

interface SessionState {
  sessionId: string;
  principal: string;
  nextLocalSeq: number;
  /** Simulated integration watermark: the read basis this client would use. */
  integratedSeq: number;
  /** Own prior localSeqs per entity, newest last (for pending-read stacks). */
  stacks: Map<string, number[]>;
}

interface AcceptedRecord {
  seq: number;
  sessionId: string;
  commit: ClientCommit;
}

// --- One schedule ----------------------------------------------------------

const STEPS = 25;

interface ScheduleStats {
  accepted: number;
  rejected: number;
  pendingReadAccepts: number;
}

const runSchedule = async (seed: number): Promise<ScheduleStats> => {
  const rng = mulberry32(seed);
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine: Engine = await open({ url: toFileUrl(path) });
  const history = emptyHistory();
  const values = new Map<string, Record<string, unknown>>();
  const accepted: AcceptedRecord[] = [];
  let headSeq = 0;
  const stats: ScheduleStats = {
    accepted: 0,
    rejected: 0,
    pendingReadAccepts: 0,
  };

  const ctx = (step: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ seed, step, ...extra });

  const admitBoth = (
    session: { sessionId: string; principal: string },
    commit: ClientCommit,
    step: number,
  ) => {
    const naive = naiveAdmit(history, session.sessionId, commit);
    let engineSeq: number | null = null;
    try {
      engineSeq = applyCommit(engine, {
        sessionId: session.sessionId,
        principal: session.principal,
        commit,
      }).seq;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
    if (engineSeq !== null && !naive.accepted) {
      throw new Error(
        `INV-2 violated: engine accepted a commit the reference model ` +
          `rejects (${naive.reason}) — ${ctx(step, { commit })}`,
      );
    }
    if (engineSeq !== null) {
      naiveRecord(history, session.sessionId, commit, engineSeq);
      naiveApply(values, commit.operations);
      accepted.push({ seq: engineSeq, sessionId: session.sessionId, commit });
      headSeq = engineSeq;
    }
    return engineSeq;
  };

  const sessions: SessionState[] = SESSIONS.map((s) => ({
    ...s,
    nextLocalSeq: 1,
    integratedSeq: 0,
    stacks: new Map(),
  }));

  try {
    // Deterministic seeding: both entities exist with the full shape.
    for (const id of ENTITIES) {
      const commit: ClientCommit = {
        localSeq: sessions[0].nextLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: doc(freshDocValue(0)) }],
      };
      if (admitBoth(sessions[0], commit, -1) === null) {
        throw new Error(`seeding must be conflict-free — ${ctx(-1)}`);
      }
    }
    for (const s of sessions) s.integratedSeq = headSeq;

    for (let step = 0; step < STEPS; step++) {
      const session = pick(rng, sessions);
      const id = pick(rng, ENTITIES);

      // Writes: whole-doc set, key replace, or array append.
      const operations: ClientCommit["operations"] = [];
      const roll = rng();
      if (roll < 0.15) {
        operations.push({
          op: "set",
          id,
          value: doc(freshDocValue(step + 1)),
        });
      } else if (roll < 0.7) {
        const leaf = pick(rng, KEY_LEAVES);
        operations.push({
          op: "patch",
          id,
          patches: [{
            op: "replace",
            path: `/${leaf.join("/")}`,
            value: `${session.sessionId}#${step}`,
          }],
        });
      } else {
        operations.push({
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/items/-",
            value: `${session.sessionId}#${step}`,
          }],
        });
      }

      // Reads: sometimes none (blind write), sometimes a confirmed read at
      // the session's (possibly stale) watermark, sometimes a pending read
      // through the session's own prior commits on this entity.
      const reads: ClientCommit["reads"] = { confirmed: [], pending: [] };
      const stack = session.stacks.get(id) ?? [];
      if (chance(rng, 0.6)) {
        const readLeaf = chance(rng, 0.5)
          ? pick(rng, KEY_LEAVES)
          : (["value", "items"] as const);
        if (stack.length > 0 && chance(rng, 0.5)) {
          reads.pending.push({
            id,
            path: toDocumentPath([...readLeaf]),
            localSeq: [...stack],
            // Half the pending reads declare the reader's true confirmed
            // basis (the CT-1910 repaired shape, scanned with own-session
            // exclusion); the rest stay legacy max-dependency so both
            // admission paths keep differential coverage.
            ...(chance(rng, 0.5) ? { basisSeq: session.integratedSeq } : {}),
          });
        } else {
          reads.confirmed.push({
            id,
            path: toDocumentPath([...readLeaf]),
            seq: session.integratedSeq,
          });
        }
      }

      const commit: ClientCommit = {
        localSeq: session.nextLocalSeq++,
        reads,
        operations,
      };
      const engineSeq = admitBoth(session, commit, step);

      if (engineSeq !== null) {
        stats.accepted++;
        if (reads.pending.length > 0) stats.pendingReadAccepts++;
        stack.push(commit.localSeq);
        session.stacks.set(id, stack);
      } else {
        stats.rejected++;
        // Client retry discipline (§3.12): drop the rejected commit and its
        // dependents, refresh, rebuild. Here: reset this entity's stack and
        // catch the watermark up.
        session.stacks.set(id, []);
        session.integratedSeq = headSeq;
      }
      // Sessions integrate lazily — stale watermarks are how conflicts arise.
      if (chance(rng, 0.4)) session.integratedSeq = headSeq;
    }

    // INV-9: durable engine values equal the naive fold of accepted ops.
    for (const id of ENTITIES) {
      const durable = read(engine, { id }) as { value?: unknown } | null;
      assertEquals(
        durable?.value,
        values.get(id)?.value,
        `INV-9 divergence on ${id} — ${ctx(STEPS)}`,
      );
    }

    // INV-1 (confirmed reads): re-scan the accepted history with the exact
    // overlap test — the in-process twin of the state-inspector oracle.
    for (const record of accepted) {
      for (const rd of record.commit.reads.confirmed) {
        for (const other of accepted) {
          if (other.seq <= rd.seq || other.seq >= record.seq) continue;
          if (other.sessionId === record.sessionId) continue;
          const hit = toNaiveOps(other.commit.operations).some((op) =>
            op.id === rd.id &&
            (op.kind === "set" ||
              op.leafPaths.some((leaf) => naivePathsOverlap(leaf, rd.path)))
          );
          if (hit) {
            throw new Error(
              `INV-1 violated: commit at seq ${record.seq} holds a ` +
                `confirmed read of ${rd.id}@${rd.seq} that overlaps the ` +
                `accepted write at seq ${other.seq} — ${ctx(STEPS)}`,
            );
          }
        }
      }
      // INV-1 (pending reads, CT-1910 repaired shape): a declared basis makes
      // pending reads post-hoc checkable for the first time — no foreign
      // accepted write overlapping the path may land in (basisSeq, seq).
      // Legacy reads (no basisSeq) stay uncheckable here; their deviation is
      // recorded against INV-1 in 09-invariants.md.
      for (const rd of record.commit.reads.pending) {
        if (rd.basisSeq === undefined) continue;
        for (const other of accepted) {
          if (other.seq <= rd.basisSeq || other.seq >= record.seq) continue;
          if (other.sessionId === record.sessionId) continue;
          const hit = toNaiveOps(other.commit.operations).some((op) =>
            op.id === rd.id &&
            (op.kind === "set" ||
              op.leafPaths.some((leaf) => naivePathsOverlap(leaf, rd.path)))
          );
          if (hit) {
            throw new Error(
              `INV-1 violated: commit at seq ${record.seq} holds a ` +
                `pending read of ${rd.id} based at ${rd.basisSeq} that ` +
                `overlaps the foreign accepted write at seq ${other.seq} — ` +
                ctx(STEPS),
            );
          }
        }
      }
    }
  } finally {
    close(engine);
    await Deno.remove(path).catch(() => {});
  }
  return stats;
};

Deno.test("memory v2 differential: engine admission refines the naive model across seeded schedules", async () => {
  const totals: ScheduleStats = {
    accepted: 0,
    rejected: 0,
    pendingReadAccepts: 0,
  };
  for (let seed = 1; seed <= 100; seed++) {
    const stats = await runSchedule(seed);
    totals.accepted += stats.accepted;
    totals.rejected += stats.rejected;
    totals.pendingReadAccepts += stats.pendingReadAccepts;
  }
  // Schedule-shape sanity (deterministic, seeds are fixed): the generator
  // must keep exercising rejections and accepted pending-stack reads, or
  // the differential assertions above become vacuous.
  if (totals.rejected < 50 || totals.pendingReadAccepts < 50) {
    throw new Error(
      `degenerate schedule mix: ${JSON.stringify(totals)} — retune generator`,
    );
  }
});
