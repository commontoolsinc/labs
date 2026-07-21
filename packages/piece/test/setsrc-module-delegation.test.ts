import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
} from "../../runner/src/compilation-cache/cell-cache.ts";
import { PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("setsrc module delegation");

function authorizedWriterProgram(version: string): RuntimeProgram {
  return {
    main: "/app/main.tsx",
    files: [
      {
        name: "/app/main.tsx",
        contents: `/// <cts-enable />
import {
  handler,
  pattern,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import { revision } from "../shared/revision.ts";

const setName = handler<
  { name: string },
  { name: Writable<string> }
>((event, state) => {
  state.name.set(revision + ":" + event.name);
});

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<
    WriteAuthorizedBy<string, typeof setName>
  >("initial").for("name");
  return { name, setName: setName({ name }) };
});
`,
      },
      {
        name: "/shared/revision.ts",
        contents: `/// <cts-enable />
export const revision = ${JSON.stringify(version)};
`,
      },
    ],
  };
}

describe("setsrc module delegation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    const session = await createSession({
      identity: signer,
      spaceName: "setsrc-delegation-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    pieces = new PiecesController(manager);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("merges predecessor chains into an already-stored successor closure", async () => {
    const first = await pieces.create(authorizedWriterProgram("v1"), {
      input: {},
    });
    const second = await pieces.create(authorizedWriterProgram("v4"), {
      input: {},
    });

    const firstRef = getPatternIdentityRef(first.getCell())!;
    const secondRef = getPatternIdentityRef(second.getCell())!;

    const invokeSetName = async (
      piece: typeof first,
      name: string,
    ): Promise<string> => {
      const result = await piece.result.getCell();
      result.key("setName").send({ name });
      await result.pull();
      return await piece.result.get(["name"]) as string;
    };

    expect(await invokeSetName(first, "before")).toBe("v1:before");

    await first.setPattern(authorizedWriterProgram("v2"));
    const intermediateRef = getPatternIdentityRef(first.getCell())!;
    expect(await invokeSetName(first, "middle")).toBe("v2:middle");
    await first.setPattern(authorizedWriterProgram("v3"));
    expect(await invokeSetName(first, "after")).toBe("v3:after");
    const successorRef = getPatternIdentityRef(first.getCell())!;

    await runtime.patternManager.flushCompileCacheWrites();
    await manager.synced();
    const patternSpace = manager.getSpace();
    const patternSpaceName = manager.getSpaceName()!;

    const loadClosure = async (targetRuntime: Runtime, identity: string) => {
      const tx = targetRuntime.edit();
      try {
        return await loadVerifiedSourceClosure(
          targetRuntime,
          patternSpace,
          identity,
          tx,
        );
      } finally {
        tx.abort();
      }
    };
    const freshRuntimes: Runtime[] = [];
    try {
      const createFreshRuntime = () => {
        const freshRuntime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
          cfcEnforcementMode: "enforce-explicit",
        });
        // Runtime.dispose() closes the shared emulated storage manager, so all
        // cold-start runtimes stay alive until the assertions are complete.
        freshRuntimes.push(freshRuntime);
        return freshRuntime;
      };
      const createFreshManager = async (freshRuntime: Runtime) => {
        const freshSession = await createSession({
          identity: signer,
          spaceName: patternSpaceName,
        });
        const freshManager = new PieceManager(freshSession, freshRuntime);
        await freshManager.synced();
        return freshManager;
      };

      // Restart before the second pattern converges on the already-stored
      // successor. Use a fresh compiled-cache variant so the source document
      // contributes the first pattern's chain while the second update
      // contributes the new chain. Both sets must persist their authenticated
      // union, and that committed union must be installed in this runtime.
      const bumpedRuntimeVersion = "setsrc-delegation-shared-successor";
      const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
        bumpedRuntimeVersion,
      );
      try {
        const mergeRuntime = createFreshRuntime();
        const mergeManager = await createFreshManager(mergeRuntime);
        const mergePieces = new PiecesController(mergeManager);
        const mergeSecond = await mergePieces.get(second.id, true);
        await mergeSecond.setPattern(authorizedWriterProgram("v3"));
        expect(getPatternIdentityRef(mergeSecond.getCell())).toEqual(
          successorRef,
        );

        const registeredTx = mergeRuntime.edit();
        const registeredDelegations = registeredTx.getCfcState()
          .moduleDelegations.get(successorRef.identity) ?? [];
        registeredTx.abort();
        expect(registeredDelegations).toContain(firstRef.identity);
        expect(registeredDelegations).toContain(intermediateRef.identity);
        expect(registeredDelegations).toContain(secondRef.identity);

        // This resolves through the successor module already evaluated for
        // mergeSecond. It therefore depends on save-time registration of the
        // complete A+B union; reloading a closure cannot rescue a partial map.
        const mergeFirst = await mergePieces.get(first.id, true);
        expect(await invokeSetName(mergeFirst, "merged")).toBe("v3:merged");

        await mergeRuntime.patternManager.flushCompileCacheWrites();
        await mergeManager.synced();

        const firstClosure = await loadClosure(mergeRuntime, firstRef.identity);
        const intermediateClosure = await loadClosure(
          mergeRuntime,
          intermediateRef.identity,
        );
        const secondClosure = await loadClosure(
          mergeRuntime,
          secondRef.identity,
        );
        const successorClosure = await loadClosure(
          mergeRuntime,
          successorRef.identity,
        );
        const byName = (closure: NonNullable<typeof firstClosure>) =>
          new Map(
            [...closure].map(([identity, doc]) => [doc.filename, identity]),
          );
        const firstByName = byName(firstClosure!);
        const intermediateByName = byName(intermediateClosure!);
        const secondByName = byName(secondClosure!);

        for (const [identity, doc] of successorClosure!) {
          if (!doc.filename.startsWith("/")) continue;
          const delegated = doc.delegatedModuleIdentities ?? [];
          expect(delegated).toContain(firstByName.get(doc.filename));
          expect(delegated).toContain(intermediateByName.get(doc.filename));
          expect(delegated).toContain(secondByName.get(doc.filename));
          expect(delegated).not.toContain(identity);
        }

        const compiledTx = mergeRuntime.edit();
        try {
          const compiledClosure = await loadCompiledClosure(
            mergeRuntime,
            patternSpace,
            successorRef.identity,
            { runtimeVersion: bumpedRuntimeVersion },
            compiledTx,
          );
          for (const [identity, sourceDoc] of successorClosure!) {
            expect(compiledClosure.get(identity)?.delegatedModuleIdentities)
              .toEqual(sourceDoc.delegatedModuleIdentities);
          }
        } finally {
          compiledTx.abort();
        }

        // A later cold runtime can warm-hit only the repaired compiled set;
        // both predecessor chains still have to authorize the first pattern.
        const coldRuntime = createFreshRuntime();
        const coldManager = await createFreshManager(coldRuntime);
        const coldPiece = await new PiecesController(coldManager).get(
          first.id,
          true,
        );
        expect(await invokeSetName(coldPiece, "cold")).toBe("v3:cold");
      } finally {
        restoreRuntimeVersion();
      }
    } finally {
      for (const freshRuntime of freshRuntimes.reverse()) {
        await freshRuntime.dispose();
      }
    }
  });
});
