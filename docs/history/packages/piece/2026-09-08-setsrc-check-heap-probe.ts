/**
 * Reproduces preflight heap growth over an acyclic graph in emulated storage.
 * Each node links twice to its successor; the piece only demands `seed`.
 * A depth of 12 completes on the investigated revision. A depth of 20
 * exhausts a 512 MB V8 heap. All writes target a disposable emulated store.
 */

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../../../../packages/piece/src/ops/pieces-controller.ts";

const depth = Number(Deno.args[0] ?? 12);
if (!Number.isSafeInteger(depth) || depth < 0) {
  throw new Error("The graph depth must be a nonnegative integer.");
}
const signer = await Identity.fromPassphrase("issue-6969-local-probe");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("http://toolshed.test"),
  storageManager,
});

try {
  const pieces = new PiecesController(
    await createSession({ identity: signer, spaceName: "issue-6969" }),
    runtime,
  );
  await pieces.synced();
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `import { pattern } from "commonfabric";
export default pattern<{seed?: string}, {label: string}>(
  ({seed}) => ({label: seed ?? "unset"})
);`,
    }],
  };
  const piece = await pieces.create(program, { input: { seed: "hello" } });
  const tx = runtime.edit();
  try {
    const space = pieces.getSpace();
    let next: Cell<unknown> = runtime.getCell(space, "leaf", undefined, tx);
    next.set({ label: "leaf" });
    for (let index = 0; index < depth; index++) {
      const node = runtime.getCell(space, `node-${index}`, undefined, tx);
      node.set({ left: next, right: next });
      next = node;
    }
    const argument = pieces.getArgument(piece.getCell()).withTx(tx)
      .asSchema(undefined);
    argument.set({ seed: "hello", extra: next });
    const result = await tx.commit();
    if (result.error) throw result.error;
  } finally {
    if (tx.status().status === "ready") tx.abort();
  }
  await runtime.idle();
  console.log(JSON.stringify({
    phase: "preflight",
    depth,
    graphDocuments: depth + 2,
    memory: Deno.memoryUsage(),
  }));
  const start = performance.now();
  const report = await piece.checkPattern(program);
  console.log(JSON.stringify({
    phase: "complete",
    depth,
    elapsedMs: performance.now() - start,
    report,
    memory: Deno.memoryUsage(),
  }));
} finally {
  await runtime.dispose();
  await storageManager.close();
}
