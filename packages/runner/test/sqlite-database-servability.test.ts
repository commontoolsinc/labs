// W2.15a / R5: `sqliteDatabase`'s computation descriptor, and the
// provenance-meta rule that made it expressible.
//
// A3 rejected `sqliteDatabase` for two reasons, and BOTH are now closed.
//
// The SECOND one — that it derives the db `owner` from the ambient
// `runtime.trustSnapshotProvider()`, so a server-side first run would mint the
// handle owned by the EXECUTOR's principal — is fixed: the builtin derives the
// owner from the acting execution lane (owner ruling 2026-07-29; see
// `sqlite-db-owner.test.ts` → "derives the owner from the acting lane").
//
// The FIRST one was an ENVELOPE-SHAPE gap, and this file still measures it
// rather than asserting it from source reading. A `sqliteDatabase` run writes,
// on the document it mints, a DOCUMENT-ROOT `["result"]` meta path
// (`makeResultCell` → `setResultCell`) beside the `["value"]` payload — a
// parent back-pointer production code walks to resolve piece ownership
// (`ensure-piece-running.ts`, `piece/manager.ts`). A W2.15a computation
// descriptor declares its minted document as a value-root link, which
// `toMemorySpaceAddress` renders `["value"]`, so `["result"]` used to sit
// OUTSIDE the envelope and every minting run de-claimed
// `dynamic-write-outside-static-surface` at the firewall.
//
// The rule that closed it (client-passivity §5h.2): a descriptor's
// MINTED-DOCUMENT declaration implicitly covers the provenance meta paths
// every mint writes — `["result"]` and `["pattern"]` — and nothing else. The
// descriptor grew a `mintedDocuments` field for exactly that, so the coverage
// attaches to the minted document SPECIFICALLY. That narrowness is the whole
// point, and the second test below pins it: the alternative considered was the
// MATERIALIZER summary's blanket value-root → document-root lift
// (`serverBuiltinMaterializerScopeSummary`, FB19/CA6), which cannot be applied
// here because the same descriptor also declares the node's direct OUTPUT SPOT
// at link path `[]` — lifting that to document root would bound the whole
// output-spot document, far too wide. Joining
// `SERVER_MATERIALIZER_BUILTIN_IDS` was refused for a second reason: that
// branch also installs `materializerWriteEnvelopes`, which re-indexes the node
// in `SchedulerMaterializers` and changes WHEN it is scheduled — a scheduling
// change bought for an envelope fix.
//
// Tripwires. If the `["result"]` write stops appearing — e.g. `makeResultCell`
// stops writing meta paths — the first test goes red and the provenance rule
// has lost its justification (delete it rather than carrying dead coverage).
// If the output-spot document ever acquires provenance coverage, the second
// test goes red: that is the blanket lift this design refused.
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ClientCommit } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import {
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
} from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";

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

const LABELED_DB_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, sqliteDatabase, table } from 'commonfabric';",
      "export default pattern<{ seed: string }>(() => ({",
      "  db: sqliteDatabase({ tables: { notes: table({",
      "    id: 'integer primary key',",
      "    body: { type: 'string', ifc: { confidentiality: ['secret'] } },",
      "  }) } }),",
      "}));",
    ].join("\n"),
  }],
};

const scopeOf = (address: IMemorySpaceAddress): unknown =>
  (address as { scope?: unknown }).scope ?? "space";

type CapturedAttempt = {
  readonly input: ActionTransactionRouteInput;
  readonly observation: SchedulerActionObservation;
};

/** Observe the single `sqliteDatabase` action-run of a one-db pattern, through
 *  the real executor router so the DYNAMIC firewall judges it too. */
