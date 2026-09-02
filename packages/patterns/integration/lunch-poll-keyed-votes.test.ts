/**
 * Regression test: a lunch-poll vote is a KEYED, mergeable write.
 *
 * `castVote` addresses one vote by `(voter profile entity, option)` and manages
 * membership with `addUnique` / `removeByValue`. It never reads or rewrites the
 * whole vote list, so two people voting at the same time touch different
 * documents and their commits merge instead of conflicting and retrying.
 *
 * This is the property nothing else here could see. `main.test.tsx` drives one
 * runtime, so nothing in it is ever concurrent. `lunch-poll-vote.test.ts` drives
 * two browsers but asserts the OUTCOME — "2 love it" on both — and a whole-list
 * read-modify-write reaches that same outcome, by conflicting and retrying until
 * it converges. `packages/runner/test/array-push-mergeable.test.ts` covers
 * `elementById` / `addUnique` / `removeByValue` with hand-built cells, and the
 * machinery was never what broke. So a vote write can regress to
 * `votes.set([...])` with every one of them still green, while voting quietly
 * becomes a contention storm.
 *
 * What catches that is where the vote LIVES, not what the tally says. A keyed
 * write puts the vote at an address every session can compute; a whole-list
 * write puts it at an address minted from the writer's own commit, which no
 * other session can name. So the first test has one session read another
 * session's vote by key alone. Under a whole-list write the tally still reads
 * right and that read finds nothing.
 *
 * The second test is the same property in the units a person feels: three
 * voters recast every option at once, three rounds of it, and no write is
 * rolled back at all. Two things make that an equality rather than a bound.
 * Each voter's vote for an option is its own document, so a burst of recasts
 * holds no document two sessions both write. And the color schedule advances
 * every voter by one color a round, which leaves each option holding one of
 * every color throughout, so the tallies the poll derives never change and
 * never contend either. What the count answers is therefore the vote write
 * alone, which is the question this file asks.
 *
 * The schedule is what makes it answer that. Casting the color already held
 * clears the vote, and clearing one changes the shared list's membership,
 * which is what the sessions' concurrent commits then get refused over. That
 * cost is membership churn, and it is the same whether the vote itself is
 * keyed or not. A burst that repeats a color pays it and measures something
 * other than what it set out to. This burst costs 0 rolled-back writes with
 * the keyed write and around 60 with a whole-list write (2026-09-02, this
 * harness).
 *
 * The poll's identity is a shared `#profile` cell. The wish resolves in this
 * harness, and in a space holding no profile it resolves to the surface that
 * offers to create one — not to an identity a session can vote with. So the
 * sessions claim identities through the `lunch-poll-keyed-votes` fixture, and
 * everything under test is the poll's own handlers, driven through the poll's
 * own streams.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const ROOT_PATH = join(import.meta.dirname!, "..");
const PROGRAM_PATH = join(
  ROOT_PATH,
  "integration",
  "fixtures",
  "lunch-poll-keyed-votes",
  "main.tsx",
);

const NAMES = ["Alice", "Bob", "Carol"] as const;
const TITLES = ["Cheeseboard", "Gregoire", "Saul's", "Fava"] as const;
const COLORS = ["green", "yellow", "red"] as const;

/**
 * The color a voter casts for an option in a given round. Consecutive rounds
 * differ for every voter and option, so no cast ever repeats the color that
 * vote already holds and no cast is read as clearing it. Every option holds
 * one of each color in every round, so the poll's tallies never change.
 */
const colorFor = (voter: number, option: number, round: number): string =>
  COLORS[(voter + option + round) % COLORS.length];

/**
 * Optimistic writes these sessions had rolled back — each one applied locally,
 * refused by the server over a stale read, and undone. This is the cost a keyed
 * write is here to avoid, counted.
 */
async function reverts(
  sessions: readonly MultiRuntimeSession[],
): Promise<number> {
  const each = await Promise.all(sessions.map(async (session) => {
    const counts = await session.loggerCounts();
    return counts["storage.v2"]?.["commit-revert"]?.total ?? 0;
  }));
  return each.reduce((sum, n) => sum + n, 0);
}

