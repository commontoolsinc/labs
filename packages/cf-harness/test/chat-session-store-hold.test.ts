/**
 * One service process holds a SQLite chat session store for as long as it
 * runs. A second process pointed at the same database is refused rather than
 * recovered over, so the turns the first is still running are never marked
 * interrupted from outside; a store whose holder has exited is taken over and
 * recovered exactly as an unheld one is.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createHarnessChatSessionStatus } from "../src/contracts/interactive-chat.ts";
import {
  HarnessChatStoreHeldError,
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { HarnessChatStoreHolder } from "../src/session-store.ts";
import {
  openSqliteHarnessChatSessionStore,
  type SqliteHarnessChatSessionStore,
  sqliteHarnessChatSessionStoreHolderPath,
} from "../src/sqlite-session-store.ts";

const makeResult = (
  options: RunHarnessTranscriptOptions,
  finalAssistantText: string,
): HarnessPromptLoopResult => ({
  model: options.model ?? "gpt-test",
  finalAssistantText,
  transcript: [
    ...options.transcript,
    { role: "assistant", content: finalAssistantText },
  ],
  modelTurns: 1,
  runState: {} as HarnessPromptLoopResult["runState"],
});

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-09-15T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

const completingPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
});

const noPromptLoop: HarnessInteractivePromptLoopFactory = () => {
  throw new Error("this service runs no model");
};

/**
 * A prompt loop that reports when a turn reaches it and completes the turn
 * only when the test says so, which is how a turn is held in `running` for
 * as long as a case needs without a timer.
 */
const suspendedPromptLoop = () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<string>();
  return {
    createPromptLoop: () => ({
      runTranscript: (options: RunHarnessTranscriptOptions) => {
        entered.resolve();
        return released.promise.then((text) => makeResult(options, text));
      },
    }),
    entered: entered.promise,
    release: (finalAssistantText: string) =>
      released.resolve(finalAssistantText),
  };
};

