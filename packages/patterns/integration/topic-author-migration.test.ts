/**
 * Runs the Topic source against isolated in-process storage to check durable
 * migration, linked comment identity, and incomplete-input recovery.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { fabricAwareEqual } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { getPatternIdentityRef, Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const PATTERN_PATH = fromFileUrl(
  new URL("../topics/topic.tsx", import.meta.url),
);
const ROOT_PATH = fromFileUrl(new URL("..", import.meta.url));
const signer = await Identity.fromPassphrase("topic author migration fixture");
const space = signer.did();

describe("topic-author-migration", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let errors: string[];

  /** Opens a fresh client replica against this test's durable storage. */
  const open = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { lazyMaterialization: true, serverExecution: false },
      errorHandlers: [(error) => errors.push(String(error))],
    });

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    errors = [];
    runtime = open();
  });
  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /** Seeds storage, then starts the actual Topic source over those inputs. */
  const start = async (input: Record<string, unknown>) => {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: PATTERN_PATH, root: ROOT_PATH },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const argument = runtime.getCell<Record<string, unknown>>(
      space,
      "argument",
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "result",
      compiled.resultSchema,
    );
    const seed = runtime.edit();
    argument.withTx(seed).set(input);
    expect((await seed.commit()).error).toBeUndefined();
    const originalComments = argument.key("comments").getRaw({
      lastNode: "value",
    });
    const tx = runtime.edit();
    runtime.run(tx, compiled, argument, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    return { argument, result, originalComments };
  };

  it("upgrades version zero to the current version without any result read", async () => {
    const { argument } = await start({
      createdByName: "Creator",
      comments: [{ authorName: "Commenter", body: "First", sentAt: 1 }],
    });
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(argument.key("topicStateVersion").getRaw()).toBe(1);
    expect(argument.key("createdBy").getRaw({ lastNode: "value" })).toEqual({
      name: "Creator",
      kind: "legacy",
    });
    expect(
      argument.key("comments").key(0).key("author").getRaw({
        lastNode: "value",
      }),
    ).toEqual({ name: "Commenter", kind: "legacy" });
    expect(errors).toEqual([]);
  });

  for (
    const comments of [[], [{
      authorName: "Commenter",
      body: "First",
      sentAt: 1,
    }]]
  ) {
    it(`upgrades without a stored creator name and with ${comments.length} comments`, async () => {
      const { argument } = await start({ comments });
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(argument.key("topicStateVersion").getRaw()).toBe(1);
      expect(argument.key("createdBy").getRaw()).toBeUndefined();
      expect(argument.key("createdByName").getRaw()).toBeUndefined();
      if (comments.length) {
        expect(
          argument.key("comments").key(0).key("author").getRaw({
            lastNode: "value",
          }),
        ).toEqual({ name: "Commenter", kind: "legacy" });
      }
      expect(errors).toEqual([]);
    });
  }

  for (const placeholder of ["someone", "  someone  "]) {
    it(`keeps the legacy placeholder ${JSON.stringify(placeholder)} unattributed`, async () => {
      const { argument } = await start({
        createdByName: placeholder,
        comments: [{ authorName: placeholder, body: "First", sentAt: 1 }],
      });
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(argument.key("topicStateVersion").getRaw()).toBe(1);
      expect(argument.key("createdBy").getRaw()).toBeUndefined();
      expect(argument.key("comments").key(0).key("author").getRaw())
        .toBeUndefined();
      expect(argument.key("createdByName").getRaw()).toBe(placeholder);
      expect(argument.key("comments").key(0).key("authorName").getRaw()).toBe(
        placeholder,
      );
      expect(errors).toEqual([]);
    });
  }

  it("preserves comment links and completion after reopening from stored source", async () => {
    const { argument, result, originalComments } = await start({
      createdByName: "Fable",
      comments: [
        { authorName: "Fable", body: "First", sentAt: 1, extra: "keep" },
        { authorName: "Gideon", body: "Reply", sentAt: 2 },
      ],
    });
    expect(await result.key("createdBy").pull()).toEqual({
      kind: "legacy",
      name: "Fable",
    });
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(argument.key("topicStateVersion").getRaw()).toBe(1);
    expect(fabricAwareEqual(
      argument.key("comments").getRaw({ lastNode: "value" }),
      originalComments,
    )).toBe(true);
    expect(argument.key("comments").key(0).key("extra").getRaw()).toBe("keep");
    expect(argument.key("comments").key(0).key("authorName").getRaw()).toBe(
      "Fable",
    );
    expect(
      argument.key("comments").key(1).key("author").getRaw({
        lastNode: "value",
      }),
    ).toEqual({ name: "Gideon", kind: "legacy" });
    const identity = getPatternIdentityRef(result);
    expect(identity).toBeDefined();
    if (!identity) throw new Error("Topic has no retained source identity.");

    const edit = runtime.edit();
    argument.withTx(edit).key("createdByName").set("Changed legacy name");
    expect((await edit.commit()).error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.dispose();
    runtime = open();

    const loaded = await runtime.patternManager.loadPatternByIdentity(
      identity.identity,
      identity.symbol,
      space,
      { repairCache: false },
    );
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("Stored Topic source did not load.");
    const reopenedArgument = runtime.getCell<Record<string, unknown>>(
      space,
      "argument",
    );
    const reopenedResult = runtime.getCell<Record<string, unknown>>(
      space,
      "result",
      loaded.resultSchema,
    );
    await reopenedArgument.sync();
    await reopenedResult.sync();
    const tx = runtime.edit();
    runtime.run(tx, loaded, reopenedArgument, reopenedResult);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    expect(await reopenedResult.key("createdBy").pull()).toEqual({
      kind: "legacy",
      name: "Fable",
    });
    expect(reopenedArgument.key("createdByName").getRaw()).toBe(
      "Changed legacy name",
    );
    expect(reopenedArgument.key("topicStateVersion").getRaw()).toBe(1);
    expect(errors).toEqual([]);
  });

  it("leaves completion and author fields untouched until a linked comment arrives", async () => {
    const pending = runtime.getCell<Record<string, unknown>>(
      space,
      "pending-comment",
    );
    const { argument, result } = await start({
      createdByName: "Creator",
      topicStateVersion: 0,
      comments: [
        { authorName: "First author", body: "First", sentAt: 1 },
        pending,
      ],
    });
    const cancel = result.key("createdBy").sink(() => {});
    try {
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(argument.key("topicStateVersion").getRaw()).toBe(0);
      expect(argument.key("createdBy").getRaw()).toBeUndefined();
      expect(argument.key("comments").key(0).key("author").getRaw())
        .toBeUndefined();

      const arrival = runtime.edit();
      pending.withTx(arrival).set({
        authorName: "Delayed author",
        body: "Arrived",
        sentAt: 2,
      });
      expect((await arrival.commit()).error).toBeUndefined();
      expect(await result.key("createdBy").pull()).toEqual({
        name: "Creator",
        kind: "legacy",
      });
      await runtime.idle();
      await runtime.storageManager.synced();
      expect(argument.key("topicStateVersion").getRaw()).toBe(1);
      expect(pending.key("author").getRaw({ lastNode: "value" })).toEqual({
        name: "Delayed author",
        kind: "legacy",
      });
      expect(errors).toEqual([]);
    } finally {
      cancel();
    }
  });

  it("preserves non-string legacy values without manufacturing authors", async () => {
    const names = [42, false, null, ["not a name"], {
      displayName: "not a name",
    }];
    const { argument, result, originalComments } = await start({
      createdByName: { displayName: "not a creator name" },
      comments: names.map((authorName, index) => ({
        authorName,
        body: "No usable name",
        sentAt: index,
      })),
    });
    expect(await result.key("createdBy").pull()).toEqual({
      name: "",
      kind: "person",
    });
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(argument.key("topicStateVersion").getRaw()).toBe(1);
    expect(argument.key("createdBy").getRaw()).toBeUndefined();
    expect(argument.key("createdByName").getRaw()).toEqual({
      displayName: "not a creator name",
    });
    expect(fabricAwareEqual(
      argument.key("comments").getRaw({ lastNode: "value" }),
      originalComments,
    )).toBe(true);
    for (const [index, name] of names.entries()) {
      const comment = argument.key("comments").key(index);
      expect(comment.key("author").getRaw()).toBeUndefined();
      expect(comment.key("authorName").getRaw()).toEqual(name);
    }
    expect(errors).toEqual([]);
  });

  for (const field of ["creator", "comment"] as const) {
    it(`waits for a linked ${field} name before completing any author writes`, async () => {
      const pendingName = runtime.getCell<string>(space, "pending-name");
      const { argument, result } = await start({
        createdByName: field === "creator" ? pendingName : "Creator",
        topicStateVersion: 0,
        comments: [
          { authorName: "First author", body: "First", sentAt: 1 },
          {
            authorName: field === "comment" ? pendingName : "Second author",
            body: "Second",
            sentAt: 2,
          },
        ],
      });
      const cancel = result.key("createdBy").sink(() => {});
      try {
        await runtime.idle();
        await runtime.storageManager.synced();
        expect(argument.key("topicStateVersion").getRaw()).toBe(0);
        expect(argument.key("createdBy").getRaw()).toBeUndefined();
        expect(argument.key("comments").key(0).key("author").getRaw())
          .toBeUndefined();

        const arrival = runtime.edit();
        pendingName.withTx(arrival).set("  Delayed name  ");
        expect((await arrival.commit()).error).toBeUndefined();
        expect(await result.key("createdBy").pull()).toEqual({
          name: field === "creator" ? "  Delayed name  " : "Creator",
          kind: "legacy",
        });
        await runtime.idle();
        await runtime.storageManager.synced();
        expect(argument.key("topicStateVersion").getRaw()).toBe(1);
        expect(
          argument.key("comments").key(1).key("author").getRaw({
            lastNode: "value",
          }),
        ).toEqual({
          name: field === "comment" ? "  Delayed name  " : "Second author",
          kind: "legacy",
        });
        expect(pendingName.getRaw()).toBe("  Delayed name  ");
        expect(errors).toEqual([]);
      } finally {
        cancel();
      }
    });
  }
});
