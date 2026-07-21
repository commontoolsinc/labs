import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { loadVerifiedSourceClosure } from "../../runner/src/compilation-cache/cell-cache.ts";
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
    await second.setPattern(authorizedWriterProgram("v3"));

    const successorRef = getPatternIdentityRef(second.getCell())!;
    expect(getPatternIdentityRef(first.getCell())).toEqual(successorRef);

    const loadClosure = async (identity: string) => {
      const tx = runtime.edit();
      try {
        return await loadVerifiedSourceClosure(
          runtime,
          manager.getSpace(),
          identity,
          tx,
        );
      } finally {
        tx.abort();
      }
    };
    const firstClosure = await loadClosure(firstRef.identity);
    const intermediateClosure = await loadClosure(intermediateRef.identity);
    const secondClosure = await loadClosure(secondRef.identity);
    const successorClosure = await loadClosure(successorRef.identity);

    const byName = (closure: NonNullable<typeof firstClosure>) =>
      new Map([...closure].map(([identity, doc]) => [doc.filename, identity]));
    const firstByName = byName(firstClosure!);
    const intermediateByName = byName(intermediateClosure!);
    const secondByName = byName(secondClosure!);

    for (const [identity, doc] of successorClosure!) {
      if (!doc.filename.startsWith("/")) continue;
      const delegated = (doc as typeof doc & {
        delegatedModuleIdentities?: readonly string[];
      }).delegatedModuleIdentities ?? [];
      expect(delegated).toContain(firstByName.get(doc.filename));
      expect(delegated).toContain(intermediateByName.get(doc.filename));
      expect(delegated).toContain(secondByName.get(doc.filename));
      expect(delegated).not.toContain(identity);
    }

    await runtime.patternManager.flushCompileCacheWrites();
    await manager.synced();
    const freshSession = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const freshManager = new PieceManager(freshSession, freshRuntime);
      await freshManager.synced();
      const freshPiece = await new PiecesController(freshManager).get(
        first.id,
        true,
      );
      expect(await invokeSetName(freshPiece, "cold")).toBe("v3:cold");
    } finally {
      await freshRuntime.dispose();
    }
  });
});