async function observeSqliteDatabase(
  program: RuntimeProgram = DB_PROGRAM,
  passphrase = "sqliteDatabase R5 surface",
): Promise<{
  attempt: CapturedAttempt;
  diagnostics: ExecutorCandidateDiagnostic[];
  space: MemorySpace;
}> {
  const signer = await Identity.fromPassphrase(passphrase);
  const space = signer.did() as MemorySpace;
  const attempts: CapturedAttempt[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {},
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
        attempts.push({
          input: {
            ...input,
            commit: structuredClone(input.commit) as ClientCommit,
          },
          observation: structuredClone(
            observation,
          ) as SchedulerActionObservation,
        });
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
    const compiled = await runtime.patternManager.compilePattern(program, {
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

    const runs = attempts.filter(({ observation }) =>
      observation.implementationFingerprint ===
        "impl:cf:builtin/sqliteDatabase:v1"
    );
    assertEquals(
      runs.length,
      1,
      `expected exactly one sqliteDatabase action-run; saw ${
        JSON.stringify(
          attempts.map(({ observation }) =>
            observation.implementationFingerprint
          ),
        )
      }`,
    );
    return { attempt: runs[0], diagnostics, space };
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

Deno.test("R5: a sqliteDatabase mint writes a DOCUMENT-ROOT meta path beside its value payload", async () => {
  const { attempt } = await observeSqliteDatabase();
  const { observation } = attempt;

  // It IS a computation node, so the `actionKind` gate that excludes
  // llmDialog/navigateTo is not what kept it out.
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
  // which is what makes a value-root declared envelope insufficient on its own
  // and is the entire reason the provenance-meta rule exists.
  const mintedId = mintedMetaWrites[0].id;
  assert(
    writes.some((write) => write.id === mintedId && write.path[0] === "value"),
    `expected the same minted document to carry its ["value"] payload too; ` +
      `saw ${JSON.stringify(writes)}`,
  );
  // No meta path OUTSIDE the two the provenance rule covers. `["pattern"]` is
  // written conditionally (`result-utils.ts`, only when the parent pattern
  // cell has a raw value), so it may be absent; anything else appearing here
  // means the rule under-declares and must be widened deliberately.
  const unexpected = writes.filter((write) =>
    write.path[0] !== "value" && write.path[0] !== "result" &&
    write.path[0] !== "pattern"
  );
  assertEquals(
    unexpected,
    [],
    `a mint wrote a document field outside {value, result, pattern}; the ` +
      `provenance-meta coverage rule enumerates exactly result+pattern`,
  );
});

Deno.test("R5: the minted-document declaration covers the provenance meta paths, and only on the minted document", async () => {
  const { attempt, diagnostics, space } = await observeSqliteDatabase();
  const { observation } = attempt;

  // The descriptor assembled a summary, and the action is claim-ready.
  const summary = observation.completeActionScopeSummary;
  assert(
    summary !== undefined,
    "sqliteDatabase carries a W2.15a computation descriptor, so its " +
      "observation must carry an assembled summary",
  );
  assertEquals(
    classifyStaticActionServability(observation, space),
    { status: "claim-ready", actionKind: "computation" },
  );

  // The end-to-end verdict FIRST, because it is the thing that used to fail:
  // the real minting run passes the dynamic firewall. Without the provenance
  // rule this exact harness answered `dynamic-write-outside-static-surface`
  // (the `["result"]` write sitting outside the value-root envelope), and
  // before the descriptor existed at all it answered
  // `incomplete-static-surface`.
  assertEquals(
    dynamicActionTransactionUnservableReason(
      attempt.input,
      observation,
      { servedSpace: space, branch: "" },
    ),
    undefined,
  );
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.diagnosticCode === "dynamic-write-outside-static-surface" ||
      diagnostic.diagnosticCode === "incomplete-static-surface"
    ),
    [],
    "the router judged the whole run without a de-claim",
  );

  // The mechanism. The minted document — the one the run wrote a `["result"]`
  // meta path on — is covered at BOTH provenance paths plus its value payload.
  const mintedId = observation.actualChangedWrites.find((address) =>
    address.path[0] === "result"
  )?.id;
  assert(mintedId !== undefined, 'expected a minted `["result"]` write');
  const pathsFor = (id: string) =>
    summary.writes.filter((write) => write.id === id)
      .map((write) => write.path.join("/")).sort();
  assertEquals(
    pathsFor(mintedId),
    ["pattern", "result", "value"],
    "the minted-document declaration must render its value payload plus the " +
      "two provenance meta paths",
  );

  // ...and NOT on the direct output spot. This is the narrowness the design
  // bought by refusing the materializer route's blanket document-root lift:
  // the output spot is declared at link path `[]` too, so a blanket lift would
  // bound that whole document.
  const outputSpotId = summary.directOutputs[0]?.id;
  assert(outputSpotId !== undefined, "expected one declared direct output");
  assert(
    outputSpotId !== mintedId,
    "the mint and the output spot must be different documents",
  );
  assertEquals(
    pathsFor(outputSpotId),
    ["value"],
    "the output spot keeps its value-root envelope; provenance coverage " +
      "attaches to the MINTED document only",
  );
});

// The one thing §5h.2's survey left unverified, measured rather than reasoned:
// whether a mint can acquire a document-root field OUTSIDE the two provenance
// paths. The obvious candidate is the CFC label envelope at `["cfc"]` — the
// MATERIALIZER lift's docblock names it as a reason that path bounds the whole
// container document, so a value-root envelope plus two provenance paths would
// be short by one if the label write were part of the action's observed surface.
// It is not: `prepareCfc` stages `["cfc"]` at commit-prepare time, outside the
// action's reactivity log, which is also why the TRANSFORMER certificate path
// only ever carries `["cfc"]` as a READ sibling
// (`transformerCertificateScopeSummaryInput`).
//
// If this goes red with a `["cfc"]` write, the provenance rule is short by that
// path for every descriptor member, not just this one — widen it deliberately
// (and revisit the materializer lift's reasoning at the same time).
Deno.test("R5: a CFC-labeled mint acquires no document field beyond value+provenance", async () => {
  const { attempt, space } = await observeSqliteDatabase(
    LABELED_DB_PROGRAM,
    "sqliteDatabase R5 labeled surface",
  );
  const { observation } = attempt;
  const fields = new Set(
    observation.actualChangedWrites.map((address) => address.path[0]),
  );
  assertEquals(
    [...fields].sort(),
    ["result", "value"],
    "a per-column `ifc` declaration must not add a document-root write " +
      '(notably `["cfc"]`) to the action\'s observed write surface',
  );
  assertEquals(
    dynamicActionTransactionUnservableReason(
      attempt.input,
      observation,
      { servedSpace: space, branch: "" },
    ),
    undefined,
  );
});
