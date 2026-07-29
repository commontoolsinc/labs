import { createSession, Identity } from "@commonfabric/identity";
import { getPieceSourceRevisions, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { pattern } from "../../../runner/src/builder/pattern.ts";
import { setArtifactEntryRef } from "../../../runner/src/builder/pattern-metadata.ts";
import { sourceDocKey } from "../../../runner/src/compilation-cache/cell-cache.ts";
import { PieceManager } from "../../src/manager.ts";

const SOURCE = "export default 1;\n";
const SOURCE_IDENTITY = "Qxkzi6OeLOLPP3A3-e-8kLe0DyNgoDZMZVIKr4PLz3w";
const worker = globalThis as unknown as {
  postMessage(value: unknown): void;
  close(): void;
};

const storageManager = StorageManager.emulate({
  as: await Identity.fromPassphrase("piece source compiler preload"),
});
const runtime = new Runtime({
  apiUrl: new URL("http://toolshed.test"),
  storageManager,
});

let outcome: { history?: string[]; error?: string };
try {
  const manager = new PieceManager(
    await createSession({
      identity: storageManager.as as Identity,
      spaceName: `piece-source-compiler-preload-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await manager.synced();

  const sourceTx = runtime.edit();
  runtime.getCell(
    manager.getSpace(),
    sourceDocKey(SOURCE_IDENTITY),
    undefined,
    sourceTx,
  ).set({
    kind: "source",
    identity: SOURCE_IDENTITY,
    code: SOURCE,
    filename: "/main.tsx",
    imports: [],
  });
  runtime.prepareTxForCommit(sourceTx);
  const sourceCommit = await sourceTx.commit();
  if (sourceCommit.error !== undefined) throw sourceCommit.error;

  const cachedPattern = pattern(() => ({}));
  setArtifactEntryRef(cachedPattern, {
    identity: SOURCE_IDENTITY,
    symbol: "default",
  });
  manager.syncPatternByIdentity = () => Promise.resolve(cachedPattern);

  const piece = await manager.setupPersistent(
    cachedPattern,
    {},
    "source-backed-piece",
  );
  outcome = {
    history: getPieceSourceRevisions(piece).map((revision) =>
      revision.operation
    ),
  };
} catch (error) {
  outcome = {
    error: error instanceof Error ? error.message : String(error),
  };
}
await runtime.dispose();
await storageManager.close();
worker.postMessage(outcome);
worker.close();
