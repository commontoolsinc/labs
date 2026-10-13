import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
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
// Its handler records the profile each request names and answers with a
// pattern over `stage` and `held`, as Home answers with one over its holder
// and the profile's pointer, so the test moves the answer by writing `stage`.
// The handler throws while `failRequest` is set.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, computed, handler, pattern, Writable } from "commonfabric";

type Pointer = { piece?: Cell<{ name?: string }> };

type Answer = { status: string; inbox?: Cell<{ name?: string }> };

const Answerer = pattern<{ stage: string; held: Pointer }, Answer>(
  ({ stage, held }) => {
    const answer = computed((): Answer =>
      stage === "ensured" ? { status: stage, inbox: held?.piece } : { status: stage }
    );
    return { status: answer.status, inbox: answer.inbox };
  },
);

const requestPrivateInbox = handler<
  { from?: Cell<unknown> },
  {
    stage: Writable<string>;
    held: Writable<Pointer>;
    named: Writable<{ piece?: Cell<unknown> }>;
    failRequest: Writable<boolean>;
  },
  Answer
>((event, { stage, held, named, failRequest }) => {
  if (failRequest.get()) throw new Error("Home fails the request");
  named.set(event?.from === undefined ? {} : { piece: event.from });
  return Answerer({ stage, held });
});

export default pattern(() => {
  const stage = new Writable("pending").for("stage");
  const held = new Writable<Pointer>({}).for("held");
  const named = new Writable<{ piece?: Cell<unknown> }>({}).for("named");
  const failRequest = new Writable(false).for("failRequest");
  return {
    stage,
    held,
    named,
    failRequest,
    requestPrivateInbox: requestPrivateInbox({
      stage,
      held,
      named,
      failRequest,
    }),
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

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    home = await installCustomRoot(runtime, controller, program);
  });

  afterEach(async () => {
    await controller.dispose();
    await storage.close();
  });

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
    await setHome("stage", "unlisted");

    await requestPrivateInboxOf(runtime, home, profile);

    const named = await home.key("named" as never).asSchema({
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    }).pull() as { piece?: Cell<unknown> } | undefined;
    expect(named?.piece === undefined ? undefined : addressOf(named.piece))
      .toEqual(addressOf(profile));
  });

  it("waits while Home's answer is `pending`, and returns the inbox once it is `ensured`", async () => {
    const profile = await documentIn(identity.did(), {});
    const inbox = await documentIn(identity.did(), { name: "inbox" });
    await setHome("held", { piece: inbox });

    const request = startRequest(profile);
    await runtime.idle();

    expect(request.settled()).toBe(false);
    await setHome("stage", "ensured");
    const outcome = await request.outcome;
    expect(outcome.status).toBe("ensured");
    expect("inbox" in outcome ? addressOf(outcome.inbox) : undefined)
      .toEqual(addressOf(inbox));
  });

  it("returns `unlisted` and `not-held` as Home answers them", async () => {
    const profile = await documentIn(identity.did(), {});

    await setHome("stage", "unlisted");
    expect(await requestPrivateInboxOf(runtime, home, profile)).toEqual({
      status: "unlisted",
    });
    await setHome("stage", "not-held");
    expect(await requestPrivateInboxOf(runtime, home, profile)).toEqual({
      status: "not-held",
    });
  });

  it("returns `abandoned` once the signal aborts while Home's answer is `pending`", async () => {
    const profile = await documentIn(identity.did(), {});
    const controller = new AbortController();

    const request = startRequest(profile, controller.signal);
    await runtime.idle();
    expect(request.settled()).toBe(false);
    controller.abort();

    expect(await request.outcome).toEqual({ status: "abandoned" });
  });

  it("rejects when Home's handling of the request fails", async () => {
    const profile = await documentIn(identity.did(), {});
    await setHome("failRequest", true);

    await expect(requestPrivateInboxOf(runtime, home, profile)).rejects
      .toThrow();
  });

  it("rejects when Home answers with a status it does not know", async () => {
    const profile = await documentIn(identity.did(), {});
    await setHome("stage", "postponed");

    await expect(requestPrivateInboxOf(runtime, home, profile)).rejects
      .toThrow("postponed");
  });
});
