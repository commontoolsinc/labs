import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type ExperimentalOptions,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";
import {
  type PrivateInboxRequestOutcome,
  requestPrivateInboxOf,
} from "../../src/ops/private-inbox.ts";

const identity = await Identity.fromPassphrase("private inbox request");

// A Home pattern reduced to the stream a client requests its inbox through.
// Its handler records the profile each request names and answers with a link
// to Home's `answer`, as Home answers with a link to its answer for the
// profile, so the test moves the answer by writing `answer`. The handler
// throws while `failRequest` is set.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, handler, pattern, Writable } from "commonfabric";

type Answer = { status: string };

const requestPrivateInbox = handler<
  { from?: Cell<unknown> },
  {
    answer: Writable<Answer>;
    named: Writable<{ piece?: Cell<unknown> }>;
    failRequest: Writable<boolean>;
  },
  Cell<Answer>
>((event, { answer, named, failRequest }) => {
  if (failRequest.get()) throw new Error("Home fails the request");
  named.set(event?.from === undefined ? {} : { piece: event.from });
  return answer;
});

export default pattern(() => {
  const answer = new Writable<Answer>({ status: "pending" }).for("answer");
  const named = new Writable<{ piece?: Cell<unknown> }>({}).for("named");
  const failRequest = new Writable(false).for("failRequest");
  return {
    answer,
    named,
    failRequest,
    requestPrivateInbox: requestPrivateInbox({ answer, named, failRequest }),
  };
});`,
  }],
};

/** The space and id a link names, which is what makes two links one. */
function addressOf(cell: Cell<unknown>): { space: string; id: string } {
  const { space, id } = cell.getAsNormalizedFullLink();
  return { space, id };
}

describe("requestPrivateInboxOf()", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let home: Cell<unknown>;

  /**
   * Opens a runtime with the `experimental` options given over new storage,
   * with Home installed as its space's root.
   */
  async function openRuntime(experimental: ExperimentalOptions): Promise<void> {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental,
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    home = await installCustomRoot(runtime, controller, program);
  }

  /** Disposes of what {@link openRuntime} opened. */
  async function closeRuntime(): Promise<void> {
    await controller.dispose();
    await storage.close();
  }

  beforeEach(() => openRuntime({ serverExecution: false }));

  afterEach(() => closeRuntime());

  /** A document in `space` holding `value`. */
  async function documentIn(
    space: MemorySpace,
    value: unknown,
  ): Promise<Cell<unknown>> {
    const cell = runtime.getCell<unknown>(space, crypto.randomUUID());
    await runtime.editWithRetry((tx) => cell.withTx(tx).set(value as never));
    return cell;
  }

  /** Writes `value` into Home's field `key`. */
  async function setHome(key: string, value: unknown): Promise<void> {
    await runtime.editWithRetry((tx) =>
      home.withTx(tx).key(key as never).set(value as never)
    );
  }

  /**
   * Starts a request naming `profile`, and records in the returned `settled`
   * whether it has settled, so a case can tell a request still waiting from
   * one that answered.
   */
  function startRequest(profile: Cell<unknown>, signal?: AbortSignal): {
    outcome: Promise<PrivateInboxRequestOutcome>;
    settled: () => boolean;
  } {
    let settled = false;
    const outcome = requestPrivateInboxOf(runtime, home, profile, signal);
    outcome.then(() => settled = true, () => settled = true);
    return { outcome, settled: () => settled };
  }

  it("returns `unavailable` for a Home without the stream, sending nothing", async () => {
    const bare = await documentIn(identity.did(), {});
    const profile = await documentIn(identity.did(), {});

    expect(await requestPrivateInboxOf(runtime, bare, profile)).toEqual({
      status: "unavailable",
    });
    expect(await bare.pull()).toEqual({});
  });

  it("sends Home the profile the request names", async () => {
    const profile = await documentIn(identity.did(), {});
    await setHome("answer", { status: "unlisted" });

    await requestPrivateInboxOf(runtime, home, profile);

    const named = await home.key("named" as never).asSchema({
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    }).pull() as { piece?: Cell<unknown> } | undefined;
    expect(named?.piece === undefined ? undefined : addressOf(named.piece))
      .toEqual(addressOf(profile));
  });

  it("waits while Home's answer is `pending`, and returns the inbox the profile points at once it is `ensured`", async () => {
    const inbox = await documentIn(identity.did(), { name: "inbox" });
    const profile = await documentIn(identity.did(), {
      inbox: { piece: inbox },
    });

    const request = startRequest(profile);
    await runtime.idle();

    expect(request.settled()).toBe(false);
    await setHome("answer", { status: "ensured" });
    const outcome = await request.outcome;
    expect(outcome.status).toBe("ensured");
    expect("inbox" in outcome ? addressOf(outcome.inbox) : undefined)
      .toEqual(addressOf(inbox));
  });

  it("waits, once Home's answer is `ensured`, for the profile's pointer to name an inbox", async () => {
    const inbox = await documentIn(identity.did(), { name: "inbox" });
    const profile = await documentIn(identity.did(), {});
    await setHome("answer", { status: "ensured" });

    const request = startRequest(profile);
    await runtime.idle();

    expect(request.settled()).toBe(false);
    await runtime.editWithRetry((tx) =>
      profile.withTx(tx).set({ inbox: { piece: inbox } } as never)
    );
    const outcome = await request.outcome;
    expect("inbox" in outcome ? addressOf(outcome.inbox) : undefined)
      .toEqual(addressOf(inbox));
  });

  it("returns `unlisted`, `unpointable` and `not-held` as Home answers them", async () => {
    const profile = await documentIn(identity.did(), {});

    for (const status of ["unlisted", "unpointable", "not-held"]) {
      await setHome("answer", { status });
      expect(await requestPrivateInboxOf(runtime, home, profile)).toEqual({
        status,
      });
    }
  });

  it("returns `abandoned` once the signal aborts while Home's answer is `pending`", async () => {
    const profile = await documentIn(identity.did(), {});
    const controller = new AbortController();

    const request = startRequest(profile, controller.signal);
    await runtime.scheduler.idleWithPendingCommits();
    expect(request.settled()).toBe(false);
    controller.abort();

    expect(await request.outcome).toEqual({ status: "abandoned" });
  });

  it("returns `abandoned`, sending nothing, when the signal has already aborted", async () => {
    const profile = await documentIn(identity.did(), {});
    const controller = new AbortController();
    controller.abort();

    expect(
      await requestPrivateInboxOf(runtime, home, profile, controller.signal),
    ).toEqual({ status: "abandoned" });
    await runtime.idle();
    expect(await home.key("named" as never).pull()).toEqual({});
  });

  it("returns `abandoned` once the signal aborts while Home has yet to handle the request, which Home still handles", async () => {
    const profile = await documentIn(identity.did(), {});
    const controller = new AbortController();
    const named = home.key("named" as never).asSchema({
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    });

    const request = requestPrivateInboxOf(
      runtime,
      home,
      profile,
      controller.signal,
    );
    controller.abort();

    expect(await request).toEqual({ status: "abandoned" });
    expect((named.get() as { piece?: unknown } | undefined)?.piece)
      .toBeUndefined();
    await runtime.idle();
    const handled = await named.pull() as { piece?: Cell<unknown> };
    expect(handled.piece === undefined ? undefined : addressOf(handled.piece))
      .toEqual(addressOf(profile));
  });

  it("rejects when Home's handling of the request fails", async () => {
    const profile = await documentIn(identity.did(), {});
    await setHome("failRequest", true);

    await expect(requestPrivateInboxOf(runtime, home, profile)).rejects
      .toThrow();
  });

  it("rejects when Home's handling of the request writes no receipt", async () => {
    // A runtime without commit preconditions writes no handling receipt, and
    // so hands a sender none to read Home's answer from.

    await closeRuntime();
    await openRuntime({ serverExecution: false, commitPreconditions: false });
    const profile = await documentIn(identity.did(), {});

    await expect(requestPrivateInboxOf(runtime, home, profile)).rejects
      .toThrow("wrote no receipt");
  });

  it("rejects when Home answers with a status it does not know", async () => {
    const profile = await documentIn(identity.did(), {});
    await setHome("answer", { status: "postponed" });

    await expect(requestPrivateInboxOf(runtime, home, profile)).rejects
      .toThrow("postponed");
  });
});