const withDatabaseUrl = async (
  run: (url: URL) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await run(toFileUrl(join(dir, "chat.sqlite")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const readHolderFile = async (url: URL): Promise<unknown> =>
  JSON.parse(
    await Deno.readTextFile(
      await sqliteHarnessChatSessionStoreHolderPath(url),
    ),
  );

const holder = (instanceId: string): HarnessChatStoreHolder => ({
  instanceId,
  pid: Deno.pid,
  heldSince: "2026-09-15T00:00:00.000Z",
});

/** Records a session in the store with `turnId` still running in it. */
const saveRunningTurn = (
  store: SqliteHarnessChatSessionStore,
  sessionId: string,
  turnId: string,
): void => {
  const turn = {
    turnId,
    status: "running" as const,
    startedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  const session = {
    ...createHarnessChatSessionStatus({
      sessionId,
      createdAt: "2026-09-15T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    }),
    status: "turn_running" as const,
    activeTurnId: turnId,
    activeTurn: turn,
  };
  store.saveSession({ session, transcript: [] });
  store.saveTurn({
    sessionId,
    turn,
    input: { text: "Still working" },
    policy: session.policy,
  });
};

/** Reads `stream` up to its first newline and returns that line. */
const readFirstLine = async (
  stream: ReadableStream<Uint8Array>,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n")[0];
};

/**
 * Starts a process that holds the store at `url` as `instanceId`, and
 * returns once it reports the hold; `kill()` ends it without a chance to
 * close anything.
 */
const spawnHolder = async (
  url: URL,
  instanceId: string,
): Promise<{ pid: number; kill: () => Promise<void> }> => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      fromFileUrl(
        new URL("./support/hold-chat-session-store.ts", import.meta.url),
      ),
      fromFileUrl(url),
      instanceId,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  expect(JSON.parse(await readFirstLine(child.stdout))).toEqual({
    held: true,
  });
  return {
    pid: child.pid,
    kill: async () => {
      child.kill("SIGKILL");
      const status = await child.status;
      expect(status.signal).toBe("SIGKILL");
      await child.stdin.close();
      await child.stdout.cancel();
    },
  };
};

const withLiveService = async (
  url: URL,
  run: (
    live: HarnessInteractiveChatService,
    stores: {
      first: SqliteHarnessChatSessionStore;
      second: SqliteHarnessChatSessionStore;
    },
    loop: ReturnType<typeof suspendedPromptLoop>,
  ) => Promise<void>,
): Promise<void> => {
  const first = await openSqliteHarnessChatSessionStore({ url });
  const second = await openSqliteHarnessChatSessionStore({ url });
  const loop = suspendedPromptLoop();
  const live = new HarnessInteractiveChatService({
    createPromptLoop: loop.createPromptLoop,
    now: nextIsoNow(),
    randomUUID: () => "instance-live",
    sessionStore: first,
  });
  try {
    await live.initializeFromStore();
    const session = await live.startSession("req-session", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
    });
    expect(session.ok).toBe(true);
    const turn = await live.startTurn("req-turn", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Keep working" },
    });
    expect(turn.ok).toBe(true);
    await loop.entered;
    expect(second.getTurn("session-1", "turn-1")?.turn.status).toBe(
      "running",
    );
    await run(live, { first, second }, loop);
  } finally {
    second.close();
    first.close();
  }
};

describe("chat session store hold", () => {
  describe("HarnessInteractiveChatService.initializeFromStore()", () => {
    it("leaves the turn another live service is running as `running` in the store", async () => {
      await withDatabaseUrl(async (url) => {
        await withLiveService(url, async (live, { second }, loop) => {
          const late = new HarnessInteractiveChatService({
            createPromptLoop: noPromptLoop,
            now: nextIsoNow(),
            sessionStore: second,
          });

          // Whether the second service is refused is the next case's subject;
          // here only what its initialization does to the store matters.
          await late.initializeFromStore().catch(() => undefined);

          expect(second.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );
          loop.release("Done.");
          await live.waitForTurn("session-1", "turn-1");
          expect(second.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "completed",
          );
        });
      });
    });

    it("rejects with `HarnessChatStoreHeldError` naming the live holder", async () => {
      await withDatabaseUrl(async (url) => {
        await withLiveService(url, async (_live, { second }) => {
          const late = new HarnessInteractiveChatService({
            createPromptLoop: noPromptLoop,
            now: nextIsoNow(),
            sessionStore: second,
          });

          const refusal = await late.initializeFromStore().then(
            () => undefined,
            (error: unknown) => error,
          );

          expect(refusal).toBeInstanceOf(HarnessChatStoreHeldError);
          const holder: HarnessChatStoreHolder = {
            instanceId: "instance-live",
            pid: Deno.pid,
            heldSince: "2026-09-15T00:00:01.000Z",
          };
          expect((refusal as HarnessChatStoreHeldError).holder).toEqual(holder);
          expect((refusal as HarnessChatStoreHeldError).message).toBe(
            `cf-harness chat session store is held by another live service process: instance instance-live, pid ${Deno.pid}, since 2026-09-15T00:00:01.000Z`,
          );
          expect(late.status().sessions).toEqual([]);
        });
      });
    });

    it("commits nothing to a held store before refusing", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({ url });
        try {
          saveRunningTurn(first, "session-1", "turn-1");
          expect(await first.hold(holder("instance-1"))).toEqual({
            held: true,
          });
          // `PRAGMA data_version` moves on this connection once any other
          // connection commits, which is what a second opener's pragmas,
          // schema statements, or recovery would do.
          const dataVersion = () =>
            (first.database.prepare("PRAGMA data_version").get() as {
              data_version: number;
            }).data_version;
          const before = dataVersion();

          const second = await openSqliteHarnessChatSessionStore({ url });
          try {
            const late = new HarnessInteractiveChatService({
              createPromptLoop: noPromptLoop,
              now: nextIsoNow(),
              sessionStore: second,
            });
            await expect(late.initializeFromStore()).rejects.toThrow(
              HarnessChatStoreHeldError,
            );

            expect(dataVersion()).toBe(before);
            expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
              "running",
            );
            expect(await readHolderFile(url)).toEqual(holder("instance-1"));

            // A commit from that connection is what the check above rules
            // out; this one shows the check can see one.
            second.saveSession({
              session: createHarnessChatSessionStatus({
                sessionId: "session-2",
                createdAt: "2026-09-15T00:00:00.000Z",
                workspace: { hostPath: "/workspace" },
              }),
              transcript: [],
            });
            expect(dataVersion()).not.toBe(before);
          } finally {
            second.close();
          }
        } finally {
          first.close();
        }
      });
    });

    it("takes over a store whose holder has died and settles the turn it left running", async () => {
      await withDatabaseUrl(async (url) => {
        const store = await openSqliteHarnessChatSessionStore({ url });
        try {
          saveRunningTurn(store, "session-1", "turn-1");
          const holder = await spawnHolder(url, "instance-died");
          expect(await readHolderFile(url)).toEqual({
            instanceId: "instance-died",
            pid: holder.pid,
            heldSince: expect.any(String),
          });
          await holder.kill();

          const service = new HarnessInteractiveChatService({
            createPromptLoop: noPromptLoop,
            now: nextIsoNow(),
            randomUUID: () => "instance-next",
            sessionStore: store,
          });
          await service.initializeFromStore();

          const turn = store.getTurn("session-1", "turn-1");
          expect(turn?.turn.status).toBe("failed");
          expect(turn?.turn.error?.details).toEqual({
            terminalReason: "process_interrupted",
            priorStatus: "running",
          });
          expect(await readHolderFile(url)).toEqual({
            instanceId: "instance-next",
            pid: Deno.pid,
            heldSince: "2026-09-15T00:00:01.000Z",
          });
        } finally {
          store.close();
        }
      });
    });

    it("settles the running turn of a store no process holds", async () => {
      await withDatabaseUrl(async (url) => {
        const store = await openSqliteHarnessChatSessionStore({ url });
        try {
          saveRunningTurn(store, "session-1", "turn-1");
          const service = new HarnessInteractiveChatService({
            createPromptLoop: noPromptLoop,
            now: nextIsoNow(),
            randomUUID: () => "instance-next",
            sessionStore: store,
          });
          await service.initializeFromStore();

          const turn = store.getTurn("session-1", "turn-1");
          expect(turn?.turn.status).toBe("failed");
          expect(turn?.turn.error?.details).toEqual({
            terminalReason: "process_interrupted",
            priorStatus: "running",
          });
          expect(service.status("session-1").sessions[0].activeTurnId)
            .toBeUndefined();
          expect(
            service.listEvents({ sessionId: "session-1" }).events.map((
              event,
            ) => event.event.kind),
          ).toEqual(["turn_failed"]);
          expect(await readHolderFile(url)).toEqual({
            instanceId: "instance-next",
            pid: Deno.pid,
            heldSince: "2026-09-15T00:00:01.000Z",
          });
        } finally {
          store.close();
        }
      });
    });

    it("runs its own turns after taking a store, and keeps it across its own reinitialization", async () => {
      await withDatabaseUrl(async (url) => {
        const store = await openSqliteHarnessChatSessionStore({ url });
        try {
          saveRunningTurn(store, "session-1", "turn-1");
          const service = new HarnessInteractiveChatService({
            createPromptLoop: completingPromptLoop,
            now: nextIsoNow(),
            sessionStore: store,
          });
          await service.initializeFromStore();

          const session = await service.startSession("req-session", {
            sessionId: "session-2",
            workspace: { hostPath: "/workspace" },
          });
          expect(session.ok).toBe(true);
          const turn = await service.startTurn("req-turn", {
            sessionId: "session-2",
            turnId: "turn-2",
            input: { text: "Carry on" },
          });
          expect(turn.ok).toBe(true);
          await service.waitForTurn("session-2", "turn-2");
          expect(store.getTurn("session-2", "turn-2")?.turn.status).toBe(
            "completed",
          );

          await service.initializeFromStore();

          expect(store.getTurn("session-2", "turn-2")?.turn.status).toBe(
            "completed",
          );
          expect(store.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "failed",
          );
        } finally {
          store.close();
        }
      });
    });
  });

  describe("SqliteHarnessChatSessionStore.hold()", () => {
    it("takes an unheld store and writes the holder beside the database", async () => {
      await withDatabaseUrl(async (url) => {
        const store = await openSqliteHarnessChatSessionStore({ url });
        try {
          expect(await store.hold(holder("instance-1"))).toEqual({
            held: true,
          });
          expect(await readHolderFile(url)).toEqual(holder("instance-1"));
        } finally {
          store.close();
        }
      });
    });

    it("returns the holder for a store another handle holds", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({ url });
        const second = await openSqliteHarnessChatSessionStore({ url });
        try {
          expect(await first.hold(holder("instance-1"))).toEqual({
            held: true,
          });
          expect(await second.hold(holder("instance-2"))).toEqual({
            held: false,
            holder: holder("instance-1"),
          });
          expect(await readHolderFile(url)).toEqual(holder("instance-1"));
        } finally {
          second.close();
          first.close();
        }
      });
    });

    it("returns the holder for a store held under another spelling of its path", async () => {
      // The link is on the database file itself, so a hold file placed beside
      // each spelling would be two different files.
      const dir = await Deno.makeTempDir();
      try {
        const first = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(dir, "real.sqlite")),
        });
        await Deno.symlink(join(dir, "real.sqlite"), join(dir, "alias.sqlite"));
        const second = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(dir, "alias.sqlite")),
        });
        try {
          expect(await first.hold(holder("instance-1"))).toEqual({
            held: true,
          });
          expect(await second.hold(holder("instance-2"))).toEqual({
            held: false,
            holder: holder("instance-1"),
          });
        } finally {
          second.close();
          first.close();
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns no holder where the record beside a held store is not one", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({ url });
        const second = await openSqliteHarnessChatSessionStore({ url });
        try {
          expect(await first.hold(holder("instance-1"))).toEqual({
            held: true,
          });
          await Deno.writeTextFile(
            await sqliteHarnessChatSessionStoreHolderPath(url),
            "{",
          );
          expect(await second.hold(holder("instance-2"))).toEqual({
            held: false,
            holder: undefined,
          });
        } finally {
          second.close();
          first.close();
        }
      });
    });

    it("takes a store once the handle holding it has closed", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({ url });
        const second = await openSqliteHarnessChatSessionStore({ url });
        try {
          expect(await first.hold(holder("instance-1"))).toEqual({
            held: true,
          });
          first.close();
          expect(await second.hold(holder("instance-2"))).toEqual({
            held: true,
          });
          expect(await readHolderFile(url)).toEqual(holder("instance-2"));
        } finally {
          second.close();
        }
      });
    });
  });
});
