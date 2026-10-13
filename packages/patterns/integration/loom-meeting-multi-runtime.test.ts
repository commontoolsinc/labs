/** Competing meeting bindings converge through the real Loom handler. */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import { parseLinkOrThrow } from "@commonfabric/runner";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

/** Reads a reply cell from the session's synced storage. */
async function replyValue(session: MultiRuntimeSession, reply: FabricValue) {
  const link = parseLinkOrThrow(reply);
  await session.client().call("readAddress", { link: reply });
  return ((await session.rawRead({ id: link.id!, space: link.space! }))
    .value as {
      value?: unknown;
    })?.value;
}

describe("loom meeting across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("keeps the first admitted key when two sessions bind different meetings", async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: join(import.meta.dirname!, "..", "loom", "main.tsx"),
      rootPath: join(import.meta.dirname!, ".."),
      sessions: ["alice", "bob"],
      watchPaths: [["meeting"]],
      aclMode: "enforce",
    });
    const alice = harness.session("alice");
    const bob = harness.session("bob");
    const aliceReply = await alice.createCell("alice meeting reply", {});
    const bobReply = await bob.createCell("bob meeting reply", {});
    await harness.settle();
    expect(await alice.read(["meeting"])).toEqual({});
    expect(await bob.read(["meeting"])).toEqual({});

    await Promise.all([
      alice.send("bindMeeting", { key: KEY, reply: aliceReply }, undefined, {
        idle: false,
      }),
      bob.send("bindMeeting", { key: OTHER, reply: bobReply }, undefined, {
        idle: false,
      }),
    ]);
    await harness.settle();

    const winner = await alice.read(["meeting", "key"]);
    expect([KEY, OTHER]).toContain(winner);
    expect(await bob.read(["meeting", "key"])).toBe(winner);
    expect(await replyValue(alice, aliceReply))
      .toEqual({ status: winner === KEY ? "bound" : "conflict", key: winner });
    expect(await replyValue(bob, bobReply))
      .toEqual({
        status: winner === OTHER ? "bound" : "conflict",
        key: winner,
      });

    await alice.send("bindMeeting", { key: winner, reply: aliceReply });
    await bob.send("bindMeeting", { key: winner === KEY ? OTHER : KEY });
    await harness.settle();
    expect(await replyValue(alice, aliceReply))
      .toEqual({ status: "already-bound", key: winner });
    expect(await alice.read(["meeting", "key"])).toBe(winner);
    expect(await bob.read(["meeting", "key"])).toBe(winner);
  });
});
