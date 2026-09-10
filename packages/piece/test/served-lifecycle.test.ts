// The served lifecycle verbs, end to end: a serving host over a real
// in-process memory server runs each verb on the space's serving runtime,
// and a client runtime opened afterwards reads what the verb left in the
// store. What is pinned is the store's state, never the serving runtime's
// own view of it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
import {
  confirmServedInstantiate,
  confirmServedSourceUpdate,
  servedCheckPieceSource,
  servedInstantiatePiece,
  ServedLifecycleRefusal,
  type ServedPatternSource,
  servedSetPieceSource,
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

/** The same contract with a different body: accepted as a replacement. */
const COMPATIBLE_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: string }, { label: string }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: `seen:${seed ?? 'unset'}`,",
  "  }),",
  ");",
  "",
].join("\n"));

/**
 * Widens the declared output, which the contract proof refuses; the stored
 * argument still satisfies it, so the dangerous override can apply it.
 */
const INCOMPATIBLE_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: string }, { label: string | number }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: seed === undefined ? 0 : seed,",
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

  beforeEach(async () => {
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
  ) =>
    served(
      "instantiate",
      (pieces) =>
        servedInstantiatePiece(pieces, {
          source,
          ...(argument === undefined ? {} : { argument }),
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

    it("refuses a program that does not compile, naming the failure", async () => {
      const refusal = await refusalOf(instantiate({ program: BROKEN_PROGRAM }));
      expect(refusal.code).toBe("compile-failed");
      expect(refusal.message).toContain("undefinedName");
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
    });
  });

  describe("setsrc", () => {
    let pieceId: string;

    beforeEach(async () => {
      pieceId = (await instantiate({ program: BASE_PROGRAM }, {
        seed: "kept",
      })).pieceId;
    });

    const check = (source: ServedPatternSource) =>
      served(
        "check",
        (pieces) => servedCheckPieceSource(pieces, pieceId, source),
      );

    const apply = (
      source: ServedPatternSource,
      options: { dangerouslyAllowIncompatibleSchema?: boolean } = {},
    ) =>
      served(
        "setsrc",
        (pieces) =>
          servedSetPieceSource(pieces, pieceId, { source, ...options }),
        (runtime, receipt) =>
          confirmServedSourceUpdate(runtime, space, pieceId, receipt),
      );

    it("reports a compatible candidate without moving the piece", async () => {
      const before = (await (await clientPieces()).get(pieceId)).getCell();
      const report = await check({ program: COMPATIBLE_PROGRAM });
      expect(report.compatible).toBe(true);
      expect(report.candidate.symbol).toBe("default");
      const after = (await (await clientPieces()).get(pieceId)).getCell();
      expect(getPatternIdentityRef(after)).toEqual(
        getPatternIdentityRef(before),
      );
    });

    it("reports an incompatible candidate with the rule that refused it", async () => {
      const report = await check({ program: INCOMPATIBLE_PROGRAM });
      expect(report.compatible).toBe(false);
      expect(report.message).toContain("not backward compatible");
    });

    it("replaces the source, appends the revision, and keeps the argument", async () => {
      const receipt = await apply({ program: COMPATIBLE_PROGRAM });
      expect(receipt.status).toBe("committed");
      expect(receipt.refresh).toEqual({ status: "completed" });
      expect(receipt.detachedOrigin).toBeNull();

      const pieces = await clientPieces();
      const piece = await pieces.get(pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.ref);
      const revisions = getPieceSourceRevisions(piece.getCell());
      expect(revisions.at(-1)?.revisionId).toBe(receipt.revisionId);
      expect(revisions.at(-1)?.operation).toBe("edit");
      const argument = pieces.getArgument<{ seed?: string }>(piece.getCell());
      await argument.sync();
      expect(argument.get()).toEqual({ seed: "kept" });
    });

    it("refuses an incompatible candidate and leaves the piece as it was", async () => {
      const before = getPatternIdentityRef(
        (await (await clientPieces()).get(pieceId)).getCell(),
      );
      const refusal = await refusalOf(apply({ program: INCOMPATIBLE_PROGRAM }));
      expect(refusal.code).toBe("incompatible");
      expect(refusal.message).toContain("not backward compatible");
      const after = getPatternIdentityRef(
        (await (await clientPieces()).get(pieceId)).getCell(),
      );
      expect(after).toEqual(before);
    });

    it("applies an incompatible candidate under the dangerous override", async () => {
      const receipt = await apply({ program: INCOMPATIBLE_PROGRAM }, {
        dangerouslyAllowIncompatibleSchema: true,
      });
      expect(receipt.status).toBe("committed");
      const piece = await (await clientPieces()).get(pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.ref);
    });

    it("refuses a piece the space does not hold", async () => {
      const refusal = await refusalOf(served(
        "setsrc",
        (pieces) =>
          servedSetPieceSource(pieces, "no-such-piece", {
            source: { program: COMPATIBLE_PROGRAM },
          }),
      ));
      expect(refusal.code).toBe("piece-not-found");
    });
  });
});
