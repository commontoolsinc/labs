import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import {
  type Cell,
  inSpaceRootCause,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { joinVisitedRoomOf } from "../../src/ops/join-visited-room.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";

const identity = await Identity.fromPassphrase("join visited room owner");

/** A principal who is not the visitor. */
const someoneElse = (await Identity.fromPassphrase("join visited room other"))
  .did();

/** The origin of the host the test's runtime is served by. */
const HOST = "https://home.example";

// A Home pattern reduced to its chat manager's `joinRoom`, which records the
// space of the room each event names, and whether it named a request.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, handler, pattern, spaceOf, Writable } from "commonfabric";

type Join = { room?: Cell<unknown>; requestId?: string };

type Joined = { space?: string; named: boolean };

const joinRoom = handler<Join, { joined: Writable<Joined[]> }>(
  (event, { joined }) => {
    joined.push({
      space: spaceOf(event.room),
      named: event.requestId !== undefined,
    });
  },
);

export default pattern(() => {
  const joined = new Writable<Joined[]>([]).for("joined");
  return { joined, chatManager: { joinRoom: joinRoom({ joined }) } };
});`,
  }],
};

/** A stand-in for a room, which a visited space's root runs. */
const roomProgram: RuntimeProgram = {
  main: "/room.tsx",
  files: [{
    name: "/room.tsx",
    contents: `
import { pattern } from "commonfabric";

export default pattern(() => ({ about: { kind: "group" } }));`,
  }],
};

/** What Home's stand-in records of each join it is sent. */
const joinedSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

describe("join-visited-room", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let home: Cell<unknown>;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    home = await installCustomRoot(runtime, controller, program);
    await runtime.idle();
  });

  afterEach(async () => {
    await controller.dispose();
    await storage.close();
  });

  /**
   * A space granting `grants`, owned by the visitor unless `owner` says
   * otherwise, which declares `spaceKind`, `fabrichat-room` by default, or no
   * kind for `null`. Its root is a room at the address its genesis commit
   * reserves, a room elsewhere in the space for `"misplaced"`, and none for
   * `false`.
   */
  async function visitedSpace(
    grants: ACL,
    { owner, root = "reserved", spaceKind = "fabrichat-room" }: {
      owner?: string;
      root?: "reserved" | "misplaced" | false;
      spaceKind?: string | null;
    } = {},
  ): Promise<MemorySpace> {
    const space = await runtime.createSpace({
      grants,
      ...(owner === undefined ? {} : { owner: owner as never }),
      root: (created) => ({ cause: inSpaceRootCause(created) }),
      ...(spaceKind === null ? {} : { spaceKind }),
    });
    if (root !== false) {
      // Disposing a controller disposes the runtime, which `afterEach` does
      // through the Home space's controller.
      const rooms = new PiecesController(
        createSession({ identity, spaceDid: space }),
        runtime,
      );
      await rooms.synced();
      await installCustomRoot(
        runtime,
        rooms,
        roomProgram,
        root === "reserved" ? { cause: inSpaceRootCause(space) } : {},
      );
    }
    return space;
  }

  /** What Home's chat manager has been sent, once its handling has settled. */
  async function joinedNow(): Promise<Record<string, unknown>[]> {
    await runtime.idle();
    return (await home.key("joined" as never).asSchema(joinedSchema)
      .pull() ?? []) as Record<string, unknown>[];
  }

  describe("joinVisitedRoomOf()", () => {
    it("sends the chat manager's `joinRoom` the room of a space the visitor owns, naming no request", async () => {
      const space = await visitedSpace({});

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("sent");
      expect(await joinedNow()).toStrictEqual([{ space, named: false }]);
    });

    it("sends the room of a space anyone may write to, as a group joinable by its link is", async () => {
      const space = await visitedSpace({ "*": "WRITE" }, {
        owner: someoneElse,
      });

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("sent");
      expect(await joinedNow()).toStrictEqual([{ space, named: false }]);
    });

    it("returns `recipient-access-refused`, sending nothing, for a space the visitor may only read", async () => {
      const space = await visitedSpace({ "*": "READ" }, {
        owner: someoneElse,
      });

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("recipient-access-refused");
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `space-kind-undeclared` for a space declaring no kind, and `space-kind-mismatch` for one declaring another", async () => {
      const undeclared = await visitedSpace({}, { spaceKind: null });
      const other = await visitedSpace({}, { spaceKind: "loom" });

      expect([
        await joinVisitedRoomOf(runtime, home, identity.did(), undeclared),
        await joinVisitedRoomOf(runtime, home, identity.did(), other),
      ]).toStrictEqual(["space-kind-undeclared", "space-kind-mismatch"]);
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `space-root-missing` for a space with no root, and `space-root-misplaced` for one whose root isn't at the reserved address", async () => {
      const missing = await visitedSpace({}, { root: false });
      const misplaced = await visitedSpace({}, { root: "misplaced" });

      expect([
        await joinVisitedRoomOf(runtime, home, identity.did(), missing),
        await joinVisitedRoomOf(runtime, home, identity.did(), misplaced),
      ]).toStrictEqual(["space-root-missing", "space-root-misplaced"]);
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `no-chat-manager`, vetting nothing, for a Home whose chat manager has no `joinRoom`", async () => {
      const space = await visitedSpace({});
      // Home, but for a `chatManager` holding no `joinRoom` stream.
      const managerless = {
        key: (name: string) =>
          name === "chatManager"
            ? { key: () => ({ getRaw: () => undefined }) }
            : home.key(name as never),
      };

      expect(
        await joinVisitedRoomOf(
          runtime,
          managerless as never,
          identity.did(),
          space,
        ),
      ).toBe("no-chat-manager");
      expect(await joinedNow()).toStrictEqual([]);
    });
  });

  describe("PiecesController.joinVisitedRoom()", () => {
    it("joins the visitor to the room through their Home's chat manager", async () => {
      const space = await visitedSpace({});

      expect(await controller.joinVisitedRoom(space)).toBe("sent");
      expect(await joinedNow()).toStrictEqual([{ space, named: false }]);
    });
  });
});