describe("lunch poll: a vote is a keyed, mergeable write", () => {
  let harness: MultiRuntimeHarness;
  let everyone: MultiRuntimeSession[];
  let host: MultiRuntimeSession;
  let options: string[];

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: NAMES.map((name) => ({ label: name.toLowerCase() })),
    });
    everyone = NAMES.map((name) => harness.session(name.toLowerCase()));
    host = everyone[0];

    // Each session claims its own profile and joins. The first to join hosts,
    // and only the host may add options.
    for (let i = 0; i < everyone.length; i++) {
      await everyone[i].send("claim", { name: NAMES[i] });
      await harness.settle();
      await everyone[i].send("joinAs", {});
      await harness.settle();
    }
    expect(await host.read(["userCount"])).toBe(NAMES.length);

    for (const title of TITLES) {
      await host.send("addOption", { title });
      await harness.settle();
    }
    options = (await host.read(["options"]) as { id: string }[])
      .map((option) => option.id);
    expect(options.length).toBe(TITLES.length);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("stores a cast vote where another session reaches it by key", async () => {
    // The whole contract in one read. Alice votes; Bob computes the address of
    // Alice's vote from her profile and the option — no list involved — and
    // finds the vote there. A vote written as part of a whole-list value lives
    // at an address minted from Alice's own commit, which Bob cannot name, so
    // this read comes back empty while the tally still says one vote.
    const [alice, bob] = everyone;
    const option = options[0];

    await alice.send("castVote", { optionId: option, voteType: "green" });
    await harness.settle();
    expect(await alice.read(["voteCount"])).toBe(1);

    await bob.send("probeVote", { voterName: "Alice", optionId: option });
    await harness.settle();
    expect(
      await bob.read(["probedVote"]),
      "another session must reach the vote by its key alone; nothing here " +
        "means the vote was stored as part of a whole-list write",
    ).toEqual({ optionId: option, voteType: "green" });

    // Clearing drops the membership AND the entity, so the address goes empty
    // rather than keeping the removed vote's content for the next reader.
    await alice.send("clearMyVote", { optionId: option });
    await harness.settle();
    await bob.send("probeVote", { voterName: "Alice", optionId: option });
    await harness.settle();
    expect(await bob.read(["probedVote"])).toBe(null);
    expect(await alice.read(["voteCount"])).toBe(0);
  });

  it("shows one session's vote to another after it settles", async () => {
    // The narrowest statement of what a torn-down poll graph costs. Bob
    // votes; Alice's session must see the tally move. A session whose piece
    // lost its instantiation and was never re-instantiated keeps serving its
    // last durable value instead, so this read stays at zero while Bob's
    // write is sitting in the store. The burst test below catches the same
    // loss, but only as a side effect of counting rollbacks.
    const [, bob] = everyone;
    const option = options[1];

    await bob.send("castVote", { optionId: option, voteType: "green" });
    await harness.settle();
    expect(
      await host.read(["voteCount"]),
      "the host's graph must observe a vote another session cast",
    ).toBe(1);

    await bob.send("clearMyVote", { optionId: option });
    await harness.settle();
    expect(await host.read(["voteCount"])).toBe(0);
  });

  it("keeps a lunch-time burst from becoming a retry storm", async () => {
    // Everyone re-votes every option at once, repeatedly — the shape of a real
    // lunch decision, where a whole-list write makes each vote wait seconds.
    // Warm up first so no session is paying for a document it has never held; a
    // cold first write conflicts either way and is not what this measures. The
    // warm-up is round zero of the same schedule, so the first measured round
    // changes every color it touches.
    for (let voter = 0; voter < everyone.length; voter++) {
      for (let option = 0; option < options.length; option++) {
        await everyone[voter].send("castVote", {
          optionId: options[option],
          voteType: colorFor(voter, option, 0),
        });
        await harness.settle();
      }
    }
    const cast = everyone.length * options.length;
    expect(await host.read(["voteCount"])).toBe(cast);

    await harness.settle();
    const before = await reverts(everyone);
    const rounds = 3;
    for (let round = 1; round <= rounds; round++) {
      await Promise.all(
        everyone.flatMap((session, voter) =>
          options.map((option, index) =>
            session.send(
              "castVote",
              { optionId: option, voteType: colorFor(voter, index, round) },
              undefined,
              { idle: false },
            )
          )
        ),
      );
      await harness.settle();
    }
    const rolledBack = await reverts(everyone) - before;

    // One vote per (voter, option) throughout: the burst recast them in place.
    expect(await host.read(["voteCount"])).toBe(cast);
    expect(
      rolledBack,
      `${rolledBack} rolled-back writes for ${cast * rounds} concurrent ` +
        "recasts; a recast writes one voter's own vote document and adds a " +
        "membership already present, so it shares no document with another " +
        "voter's recast and costs nothing to roll back. Anything here means " +
        "the vote write is contending on the whole list again",
    ).toBe(0);
  });
});
