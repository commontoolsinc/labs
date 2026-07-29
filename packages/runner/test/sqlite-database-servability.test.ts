// W2.15a / R5: why `sqliteDatabase` still has no descriptor, made executable.
//
// A3 rejected `sqliteDatabase` for two reasons. The SECOND one — that it
// derives the db `owner` from the ambient `runtime.trustSnapshotProvider()`,
// so a server-side first run would mint the handle owned by the EXECUTOR's
// principal — is FIXED: the builtin now derives the owner from the acting
// execution lane (owner ruling 2026-07-29; see
// `sqlite-db-owner.test.ts` → "derives the owner from the acting lane").
//
// The FIRST one stands, and this file measures it rather than asserting it
// from source reading. A `sqliteDatabase` run writes, on the document it
// mints, a DOCUMENT-ROOT `["result"]` meta path (`makeResultCell` →
// `setResultCell`) beside the `["value"]` payload. A W2.15a computation
// descriptor declares its minted document as a value-root link, which
// `toMemorySpaceAddress` renders `["value"]` — so `["result"]` sits outside
// the envelope and every minting run would de-claim
// `dynamic-write-outside-static-surface` at the firewall. The only assembler
// that lifts a value-root envelope to a document-root prefix is the
// MATERIALIZER one (`serverBuiltinMaterializerScopeSummary`, FB19/CA6), and
// that lift is deliberately NOT blanket: the same descriptor also declares the
// node's direct OUTPUT SPOT at link path `[]`, and lifting that to document
// root would bound the whole output-spot document — far too wide. So the
// envelope has to be attached to the minted document SPECIFICALLY, which is a
// field the computation descriptor does not have and the materializer
// descriptor does.
//
// That leaves a decision nobody has made: either `sqliteDatabase` joins
// `SERVER_MATERIALIZER_BUILTIN_IDS` (whose docblock says only the three
// container-minting list builtins belong, and whose runner branch ALSO
// installs `materializerWriteEnvelopes` on the action, which re-indexes the
// node in `SchedulerMaterializers` and changes when it is scheduled), or the
// computation descriptor grows a minted-document envelope field of its own.
// Both are registry/design calls, so this file pins the measurement that
// forces the choice instead of guessing at it.
//
// When the `["result"]` write stops appearing — e.g. `makeResultCell` stops
// writing meta paths, or the minted document gets a real envelope — this test
// goes red and the descriptor question is genuinely re-openable.
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createExecutorActionTransactionRouter } from "../src/executor/action-transaction-router.ts";
import { classifyStaticActionServability } from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const DB_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, sqliteDatabase, table } from 'commonfabric';",
      "export default pattern<{ seed: string }>(() => ({",
      "  db: sqliteDatabase({ tables: { notes: table({",
      "    id: 'integer primary key', body: 'text' }) } }),",
      "}));",
    ].join("\n"),
  }],
};

const scopeOf = (address: IMemorySpaceAddress): unknown =>
  (address as { scope?: unknown }).scope ?? "space";

/** Observe the single `sqliteDatabase` action-run of a one-db pattern. */
async function observeSqliteDatabase(): Promise<{
  observation: SchedulerActionObservation;
  space: MemorySpace;
}> {
  const signer = await Identity.fromPassphrase("sqliteDatabase R5 surface");
  const space = signer.did() as MemorySpace;
  const attempts: SchedulerActionObservation[] = [];
  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {},
    onDiagnostic: () => {},
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter(input) {
      const route = executorRouter(input);
      const observation = input.commit.schedulerObservation;
      if (
        observation !== undefined &&
        (observation as { transactionKind?: unknown }).transactionKind ===
          "action-run"
      ) {
        attempts.push(
          structuredClone(observation) as SchedulerActionObservation,
        );
      }
      return route;
    },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(DB_PROGRAM, {
      space,
    });
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "sqlite-db-servability",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { seed: "probe" }, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();

    const runs = attempts.filter((observation) =>
      observation.implementationFingerprint ===
        "impl:cf:builtin/sqliteDatabase:v1"
    );
    assertEquals(
      runs.length,
      1,
      `expected exactly one sqliteDatabase action-run; saw ${
        JSON.stringify(attempts.map((a) => a.implementationFingerprint))
      }`,
    );
    return { observation: runs[0], space };
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

Deno.test("R5: a sqliteDatabase mint writes a DOCUMENT-ROOT meta path, which no computation envelope can bound", async () => {
  const { observation, space } = await observeSqliteDatabase();

  // It IS a computation node, so the `actionKind` gate that excludes
  // llmDialog/navigateTo is not what keeps it out.
  assertEquals(observation.actionKind, "computation");

  const writes = observation.actualChangedWrites.map((address) => ({
    scope: scopeOf(address),
    id: address.id,
    path: [...address.path],
  }));
  // The minted handle document is the one carrying a `["result"]` write; the
  // direct output spot only ever gets `["value"]`.
  const mintedMetaWrites = writes.filter((write) => write.path[0] === "result");
  assert(
    mintedMetaWrites.length > 0,
    `expected a document-root ["result"] write from makeResultCell's ` +
      `setResultCell; saw ${JSON.stringify(writes)}`,
  );
  // ...and it is a sibling of, not under, that same document's `["value"]` —
  // which is what makes a value-root declared envelope insufficient.
  const mintedId = mintedMetaWrites[0].id;
  assert(
    writes.some((write) => write.id === mintedId && write.path[0] === "value"),
    `expected the same minted document to carry its ["value"] payload too; ` +
      `saw ${JSON.stringify(writes)}`,
  );

  // Therefore: still no descriptor. If this flips to claim-ready because one
  // was added, the two assertions above are the reason it needs a
  // document-root envelope rather than the W2.15a value-root one — re-read
  // this file's header, do not relax the pin.
  assertEquals(
    classifyStaticActionServability(observation, space),
    { status: "unservable", reason: "incomplete-static-surface" },
  );
});
