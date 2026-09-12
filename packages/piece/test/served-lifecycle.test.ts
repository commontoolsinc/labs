// The served lifecycle verbs, end to end: a serving host over a real
// in-process memory server runs each verb on the space's serving runtime,
// and a client runtime opened afterwards reads what the verb left in the
// store. What is pinned is the store's state, never the serving runtime's
// own view of it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  getPatternIdentityRef,
  getPieceSourceRevisions,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";
import { resolveSlugTargetCell } from "../src/slugs.ts";
import {
  confirmServedInstantiate,
  servedInstantiatePiece,
  ServedLifecycleRefusal,
  type ServedPatternSource,
  servedUploadPattern,
} from "../src/ops/served-lifecycle.ts";

const spaceSigner = await Identity.fromPassphrase("served lifecycle space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "served lifecycle service",
);
const aliceSigner = await Identity.fromPassphrase("served lifecycle alice");

const TEST_AUDIENCE = "did:key:z6Mk-served-lifecycle-audience";

function programOf(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

/** One optional input, one output. */
const BASE_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: string }, { label: string }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: seed ?? 'unset',",
  "  }),",
  ");",
  "",
].join("\n"));

const BROKEN_PROGRAM = programOf(
  "import { pattern } from 'commonfabric';\nexport default pattern<{}, {}>(() => ({ label: undefinedName }));\n",
);

describe("served lifecycle verbs", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;
  let preciseReferences: boolean;

  beforeEach(async () => {
    preciseReferences = false;
    server = new MemoryV2Server.Server({
      store: new URL(`memory://served-lifecycle-${crypto.randomUUID()}`),
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
      subscriptionRefreshDelayMs: 0,
    });
    session = await createSession({
      identity: serviceSigner,
      spaceDid: space as DID,
    });
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (servedSpace) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: serviceSigner,
          servingHomeSpace: servedSpace,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          cfcFlowLabels: preciseReferences ? "persist" : "off",
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      ensureSpaceRoots: false,
    });
    cleanups = [];
  });

  afterEach(async () => {
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /** A client's view of the space, opened as alice after the verb ran. */
  const clientPieces = async (): Promise<PiecesController> => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    const pieces = new PiecesController(session, runtime, {
      deferSpaceCellSync: true,
    });
    await pieces.ready;
    return pieces;
  };

  const served = <T>(
    name: string,
    run: (pieces: PiecesController) => Promise<T>,
    confirm?: (runtime: Runtime, receipt: T) => Promise<void>,
  ): Promise<T> =>
    host.runLifecycleVerb(space, {
      name,
      run: (runtime) =>
        run(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
        ),
      ...(confirm === undefined ? {} : { confirm }),
    });

  const instantiate = (
    source: ServedPatternSource,
    argument?: object,
    naming: { slug?: string; force?: boolean; register?: boolean } = {},
  ) =>
    served(
      "instantiate",
      (pieces) =>
        servedInstantiatePiece(pieces, {
          source,
          ...(argument === undefined ? {} : { argument }),
          ...naming,
          actingUser: aliceSigner.did(),
        }),
      (runtime, receipt) => confirmServedInstantiate(runtime, space, receipt),
    );

  const refusalOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(ServedLifecycleRefusal);
      return error as ServedLifecycleRefusal;
    }
    throw new Error("expected a refusal");
  };

  describe("instantiate", () => {
    it("acquires an explicit linked argument on a precise serving runtime", async () => {
      preciseReferences = true;
      const client = await clientPieces();
      const tx = client.runtime.edit();
      const seed = client.runtime.getCell<string>(
        space,
        "served-lifecycle-linked-seed",
        undefined,
        tx,
      );
      seed.set("linked seed");
      expect((await tx.commit()).error).toBeUndefined();
      const input = fabricFromJsonValue(jsonFromFabricValue(seed.getAsLink()));
      const receipt = await instantiate({ program: BASE_PROGRAM }, {
        seed: input,
      });
      const later = await clientPieces();
      const piece = await later.get(receipt.pieceId);
      const argument = later.getArgument<{ seed: string }>(piece.getCell());
      await argument.sync();
      expect(argument.get()).toEqual({ seed: "linked seed" });
    });

    it("creates a piece a later client reads with the pattern pointer and argument the verb wrote", async () => {
      const receipt = await instantiate({ program: BASE_PROGRAM }, {
        seed: "planted",
      });
      expect(receipt.pattern.symbol).toBe("default");

      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.pattern);
      const argument = pieces.getArgument<{ seed?: string }>(piece.getCell());
      await argument.sync();
      expect(argument.get()).toEqual({ seed: "planted" });
      expect(getPieceSourceRevisions(piece.getCell())).toHaveLength(1);
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 0 });
    });

    it("takes a pattern an earlier upload left in the space", async () => {
      const { ref } = await served(
        "upload",
        (pieces) => servedUploadPattern(pieces, BASE_PROGRAM),
      );
      const receipt = await instantiate({ pattern: ref });
      expect(receipt.pattern).toEqual(ref);
      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(ref);
    });

    it("refuses a pattern the space does not hold", async () => {
      const refusal = await refusalOf(instantiate({
        pattern: { identity: "no-such-identity", symbol: "default" },
      }));
      expect(refusal.code).toBe("pattern-not-found");
    });

    it("claims the slug with the creation, refuses a taken name, and takes it under force", async () => {
      const first = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "named-piece",
      });
      expect(first.slug).toBe("named-piece");
      const pieces = await clientPieces();
      expect(pieceId(await resolveSlugTargetCell(pieces, "named-piece")))
        .toBe(first.pieceId);

      const refusal = await refusalOf(
        instantiate({ program: BASE_PROGRAM }, undefined, {
          slug: "named-piece",
        }),
      );
      expect(refusal.code).toBe("slug-taken");
      expect(refusal.message).toContain("nothing was created");

      const taken = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "named-piece",
        force: true,
      });
      // A client opened after the forced claim: the earlier one holds the
      // name's document from before it moved.
      const later = await clientPieces();
      expect(pieceId(await resolveSlugTargetCell(later, "named-piece")))
        .toBe(taken.pieceId);
    });

    it("refuses to register a piece in a space with no root", async () => {
      const refusal = await refusalOf(
        instantiate({ program: BASE_PROGRAM }, undefined, { register: true }),
      );
      expect(refusal.code).toBe("no-space-root");
    });

    it("refuses a program that does not compile, naming the failure", async () => {
      const refusal = await refusalOf(instantiate({ program: BROKEN_PROGRAM }));
      expect(refusal.code).toBe("compile-failed");
      expect(refusal.message).toContain("undefinedName");
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
    });
  });
});
