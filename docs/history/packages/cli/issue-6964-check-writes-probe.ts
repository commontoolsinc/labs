/**
 * Measures source preflight writes in a disposable Memory v2 server using the
 * CLI library's file-resolution path. Fresh runtimes keep compilation-cache
 * reuse distinct from reuse of the caller's in-memory state.
 */

import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { getPatternIdentityRef, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { checkPiecePattern } from "../../../../packages/cli/lib/piece.ts";

const signer = await Identity.fromPassphrase("issue-6964-disposable-probe");
const session = await createSession({
  identity: signer,
  spaceName: "issue-6964",
});
const server = newLoopbackServer();
const directory = await Deno.makeTempDir({ prefix: "issue-6964-programs-" });
const base = `import { pattern } from "commonfabric";
export default pattern<{seed?: string}, {label: string}>(
  ({seed}) => ({label: seed ?? "unset"})
);`;
const compatible = base.replace('seed ?? "unset"', '`seen:${seed ?? "unset"}`');
const refused = `import { pattern } from "commonfabric";
export default pattern<{required: number}, {label: string}>(
  ({required}) => ({label: String(required)})
);`;
for (const [name, contents] of Object.entries({ base, compatible, refused })) {
  await Deno.writeTextFile(`${directory}/${name}.tsx`, contents);
}

/** Opens a client without starting any existing piece. */
async function openClient() {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost:9999"),
    storageManager: storage,
  });
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();
  return { storage, runtime, pieces };
}

try {
  const writer = await openClient();
  const piece = await writer.pieces.create({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: base }],
  }, { input: { seed: "hello" } });
  const pieceId = piece.id;
  await writer.runtime.idle();
  await writer.storage.synced();
  await writer.runtime.dispose();

  const engine = await server.engineForSpace(session.space);
  const db = engine.database;
  const snapshot = () => ({
    commits: db.prepare('SELECT COUNT(*) AS count FROM "commit"').value<
      [number]
    >()![0],
    revisions: db.prepare("SELECT COUNT(*) AS count FROM revision").value<
      [number]
    >()![0],
    heads: new Map(
      db.prepare(
        "SELECT branch, id, scope_key, seq, op_index, op FROM head ORDER BY branch, id, scope_key",
      ).all<
        {
          branch: string;
          id: string;
          scope_key: string;
          seq: number;
          op_index: number;
          op: string;
        }
      >()
        .map((
          row,
        ) => [
          JSON.stringify([row.branch, row.id, row.scope_key]),
          JSON.stringify(row),
        ]),
    ),
  });
  const measure = async (
    name: string,
    candidate?: "compatible" | "refused",
  ) => {
    const before = snapshot();
    const reader = await openClient();
    try {
      const target = await reader.pieces.get(pieceId, false);
      const ref = getPatternIdentityRef(target.getCell());
      const argument = reader.pieces.getArgument(target.getCell()).getRaw();
      using starts = spy(reader.runtime.runner, "start");
      const report = candidate === undefined
        ? undefined
        : await checkPiecePattern(
          {
            apiUrl: "http://localhost:9999",
            identity: "/unused/injected-identity",
            space: session.space,
            piece: pieceId,
          },
          { mainPath: `${directory}/${candidate}.tsx`, rootPath: directory },
          {
            loadPieces: () => Promise.resolve(reader.pieces),
          },
        );
      await reader.runtime.idle();
      await reader.storage.synced();
      expect(starts.calls.length).toBe(0);
      expect(getPatternIdentityRef(target.getCell())).toEqual(ref);
      expect(reader.pieces.getArgument(target.getCell()).getRaw()).toEqual(
        argument,
      );
      if (report !== undefined) {
        expect(report.compatible).toBe(candidate === "compatible");
      }
      const after = snapshot();
      const added = [...after.heads.keys()].filter((key) =>
        !before.heads.has(key)
      );
      const changed = [...before.heads].filter(([key, value]) =>
        after.heads.has(key) && after.heads.get(key) !== value
      );
      const removed = [...before.heads.keys()].filter((key) =>
        !after.heads.has(key)
      );
      expect(changed.length).toBe(0);
      expect(removed.length).toBe(0);
      console.log(JSON.stringify({
        name,
        compatible: report?.compatible,
        commits: after.commits - before.commits,
        revisions: after.revisions - before.revisions,
        added: added.length,
        changed: changed.length,
        removed: removed.length,
        runnerStarts: starts.calls.length,
        issues: report?.issues,
      }));
    } finally {
      await reader.runtime.dispose();
    }
  };
  await measure("open/read/close control");
  await measure("new refused candidate", "refused");
  await measure("same refused candidate, fresh runtime", "refused");
  await measure("new compatible candidate", "compatible");
  await measure("same compatible candidate, fresh runtime", "compatible");
} finally {
  await server.close();
  await Deno.remove(directory, { recursive: true });
}
